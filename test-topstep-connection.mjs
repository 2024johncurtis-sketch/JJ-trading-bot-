#!/usr/bin/env node
// Read-only connection test for the TopStep/ProjectX integration.
// Places NO orders — just verifies auth, account lookup, and contract
// lookup work end to end, once topstep-config.json has real credentials.
//
// Usage: node test-topstep-connection.mjs
import { searchAccounts, searchContract, hasConfig } from './src/topstep/client.mjs';

if (!hasConfig()) {
  console.log('No topstep-config.json found (or it failed to parse). Copy topstep-config.example.json to topstep-config.json and fill in your username + apiKey first.');
  process.exit(1);
}

console.log('Authenticating and looking up accounts...');
try {
  const accountsResp = await searchAccounts({ onlyActiveAccounts: true });
  console.log(`Found ${accountsResp.accounts.length} active account(s):`);
  for (const a of accountsResp.accounts) {
    console.log(`  id=${a.id}  name=${a.name}  balance=${a.balance}  canTrade=${a.canTrade}`);
  }
  if (accountsResp.accounts.length === 0) {
    console.log('No active accounts found — check that the linked account is active in TopstepX, and that this API key is tied to it.');
  }

  console.log('\nSearching for NQ contract (practice/sim data)...');
  const contractResp = await searchContract('NQ');
  console.log(`Found ${contractResp.contracts.length} matching contract(s):`);
  for (const c of contractResp.contracts.slice(0, 10)) {
    console.log(`  id=${c.id}  name=${c.name}  active=${c.activeContract}  tickSize=${c.tickSize}  tickValue=${c.tickValue}`);
  }

  console.log('\nConnection test passed — auth, account lookup, and contract lookup all work. No orders were placed.');
} catch (err) {
  console.error('\nConnection test FAILED:', err.message);
  process.exit(1);
}
