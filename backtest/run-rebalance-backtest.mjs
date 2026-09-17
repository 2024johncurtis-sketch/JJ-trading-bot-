#!/usr/bin/env node
// Extended backtest runner for the Rebalance Model. See rebalance-engine.mjs
// header for the exact logic being replayed and the documented deviations
// from the live 1-minute chart version.
//
// Usage: node backtest/run-rebalance-backtest.mjs [fixturePath]
import { loadBars } from './engine.mjs';
import { runRebalanceBacktest } from './rebalance-engine.mjs';

const fixturePath = process.argv[2] || 'fixtures/nq_3m_bars_2026-06-14_to_07-20.json';
const targetMode = process.argv[3] || 'ledge'; // 'ledge' | 'sessionExtreme'
const bars = loadBars(fixturePath);

const { trades, dailyLog } = runRebalanceBacktest(bars, { targetMode });
console.log(`Target mode: ${targetMode}`);

const scored = trades.filter(t => t.resultR != null);
const wins = scored.filter(t => t.resultR > 0);
const losses = scored.filter(t => t.resultR < 0);
const ambiguous = trades.filter(t => t.outcome && t.outcome.startsWith('AMBIGUOUS'));
const open = trades.filter(t => t.outcome && t.outcome.startsWith('OPEN'));
const invalid = trades.filter(t => t.outcome && t.outcome.startsWith('INVALID'));

const cumulativeR = +scored.reduce((s, t) => s + t.resultR, 0).toFixed(2);
const winRate = scored.length ? +((wins.length / scored.length) * 100).toFixed(1) : null;
const grossWin = wins.reduce((s, t) => s + t.resultR, 0);
const grossLoss = Math.abs(losses.reduce((s, t) => s + t.resultR, 0));
const profitFactor = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null;
const avgTrade = scored.length ? +(cumulativeR / scored.length).toFixed(2) : null;

let peak = 0, running = 0, maxDD = 0;
for (const t of scored) {
  running += t.resultR;
  if (running > peak) peak = running;
  const dd = peak - running;
  if (dd > maxDD) maxDD = dd;
}

const daysWithBias = dailyLog.filter(d => d.bias).length;
const daysWithManip = dailyLog.filter(d => d.manipUp || d.manipDn).length;
const daysWithTrigger = dailyLog.filter(d => d.longTrigger || d.shortTrigger).length;
const biasBull = dailyLog.filter(d => d.bias === 'BULLISH').length;
const biasBear = dailyLog.filter(d => d.bias === 'BEARISH').length;

console.log(`\n=== Rebalance Model backtest: ${dailyLog.length} trading days, ${dailyLog[0]?.date} to ${dailyLog[dailyLog.length - 1]?.date} ===\n`);
console.log(`Days with a resolved pre-market bias: ${daysWithBias} (${biasBull} bullish / ${biasBear} bearish)`);
console.log(`Days with a confirmed manipulation leg: ${daysWithManip}`);
console.log(`Days with at least one entry trigger: ${daysWithTrigger}`);
console.log(`Total triggers (long+short): ${trades.length}`);
console.log(`  Scored (stop or target hit): ${scored.length}`);
console.log(`  Ambiguous (stop+target same 3m bar): ${ambiguous.length}`);
console.log(`  Open/unresolved at end of data: ${open.length}`);
console.log(`  Invalid (non-positive risk): ${invalid.length}`);
console.log(`\nWins: ${wins.length} | Losses: ${losses.length}`);
console.log(`Win rate: ${winRate}%`);
console.log(`Profit factor: ${profitFactor}`);
console.log(`Cumulative R: ${cumulativeR}`);
console.log(`Avg trade: ${avgTrade}R`);
console.log(`Max drawdown: ${+maxDD.toFixed(2)}R`);
console.log(`Largest winner: ${scored.length ? +Math.max(...scored.map(t => t.resultR)).toFixed(2) : 'n/a'}R`);
console.log(`Largest loser: ${scored.length ? +Math.min(...scored.map(t => t.resultR)).toFixed(2) : 'n/a'}R`);

console.log(`\nAll triggers, chronological:`);
for (const t of trades) {
  console.log(`  ${t.dateStr} ${t.direction.padEnd(5)} entry=${t.entry} stop=${t.stop} target=${t.target} risk=${t.risk} rewardR=${t.rewardR ?? 'n/a'} -> ${t.outcome} (R=${t.resultR ?? 'n/a'})`);
}
