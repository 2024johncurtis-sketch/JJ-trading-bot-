// Rebalance Model backtest engine. Mirrors the deployed Pine script
// (Rebalance Model [Chrome], pushed to the live NQ1! chart 2026-08-08)
// bar-for-bar: pre-market TPO bias (POC vs range-midpoint, 09:00-09:30 ET),
// structural ledges (rolling lookback high/low), manipulation-leg detection
// (fake breakout/breakdown at the bias-opposing ledge), and the rejection-
// wick + directional-close entry trigger, one signal per session.
//
// Walk-forward, no lookahead: at simulated bar i, only bars[0..i] are used
// for detection. Bars after i are only used afterward, to score what a
// fired signal would have done.
//
// Known deviations from the live 1-minute chart, documented here rather
// than glossed over:
//   1. This runs on 3-minute bars (the only extended historical fixture in
//      this project — fixtures/nq_3m_bars_2026-06-14_to_07-20.json, 26
//      trading days). The live indicator runs on the chart's 1-minute
//      resolution. Wick shapes, TPO binning, and exact trigger timing will
//      not match 1:1 — this tests the MODEL'S LOGIC, not a tick-exact replay.
//   2. Ledge lookback is expressed as a 20-MINUTE trailing window (time-
//      equivalent of the live default: 20 bars on a 1-min chart), not a
//      literal 20-bar count, since bar count is resolution-dependent and a
//      time window is the more honest equivalent at 3-min resolution.
//   3. ES1! cross-market alignment check is DISABLED — no historical ES
//      fixture exists in this project (same gap the Chrome-model backtest
//      already documents for its own live-only SMT check). Every trigger
//      here would additionally need `esAlignedLong`/`esAlignedShort` live;
//      this backtest cannot verify that half of the live model's gate.
//   4. Entry/stop/wick-rejection are evaluated on ONE candle (matches what's
//      actually deployed), not the two-candle "wick candle, then a separate
//      confirming bullish/bearish candle" sequence the source video
//      describes literally. Flagged as a fidelity gap in the report, not
//      silently resolved either way.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadBars, etParts } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));
// 2026-08-12: JJ's own manual breakeven practice (moves his stop to
// breakeven once price has moved this many points in his favor) — same
// constant/source as backtest/engine.mjs and shadow-poller.mjs, see
// rules.json hard_constraints.manual_breakeven_enforcement for the full
// rationale. Unlike the Chrome model, Rebalance has no TP1/TP2 split — this
// is the only breakeven trigger here, not an earlier-arriving addition to
// an existing one.
const MANUAL_BREAKEVEN_POINTS = rules.hard_constraints?.manual_breakeven_points ?? 15;

const TICK = 0.25; // NQ mintick
const ROW_TICKS = 4;
const ROW_SIZE = TICK * ROW_TICKS;

function inBiasWindow(timeStr) {
  return timeStr >= '09:00:00' && timeStr < '09:30:00';
}

function runRebalanceBacktest(bars, opts = {}) {
  const targetMode = opts.targetMode || 'ledge'; // 'ledge' | 'sessionExtreme' | 'fixedR'
  const fixedRMultiple = opts.fixedRMultiple || 2;
  const minLedgeDistance = opts.minLedgeDistance || 0; // points; skip trigger if ledge-to-ledge gap is below this
  const LEDGE_LOOKBACK_MIN = opts.ledgeLookbackMin || 20;
  const WICK_RATIO = opts.wickRatio || 0.4;
  const LEDGE_TOLERANCE = TICK * (opts.ledgeToleranceTicks || 20);
  const tagged = bars.map(b => ({ ...b, et: etParts(b.time) }));

  let curDate = null;
  let upperLedge = null, lowerLedge = null;
  let sessionHigh = null, sessionLow = null;
  let dailyBias = 'PENDING';
  let manipUpConfirmed = false, manipDnConfirmed = false;
  let longFiredToday = false, shortFiredToday = false;
  let tpoMap = new Map();
  let wasInWindow = false;

  const trades = [];
  const dailyLog = [];

  for (let i = 0; i < tagged.length; i++) {
    const b = tagged[i];
    const { dateStr, timeStr } = b.et;

    // --- new session bookkeeping ---
    if (dateStr !== curDate) {
      curDate = dateStr;
      const dayStart = b.time;
      const lookbackStart = dayStart - LEDGE_LOOKBACK_MIN * 60;
      const lookbackBars = tagged.filter(x => x.time >= lookbackStart && x.time < dayStart);
      upperLedge = lookbackBars.length ? Math.max(...lookbackBars.map(x => x.high)) : null;
      lowerLedge = lookbackBars.length ? Math.min(...lookbackBars.map(x => x.low)) : null;
      sessionHigh = null;
      sessionLow = null;
      manipUpConfirmed = false;
      manipDnConfirmed = false;
      longFiredToday = false;
      shortFiredToday = false;
      dailyBias = 'PENDING';
      tpoMap = new Map();
      wasInWindow = false;
      dailyLog.push({ date: dateStr, upperLedge, lowerLedge, bias: null, manipUp: false, manipDn: false, longTrigger: false, shortTrigger: false });
    }
    const today = dailyLog[dailyLog.length - 1];

    // running session extreme-so-far, updated every bar before any trigger check
    sessionHigh = sessionHigh == null ? b.high : Math.max(sessionHigh, b.high);
    sessionLow = sessionLow == null ? b.low : Math.min(sessionLow, b.low);

    // --- TPO bias accumulation / resolution ---
    const nowInWindow = inBiasWindow(timeStr);
    if (nowInWindow) {
      const lo = Math.round(b.low / ROW_SIZE);
      const hi = Math.round(b.high / ROW_SIZE);
      for (let idx = lo; idx <= hi; idx++) tpoMap.set(idx, (tpoMap.get(idx) || 0) + 1);
    }
    if (wasInWindow && !nowInWindow && tpoMap.size > 0) {
      let maxHits = 0, pocIdx = null;
      const keys = [...tpoMap.keys()];
      for (const k of keys) { const h = tpoMap.get(k); if (h > maxHits) { maxHits = h; pocIdx = k; } }
      const pocPrice = pocIdx * ROW_SIZE;
      const rangeHigh = Math.max(...keys) * ROW_SIZE + ROW_SIZE;
      const rangeLow = Math.min(...keys) * ROW_SIZE;
      const rangeMid = (rangeHigh + rangeLow) / 2;
      dailyBias = pocPrice > rangeMid ? 'BULLISH' : 'BEARISH';
      today.bias = dailyBias;
    }
    wasInWindow = nowInWindow;

    if (upperLedge == null || lowerLedge == null) continue; // no lookback data yet (start of fixture)

    // --- manipulation leg ---
    const wickAboveUpper = b.high > upperLedge && b.close <= upperLedge;
    const wickBelowLower = b.low < lowerLedge && b.close >= lowerLedge;
    if (dailyBias === 'BULLISH' && wickAboveUpper && !manipUpConfirmed) { manipUpConfirmed = true; today.manipUp = true; }
    if (dailyBias === 'BEARISH' && wickBelowLower && !manipDnConfirmed) { manipDnConfirmed = true; today.manipDn = true; }

    // --- rejection wick + trigger ---
    const range = b.high - b.low;
    if (range <= 0) continue;
    const lowerWick = Math.min(b.open, b.close) - b.low;
    const upperWick = b.high - Math.max(b.open, b.close);
    const lowerWickRejection = (lowerWick / range) >= WICK_RATIO;
    const upperWickRejection = (upperWick / range) >= WICK_RATIO;
    const touchesLower = b.low <= lowerLedge + LEDGE_TOLERANCE;
    const touchesUpper = b.high >= upperLedge - LEDGE_TOLERANCE;
    const bullishClose = b.close > b.open;
    const bearishClose = b.close < b.open;

    const ledgeDistance = upperLedge - lowerLedge;
    const wideEnough = ledgeDistance >= minLedgeDistance;

    const triggerLong = dailyBias === 'BULLISH' && manipUpConfirmed && touchesLower && lowerWickRejection && bullishClose && !longFiredToday && wideEnough;
    const triggerShort = dailyBias === 'BEARISH' && manipDnConfirmed && touchesUpper && upperWickRejection && bearishClose && !shortFiredToday && wideEnough;

    if (triggerLong) {
      longFiredToday = true;
      today.longTrigger = true;
      const risk = b.close - b.low;
      const target = targetMode === 'sessionExtreme' ? sessionHigh
        : targetMode === 'fixedR' ? b.close + fixedRMultiple * risk
        : upperLedge;
      trades.push(scoreTrade(tagged, i, 'LONG', b.close, b.low, target, dateStr));
    }
    if (triggerShort) {
      shortFiredToday = true;
      today.shortTrigger = true;
      const risk = b.high - b.close;
      const target = targetMode === 'sessionExtreme' ? sessionLow
        : targetMode === 'fixedR' ? b.close - fixedRMultiple * risk
        : lowerLedge;
      trades.push(scoreTrade(tagged, i, 'SHORT', b.close, b.high, target, dateStr));
    }
  }

  return { trades, dailyLog };
}

function scoreTrade(bars, armIndex, direction, entry, stop, target, dateStr) {
  const isLong = direction === 'LONG';
  const risk = isLong ? entry - stop : stop - entry;
  if (risk <= 0) return { dateStr, direction, entry, stop, target, risk, outcome: 'INVALID (non-positive risk)', resultR: null };
  const rewardR = Math.abs(target - entry) / risk;

  let outcome = null, resultR = null, outcomeAt = null;
  let favExtreme = entry, advExtreme = entry;
  // 2026-08-12: JJ's manual breakeven rule — once price has moved
  // MANUAL_BREAKEVEN_POINTS in favor, his real stop becomes entry, not the
  // original structural stop. No TP1/TP2 split here (single fixed target),
  // so this is the only breakeven trigger: hitting it before target means a
  // scratch (0R), not the full -1R a naive stop-only replay would log.
  let effectiveStop = stop;
  let breakevenArmed = false;
  for (let j = armIndex + 1; j < bars.length; j++) {
    const b = bars[j];
    favExtreme = isLong ? Math.max(favExtreme, b.high) : Math.min(favExtreme, b.low);
    advExtreme = isLong ? Math.min(advExtreme, b.low) : Math.max(advExtreme, b.high);

    if (!breakevenArmed) {
      const favMove = isLong ? b.high - entry : entry - b.low;
      if (favMove >= MANUAL_BREAKEVEN_POINTS) { breakevenArmed = true; effectiveStop = entry; }
    }

    const hitStop = isLong ? b.low <= effectiveStop : b.high >= effectiveStop;
    const hitTarget = isLong ? b.high >= target : b.low <= target;
    if (hitStop && hitTarget) { outcome = 'AMBIGUOUS (same 3m bar)'; outcomeAt = b.time; break; }
    if (hitStop) { outcome = breakevenArmed ? 'BREAKEVEN (manual 15pt rule)' : 'STOP'; outcomeAt = b.time; break; }
    if (hitTarget) { outcome = 'TARGET'; outcomeAt = b.time; break; }
  }
  if (outcome === 'STOP') resultR = -1;
  else if (outcome === 'BREAKEVEN (manual 15pt rule)') resultR = 0;
  else if (outcome === 'TARGET') resultR = +rewardR.toFixed(2);
  const mfe = +Math.abs(isLong ? favExtreme - entry : entry - favExtreme).toFixed(2);
  const mae = +Math.abs(isLong ? entry - advExtreme : advExtreme - entry).toFixed(2);

  return {
    dateStr, direction, entry, stop, target,
    risk: +risk.toFixed(2), rewardR: +rewardR.toFixed(2),
    outcome: outcome || 'OPEN (unresolved in available data)', outcomeAt,
    resultR, mfeR: risk > 0 ? +(mfe / risk).toFixed(2) : null, maeR: risk > 0 ? +(mae / risk).toFixed(2) : null,
  };
}

export { runRebalanceBacktest, scoreTrade, MANUAL_BREAKEVEN_POINTS };
