#!/usr/bin/env node
/**
 * topstep-live-poller.mjs
 *
 * REAL ORDER EXECUTION. This places, modifies, and relies on TopStep/
 * ProjectX Gateway to fill actual orders on whatever account
 * topstep-config.json points at (practice/sim by default — see
 * topstep-config.example.json's `practice: true`). This is NOT another
 * paper-trading shadow poller like shadow-poller.mjs/rebalance-poller.mjs.
 *
 * SCOPE (2026-08-31, v1): Chrome model only. Brian's and Rebalance are not
 * wired to real orders yet — this starts with the most mature, most-tested
 * detection path before expanding. Chrome's own TP2/runner concept isn't
 * relevant here either: full-exit-at-TP1 is the standing rule (see
 * rules.json), so every trade only ever needs ONE target, which a bracket
 * order expresses natively.
 *
 * DESIGN — "Option A" (JJ's call, 2026-08-31): place the entry as a LIMIT
 * order with stopLossBracket + takeProfitBracket attached at placement time.
 * The exchange enforces the stop and target instantly and exactly — no lag,
 * no slippage from a 30-second poll loop reacting after the fact. This
 * poller's own job, once a position is confirmed filled, is ONLY the 15pt
 * manual breakeven rule (rules.json hard_constraints.manual_breakeven_points)
 * — moving the stop-loss order's price to breakeven once price has moved
 * that far in favor, which no bracket order can express on its own.
 *
 * REAL GAP, STATED PLAINLY: gateway.docs.projectx.com's Order/search
 * reference does not document any field linking a bracket's stop-loss
 * CHILD order back to its parent (no linkedOrderId/parentId/bracketOrderId).
 * findStopOrderFor() below identifies "the stop order for this trade" by
 * matching accountId + contractId + type===STOP + a stopPrice close to what
 * we expect — a best-effort heuristic, not a guaranteed-correct lookup by
 * ID. This is the first thing to actually verify once real credentials
 * exist and a real bracket order has been placed — don't trust it blindly.
 *
 * WHO RUNS THIS, AND HOW ORDERS ACTUALLY FIRE (revised 2026-09-04): this
 * script detects a genuine ARMED signal, Discord-alerts the full plan, and
 * places the bracket order immediately — no per-trade confirm prompt (that
 * existed 2026-08-31 through 2026-09-04; removed at JJ's request once he
 * confirmed this only ever runs locally, at his own desk).
 *
 * The line that hasn't moved, restated for whoever reads this next: I
 * (Claude) do not launch this process. Not in the background, not via a
 * webhook, not via any remote trigger (Discord button, phone approval, SMS —
 * the transport doesn't matter). JJ explicitly asked for phone/remote
 * approval on 2026-09-04 and it was declined for the same reason the
 * Discord-button version was declined earlier: a real order firing with
 * nobody physically at this machine removes the one safeguard that actually
 * matters — a human able to catch a bad print, stale data, or a detection
 * bug before it becomes a real fill. This script fires with NO confirm step
 * specifically BECAUSE it's understood to only ever run while JJ is
 * physically at the keyboard that starts it
 * (`node topstep-live-poller.mjs "HH:MM"`, foreground, his terminal, his
 * topstep-config.json credentials) — remove that precondition and the
 * removed confirm step becomes exactly the unattended-remote-execution risk
 * this whole design has been threading around.
 *
 * DAILY CAPS (added 2026-08-31, JJ's numbers, matching TopstepX's own
 * displayed PDPT/PDLL for the 50K Trading Combine): session P&L is checked
 * against live account balance each tick. At +$1,550 (consistency-rule
 * profit target) or -$1,800 (max daily loss), the script stops considering
 * NEW entries for the rest of the session — see rules.json hard_constraints
 * for the exact numbers/rationale. This is a redundant safety net on top of
 * whatever TopstepX enforces platform-side, not a replacement for it.
 * Already-open positions/orders are NOT auto-closed on a cap hit, same
 * convention as the existing cutoff-time behavior below.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getState, setTimeframe } from './src/core/chart.js';
import { getOhlcv, getQuote } from './src/core/data.js';
import { disconnect } from './src/connection.js';
import { computeChromeFib, nearestValidIfvg, roundToTick, TICK } from './scan-chart.mjs';
import {
  searchAccounts, searchContract, placeOrder, modifyOrder,
  searchOpenPositions, searchOpenOrders, searchOrders, ORDER_TYPE, ORDER_SIDE, ORDER_STATUS, POSITION_TYPE, hasConfig,
} from './src/topstep/client.mjs';
import { sendArmedAlert, sendCancelledAlert } from './src/notify/discord.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'rules.json'), 'utf8'));
const MAX_STOP_POINTS = rules.hard_constraints?.max_stop_points ?? 20;
const MIN_STOP_POINTS = 2; // matches shadow-poller.mjs / scan-chart.mjs's own floor, see their comments for the 2026-07-26 rationale
const MANUAL_BREAKEVEN_POINTS = rules.hard_constraints?.manual_breakeven_points ?? 15;
const MAX_DAILY_PROFIT = rules.hard_constraints?.max_daily_profit_consistency ?? 1550;
const MAX_DAILY_LOSS = rules.hard_constraints?.max_daily_loss ?? 1800;
// 2026-09-16: JJ asked to disable this internal halt ("don't worry about
// daily loss limit or personal daily profit target, I set those parameters
// myself within TopStep"). That's accurate and this is safe to turn off —
// this check was always documented as "a redundant safety net on top of
// whatever TopstepX enforces platform-side, not a replacement for it"
// (rules.json), and TopStep's own PDPT/PDLL enforcement is real, separate,
// and independent of this code: confirmed live 2026-09-08, TopStep force-
// liquidated a session at exactly +$1,550 gross via its own "Liquidate &
// Block" behavior with zero involvement from this poller. Turning this off
// removes the local early-warning/halt only — the actual account-level
// protection stays fully intact regardless. Flip back to true to restore
// the local halt (still checked every tick below either way, just doesn't
// block entries when false).
const DAILY_CAPS_ENFORCED = false;
const CHROME_FIB_LOOKBACK_BARS = 300;
const POLL_INTERVAL_MS = 30_000;
// 2026-09-17: replaced the fixed ORDER_SIZE=3 (2026-09-16) with dollar-risk-
// normalized sizing, per JJ's request to live-test the "size up on tight
// stops" half of the 09-16 stop-sizing backtest (backtest/compare-stop-
// sizing.mjs). Deliberately NOT the other half of that backtest (removing
// the 20pt stop cap) — that half backtested as a clear net loss (-$17,271
// across 81 trades on the 26-day fixture) and MAX_STOP_POINTS is untouched.
// This only changes how many contracts a plan that ALREADY passes the
// existing gate gets: entry.stop = 20pt -> 1 contract (matches this week's
// live floor), tighter stops -> proportionally more, up to MAX_CONTRACTS.
// TARGET_DOLLAR_RISK=1200 is chosen to match this week's live 3-contract
// sizing AT the 20pt ceiling (3 x 20 x $20), not a new risk appetite.
// MAX_CONTRACTS is a hard tail-risk ceiling the backtest itself didn't need
// (it was purely retrospective) — without one, a 2pt stop would size to
// floor(1200/(2*20))=30 contracts, an unrealistic, execution-risk-heavy
// position no matter how tight the stop looks on paper.
// 2026-09-17 fix, found live same morning: the original ceiling (8) was
// picked purely as a tail-risk guard against unrealistic size, without
// checking TopstepX's own per-account contract limit — JJ confirmed 50K
// accounts cap at 5. The 07:39 ET arm this session actually computed 6
// (9.75pt stop), over that limit; it never placed, but only because of the
// separate Auto-OCO Brackets issue, not because this ceiling caught it.
// Lowered to the real platform limit.
const POINT_VALUE = 20; // NQ full-size, $/pt/contract
const TARGET_DOLLAR_RISK = 1200;
const MAX_CONTRACTS = 5;
function sizeForRisk(riskPoints) {
  return Math.max(1, Math.min(MAX_CONTRACTS, Math.floor(TARGET_DOLLAR_RISK / (riskPoints * POINT_VALUE))));
}
const OTE_PROXIMITY = 40;
const IFVG_PROXIMITY = 40;

if (!hasConfig()) {
  console.error('No topstep-config.json found — copy topstep-config.example.json, fill in username + apiKey, and run test-topstep-connection.mjs first. Refusing to start without it.');
  process.exit(1);
}

// 2026-09-07: optional START time added, per JJ's request — one arg is still
// just a cutoff (starts immediately, exact previous behavior, unchanged for
// anyone with muscle memory around the old single-arg form). Two args means
// the first is START and the second is cutoff: the process comes up right
// away (resolves account/contract immediately, so a bad config still fails
// fast) but WAITS to actually watch for signals until START is reached —
// see the wait-loop in main(). Lets JJ launch it any time and walk away,
// instead of needing to be at the keyboard at the exact minute the window
// opens.
const rawArg2 = process.argv[2];
const rawArg3 = process.argv[3];
if (!rawArg2) {
  console.error('Usage: node topstep-live-poller.mjs "HH:MM" (or "YYYY-MM-DD HH:MM")\n   or: node topstep-live-poller.mjs "START" "CUTOFF" (each HH:MM or YYYY-MM-DD HH:MM) — waits until START before watching for signals');
  process.exit(1);
}
const startArg = rawArg3 ? rawArg2 : null;
const cutoffArg = rawArg3 ? rawArg3 : rawArg2;

function etDateTimeToEpochMs(dateStr, timeStr) {
  const naiveUtc = new Date(`${dateStr}T${timeStr}:00Z`);
  const etFormatted = naiveUtc.toLocaleString('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const [d, t] = etFormatted.split(', ');
  const [mm, dd, yyyy] = d.split('/');
  const asIfUtc = new Date(`${yyyy}-${mm}-${dd}T${t}Z`);
  return naiveUtc.getTime() + (naiveUtc.getTime() - asIfUtc.getTime());
}
function parseTimeArg(arg) {
  arg = arg.trim(); // tolerate accidental leading/trailing whitespace from the terminal prompt
  const absoluteMatch = arg.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/);
  // 2026-09-09 fix, found live: a malformed date (JJ typed "26-09-09 11:00",
  // missing the "20" prefix) silently fell through to being treated as a
  // literal "HH:MM" value with no validation at all — the cutoff/start
  // comparison then ran as a string compare against garbage that could
  // never realistically match a real HH:MM clock reading, meaning the
  // session might never actually stop. Now rejected outright at startup
  // instead of accepted and silently broken.
  if (!absoluteMatch && !/^\d{2}:\d{2}$/.test(arg)) {
    console.error(`Invalid time "${arg}" — expected "HH:MM" or "YYYY-MM-DD HH:MM". Refusing to start with an unparseable start/cutoff time.`);
    process.exit(1);
  }
  const hhmm = absoluteMatch ? absoluteMatch[2] : arg;
  const epochMs = absoluteMatch ? etDateTimeToEpochMs(absoluteMatch[1], absoluteMatch[2]) : null;
  const label = absoluteMatch ? `${absoluteMatch[1]} ${absoluteMatch[2]} ET` : `${hhmm} ET (today)`;
  return { hhmm, epochMs, label };
}
const CUTOFF = parseTimeArg(cutoffArg);
const CUTOFF_ET = CUTOFF.hhmm, CUTOFF_EPOCH_MS = CUTOFF.epochMs, CUTOFF_LABEL = CUTOFF.label;
const START = startArg ? parseTimeArg(startArg) : null;
// Only checkable when both are absolute (YYYY-MM-DD HH:MM) — a plain HH:MM
// on either side is same-day-relative and ambiguous to compare here.
if (START && START.epochMs != null && CUTOFF_EPOCH_MS != null && START.epochMs >= CUTOFF_EPOCH_MS) {
  console.error(`START (${START.label}) is not before CUTOFF (${CUTOFF_LABEL}) — nothing would ever run. Check your arguments.`);
  process.exit(1);
}

function nowET_HHMM() {
  return new Date().toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false }).slice(0, 5);
}
function isoNow() { return new Date().toISOString(); }

const SESSIONS_DIR = path.join(__dirname, 'sessions');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
// 2026-09-10 fix, found live: sessionDate was `new Date()` at LAUNCH time, so
// a poller started the evening before a next-morning session (ts 2026-09-09
// 00:51Z = 8:51pm ET Sep 8, START "2026-09-09 07:00") named its files
// 2026-09-08-* — the wrong trading day, and it collided with the real Sep 8
// files. Derive the date from START instead whenever START is given; only
// fall back to "now" for the start-immediately case.
function deriveSessionDate() {
  const nowDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (!START) return nowDate();
  if (START.epochMs != null) {
    // absolute "YYYY-MM-DD HH:MM" — the ET wall date at that instant
    return new Date(START.epochMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  }
  // plain "HH:MM" — if that time already passed in ET today, START means tomorrow
  if (START.hhmm <= nowET_HHMM()) {
    const d = new Date(`${nowDate()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  }
  return nowDate();
}
const sessionDate = deriveSessionDate();
const LOG_PATH = path.join(SESSIONS_DIR, `${sessionDate}-topstep-live.jsonl`);
function appendLog(obj) { fs.appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n'); }

// 2026-09-08: real-money trade summary, written alongside the raw JSONL log
// so the dashboard has an accurate, reconciled source instead of having to
// trust the raw event stream (which had a real false-positive-fill bug the
// same day this was built — see EVOLUTION.md). One record per real order
// placed, keyed by orderId, updated in place as it resolves.
const SUMMARY_PATH = path.join(SESSIONS_DIR, `${sessionDate}-topstep-live-candidates.json`);
// 2026-09-11 fix, found doing a weekly review: registry started empty every
// process launch and writeRegistry() fully overwrites SUMMARY_PATH, so a
// second poller launch on the same calendar day silently destroyed every
// trade the first launch had already written — confirmed live: 2026-09-10's
// file lost its morning cancelled order AND its midday -$178.78 stop-out,
// both wiped when the evening 18:00-19:00 session started fresh and wrote
// only its own trade. Now hydrate from the existing file (if any) before
// the session adds to it, so same-day relaunches accumulate instead of
// clobbering.
const registry = new Map();
if (fs.existsSync(SUMMARY_PATH)) {
  try {
    const existing = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8'));
    for (const rec of existing) registry.set(rec.orderId, rec);
    console.log(`Loaded ${existing.length} existing trade record(s) for ${sessionDate} from ${SUMMARY_PATH}.`);
  } catch (err) {
    console.error(`WARNING: couldn't parse existing ${SUMMARY_PATH} (${err.message}) — starting this session's registry empty. The old file is NOT overwritten until the first write, so it's still on disk to recover by hand if this session's data ends up wrong.`);
  }
}
function writeRegistry() {
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify([...registry.values()], null, 2));
}

let ACCOUNT_ID = null;
let CONTRACT_ID = null;
let SESSION_START_BALANCE = null;
let haltedReason = null; // sticky once a daily cap trips — never clears mid-session

async function resolveAccountAndContract() {
  const configuredId = JSON.parse(fs.readFileSync(path.join(__dirname, 'topstep-config.json'), 'utf8')).accountId;
  const accResp = await searchAccounts({ onlyActiveAccounts: true });
  if (!accResp.accounts || accResp.accounts.length === 0) {
    throw new Error('No active TopStep accounts found for this API key.');
  }
  if (configuredId != null) {
    const match = accResp.accounts.find(a => a.id === configuredId);
    if (!match) throw new Error(`topstep-config.json's accountId (${configuredId}) is not among this API key's active accounts.`);
    ACCOUNT_ID = match.id;
    SESSION_START_BALANCE = match.balance;
  } else {
    if (accResp.accounts.length > 1) {
      console.log(`WARNING: ${accResp.accounts.length} active accounts found, using the first (id=${accResp.accounts[0].id}, name=${accResp.accounts[0].name}). Set topstep-config.json's accountId explicitly if this is the wrong one.`);
    }
    ACCOUNT_ID = accResp.accounts[0].id;
    SESSION_START_BALANCE = accResp.accounts[0].balance;
  }

  // 2026-08-31: searching "NQ" is ambiguous on its own — a plain substring
  // search against the API returns unrelated contracts whose internal codes
  // happen to contain "NQ" (confirmed 2026-09-06: E-Mini Natural Gas "QGV6"
  // and E-Mini Crude Oil "QMV6" both showed up), and previously "MNQ" (the
  // micro) also matched as a substring of any loose "NQ" search. SYMBOL
  // below must be an exact prefix match against the contract's own `name`
  // field, not just "any active result the search returned."
  //
  // 2026-09-06: switched from MNQ to full-size NQ at JJ's explicit request.
  // REAL CONSEQUENCE, stated plainly: NQ's tickValue is $5/tick (0.25pt) =
  // $20/point, exactly 10x MNQ's $0.50/tick = $2/point — the same 15-20pt
  // stop that risked ~$30-40 on MNQ now risks ~$300-400 on 1 NQ. The daily
  // $1,550/$1,800 caps (hard_constraints.daily_caps_enforcement) still work
  // correctly regardless (they check real account balance, not points), but
  // far fewer bad trades now stand between a normal session and hitting them.
  const SYMBOL = 'NQ';
  const conResp = await searchContract(SYMBOL);
  const active = (conResp.contracts || []).find(c => c.activeContract && c.name?.startsWith(SYMBOL));
  if (!active) throw new Error(`No active ${SYMBOL} contract found via Contract/search (exact prefix match) — check the account supports it.`);
  CONTRACT_ID = active.id;
  console.log(`Resolved account ${ACCOUNT_ID}, contract ${CONTRACT_ID} (${active.name}) — tickValue=${active.tickValue}, confirm this matches ${SYMBOL} before trusting any order size math.`);
}

// Same shape as shadow-poller.mjs's buildChromeTradePlan, trimmed down: no
// Brian's-sourced TP2/runner concept — full-exit-at-TP1 is the standing
// rule, so this only ever needs entry/stop/TP1 for a bracket order.
function findSwingExtreme(bars, side) {
  let best = bars[0];
  for (const b of bars) {
    if (side === 'low' && b.low < best.low) best = b;
    if (side === 'high' && b.high > best.high) best = b;
  }
  return best;
}
function buildPlan(fib, direction, closedBars, ifvgObj) {
  const isBear = direction === 'BEAR';
  const entry = fib.ote705;
  const stop = isBear ? roundToTick(ifvgObj.invalidation + TICK) : roundToTick(ifvgObj.invalidation - TICK);
  const swingOpp = findSwingExtreme(closedBars, isBear ? 'low' : 'high');
  const tp1 = roundToTick(isBear ? swingOpp.low : swingOpp.high);
  const riskPoints = +Math.abs(entry - stop).toFixed(2);
  const onCorrectSide = isBear ? stop > entry : stop < entry;
  const passesGate = onCorrectSide && riskPoints >= MIN_STOP_POINTS && riskPoints <= MAX_STOP_POINTS;
  return { direction, entry, stop, tp1, riskPoints, passesGate };
}

// chromeState: same per-direction dedup pattern as shadow-poller.mjs
// (cisdTime-only, rearm only after the tracked order/position actually
// resolves) — see project_shadow_poller_dedup_fix_2026_08_12 for the full
// history of why this specific shape is correct.
const chromeState = {
  BEAR: { lastCisdTime: null, activeTrade: null, usedIfvgKeys: new Set(), seenArmedCisdTimes: new Set() },
  BULL: { lastCisdTime: null, activeTrade: null, usedIfvgKeys: new Set(), seenArmedCisdTimes: new Set() },
};

async function findStopOrderFor(trade) {
  // 2026-09-08 fix: this used to match by "closest stopPrice within 2 ticks
  // of what we expect" — a heuristic flagged since the file's own header as
  // not a guaranteed lookup, because gateway.docs.projectx.com's Order
  // reference doesn't document a parent/child link. Pulling REAL order
  // history that same day showed every bracket child order actually DOES
  // carry `parentOrderId` back to its entry order — undocumented but real,
  // confirmed against live data. Matching on `parentOrderId === trade
  // .orderId` is an exact lookup now, not a proximity guess.
  const resp = await searchOpenOrders({ accountId: ACCOUNT_ID });
  const candidates = (resp.orders || []).filter(o =>
    o.accountId === ACCOUNT_ID && o.contractId === CONTRACT_ID && o.type === ORDER_TYPE.STOP &&
    o.parentOrderId === trade.orderId
  );
  if (candidates.length !== 1) {
    console.log(`WARNING: findStopOrderFor matched ${candidates.length} orders (expected 1) for entry orderId=${trade.orderId} — skipping breakeven move this tick, will retry next tick.`);
    return null;
  }
  return candidates[0];
}

// 2026-09-08: added for the trade-summary file — once a position closes,
// figure out HOW (stop hit / target hit / something else) by checking real
// order history instead of guessing. Uses the same parentOrderId link
// findStopOrderFor relies on, plus a best-effort check for an external
// close (confirmed live 2026-09-08: TopStep's own Personal Daily Profit
// Target liquidated a position with a standalone MARKET order neither
// bracket leg triggered — reported honestly as "likely external", not
// asserted as certain, since there's no direct "why was this closed" field
// documented anywhere in the API).
async function resolveTradeOutcome(trade) {
  const startTs = trade.armedAt || new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  const resp = await searchOrders({ accountId: ACCOUNT_ID, startTimestamp: startTs, endTimestamp: new Date().toISOString() }).catch(() => null);
  if (!resp) return { outcome: 'CLOSED (unable to verify — order history lookup failed, check TopstepX directly)', resultR: null, exitPrice: null };
  const orders = resp.orders || [];
  const sl = orders.find(o => o.parentOrderId === trade.orderId && o.type === ORDER_TYPE.STOP);
  const tp = orders.find(o => o.parentOrderId === trade.orderId && o.type === ORDER_TYPE.LIMIT);
  const risk = trade.plan?.riskPoints;
  if (sl && sl.status === ORDER_STATUS.FILLED) {
    return { outcome: 'STOP', resultR: -1, exitPrice: sl.filledPrice };
  }
  if (tp && tp.status === ORDER_STATUS.FILLED) {
    const reward = trade.realEntry != null ? Math.abs(tp.filledPrice - trade.realEntry) : null;
    return { outcome: 'TP1', resultR: (risk > 0 && reward != null) ? +(reward / risk).toFixed(2) : null, exitPrice: tp.filledPrice };
  }
  // Neither bracket leg filled — closed some other way. Best-effort: a
  // standalone MARKET order, closing side, filled, not part of any bracket.
  const isBear = trade.direction === 'BEAR';
  const closingSide = isBear ? ORDER_SIDE.BUY : ORDER_SIDE.SELL;
  const marketExit = orders.find(o => o.type === ORDER_TYPE.MARKET && o.side === closingSide && o.parentOrderId == null && o.status === ORDER_STATUS.FILLED);
  if (marketExit && trade.realEntry != null) {
    const points = isBear ? (trade.realEntry - marketExit.filledPrice) : (marketExit.filledPrice - trade.realEntry);
    return {
      outcome: "CLOSED (external — likely TopStep's own daily profit/loss target liquidation, not a stop or target hit)",
      resultR: risk > 0 ? +(points / risk).toFixed(2) : null, exitPrice: marketExit.filledPrice, points: +points.toFixed(2),
    };
  }
  return { outcome: 'CLOSED (cause unverified — check TopstepX directly)', resultR: null, exitPrice: null };
}

// 2026-09-09: a real trade filled AND stopped out within the same second —
// faster than one 30s poll cycle. `searchOpenPositions` never once saw the
// position exist, so the ordinary "not confirmedFilled yet, check if a
// position now exists" branch never fired, and `cs.activeTrade` was left
// permanently stuck thinking the entry was still pending — which silently
// blocked that direction from ever arming again for the rest of the
// session (the "if (cs.activeTrade) continue" guard doesn't know the
// difference between "still working" and "stuck"). Fixed by checking the
// entry order's OWN real status (not position existence) whenever it's no
// longer in the open-orders list: if it has a fill, resolve the whole trade
// (entry + outcome) from real order history in one pass; if it never
// filled at all, there's nothing to track.
async function resolveEntryAndOutcome(trade) {
  const startTs = trade.armedAt || new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  const resp = await searchOrders({ accountId: ACCOUNT_ID, startTimestamp: startTs, endTimestamp: new Date().toISOString() }).catch(() => null);
  if (!resp) return { neverFilled: false, unresolved: true };
  const entry = (resp.orders || []).find(o => o.id === trade.orderId);
  if (!entry || entry.fillVolume < 1) return { neverFilled: true };
  const realEntry = entry.filledPrice;
  const outcome = await resolveTradeOutcome({ ...trade, realEntry });
  return { neverFilled: false, realEntry, ...outcome };
}

// 2026-09-10 fix, found live: an order placed close to cutoff (10:31 ET,
// cutoff 11:00 ET) was never reconciled — main()'s cutoff branch just broke
// the loop with no final check, so a still-open real trade's fill/close was
// silently dropped from both the JSONL log and the candidates registry (the
// account balance confirmed it filled and lost ~$254; the files show
// nothing). Separately, an EARLIER trade the same week had its owning
// process killed outright (Ctrl+C or closed terminal — no crash log exists
// either way) partway through the session, taking all in-memory tracking
// for its still-open order down with it; that order's candidates file was
// never even created. Both are the same root gap: nothing ever tries to
// resolve an order's true outcome before the process stops watching it.
// Extracted from tick()'s per-direction body so both the normal poll loop
// AND a final reconciliation pass (added below, run on cutoff and on
// SIGINT/SIGTERM) share the exact same resolution logic instead of two
// versions drifting apart.
//
// Resolve: is the currently-tracked trade for this CISD actually done
// (position closed — hit its bracket stop or target)? If so, free it up
// for a genuine re-arm, same rule as shadow-poller.mjs's 2026-08-14 fix.
//
// 2026-09-08 fix: position checks used to be `.some(p => p.contractId ===
// CONTRACT_ID)` — matches ANY position on the contract, BEAR or BULL, ours
// or otherwise. Confirmed via gateway.docs.projectx.com's Enum Definitions
// (PositionType: Long=1, Short=2) that positions carry a real, documented
// direction field — now filtered on it, so a BULL trade can never be
// confused for a BEAR position's evidence or vice versa (this alone
// wouldn't have caught the double-long above, since both were BULL — the
// CISD fix in tick() is what actually closes that gap; this is a
// correctness fix for the direction-crossing case instead).
async function reconcileActiveTrade(direction, cs) {
  const isBear = direction === 'BEAR';
  const expectedPositionType = isBear ? POSITION_TYPE.SHORT : POSITION_TYPE.LONG;
  if (!cs.activeTrade) return;
  const posResp = await searchOpenPositions({ accountId: ACCOUNT_ID }).catch(() => null);
  const myPosition = posResp && (posResp.positions || []).find(p => p.contractId === CONTRACT_ID && p.type === expectedPositionType);
  if (!myPosition && cs.activeTrade.confirmedFilled) {
    cs.usedIfvgKeys.add(cs.activeTrade.ifvgKey);
    appendLog({ event: 'TRADE_CLOSED', ts: isoNow(), etTime: nowET_HHMM(), direction, trade: cs.activeTrade });
    const resolved = await resolveTradeOutcome(cs.activeTrade).catch(err => ({ outcome: `CLOSED (resolution check failed: ${err.message})`, resultR: null, exitPrice: null }));
    const rec = registry.get(cs.activeTrade.orderId);
    if (rec) {
      Object.assign(rec, resolved, { closed_at: isoNow() });
      writeRegistry();
    }
    cs.activeTrade = null;
  } else if (cs.activeTrade && !cs.activeTrade.confirmedFilled) {
    if (myPosition) {
      cs.activeTrade.confirmedFilled = true;
      // 2026-09-08 fix: breakeven math and the eventual stop-modify
      // target now use the REAL average fill price, not the planned/
      // theoretical entry (fib.ote705) — a limit order can fill better
      // than planned (confirmed live: planned 29557, filled 29552.25),
      // and moving "breakeven" to a price that was never the real entry
      // either leaves free R on the table or, worse, isn't genuinely
      // riskless. plan.entry is kept as-is for logging/journal purposes.
      cs.activeTrade.realEntry = myPosition.averagePrice;
      appendLog({ event: 'TRADE_FILLED', ts: isoNow(), etTime: nowET_HHMM(), direction, trade: cs.activeTrade });
      const rec = registry.get(cs.activeTrade.orderId);
      if (rec) {
        rec.filled = true; rec.filled_at = isoNow(); rec.realEntry = cs.activeTrade.realEntry;
        writeRegistry();
      }
    } else {
      // 2026-09-09 fix: no position exists, but that alone doesn't mean
      // "still waiting to fill" — it might have already filled AND
      // closed within this same poll gap (confirmed live: same-second
      // fill-then-stop). Only conclude "still pending" if the entry
      // order is genuinely still open; otherwise resolve it for real
      // instead of leaving activeTrade stuck (which silently blocks
      // this direction from ever arming again for the rest of the
      // session).
      const openResp = await searchOpenOrders({ accountId: ACCOUNT_ID }).catch(() => null);
      const stillPending = openResp && (openResp.orders || []).some(o => o.id === cs.activeTrade.orderId);
      if (!stillPending) {
        const resolved = await resolveEntryAndOutcome(cs.activeTrade).catch(err => ({ neverFilled: false, unresolved: true, error: err.message }));
        const rec = registry.get(cs.activeTrade.orderId);
        if (resolved.neverFilled) {
          appendLog({ event: 'TRADE_CANCELLED_UNFILLED', ts: isoNow(), etTime: nowET_HHMM(), direction, trade: cs.activeTrade });
          if (rec) { Object.assign(rec, { outcome: 'CANCELLED (never filled)', closed_at: isoNow() }); writeRegistry(); }
          // 2026-09-10 fix, found live minutes after shipping the reconcile
          // path: this branch logged the cancel but never released the
          // direction — cs.activeTrade stayed set, so BEAR was blocked from
          // re-arming for the rest of the session and TRADE_CANCELLED_UNFILLED
          // re-fired every tick. Same cleanup the filled-then-closed branch
          // below already does. Blacklist the ifvgKey too: a manually
          // cancelled setup shouldn't be re-entered on the identical IFVG.
          cs.usedIfvgKeys.add(cs.activeTrade.ifvgKey);
          cs.activeTrade = null;
        } else if (resolved.unresolved) {
          console.log(`WARNING: could not resolve orderId=${cs.activeTrade.orderId} (${resolved.error || 'no order-history match'}) — will retry next tick, this direction stays blocked from re-arming until it resolves.`);
          // Deliberately do NOT clear cs.activeTrade here — better to
          // stay blocked (missed opportunity) than silently drop
          // tracking of an order that might still be real.
        } else {
          appendLog({ event: 'TRADE_FILLED', ts: isoNow(), etTime: nowET_HHMM(), direction, trade: { ...cs.activeTrade, realEntry: resolved.realEntry } });
          appendLog({ event: 'TRADE_CLOSED', ts: isoNow(), etTime: nowET_HHMM(), direction, trade: cs.activeTrade, resolved });
          if (rec) { Object.assign(rec, resolved, { filled: true, filled_at: isoNow(), closed_at: isoNow() }); writeRegistry(); }
          cs.usedIfvgKeys.add(cs.activeTrade.ifvgKey);
          cs.activeTrade = null;
        }
      }
    }
  }
}

// Best-effort, time-boxed final reconciliation — called both when cutoff is
// reached (main()'s loop) and from the SIGINT/SIGTERM handler below. Races
// against a timeout so a network hiccup on the way out can't hang the
// process open indefinitely; if it times out or throws, that's logged
// honestly rather than silently swallowed, since the whole point is to stop
// silent data loss, not just move where it can happen.
async function finalReconcile(reason) {
  appendLog({ event: 'FINAL_RECONCILE_START', ts: isoNow(), etTime: nowET_HHMM(), reason });
  for (const direction of ['BEAR', 'BULL']) {
    const cs = chromeState[direction];
    if (!cs.activeTrade) continue;
    try {
      await Promise.race([
        reconcileActiveTrade(direction, cs),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 10s')), 10_000)),
      ]);
    } catch (err) {
      console.error(`finalReconcile(${direction}) failed: ${err.message}`);
    }
    if (cs.activeTrade) {
      // Still unresolved even after a direct attempt — say so loudly in the
      // log instead of letting the process exit without a trace, which is
      // exactly what happened to the 08:03 ET trade this same week.
      appendLog({ event: 'SESSION_END_UNRESOLVED_TRADE', ts: isoNow(), etTime: nowET_HHMM(), direction, trade: cs.activeTrade });
      console.log(`WARNING: ${direction} trade (orderId=${cs.activeTrade.orderId}) is still unresolved at session end — check TopstepX directly and reconcile the candidates file by hand.`);
    }
  }
}

// Gates NEW entries only — never touches existing open positions/orders.
// Checks live account balance vs. session-start balance (real fills/fees,
// no manual point-to-dollar math needed). Sticky: once tripped, later calls
// short-circuit without hitting the API again.
async function checkDailyCaps() {
  if (haltedReason) return haltedReason;
  const accResp = await searchAccounts({ onlyActiveAccounts: true }).catch(() => null);
  const acc = accResp?.accounts?.find(a => a.id === ACCOUNT_ID);
  if (!acc) return null; // transient lookup failure — fail open on the check itself, don't halt on a blip
  const pnl = acc.balance - SESSION_START_BALANCE;
  let reason = null;
  if (pnl >= MAX_DAILY_PROFIT) {
    reason = `daily profit cap hit (+$${pnl.toFixed(2)} >= +$${MAX_DAILY_PROFIT} consistency limit)`;
  } else if (pnl <= -MAX_DAILY_LOSS) {
    reason = `daily loss cap hit (-$${Math.abs(pnl).toFixed(2)} >= -$${MAX_DAILY_LOSS} max loss)`;
  }
  if (reason && !DAILY_CAPS_ENFORCED) {
    // Local halt disabled (see DAILY_CAPS_ENFORCED comment) — log the crossing
    // as information only, keep trading. TopStep's own platform-side PDPT/PDLL
    // is the real enforcement and is untouched by this flag either way.
    appendLog({ event: 'DAILY_CAP_THRESHOLD_CROSSED_NOT_ENFORCED', ts: isoNow(), etTime: nowET_HHMM(), reason, balance: acc.balance, sessionStartBalance: SESSION_START_BALANCE });
    console.log(`\n[${nowET_HHMM()} ET] NOTE: ${reason} — local halt disabled (DAILY_CAPS_ENFORCED=false), still trading. TopStep's own PDPT/PDLL enforcement is separate and still applies.\n`);
    return null;
  }
  if (reason) haltedReason = reason;
  if (haltedReason) {
    appendLog({ event: 'DAILY_CAP_HALT', ts: isoNow(), etTime: nowET_HHMM(), reason: haltedReason, balance: acc.balance, sessionStartBalance: SESSION_START_BALANCE });
    console.log(`\n[${nowET_HHMM()} ET] *** HALT: ${haltedReason} *** No new entries for the rest of this session. Existing positions/orders are untouched — manage them directly in TopstepX.\n`);
    await sendCancelledAlert({ direction: 'N/A', model: 'topstep-live-poller', entry: 'n/a', stop: 'n/a', reason: haltedReason }).catch(() => {});
  }
  return haltedReason;
}

async function tick() {
  const state = await getState();
  const originalResolution = state.resolution;
  await setTimeframe({ timeframe: '3' });
  const ohlcv = await getOhlcv({ count: CHROME_FIB_LOOKBACK_BARS, summary: false });
  await setTimeframe({ timeframe: originalResolution });
  const bars = ohlcv.bars;
  // Same repaint guard as shadow-poller.mjs: detection uses closed bars only.
  const closedBars = bars.length > 1 ? bars.slice(0, -1) : bars;
  const quote = await getQuote({});
  const price = quote.last;

  for (const direction of ['BEAR', 'BULL']) {
    const cs = chromeState[direction];
    const isBear = direction === 'BEAR';
    const fib = computeChromeFib(closedBars, direction);
    if (!fib || fib.expired) continue;

    // 2026-09-08 fix, found live by JJ watching TopstepX directly: this
    // used to unconditionally null cs.activeTrade the instant a genuinely
    // new CISD formed — REGARDLESS of whether the previous trade under the
    // old CISD had actually resolved yet. That let a second real BULL order
    // arm and fill while the first was still open (an unintended double
    // long), and worse, it overwrote the ONE per-direction activeTrade slot
    // with the new trade's info — so the still-open first trade lost all
    // further tracking, including the manual-breakeven watcher below, which
    // is why it never fired even after price ran 90+ points in favor.
    // Fix: a new CISD updates bookkeeping but NEVER clears a real,
    // unresolved activeTrade. The existing "if (cs.activeTrade) continue"
    // further down already refuses to arm anything new while one is live —
    // that guard only works if activeTrade is never wrongly nulled first.
    if (cs.lastCisdTime !== fib.cisdBar.time) {
      cs.lastCisdTime = fib.cisdBar.time;
      if (!cs.activeTrade) cs.usedIfvgKeys = new Set();
    }

    // Resolve any trade already tracked for this direction (fill/close
    // detection, breakeven-eligible bookkeeping) — see reconcileActiveTrade
    // for the logic and its history.
    await reconcileActiveTrade(direction, cs);

    // Breakeven watcher: only meaningful once the entry has actually filled.
    if (cs.activeTrade && cs.activeTrade.confirmedFilled && !cs.activeTrade.breakevenMoved) {
      const realEntry = cs.activeTrade.realEntry ?? cs.activeTrade.entry;
      const favMove = isBear ? realEntry - price : price - realEntry;
      if (favMove >= MANUAL_BREAKEVEN_POINTS) {
        const stopOrder = await findStopOrderFor(cs.activeTrade).catch(() => null);
        if (stopOrder) {
          await modifyOrder({ accountId: ACCOUNT_ID, orderId: stopOrder.id, stopPrice: realEntry }).catch(err => {
            console.error(`modifyOrder (breakeven) failed: ${err.message}`);
          });
          cs.activeTrade.breakevenMoved = true;
          appendLog({ event: 'BREAKEVEN_MOVED', ts: isoNow(), etTime: nowET_HHMM(), direction, trade: cs.activeTrade, stopOrderId: stopOrder.id });
          console.log(`[${nowET_HHMM()} ET] ${direction} breakeven rule fired — moved stop order ${stopOrder.id} to ${realEntry} (real fill price).`);
        }
      }
    }

    if (cs.activeTrade) continue; // already have a live trade tracked for this direction/CISD

    const halt = await checkDailyCaps();
    if (halt) continue; // caps only block NEW entries — breakeven/close monitoring above already ran

    const dist = Math.abs(price - fib.ote705);
    if (dist > OTE_PROXIMITY) continue;
    const confirmingIfvg = nearestValidIfvg(closedBars, direction, fib.ote705, IFVG_PROXIMITY, cs.usedIfvgKeys);
    if (!confirmingIfvg) continue;

    const rearm = cs.usedIfvgKeys.size > 0;
    if (!rearm && cs.seenArmedCisdTimes.has(fib.cisdBar.time)) continue;
    cs.seenArmedCisdTimes.add(fib.cisdBar.time);

    const plan = buildPlan(fib, direction, closedBars, confirmingIfvg);
    if (!plan.passesGate) {
      appendLog({ event: 'REJECTED', ts: isoNow(), etTime: nowET_HHMM(), direction, plan });
      continue;
    }

    const riskTicks = Math.round(plan.riskPoints / TICK);
    const rewardTicks = Math.round(Math.abs(plan.tp1 - plan.entry) / TICK);
    const orderSize = sizeForRisk(plan.riskPoints);
    console.log(`\n[${nowET_HHMM()} ET] ${direction} ARMED — entry=${plan.entry} stop=${plan.stop} (${plan.riskPoints}pt) tp1=${plan.tp1} size=${orderSize}`);
    appendLog({ event: 'ARMED', ts: isoNow(), etTime: nowET_HHMM(), direction, plan, orderSize });

    // 2026-09-04: fires immediately, no confirm step — see file header for
    // the precondition this depends on (JJ physically at this machine when
    // it's running).
    await sendArmedAlert({
      direction, model: "JJ's Model (LIVE — firing automatically)",
      plan: { entry: plan.entry, stop: plan.stop, riskPoints: plan.riskPoints, tp1: plan.tp1, tp2: null, rr1: (rewardTicks / riskTicks).toFixed(2), breakevenAt: null, breakevenPoints: MANUAL_BREAKEVEN_POINTS },
      path: 'topstep-live-poller', grade: `size=${orderSize} NQ ($-normalized)`,
    }).catch(() => {});

    console.log(`[${nowET_HHMM()} ET] ${direction} placing bracket order now.`);
    let placed;
    try {
      // 2026-09-07 fix: real live rejection on the very first SELL order —
      // "Invalid take profit ticks (271). Ticks should be less than zero
      // when going short." The docs' own example (gateway.docs.projectx.com
      // /docs/api-reference/order/order-place) shows a sell order with BOTH
      // bracket ticks positive, which the live API contradicts outright —
      // going with what the live API actually enforced, not the doc
      // example. Ticks are signed relative to entry, in the direction price
      // needs to move: BULL stop is below entry (negative), target above
      // (positive); BEAR stop is above entry (positive), target below
      // (negative) — the two are always mirror images of each other. Only
      // one side of this (BEAR takeProfit) has been directly confirmed
      // against the real API so far; watch the next BULL fill closely too.
      const signedStopTicks = isBear ? riskTicks : -riskTicks;
      const signedTP1Ticks = isBear ? -rewardTicks : rewardTicks;
      placed = await placeOrder({
        accountId: ACCOUNT_ID, contractId: CONTRACT_ID,
        type: ORDER_TYPE.LIMIT, side: isBear ? ORDER_SIDE.SELL : ORDER_SIDE.BUY, size: orderSize,
        limitPrice: plan.entry,
        stopLossBracket: { ticks: signedStopTicks, type: ORDER_TYPE.STOP },
        takeProfitBracket: { ticks: signedTP1Ticks, type: ORDER_TYPE.LIMIT },
        // 2026-09-07 fix: was `chrome-${direction}-${cisdBar.time}` alone —
        // deterministic from the signal's own structure, so restarting the
        // process (in-memory dedup state resets, the same still-valid CISD
        // gets re-detected) regenerated an IDENTICAL tag to a PRIOR attempt
        // and TopStep rejected it outright: "Specified custom tag is
        // already in use" — confirmed live, it reserves tags even for
        // orders that themselves got rejected, not just successful ones.
        // Date.now() suffix makes every actual placeOrder call unique
        // regardless of how many times the same structure gets retried.
        customTag: `chrome-${direction}-${fib.cisdBar.time}-${Date.now()}`,
      });
    } catch (err) {
      console.error(`placeOrder failed: ${err.message}`);
      appendLog({ event: 'PLACE_ORDER_FAILED', ts: isoNow(), etTime: nowET_HHMM(), direction, plan, error: err.message });
      continue;
    }
    cs.activeTrade = {
      ...plan, ifvgKey: confirmingIfvg.invertedTime, orderId: placed.orderId,
      confirmedFilled: false, breakevenMoved: false, armedAt: isoNow(),
    };
    appendLog({ event: 'ORDER_PLACED', ts: isoNow(), etTime: nowET_HHMM(), direction, plan, orderId: placed.orderId, orderSize, rearm });
    registry.set(placed.orderId, {
      id: placed.orderId, orderId: placed.orderId, model: "JJ's Model", direction,
      plan: { entry: plan.entry, stop: plan.stop, tp1: plan.tp1, riskPoints: plan.riskPoints },
      // 2026-09-17: `size` recorded per-trade now that sizing is dollar-risk-
      // normalized instead of fixed — dashboard-data.mjs's live $ math reads
      // this instead of assuming 1 contract (see EVOLUTION.md 2026-09-17).
      size: orderSize,
      armed_at: isoNow(), realEntry: null, filled: false, filled_at: null,
      outcome: null, resultR: null, exitPrice: null, closed_at: null,
    });
    writeRegistry();
  }
}

// Blocks until START is reached (no-op if START wasn't given — starts
// watching immediately, exact previous behavior). Account/contract are
// already resolved by the time this runs, so a bad config still fails fast
// instead of silently waiting for hours first.
async function waitUntilStart() {
  if (!START) return;
  console.log(`Waiting until ${START.label} to begin watching for signals — account/contract already resolved above, nothing else happens until then.`);
  appendLog({ event: 'WAITING_FOR_START', ts: isoNow(), etTime: nowET_HHMM(), start: START.label });
  let lastPrint = Date.now();
  while (true) {
    const hhmm = nowET_HHMM();
    const startReached = START.epochMs != null ? Date.now() >= START.epochMs : hhmm >= START.hhmm;
    if (startReached) break;
    if (Date.now() - lastPrint > 5 * 60 * 1000) {
      console.log(`[${hhmm} ET] still waiting for ${START.label}...`);
      lastPrint = Date.now();
    }
    await new Promise(r => setTimeout(r, 10_000));
  }
  console.log(`[${nowET_HHMM()} ET] start time reached — now watching for signals.`);
  appendLog({ event: 'START_REACHED', ts: isoNow(), etTime: nowET_HHMM() });
}

async function main() {
  console.log('topstep-live-poller starting. THIS PLACES REAL ORDERS AUTOMATICALLY, no confirm prompt — only run this while you are physically at this machine.');
  await resolveAccountAndContract();
  console.log(`Start: ${START ? START.label : 'immediately'}. Cutoff: ${CUTOFF_LABEL}. Log: ${LOG_PATH}`);
  console.log(`Session-start balance: $${SESSION_START_BALANCE}. Sizing: $-normalized, target $${TARGET_DOLLAR_RISK}/trade, 1-${MAX_CONTRACTS} contracts (20pt stop = 1, tighter = more). Daily caps: ${DAILY_CAPS_ENFORCED ? `halt new entries at +$${MAX_DAILY_PROFIT} (consistency) or -$${MAX_DAILY_LOSS} (max loss)` : `DISABLED — local halt off, TopStep's own PDPT/PDLL enforcement still applies`}.`);
  appendLog({
    event: 'START', ts: isoNow(), etTime: nowET_HHMM(), start: START ? START.label : null, cutoff: CUTOFF_ET, accountId: ACCOUNT_ID, contractId: CONTRACT_ID,
    sessionStartBalance: SESSION_START_BALANCE, maxDailyProfit: MAX_DAILY_PROFIT, maxDailyLoss: MAX_DAILY_LOSS,
  });
  await waitUntilStart();

  while (true) {
    const hhmm = nowET_HHMM();
    const cutoffReached = CUTOFF_EPOCH_MS != null ? Date.now() >= CUTOFF_EPOCH_MS : hhmm >= CUTOFF_ET;
    if (cutoffReached) {
      // 2026-09-10 fix: a trade placed shortly before cutoff used to get
      // dropped here with no final check — see finalReconcile's own comment
      // for the live incident that found this.
      await finalReconcile('cutoff reached').catch(err => console.error(`finalReconcile failed: ${err.message}`));
      appendLog({ event: 'STOP', ts: isoNow(), etTime: hhmm, reason: 'cutoff reached' });
      console.log(`Cutoff (${CUTOFF_LABEL}) reached at ${hhmm} ET. Stopping. Any still-open positions/orders are NOT auto-closed — check TopstepX directly.`);
      break;
    }
    try {
      await tick();
    } catch (err) {
      appendLog({ event: 'ERROR', ts: isoNow(), etTime: nowET_HHMM(), error: err.message });
      console.error(`[${nowET_HHMM()} ET] ERROR: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  await disconnect();
  process.exit(0);
}

// 2026-09-10 fix: covers the other half of the same live incident — a
// process killed by hand (Ctrl+C, closed terminal, machine slept) mid-
// session used to take all in-memory trade tracking down with it, with no
// trace left anywhere that the order had ever existed. Now a Ctrl+C (or a
// TERM signal) gets one best-effort shot at writing down the true final
// state before actually exiting, same reconciliation the cutoff path uses.
// Guarded against firing twice on a double Ctrl+C.
let shuttingDown = false;
async function handleShutdownSignal(signal) {
  if (shuttingDown) { process.exit(1); return; } // second signal: just go
  shuttingDown = true;
  console.log(`\n[${nowET_HHMM()} ET] Received ${signal} — reconciling any open trade before exiting (press again to force-quit without reconciling)...`);
  await finalReconcile(`signal: ${signal}`).catch(err => console.error(`finalReconcile failed: ${err.message}`));
  appendLog({ event: 'STOP', ts: isoNow(), etTime: nowET_HHMM(), reason: `signal: ${signal}` });
  await disconnect().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));

main().catch(async (err) => {
  console.error('topstep-live-poller fatal:', err.message);
  appendLog({ event: 'FATAL', ts: isoNow(), etTime: nowET_HHMM(), error: err.message });
  await disconnect();
  process.exit(1);
});
