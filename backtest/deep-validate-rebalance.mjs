#!/usr/bin/env node
// Deepest validation pass available given this project's actual data
// constraints (see report for why: no drag-pan primitive in the current
// tradingview MCP toolset, and scroll/programmatic-range-setting confirmed
// NOT to trigger TradingView's lazy history loading — verified live, not
// assumed from memory). Two things this script adds beyond the first sweep:
//
// 1. TRUE out-of-sample validation: pick the target R-multiple using ONLY
//    the first half of trading days (by date), then apply that fixed choice
//    to the second half and report the second half's performance standalone.
//    This is the direct test of whether 2R generalizes or was curve-fit to
//    the whole 26-day sample.
// 2. Parameter-sensitivity sweep: vary wick ratio, ledge lookback, and ledge
//    tolerance (holding target at 2R) to see whether the result is robust to
//    nearby parameter choices or fragile to the exact defaults chosen.
import { loadBars } from './engine.mjs';
import { runRebalanceBacktest } from './rebalance-engine.mjs';

const bars = loadBars('fixtures/nq_3m_bars_2026-06-14_to_07-20.json');

function stats(scored) {
  const wins = scored.filter(t => t.resultR > 0);
  const losses = scored.filter(t => t.resultR < 0);
  const cumR = +scored.reduce((s, t) => s + t.resultR, 0).toFixed(2);
  const wr = scored.length ? +((wins.length / scored.length) * 100).toFixed(1) : null;
  const grossWin = wins.reduce((s, t) => s + t.resultR, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.resultR, 0));
  const pf = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? Infinity : null);
  return { n: scored.length, wins: wins.length, losses: losses.length, wr, pf, cumR };
}

console.log('=== 1. Out-of-sample train/test split ===\n');
const SPLIT_DATE = '2026-07-01'; // roughly bisects the 12 trigger dates

for (const r of [1, 1.5, 2, 2.5, 3]) {
  const { trades } = runRebalanceBacktest(bars, { targetMode: 'fixedR', fixedRMultiple: r });
  const scored = trades.filter(t => t.resultR != null);
  const train = scored.filter(t => t.dateStr < SPLIT_DATE);
  const test = scored.filter(t => t.dateStr >= SPLIT_DATE);
  const trainS = stats(train), testS = stats(test);
  console.log(
    `R=${r}  TRAIN(<${SPLIT_DATE}): n=${trainS.n} wr=${trainS.wr}% cumR=${trainS.cumR}   ` +
    `TEST(>=${SPLIT_DATE}): n=${testS.n} wr=${testS.wr}% cumR=${testS.cumR}`
  );
}

console.log('\nPicking best R by TRAIN cumR only, then reporting TEST performance standalone:');
let best = null;
for (const r of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]) {
  const { trades } = runRebalanceBacktest(bars, { targetMode: 'fixedR', fixedRMultiple: r });
  const scored = trades.filter(t => t.resultR != null);
  const train = scored.filter(t => t.dateStr < SPLIT_DATE);
  const trainS = stats(train);
  if (!best || trainS.cumR > best.trainS.cumR) best = { r, trainS };
}
{
  const { trades } = runRebalanceBacktest(bars, { targetMode: 'fixedR', fixedRMultiple: best.r });
  const scored = trades.filter(t => t.resultR != null);
  const test = scored.filter(t => t.dateStr >= SPLIT_DATE);
  const testS = stats(test);
  console.log(`Best-on-train R=${best.r} (train cumR=${best.trainS.cumR}) -> held-out TEST: n=${testS.n} wr=${testS.wr}% pf=${testS.pf} cumR=${testS.cumR}`);
}

console.log('\n=== 2. Parameter-sensitivity sweep (target fixed at 2R) ===\n');
console.log('-- Wick ratio --');
for (const wr of [0.3, 0.35, 0.4, 0.45, 0.5, 0.6]) {
  const { trades } = runRebalanceBacktest(bars, { targetMode: 'fixedR', fixedRMultiple: 2, wickRatio: wr });
  const s = stats(trades.filter(t => t.resultR != null));
  console.log(`wickRatio=${wr}  triggers=${trades.length} scored=${s.n} wr=${s.wr}% pf=${s.pf} cumR=${s.cumR}`);
}
console.log('-- Ledge lookback (minutes) --');
for (const lb of [10, 15, 20, 25, 30, 40]) {
  const { trades } = runRebalanceBacktest(bars, { targetMode: 'fixedR', fixedRMultiple: 2, ledgeLookbackMin: lb });
  const s = stats(trades.filter(t => t.resultR != null));
  console.log(`ledgeLookback=${lb}min  triggers=${trades.length} scored=${s.n} wr=${s.wr}% pf=${s.pf} cumR=${s.cumR}`);
}
console.log('-- Ledge touch tolerance (ticks) --');
for (const tol of [10, 15, 20, 25, 30, 40]) {
  const { trades } = runRebalanceBacktest(bars, { targetMode: 'fixedR', fixedRMultiple: 2, ledgeToleranceTicks: tol });
  const s = stats(trades.filter(t => t.resultR != null));
  console.log(`ledgeTolerance=${tol}ticks  triggers=${trades.length} scored=${s.n} wr=${s.wr}% pf=${s.pf} cumR=${s.cumR}`);
}
