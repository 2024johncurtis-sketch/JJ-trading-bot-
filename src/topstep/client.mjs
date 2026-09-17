// TopStep / ProjectX Gateway API client (2026-08-25).
//
// Read-only reconnaissance and order-management wrapper for the REST API
// documented at gateway.docs.projectx.com. Credentials live in
// topstep-config.json (gitignored, never committed) — copy
// topstep-config.example.json and fill in username/apiKey, same pattern as
// discord-config.json.
//
// Scope, stated plainly: this module can place, modify, and close real
// orders on whatever account topstep-config.json points at. It does NOT
// decide when to trade — that's still the Chrome/Rebalance detection logic
// in shadow-poller.mjs / rebalance-poller.mjs. Wiring THIS client into that
// decision logic (so a real ARMED signal actually calls placeOrder) is a
// separate, deliberate step, not something that happens by importing this
// file. Per Topstep's own terms: all trading activity must originate from
// this machine, not a VPS/cloud server/remote host — same constraint the
// existing local pollers already satisfy by construction.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', '..', 'topstep-config.json');

let config = null;
let token = null;
let tokenExpiresAt = 0; // epoch ms — refreshed a bit early, real token is valid 24h

function loadConfig() {
  if (config !== null) return config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    config = false; // sentinel: "tried and failed," distinct from "not yet tried" (null)
  }
  return config || null;
}

function baseUrl() {
  return loadConfig()?.baseUrl || 'https://api.topstepx.com';
}

// 2026-08-25: config.practice mirrors the API's own `live` boolean, just
// inverted and named for what it actually means to a human reading the
// config file — practice:true (the default, and the only mode this project
// should ever run in without an explicit, separate decision) maps to
// live:false in every API call that takes it.
//
// 2026-09-06 correction, empirically verified — do NOT flip this to
// practice:false for a TopStep eval/combine account: searchContract('MNQ',
// {live:true}) returned zero contracts against this project's actual
// account (a combine account, `simulated:true` per searchAccounts —
// meaning it trades through TopStep's sim-execution layer regardless of
// funding stage), while {live:false} correctly found the real active MNQ
// contract. The `live` flag apparently gates "does this account have LIVE
// (funded, non-sim) contracts available," not "give me real-time vs.
// delayed data" — practice:true is not just the safe default, it's the
// only setting that actually works for this account category. Was flipped
// to false once (briefly, before this was verified) and reverted the same
// day after the poller failed to resolve a contract.
function isLive() {
  const cfg = loadConfig();
  return cfg ? !(cfg.practice ?? true) : false;
}

async function authenticate() {
  const cfg = loadConfig();
  if (!cfg || !cfg.username || !cfg.apiKey) {
    throw new Error('topstep-config.json missing or incomplete (need username + apiKey) — copy topstep-config.example.json and fill it in.');
  }
  if (token && Date.now() < tokenExpiresAt) return token;
  const res = await fetch(`${baseUrl()}/api/Auth/loginKey`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName: cfg.username, apiKey: cfg.apiKey }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.success) {
    throw new Error(`TopStep auth failed: HTTP ${res.status} ${data?.errorMessage || data?.errorCode || ''}`.trim());
  }
  token = data.token;
  tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000; // refresh 1h before the real 24h expiry
  return token;
}

async function apiCall(pathName, body) {
  const t = await authenticate();
  const res = await fetch(`${baseUrl()}${pathName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${t}` },
    body: JSON.stringify(body),
  });
  if (res.status === 429) {
    throw new Error(`TopStep rate limit hit (429) on ${pathName} — back off and retry, don't hammer it.`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.success) {
    throw new Error(`TopStep API error on ${pathName}: HTTP ${res.status} ${data?.errorMessage || data?.errorCode || ''}`.trim());
  }
  return data;
}

// --- Order type/side enums, per gateway.docs.projectx.com's order-place reference ---
export const ORDER_TYPE = { LIMIT: 1, MARKET: 2, STOP: 4, TRAILING_STOP: 5, JOIN_BID: 6, JOIN_ASK: 7 };
export const ORDER_SIDE = { BUY: 0, SELL: 1 };
// Confirmed 2026-09-08 against gateway.docs.projectx.com's Realtime Updates
// "Enum Definitions" section (public enum OrderStatus / PositionType) — not
// guessed. OrderStatus: None=0, Open=1, Filled=2, Cancelled=3, Expired=4,
// Rejected=5, Pending=6. Matches every real order status seen live so far.
export const ORDER_STATUS = { NONE: 0, OPEN: 1, FILLED: 2, CANCELLED: 3, EXPIRED: 4, REJECTED: 5, PENDING: 6 };
export const POSITION_TYPE = { UNDEFINED: 0, LONG: 1, SHORT: 2 };

export async function searchAccounts({ onlyActiveAccounts = true } = {}) {
  return apiCall('/api/Account/search', { onlyActiveAccounts });
}

export async function searchContract(searchText, opts = {}) {
  const live = opts.live ?? isLive();
  return apiCall('/api/Contract/search', { live, searchText });
}

export async function placeOrder({ accountId, contractId, type, side, size, limitPrice = null, stopPrice = null, trailPrice = null, customTag = null, stopLossBracket = null, takeProfitBracket = null }) {
  return apiCall('/api/Order/place', { accountId, contractId, type, side, size, limitPrice, stopPrice, trailPrice, customTag, stopLossBracket, takeProfitBracket });
}

// 2026-08-31: used by the live poller to detect a bracket entry has filled
// (a position now exists) and, separately, to find the bracket's stop-loss
// CHILD order so its price can be moved for the breakeven rule.
export async function searchOpenPositions({ accountId }) {
  return apiCall('/api/Position/searchOpen', { accountId });
}

// IMPORTANT, stated plainly: gateway.docs.projectx.com does not document any
// field linking a bracket's child orders back to the parent (no
// linkedOrderId/parentId/bracketOrderId in the order-search-open reference).
// Finding "the stop order for this specific trade" is therefore a
// best-effort match on accountId + contractId + type===STOP + a stopPrice
// close to what we expect — NOT a guaranteed-correct lookup by ID. This
// needs to be the first thing actually verified once real credentials
// exist, before trusting it with anything live.
export async function searchOpenOrders({ accountId }) {
  return apiCall('/api/Order/searchOpen', { accountId });
}

// Historical order search — needs a date range, per gateway.docs.projectx.com
// (accountId + startTimestamp required, endTimestamp optional). Distinct from
// searchOpenOrders above (/api/Order/searchOpen, accountId only, live orders
// only) — don't conflate the two, they hit different endpoints.
export async function searchOrders({ accountId, startTimestamp, endTimestamp = null }) {
  return apiCall('/api/Order/search', { accountId, startTimestamp, endTimestamp });
}

// The one this whole integration exists for: moving a stop (breakeven rule,
// TP1-triggered runner stage) without touching the rest of the order.
export async function modifyOrder({ accountId, orderId, size = null, limitPrice = null, stopPrice = null, trailPrice = null }) {
  return apiCall('/api/Order/modify', { accountId, orderId, size, limitPrice, stopPrice, trailPrice });
}

export async function cancelOrder({ accountId, orderId }) {
  return apiCall('/api/Order/cancel', { accountId, orderId });
}

export async function closePosition({ accountId, contractId }) {
  return apiCall('/api/Position/closeContract', { accountId, contractId });
}

// The other one this integration exists for: the TP1 half-exit, since our
// TP1 is a structural price level (fib.ote705-derived swing), not a fixed
// tick offset a bracket order can express on its own.
export async function partialClosePosition({ accountId, contractId, size }) {
  return apiCall('/api/Position/partialCloseContract', { accountId, contractId, size });
}

export function hasConfig() {
  return !!loadConfig();
}
