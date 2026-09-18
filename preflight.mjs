#!/usr/bin/env node
// Morning pre-flight for the live session. READ-ONLY — places/modifies
// nothing, just checks that everything topstep-live-poller.mjs needs is up
// before JJ launches it. Run it ~10 min before the 07:00 ET start.
//
//   node preflight.mjs
//
// Exit 0 = all green, safe to launch. Exit 1 = something's not ready; the
// failing line says what.
import fs from 'fs';
import { execSync } from 'child_process';
import { runningScriptLines } from './proc-list.mjs';
import { getState } from './src/core/chart.js';
import { disconnect } from './src/connection.js';
import { searchAccounts, searchContract } from './src/topstep/client.mjs';

// 2026-09-16 fix, found live: this used to hardcode 27357686, which went
// stale the moment JJ switched accounts (to 27636567) — preflight kept
// checking the OLD account's balance/canTrade while the poller itself
// (which reads topstep-config.json directly) had already moved on. Read
// from the same config file so the two can never drift apart again.
const ACCOUNT_ID = JSON.parse(fs.readFileSync('./topstep-config.json', 'utf8')).accountId;
const EXPECT_SYMBOL = 'NQ';
const BALANCE_FLOOR = 45000;   // sanity bounds only — not a trading rule
const BALANCE_CEIL = 60000;

let failed = 0;
const ok = m => console.log(`  \x1b[32mOK\x1b[0m   ${m}`);
const bad = m => { console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); failed++; };
const warn = m => console.log(`  \x1b[33mWARN\x1b[0m ${m}`);

console.log(`\nPre-flight — ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET\n`);

// 1. No poller already running
// 2026-09-16 fix, found live: the old grep matched ANY command line
// containing the string "topstep-live-poller.mjs" — including preflight's
// own invocation (e.g. `node --check topstep-live-poller.mjs && ... node
// preflight.mjs`), producing a false-positive FAIL against itself. Now
// matches only the actual `node topstep-live-poller.mjs` process pattern.
{
  const procs = runningScriptLines('topstep-live-poller.mjs');
  if (procs.length) bad(`a topstep-live-poller is ALREADY running — don't start a second one:\n       ${procs.join('\n       ')}`);
  else ok('no topstep-live-poller already running');
}

// 2. TradingView chart reachable over CDP + on the right instrument
try {
  const st = await getState();
  if (!st?.symbol) bad('CDP connected but chart.symbol() came back empty — is a chart tab actually open?');
  else if (!st.symbol.toUpperCase().includes(EXPECT_SYMBOL)) bad(`chart is on "${st.symbol}", expected an ${EXPECT_SYMBOL} chart (e.g. CME_MINI:NQ1!) — the poller reads bars from whatever's shown`);
  else ok(`TradingView chart up on ${st.symbol} (${st.resolution})`);
} catch (e) {
  bad(`can't reach TradingView over CDP on :9222 — open TradingView Desktop with remote debugging, chart on CME_MINI:NQ1! (${e.message})`);
}

// 3. TopstepX auth + the exact account
try {
  const accts = (await searchAccounts({ onlyActiveAccounts: true })).accounts || [];
  const a = accts.find(x => x.id === ACCOUNT_ID);
  if (!a) bad(`account ${ACCOUNT_ID} not in the active list — check it's still the live Combine account and the API key is tied to it`);
  else {
    a.canTrade ? ok(`account ${ACCOUNT_ID} (${a.name}) active, canTrade=true`) : bad(`account ${ACCOUNT_ID} has canTrade=false — can't place orders`);
    if (a.balance < BALANCE_FLOOR || a.balance > BALANCE_CEIL) warn(`balance $${a.balance} is outside the expected $${BALANCE_FLOOR}-$${BALANCE_CEIL} band — sanity-check it's the right account`);
    else ok(`balance $${a.balance}`);
  }
} catch (e) {
  bad(`TopstepX auth/account lookup failed — check topstep-config.json credentials (${e.message})`);
}

// 4. Tradable NQ contract resolves
try {
  const c = (await searchContract('NQ')).contracts || [];
  const active = c.find(x => x.activeContract && x.name?.startsWith('NQ'));
  active ? ok(`NQ contract resolves: ${active.id} (${active.name}), tickValue=${active.tickValue}`)
         : bad('no active NQ contract from Contract/search — front-month may have rolled; check the id in RUNBOOK');
} catch (e) {
  bad(`contract lookup failed (${e.message})`);
}

await disconnect().catch(() => {});

console.log('');
if (failed === 0) {
  // next upcoming 07:00 ET as an explicit date, so the launch command is unambiguous
  const nowHHMM = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false }).slice(0, 5);
  const base = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  let sd = base;
  if (nowHHMM >= '07:00') { const d = new Date(base + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); sd = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
  console.log('\x1b[32mALL GREEN\x1b[0m — safe to launch. When you\'re ready:\n');
  console.log(`  node topstep-live-poller.mjs "${sd} 07:00" "${sd} 10:00"`);
  console.log('  (or double-click  Tomorrow 7-10.command )\n');
  console.log('Manual checks preflight can\'t see: TopstepX logged in, Auto-OCO Brackets ON (Settings -> Risk -> Brackets).\n');
  // Windows/Node 24: exiting immediately while HTTP/CDP handles are still
  // closing trips a libuv assertion and turns exit 0 into a crash code, which
  // "Tomorrow 7-10.bat" would read as a failed pre-flight. Let handles settle.
  setTimeout(() => process.exit(0), 250);
} else {
  console.log(`\x1b[31m${failed} check(s) failed\x1b[0m — fix the FAIL line(s) above before launching.\n`);
  setTimeout(() => process.exit(1), 250);
}
