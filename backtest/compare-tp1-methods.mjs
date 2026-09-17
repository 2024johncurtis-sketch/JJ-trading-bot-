#!/usr/bin/env node
// Compares the shipped TP1 targeting method (most-extreme swing in a 100-bar
// window) against a fixed-R-multiple target, across the same 26-day fixture
// and window run-extended-backtest.mjs uses — so these numbers are directly
// comparable to the already-cited 65.15R/82.73R figures from the 2026-08-27
// full-exit decision.
//
// Why this exists: 2026-08-24 found the shipped method has a ~10% real TP1
// hit rate (32 filled trades, 1 win, live 2026-08-23 data) because the
// target is routinely 100-200+pt away against 3-10pt stops. The obvious fix
// (nearest untapped swing pivot, findNearestSwingTarget) was tried and made
// things WORSE in backtest (net R 65.15 -> 27-53, TP1 wins 2 -> 0). A fixed-
// R-multiple target was flagged as the untried alternative (same idea the
// Rebalance Model already uses successfully) but never actually built or
// measured here — this script is that measurement, requested by JJ
// 2026-09-11 after a live week where 0/9 trades organically hit TP1.
//
// engine.mjs's computeTargets() ALREADY supports opts.tp1RMultiple (built
// alongside the 8/24 investigation, just never exercised) — this script
// doesn't change engine.mjs, it just runs it under different scoreOpts and
// compares.
//
// Usage: node backtest/compare-tp1-methods.mjs [fixturePath]
import path from 'path';
import { fileURLToPath } from 'url';
import { runSession, loadBars, etParts } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = process.argv[2] || 'fixtures/nq_3m_bars_2026-06-14_to_07-20.json';
const WINDOW_START = '09:30:00', WINDOW_END = '11:30:00';

const bars = loadBars(fixturePath);
const dates = new Set();
for (const b of bars) {
  const { dateStr, timeStr } = etParts(b.time);
  if (timeStr >= WINDOW_START && timeStr <= WINDOW_END) dates.add(dateStr);
}
const sortedDates = [...dates].sort();

const VARIANTS = [
  { label: 'current (most-extreme, shipped)', opts: {} },
  { label: 'fixed 1R',   opts: { tp1RMultiple: 1 } },
  { label: 'fixed 1.5R', opts: { tp1RMultiple: 1.5 } },
  { label: 'fixed 2R',   opts: { tp1RMultiple: 2 } },
  { label: 'fixed 3R',   opts: { tp1RMultiple: 3 } },
  { label: 'fixed 4R',   opts: { tp1RMultiple: 4 } },
];

function runVariant(opts) {
  let scored = 0;
  const outcomeCounts = { TP1: 0, STOP: 0, 'BREAKEVEN (manual 15pt rule, pre-TP1)': 0, AMBIGUOUS: 0, OPEN: 0 };
  const rDist = [];
  for (const d of sortedDates) {
    const r = runSession(bars, d, d, WINDOW_START, WINDOW_END, opts);
    const armed = r.candidates.filter(c => c.state === 'ARMED');
    const gatePass = armed.filter(c => c.plan.passesStopGate);
    for (const c of gatePass) {
      const s = c.score;
      if (!s) continue;
      scored++;
      const key = s.outcome && s.outcome.startsWith('AMBIGUOUS') ? 'AMBIGUOUS'
        : s.outcome && s.outcome.startsWith('OPEN') ? 'OPEN'
        : s.outcome;
      if (outcomeCounts[key] != null) outcomeCounts[key]++;
      if (s.resultR != null) rDist.push(s.resultR);
    }
  }
  const cumulativeR = +rDist.reduce((a, b) => a + b, 0).toFixed(2);
  const grossWin = rDist.filter(r => r > 0).reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(rDist.filter(r => r < 0).reduce((s, r) => s + r, 0));
  const profitFactor = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null;
  const tp1HitRate = scored > 0 ? +((outcomeCounts.TP1 / scored) * 100).toFixed(1) : null;
  const avgTrade = rDist.length > 0 ? +(cumulativeR / rDist.length).toFixed(3) : null;
  let peak = 0, running = 0, maxDD = 0;
  for (const R of rDist) { running += R; if (running > peak) peak = running; const dd = peak - running; if (dd > maxDD) maxDD = dd; }
  return { scored, outcomeCounts, cumulativeR, profitFactor, tp1HitRate, avgTrade, maxDD: +maxDD.toFixed(2) };
}

console.log(`\n=== TP1 targeting method comparison — ${sortedDates.length} days, ${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]} (${WINDOW_START}-${WINDOW_END} ET) ===`);
console.log('Full-exit-at-TP1 (JJ\'s 2026-08-27 standing rule) in effect for every variant — this only changes WHERE TP1 is placed, not the exit style.\n');

const results = VARIANTS.map(v => ({ ...v, r: runVariant(v.opts) }));

const colW = 26;
const pad = s => String(s).padEnd(colW);
console.log(pad('variant') + pad('scored') + pad('TP1 hit%') + pad('cumR') + pad('avgR/trade') + pad('profitFactor') + pad('maxDD(R)'));
for (const { label, r } of results) {
  console.log(pad(label) + pad(r.scored) + pad(r.tp1HitRate + '%') + pad(r.cumulativeR) + pad(r.avgTrade) + pad(r.profitFactor) + pad(r.maxDD));
}

console.log('\nOutcome breakdown per variant:');
for (const { label, r } of results) {
  console.log(`  ${label}:`);
  console.log(`    TP1=${r.outcomeCounts.TP1}  STOP=${r.outcomeCounts.STOP}  BE(pre-TP1)=${r.outcomeCounts['BREAKEVEN (manual 15pt rule, pre-TP1)']}  AMBIGUOUS=${r.outcomeCounts.AMBIGUOUS}  OPEN=${r.outcomeCounts.OPEN}`);
}

const baselineR = results[0].r.cumulativeR;
console.log(`\nBaseline (current, shipped) cumulative R: ${baselineR}`);
const best = results.slice(1).reduce((a, b) => (b.r.cumulativeR > a.r.cumulativeR ? b : a));
console.log(`Best fixed-R variant: ${best.label} at ${best.r.cumulativeR}R (${best.r.cumulativeR > baselineR ? '+' : ''}${+(best.r.cumulativeR - baselineR).toFixed(2)} vs current)`);
