// dashboard-data.mjs
//
// All read-only data aggregation for dashboard-server.mjs. Every function
// here reads real files off disk and returns data traceable to a specific
// source path + its last-modified time. Nothing in this file writes to
// disk, touches a poller process (beyond reading `ps aux` to check whether
// one is running), or invents a number that isn't a direct computation over
// real logged data.
//
// HONESTY CONTRACT (2026-09-06, per JJ's own spec): if a section's source
// file is missing, return { noData: true, reason: '...' } instead of zeros
// or a fabricated value. This file has several such gaps, found and
// documented while building this — see each function's comment.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const EVOLUTION_PATH = path.join(__dirname, 'EVOLUTION.md');
const RULES_PATH = path.join(__dirname, 'rules.json');
const BASELINE_PATH = path.join(__dirname, 'backtest', 'baseline.json');
const REGRESSION_SESSIONS_PATH = path.join(__dirname, 'backtest', 'sessions.json');
const PROPOSALS_PATH = path.join(__dirname, 'PROPOSALS.md'); // does not exist as of 2026-09-06 — see note below
const REPORTS_DIR = path.join(__dirname, 'reports'); // does not exist as of 2026-09-06

function fileMeta(p) {
  try {
    const st = fs.statSync(p);
    return { exists: true, mtime: st.mtime.toISOString() };
  } catch {
    return { exists: false, mtime: null };
  }
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Timestamps in this project are NOT uniform: shadow-poller.mjs's
// first_armed_at/filled_at are ISO strings, but rebalance-engine.mjs's
// outcomeAt is a raw bar.time — epoch SECONDS (matches this whole project's
// convention, see etParts()/etTimeShort() everywhere). new Date(v) with a
// bare number always means milliseconds, so passing epoch-seconds straight
// in silently produces a 1970 timestamp — found and fixed while wiring the
// journal/equity sort below (Rebalance rows were sorting first, corrupting
// both the journal order and the equity curve's running total).
function toEpochMs(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; // <1e12 can't be a real ms timestamp post-2001; treat as seconds
  const d = new Date(v);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

// 2026-09-07: model display names were renamed ("Chrome" -> "JJ's Model")
// per JJ's request, but historical session files on disk still literally
// contain the OLD string (not rewritten — see EVOLUTION.md, same principle
// as never rewriting history there). This checks both so old and new data
// keep working identically in every model-scoped computation below.
function isJJsModel(modelStr) { return modelStr === 'Chrome' || modelStr === "JJ's Model"; }

function todayKeyET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function nowET_HHMM() {
  return new Date().toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false }).slice(0, 5);
}

// --- Every candidates.json / rebalance-summary.json file in sessions/ ---
function listSessionFiles(suffix) {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith(suffix))
    .map(f => path.join(SESSIONS_DIR, f))
    .sort();
}

// Loads every Chrome-model candidate record across every session file,
// tagged with its source date (from the filename) — the single shared
// dataset most of the sections below aggregate over.
function loadAllChromeRecords() {
  const files = listSessionFiles('-candidates.json');
  const records = [];
  for (const f of files) {
    const dateStr = path.basename(f).replace('-candidates.json', '');
    const data = readJSON(f);
    if (!Array.isArray(data)) continue;
    for (const r of data) records.push({ ...r, sessionDate: dateStr, sourceFile: f });
  }
  return { records, files };
}

function loadAllRebalanceRecords() {
  const files = listSessionFiles('-rebalance-summary.json');
  const records = [];
  for (const f of files) {
    const dateStr = path.basename(f).replace('-rebalance-summary.json', '');
    const data = readJSON(f);
    if (!data || !Array.isArray(data.allTriggers)) continue;
    for (const t of data.allTriggers) records.push({ ...t, sessionDate: dateStr, sourceFile: f, model: "JJ's Sweep" });
  }
  return { records, files };
}

// ============ 1. HEADER CARDS ============

export function getSessionStatusET() {
  const hhmm = nowET_HHMM();
  if (hhmm >= '18:00' || hhmm < '04:00') return 'Overnight (Globex)';
  if (hhmm < '09:30') return 'Pre-market';
  if (hhmm < '12:00') return 'NY AM';
  if (hhmm < '13:30') return 'Lunch';
  if (hhmm < '16:00') return 'PM';
  return 'Closed (daily maintenance halt)';
}

// Checks real running processes via `ps aux` (read-only inspection — never
// sends a signal, never starts/stops anything) and cross-references the
// most recent line of today's raw JSONL log for a genuine last-tick time.
export function getPollerStatus() {
  let psOut = '';
  try {
    psOut = execSync('ps aux', { encoding: 'utf8', timeout: 3000 });
  } catch {
    psOut = '';
  }
  const check = (needle) => psOut.split('\n').some(line => line.includes(needle) && !line.includes('grep'));

  const today = todayKeyET();
  function lastTickFor(logSuffix) {
    const p = path.join(SESSIONS_DIR, `${today}${logSuffix}`);
    if (!fs.existsSync(p)) return null;
    try {
      const content = fs.readFileSync(p, 'utf8').trimEnd();
      if (!content) return null;
      const lastLine = content.slice(content.lastIndexOf('\n') + 1);
      const obj = JSON.parse(lastLine);
      return { etTime: obj.etTime || null, ts: obj.ts || null, event: obj.event || null };
    } catch {
      return null;
    }
  }

  return {
    shadow: { running: check('shadow-poller.mjs'), lastTick: lastTickFor('.jsonl') },
    rebalance: { running: check('rebalance-poller.mjs'), lastTick: lastTickFor('-rebalance.jsonl') },
    topstepLive: { running: check('topstep-live-poller.mjs'), lastTick: lastTickFor('-topstep-live.jsonl') },
    checkedAt: new Date().toISOString(),
  };
}

export function getHeaderTotals() {
  const { records: chrome, files: chromeFiles } = loadAllChromeRecords();
  const { records: rebalance, files: rebalanceFiles } = loadAllRebalanceRecords();
  const files = [...chromeFiles, ...rebalanceFiles];
  if (files.length === 0) {
    return { noData: true, reason: 'No session files found in sessions/', sourceFiles: [] };
  }

  const resolved = [
    ...chrome.filter(r => r.resultR != null).map(r => ({ resultR: r.resultR, sessionDate: r.sessionDate, tsMs: toEpochMs(r.filled_at || r.first_armed_at || r.sessionDate) })),
    ...rebalance.filter(r => r.resultR != null).map(r => ({ resultR: r.resultR, sessionDate: r.sessionDate, tsMs: toEpochMs(r.outcomeAt) || toEpochMs(r.sessionDate) })),
  ].sort((a, b) => a.tsMs - b.tsMs);

  const totalScored = resolved.length;
  const cumulativeR = +resolved.reduce((s, r) => s + r.resultR, 0).toFixed(2);
  const wins = resolved.filter(r => r.resultR > 0).length;
  const winRate = totalScored > 0 ? +((wins / totalScored) * 100).toFixed(1) : null;

  let streak = 0, streakType = null;
  for (let i = resolved.length - 1; i >= 0; i--) {
    const isWin = resolved[i].resultR > 0;
    const kind = isWin ? 'win' : 'loss';
    if (streakType === null) { streakType = kind; streak = 1; }
    else if (kind === streakType) streak++;
    else break;
  }
  const streakLabel = streakType === 'loss' ? (streak > 1 ? 'losses' : 'loss') : (streak > 1 ? 'wins' : 'win');

  return {
    noData: false,
    totalScored, cumulativeR, winRate, currentStreak: streak > 0 ? `${streak} ${streakLabel}` : 'n/a',
    sourceFiles: files, lastUpdate: new Date().toISOString(),
  };
}

// NQ = $20/point (1 full-size contract, NOT the MNQ micro topstep-live-poller.mjs
// actually trades — this reflects the project's paper-trading convention used
// throughout every backtest/report so far, same "1 NQ" framing JJ has asked for
// P&L in every time so far). R is risk-normalized and doesn't convert to
// dollars on its own (a 32R trade might be a 3pt-risk trade that ran 96pts,
// not 32 literal points) — so this recomputes actual points per trade as
// riskPoints * resultR, which holds for every outcome type uniformly: STOP
// (resultR=-1 -> -riskPoints), BREAKEVEN (resultR=0 -> 0pt), TP1/TARGET
// (resultR=reward/risk -> the real reward in points). No synthetic
// assumptions — this is the same math the resultR field itself is defined by,
// just inverted back into points.
const NQ_POINT_VALUE = 20;

export function getDailyDollarPnl() {
  const { records: chrome, files: chromeFiles } = loadAllChromeRecords();
  const { records: rebalance, files: rebalanceFiles } = loadAllRebalanceRecords();
  const files = [...chromeFiles, ...rebalanceFiles];
  if (files.length === 0) return { noData: true, reason: 'No session files found in sessions/' };

  const trades = [
    ...chrome.filter(r => r.resultR != null && r.plan?.riskPoints != null)
      .map(r => ({ sessionDate: r.sessionDate, points: +(r.plan.riskPoints * r.resultR).toFixed(2), tsMs: toEpochMs(r.filled_at || r.first_armed_at || r.sessionDate) })),
    ...rebalance.filter(r => r.resultR != null && r.risk != null)
      .map(r => ({ sessionDate: r.sessionDate, points: +(r.risk * r.resultR).toFixed(2), tsMs: toEpochMs(r.outcomeAt) || toEpochMs(r.sessionDate) })),
  ].sort((a, b) => a.tsMs - b.tsMs);

  const byDay = new Map();
  for (const t of trades) {
    if (!byDay.has(t.sessionDate)) byDay.set(t.sessionDate, { trades: 0, points: 0 });
    const d = byDay.get(t.sessionDate);
    d.trades++;
    d.points += t.points;
  }
  const days = [...byDay.entries()].map(([date, d]) => ({
    date, trades: d.trades, points: +d.points.toFixed(2), dollars: +(d.points * NQ_POINT_VALUE).toFixed(2),
  })).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  const totalPoints = +trades.reduce((s, t) => s + t.points, 0).toFixed(2);
  const totalDollars = +(totalPoints * NQ_POINT_VALUE).toFixed(2);

  return {
    noData: false,
    pointValue: NQ_POINT_VALUE, days, totalPoints, totalDollars,
    sourceFiles: files, lastUpdate: new Date().toISOString(),
    note: 'Idealized fills — no commissions, fees, or slippage. 1 full-size NQ contract ($20/pt), not the MNQ topstep-live-poller.mjs actually trades live.',
  };
}

// ============ 2. LIVE SETUPS (latest scan) ============

export function getLiveSetups() {
  const today = todayKeyET();
  const p = path.join(SESSIONS_DIR, `${today}.jsonl`);
  if (!fs.existsSync(p)) {
    return { noData: true, reason: `No scan log for today (${today}) — sessions/${today}.jsonl does not exist. The paper poller likely hasn't run yet today.` };
  }
  let lastScan = null;
  try {
    const lines = fs.readFileSync(p, 'utf8').trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const obj = JSON.parse(lines[i]);
      if (obj.event === 'SCAN') { lastScan = obj; break; }
    }
  } catch (err) {
    return { noData: true, reason: `Failed to parse ${p}: ${err.message}` };
  }
  if (!lastScan) {
    return { noData: true, reason: `${p} exists but contains no SCAN events yet.` };
  }
  const ageMs = Date.now() - new Date(lastScan.ts).getTime();
  return {
    noData: false,
    stale: ageMs > 5 * 60 * 1000, // 5 min = ~10 missed 30s polls
    ageSeconds: Math.round(ageMs / 1000),
    price: lastScan.price,
    etTime: lastScan.etTime,
    candidates: lastScan.candidates || [],
    rejectedCandidates: lastScan.rejectedCandidates || [],
    sourceFile: p, lastUpdate: lastScan.ts,
  };
}

// ============ 3. EQUITY & RESULTS + JOURNAL ============

export function getEquityAndJournal() {
  const { records: chrome, files: chromeFiles } = loadAllChromeRecords();
  const { records: rebalance, files: rebalanceFiles } = loadAllRebalanceRecords();
  const files = [...chromeFiles, ...rebalanceFiles];
  if (files.length === 0) {
    return { noData: true, reason: 'No session files found in sessions/' };
  }

  const journal = [];
  for (const r of chrome) {
    journal.push({
      date: r.sessionDate, sessionType: 'live shadow', model: r.model, direction: r.direction,
      entry: r.plan?.entry ?? null, stop: r.plan?.stop ?? null, tp: r.plan?.tp1 ?? null,
      filled: !!r.filled, outcome: r.outcome, resultR: r.resultR, mfe: r.mfe, mae: r.mae,
      grade: r.grade, detectionPath: null, // joined in separately, see getGateAnalytics/path join note
      tsMs: toEpochMs(r.filled_at || r.first_armed_at || r.sessionDate),
    });
  }
  for (const r of rebalance) {
    journal.push({
      date: r.sessionDate, sessionType: 'live shadow', model: "JJ's Sweep", direction: r.direction,
      entry: r.entry, stop: r.stop, tp: r.target,
      filled: r.outcome !== 'OPEN (unresolved in available data)' && r.outcome != null, outcome: r.outcome, resultR: r.resultR, mfe: r.mfeR, mae: r.maeR,
      grade: null, detectionPath: null,
      tsMs: toEpochMs(r.outcomeAt) || toEpochMs(r.sessionDate),
    });
  }
  journal.sort((a, b) => a.tsMs - b.tsMs);

  let running = 0;
  const equityPoints = [];
  for (const j of journal) {
    if (j.resultR == null) continue;
    running += j.resultR;
    equityPoints.push({ seq: equityPoints.length + 1, date: j.date, cumR: +running.toFixed(2), sourceType: j.sessionType });
  }

  return {
    noData: false,
    journal, equityPoints,
    sourceFiles: files, lastUpdate: new Date().toISOString(),
    note: 'All rows currently sourced from live shadow-poller sessions — no backtest-run journal rows are persisted to disk in this schema (backtest/run-regression.mjs and run-extended-backtest.mjs only print console summaries; see the Audit panel for the latest backtest/regression numbers instead).',
  };
}

// ============ 4. BREAKDOWN STATS ============

// Recovers `path` (single-candle/grind) per Chrome candidate id by scanning
// the raw JSONL scan logs — NOT stored in the persisted *-candidates.json
// summary files (a real gap found while building this; the live poller's
// registry never carries `path` through to the summary it writes). Cheap
// enough to do fresh: session JSONLs are a few hundred KB to ~1MB each.
function recoverPathById() {
  const map = new Map();
  if (!fs.existsSync(SESSIONS_DIR)) return map;
  const jsonlFiles = fs.readdirSync(SESSIONS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  for (const f of jsonlFiles) {
    const full = path.join(SESSIONS_DIR, f);
    let lines;
    try { lines = fs.readFileSync(full, 'utf8').trimEnd().split('\n'); } catch { continue; }
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.event !== 'SCAN' || !Array.isArray(obj.candidates)) continue;
      for (const c of obj.candidates) {
        if (isJJsModel(c.model) && c.path && !map.has(c.id)) map.set(c.id, c.path);
      }
    }
  }
  return map;
}

function statsFor(items, keyFn) {
  const buckets = new Map();
  for (const it of items) {
    const key = keyFn(it);
    if (key == null) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it.resultR);
  }
  const rows = [];
  for (const [key, rs] of buckets) {
    const n = rs.length;
    const wins = rs.filter(r => r > 0).length;
    rows.push({
      key, n,
      winRate: +((wins / n) * 100).toFixed(1),
      avgR: +(rs.reduce((s, r) => s + r, 0) / n).toFixed(2),
      insufficientSample: n < 10,
    });
  }
  return rows.sort((a, b) => b.n - a.n);
}

export function getBreakdownStats() {
  const { records: chrome, files: chromeFiles } = loadAllChromeRecords();
  const { records: rebalance, files: rebalanceFiles } = loadAllRebalanceRecords();
  const files = [...chromeFiles, ...rebalanceFiles];
  if (files.length === 0) return { noData: true, reason: 'No session files found in sessions/' };

  const resolvedChrome = chrome.filter(r => r.resultR != null);
  const resolvedRebalance = rebalance.filter(r => r.resultR != null);
  // 2026-09-06 fix: byModel/bySessionType originally only ever saw Chrome
  // records (loadAllRebalanceRecords wasn't called in this function at
  // all) — found by screenshot-checking this section: "By Model" showed
  // only "Chrome", silently missing the 4 real resolved Rebalance trades.
  // Detection path / A+ overlap / re-arm are genuinely Chrome-only concepts
  // (Rebalance has neither), so those two stay scoped to resolvedChrome.
  const resolvedAll = [...resolvedChrome, ...resolvedRebalance];

  const pathById = recoverPathById();
  const withPath = resolvedChrome.map(r => ({ ...r, path: pathById.get(r.id) || null }));

  return {
    noData: false,
    byModel: statsFor(resolvedAll, r => r.model),
    byGrade: { noData: true, reason: "No A/B/C categorical grade exists in the data model — JJ's Model's `grade` field is a free-text description, not a letter grade. rules.json's own \"grading\" note flags the A/B/C boundary below A+ as an unresolved spec ambiguity (spec §8). Showing a fabricated A/B/C split would violate the no-synthetic-values rule." },
    byDetectionPath: statsFor(withPath.filter(r => r.path), r => r.path),
    byGapMatched: statsFor(resolvedChrome, r => (r.grade || '').includes('A+') ? "A+ overlap (JJ's Model + JJ's Rejection match)" : 'standalone'),
    bySessionType: statsFor(resolvedAll, () => 'live shadow'),
    byRearm: { noData: true, reason: 'Re-arm vs. first-attempt status is computed in-memory by shadow-poller.mjs during a live run but is never written to the persisted *-candidates.json summary — no way to recover it after the fact without re-running the session.' },
    sourceFiles: [...files, ...(fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl')).map(f => path.join(SESSIONS_DIR, f)) : [])],
    lastUpdate: new Date().toISOString(),
    note: "Detection path, A+ overlap, and re-arm breakdowns are JJ's Model-only concepts — JJ's Sweep trades are excluded from those three, but included in By Model and By Session Type.",
  };
}

// ============ 5. AUDIT PANEL ============

function bootstrapCI(values, iterations = 2000, alpha = 0.10) {
  if (values.length < 10) return null;
  const n = values.length;
  const means = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += values[Math.floor(Math.random() * n)];
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor((alpha / 2) * iterations)];
  const hi = means[Math.floor((1 - alpha / 2) * iterations)];
  return { lo: +lo.toFixed(3), hi: +hi.toFixed(3) };
}

export async function getAuditPanel() {
  const { records: chrome } = loadAllChromeRecords();
  const { records: rebalance } = loadAllRebalanceRecords();
  const resolved = [...chrome, ...rebalance].filter(r => r.resultR != null);
  const n = resolved.length;

  const winIndicator = resolved.map(r => (r.resultR > 0 ? 1 : 0));
  const rValues = resolved.map(r => r.resultR);
  const winRateCI = bootstrapCI(winIndicator);
  const avgRCI = bootstrapCI(rValues);

  // Live regression check: actually re-runs the frozen baseline sessions
  // through the CURRENT engine code right now, rather than just reading a
  // static file — genuinely "last walk-forward result," not a stale cache.
  let regression = { noData: true, reason: 'backtest/baseline.json or backtest/sessions.json not found.' };
  if (fs.existsSync(BASELINE_PATH) && fs.existsSync(REGRESSION_SESSIONS_PATH)) {
    try {
      const { runSession, loadBars } = await import('./backtest/engine.mjs');
      const baseline = readJSON(BASELINE_PATH);
      const { sessions } = readJSON(REGRESSION_SESSIONS_PATH);
      const results = [];
      for (const s of sessions) {
        const bars = loadBars(path.join(__dirname, 'backtest', s.fixture));
        const r = runSession(bars, s.label, s.dateStr, s.startHHMM, s.endHHMM);
        const armed = r.candidates.filter(c => c.state === 'ARMED');
        const scored = armed.filter(c => c.plan.passesStopGate && c.score);
        const cumulativeR = +scored.reduce((sum, c) => sum + (c.score.resultR || 0), 0).toFixed(2);
        const base = baseline.sessions?.[s.id];
        results.push({
          id: s.id, currentR: cumulativeR, baselineR: base?.cumulativeR ?? null,
          pass: base ? cumulativeR >= base.cumulativeR : null,
        });
      }
      regression = { noData: false, baselineWrittenAt: baseline.writtenAt, results, ranAt: new Date().toISOString() };
    } catch (err) {
      regression = { noData: true, reason: `Live regression re-run failed: ${err.message}` };
    }
  }

  let oneLiner;
  if (n === 0) oneLiner = 'Zero resolved trades logged — nothing can be concluded yet.';
  else if (n < 10) oneLiner = `Only ${n} resolved trades logged — far too few to draw any statistical conclusion; treat every number above as anecdote, not evidence.`;
  else if (n < 30) oneLiner = `${n} resolved trades — enough for a rough directional read, not enough to rule out variance. A single good or bad week can still swing these numbers a lot.`;
  else oneLiner = `${n} resolved trades — a reasonable sample for the win-rate/avg-R estimates below, though still nowhere near enough to detect small edges reliably.`;

  return {
    noData: false,
    n,
    holdoutSplit: { noData: true, reason: 'No holdout/train-test split methodology exists in this project — all backtest numbers to date are in-sample.' },
    winRateBootstrapCI: winRateCI ? { lo: +(winRateCI.lo * 100).toFixed(1), hi: +(winRateCI.hi * 100).toFixed(1) } : { noData: true, reason: `n=${n} < 10, insufficient sample for a bootstrap CI.` },
    avgRBootstrapCI: avgRCI || { noData: true, reason: `n=${n} < 10, insufficient sample for a bootstrap CI.` },
    lastWalkForward: regression,
    oneLiner,
    lastUpdate: new Date().toISOString(),
  };
}

// ============ 6. SYSTEM HEALTH & CHANGE LOG ============

export function getSystemHealth() {
  const evoMeta = fileMeta(EVOLUTION_PATH);
  let entries = [];
  if (evoMeta.exists) {
    const text = fs.readFileSync(EVOLUTION_PATH, 'utf8');
    const matches = [...text.matchAll(/^## (\d{4}-\d{2}-\d{2}) — (.+)$/gm)];
    entries = matches.map(m => ({ date: m[1], title: m[2] })).slice(-10).reverse();
  }

  const rulesMeta = fileMeta(RULES_PATH);
  const rules = rulesMeta.exists ? readJSON(RULES_PATH) : null;

  return {
    evolutionLog: evoMeta.exists ? { noData: false, entries, sourceFile: EVOLUTION_PATH, lastUpdate: evoMeta.mtime } : { noData: true, reason: 'EVOLUTION.md not found.' },
    proposals: fs.existsSync(PROPOSALS_PATH)
      ? { noData: false, sourceFile: PROPOSALS_PATH }
      : { noData: true, reason: 'PROPOSALS.md does not exist in this project (checked 2026-09-06) — despite being referenced repeatedly throughout EVOLUTION.md\'s history as the place open proposals get tracked. Either it was removed at some point or never committed.' },
    knownLimitations: rules?.notes
      ? { noData: false, text: rules.notes, sourceFile: RULES_PATH, lastUpdate: rulesMeta.mtime }
      : { noData: true, reason: 'rules.json not found or has no `notes` field.' },
  };
}

// ============ 7. GATE ANALYTICS (funnel) ============

export function getGateAnalytics() {
  if (!fs.existsSync(SESSIONS_DIR)) return { noData: true, reason: 'sessions/ directory not found.' };
  const jsonlFiles = fs.readdirSync(SESSIONS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  if (jsonlFiles.length === 0) return { noData: true, reason: 'No raw session JSONL logs found in sessions/.' };

  const counts = {
    'No CISD found': 0,
    'Expired/stale anchor': 0,
    'No tap (not yet in OTE proximity)': 0,
    'In proximity, no inversion confirmation yet': 0,
    'Rejected: stop exceeds max risk': 0,
    'Rejected: stop under minimum': 0,
    'Rejected: backwards stop': 0,
    'Passed all gates': 0,
  };
  let totalTicks = 0;

  for (const f of jsonlFiles) {
    const full = path.join(SESSIONS_DIR, f);
    let lines;
    try { lines = fs.readFileSync(full, 'utf8').trimEnd().split('\n'); } catch { continue; }
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.event !== 'SCAN') continue;
      totalTicks++;
      for (const c of (obj.candidates || [])) {
        if (!isJJsModel(c.model)) continue;
        if (c.expiredAnchor) { counts['Expired/stale anchor']++; continue; }
        if (c.grade && (c.grade.includes('no Chrome-CISD found') || c.grade.includes('no CISD found'))) { counts['No CISD found']++; continue; }
        if (c.state === 'WATCHING') { counts['No tap (not yet in OTE proximity)']++; continue; }
        if (c.state === 'EYES_ON') { counts['In proximity, no inversion confirmation yet']++; continue; }
        if (c.state === 'ARMED' && c.planStatus && c.planStatus.startsWith('REJECTED')) {
          if (c.planStatus.includes('exceeds max risk')) counts['Rejected: stop exceeds max risk']++;
          else if (c.planStatus.includes('under') && c.planStatus.includes('minimum')) counts['Rejected: stop under minimum']++;
          else if (c.planStatus.includes('wrong side')) counts['Rejected: backwards stop']++;
          continue;
        }
        if (c.state === 'ARMED' && c.plan) { counts['Passed all gates']++; }
      }
    }
  }

  return {
    noData: false,
    counts, totalTicks,
    sourceFiles: jsonlFiles.map(f => path.join(SESSIONS_DIR, f)),
    lastUpdate: new Date().toISOString(),
    note: '"Zone used / re-arm exclusion" is a real internal state (usedIfvgKeys) but is never distinctly logged as its own rejection reason — folded into whichever bucket above the candidate would otherwise land in. Not broken out separately here rather than estimated.',
  };
}

// ============ 8. LIVE TRADING (real money, current eval) ============

// NQ = $20/point (topstep-live-poller.mjs trades full-size NQ as of
// 2026-09-06 — see EVOLUTION.md). Points realized are computed from
// exitPrice vs. the REAL average fill price (realEntry), not from the
// planned riskPoints — a real fill can differ from the plan (limit-order
// price improvement, stop slippage), confirmed live multiple times.
const NQ_POINT_VALUE_LIVE = 20;

export function getLiveTradingSummary() {
  const files = listSessionFiles('-topstep-live-candidates.json');
  if (files.length === 0) {
    return { noData: true, reason: 'No sessions/*-topstep-live-candidates.json files found — no real live trade has been placed yet, or topstep-live-poller.mjs predates this summary mechanism (added 2026-09-08).' };
  }
  const trades = [];
  for (const f of files) {
    const dateStr = path.basename(f).replace('-topstep-live-candidates.json', '');
    const data = readJSON(f);
    if (!Array.isArray(data)) continue;
    for (const r of data) trades.push({ ...r, sessionDate: dateStr, sourceFile: f });
  }
  trades.sort((a, b) => toEpochMs(a.armed_at) - toEpochMs(b.armed_at));

  const rows = trades.map(t => {
    const isBear = t.direction === 'BEAR';
    let points = 0;
    if (t.filled && t.exitPrice != null && t.realEntry != null) {
      points = isBear ? (t.realEntry - t.exitPrice) : (t.exitPrice - t.realEntry);
    }
    // 2026-09-17 fix: this always multiplied by 1 contract implicitly (just
    // NQ_POINT_VALUE_LIVE, no size factor) — silently wrong since 2026-09-16
    // when the poller went to a fixed size of 3, and would have been
    // meaningless once sizing went dollar-risk-normalized the same day.
    // `size` is only present on trades placed after that fix (2026-09-17);
    // older records fall back to 1, their real, actual size at the time.
    const size = t.size ?? 1;
    return {
      sessionDate: t.sessionDate, orderId: t.orderId, direction: t.direction,
      plan: t.plan, realEntry: t.realEntry, filled: t.filled, outcome: t.outcome,
      resultR: t.resultR, exitPrice: t.exitPrice, points: +points.toFixed(2), size,
      dollars: +(points * NQ_POINT_VALUE_LIVE * size).toFixed(2),
      backfilled: !!t.backfilled, backfillNote: t.backfillNote || null,
      armed_at: t.armed_at, closed_at: t.closed_at,
    };
  });

  const resolved = rows.filter(r => r.filled && r.outcome && !r.outcome.startsWith('CANCELLED'));
  const totalPoints = +resolved.reduce((s, r) => s + r.points, 0).toFixed(2);
  const totalDollars = +(totalPoints * NQ_POINT_VALUE_LIVE).toFixed(2);
  const wins = resolved.filter(r => r.points > 0).length;

  return {
    noData: false,
    rows, resolvedCount: resolved.length, totalTrades: rows.length,
    winRate: resolved.length ? +((wins / resolved.length) * 100).toFixed(1) : null,
    totalPoints, totalDollars,
    sourceFiles: files, lastUpdate: new Date().toISOString(),
    note: 'Dollar figures are computed from resolved trades\' real fill/exit prices at $20/pt (full-size NQ) — this is NOT a live account-balance query (dashboard-server.mjs stays read-only/file-based, no API calls), so commissions/fees are not included here. Rows marked "backfilled" were reconciled by hand against real TopstepX order history because the raw local log predates the automatic summary mechanism (2026-09-08) or was affected by a since-fixed tracking bug — see each row\'s backfillNote.',
  };
}
