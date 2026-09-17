#!/usr/bin/env node
// Sweeps target/filter variants of the Rebalance Model against the 26-day
// fixture to find a genuinely better-performing configuration than the
// deployed baseline (ledge target, no distance filter, which nets -1.56R).
// Every run is walk-forward/no-lookahead via rebalance-engine.mjs — this
// script only changes which config each run uses, not how bars are scored.
import { loadBars } from './engine.mjs';
import { runRebalanceBacktest } from './rebalance-engine.mjs';

const bars = loadBars('fixtures/nq_3m_bars_2026-06-14_to_07-20.json');

function summarize(label, opts) {
  const { trades } = runRebalanceBacktest(bars, opts);
  const scored = trades.filter(t => t.resultR != null);
  const wins = scored.filter(t => t.resultR > 0);
  const losses = scored.filter(t => t.resultR < 0);
  const cumulativeR = +scored.reduce((s, t) => s + t.resultR, 0).toFixed(2);
  const winRate = scored.length ? +((wins.length / scored.length) * 100).toFixed(1) : null;
  const grossWin = wins.reduce((s, t) => s + t.resultR, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.resultR, 0));
  const profitFactor = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? Infinity : null);
  const ambiguous = trades.filter(t => t.outcome && t.outcome.startsWith('AMBIGUOUS')).length;
  console.log(
    `${label.padEnd(34)} triggers=${String(trades.length).padStart(2)} scored=${String(scored.length).padStart(2)} amb=${ambiguous} ` +
    `W=${String(wins.length).padStart(2)} L=${String(losses.length).padStart(2)} WR=${String(winRate ?? 'n/a').padStart(5)}% ` +
    `PF=${String(profitFactor ?? 'n/a').padStart(5)} cumR=${String(cumulativeR).padStart(7)}`
  );
  return { label, cumulativeR, winRate, profitFactor, scored: scored.length };
}

console.log('=== Baseline ===');
summarize('ledge target (deployed)', { targetMode: 'ledge' });

console.log('\n=== Fixed-R target sweep (ledge/manip/wick logic unchanged) ===');
for (const r of [1, 1.5, 2, 2.5, 3, 4, 5]) {
  summarize(`fixedR target=${r}R`, { targetMode: 'fixedR', fixedRMultiple: r });
}

console.log('\n=== Ledge target + minimum ledge-distance filter ===');
for (const d of [20, 30, 40, 50, 60, 80]) {
  summarize(`ledge target, minDist=${d}pt`, { targetMode: 'ledge', minLedgeDistance: d });
}

console.log('\n=== Session-extreme target (already tested, worse — included for comparison) ===');
summarize('sessionExtreme target', { targetMode: 'sessionExtreme' });
