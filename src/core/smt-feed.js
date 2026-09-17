/**
 * PROPOSALS.md #6: live ES1! feed for computeSMT (scan-chart.mjs).
 *
 * 2026-07-23 redesign: the original version opened/closed a new tab on every
 * refresh via a keyboard shortcut (Cmd+T) and identified it by URL matching.
 * Live-tested, that broke the shared connection.js singleton's lock on the
 * real chart tab (URL matching landed on the wrong target after reconnect —
 * see PROPOSALS.md #6 for the full incident writeup) — a real, not
 * hypothetical, failure mode.
 *
 * This version does no tab creation, closing, activation, or keyboard
 * shortcuts at all. JJ keeps a second tab open on CME_MINI:ES1! alongside
 * his NQ chart; this module finds it by directly probing each open page
 * target for that exact symbol (same probe technique connection.js's
 * findChartTarget() now uses), reads its bars over its own temporary CDP
 * connection, and closes only that CDP *client* object — never the tab
 * itself. If the ES1! tab isn't open, this just returns null: SMT is
 * confluence-only per spec §1.4 (never gates), so its absence is always a
 * safe, already-expected state, not an error condition.
 */
import CDP from 'chrome-remote-interface';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const ES1_SYMBOL = 'CME_MINI:ES1!';
const REFRESH_MS = 20 * 60 * 1000; // 15-30min cadence — SMT only needs recent swing structure, not tick precision

let cache = { bars: null, fetchedAt: 0 };
let inFlight = null;
let warnedNotFound = false;

async function evalOn(client, expression) {
  const result = await client.Runtime.evaluate({ expression, returnByValue: true });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation error';
    throw new Error(msg);
  }
  return result.result?.value;
}

async function findEs1Tab() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  for (const t of targets.filter(t => t.type === 'page')) {
    let probe;
    try {
      probe = await CDP({ host: CDP_HOST, port: CDP_PORT, target: t.id });
      const symbol = await evalOn(probe, `
        (function() {
          try {
            var w = window.TradingViewApi._activeChartWidgetWV.value();
            return w.symbol();
          } catch (e) { return null; }
        })()
      `);
      if (symbol === ES1_SYMBOL) return t;
    } catch {
      // not evaluable / closed mid-probe — skip
    } finally {
      if (probe) { try { await probe.close(); } catch {} }
    }
  }
  return null;
}

async function fetchEs1mBars(count) {
  const tab = await findEs1Tab();
  if (!tab) {
    if (!warnedNotFound) {
      console.log(`[smt-feed] No open tab found on ${ES1_SYMBOL} — SMT unavailable until one is open. This never blocks or affects trade decisions.`);
      warnedNotFound = true;
    }
    return null;
  }
  warnedNotFound = false;

  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: tab.id });
  try {
    const data = await evalOn(client, `
      (function() {
        var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - ${count} + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
        }
        return result;
      })()
    `);
    if (!data || data.length === 0) throw new Error('ES1! bar extraction returned nothing');
    return data;
  } finally {
    try { await client.close(); } catch {}
    // Only the CDP client is closed here — the tab itself is never touched.
  }
}

/**
 * Returns cached ES1! bars, refreshing (by reading JJ's already-open ES1!
 * tab) only if the cache is older than REFRESH_MS. Never throws — returns
 * the last good cache (or null) on any failure, since SMT must never be
 * able to affect the poll loop.
 */
export async function getEs1mBars(count = 300) {
  const now = Date.now();
  if (cache.bars && (now - cache.fetchedAt) < REFRESH_MS) return cache.bars;
  if (inFlight) return inFlight.then(() => cache.bars).catch(() => cache.bars);

  inFlight = fetchEs1mBars(count)
    .then((bars) => {
      if (bars) cache = { bars, fetchedAt: Date.now() };
      return cache.bars;
    })
    .catch((err) => {
      console.log(`[smt-feed] ES1! read failed (${err.message}) — ${cache.bars ? 'using last cached bars' : 'no cache yet, SMT unavailable this tick'}.`);
      return cache.bars;
    })
    .finally(() => { inFlight = null; });

  return inFlight;
}
