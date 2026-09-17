#!/usr/bin/env node
// Regression guard: re-runs every session in sessions.json through the
// current backtest engine and compares key metrics against baseline.json.
// Any logic change (CISD detection, freshness rules, IFVG matching, gate
// thresholds, etc.) must be run through this before shipping — if a metric
// gets WORSE than baseline, that's a regression, not just a difference.
//
// Usage:
//   node run-regression.mjs            # compare current code against baseline.json
//   node run-regression.mjs --write     # overwrite baseline.json with current results
//                                         (only after a deliberate, approved change —
//                                         see reports/PROPOSALS.md workflow)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runSession, loadBars } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessionsPath = path.join(__dirname, 'sessions.json');
const baselinePath = path.join(__dirname, 'baseline.json');
const { sessions } = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
const writeBaseline = process.argv.includes('--write');

function summarize(result) {
  const armed = result.candidates.filter(c => c.state === 'ARMED');
  const gatePass = armed.filter(c => c.plan.passesStopGate);
  const scored = gatePass.filter(c => c.score);
  const wins = scored.filter(c => c.score.resultR != null && c.score.resultR > 0);
  const losses = scored.filter(c => c.score.resultR === -1);
  const open = scored.filter(c => c.score.resultR == null);
  const cumulativeR = +scored.reduce((s, c) => s + (c.score.resultR || 0), 0).toFixed(2);
  const byPath = {};
  for (const c of armed) {
    byPath[c.path] = byPath[c.path] || { armed: 0, gatePass: 0 };
    byPath[c.path].armed += 1;
    if (c.plan.passesStopGate) byPath[c.path].gatePass += 1;
  }
  return {
    cisdEvents: result.cisdEvents.BEAR.length + result.cisdEvents.BULL.length,
    expiredEvents: (result.expiredEvents?.BEAR.length || 0) + (result.expiredEvents?.BULL.length || 0),
    armedCount: armed.length, gatePassCount: gatePass.length, scoredCount: scored.length,
    wins: wins.length, losses: losses.length, openCount: open.length, cumulativeR, byPath,
  };
}

const current = {};
for (const s of sessions) {
  const bars = loadBars(s.fixture);
  const result = runSession(bars, s.label, s.dateStr, s.startHHMM, s.endHHMM);
  current[s.id] = summarize(result);
}

if (writeBaseline) {
  fs.writeFileSync(baselinePath, JSON.stringify({ writtenAt: new Date().toISOString(), sessions: current }, null, 2));
  console.log(`Wrote baseline.json from current code — ${Object.keys(current).length} session(s).`);
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  console.error('No baseline.json found. Run with --write to seed one (only after a reviewed/approved change).');
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
let anyRegression = false;

for (const s of sessions) {
  const cur = current[s.id];
  const base = baseline.sessions[s.id];
  console.log(`\n=== ${s.label} (${s.id}) ===`);
  if (!base) {
    console.log('  NEW session, no baseline yet — run --write after review to add it.');
    continue;
  }
  const regressed = cur.cumulativeR < base.cumulativeR || cur.losses > base.losses;
  console.log(`  cumulativeR: ${base.cumulativeR} -> ${cur.cumulativeR}${cur.cumulativeR < base.cumulativeR ? '  ** REGRESSION **' : ''}`);
  console.log(`  wins/losses/open: ${base.wins}/${base.losses}/${base.openCount} -> ${cur.wins}/${cur.losses}/${cur.openCount}${cur.losses > base.losses ? '  ** REGRESSION **' : ''}`);
  console.log(`  armed/gatePass/scored: ${base.armedCount}/${base.gatePassCount}/${base.scoredCount} -> ${cur.armedCount}/${cur.gatePassCount}/${cur.scoredCount}`);
  console.log(`  cisdEvents/expired: ${base.cisdEvents}/${base.expiredEvents} -> ${cur.cisdEvents}/${cur.expiredEvents}`);
  console.log(`  by path: ${JSON.stringify(cur.byPath)}`);
  if (regressed) anyRegression = true;
}

console.log(anyRegression ? '\nFAIL: regression detected — do not ship.' : '\nPASS: no regression vs baseline.');
process.exit(anyRegression ? 1 : 0);
