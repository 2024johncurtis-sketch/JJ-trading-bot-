#!/usr/bin/env node
/**
 * rebalance-poller.mjs
 *
 * Long-running live poller for the Rebalance Model (ledge manipulation +
 * pre-market TPO bias), the model built and backtested 2026-08-08. Polls
 * the live chart every POLL_INTERVAL_MS, replays the SAME detection logic
 * already backtested in backtest/rebalance-engine.mjs (imported, not
 * duplicated) against live 1-minute bars, and sends Discord alerts on state
 * changes. Runs alongside shadow-poller.mjs (Chrome/Brian's model) — fully
 * independent, no shared state, same Discord webhook.
 *
 * Three-tier alerts, mirroring shadow-poller.mjs's EYES_ON/ARMED pattern
 * plus a resolution tier shadow-poller.mjs already had that this one
 * originally didn't (fixed 2026-08-10 — see below):
 *  - EYES_ON  — manipulation leg just confirmed for today (watching for the
 *               rejection-wick entry at the opposite ledge).
 *  - ARMED    — entry trigger fired: bias + manip leg + rejection wick +
 *               directional close all lined up. Includes entry/stop/target
 *               (fixed 2R, matching what's deployed on the chart and what
 *               the 2026-08-08 out-of-sample backtest actually validated:
 *               +3R/50% WR on held-out data — cite that number, not the
 *               inflated full-sample +13R one, if asked how this performs).
 *  - RESOLVED — the trade actually hit its stop or target. Added 2026-08-10
 *               after the first live session (2026-08-10) produced a real
 *               winning trigger that never got a follow-up alert — this
 *               poller detected the entry but had no mechanism to notice
 *               the outcome. Fix works by re-running the SAME
 *               runRebalanceBacktest() call every tick against the latest
 *               live bars: scoreTrade() inside it already walks forward
 *               through whatever bars it's given looking for a stop/target
 *               hit, so on each subsequent tick — with more real bars now
 *               available after the trigger — the SAME trade key
 *               progressively resolves from "OPEN" to STOP/TARGET on its
 *               own. No separate tracking logic was needed, just actually
 *               reading that field on every tick instead of only once.
 *
 * Known gap, stated plainly: the ES1! cross-market alignment check that's
 * on by default in the deployed Pine script (i_checkES) is NOT applied
 * here yet — this poller alerts on the same logic the backtest validated
 * (which also didn't have historical ES data), not the full live gate.
 * Worth adding as a fast follow using the same getEs1mBars() feed
 * shadow-poller.mjs already uses for Chrome's SMT check.
 *
 * Live 1-minute bars (not the backtest's 3-minute fixture) — this actually
 * closes the single biggest fidelity gap the backtest report flagged.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getState, setTimeframe } from './src/core/chart.js';
import { getOhlcv, getQuote } from './src/core/data.js';
import { disconnect } from './src/connection.js';
import { sendEyesOnAlert, sendArmedAlert, sendResolutionAlert, sendSessionSummary } from './src/notify/discord.mjs';
import { runRebalanceBacktest, MANUAL_BREAKEVEN_POINTS } from './backtest/rebalance-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLL_INTERVAL_MS = 30_000;
const BAR_COUNT = 1400; // ~23hrs of 1-min bars — covers current session + prior-session ledge lookback + TPO bias window
const TARGET_R_MULTIPLE = 2.0; // matches deployed Pine script's default, validated OOS in reports/2026-08-08-rebalance-model-backtest.md

const SESSIONS_DIR = path.join(__dirname, 'sessions');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function todayKeyET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function nowET_HHMM() {
  return new Date().toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false }).slice(0, 5);
}
function isoNow() { return new Date().toISOString(); }

// Ported from shadow-poller.mjs 2026-08-12 — same double-conversion trick
// (treat the target as if it were UTC, format that instant back in ET, use
// the difference as the correction; self-corrects for DST since it uses the
// real offset at that moment). Needed here now too: launching an overnight
// session THIS evening with a same-day-style "11:30" cutoff would have the
// poller read current time as already past cutoff on its very first tick
// (plain HH:MM string comparison, no date awareness) and shut down
// immediately instead of running through to tomorrow morning.
function etDateTimeToEpochMs(dateStr, timeStr) {
  const naiveUtc = new Date(`${dateStr}T${timeStr}:00Z`);
  const etFormatted = naiveUtc.toLocaleString('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const [d, t] = etFormatted.split(', ');
  const [mm, dd, yyyy] = d.split('/');
  const asIfUtc = new Date(`${yyyy}-${mm}-${dd}T${t}Z`);
  const offsetMs = naiveUtc.getTime() - asIfUtc.getTime();
  return naiveUtc.getTime() + offsetMs;
}

// Cutoff arg supports two forms, same as shadow-poller.mjs:
//  - "HH:MM"              — same-day cutoff (original behavior)
//  - "YYYY-MM-DD HH:MM"   — absolute ET date+time, for a session that runs
//                            past midnight into the next calendar day
const cutoffArg = process.argv[2] || '16:00';
const absoluteMatch = cutoffArg.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/);
const CUTOFF_ET = absoluteMatch ? absoluteMatch[2] : cutoffArg;
const CUTOFF_EPOCH_MS = absoluteMatch ? etDateTimeToEpochMs(absoluteMatch[1], absoluteMatch[2]) : null;
const CUTOFF_LABEL = absoluteMatch ? `${absoluteMatch[1]} ${absoluteMatch[2]} ET` : `${CUTOFF_ET} ET (today)`;

const sessionDate = todayKeyET();
const LOG_PATH = path.join(SESSIONS_DIR, `${sessionDate}-rebalance.jsonl`);
const SUMMARY_PATH = path.join(SESSIONS_DIR, `${sessionDate}-rebalance-summary.json`);

function appendLog(obj) {
  fs.appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n');
}

const notifiedManip = new Set(); // `${dateStr}:${direction}` — EYES_ON tier
const notifiedTrigger = new Set(); // `${dateStr}:${direction}` — ARMED tier
const notifiedResolved = new Set(); // `${dateStr}:${direction}` — RESOLVED tier
const tradesByKey = new Map(); // `${dateStr}:${direction}` -> latest trade snapshot (outcome/resultR update tick to tick)

function isResolvedOutcome(outcome) {
  return outcome === 'STOP' || outcome === 'TARGET' || (typeof outcome === 'string' && outcome.startsWith('AMBIGUOUS'));
}

async function tick() {
  const state = await getState();
  const originalResolution = state.resolution;
  await setTimeframe({ timeframe: '1' });
  const ohlcv = await getOhlcv({ count: BAR_COUNT, summary: false });
  await setTimeframe({ timeframe: originalResolution });

  const bars = ohlcv.bars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));

  // 2026-08-12: same repaint guard as shadow-poller.mjs — getOhlcv's last
  // bar is whatever candle is still forming, and manip-leg wicks / rejection
  // triggers are pattern-detection off that candle's own shape, which can
  // still change before it closes. closedBars drops it for detection (bias
  // window, manip leg, trigger) and dailyLog — matches what the backtest
  // actually validated on closed historical bars. Once a trigger is
  // confirmed off a closed candle, its outcome (STOP/TARGET) is reported
  // from the full live-bar run instead: "did price cross this level" is a
  // fact the instant it happens, no reason to delay recognizing a fill
  // that's already occurred just because the current candle hasn't closed.
  const closedBars = bars.length > 1 ? bars.slice(0, -1) : bars;
  const opts = { targetMode: 'fixedR', fixedRMultiple: TARGET_R_MULTIPLE };
  const { trades: closedTrades, dailyLog } = runRebalanceBacktest(closedBars, opts);
  const { trades: liveTrades } = runRebalanceBacktest(bars, opts);
  const trades = closedTrades.map(ct => liveTrades.find(lt => lt.dateStr === ct.dateStr && lt.direction === ct.direction) || ct);

  const today = dailyLog[dailyLog.length - 1];
  const todayDate = today?.date;

  return { ts: isoNow(), etTime: nowET_HHMM(), today, todayDate, trades, price: bars[bars.length - 1]?.close };
}

async function main() {
  console.log(`Rebalance poller starting. Session date (ET): ${sessionDate}. Cutoff: ${CUTOFF_LABEL}.`);
  console.log(`Log: ${LOG_PATH}`);
  console.log(`Summary: ${SUMMARY_PATH}`);
  console.log(`Target: fixed ${TARGET_R_MULTIPLE}R (matches deployed chart indicator). ES1! cross-check NOT applied yet — known gap, see file header.`);
  appendLog({ event: 'START', ts: isoNow(), etTime: nowET_HHMM(), cutoff: CUTOFF_ET, pollIntervalMs: POLL_INTERVAL_MS });

  while (true) {
    const hhmm = nowET_HHMM();
    // Same fix as shadow-poller.mjs's cutoffReached: an absolute date+time
    // cutoff must compare real epoch time, not just today's HH:MM string —
    // otherwise a session launched in the evening for an overnight run
    // would read "20:xx" as already past an "11:30" cutoff and stop
    // instantly on its first tick.
    const cutoffReached = CUTOFF_EPOCH_MS != null ? Date.now() >= CUTOFF_EPOCH_MS : hhmm >= CUTOFF_ET;
    if (cutoffReached) {
      appendLog({ event: 'STOP', ts: isoNow(), etTime: hhmm, reason: 'cutoff reached' });
      console.log(`Cutoff (${CUTOFF_LABEL}) reached at ${hhmm} ET. Stopping.`);
      const finalTrades = [...tradesByKey.values()];
      const resolved = finalTrades.filter(t => isResolvedOutcome(t.outcome));
      const cumulativeR = resolved.reduce((s, t) => s + (t.resultR || 0), 0);
      await sendSessionSummary({
        sessionDate, armedCount: finalTrades.length, gatePassCount: finalTrades.length, filledCount: resolved.length,
        cumulativeR: +cumulativeR.toFixed(2),
        notes: `Rebalance Model session ended ${hhmm} ET (cutoff ${CUTOFF_LABEL}). ${finalTrades.length} trigger(s) fired today, ${resolved.length} resolved.`,
      }).catch(() => {});
      break;
    }

    try {
      const result = await tick();
      if (result.today) {
        const dateStr = result.todayDate;
        if (result.today.manipUp && !notifiedManip.has(`${dateStr}:BULL`)) {
          notifiedManip.add(`${dateStr}:BULL`);
          sendEyesOnAlert({ model: "JJ's Sweep", direction: 'BULL', level: result.today.lowerLedge, distance: null, path: 'manipulation leg confirmed at upper ledge — watching lower ledge for rejection wick entry' }).catch(() => {});
        }
        if (result.today.manipDn && !notifiedManip.has(`${dateStr}:BEAR`)) {
          notifiedManip.add(`${dateStr}:BEAR`);
          sendEyesOnAlert({ model: "JJ's Sweep", direction: 'BEAR', level: result.today.upperLedge, distance: null, path: 'manipulation leg confirmed at lower ledge — watching upper ledge for rejection wick entry' }).catch(() => {});
        }
        for (const t of result.trades) {
          if (t.dateStr !== dateStr) continue; // only track today's triggers
          const key = `${t.dateStr}:${t.direction}`;
          tradesByKey.set(key, t); // always overwrite with the latest snapshot — outcome/resultR firm up as more live bars arrive

          if (!notifiedTrigger.has(key)) {
            notifiedTrigger.add(key);
            sendArmedAlert({
              model: "JJ's Sweep", direction: t.direction === 'LONG' ? 'BULL' : 'BEAR',
              path: 'ledge manipulation + rejection wick', grade: `bias-aligned ${t.direction}, fixed ${TARGET_R_MULTIPLE}R target`,
              plan: {
                entry: t.entry, stop: t.stop, tp1: t.target, tp2: null, riskPoints: t.risk, rr1: t.rewardR,
                breakevenAt: t.direction === 'LONG' ? t.entry + MANUAL_BREAKEVEN_POINTS : t.entry - MANUAL_BREAKEVEN_POINTS,
                breakevenPoints: MANUAL_BREAKEVEN_POINTS,
              },
            }).catch(() => {});
          }

          if (isResolvedOutcome(t.outcome) && !notifiedResolved.has(key)) {
            notifiedResolved.add(key);
            sendResolutionAlert({
              model: "JJ's Sweep", direction: t.direction === 'LONG' ? 'BULL' : 'BEAR',
              entry: t.entry, exit: t.outcome === 'STOP' ? t.stop : t.target,
              outcome: t.outcome, resultR: t.resultR,
            }).catch(() => {});
          }
        }
      }

      const allTriggers = [...tradesByKey.values()];
      appendLog({ event: 'SCAN', ts: result.ts, etTime: result.etTime, price: result.price, today: result.today, newTriggersToday: result.trades.filter(t => t.dateStr === result.todayDate) });
      fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ sessionDate, allTriggers, lastTick: result }, null, 2));

      console.log(`[${result.etTime} ET] price=${result.price} bias=${result.today?.bias || 'PENDING'} manipUp=${!!result.today?.manipUp} manipDn=${!!result.today?.manipDn} triggersToday=${allTriggers.length} resolved=${allTriggers.filter(t => isResolvedOutcome(t.outcome)).length}`);
    } catch (err) {
      appendLog({ event: 'ERROR', ts: isoNow(), etTime: nowET_HHMM(), error: err.message });
      console.error(`[${nowET_HHMM()} ET] ERROR: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  await disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('rebalance-poller fatal:', err.message);
  appendLog({ event: 'FATAL', ts: isoNow(), etTime: nowET_HHMM(), error: err.message });
  await disconnect();
  process.exit(1);
});
