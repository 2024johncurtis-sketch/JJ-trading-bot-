#!/usr/bin/env node
// Compares the shipped stop-size gate (hard reject if riskPoints > 20) against
// letting wide-stop setups through and controlling risk via position size
// instead. Same 26-day fixture/window run-extended-backtest.mjs and
// compare-tp1-methods.mjs use, so these numbers are directly comparable to
// the already-cited 82.73R baseline.
//
// Why this exists: JJ asked 2026-09-16 why stops on some setups run
// 20-60pt+ and whether we could just cap the stop distance itself at
// 15-20pt instead of rejecting the trade. Answer given at the time: the
// stop is the IFVG's real invalidation extreme — shrinking it below that
// puts the stop inside still-valid structure (same failure mode already
// found and fixed 2026-07-26 in the opposite direction: PROPOSALS #7's
// tightest-stop hunting produced 1.25-4.25pt noise-level "stops"). The
// alternative worth testing isn't a smaller stop, it's smaller SIZE on a
// wide stop — bound dollar risk instead of point risk. This script is that
// measurement.
//
// engine.mjs's buildPlan() ALREADY supports opts.maxStopPointsOverride
// (added alongside this) — this script doesn't change engine.mjs's
// scoring, it just runs it under a raised/removed ceiling and applies
// position sizing afterward using the real riskPoints on each trade.
//
// Usage: node backtest/compare-stop-sizing.mjs [fixturePath]
import path from 'path';
import { fileURLToPath } from 'url';
import { runSession, loadBars, etParts } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = process.argv[2] || 'fixtures/nq_3m_bars_2026-06-14_to_07-20.json';
const WINDOW_START = '09:30:00', WINDOW_END = '11:30:00';
const POINT_VALUE = 20; // NQ full-size, $/pt/contract
// Matches the shipped system's own worst-case per-trade $ exposure (20pt
// cap x 1 contract x $20/pt) — chosen so the sizing variant is bounded by
// the SAME dollar ceiling the current reject-based gate already implies,
// not a new, bigger risk appetite.
const TARGET_DOLLAR_RISK = 20 * POINT_VALUE;

const bars = loadBars(fixturePath);
const dates = new Set();
for (const b of bars) {
  const { dateStr, timeStr } = etParts(b.time);
  if (timeStr >= WINDOW_START && timeStr <= WINDOW_END) dates.add(dateStr);
}
const sortedDates = [...dates].sort();

const VARIANTS = [
  { label: 'current (20pt reject, shipped)', maxStopPointsOverride: undefined, sizeFn: () => 1 },
  { label: 'no cap, fixed size 1',           maxStopPointsOverride: 500,        sizeFn: () => 1 },
  { label: 'no cap, $-normalized size',      maxStopPointsOverride: 500,        sizeFn: rp => Math.max(1, Math.floor(TARGET_DOLLAR_RISK / (rp * POINT_VALUE))) },
];

function runVariant({ maxStopPointsOverride, sizeFn }) {
  const opts = maxStopPointsOverride != null ? { maxStopPointsOverride } : {};
  let scored = 0, rejectedForStop = 0;
  const outcomeCounts = { TP1: 0, STOP: 0, 'BREAKEVEN (manual 15pt rule, pre-TP1)': 0, AMBIGUOUS: 0, OPEN: 0 };
  const trades = []; // { R, riskPoints, contracts, dollarPnl }
  const stopSizeSeen = [];
  for (const d of sortedDates) {
    const r = runSession(bars, d, d, WINDOW_START, WINDOW_END, opts);
    const armed = r.candidates.filter(c => c.state === 'ARMED');
    for (const c of armed) {
      if (!c.plan.passesStopGate) { if (c.plan.riskPoints > 20) rejectedForStop++; continue; }
      const s = c.score;
      if (!s) continue;
      scored++;
      stopSizeSeen.push(c.plan.riskPoints);
      const key = s.outcome && s.outcome.startsWith('AMBIGUOUS') ? 'AMBIGUOUS'
        : s.outcome && s.outcome.startsWith('OPEN') ? 'OPEN'
        : s.outcome;
      if (outcomeCounts[key] != null) outcomeCounts[key]++;
      if (s.resultR != null) {
        const contracts = sizeFn(c.plan.riskPoints);
        const dollarPnl = s.resultR * c.plan.riskPoints * POINT_VALUE * contracts;
        trades.push({ R: s.resultR, riskPoints: c.plan.riskPoints, contracts, dollarPnl });
      }
    }
  }
  const rDist = trades.map(t => t.R);
  const cumulativeR = +rDist.reduce((a, b) => a + b, 0).toFixed(2);
  const cumulativeDollar = +trades.reduce((a, t) => a + t.dollarPnl, 0).toFixed(2);
  const grossWinR = rDist.filter(r => r > 0).reduce((s, r) => s + r, 0);
  const grossLossR = Math.abs(rDist.filter(r => r < 0).reduce((s, r) => s + r, 0));
  const profitFactor = grossLossR > 0 ? +(grossWinR / grossLossR).toFixed(2) : null;
  const avgContracts = trades.length ? +(trades.reduce((s, t) => s + t.contracts, 0) / trades.length).toFixed(2) : null;
  const maxContracts = trades.length ? Math.max(...trades.map(t => t.contracts)) : null;
  let peakD = 0, runD = 0, maxDDDollar = 0;
  for (const t of trades) { runD += t.dollarPnl; if (runD > peakD) peakD = runD; const dd = peakD - runD; if (dd > maxDDDollar) maxDDDollar = dd; }
  return {
    scored, rejectedForStop, outcomeCounts, cumulativeR, cumulativeDollar, profitFactor,
    avgContracts, maxContracts, maxDDDollar: +maxDDDollar.toFixed(2),
    maxStopSeen: stopSizeSeen.length ? +Math.max(...stopSizeSeen).toFixed(2) : null,
  };
}

console.log(`\n=== Stop-size gate comparison — ${sortedDates.length} days, ${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]} (${WINDOW_START}-${WINDOW_END} ET) ===`);
console.log(`Target $ ceiling for the sizing variant: $${TARGET_DOLLAR_RISK} (= the current gate's own worst case, 20pt x $${POINT_VALUE}/pt x 1 contract).\n`);

const results = VARIANTS.map(v => ({ label: v.label, r: runVariant(v) }));

const colW = 24;
const pad = s => String(s).padEnd(colW);
console.log(pad('variant') + pad('scored') + pad('rejected(>20pt)') + pad('cumR') + pad('cum$') + pad('profitFactor') + pad('avgSize') + pad('maxSize') + pad('maxDD$'));
for (const { label, r } of results) {
  console.log(pad(label) + pad(r.scored) + pad(r.rejectedForStop) + pad(r.cumulativeR) + pad('$' + r.cumulativeDollar) + pad(r.profitFactor) + pad(r.avgContracts ?? 'n/a') + pad(r.maxContracts ?? 'n/a') + pad('$' + r.maxDDDollar));
}

console.log('\nOutcome breakdown per variant:');
for (const { label, r } of results) {
  console.log(`  ${label}: TP1=${r.outcomeCounts.TP1}  STOP=${r.outcomeCounts.STOP}  BE(pre-TP1)=${r.outcomeCounts['BREAKEVEN (manual 15pt rule, pre-TP1)']}  AMBIGUOUS=${r.outcomeCounts.AMBIGUOUS}  OPEN=${r.outcomeCounts.OPEN}  (widest stop taken: ${r.maxStopSeen}pt)`);
}

const baseline = results[0].r;
console.log(`\nBaseline (current, shipped): ${baseline.scored} trades, $${baseline.cumulativeDollar}, ${baseline.rejectedForStop} candidates rejected for stop size.`);
for (const { label, r } of results.slice(1)) {
  console.log(`${label}: $${r.cumulativeDollar} (${r.cumulativeDollar >= baseline.cumulativeDollar ? '+' : ''}${+(r.cumulativeDollar - baseline.cumulativeDollar).toFixed(2)} vs current), took ${r.rejectedForStop === 0 ? 'all' : baseline.rejectedForStop - r.rejectedForStop} of the ${baseline.rejectedForStop} previously-rejected wide-stop candidates.`);
}
