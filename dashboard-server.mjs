#!/usr/bin/env node
// dashboard-server.mjs
//
// Read-only local web dashboard for the trading system. Serves a single
// page at http://localhost:3000 that polls GET /api/data every 30s.
//
// This process NEVER writes to any project file, never places or modifies
// an order, never starts/stops/signals a poller process — it only reads
// files already on disk (see dashboard-data.mjs) plus a `ps aux` check to
// report whether a poller happens to be running. Safe to leave open
// indefinitely alongside a live session.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getSessionStatusET, getPollerStatus, getHeaderTotals, getLiveSetups,
  getEquityAndJournal, getBreakdownStats, getAuditPanel, getSystemHealth, getGateAnalytics,
  getDailyDollarPnl, getLiveTradingSummary,
} from './dashboard-data.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.DASHBOARD_PORT || 3000;
const HTML_PATH = path.join(__dirname, 'dashboard.html');

async function buildPayload() {
  const liveSetups = getLiveSetups();
  const header = {
    price: liveSetups.noData ? { noData: true, reason: liveSetups.reason } : { value: liveSetups.price, etTime: liveSetups.etTime, source: liveSetups.sourceFile },
    sessionStatusET: getSessionStatusET(),
    poller: getPollerStatus(),
    totals: getHeaderTotals(),
    dailyDollarPnl: getDailyDollarPnl(),
  };
  return {
    generatedAt: new Date().toISOString(),
    header,
    liveSetups,
    equityAndJournal: getEquityAndJournal(),
    liveTrading: getLiveTradingSummary(),
    breakdown: getBreakdownStats(),
    audit: await getAuditPanel(),
    systemHealth: getSystemHealth(),
    gateAnalytics: getGateAnalytics(),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/data') {
      const payload = await buildPayload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      const html = fs.readFileSync(HTML_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Trading dashboard running at http://localhost:${PORT} (read-only, refreshes every 30s)`);
  console.log('Ctrl+C to stop. This process never modifies project files or touches any poller.');
});
