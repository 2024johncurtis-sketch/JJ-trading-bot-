// Chrome-model backtest engine. Operates on a static local bar dataset (no
// live connection needed). Walk-forward, no lookahead: at simulated bar i,
// only bars[0..i] are used for detection/decision-making. Bars after i are
// only used afterward, to SCORE what a plan (once armed) would have done —
// exactly the same distinction a live trader has between "what I knew when I
// entered" and "what happened after."
import fs from 'fs';
import {
  detectChromeCISD, findChromeAnchors, computeChromeFib, roundToTick, fmtTick, TICK,
} from '/Users/jjcurtis/tradingview-mcp-jackson/scan-chart.mjs';

const BARS_PATH = '/private/tmp/claude-501/-Users-jjcurtis-Downloads-mentor-lessons-2/406da6c7-3079-49d4-ac1f-58088c9911c9/scratchpad/nq_3m_bars.json';
const rules = JSON.parse(fs.readFileSync('/Users/jjcurtis/tradingview-mcp-jackson/rules.json', 'utf8'));
const MAX_STOP_POINTS = rules.hard_constraints?.max_stop_points ?? 20;

const allBars = JSON.parse(fs.readFileSync(BARS_PATH, 'utf8'));

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

// ---------- FVG / IFVG, per spec §1.1 / §1.2 (implemented fresh here since
// no historical ScriVindicator tag data exists to read back) ----------
function findFVGs(bars) {
  const fvgs = [];
  for (let i = 2; i < bars.length; i++) {
    const c1 = bars[i - 2], c3 = bars[i];
    if (c1.high < c3.low) fvgs.push({ type: 'bullish', top: c3.low, bottom: c1.high, formedIndex: i, formedTime: c3.time });
    else if (c1.low > c3.high) fvgs.push({ type: 'bearish', top: c1.low, bottom: c3.high, formedIndex: i, formedTime: c3.time });
  }
  return fvgs;
}

// Invalidation extreme = the high/low of the 3-candle FVG formation itself
// (spec §1.2 doesn't give an exact formula; this is a documented, defensible
// reading: "the extreme that formed it" = the swing the FVG's impulse came from).
function findIFVGs(bars, fvgs) {
  const ifvgs = [];
  for (const fvg of fvgs) {
    const c1 = bars[fvg.formedIndex - 2], c2 = bars[fvg.formedIndex - 1], c3 = bars[fvg.formedIndex];
    const groupHigh = Math.max(c1.high, c2.high, c3.high);
    const groupLow = Math.min(c1.low, c2.low, c3.low);
    for (let j = fvg.formedIndex + 1; j < bars.length; j++) {
      const c = bars[j];
      if (fvg.type === 'bullish' && c.close < fvg.bottom) {
        ifvgs.push({ direction: 'BEAR', level: fvg.bottom, invalidation: groupHigh, invertedIndex: j, invertedTime: c.time, sourceFvg: fvg });
        break;
      }
      if (fvg.type === 'bearish' && c.close > fvg.top) {
        ifvgs.push({ direction: 'BULL', level: fvg.top, invalidation: groupLow, invertedIndex: j, invertedTime: c.time, sourceFvg: fvg });
        break;
      }
    }
  }
  return ifvgs;
}

// Is this IFVG still "live" (uninvalidated) as of index i? (no candle since
// inversion has closed back beyond the invalidation extreme)
function ifvgValidAt(bars, ifvg, i) {
  if (ifvg.invertedIndex > i) return false; // hasn't happened yet — no lookahead
  for (let j = ifvg.invertedIndex + 1; j <= i; j++) {
    const c = bars[j];
    if (ifvg.direction === 'BEAR' && c.close > ifvg.invalidation) return false;
    if (ifvg.direction === 'BULL' && c.close < ifvg.invalidation) return false;
  }
  return true;
}

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

// TP1 = nearest opposite extreme within a "recent" window (proxy for internal DOL).
// TP2 = the more extreme point within a wider window, beyond TP1 (proxy for
// external DOL) — a same-OHLCV-only substitute for the live pipeline's
// Bryan's-indicator-cross-referenced TP2, since no historical indicator
// labels exist to check against. Documented limitation, not a live match.
function computeTargets(history, isBear) {
  const side = isBear ? 'low' : 'high';
  const recentWindow = history.slice(-100);
  const wideWindow = history.slice(-400);
  const tp1Bar = findExtreme(recentWindow, side);
  const tp1 = roundToTick(isBear ? tp1Bar.low : tp1Bar.high);
  const wideExtremeBar = findExtreme(wideWindow, side);
  const wideExtreme = isBear ? wideExtremeBar.low : wideExtremeBar.high;
  const tp2 = (isBear ? wideExtreme < tp1 - TICK : wideExtreme > tp1 + TICK) ? roundToTick(wideExtreme) : null;
  return { tp1, tp1Bar, tp2 };
}

function buildPlan(fib, direction, history, ifvg) {
  const isBear = direction === 'BEAR';
  const entry = fib.ote705;
  const stop = isBear ? roundToTick(ifvg.invalidation + TICK) : roundToTick(ifvg.invalidation - TICK);
  const { tp1, tp2 } = computeTargets(history, isBear);
  const riskPoints = +Math.abs(entry - stop).toFixed(2);
  const reward1 = Math.abs(entry - tp1);
  const reward2 = tp2 != null ? Math.abs(entry - tp2) : null;
  return {
    direction, entry, stop, tp1, tp2, riskPoints,
    rr1: riskPoints > 0 ? +(reward1 / riskPoints).toFixed(2) : null,
    rr2: (riskPoints > 0 && reward2 != null) ? +(reward2 / riskPoints).toFixed(2) : null,
    passesStopGate: riskPoints <= MAX_STOP_POINTS,
    ifvgUsed: { level: ifvg.level, invalidation: ifvg.invalidation, invertedTime: ifvg.invertedTime },
  };
}

// Score a plan forward using bars strictly after the arming index (this is
// retrospective — fine, since we're scoring, not deciding).
function scorePlan(bars, armIndex, plan) {
  const isBear = plan.direction === 'BEAR';
  const fwd = bars.slice(armIndex + 1);
  let filled = false, filledAt = null, outcome = null, outcomeAt = null, outcomeBarTime = null;
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
    const hitStop = isBear ? b.high >= plan.stop : b.low <= plan.stop;
    const hitT1 = plan.tp1 != null && (isBear ? b.low <= plan.tp1 : b.high >= plan.tp1);
    if (hitStop && hitT1) { outcome = 'AMBIGUOUS (same 3m bar)'; outcomeAt = b.time; }
    else if (hitStop) { outcome = 'STOP'; outcomeAt = b.time; }
    else if (hitT1) { outcome = 'TP1'; outcomeAt = b.time; }
    if (outcome) break;
  }
  const mfe = +Math.abs(plan.entry - favExtreme).toFixed(2);
  const mae = +Math.abs(plan.entry - advExtreme).toFixed(2);
  let resultR = null;
  if (outcome === 'STOP') resultR = -1;
  else if (outcome === 'TP1') resultR = plan.rr1;
  return { filled, filledAt, outcome: outcome || (filled ? 'OPEN (unresolved in available data)' : null), outcomeAt, mfe, mae, resultR };
}

function runSession(label, dateStr, startHHMM, endHHMM) {
  // Build ET-tagged bars once
  const tagged = allBars.map(b => ({ ...b, et: etParts(b.time) }));
  const sessionBars = tagged.filter(b => b.et.dateStr === dateStr && b.et.timeStr >= startHHMM && b.et.timeStr <= endHHMM);
  if (sessionBars.length === 0) throw new Error(`No bars found for ${label} in window ${dateStr} ${startHHMM}-${endHHMM}`);

  const cisdEvents = { BEAR: [], BULL: [] };
  const lastCisdTime = { BEAR: null, BULL: null };
  const stateOf = { BEAR: 'WATCHING', BULL: 'WATCHING' };
  const candidates = [];

  for (const sb of sessionBars) {
    const i = allBars.findIndex(b => b.time === sb.time);
    const history = allBars.slice(0, i + 1);
    const price = sb.close;

    for (const direction of ['BEAR', 'BULL']) {
      const fib = computeChromeFib(history, direction);
      if (!fib) continue;

      if (lastCisdTime[direction] !== fib.cisdBar.time) {
        lastCisdTime[direction] = fib.cisdBar.time;
        stateOf[direction] = 'WATCHING';
        cisdEvents[direction].push({
          detectedAt: sb.time, detectedAtLabel: etLabel(sb.time),
          cisdBar: { time: fib.cisdBar.time, label: etLabel(fib.cisdBar.time), close: fmtTick(fib.cisdBar.close) },
          topAnchor: { time: fib.topAnchorBar.time, label: etLabel(fib.topAnchorBar.time), price: fmtTick(fib.topAnchorPrice) },
          bottomAnchor: { time: fib.bottomAnchorBar.time, label: etLabel(fib.bottomAnchorBar.time), price: fmtTick(fib.bottomAnchorPrice) },
          range: +(fib.topAnchorPrice - fib.bottomAnchorPrice).toFixed(2),
          ote705: fib.ote705, zone618: fib.zone618, zone79: fib.zone79,
        });
      }

      const dist = Math.abs(price - fib.ote705);
      if (dist > OTE_PROXIMITY) continue;

      if (stateOf[direction] === 'WATCHING') {
        stateOf[direction] = 'EYES_ON';
        candidates.push({
          direction, state: 'EYES_ON', at: sb.time, atLabel: etLabel(sb.time),
          level: fib.ote705, distance: +dist.toFixed(2), cisdTime: fib.cisdBar.time,
        });
      }

      if (stateOf[direction] !== 'ARMED') {
        const fvgs = findFVGs(history);
        const ifvgs = findIFVGs(history, fvgs);
        const matchingIfvg = ifvgs.find(f => f.direction === direction && ifvgValidAt(history, f, i) && Math.abs(f.level - fib.ote705) <= IFVG_PROXIMITY);
        if (matchingIfvg) {
          stateOf[direction] = 'ARMED';
          const plan = buildPlan(fib, direction, history, matchingIfvg);
          const score = plan.passesStopGate ? scorePlan(allBars, i, plan) : null;
          candidates.push({
            direction, state: 'ARMED', at: sb.time, atLabel: etLabel(sb.time),
            level: fib.ote705, cisdTime: fib.cisdBar.time,
            ifvg: { level: matchingIfvg.level, invalidation: matchingIfvg.invalidation, invertedAtLabel: etLabel(matchingIfvg.invertedTime) },
            plan, score,
          });
        }
      }
    }
  }

  return { label, dateStr, startHHMM, endHHMM, sessionBars, cisdEvents, candidates };
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

export { runSession, summarizeMoves, findSwings, etLabel, etParts, allBars, MAX_STOP_POINTS };
