#!/usr/bin/env node
// Extended backtest: runs every trading day in a fixture through the CURRENT
// engine (whatever's shipped in engine.mjs/scan-chart.mjs right now) over
// the 09:30-11:30 ET window, and reports aggregate stats. Used to measure
// whether a shipped change (PROPOSALS.md #7, #8, #4, etc.) actually moved
// the needle relative to the last time this was run — see reports/ for the
// dated writeups this produces.
//
// Usage: node backtest/run-extended-backtest.mjs [fixturePath]
import path from 'path';
import { fileURLToPath } from 'url';
import { runSession, loadBars, etParts } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = process.argv[2] || 'fixtures/nq_3m_bars_2026-06-14_to_07-20.json';

const bars = loadBars(fixturePath);
const dates = new Set();
for (const b of bars) {
  const { dateStr, timeStr } = etParts(b.time);
  if (timeStr >= '09:30:00' && timeStr <= '11:30:00') dates.add(dateStr);
}
const sortedDates = [...dates].sort();

let totalArmed = 0, totalGatePass = 0, totalScored = 0, totalCisdEvents = 0, totalExpired = 0;
let wins = 0, losses = 0, rearmWins = 0, rearmLosses = 0;
let cumulativeR = 0;
const rDistribution = [];
const perDay = [];

for (const d of sortedDates) {
  const r = runSession(bars, d, d, '09:30:00', '11:30:00');
  const armed = r.candidates.filter(c => c.state === 'ARMED');
  const gatePass = armed.filter(c => c.plan.passesStopGate);
  const scored = gatePass.filter(c => c.score && c.score.resultR != null);

  totalArmed += armed.length;
  totalGatePass += gatePass.length;
  totalScored += scored.length;
  totalCisdEvents += r.cisdEvents.BEAR.length + r.cisdEvents.BULL.length;
  totalExpired += (r.expiredEvents?.BEAR.length || 0) + (r.expiredEvents?.BULL.length || 0);

  let dayR = 0;
  for (const c of scored) {
    const R = c.score.resultR;
    cumulativeR += R;
    dayR += R;
    rDistribution.push(R);
    if (R > 0) { wins++; if (c.rearm) rearmWins++; }
    else { losses++; if (c.rearm) rearmLosses++; }
  }
  if (armed.length > 0 || gatePass.length > 0) {
    perDay.push({ date: d, armed: armed.length, gatePass: gatePass.length, scored: scored.length, dayR: +dayR.toFixed(2) });
  }
}

const grossWin = rDistribution.filter(r => r > 0).reduce((s, r) => s + r, 0);
const grossLoss = Math.abs(rDistribution.filter(r => r < 0).reduce((s, r) => s + r, 0));
const profitFactor = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null;
const winRate = totalScored > 0 ? +((wins / totalScored) * 100).toFixed(1) : null;
const avgTrade = totalScored > 0 ? +(cumulativeR / totalScored).toFixed(2) : null;

// Max drawdown: running peak-to-trough on cumulative R, in chronological
// scored-trade order (not calendar-day order — matches the earlier report's
// methodology of tracking the R curve trade-by-trade).
let peak = 0, running = 0, maxDD = 0;
for (const R of rDistribution) {
  running += R;
  if (running > peak) peak = running;
  const dd = peak - running;
  if (dd > maxDD) maxDD = dd;
}

console.log(`\n=== Extended backtest: ${sortedDates.length} trading days, ${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]} ===\n`);
console.log(`Total ARMED (incl. gate-rejected): ${totalArmed}`);
console.log(`Gate-passing (distinct plans, post-#4 dedup): ${totalGatePass}`);
console.log(`Scored trades: ${totalScored}`);
console.log(`Total CISD events (both paths): ${totalCisdEvents}`);
console.log(`Expired-anchor events: ${totalExpired}`);
console.log(`Wins: ${wins} (${rearmWins} from re-arms) | Losses: ${losses} (${rearmLosses} from re-arms)`);
console.log(`Win rate: ${winRate}%`);
console.log(`Profit factor: ${profitFactor}`);
console.log(`Cumulative R: ${+cumulativeR.toFixed(2)}`);
console.log(`Avg trade: ${avgTrade}R`);
console.log(`Max drawdown: ${+maxDD.toFixed(2)}R`);
console.log(`Largest winner: ${rDistribution.length ? +Math.max(...rDistribution).toFixed(2) : 'n/a'}R`);
console.log(`\nPer-day detail (days with any ARMED activity):`);
for (const d of perDay) console.log(`  ${d.date}  armed=${d.armed} gatePass=${d.gatePass} scored=${d.scored} dayR=${d.dayR}`);
