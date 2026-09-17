// Discord webhook notifications for shadow-poller.mjs. Two tiers per spec:
// EYES_ON (heads-up: model, direction, level) and ARMED (full plan:
// entry/stop/TP/grade/detection path), plus a session-end summary.
//
// Webhook URL lives in discord-config.json (gitignored, never in code) —
// copy discord-config.example.json and fill in webhookUrl. If the config
// file is missing or the URL is blank, every send is a silent no-op (logged
// once at startup, not on every tick) so the poller runs fine without it.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', '..', 'discord-config.json');

let webhookUrl = null;
let alertWindow = null;
let warnedOnce = false;
let warnedWindowOnce = false;

// 2026-07-26 fix: nothing previously gated WHEN a signal alert could fire —
// confirmed live, alerts went out at 9:20-9:34 PM during an overnight
// session. Default is the spec's NY AM window; override per-field in
// discord-config.json (e.g. {"alertWindow": {"start": "09:30", "end": "16:00"}})
// if JJ wants a wider or different window on a given day. Session summaries
// are NOT gated by this — an end-of-run wrap-up is fine whenever the
// session actually ends, it's not a "signal."
const DEFAULT_ALERT_WINDOW = { start: '09:30', end: '11:30' };

function loadAlertWindow() {
  if (alertWindow !== null) return alertWindow;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    alertWindow = (cfg.alertWindow && cfg.alertWindow.start && cfg.alertWindow.end) ? cfg.alertWindow : DEFAULT_ALERT_WINDOW;
  } catch {
    alertWindow = DEFAULT_ALERT_WINDOW;
  }
  return alertWindow;
}

function withinAlertWindow() {
  const { start, end } = loadAlertWindow();
  const hhmm = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false }).slice(0, 5);
  return hhmm >= start && hhmm <= end;
}

// 2026-09-02: JJ's complaint, verbatim — a busy/choppy session (20 Chrome
// candidates in one day, 5 never filled) meant shadow-poller.mjs's unfilled-
// plan CANCELLED alerts (added 2026-08-23 for a real but narrower reason —
// "don't leave me guessing which alert is still live") ended up dominating
// his Discord feed: "all I got is cancelled, cancelled, cancelled... never
// actual trades." Default flipped to OFF here. This does NOT touch
// topstep-live-poller.mjs's own sendCancelledAlert calls (daily-cap halts,
// declined-trade notices) — those are a different alert in substance (a
// real-money-relevant event, not "a paper prospect fizzled before filling")
// and stay on unconditionally; this gate only wraps shadow-poller.mjs's
// unfilled-plan cancel loop. cancelledPlans still gets written to the local
// JSONL log either way (shadow-poller.mjs's own appendLog call, independent
// of this) — nothing is lost, it just stops pushing to Discord by default.
// Flip discord-config.json's `unfilledCancelledAlerts: true` to restore it.
let unfilledCancelledAlertsEnabled = null;
export function shouldSendUnfilledCancelledAlert() {
  if (unfilledCancelledAlertsEnabled !== null) return unfilledCancelledAlertsEnabled;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    unfilledCancelledAlertsEnabled = cfg.unfilledCancelledAlerts === true;
  } catch {
    unfilledCancelledAlertsEnabled = false;
  }
  return unfilledCancelledAlertsEnabled;
}

// 2026-07-26: was a hard pause after backwards stops, absurdly tight
// (1.25-4.25pt) stops, duplicate ARMED alerts, and overnight alerts outside
// the intended session window all made it to Discord. All four root-caused,
// fixed, and re-verified (regression suite passes byte-identical; the
// 26-day extended backtest landed exactly back on the original pre-#7
// numbers) — see EVOLUTION.md same date and PROPOSALS.md #10 before
// touching this again.
const NOTIFICATIONS_PAUSED = false;

function loadWebhookUrl() {
  if (webhookUrl !== null) return webhookUrl; // already resolved (string or '')
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    webhookUrl = cfg.webhookUrl || '';
  } catch {
    webhookUrl = '';
  }
  if (!webhookUrl && !warnedOnce) {
    console.log('[discord] No webhook configured (discord-config.json missing or webhookUrl blank) — notifications disabled, poller continues normally.');
    warnedOnce = true;
  }
  return webhookUrl;
}

async function post(payload) {
  if (NOTIFICATIONS_PAUSED) {
    if (!warnedOnce) {
      console.log('[discord] NOTIFICATIONS_PAUSED is true (see EVOLUTION.md 2026-07-26) — all sends are no-ops until this is lifted.');
      warnedOnce = true;
    }
    return { sent: false, reason: 'notifications paused — see EVOLUTION.md 2026-07-26' };
  }
  const url = loadWebhookUrl();
  if (!url) return { sent: false, reason: 'no webhook configured' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.log(`[discord] webhook post failed: ${res.status} ${res.statusText}`);
      return { sent: false, reason: `HTTP ${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.log(`[discord] webhook post error: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

const DIRECTION_COLOR = { BEAR: 0xe03131, BULL: 0x2f9e44 };

// 2026-08-12: JJ asked for LONG/SHORT up front in every notification instead
// of having to translate BULL/BEAR (or Brian's occasional UNKNOWN, before a
// direction is confirmed) — this is the one place all three pollers' alerts
// funnel through, so it only needs to be mapped here.
function dirLabel(direction) {
  if (direction === 'BULL') return 'LONG';
  if (direction === 'BEAR') return 'SHORT';
  return direction || 'UNKNOWN';
}

export async function sendEyesOnAlert(candidate) {
  if (!withinAlertWindow()) {
    if (!warnedWindowOnce) {
      const w = loadAlertWindow();
      console.log(`[discord] Outside alert window (${w.start}-${w.end} ET) — signal alerts suppressed until then. Session summary still sends normally.`);
      warnedWindowOnce = true;
    }
    return { sent: false, reason: 'outside alert window' };
  }
  const color = DIRECTION_COLOR[candidate.direction] || 0x868e96;
  return post({
    embeds: [{
      title: `${dirLabel(candidate.direction)} — 👀 EYES ON (${candidate.model})`,
      color,
      fields: [
        { name: 'Level (0.705)', value: `${candidate.level}`, inline: true },
        { name: 'Distance', value: `${candidate.distance}pt`, inline: true },
        { name: 'Path', value: candidate.path || 'n/a', inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

export async function sendArmedAlert(candidate) {
  if (!withinAlertWindow()) {
    if (!warnedWindowOnce) {
      const w = loadAlertWindow();
      console.log(`[discord] Outside alert window (${w.start}-${w.end} ET) — signal alerts suppressed until then. Session summary still sends normally.`);
      warnedWindowOnce = true;
    }
    return { sent: false, reason: 'outside alert window' };
  }
  const color = DIRECTION_COLOR[candidate.direction] || 0x868e96;
  const p = candidate.plan;
  return post({
    embeds: [{
      title: `${dirLabel(candidate.direction)} — 🎯 ARMED (${candidate.model})`,
      color,
      fields: [
        { name: 'Entry', value: `${p.entry}`, inline: true },
        { name: 'Stop', value: `${p.stop} (${p.riskPoints}pt)`, inline: true },
        { name: 'TP1', value: `${p.tp1 ?? 'n/a'}`, inline: true },
        { name: 'TP2', value: `${p.tp2 ?? 'n/a'}`, inline: true },
        { name: 'RR1', value: `${p.rr1 ?? 'n/a'}`, inline: true },
        { name: 'Breakeven at', value: p.breakevenAt != null ? `${p.breakevenAt} (${p.breakevenPoints}pt)` : 'n/a', inline: true },
        { name: 'Detection path', value: candidate.path || 'n/a', inline: true },
        { name: 'Grade', value: candidate.grade || 'n/a', inline: false },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

// Trade resolution (stop hit / target hit) — NOT gated by the alert window,
// same reasoning as sendSessionSummary: if the entry alert already went out,
// the trader needs to know how it turned out regardless of what time that
// happens to resolve.
export async function sendResolutionAlert(candidate) {
  const win = candidate.resultR != null && candidate.resultR > 0;
  const color = win ? 0x2f9e44 : 0xe03131;
  const emoji = win ? '✅' : '🛑';
  return post({
    embeds: [{
      title: `${dirLabel(candidate.direction)} — ${emoji} ${candidate.outcome} (${candidate.model})`,
      color,
      fields: [
        { name: 'Entry', value: `${candidate.entry}`, inline: true },
        { name: 'Exit', value: `${candidate.exit}`, inline: true },
        { name: 'Result', value: `${candidate.resultR != null ? candidate.resultR + 'R' : 'n/a'}`, inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

// 2026-08-23: JJ asked for this — if a signal he was already told to take
// stops being one we'd still take (structure superseded or went stale)
// BEFORE he ever filled it, say so explicitly instead of leaving a stale
// ARMED alert sitting in his feed with no indication it's no longer live.
// NOT gated by the alert window, same reasoning as sendResolutionAlert: the
// entry alert already went out, so the correction needs to reach him
// regardless of what time that happens.
export async function sendCancelledAlert(candidate) {
  return post({
    embeds: [{
      title: `${dirLabel(candidate.direction)} — 🚫 CANCELLED (${candidate.model})`,
      color: 0x868e96,
      fields: [
        { name: 'Entry', value: `${candidate.entry}`, inline: true },
        { name: 'Stop', value: `${candidate.stop}`, inline: true },
        { name: 'Reason', value: candidate.reason || 'n/a', inline: false },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

export async function sendSessionSummary(summary) {
  const { sessionDate, armedCount, gatePassCount, filledCount, cumulativeR, notes } = summary;
  return post({
    embeds: [{
      title: `📋 Session summary — ${sessionDate}`,
      color: 0x1971c2,
      fields: [
        { name: 'ARMED', value: `${armedCount}`, inline: true },
        { name: 'Gate-passed', value: `${gatePassCount}`, inline: true },
        { name: 'Filled', value: `${filledCount}`, inline: true },
        { name: 'Cumulative R', value: `${cumulativeR}`, inline: true },
      ],
      description: notes || undefined,
      timestamp: new Date().toISOString(),
    }],
  });
}
