// Chrome-model backtest engine. Operates on a static local bar dataset (no
// live connection needed). Walk-forward, no lookahead: at simulated bar i,
// only bars[0..i] are used for detection/decision-making. Bars after i are
// only used afterward, to SCORE what a plan (once armed) would have done —
// exactly the same distinction a live trader has between "what I knew when I
// entered" and "what happened after."
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import {
  detectChromeCISD, findChromeAnchors, computeChromeFib, roundToTick, fmtTick, TICK,
  nearestValidIfvg, findNearestSwingTarget,
} from '../scan-chart.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));
const MAX_STOP_POINTS = rules.hard_constraints?.max_stop_points ?? 20;
const MANUAL_BREAKEVEN_POINTS = rules.hard_constraints?.manual_breakeven_points ?? 15;

export function loadBars(fixturePath) {
  const resolved = path.isAbsolute(fixturePath) ? fixturePath : path.join(__dirname, fixturePath);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function etParts(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const s = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  // format: MM/DD/YYYY, HH:MM:SS
  const [datePart, timePart] = s.split(', ');
  const [mm, dd, yyyy] = datePart.split('/');
  return { dateStr: `${yyyy}-${mm}-${dd}`, timeStr: timePart };
}
function etLabel(unixSeconds) {
  const { dateStr, timeStr } = etParts(unixSeconds);
  return `${dateStr} ${timeStr} ET`;
}

// FVG/IFVG detection now lives in scan-chart.mjs (imported above) as the
// single canonical source shared with the live scanner/poller — 2026-07-18
// independence build. Previously duplicated here since no historical
// ScriVindicator tag data existed to replay; that's still true, but the
// detector itself no longer needs to be a separate copy.

const OTE_PROXIMITY = 40;
const IFVG_PROXIMITY = 40;

function findExtreme(bars, side) {
  let best = bars[0];
  for (const b of bars) {
    if (side === 'low' && b.low < best.low) best = b;
    if (side === 'high' && b.high > best.high) best = b;
  }
  return best;
}

// 2026-08-24: TP1 = the NEAREST qualifying swing pivot beyond entry, not the
// most extreme point in a window — see scan-chart.mjs's findNearestSwingTarget
// for the full rationale (real 2026-08-23 session data: 10% hit rate on
// directionally-resolved trades, because the old "most extreme in the last
// 100 bars" target was routinely 100-200+ points away against 3-10pt stops).
// Falls back to the old most-extreme-in-window behavior only if no
// qualifying pivot exists (rare — keeps a trade from ending up with no
// target at all rather than silently reverting to the discredited default).
// TP2 = the more extreme point within a wider window, beyond TP1 (proxy for
// external DOL) — a same-OHLCV-only substitute for the live pipeline's
// Bryan's-indicator-cross-referenced TP2, since no historical indicator
// labels exist to check against. Left untouched — documented fidelity gap,
// not implicated in the diagnosed TP1 problem, and usually null anyway.
// 2026-08-24: findNearestSwingTarget (tried first, see file header) made
// things WORSE across every pivotWindow tested (3 through 50) on the real
// 26-day set — net R dropped from 65.15 to a 27-53 range, and TP1 wins hit
// ZERO at every window size (vs. 2 originally). Root cause, best guess:
// right as a Chrome setup completes (CISD + OTE + IFVG), price has usually
// just reversed off a real move — most NEARBY levels in the target
// direction are ones price already tapped on the way in, so "nearest
// UNTAPPED pivot" ends up no closer than the old approach, just noisier and
// more prone to landing in the same bar as the stop (AMBIGUOUS). Left in
// scan-chart.mjs since it's a real, reusable primitive, but NOT wired in
// here — opts.tp1RMultiple (fixed-R target, same idea Rebalance Model
// already uses successfully) is the live option now.
function computeTargets(history, isBear, entry, riskPoints, opts = {}) {
  const side = isBear ? 'low' : 'high';
  let tp1, tp1Bar = null;
  if (opts.tp1RMultiple) {
    tp1 = roundToTick(isBear ? entry - riskPoints * opts.tp1RMultiple : entry + riskPoints * opts.tp1RMultiple);
  } else {
    const recentWindow = history.slice(-100);
    tp1Bar = findExtreme(recentWindow, side);
    tp1 = roundToTick(isBear ? tp1Bar.low : tp1Bar.high);
  }
  const wideWindow = history.slice(-400);
  const wideExtremeBar = findExtreme(wideWindow, side);
  const wideExtreme = isBear ? wideExtremeBar.low : wideExtremeBar.high;
  const tp2 = (isBear ? wideExtreme < tp1 - TICK : wideExtreme > tp1 + TICK) ? roundToTick(wideExtreme) : null;
  return { tp1, tp1Bar, tp2 };
}

const MIN_STOP_POINTS = 2; // see scan-chart.mjs's MIN_IFVG_RISK_POINTS comment (2026-07-26) for the reasoning

// 2026-09-16: opts.maxStopPointsOverride lets a comparison script (see
// compare-stop-sizing.mjs) test a different stop-size ceiling than the
// shipped MAX_STOP_POINTS (20) without touching the live constant — same
// pattern as opts.tp1RMultiple above. Undefined (the default) reproduces
// exactly the shipped gate.
function buildPlan(fib, direction, history, ifvg, opts = {}) {
  const isBear = direction === 'BEAR';
  const entry = fib.ote705;
  const stop = isBear ? roundToTick(ifvg.invalidation + TICK) : roundToTick(ifvg.invalidation - TICK);
  const riskPoints = +Math.abs(entry - stop).toFixed(2);
  const { tp1, tp2 } = computeTargets(history, isBear, entry, riskPoints, opts);
  const reward1 = Math.abs(entry - tp1);
  const reward2 = tp2 != null ? Math.abs(entry - tp2) : null;
  // 2026-07-26: the validity gate now checks DIRECTION, not just magnitude.
  // Math.abs() above (needed for riskPoints regardless of side) used to
  // silently erase a backwards stop's sign, so a plan whose stop was on the
  // wrong side of entry (e.g. above entry on a BULL) could still compute a
  // small-looking riskPoints and pass the magnitude-only gate. nearestValidIfvg
  // (scan-chart.mjs) is now fixed at the source to never hand back a
  // wrong-side or degenerate-size match, but this gate checks it again
  // independently — a plan is never "valid" just because its input was.
  const onCorrectSide = isBear ? stop > entry : stop < entry;
  const maxStop = opts.maxStopPointsOverride ?? MAX_STOP_POINTS;
  return {
    direction, entry, stop, tp1, tp2, riskPoints,
    rr1: riskPoints > 0 ? +(reward1 / riskPoints).toFixed(2) : null,
    rr2: (riskPoints > 0 && reward2 != null) ? +(reward2 / riskPoints).toFixed(2) : null,
    passesStopGate: onCorrectSide && riskPoints >= MIN_STOP_POINTS && riskPoints <= maxStop,
    invalidReason: !onCorrectSide ? 'stop is on the wrong side of entry' : (riskPoints < MIN_STOP_POINTS ? `stop under ${MIN_STOP_POINTS}pt minimum (noise-level, not a real inversion)` : (riskPoints > maxStop ? `stop over ${maxStop}pt ceiling` : null)),
    ifvgUsed: { level: ifvg.level, invalidation: ifvg.invalidation, invertedTime: ifvg.invertedTime },
  };
}

// Score a plan forward using bars strictly after the arming index (this is
// retrospective — fine, since we're scoring, not deciding).
//
// 2026-07-31: implements rules.json's own spec §5.11 ("Partial-profit
// template — TP1 at the internal-range DOL, runner to the external target.
// Stop to breakeven only after TP1 fills, not before"), which was written
// down but never actually built — the engine used to treat TP1 as a single
// full exit. JJ asked for a breakeven rule framed as "after how many
// points"; the honest answer is it isn't a fixed point count — TP1 is a
// structural level (nearest swing extreme) that varies per trade, so the
// trigger is the EVENT (TP1 filling), not a point threshold. Implemented as
// specified, not as an invented number.
//
// Position-split assumption (not spec-given, flagged as a heuristic like
// every other tuned constant here): half the position exits at TP1 (locked
// profit = rr1 on that half), the stop on the remaining half moves to
// breakeven (entry price) and runs toward TP2. If TP2 is null (common in
// this system — see buildChromeTradePlan's tp2Source), there's no runner
// target to move toward, so this falls back to the pre-2026-07-31 behavior
// (full exit at TP1) rather than leaving a runner open with nothing to aim
// at.
//
// 2026-08-12: added JJ's own manual breakeven practice (rules.json
// hard_constraints.manual_breakeven_points, 15pt default) as a SEPARATE,
// EARLIER trigger for the same stop-to-breakeven move, independent of TP1 —
// whichever happens first (15pt favorable move, or TP1 fill) moves the
// stop; targets are unchanged. This matters: on 2026-08-12 all 7 of that
// day's live STOP-outs had already moved 15pt+ favorable (against 2.75-10.75pt
// stops) before reversing — raw TP1-only tracking logged that as -7R, but
// under JJ's actual rule none of the 7 should have been a full loss. New
// intermediate stage BE_TARGET_T1 (stop at breakeven, still targeting the
// ORIGINAL TP1 — no partial-exit credit yet, since TP1 hasn't filled) sits
// between FULL and RUNNER; RUNNER (post-TP1-fill breakeven) is unchanged.
// 2026-08-14: opts.breakevenMode/breakevenValue let the sweep script test
// alternative breakeven triggers against the shipped default (points mode,
// 15pt) without touching production behavior — defaults exactly reproduce
// the existing rules.json-driven rule when opts is omitted.
function scorePlan(bars, armIndex, plan, opts = {}) {
  const breakevenMode = opts.breakevenMode || 'points';
  const breakevenThreshold = breakevenMode === 'rMultiple'
    ? (opts.breakevenValue ?? 1) * plan.riskPoints
    : (opts.breakevenValue ?? MANUAL_BREAKEVEN_POINTS);
  const isBear = plan.direction === 'BEAR';
  const fwd = bars.slice(armIndex + 1);
  let filled = false, filledAt = null, outcome = null, outcomeAt = null, tp1HitAt = null;
  // FULL (original stop) -> BE_TARGET_T1 (stop at BE via 15pt rule, still
  // targeting TP1, no partial credit yet) -> RUNNER (stop at BE via TP1
  // fill, targeting TP2, half-position credit already banked at TP1).
  let stage = 'FULL';
  let favExtreme = plan.entry, advExtreme = plan.entry;
  for (const b of fwd) {
    if (!filled) {
      const touched = isBear ? b.high >= plan.entry : b.low <= plan.entry;
      if (touched) { filled = true; filledAt = b.time; }
      continue;
    }
    // MFE/MAE measured over the trade's actual open lifetime (entry to exit),
    // not the whole remaining dataset — stop tracking once outcome is decided.
    favExtreme = isBear ? Math.min(favExtreme, b.low) : Math.max(favExtreme, b.high);
    advExtreme = isBear ? Math.max(advExtreme, b.high) : Math.min(advExtreme, b.low);

    if (stage === 'FULL') {
      // 2026-08-14: opts.breakevenRequireClose tests JJ's own candle-close
      // framing against the shipped default (any intrabar wick touch of the
      // threshold, using high/low) — favMove switches to the bar's CLOSE
      // when set, so a wick that spikes past the threshold and reverses
      // within the same bar doesn't arm breakeven unless the bar actually
      // settles there.
      const favMove = opts.breakevenRequireClose
        ? (isBear ? plan.entry - b.close : b.close - plan.entry)
        : (isBear ? plan.entry - b.low : b.high - plan.entry);
      const hitStop = isBear ? b.high >= plan.stop : b.low <= plan.stop;
      const hitT1 = plan.tp1 != null && (isBear ? b.low <= plan.tp1 : b.high >= plan.tp1);
      if (hitStop && hitT1) { outcome = 'AMBIGUOUS (same 3m bar)'; outcomeAt = b.time; break; }
      if (hitStop) { outcome = 'STOP'; outcomeAt = b.time; break; }
      if (hitT1) {
        tp1HitAt = b.time;
        // 2026-08-27: SWITCHED from spec §5.11's partial+runner template to
        // full exit at TP1, JJ's explicit call after backtesting both on
        // the 26-day set: partial+runner scored +65.15R (TP2 hit ZERO times
        // in the entire dataset, under either style), full-exit scored
        // +82.73R. The runner's whole reason to exist — catching TP2 upside
        // — has never once paid off here, so holding half size past TP1 has
        // only ever given back R, never earned any. opts.useRunnerToTP2
        // re-enables the old behavior for anyone re-testing it later; the
        // default now is a full-size exit regardless of whether tp2 exists.
        if (plan.tp2 == null || !opts.useRunnerToTP2) { outcome = 'TP1'; outcomeAt = b.time; break; }
        stage = 'RUNNER'; // spec §5.11 behavior, opt-in only as of 2026-08-27
        continue;
      }
      if (favMove >= breakevenThreshold) {
        stage = 'BE_TARGET_T1'; // JJ's manual rule fired before TP1 did
        continue;
      }
    } else if (stage === 'BE_TARGET_T1') {
      const hitBE = isBear ? b.high >= plan.entry : b.low <= plan.entry;
      const hitT1 = plan.tp1 != null && (isBear ? b.low <= plan.tp1 : b.high >= plan.tp1);
      if (hitBE && hitT1) { outcome = 'AMBIGUOUS (breakeven vs TP1, same 3m bar)'; outcomeAt = b.time; break; }
      if (hitT1) {
        tp1HitAt = b.time;
        if (plan.tp2 == null || !opts.useRunnerToTP2) { outcome = 'TP1'; outcomeAt = b.time; break; }
        stage = 'RUNNER';
        continue;
      }
      if (hitBE) { outcome = 'BREAKEVEN (manual 15pt rule, pre-TP1)'; outcomeAt = b.time; break; }
    } else {
      const hitBE = isBear ? b.high >= plan.entry : b.low <= plan.entry;
      const hitT2 = isBear ? b.low <= plan.tp2 : b.high >= plan.tp2;
      if (hitBE && hitT2) { outcome = 'AMBIGUOUS (runner, same 3m bar)'; outcomeAt = b.time; break; }
      if (hitT2) { outcome = 'TP2'; outcomeAt = b.time; break; }
      if (hitBE) { outcome = 'BREAKEVEN'; outcomeAt = b.time; break; }
    }
  }
  const mfe = +Math.abs(plan.entry - favExtreme).toFixed(2);
  const mae = +Math.abs(plan.entry - advExtreme).toFixed(2);
  let resultR = null;
  if (outcome === 'STOP') resultR = -1;
  else if (outcome === 'TP1') resultR = plan.rr1;
  else if (outcome === 'BREAKEVEN (manual 15pt rule, pre-TP1)') resultR = 0; // full position scratched, nothing banked at TP1 yet
  else if (outcome === 'BREAKEVEN') resultR = plan.rr1 != null ? +(0.5 * plan.rr1).toFixed(2) : null; // TP1 half already banked
  else if (outcome === 'TP2') resultR = (plan.rr1 != null && plan.rr2 != null) ? +(0.5 * plan.rr1 + 0.5 * plan.rr2).toFixed(2) : null;
  const openLabel = stage === 'RUNNER' ? 'OPEN (runner past TP1, stop at breakeven, unresolved)'
    : stage === 'BE_TARGET_T1' ? 'OPEN (breakeven armed via 15pt rule, still targeting TP1)'
    : 'OPEN (unresolved in available data)';
  return { filled, filledAt, outcome: outcome || (filled ? openLabel : null), outcomeAt, tp1HitAt, mfe, mae, resultR };
}

function runSession(allBars, label, dateStr, startHHMM, endHHMM, scoreOpts = {}) {
  // Build ET-tagged bars once
  const tagged = allBars.map(b => ({ ...b, et: etParts(b.time) }));
  const sessionBars = tagged.filter(b => b.et.dateStr === dateStr && b.et.timeStr >= startHHMM && b.et.timeStr <= endHHMM);
  if (sessionBars.length === 0) throw new Error(`No bars found for ${label} in window ${dateStr} ${startHHMM}-${endHHMM}`);

  const cisdEvents = { BEAR: [], BULL: [] };
  const expiredEvents = { BEAR: [], BULL: [] };
  const lastCisdTime = { BEAR: null, BULL: null };
  const lastExpiredTime = { BEAR: null, BULL: null };
  const stateOf = { BEAR: 'WATCHING', BULL: 'WATCHING' };
  const candidates = [];
  // PROPOSALS.md #8: allow re-arming within a still-valid CISD after a
  // stop-out, instead of staying stuck ARMED for the CISD's whole lifetime.
  // activePlan tracks the live stop to check against each new bar (no
  // lookahead — checked one bar at a time as the walk-forward advances).
  // usedIfvgKeys excludes IFVGs that already produced a stopped-out trade
  // this CISD (spec §5 rule 2: a stop-out needs a brand-new confirmation),
  // reset when a genuinely new CISD forms.
  const activePlan = { BEAR: null, BULL: null };
  const usedIfvgKeys = { BEAR: new Set(), BULL: new Set() };
  // PROPOSALS.md #4: a transient 1-2 bar grind run can briefly outrank the
  // single-candle CISD (the dispatcher always returns whichever candidate's
  // cisdBar is more recent), then break a bar or two later — at which point
  // the unchanged, still-current single-candle CISD "reappears" and looks
  // new purely because lastCisdTime had moved to the grind's timestamp and
  // back. That doesn't change stateOf/activePlan handling (still correct,
  // still what #8 relies on) — it just means the SAME (cisdTime, ifvgTime)
  // combination can get pushed to `candidates` more than once. Dedup at the
  // push point only: track every cisdTime already given an EYES_ON entry
  // and every (cisdTime, ifvgTime) signature already given an ARMED entry,
  // per direction, and skip re-pushing an identical one. Pure logging fix —
  // entry/stop/target math and the state machine itself are untouched.
  const seenEyesOnFor = { BEAR: new Set(), BULL: new Set() };
  const seenArmedCisdTimes = { BEAR: new Set(), BULL: new Set() };
  const seenCisdTimes = { BEAR: new Set(), BULL: new Set() };

  for (const sb of sessionBars) {
    const i = allBars.findIndex(b => b.time === sb.time);
    const history = allBars.slice(0, i + 1);
    const price = sb.close;

    for (const direction of ['BEAR', 'BULL']) {
      // Check the ACTIVE plan's stop against only this new bar (no
      // lookahead — earlier bars were already checked on their own
      // iteration). If hit, drop back to WATCHING so a fresh IFVG
      // confirmation on the same still-valid CISD can re-arm (#8).
      if (stateOf[direction] === 'ARMED' && activePlan[direction]) {
        const isBear = direction === 'BEAR';
        const stopHit = isBear ? sb.high >= activePlan[direction].stop : sb.low <= activePlan[direction].stop;
        if (stopHit) {
          usedIfvgKeys[direction].add(activePlan[direction].ifvgKey);
          activePlan[direction] = null;
          stateOf[direction] = 'WATCHING';
        }
      }

      const fib = computeChromeFib(history, direction);
      if (!fib) continue;

      if (fib.expired) {
        if (lastExpiredTime[direction] !== fib.cisdBar.time) {
          lastExpiredTime[direction] = fib.cisdBar.time;
          expiredEvents[direction].push({
            at: sb.time, atLabel: etLabel(sb.time), path: fib.path,
            cisdBar: { time: fib.cisdBar.time, label: etLabel(fib.cisdBar.time) },
            ote705: fib.ote705,
          });
        }
        stateOf[direction] = 'WATCHING';
        continue; // expired anchor: not used for EYES_ON/ARMED, per spec §5 rule 5
      }

      if (lastCisdTime[direction] !== fib.cisdBar.time) {
        // PROPOSALS.md #4: only treat this as a genuinely new CISD (reset
        // state/plan, log a cisdEvent) the FIRST time this cisdBar.time is
        // seen. A transient 1-2 bar grind blip can briefly outrank the
        // single-candle CISD then break, making the unchanged single-candle
        // CISD "reappear" here purely because lastCisdTime moved to the
        // grind's timestamp and back — that reappearance must not reset an
        // already-ARMED plan back to WATCHING (which is what let it get
        // re-evaluated against a different IFVG and look like a fresh
        // re-arm of nothing). Still update lastCisdTime so this check
        // doesn't refire every bar; just skip the reset/log on a repeat.
        const reappearance = seenCisdTimes[direction].has(fib.cisdBar.time);
        lastCisdTime[direction] = fib.cisdBar.time;
        if (!reappearance) {
          seenCisdTimes[direction].add(fib.cisdBar.time);
          stateOf[direction] = 'WATCHING';
          activePlan[direction] = null;
          usedIfvgKeys[direction] = new Set(); // new CISD = fresh structure, old exclusions don't apply
          cisdEvents[direction].push({
            detectedAt: sb.time, detectedAtLabel: etLabel(sb.time), path: fib.path,
            cisdBar: { time: fib.cisdBar.time, label: etLabel(fib.cisdBar.time), close: fmtTick(fib.cisdBar.close) },
            topAnchor: { time: fib.topAnchorBar.time, label: etLabel(fib.topAnchorBar.time), price: fmtTick(fib.topAnchorPrice) },
            bottomAnchor: { time: fib.bottomAnchorBar.time, label: etLabel(fib.bottomAnchorBar.time), price: fmtTick(fib.bottomAnchorPrice) },
            range: +(fib.topAnchorPrice - fib.bottomAnchorPrice).toFixed(2),
            ote705: fib.ote705, zone618: fib.zone618, zone79: fib.zone79,
          });
        }
      }

      const dist = Math.abs(price - fib.ote705);
      if (dist > OTE_PROXIMITY) continue;

      if (stateOf[direction] === 'WATCHING') {
        stateOf[direction] = 'EYES_ON';
        if (!seenEyesOnFor[direction].has(fib.cisdBar.time)) {
          seenEyesOnFor[direction].add(fib.cisdBar.time);
          candidates.push({
            direction, state: 'EYES_ON', at: sb.time, atLabel: etLabel(sb.time), path: fib.path,
            level: fib.ote705, distance: +dist.toFixed(2), cisdTime: fib.cisdBar.time,
          });
        }
      }

      if (stateOf[direction] !== 'ARMED') {
        const matchingIfvg = nearestValidIfvg(history, direction, fib.ote705, IFVG_PROXIMITY, usedIfvgKeys[direction]);
        if (matchingIfvg) {
          stateOf[direction] = 'ARMED';
          const plan = buildPlan(fib, direction, history, matchingIfvg, scoreOpts);
          if (plan.passesStopGate) activePlan[direction] = { stop: plan.stop, ifvgKey: matchingIfvg.invertedTime };
          const rearm = usedIfvgKeys[direction].size > 0;
          // Dedup by cisdTime alone (not cisdTime+ifvg): a transient grind
          // interruption can leave this direction's state non-ARMED for a
          // bar or two even though the underlying CISD structure (cisdTime)
          // never actually changed, and nearestValidIfvg can then pick a
          // DIFFERENT (but not meaningfully new) IFVG on re-evaluation —
          // still the same stale structure re-arming, just with a different
          // ifvg attached. A genuine PROPOSALS #8 re-arm (rearm=true, i.e.
          // following a real stop-out) is exempted — that IS a new plan.
          if (rearm || !seenArmedCisdTimes[direction].has(fib.cisdBar.time)) {
            seenArmedCisdTimes[direction].add(fib.cisdBar.time);
            const score = plan.passesStopGate ? scorePlan(allBars, i, plan, scoreOpts) : null;
            candidates.push({
              direction, state: 'ARMED', at: sb.time, atLabel: etLabel(sb.time), path: fib.path,
              level: fib.ote705, cisdTime: fib.cisdBar.time,
              ifvg: { level: matchingIfvg.level, invalidation: matchingIfvg.invalidation, invertedAtLabel: etLabel(matchingIfvg.invertedTime) },
              plan, score, rearm,
            });
          }
        }
      }
    }
  }

  return { label, dateStr, startHHMM, endHHMM, sessionBars, cisdEvents, expiredEvents, candidates };
}

// ---------- Market context: simple swing/pivot detector over session bars ----------
function findSwings(bars, pivotWindow = 2) {
  const swings = [];
  for (let i = pivotWindow; i < bars.length - pivotWindow; i++) {
    const b = bars[i];
    let isHigh = true, isLow = true;
    for (let k = 1; k <= pivotWindow; k++) {
      if (bars[i - k].high > b.high || bars[i + k].high > b.high) isHigh = false;
      if (bars[i - k].low < b.low || bars[i + k].low < b.low) isLow = false;
    }
    if (isHigh) swings.push({ type: 'high', time: b.time, price: b.high });
    if (isLow) swings.push({ type: 'low', time: b.time, price: b.low });
  }
  return swings;
}

function summarizeMoves(bars, minMovePts = 40) {
  const swings = findSwings(bars).sort((a, b) => a.time - b.time);
  // Collapse into alternating major moves >= minMovePts
  const moves = [];
  let anchor = { type: bars[0].close, time: bars[0].time, price: bars[0].open };
  let last = swings[0];
  for (const s of swings) {
    if (!last) { last = s; continue; }
    if (Math.abs(s.price - last.price) >= minMovePts && s.type !== last.type) {
      moves.push({ from: last, to: s, size: +Math.abs(s.price - last.price).toFixed(2), direction: s.price > last.price ? 'UP' : 'DOWN' });
      last = s;
    } else if (s.type === last.type) {
      // extend: keep the more extreme of the two same-type pivots
      if ((s.type === 'high' && s.price > last.price) || (s.type === 'low' && s.price < last.price)) last = s;
    }
  }
  return moves;
}

export { runSession, summarizeMoves, findSwings, etLabel, etParts, MAX_STOP_POINTS };
