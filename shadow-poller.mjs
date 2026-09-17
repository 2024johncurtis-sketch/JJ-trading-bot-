#!/usr/bin/env node
/**
 * shadow-poller.mjs
 *
 * Long-running, detached paper-trade shadow poller. Polls the live chart every
 * POLL_INTERVAL_MS, logs every scan, and tracks every ARMED candidate forward
 * across subsequent ticks to score fill / stop-vs-target / MFE-MAE — without
 * placing any real or simulated order. Stops automatically at CUTOFF_ET.
 *
 * Reuses scan-chart.mjs's exact parsing, dedup, and fib-anchor logic (imported,
 * not duplicated) so both tools stay consistent with each other.
 *
 * Known limitations, stated plainly (not silently swept):
 *  - Outcome sequencing (stop vs target) is resolved at 3-minute bar granularity,
 *    not tick-precise. If both stop and TP1 fall inside the same 3m bar, the
 *    outcome is logged as AMBIGUOUS rather than guessed.
 *  - Brian's-model direction is inferred from whether the nearest real candle
 *    that actually taps the CISD/RB level closed above or below it (spec 3.1
 *    Step 4) — this is a heuristic cross-check, not a byte-perfect replication
 *    of the indicator's internal logic.
 *  - Brian's TP1 uses the spec's fixed 15/40 risk-unit template (spec 3.4);
 *    it is not structurally derived from the actual rejection candle's own
 *    extreme. The 10/30 one-minute-continuation variant is not applied here —
 *    this parser has not observed 1M-tagged CISD/RB labels from Bryan's
 *    Indicator to trigger it.
 *  - A "match" between a Chrome candidate and a Brian's candidate at a nearby
 *    price is treated as an A+ overlap per spec §4, using a fixed proximity
 *    tolerance — not independently verified beyond that.
 *
 * 2026-07-17 fixes (see EVOLUTION.md for the full day-one review that drove these):
 *  - Single reference frame: OUR computed fib.ote705 drives proximity, IFVG
 *    matching, and entry for Chrome — never the raw ScriVindicator tag, which
 *    was the root cause of both 2026-07-16 Chrome plans coming out with the
 *    stop on the wrong side of entry.
 *  - Plans are withheld (not silently presented) when crosscheck.ok is false.
 *  - Hard constraint: any plan (Chrome or Brian's) whose stop distance exceeds
 *    rules.json's hard_constraints.max_stop_points is REJECTED outright and
 *    logged as a rejected candidate, never shown as tradeable.
 *  - Fib anchor bars (top/bottom/CISD, timestamp + price) are persisted in the
 *    per-tick JSONL now, not just in scan-chart.mjs's interactive console output.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getState, setTimeframe } from './src/core/chart.js';
import { getQuote, getPineLabels, getOhlcv } from './src/core/data.js';
import { disconnect } from './src/connection.js';
import {
  parseBryanLabel, parseScrivLabel, dedupBryanBlocks, dedupParsedObjects,
  computeChromeFib, roundToTick, fmtTick, TICK, nearestValidIfvg, computeSMT,
} from './scan-chart.mjs';
import { sendEyesOnAlert, sendArmedAlert, sendCancelledAlert, sendSessionSummary, shouldSendUnfilledCancelledAlert } from './src/notify/discord.mjs';
import { getEs1mBars } from './src/core/smt-feed.js';

// Dedup keys so a still-active zone doesn't re-notify every 30s tick — only
// a genuinely new (id, level) pair fires again.
const notifiedEyesOn = new Set();
const notifiedArmed = new Set();
const notifiedCancelled = new Set();

// Chrome per-direction dedup state, added 2026-08-12 — mirrors
// backtest/engine.mjs's runSession state machine (cisdTime-only dedup,
// rearm only after a genuine stop-out) instead of the previous per-tick id
// (cisdTime+ifvgKey), which let a still-open, never-stopped-out CISD get
// logged as a "new" candidate whenever nearestValidIfvg's pick shifted from
// one tick to the next — confirmed live on 2026-08-10 (82 logged candidates,
// only 60 distinct CISD structures). See engine.mjs's activePlan /
// usedIfvgKeys / seenArmedCisdTimes comments for the full rationale; this is
// the same rule, just re-applied across 30s poll ticks instead of bars.
const chromeState = {
  BEAR: { lastCisdTime: null, activePlan: null, usedIfvgKeys: new Set(), seenArmedCisdTimes: new Set() },
  BULL: { lastCisdTime: null, activePlan: null, usedIfvgKeys: new Set(), seenArmedCisdTimes: new Set() },
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POLL_INTERVAL_MS = 30_000;
const CHROME_FIB_LOOKBACK_BARS = 300; // bars fetched for the CISD search, see scan-chart.mjs
const A_PLUS_OVERLAP_TOLERANCE = 15; // points — Chrome & Brian's candidates within this = A+ per spec §4
const CROSSCHECK_TOLERANCE = 1; // points — must match scan-chart.mjs's own tolerance

const RULES_PATH = path.join(__dirname, 'rules.json');
const rules = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
const MAX_STOP_POINTS = rules.hard_constraints?.max_stop_points ?? 20;
const MANUAL_BREAKEVEN_POINTS = rules.hard_constraints?.manual_breakeven_points ?? 15;
console.log(`Loaded hard constraint from rules.json: max_stop_points = ${MAX_STOP_POINTS}, manual_breakeven_points = ${MANUAL_BREAKEVEN_POINTS}`);

const SESSIONS_DIR = path.join(__dirname, 'sessions');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function todayKeyET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}
function nowET_HHMM() {
  return new Date().toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false }).slice(0, 5);
}
function isoNow() { return new Date().toISOString(); }

// Converts an America/New_York wall-clock date+time into its real epoch ms,
// via the standard double-conversion trick (treat the target as if it were
// UTC, format THAT instant back in ET, and use the difference as the
// correction — self-corrects for DST since it uses the actual offset at
// that moment). Good for any single target within the current DST period;
// not meant for cutoffs many months out that straddle a DST transition.
function etDateTimeToEpochMs(dateStr, timeStr) {
  const naiveUtc = new Date(`${dateStr}T${timeStr}:00Z`);
  const etFormatted = naiveUtc.toLocaleString('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const [d, t] = etFormatted.split(', ');
  const [mm, dd, yyyy] = d.split('/');
  const asIfUtc = new Date(`${yyyy}-${mm}-${dd}T${t}Z`);
  const offsetMs = naiveUtc.getTime() - asIfUtc.getTime();
  return naiveUtc.getTime() + offsetMs;
}

// Cutoff arg supports two forms:
//  - "HH:MM"              — same-day cutoff (original behavior, RUNBOOK's
//                            normal single-morning-session usage)
//  - "YYYY-MM-DD HH:MM"   — absolute ET date+time, for a session that runs
//                            past midnight into the next calendar day
const cutoffArg = process.argv[2] || '11:30';
const absoluteMatch = cutoffArg.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/);
const CUTOFF_ET = absoluteMatch ? absoluteMatch[2] : cutoffArg;
const CUTOFF_EPOCH_MS = absoluteMatch ? etDateTimeToEpochMs(absoluteMatch[1], absoluteMatch[2]) : null;
const CUTOFF_LABEL = absoluteMatch ? `${absoluteMatch[1]} ${absoluteMatch[2]} ET` : `${CUTOFF_ET} ET (today)`;

const sessionDate = todayKeyET();
const LOG_PATH = path.join(SESSIONS_DIR, `${sessionDate}.jsonl`);
const SUMMARY_PATH = path.join(SESSIONS_DIR, `${sessionDate}-candidates.json`);

function appendLog(obj) {
  fs.appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n');
}

// --- Candidate registry: in-memory for the process lifetime, mirrored to SUMMARY_PATH each tick ---
const registry = new Map();
// PROPOSALS.md #9: previously `chromeId(direction)` alone (e.g. "chrome:BEAR"),
// one registry slot per direction for the whole session. Once the first
// ARMED-with-plan candidate for a direction was tracked, ANY later, genuinely
// different plan (new CISD, new IFVG) still correctly showed ARMED in the
// console/JSONL but only overwrote that same slot's `grade` field — it never
// got its own fill/outcome/mfe/mae tracking or its own registry entry. Now
// the id incorporates the plan's identity (cisdTime + ifvg invertedTime) so
// a genuinely new plan gets a fresh Map key, while an unchanged plan across
// ticks (same cisdTime+ifvg) keeps hitting the same entry as before.
function chromeId(direction, planKey) { return planKey ? `chrome:${direction}:${planKey}` : `chrome:${direction}`; }
function briansId(o) { return `brians:${o.tf}:${Math.round(o.price)}`; }


function inferBriansDirection(bars, level, tolerance = 6) {
  const touching = bars.filter(b => b.low - tolerance <= level && b.high + tolerance >= level);
  if (touching.length === 0) return null;
  const b = touching[touching.length - 1];
  if (b.close > level) return { direction: 'BULL', bar: b };
  if (b.close < level) return { direction: 'BEAR', bar: b };
  return null;
}

function findSwingExtreme(bars, side) {
  let best = bars[0];
  for (const b of bars) {
    if (side === 'low' && b.low < best.low) best = b;
    if (side === 'high' && b.high > best.high) best = b;
  }
  return best;
}

function buildChromeTradePlan(fib, direction, bars3m, ifvgObj, bryanObjects) {
  // Single reference frame (2026-07-17): entry, stop, and the IFVG this plan
  // was confirmed against are ALL derived from fib.ote705 — ifvgObj here is
  // guaranteed (by the caller) to have been matched against fib.ote705, not
  // the raw ScriVindicator tag.
  const entry = fib.ote705;
  const isBear = direction === 'BEAR';

  // 2026-07-18 independence build: ifvgObj is now OUR OWN computed IFVG
  // (scan-chart.mjs nearestValidIfvg), which already carries the exact
  // invalidation extreme (spec 1.2's "that extreme = the defined stop") —
  // no need to search for a nearby candle to approximate a raw tag price
  // anymore, that heuristic (nearestExtremeBar) is retired.
  let stop, stopSource;
  if (ifvgObj) {
    stop = isBear ? roundToTick(ifvgObj.invalidation + TICK) : roundToTick(ifvgObj.invalidation - TICK);
    stopSource = `our own IFVG invalidation extreme (inverted ${etTimeShort(ifvgObj.invertedTime)})`;
  } else {
    stop = isBear ? roundToTick(fib.topAnchorPrice + TICK) : roundToTick(fib.bottomAnchorPrice - TICK);
    stopSource = 'fallback: fib swing-anchor extreme (no IFVG object passed in)';
  }

  const opp = isBear ? 'low' : 'high';
  const swingOpp = findSwingExtreme(bars3m, opp);
  const tp1 = roundToTick(isBear ? swingOpp.low : swingOpp.high);

  const beyond = bryanObjects
    .filter(o => o.price != null)
    .filter(o => isBear ? o.price < tp1 - TICK : o.price > tp1 + TICK)
    .sort((a, b) => isBear ? b.price - a.price : a.price - b.price);
  const tp2 = beyond.length ? roundToTick(beyond[0].price) : null;
  const tp2Source = beyond.length ? `Bryan's ${beyond[0].tf} ${beyond[0].text} @ ${beyond[0].price}` : "no further Bryan's-marked structure found — no TP2";

  const risk = Math.abs(entry - stop);
  const reward1 = Math.abs(entry - tp1);
  const reward2 = tp2 != null ? Math.abs(entry - tp2) : null;

  const breakevenAt = roundToTick(isBear ? entry - MANUAL_BREAKEVEN_POINTS : entry + MANUAL_BREAKEVEN_POINTS);
  return {
    model: "JJ's Model", direction, entry, stop, tp1, tp2,
    stopSource, tp2Source,
    rr1: risk > 0 ? +(reward1 / risk).toFixed(2) : null,
    rr2: (risk > 0 && reward2 != null) ? +(reward2 / risk).toFixed(2) : null,
    riskPoints: +risk.toFixed(2),
    breakevenAt, breakevenPoints: MANUAL_BREAKEVEN_POINTS,
    anchors: {
      cisdBar: { time: fib.cisdBar.time, timeET: etTimeShort(fib.cisdBar.time), close: fmtTick(fib.cisdBar.close) },
      topAnchorBar: { time: fib.topAnchorBar.time, timeET: etTimeShort(fib.topAnchorBar.time), price: fmtTick(fib.topAnchorPrice) },
      bottomAnchorBar: { time: fib.bottomAnchorBar.time, timeET: etTimeShort(fib.bottomAnchorBar.time), price: fmtTick(fib.bottomAnchorPrice) },
    },
  };
}

const MIN_STOP_POINTS = 2; // see scan-chart.mjs's MIN_IFVG_RISK_POINTS comment (2026-07-26) for the reasoning

// Hard-constraint gate (2026-07-17): applies to both models. A plan can be
// numerically self-consistent and still unacceptable for JJ if it's oversized
// — per rules.json hard_constraints, never presented as tradeable.
//
// 2026-07-26: now also checks DIRECTION and a minimum size, not just the
// upper bound. `riskPoints` is always `Math.abs(entry - stop)` — that's
// necessary to get a magnitude at all, but it also means a backwards stop
// (on the wrong side of entry — e.g. above entry on a BULL) used to produce
// a small, plausible-looking positive number and sail through this gate
// untouched. Confirmed live 2026-07-26: entry 28607.75, stop 28613.75,
// reported as a valid "6pt risk" BULL plan. `nearestValidIfvg`
// (scan-chart.mjs) is fixed at the source to never hand back a wrong-side
// or degenerate-size match now, but this gate checks independently too —
// a plan is never "valid" just because its input was.
function applyHardConstraints(plan) {
  if (!plan || plan.entry == null || plan.stop == null) return { plan, rejected: false };
  const isBear = plan.direction === 'BEAR';
  const onCorrectSide = isBear ? plan.stop > plan.entry : plan.stop < plan.entry;
  if (!onCorrectSide) {
    return {
      plan: null,
      rejected: true,
      rejectReason: `stop is on the wrong side of entry (${plan.stop} vs entry ${plan.entry}, direction ${plan.direction}) — invalid plan, not a real trade`,
      rejectedPlan: plan,
    };
  }
  if (plan.riskPoints < MIN_STOP_POINTS) {
    return {
      plan: null,
      rejected: true,
      rejectReason: `stop under ${MIN_STOP_POINTS}pt minimum (${plan.riskPoints}pt — noise-level, not a real structural inversion)`,
      rejectedPlan: plan,
    };
  }
  if (plan.riskPoints > MAX_STOP_POINTS) {
    return {
      plan: null,
      rejected: true,
      rejectReason: `stop exceeds max risk (${plan.riskPoints}pt > ${MAX_STOP_POINTS}pt hard limit, rules.json hard_constraints.max_stop_points)`,
      rejectedPlan: plan, // kept for the log so the numbers aren't lost, just marked untradeable
    };
  }
  return { plan, rejected: false };
}

function buildBriansTradePlan(o, bars) {
  const inferred = inferBriansDirection(bars, o.price);
  if (!inferred) {
    return { model: "JJ's Rejection", direction: 'UNKNOWN', entry: null, stop: null, tp1: null, tp2: null, note: 'Direction not inferable — no recent candle found tapping this level within tolerance.' };
  }
  const { direction, bar } = inferred;
  const isBear = direction === 'BEAR';
  const entry = roundToTick(o.price);
  const stopPts = 15, t1Pts = 40; // spec 3.4 standard risk units
  const stop = roundToTick(isBear ? entry + stopPts : entry - stopPts);
  const tp1 = roundToTick(isBear ? entry - t1Pts : entry + t1Pts);
  const breakevenAt = roundToTick(isBear ? entry - MANUAL_BREAKEVEN_POINTS : entry + MANUAL_BREAKEVEN_POINTS);
  return {
    model: "JJ's Rejection", direction, entry, stop, tp1, tp2: null,
    directionSource: `candle-inferred: bar @ ${etTimeShort(bar.time)} closed ${isBear ? 'below' : 'above'} the level`,
    rr1: +(t1Pts / stopPts).toFixed(2),
    riskPoints: stopPts,
    breakevenAt, breakevenPoints: MANUAL_BREAKEVEN_POINTS,
    note: "Fixed spec 3.4 risk units (15/40), not structurally derived from the rejection candle's own extreme — known simplification.",
  };
}

function etTimeShort(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// 2026-07-31: implements rules.json spec §5.11 ("Partial-profit template —
// TP1 at the internal-range DOL, runner to the external target. Stop to
// breakeven only after TP1 fills, not before"), mirroring backtest/engine.mjs's
// scorePlan (see that function's comment for the position-split assumption
// and the TP2-null fallback). `stage` is a LOCAL variable recomputed fresh
// on every call by replaying relevantBars from the top — not persisted on
// `record` — so an incrementally-growing bar window (this function is
// called every tick with more bars each time) always replays the correct
// bar-by-bar order instead of resuming from a possibly-stale stage.
function updateTrackedCandidate(record, bars) {
  if (!record.plan || record.plan.entry == null) return;
  const { entry, stop, tp1, tp2 } = record.plan;
  const isBear = record.direction === 'BEAR';

  let relevantBars = bars.filter(b => b.time >= record.first_armed_at_epoch);
  if (relevantBars.length === 0) relevantBars = [bars[bars.length - 1]];

  if (!record.filled) {
    const touched = relevantBars.some(b => isBear ? b.high >= entry : b.low <= entry);
    if (touched) { record.filled = true; record.filled_at = isoNow(); }
  }

  // 2026-09-01 fix: captured BEFORE the stage loop below can mutate
  // record.outcome. A trade that fills and resolves within the same call
  // (fast move, or the poller just restarted and this is its first tick on
  // an already-in-flight structure) used to skip the mfe/mae block entirely
  // — that block only ran `if (!record.outcome)`, which was already false
  // by the time it checked, since the loop above had just set it moments
  // earlier in this SAME function call. Confirmed live 2026-09-01: a STOP
  // outcome logged mfe=0/mae=0, which is only possible if mfe/mae were never
  // computed even once. resolveBarTime (set at every outcome assignment
  // below) lets the mfe/mae calc bound itself to "through the resolving bar"
  // in that same-tick case, while wasAlreadyResolved preserves the original
  // 2026-08-24 freeze behavior for every later tick.
  const wasAlreadyResolved = !!record.outcome;
  let resolveBarTime = null;

  if (record.filled && !record.outcome) {
    // FULL (original stop) -> BE_TARGET_T1 (stop at BE via JJ's 15pt manual
    // rule, no partial credit yet since TP1 hasn't filled) -> RUNNER (stop
    // at BE via TP1 fill, targeting TP2, half-position credit banked at
    // TP1). 2026-08-12: BE_TARGET_T1 added per JJ — he moves his own stop
    // to breakeven once price has moved manual_breakeven_points in his
    // favor, regardless of whether TP1 has filled yet. Whichever trigger
    // (15pt move or TP1 fill) happens first wins; targets are unchanged.
    let stage = 'FULL';
    for (const b of relevantBars) {
      if (b.time < (record.filled_at_epoch || 0)) continue;
      if (stage === 'FULL') {
        const favMove = isBear ? entry - b.low : b.high - entry;
        const hitStop = isBear ? b.high >= stop : b.low <= stop;
        const hitT1 = tp1 != null && (isBear ? b.low <= tp1 : b.high >= tp1);
        if (hitStop && hitT1) {
          record.outcome = 'AMBIGUOUS — stop and TP1 both within the same 3m bar, cannot determine sequence from bar data alone';
          record.outcome_bar_time = etTimeShort(b.time); resolveBarTime = b.time;
          break;
        } else if (hitStop) {
          record.outcome = 'STOP'; record.outcome_bar_time = etTimeShort(b.time); resolveBarTime = b.time; break;
        } else if (hitT1) {
          record.tp1_hit_at = etTimeShort(b.time);
          // 2026-08-27: full exit at TP1 regardless of tp2, JJ's call after
          // backtesting both against spec §5.11's partial+runner default on
          // the 26-day set — TP2 never hit once in that data under either
          // style (+65.15R partial+runner vs +82.73R full-exit). See
          // backtest/engine.mjs's scorePlan for the full rationale.
          record.outcome = 'TP1'; record.outcome_bar_time = etTimeShort(b.time); resolveBarTime = b.time; break;
        } else if (favMove >= MANUAL_BREAKEVEN_POINTS) {
          stage = 'BE_TARGET_T1'; // JJ's manual rule fired before TP1 did
          continue;
        }
      } else if (stage === 'BE_TARGET_T1') {
        const hitBE = isBear ? b.high >= entry : b.low <= entry;
        const hitT1 = tp1 != null && (isBear ? b.low <= tp1 : b.high >= tp1);
        if (hitBE && hitT1) {
          record.outcome = 'AMBIGUOUS — breakeven and TP1 both within the same 3m bar';
          record.outcome_bar_time = etTimeShort(b.time); resolveBarTime = b.time;
          break;
        } else if (hitT1) {
          record.tp1_hit_at = etTimeShort(b.time);
          // 2026-08-27: full exit at TP1 regardless of tp2, JJ's call after
          // backtesting both against spec §5.11's partial+runner default on
          // the 26-day set — TP2 never hit once in that data under either
          // style (+65.15R partial+runner vs +82.73R full-exit). See
          // backtest/engine.mjs's scorePlan for the full rationale.
          record.outcome = 'TP1'; record.outcome_bar_time = etTimeShort(b.time); resolveBarTime = b.time; break;
        } else if (hitBE) {
          record.outcome = 'BREAKEVEN (manual 15pt rule, pre-TP1)'; record.outcome_bar_time = etTimeShort(b.time); resolveBarTime = b.time; break;
        }
      } else {
        // 2026-08-27: stage is never actually set to 'RUNNER' anymore (both
        // branches above always break on TP1 now) — left in place rather
        // than deleted in case the runner-to-TP2 style ever comes back.
        const hitBE = isBear ? b.high >= entry : b.low <= entry;
        const hitT2 = isBear ? b.low <= tp2 : b.high >= tp2;
        if (hitBE && hitT2) {
          record.outcome = 'AMBIGUOUS (runner) — breakeven and TP2 both within the same 3m bar';
          record.outcome_bar_time = etTimeShort(b.time); resolveBarTime = b.time;
          break;
        } else if (hitT2) {
          record.outcome = 'TP2'; record.outcome_bar_time = etTimeShort(b.time); resolveBarTime = b.time; break;
        } else if (hitBE) {
          record.outcome = 'BREAKEVEN'; record.outcome_bar_time = etTimeShort(b.time); resolveBarTime = b.time; break;
        }
      }
    }
    record.stage = stage; // informational — lets the summary show "runner, stop at BE" while still open
  }

  // 2026-08-24 fix: this used to recompute unconditionally every tick using
  // ALL of `relevantBars` (first_armed_at_epoch through "now"), with no
  // upper bound at the outcome bar — a resolved record stays in the
  // registry for the rest of the session, and every later tick, mfe/mae
  // kept growing from price action that happened AFTER the trade was
  // already closed. Confirmed live: STOP trades from a 2026-08-23 session
  // showed mfe up to 398pts against an 11pt stop — that's not how far the
  // trade ran, that's the market's range for the rest of the night. Only
  // recompute while genuinely still open (no outcome yet); freeze once
  // resolved.
  //
  // 2026-09-01 fix: "still open" now means wasAlreadyResolved is false, not
  // record.outcome is currently null — a trade resolving THIS call still
  // gets one real mfe/mae computation (bounded to resolveBarTime, i.e.
  // through the resolving bar only, never past it) instead of being frozen
  // at its registry-init default of 0/0 forever. A trade resolved on a
  // PRIOR call still skips this block entirely, preserving the freeze.
  if (!wasAlreadyResolved) {
    const scanBars = resolveBarTime != null ? relevantBars.filter(b => b.time <= resolveBarTime) : relevantBars;
    const favExtreme = isBear ? Math.min(...scanBars.map(b => b.low)) : Math.max(...scanBars.map(b => b.high));
    const advExtreme = isBear ? Math.max(...scanBars.map(b => b.high)) : Math.min(...scanBars.map(b => b.low));
    record.mfe = +(Math.abs(entry - favExtreme)).toFixed(2);
    record.mae = +(Math.abs(entry - advExtreme)).toFixed(2);
  }

  if (record.outcome && record.resultR == null) {
    if (record.outcome === 'STOP') record.resultR = -1;
    else if (record.outcome === 'TP1') record.resultR = record.plan.rr1 ?? null;
    else if (record.outcome === 'BREAKEVEN (manual 15pt rule, pre-TP1)') record.resultR = 0; // full position scratched, nothing banked at TP1 yet
    else if (record.outcome === 'BREAKEVEN') record.resultR = record.plan.rr1 != null ? +(0.5 * record.plan.rr1).toFixed(2) : null; // TP1 half already banked
    else if (record.outcome === 'TP2') record.resultR = (record.plan.rr1 != null && record.plan.rr2 != null) ? +(0.5 * record.plan.rr1 + 0.5 * record.plan.rr2).toFixed(2) : null;
  }
}

async function tick() {
  const state = await getState();
  const quote = await getQuote({});
  const price = quote.last;
  const originalResolution = state.resolution;

  const labelResp = await getPineLabels({ max_labels: 200 });
  const bryanBlocksRaw = labelResp.studies.filter(s => /bryan/i.test(s.name));
  const bryanBlocks = dedupBryanBlocks(bryanBlocksRaw);
  const scrivBlock = labelResp.studies.find(s => /scrivindicator/i.test(s.name));

  const bryanObjectsRaw = bryanBlocks.flatMap(b => b.labels.map(l => parseBryanLabel(l.text, l.price)));
  const bryanObjects = dedupParsedObjects(bryanObjectsRaw);
  const scrivObjects = scrivBlock ? scrivBlock.labels.map(l => parseScrivLabel(l.text, l.price)) : [];

  await setTimeframe({ timeframe: '3' });
  const ohlcv3m = await getOhlcv({ count: CHROME_FIB_LOOKBACK_BARS, summary: false });
  await setTimeframe({ timeframe: originalResolution });

  // 2026-08-12: getOhlcv's last bar is whatever candle is CURRENTLY forming
  // on the chart (src/core/data.js reads straight off TradingView's live
  // bars model, no closed-bar filtering) — polling every 30s against 3-min
  // bars means most ticks would otherwise be judging CISD shape, rejection
  // wicks, and IFVG confirmation against a candle that can still change
  // before it closes. closedBars drops that still-forming bar for anything
  // that's PATTERN DETECTION (arming a new signal) — matches what the
  // backtest actually validated, since replayed historical bars are closed
  // by definition. Outcome tracking on an ALREADY-armed trade (stop/target/
  // breakeven hits, MFE/MAE) deliberately keeps using the live ohlcv3m.bars
  // below — "did price cross this level" is a fact the instant it happens,
  // not something that un-happens when the candle closes, so there's no
  // reason to add latency there.
  const closedBars = ohlcv3m.bars.length > 1 ? ohlcv3m.bars.slice(0, -1) : ohlcv3m.bars;

  // PROPOSALS.md #6: re-enabled 2026-07-23 with a redesigned smt-feed.js —
  // reads JJ's already-open ES1! tab directly by probing for its symbol, no
  // tab creation/closing/keyboard shortcuts at all (the original open/close
  // version broke the shared connection to the live chart — see PROPOSALS.md
  // #6 for that incident). If the ES1! tab isn't open, this returns null and
  // logs once; confluence-only per spec §1.4, never gates either way.
  const es1Bars = await getEs1mBars(300).catch(() => null);
  const smt = es1Bars ? computeSMT(ohlcv3m.bars, es1Bars, 20) : null;

  // 2026-07-18 independence build: both directions always evaluated from our
  // own computation, no longer gated on whether ScriVindicator happens to
  // show an OTE tag. IFVG confirmation uses our own direction-verified,
  // freshest-within-proximity detection (nearestValidIfvg) instead of reading
  // the indicator's IFVG tags. The crosscheck against ScriVindicator's OTE
  // tag (if it's showing one) is now informational telemetry only — it no
  // longer withholds a plan. See EVOLUTION.md 2026-07-18, PROPOSALS.md #1.
  const otes = scrivObjects.filter(o => o.type === 'OTE');
  const fibByDirection = { BEAR: computeChromeFib(closedBars, 'BEAR'), BULL: computeChromeFib(closedBars, 'BULL') };

  const tickCandidates = [];
  const rejectedCandidates = [];
  const cancelledPlans = [];

  for (const direction of ['BEAR', 'BULL']) {
    const fib = fibByDirection[direction];
    const ote = otes.find(o => o.direction === direction);
    const cs = chromeState[direction];

    // 2026-08-23: JJ asked for a CANCEL alert when a signal he already got
    // told to take stops being one we'd still take, before he ever filled
    // it — so he isn't left guessing which alert in his feed is still live.
    // Only fires for a plan that never filled (registry.filled === false) —
    // once JJ's actually in the trade, its fate is the resolution alert's
    // job, not this one. Helper shared by both trigger paths below (new
    // CISD superseding the old one, and the anchor going stale/expired).
    function cancelIfUnfilled(reason) {
      if (!cs.activePlan) return;
      const record = registry.get(cs.activePlan.id);
      if (record && !record.filled) {
        cancelledPlans.push({
          id: cs.activePlan.id, model: "JJ's Model", direction,
          entry: cs.activePlan.plan.entry, stop: cs.activePlan.plan.stop, reason,
        });
      }
    }

    if (!fib) {
      cancelIfUnfilled('no CISD found in the search window anymore');
      cs.activePlan = null;
      tickCandidates.push({
        id: chromeId(direction), model: "JJ's Model", direction, state: 'WATCHING',
        level: null, distance: null, crosscheck: null,
        grade: 'no independent fib — no CISD found in search window',
        plan: null,
      });
      continue;
    }

    // 2026-07-17/18 recalibration: anchor-freshness expiry (scan-chart.mjs
    // isAnchorExpired). Pre-session/stale CISDs are not used unless price is
    // actively working their own 0.705 — logged as EXPIRED, not silently
    // dropped, so this is visible in the JSONL exactly like a rejection.
    if (fib.expired) {
      // 2026-08-23: this used to leave cs.activePlan set forever if the
      // structure went stale before ever filling — it just silently stopped
      // updating (this whole branch continues past the state machine below)
      // rather than clearing, which could make the NEXT non-expired tick on
      // the same still-unfilled CISD resume tracking a genuinely stale plan.
      cancelIfUnfilled(`the setup went stale (pre-session or 2hr+ old) before it ever filled — CISD @ ${etTimeShort(fib.cisdBar.time)}`);
      cs.activePlan = null;
      tickCandidates.push({
        id: chromeId(direction), model: "JJ's Model", direction, state: 'WATCHING',
        level: null, distance: null, crosscheck: null, expiredAnchor: true, path: fib.path,
        grade: `EXPIRED ANCHOR (${fib.path}) — CISD @ ${etTimeShort(fib.cisdBar.time)} is pre-session or stale and price is not within proximity of its 0.705 (${fmtTick(fib.ote705)})`,
        plan: null,
      });
      continue;
    }

    // Informational only now — logged when ScriVindicator happens to be
    // showing an OTE tag, purely to monitor drift, never gates.
    let crosscheck = null;
    if (ote) {
      const delta = +Math.abs(fib.ote705 - ote.price).toFixed(2);
      crosscheck = { computed705: fib.ote705, tag: ote.price, delta, ok: delta <= CROSSCHECK_TOLERANCE };
    }
    const anchors = {
      cisdBar: { time: fib.cisdBar.time, timeET: etTimeShort(fib.cisdBar.time), close: fmtTick(fib.cisdBar.close) },
      topAnchorBar: { time: fib.topAnchorBar.time, timeET: etTimeShort(fib.topAnchorBar.time), price: fmtTick(fib.topAnchorPrice) },
      bottomAnchorBar: { time: fib.bottomAnchorBar.time, timeET: etTimeShort(fib.bottomAnchorBar.time), price: fmtTick(fib.bottomAnchorPrice) },
    };

    // Genuinely new CISD structure -> drop tracking of whatever was active
    // under the old one (a fresh structure starts with a clean slate, same
    // as engine.mjs's runSession on a cisdTime change).
    if (cs.lastCisdTime !== fib.cisdBar.time) {
      cancelIfUnfilled(`a newer CISD structure formed (@ ${etTimeShort(fib.cisdBar.time)}) before this one ever filled`);
      cs.lastCisdTime = fib.cisdBar.time;
      cs.activePlan = null;
      cs.usedIfvgKeys = new Set();
    }
    // NOTE: whether this plan has actually closed out (stop, breakeven via
    // the 15pt rule, TP1, TP2 — any of them) is decided in main(), from the
    // SAME registry/updateTrackedCandidate outcome used for real scoring,
    // right after each tick. See the "resolve activePlans" block there.
    // 2026-08-14: this used to duplicate that check here with its own
    // bar-scan against only the ORIGINAL stop price — blind to the 15pt
    // manual-breakeven rule added 2026-08-12, so a trade that had already
    // scratched at breakeven (or even won at TP1) could still "re-arm" a
    // new plan later just because price happened to wander back through
    // where the original stop used to be, long after the trader was
    // already flat. Confirmed live on both 2026-08-12 and 2026-08-13 —
    // 3 of 54 signals on the 08-13 overnight session fired for exactly
    // this reason. Single source of truth now: registry outcome only.

    const dist = Math.abs(price - fib.ote705);
    let st = 'WATCHING';
    let plan = null;
    let planStatus = null;
    let planKey = null;

    if (dist <= 40) {
      if (cs.activePlan) {
        // Still-open plan under this same CISD, not stopped out — reuse its
        // identity instead of re-evaluating nearestValidIfvg, so a shifted
        // IFVG pick this tick can't manufacture a "new" candidate out of the
        // same live trade (this was the actual bug: previously every tick
        // recomputed planKey from whatever nearestValidIfvg picked right
        // now, with no memory of "is there already an untouched plan open").
        st = 'ARMED';
        planKey = `${fib.cisdBar.time}:${cs.activePlan.ifvgKey}`;
        plan = cs.activePlan.plan;
      } else {
        const confirmingIfvg = nearestValidIfvg(closedBars, direction, fib.ote705, 40, cs.usedIfvgKeys);
        st = confirmingIfvg ? 'ARMED' : 'EYES_ON';

        if (st === 'ARMED') {
          // Dedup by cisdTime alone (not cisdTime+ifvg) — a genuine re-arm
          // (rearm=true, i.e. usedIfvgKeys is non-empty because a REAL
          // stop-out happened above) is exempted; anything else re-hitting
          // this same still-fresh cisdTime is not a new setup.
          const rearm = cs.usedIfvgKeys.size > 0;
          if (rearm || !cs.seenArmedCisdTimes.has(fib.cisdBar.time)) {
            cs.seenArmedCisdTimes.add(fib.cisdBar.time);
            planKey = `${fib.cisdBar.time}:${confirmingIfvg.invertedTime}`;
            const built = buildChromeTradePlan(fib, direction, closedBars, confirmingIfvg, bryanObjects);
            const gated = applyHardConstraints(built);
            if (gated.rejected) {
              planStatus = `REJECTED — ${gated.rejectReason}`;
              rejectedCandidates.push({ id: chromeId(direction, planKey), model: "JJ's Model", direction, reason: gated.rejectReason, rejectedPlan: gated.rejectedPlan });
            } else {
              plan = gated.plan;
              cs.activePlan = {
                id: chromeId(direction, planKey), stop: plan.stop, ifvgKey: confirmingIfvg.invertedTime,
                armedAt: closedBars[closedBars.length - 1].time, plan,
              };
            }
          } else {
            // Same cisdTime already armed, no genuine stop-out since —
            // nothing new to report this tick.
            st = 'WATCHING';
          }
        }
      }
    }

    // 2026-08-23: JJ doesn't want the grade field framed around whether a
    // Brian's candidate happens to overlap anymore — a short reason for
    // THIS trade on its own terms instead. This is always literally true by
    // the time a candidate reaches ARMED (that's Chrome's own entry
    // criteria), so it's a real reason, not filler.
    const biasWord = direction === 'BULL' ? 'Bullish' : 'Bearish';
    tickCandidates.push({
      id: chromeId(direction, planKey), model: "JJ's Model", direction, state: st,
      level: fib.ote705, distance: +dist.toFixed(2),
      crosscheck, anchors, path: fib.path,
      grade: `${biasWord}: CISD confirmed, price retraced into the 0.705 OTE with independent IFVG confirmation.`,
      plan, planStatus,
    });
  }

  for (const o of bryanObjects) {
    if (o.type !== 'CISD_RB' && o.type !== 'CISD') continue;
    const dist = Math.abs(price - o.price);
    const st = o.type === 'CISD_RB' ? 'ARMED' : 'EYES_ON';
    let plan = null;
    let planStatus = null;
    if (st === 'ARMED') {
      const built = buildBriansTradePlan(o, closedBars);
      const gated = applyHardConstraints(built);
      if (gated.rejected) {
        planStatus = `REJECTED — ${gated.rejectReason}`;
        rejectedCandidates.push({ id: briansId(o), model: "JJ's Rejection", direction: built.direction, reason: gated.rejectReason, rejectedPlan: gated.rejectedPlan });
      } else {
        plan = gated.plan;
      }
    }
    tickCandidates.push({
      id: briansId(o), model: "JJ's Rejection", direction: plan ? plan.direction : 'UNKNOWN', state: st,
      level: o.price, distance: +dist.toFixed(2),
      grade: o.type === 'CISD_RB' ? `indicator-reported: CISD + ${o.grade} RB` : `CISD only (×${o.count}, no RB yet)`,
      plan, planStatus,
    });
  }

  // A+ overlap check per spec §4: independent Chrome + Brian's ARMED candidates
  // within tolerance, same direction (where Brian's direction is known).
  // 2026-08-23: JJ no longer wants Chrome's own grade text reframed around
  // this ("I don't care about Brian's thing anymore... just give me a short
  // reason why we're taking this trade") — Chrome's grade stays its own
  // short reason regardless of overlap. Brian's candidate still gets the
  // overlap note appended to ITS OWN alert, since that side wasn't the
  // complaint.
  const chromeArmed = tickCandidates.filter(c => c.model === "JJ's Model" && c.state === 'ARMED');
  const briansArmed = tickCandidates.filter(c => c.model === "JJ's Rejection" && c.state === 'ARMED');
  for (const cc of chromeArmed) {
    for (const bc of briansArmed) {
      if (Math.abs(cc.level - bc.level) <= A_PLUS_OVERLAP_TOLERANCE && (bc.direction === 'UNKNOWN' || bc.direction === cc.direction)) {
        bc.grade += ` | A+ candidate — overlaps ${cc.id} within ${A_PLUS_OVERLAP_TOLERANCE}pt (spec §4).`;
      }
    }
  }

  return { ts: isoNow(), etTime: nowET_HHMM(), price, tickCandidates, rejectedCandidates, cancelledPlans, bars3m: ohlcv3m.bars, smt };
}

async function main() {
  console.log(`Shadow poller starting. Session date (ET): ${sessionDate}. Cutoff: ${CUTOFF_LABEL}.`);
  console.log(`Log: ${LOG_PATH}`);
  console.log(`Summary: ${SUMMARY_PATH}`);
  appendLog({ event: 'START', ts: isoNow(), etTime: nowET_HHMM(), cutoff: CUTOFF_ET, pollIntervalMs: POLL_INTERVAL_MS });

  // PROPOSALS.md #6: prime the ES1! cache once at startup. No tab
  // creation/closing here — just a direct read of whatever's already open
  // on CME_MINI:ES1!, so this can't disturb JJ's chart tab either way.
  console.log('Priming SMT ES1! feed (reads the already-open ES1! tab, if any)...');
  await getEs1mBars(300).catch((err) => console.log(`[smt-feed] startup priming failed: ${err.message} — will retry on the next scheduled refresh.`));

  while (true) {
    const hhmm = nowET_HHMM();
    // Absolute (date+time) cutoffs compare real epoch ms, so this correctly
    // spans midnight into the next calendar day. Plain HH:MM cutoffs keep
    // the original same-day string comparison (RUNBOOK's normal usage).
    const cutoffReached = CUTOFF_EPOCH_MS != null ? Date.now() >= CUTOFF_EPOCH_MS : hhmm >= CUTOFF_ET;
    if (cutoffReached) {
      appendLog({ event: 'STOP', ts: isoNow(), etTime: hhmm, reason: 'cutoff reached' });
      console.log(`Cutoff (${CUTOFF_LABEL}) reached at ${hhmm} ET. Stopping.`);
      const records = [...registry.values()];
      const filledCount = records.filter(r => r.filled).length;
      // Uses the same resultR updateTrackedCandidate already computes (now
      // spec §5.11-aware: STOP=-1, TP1=full rr1, BREAKEVEN/TP2=partial-exit
      // blend) instead of re-deriving it ad hoc here with the old TP1-only logic.
      const cumulativeR = records.reduce((s, r) => s + (r.resultR || 0), 0);
      await sendSessionSummary({
        sessionDate, armedCount: records.length, gatePassCount: records.length, filledCount,
        cumulativeR: +cumulativeR.toFixed(2),
        notes: `Session ended ${hhmm} ET (cutoff ${CUTOFF_LABEL}).`,
      }).catch(() => {});
      break;
    }

    try {
      const result = await tick();
      const nowEpoch = Math.floor(Date.now() / 1000);

      // Only track candidates that reached ARMED *with a usable plan* — an
      // ARMED-but-withheld (crosscheck failed) or ARMED-but-rejected (stop
      // too big) candidate has no entry price to score fills against. Both
      // are still fully visible in the per-tick JSONL below via planStatus.
      for (const c of result.tickCandidates) {
        if (c.state === 'EYES_ON') {
          const key = `${c.id}:${c.level}`;
          if (!notifiedEyesOn.has(key)) {
            notifiedEyesOn.add(key);
            sendEyesOnAlert(c).catch(() => {}); // notification failure must never break the poll loop
          }
        }
        if (c.state !== 'ARMED' || !c.plan) continue;
        // 2026-07-26 fix: was `${c.id}:${c.plan.entry}` — c.id is stable
        // (post-#9, keyed by cisdTime+ifvgKey), but plan.entry (fib.ote705)
        // drifts by small amounts almost every tick as the post-CISD anchor
        // recomputation picks up new extreme candles, so that key was
        // effectively always "new," defeating dedup. Confirmed live: 4+
        // ARMED alerts for the same structure inside 60 seconds. id alone
        // already captures "is this a genuinely new plan" correctly.
        const armedKey = c.id;
        if (!notifiedArmed.has(armedKey)) {
          notifiedArmed.add(armedKey);
          sendArmedAlert(c).catch(() => {});
        }
        if (!registry.has(c.id)) {
          registry.set(c.id, {
            id: c.id, model: c.model, direction: c.direction, grade: c.grade,
            first_armed_at: result.ts, first_armed_at_epoch: nowEpoch,
            plan: c.plan, filled: false, filled_at: null, filled_at_epoch: null,
            outcome: null, outcome_bar_time: null, mfe: 0, mae: 0,
          });
        } else {
          registry.get(c.id).grade = c.grade; // grade (e.g. A+ overlap) can change tick to tick
        }
      }
      for (const record of registry.values()) {
        if (record.filled && !record.filled_at_epoch) record.filled_at_epoch = nowEpoch;
        updateTrackedCandidate(record, result.bars3m);
      }

      // 2026-08-14 fix: a chromeState activePlan is only genuinely eligible
      // to free up for a re-arm once ITS OWN registry record has actually
      // resolved — any outcome (STOP, BREAKEVEN, TP1, TP2, AMBIGUOUS), not
      // just the original stop being touched. This is the single source of
      // truth for "is the trader still in this position," replacing the
      // narrower stop-only check that used to live in tick().
      for (const direction of ['BEAR', 'BULL']) {
        const cs = chromeState[direction];
        if (!cs.activePlan) continue;
        const record = registry.get(cs.activePlan.id);
        if (record && record.outcome) {
          cs.usedIfvgKeys.add(cs.activePlan.ifvgKey);
          cs.activePlan = null;
        }
      }

      // 2026-09-02: default is now OFF (discord-config.json's
      // unfilledCancelledAlerts) — see shouldSendUnfilledCancelledAlert's
      // comment in src/notify/discord.mjs for why. Still tracked in
      // notifiedCancelled and still written to the JSONL log below either
      // way (appendLog's cancelledPlans field, a few lines down) — this only
      // gates the Discord push.
      for (const cancelled of result.cancelledPlans) {
        if (notifiedCancelled.has(cancelled.id)) continue;
        notifiedCancelled.add(cancelled.id);
        if (shouldSendUnfilledCancelledAlert()) sendCancelledAlert(cancelled).catch(() => {});
      }

      appendLog({
        event: 'SCAN', ts: result.ts, etTime: result.etTime, price: result.price,
        candidates: result.tickCandidates.map(({ ...c }) => c),
        rejectedCandidates: result.rejectedCandidates,
        cancelledPlans: result.cancelledPlans,
        smt: result.smt, // PROPOSALS.md #6 — confluence-only, informational, never gates
      });
      fs.writeFileSync(SUMMARY_PATH, JSON.stringify([...registry.values()], null, 2));

      const armedNow = result.tickCandidates.filter(c => c.state === 'ARMED').length;
      const eyesOnNow = result.tickCandidates.filter(c => c.state === 'EYES_ON').length;
      const withheldNow = result.tickCandidates.filter(c => c.planStatus?.startsWith('WITHHELD')).length;
      const rejectedNow = result.rejectedCandidates.length;
      const smtNote = result.smt ? (result.smt.divergence ? ` smt=${result.smt.direction}` : ' smt=none') : ' smt=unavailable';
      console.log(`[${result.etTime} ET] price=${result.price} armed=${armedNow} eyes_on=${eyesOnNow} withheld=${withheldNow} rejected=${rejectedNow} tracked_total=${registry.size}${smtNote}`);
    } catch (err) {
      appendLog({ event: 'ERROR', ts: isoNow(), etTime: nowET_HHMM(), error: err.message });
      console.error(`[${nowET_HHMM()} ET] ERROR: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  await disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('shadow-poller fatal:', err.message);
  appendLog({ event: 'FATAL', ts: isoNow(), etTime: nowET_HHMM(), error: err.message });
  await disconnect();
  process.exit(1);
});
