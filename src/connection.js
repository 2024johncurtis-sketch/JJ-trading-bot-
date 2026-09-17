import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return client;
    } catch {
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

export async function connect() {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget();
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

// 2026-07-23: URL matching alone isn't reliable in every TradingView Desktop
// session — real chart tabs can report blank/generic URLs over CDP (no
// "tradingview.com/chart" to match), while non-chart pages (the outer
// window shell, "New tab", a profile page) DO have matchable URLs. A stale
// reconnect used to silently land on one of those instead, leaving the tool
// pointed at a page with no live chart API at all (see PROPOSALS.md #6 /
// EVOLUTION.md 2026-07-23 for how this was found). Now each page target is
// probed directly for the live chart API before being trusted; URL matching
// is kept only as a last-resort fallback if no probe succeeds (e.g. CDP
// permissions prevent the probe itself).
// Reserved for src/core/smt-feed.js's dedicated SMT-only tab (PROPOSALS.md
// #6) — never the tab this shared connection should attach to, even though
// it's a perfectly valid, live chart. If it's ever the ONLY valid chart tab
// found, it's still used as a last resort (better than nothing).
const RESERVED_SECONDARY_SYMBOLS = ['CME_MINI:ES1!'];

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const pageTargets = targets.filter(t => t.type === 'page');

  let firstValid = null;
  for (const t of pageTargets) {
    let probe;
    try {
      probe = await CDP({ host: CDP_HOST, port: CDP_PORT, target: t.id });
      const symbol = await probe.Runtime.evaluate({
        expression: `(function() {
          try {
            var w = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV && window.TradingViewApi._activeChartWidgetWV.value();
            return (w && typeof w.symbol === 'function') ? (w.symbol() || null) : null;
          } catch (e) { return null; }
        })()`,
        returnByValue: true,
      }).then(r => r.result?.value);
      if (symbol) {
        if (!firstValid) firstValid = t;
        if (!RESERVED_SECONDARY_SYMBOLS.includes(symbol)) return t;
      }
    } catch {
      // not evaluable, closed mid-probe, or CDP refused attachment — skip it
    } finally {
      if (probe) { try { await probe.close(); } catch {} }
    }
  }
  if (firstValid) return firstValid; // only reserved-symbol tabs were live — use one anyway rather than fail

  // Fallback: old URL-based heuristic, kept for environments where the
  // probe above can't run at all.
  return pageTargets.find(t => /tradingview\.com\/chart/i.test(t.url))
    || pageTargets.find(t => /tradingview/i.test(t.url))
    || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
