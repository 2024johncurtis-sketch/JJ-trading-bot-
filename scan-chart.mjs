#!/usr/bin/env node
/**
 * scan-chart.mjs
 *
 * Reads the live TradingView chart via CDP (reusing tradingview-mcp-jackson's own
 * core modules), parses indicator labels into strategy-spec.md §1 objects, and
 * reports candidate setups for the Chrome and Brian's models with a §6-style state
 * (capped at WATCHING / EYES_ON / ARMED / NO TRADE — a passive read can't observe
 * fills, so PENDING/IN_TRADE/CLOSED aren't reportable from a scan).
 *
 * Design decisions locked in for this version (see conversation, not re-derived here):
 *  - ScriVindicator's native "OTE Bull"/"OTE Bear" labels ARE the Chrome-model OTE
 *    zone. No independent fib/candle computation is done in this version.
 *  - Liquidity Zone Detector is excluded entirely — its price values don't match
 *    NQ's trading range.
 *  - ICT Killzones & Pivots [TFO] can't be read via labels/lines/boxes/tables/study
 *    values — session windows below are hardcoded ICT-convention constants, display
 *    only, not read live and not yet used to gate anything.
 *  - SMT (ES1! divergence) is NOT implemented here — spec 1.4 says it's always
 *    optional/supporting, never a gate, so its absence doesn't invalidate a call.
 *  - Bryan's Indicator (foundation) commonly appears as 2+ instances on this chart,
 *    sometimes with identical configs (see README notes). This script dedupes by
 *    comparing each returned label block's content rather than trusting entity-ID
 *    ordering, since data_get_pine_labels doesn't expose a per-study entity ID.
 */

import { getState, setTimeframe } from './src/core/chart.js';
import { getQuote, getPineLabels, getOhlcv } from './src/core/data.js';
import { evaluate, disconnect } from './src/connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

// Hardcoded because ICT Killzones & Pivots [TFO] can't be read via the MCP.
// Approximate ICT-convention windows, America/New_York. Display context only.
const SESSION_WINDOWS_ET = [
  { name: 'Asia', start: '20:00', end: '23:59' },
  { name: 'London', start: '02:00', end: '05:00' },
  { name: 'NY AM', start: '08:30', end: '11:00' },
  { name: 'NY Lunch', start: '12:00', end: '13:30' },
  { name: 'NY PM', start: '13:30', end: '16:00' },
];

export function currentSessionET() {
  const now = new Date();
  const et = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
  const hm = et.slice(0, 5);
  for (const w of SESSION_WINDOWS_ET) {
    if (hm >= w.start && hm <= w.end) return `${w.name} (${hm} ET)`;
  }
  return `outside marked windows (${hm} ET)`;
}

// --- Study title lookup (read-only), to explain duplicate instances honestly ---
export async function getStudyTitles(ids) {
  const idsJson = JSON.stringify(ids);
  const expr = `
    (function() {
      var chart = ${CHART_API};
      var ids = ${idsJson};
      var out = {};
      ids.forEach(function(id) {
        var study = chart.getStudyById(id);
        out[id] = (study && study.title) ? study.title() : null;
      });
      return out;
    })()
  `;
  return evaluate(expr);
}

// --- Label parsing into spec §1 objects ---

// Bryan's Indicator (foundation) label patterns
const BRYAN_PATTERNS = [
  { re: /^(\d+)(M|HR)\s+CISD\s+(A\+\+|A\+|A)\s*RB$/i, type: 'CISD_RB' },      // e.g. "5M CISD A+ RB"
  { re: /^(\d+)(M|HR)\s+CISD\s*(?:×(\d+))?$/i, type: 'CISD' },                // e.g. "15M CISD ×1"
  { re: /^(\d+)(M|HR)\s+(A\+\+|A\+|A)\s+RB$/i, type: 'RB' },                  // e.g. "15M A+ RB"
  { re: /^(\d+)(M|HR)\s+FVG$/i, type: 'FVG' },                                // e.g. "5M FVG"
  { re: /^(MIDNIGHT|10AM)$/i, type: 'SESSION' },
  { re: /^NWOG$/i, type: 'UNKNOWN' },                                        // surfaced per spec §8, not silently resolved
];

// ScriVindicator label patterns
const SCRIV_PATTERNS = [
  { re: /^OTE\s+(Bull|Bear)$/i, type: 'OTE' },
  { re: /^IFVG\s+(\d+)(m|h)$/i, type: 'IFVG' },
  { re: /^FVG\s+(\d+)(m|h)$/i, type: 'FVG' },
  { re: /^RB\s+(\d+)(m|h)$/i, type: 'RB' },
  { re: /^(\d+)(m|h)\s+A\s+(-[\d.]+)(?:\s*x(\d+))?$/i, type: 'SD_EXTENSION' }, // spec §2.2, OFF by default — kept for context only
];

export function parseBryanLabel(text, price) {
  for (const p of BRYAN_PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;
    if (p.type === 'SESSION') return { source: 'bryan', type: 'SESSION', text, price };
    if (p.type === 'UNKNOWN') return { source: 'bryan', type: 'UNKNOWN', text, price };
    const tf = `${m[1]}${m[2]}`.toUpperCase();
    if (p.type === 'CISD_RB') return { source: 'bryan', type: 'CISD_RB', tf, grade: m[3].toUpperCase(), text, price };
    if (p.type === 'CISD') return { source: 'bryan', type: 'CISD', tf, count: m[3] ? Number(m[3]) : 1, text, price };
    if (p.type === 'RB') return { source: 'bryan', type: 'RB', tf, grade: m[3].toUpperCase(), text, price };
    if (p.type === 'FVG') return { source: 'bryan', type: 'FVG', tf, text, price };
  }
  return { source: 'bryan', type: 'UNPARSED', text, price };
}

export function parseScrivLabel(text, price) {
  for (const p of SCRIV_PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;
    if (p.type === 'OTE') return { source: 'scriv', type: 'OTE', direction: m[1].toUpperCase(), text, price };
    if (p.type === 'IFVG') return { source: 'scriv', type: 'IFVG', tf: `${m[1]}${m[2]}`.toUpperCase(), text, price };
    if (p.type === 'FVG') return { source: 'scriv', type: 'FVG', tf: `${m[1]}${m[2]}`.toUpperCase(), text, price };
    if (p.type === 'RB') return { source: 'scriv', type: 'RB', tf: `${m[1]}${m[2]}`.toUpperCase(), text, price };
    if (p.type === 'SD_EXTENSION') return { source: 'scriv', type: 'SD_EXTENSION', tf: `${m[1]}${m[2]}`.toUpperCase(), level: m[3], count: m[4] ? Number(m[4]) : 1, text, price };
  }
  return { source: 'scriv', type: 'UNPARSED', text, price };
}

// --- Dedup Bryan's instances by content equality (see header note) ---
// Handles the exact-duplicate-instance case (e.g. e48KnA == tc3VFM).
export function dedupBryanBlocks(blocks) {
  const seen = new Set();
  const unique = [];
  for (const b of blocks) {
    const key = JSON.stringify(b.labels);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(b);
  }
  return unique;
}

// Handles the SECOND, distinct dedup problem: two genuinely different-config
// instances (e.g. 15m/1h/4h-primary vs 5m/1h/15m-primary) still independently
// draw identical objects for timeframes both configs share (1HR, 4HR, session
// markers) since those don't depend on which lower TF is "primary." Dedup by
// parsed-object identity (type+tf+grade/count+price), not by block.
export function dedupParsedObjects(objects) {
  const seen = new Set();
  const unique = [];
  for (const o of objects) {
    const key = JSON.stringify([o.type, o.tf, o.grade ?? o.count ?? null, o.price]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(o);
  }
  return unique;
}

// --- Precision: NQ ticks in 0.25 increments. Round every level WE compute
// (never re-round raw indicator-reported label prices — those are the source
// of truth as reported, shown as-is for honest comparison). ---
export const TICK = 0.25;
export function roundToTick(price) {
  return Math.round(price / TICK) * TICK;
}
export function fmtTick(n) {
  return roundToTick(n).toFixed(2);
}
export function etTime(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// --- Chrome-CISD detection, spec §1.3 (loose definition) ---
// "after a series of same-direction candles/wicks, a candle with a large body
// closes beyond the recent lows/highs." That sentence actually describes TWO
// patterns: (a) one large-body candle doing the breaking — the original
// single-candle path below — or (b) the "series of same-direction candles"
// itself accumulating enough displacement to break structure, with no single
// candle required — the grind path, added after the 2026-07-16/17 backtest
// found real 87-127pt swings the single-candle path never fired on (see
// reports/2026-07-17-backtest.md "Offered vs caught"). Neither numeric
// formula is in the spec — both are documented heuristic thresholds, tuned
// against that backtest, not spec values. Both paths run on every
// evaluation; detectChromeCISD returns whichever produced the MORE RECENT
// cisdBar and tags which one via `.path`, so live/backtest logs can score
// the two paths separately (see reports/SCOREBOARD.md).
const LARGE_BODY_MULT = 1.5;       // candidate body must be >= this * avg body size in the search window
const CONSOLIDATION_LOOKBACK = 10; // bars immediately before a candidate CISD bar, treated as "the wicks it broke"
const CISD_SEARCH_BARS = 300;      // hard cap on how far back to search (all getOhlcv returns) — a safety bound, not the anchor window itself

// Fit against reports/2026-07-17-backtest.md's own missed-swing list: catches
// 7/16's 10:18 BEAR (103pt), 10:24 BULL (90pt), 10:45 BEAR, 11:03 BEAR legs
// and 7/17's 09:45 BULL (the recovery's start — 15 min before the
// single-candle path found it), 10:27 BEAR, 10:33 BULL legs — while leaving
// 7/16's smallest, marginal 52.5pt 10:39-10:45 leg uncaught (correctly
// filtered, not real displacement).
const GRIND_MIN_RUN = 2;        // consecutive same-direction closes required
const GRIND_DISPLACEMENT = 80;  // points, pivot bar's extreme to the run's extreme

// Scans from the MOST RECENT bar backward for the first (i.e. most recent)
// candle whose body is large relative to the recent average AND whose close
// breaks beyond the high/low of the CONSOLIDATION_LOOKBACK bars immediately
// preceding it. Returns null if none found — an honest "no CISD" rather than
// falling back to a fixed window.
function detectChromeCISDSingleCandle(bars, direction) {
  const search = bars.slice(-CISD_SEARCH_BARS);
  if (search.length < CONSOLIDATION_LOOKBACK + 2) return null;

  const avgBody = search.reduce((s, b) => s + Math.abs(b.close - b.open), 0) / search.length;
  const threshold = avgBody * LARGE_BODY_MULT;

  for (let i = search.length - 1; i >= CONSOLIDATION_LOOKBACK; i--) {
    const b = search[i];
    const body = Math.abs(b.close - b.open);
    if (body < threshold) continue;
    const window = search.slice(i - CONSOLIDATION_LOOKBACK, i);
    const windowHigh = Math.max(...window.map(w => w.high));
    const windowLow = Math.min(...window.map(w => w.low));
    if (direction === 'BEAR' && b.close < windowLow) {
      return { cisdBar: b, cisdIndex: i, consolidation: window, windowHigh, windowLow, searchArray: search };
    }
    if (direction === 'BULL' && b.close > windowHigh) {
      return { cisdBar: b, cisdIndex: i, consolidation: window, windowHigh, windowLow, searchArray: search };
    }
  }
  return null;
}

// Walks back from the most recent bar over the current unbroken run of
// same-direction closes (a "grind"). If that run displaces >= GRIND_DISPLACEMENT
// points from the pivot bar (the last opposite-direction close before the run)
// and is at least GRIND_MIN_RUN bars long, treats the run's FIRST bar as the
// CISD — same convention Brian's-model CISD uses (mark the turn, not the
// latest bar), which is also what keeps this stable while the grind
// continues rather than re-firing every single bar.
function detectChromeCISDGrind(bars, direction) {
  const search = bars.slice(-CISD_SEARCH_BARS);
  if (search.length < CONSOLIDATION_LOOKBACK + GRIND_MIN_RUN + 1) return null;

  const sameDir = (b) => (direction === 'BEAR' ? b.close <= b.open : b.close >= b.open);
  const end = search.length - 1;
  let start = end;
  while (start > 0 && sameDir(search[start])) start--;
  start++;
  const runLen = end - start + 1;
  if (runLen < GRIND_MIN_RUN || start === 0) return null;

  const pivotBar = search[start - 1];
  const runBars = search.slice(start, end + 1);
  const displacement = direction === 'BEAR'
    ? pivotBar.high - Math.min(...runBars.map(b => b.low))
    : Math.max(...runBars.map(b => b.high)) - pivotBar.low;
  if (displacement < GRIND_DISPLACEMENT) return null;

  const window = search.slice(Math.max(0, start - CONSOLIDATION_LOOKBACK), start);
  if (window.length === 0) return null;
  return {
    cisdBar: search[start], cisdIndex: start, consolidation: window,
    windowHigh: Math.max(...window.map(w => w.high)), windowLow: Math.min(...window.map(w => w.low)),
    searchArray: search, runLen, displacement: +displacement.toFixed(2),
  };
}

export function detectChromeCISD(bars, direction) {
  const single = detectChromeCISDSingleCandle(bars, direction);
  const grind = detectChromeCISDGrind(bars, direction);
  if (!single && !grind) return null;
  if (!single) return { ...grind, path: 'grind' };
  if (!grind) return { ...single, path: 'single-candle' };
  return grind.cisdBar.time > single.cisdBar.time
    ? { ...grind, path: 'grind' }
    : { ...single, path: 'single-candle' };
}

// --- Deterministic Chrome-model anchor selection, adaptive per spec §2.1 ---
// Anchors are no longer taken from a blind fixed-size window's global
// high/low (that produced 100+ point cross-check errors during a fast,
// wide-range session — see EVOLUTION.md 2026-07-17). Instead: find the most
// recent Chrome-CISD (above), then anchor the swing to the structure it
// actually describes —
// BEAR: top anchor = highest WICK within the consolidation that preceded the
//       CISD breakout (the range that got broken). bottom anchor = BODY
//       BOTTOM (min(open,close)) of the lowest-WICK candle among bars AFTER
//       the CISD bar (the impulse leg the CISD started).
// BULL: inverted — bottom anchor = lowest WICK within the preceding
//       consolidation. top anchor = BODY TOP (max(open,close)) of the
//       highest-WICK candle among bars after the CISD bar.
// Returns null (no fabricated anchors) if no CISD is found, or if there are
// no bars after the CISD to form the impulse leg yet.
export function findChromeAnchors(bars, direction) {
  const cisd = detectChromeCISD(bars, direction);
  if (!cisd) return null;
  const { consolidation, cisdIndex, searchArray, cisdBar, path } = cisd;
  const after = searchArray.slice(cisdIndex + 1);
  if (after.length === 0) return null;

  if (direction === 'BEAR') {
    const topAnchorBar = consolidation.reduce((a, b) => (b.high > a.high ? b : a));
    const bottomAnchorBar = after.reduce((a, b) => (b.low < a.low ? b : a));
    return {
      topAnchorBar, topAnchorPrice: topAnchorBar.high,
      bottomAnchorBar, bottomAnchorPrice: Math.min(bottomAnchorBar.open, bottomAnchorBar.close),
      cisdBar, path,
    };
  } else {
    const bottomAnchorBar = consolidation.reduce((a, b) => (b.low < a.low ? b : a));
    const topAnchorBar = after.reduce((a, b) => (b.high > a.high ? b : a));
    return {
      bottomAnchorBar, bottomAnchorPrice: bottomAnchorBar.low,
      topAnchorBar, topAnchorPrice: Math.max(topAnchorBar.open, topAnchorBar.close),
      cisdBar, path,
    };
  }
}

// --- Anchor freshness, global risk rule §5.5 ("stale-setup expiry") ---
// A CISD from before today's 9:30 ET open is pre-session structure; once the
// clock reaches 9:30 ET it expires — UNLESS price is still actively working
// that exact zone (within OTE_PROXIMITY of its own computed 0.705). A second,
// generic cap (ANCHOR_MAX_AGE_HOURS) catches the same staleness intraday,
// beyond one NY-AM-session length. Root cause this addresses: the 2026-07-17
// backtest found a single 8-hour-stale pre-market IFVG reused across two
// unrelated intraday setups, producing 70-90pt stops that tripped the max-
// stop gate all morning (reports/2026-07-17-backtest.md, "Fib sanity check").
const RTH_OPEN_ET = '09:30:00';
export const ANCHOR_MAX_AGE_HOURS = 2; // ~one NY AM session length (spec §3.6 "NY AM" window)

function etDateTimeParts(unixSeconds) {
  const s = new Date(unixSeconds * 1000).toLocaleString('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const [datePart, timePart] = s.split(', ');
  const [mm, dd, yyyy] = datePart.split('/');
  return { dateStr: `${yyyy}-${mm}-${dd}`, timeStr: timePart };
}

export function isAnchorExpired(cisdBar, refBar, ote705) {
  const cisdEt = etDateTimeParts(cisdBar.time);
  const refEt = etDateTimeParts(refBar.time);
  const crossedSessionOpen = cisdEt.dateStr < refEt.dateStr
    || (cisdEt.dateStr === refEt.dateStr && cisdEt.timeStr < RTH_OPEN_ET && refEt.timeStr >= RTH_OPEN_ET);
  const ageHours = (refBar.time - cisdBar.time) / 3600;
  if (!crossedSessionOpen && ageHours <= ANCHOR_MAX_AGE_HOURS) return false;
  const activelyWorking = Math.abs(refBar.close - ote705) <= OTE_PROXIMITY;
  return !activelyWorking;
}

// Fib convention: BEAR measures retracement UP from bottom (0%) toward top
// (100%) — the OTE sits near the top (premium, correct for selling). BULL
// measures DOWN from top (0%) toward bottom (100%) — OTE sits near the
// bottom (discount, correct for buying). Spec §1.5.
export function computeChromeFib(bars, direction) {
  const anchors = findChromeAnchors(bars, direction);
  if (!anchors) return null;
  const { topAnchorPrice, bottomAnchorPrice, topAnchorBar, bottomAnchorBar, cisdBar, path } = anchors;
  const range = topAnchorPrice - bottomAnchorPrice;
  if (!(range > 0)) return null; // degenerate swing — anchors didn't resolve to a real leg

  const level = direction === 'BEAR'
    ? (pct) => bottomAnchorPrice + pct * range
    : (pct) => topAnchorPrice - pct * range;

  const ote705 = roundToTick(level(0.705));
  const refBar = bars[bars.length - 1];
  return {
    direction, topAnchorBar, bottomAnchorBar, cisdBar, path, topAnchorPrice, bottomAnchorPrice, range,
    ote705,
    zone618: roundToTick(level(0.618)),
    zone79: roundToTick(level(0.79)),
    sd: {
      'SD -1': roundToTick(level(-1)),
      'SD -2': roundToTick(level(-2)),
      'SD -2.5': roundToTick(level(-2.5)),
      'SD -4': roundToTick(level(-4)),
    },
    expired: isAnchorExpired(cisdBar, refBar, ote705),
  };
}

// --- Fair Value Gap (FVG) / Inverse FVG (IFVG), spec §1.1/§1.2 ---
// 2026-07-18 independence build: computed directly from raw OHLCV, no longer
// read from ScriVindicator's IFVG labels. This closes two real gaps in the
// tag-reading approach: (1) the live indicator's IFVG label carries no
// direction marker in its text, so confirmation direction was a heuristic
// guess ("not verified against OTE direction"); our own computation knows
// BEAR/BULL for certain, straight from which side of the gap inverted.
// (2) tag-matching used "first found in proximity" — matching against our
// own computed set instead lets us pick the NEAREST valid one to the OTE
// level (see PROPOSALS.md #1, resolved by this — there's no longer a stale,
// far-away tag to mismatch against). Ported from backtest/engine.mjs, where
// it was originally built out of necessity (no historical indicator tags to
// replay) — now the single canonical source both live and backtest import.
export function findFVGs(bars) {
  const fvgs = [];
  for (let i = 2; i < bars.length; i++) {
    const c1 = bars[i - 2], c3 = bars[i];
    if (c1.high < c3.low) fvgs.push({ type: 'bullish', top: c3.low, bottom: c1.high, formedIndex: i, formedTime: c3.time });
    else if (c1.low > c3.high) fvgs.push({ type: 'bearish', top: c1.low, bottom: c3.high, formedIndex: i, formedTime: c3.time });
  }
  return fvgs;
}

// Invalidation extreme = the high/low of the 3-candle FVG formation itself
// (spec §1.2 doesn't give an exact formula; documented, defensible reading:
// "the extreme that formed it" = the swing the FVG's impulse came from).
export function findIFVGs(bars, fvgs) {
  const ifvgs = [];
  for (const fvg of fvgs) {
    const c1 = bars[fvg.formedIndex - 2], c2 = bars[fvg.formedIndex - 1], c3 = bars[fvg.formedIndex];
    const groupHigh = Math.max(c1.high, c2.high, c3.high);
    const groupLow = Math.min(c1.low, c2.low, c3.low);
    for (let j = fvg.formedIndex + 1; j < bars.length; j++) {
      const c = bars[j];
      if (fvg.type === 'bullish' && c.close < fvg.bottom) {
        ifvgs.push({ direction: 'BEAR', level: fvg.bottom, invalidation: groupHigh, invertedIndex: j, invertedTime: c.time, sourceFvg: fvg });
        break;
      }
      if (fvg.type === 'bearish' && c.close > fvg.top) {
        ifvgs.push({ direction: 'BULL', level: fvg.top, invalidation: groupLow, invertedIndex: j, invertedTime: c.time, sourceFvg: fvg });
        break;
      }
    }
  }
  return ifvgs;
}

// Is this IFVG still "live" (uninvalidated) as of index i in `bars`? (no
// candle since inversion has closed back beyond the invalidation extreme)
export function ifvgValidAt(bars, ifvg, i) {
  if (ifvg.invertedIndex > i) return false; // hasn't happened yet — no lookahead
  for (let j = ifvg.invertedIndex + 1; j <= i; j++) {
    const c = bars[j];
    if (ifvg.direction === 'BEAR' && c.close > ifvg.invalidation) return false;
    if (ifvg.direction === 'BULL' && c.close < ifvg.invalidation) return false;
  }
  return true;
}

// Freshest (most recently inverted) valid IFVG within proximity of a target
// level (e.g. fib.ote705), in the given direction, using only bars already
// in `history` (no lookahead). Supersedes "first found" tag/array-order
// matching (PROPOSALS.md #1).
//
// 2026-07-18 correction: the original diagnosis called this a "nearest vs
// first" problem, but re-checking the actual bug on 2026-07-16 showed the
// real defect was RECENCY, not price-distance — `findFVGs`/`findIFVGs`
// return IFVGs in chronological (oldest-first) order, so `.find()` picked
// the OLDEST valid match, which is how an 8-hour-stale IFVG kept winning
// over fresher ones. Selecting by nearest PRICE was tried first and tested
// worse on 2026-07-17 (picked a closer-in-price but wider-stop IFVG,
// dropping both that day's trades below the gate) — see
// reports/2026-07-17-independence.md for the comparison. Freshest-within-
// proximity is the version that actually matches the diagnosed defect.
// 2026-07-22 update (PROPOSALS.md #7): the funnel diagnostic
// (reports/2026-07-21-funnel-diagnostic.md) found freshest-within-proximity
// is still not enough — 79% of missed opportunities across a 26-day sample
// died at the stop gate, median rejected stop 56.75pt vs the 20pt limit.
// Freshest-in-time isn't the same as tightest-stop: a fresh IFVG can still
// carry a wide invalidation extreme. This version selects the valid,
// in-proximity IFVG that produces the SMALLEST resulting risk directly,
// optimizing for what the gate actually measures instead of a proxy for it.
// `excludeKeys` (a Set of IFVG invertedTime values already used-and-stopped-
// out within the current CISD's lifetime) supports PROPOSALS.md #8 — a
// stop-out requires a brand-new confirmation (spec §5 rule 2), so an IFVG
// that already produced a stopped-out trade this CISD must not be reselected.
// 2026-07-26 fix (bugs found live overnight 7/26, reported by JJ):
//
// (a) DIRECTIONAL CORRECTNESS — this loop only ever checked that the IFVG's
// *level* was within proximity of targetLevel; it never checked that the
// resulting *stop* actually lands on the structurally-correct side of
// entry. A BULL-direction IFVG whose own level happens to sit ABOVE the
// current entry (well within the 40pt proximity band) can produce a stop
// that's also above entry — backwards for a long. Confirmed live: entry
// 28607.75, selected stop 28613.75. `riskPoints = Math.abs(entry - stop)`
// downstream then silently reports this as a plausible-looking small
// number instead of the invalid plan it actually is, since Math.abs erases
// the sign. Fixed at the source: a candidate whose stop isn't on the
// correct side of targetLevel is now skipped entirely, never scored.
//
// (b) MINIMUM STRUCTURAL SIGNIFICANCE — nothing ever required a candidate
// IFVG to represent a REAL gap. `findFVGs` has no minimum-width check, so a
// single-tick market-noise gap counts exactly the same as a genuine
// imbalance. PROPOSALS #7 (tightest-stop selection, 2026-07-22) changed
// this function to explicitly MINIMIZE risk — which actively hunts out
// exactly these degenerate micro-gaps whenever one sits near the OTE
// level. Confirmed live: a 1.5pt "stop" producing rr1=53.83 — that RR
// alone is the tell of a fake structural reference, not a real inversion.
// MIN_IFVG_RISK_POINTS is a conservative, evidence-based floor (JJ's own
// regression baseline already has a legitimate 5.25pt gate-passing trade —
// see reports/EVOLUTION.md 2026-07-26 — so this is set well below that,
// specifically to exclude the 1.25-1.75pt noise-level instances actually
// observed without touching any already-verified real trade). Flagged as a
// heuristic default, not spec-given — same status as LARGE_BODY_MULT/
// GRIND_DISPLACEMENT/etc. above; revisit with more evidence if it proves
// too strict or too loose.
const MIN_IFVG_RISK_POINTS = 2;

export function nearestValidIfvg(history, direction, targetLevel, proximity = IFVG_PROXIMITY, excludeKeys = null) {
  const fvgs = findFVGs(history);
  const ifvgs = findIFVGs(history, fvgs);
  const lastIdx = history.length - 1;
  let best = null, bestRisk = Infinity;
  for (const f of ifvgs) {
    if (f.direction !== direction) continue;
    if (excludeKeys != null && excludeKeys.has(f.invertedTime)) continue;
    if (!ifvgValidAt(history, f, lastIdx)) continue;
    const d = Math.abs(f.level - targetLevel);
    if (d > proximity) continue;
    const stop = direction === 'BEAR' ? f.invalidation + TICK : f.invalidation - TICK;
    const onCorrectSide = direction === 'BEAR' ? stop > targetLevel : stop < targetLevel;
    if (!onCorrectSide) continue;
    const risk = Math.abs(targetLevel - stop);
    if (risk < MIN_IFVG_RISK_POINTS) continue;
    if (risk < bestRisk) { best = f; bestRisk = risk; }
  }
  return best;
}

// --- Rejection Block (RB), spec §1.7 ---
// "A candle that trades into a level and closes back against it, leaving a
// prominent rejection wick. CE (central equilibrium) = 50% of that candle's
// full range." Confluence only per spec — never a standalone entry trigger.
// direction 'BEAR' = rejection off a high (wicks up, closes back down);
// 'BULL' = rejection off a low (wicks down, closes back up).
const RB_WICK_MULT = 2; // the rejecting wick must be >= this * the candle's own body to count as "prominent"
export function findRejectionBlocks(bars, direction) {
  const blocks = [];
  for (const b of bars) {
    const body = Math.abs(b.close - b.open);
    const upperWick = b.high - Math.max(b.open, b.close);
    const lowerWick = Math.min(b.open, b.close) - b.low;
    const ce = roundToTick((b.high + b.low) / 2);
    if (direction === 'BEAR' && upperWick >= RB_WICK_MULT * Math.max(body, TICK) && b.close < b.open) {
      blocks.push({ direction: 'BEAR', bar: b, time: b.time, high: b.high, low: b.low, ce, wick: upperWick, body });
    }
    if (direction === 'BULL' && lowerWick >= RB_WICK_MULT * Math.max(body, TICK) && b.close > b.open) {
      blocks.push({ direction: 'BULL', bar: b, time: b.time, high: b.high, low: b.low, ce, wick: lowerWick, body });
    }
  }
  return blocks;
}

// 2026-08-24: TP1 target selection. Previously both engine.mjs (windowed to
// the last 100 bars) and shadow-poller.mjs (no window at all — the whole
// ~300-bar/15hr lookback) picked the MOST EXTREME high/low available,
// producing targets 100-200+ points away against 3-10pt stops. Real
// session data on 2026-08-23 showed exactly the predicted effect: 32 filled
// trades, only 1 real TP1 win (10% hit rate on trades that resolved
// directionally) — the target was structurally too far to ever realistically
// tap, so nearly every trade either scratched at the 15pt breakeven rule or
// reversed into a full stop. This scans backward from the most recent bar
// for the NEAREST qualifying pivot beyond entry in the target direction —
// the closest visible swing structure, not the single biggest number in the
// lookback. Shared by both engine.mjs (backtest) and shadow-poller.mjs
// (live) so the two stop being two different, undocumented methodologies.
export function findNearestSwingTarget(bars, direction, entry, pivotWindow = 3) {
  const isBear = direction === 'BEAR';
  let best = null;
  // Bounded on both sides — a pivot needs real neighbors on both sides to
  // confirm, so the last `pivotWindow` bars can never qualify (live-safe:
  // the most recent bars haven't had a chance to be confirmed as a pivot
  // yet either). Scans the WHOLE window and keeps the smallest PRICE
  // distance from entry — nearest in time was the original mistake here
  // (first-found scanning backward isn't the same as closest; a persistent
  // trend can put the first time-wise pivot much farther away in price than
  // one found further back).
  for (let i = pivotWindow; i < bars.length - pivotWindow; i++) {
    const b = bars[i];
    let isPivot = true;
    for (let k = 1; k <= pivotWindow; k++) {
      if (isBear) {
        if (bars[i - k].low < b.low || bars[i + k].low < b.low) { isPivot = false; break; }
      } else {
        if (bars[i - k].high > b.high || bars[i + k].high > b.high) { isPivot = false; break; }
      }
    }
    if (!isPivot) continue;
    const price = isBear ? b.low : b.high;
    const beyondEntry = isBear ? price < entry : price > entry;
    if (!beyondEntry) continue;
    const dist = Math.abs(price - entry);
    if (!best || dist < best.dist) best = { price, bar: b, dist };
  }
  return best ? { price: roundToTick(best.price), bar: best.bar } : null; // no qualifying swing found — caller decides the fallback
}

// --- SMT (Smart Money Technique divergence), spec §1.4 ---
// Compare NQ and ES at swing points: one instrument sweeps (trades beyond) a
// prior high/low, the other fails to. ALWAYS optional/supporting per spec —
// never gates an entry, informational only. Live-only (needs a second
// symbol's bars); not used in the backtest, which is fine since spec
// forbids gating on it anyway — its absence can't change a backtest verdict.
export function computeSMT(primaryBars, otherBars, lookback = 20) {
  const p = primaryBars.slice(-lookback);
  const o = otherBars.slice(-lookback);
  if (p.length < 3 || o.length < 3) return null;
  const pHigh = Math.max(...p.map(b => b.high)), pLow = Math.min(...p.map(b => b.low));
  const oHigh = Math.max(...o.map(b => b.high)), oLow = Math.min(...o.map(b => b.low));
  const pLast = p[p.length - 1], oLast = o[o.length - 1];
  const primarySweptHigh = pLast.high >= pHigh && pLast.high === pHigh;
  const otherSweptHigh = oLast.high >= oHigh && oLast.high === oHigh;
  const primarySweptLow = pLast.low <= pLow && pLast.low === pLow;
  const otherSweptLow = oLast.low <= oLow && oLast.low === oLow;
  if (primarySweptHigh && !otherSweptHigh) return { divergence: true, direction: 'BEAR', note: `Primary swept its ${lookback}-bar high, other symbol did not — bearish SMT.` };
  if (otherSweptHigh && !primarySweptHigh) return { divergence: true, direction: 'BEAR', note: `Other symbol swept its ${lookback}-bar high, primary did not — bearish SMT.` };
  if (primarySweptLow && !otherSweptLow) return { divergence: true, direction: 'BULL', note: `Primary swept its ${lookback}-bar low, other symbol did not — bullish SMT.` };
  if (otherSweptLow && !primarySweptLow) return { divergence: true, direction: 'BULL', note: `Other symbol swept its ${lookback}-bar low, primary did not — bullish SMT.` };
  return { divergence: false, direction: null, note: 'No divergence at the current swing extremes.' };
}

// --- Chrome model candidate classification ---
// State capped at WATCHING / EYES_ON / ARMED per this being a passive read.
const OTE_PROXIMITY = 40;   // points — price must be within this of the OTE label to be "eyes on"
const IFVG_PROXIMITY = 40;  // points — an IFVG must be within this of the OTE level to "arm" it
const CROSSCHECK_TOLERANCE = 1; // points — agreement within this = trust, more = flag for manual review

// 2026-07-18 independence build: driven entirely by OUR OWN computation now.
// Previously this looped over ScriVindicator's OTE tags (so no independent
// fib meant no candidate at all) and matched confirmation against its IFVG
// tags (first-found, no verified direction). Now: both directions are
// always evaluated from fibByDirection regardless of what the indicator
// shows, and IFVG confirmation comes from nearestValidIfvg (our own
// direction-known computation over `bars`). The ScriVindicator OTE tag, if
// present, is kept ONLY as an informational cross-check in the log — it no
// longer gates ARMED/plan-eligibility (see EVOLUTION.md 2026-07-18 and
// PROPOSALS.md #1, which this supersedes).
export function classifyChrome(scrivObjects, price, fibByDirection, bars) {
  const otes = scrivObjects.filter(o => o.type === 'OTE');
  const candidates = [];

  for (const direction of ['BEAR', 'BULL']) {
    const fib = fibByDirection[direction];
    const ote = otes.find(o => o.direction === direction);

    if (!fib) {
      candidates.push({
        model: 'Chrome', state: 'WATCHING', direction, level: null, distance: null,
        crosscheck: null,
        note: `No independent fib computed — no Chrome-CISD found in the search window (spec 1.3), or no bars after it to form an impulse leg yet.${ote ? ` (ScriVindicator still shows an OTE ${direction} tag @ ${ote.price.toFixed(2)} — informational only, no fib to check it against.)` : ''}`,
      });
      continue;
    }

    if (fib.expired) {
      candidates.push({
        model: 'Chrome', state: 'WATCHING', direction, level: null, distance: null,
        crosscheck: null, expiredAnchor: true,
        note: `EXPIRED ANCHOR: CISD @ ${etTime(fib.cisdBar.time)} (${fib.path}) is pre-session or >${ANCHOR_MAX_AGE_HOURS}hr stale and price is not actively working its 0.705 (${fmtTick(fib.ote705)}) — per spec §5 rule 5 (stale-setup expiry), not used.`,
      });
      continue;
    }

    // Informational only — no longer gates state or plan eligibility. Kept
    // purely to monitor whether our computation is drifting from the paid
    // indicator's, in case that's ever worth investigating again.
    let crosscheck = null;
    if (ote) {
      const delta = +Math.abs(fib.ote705 - ote.price).toFixed(2);
      crosscheck = { computed705: fib.ote705, tag: ote.price, delta, ok: delta <= CROSSCHECK_TOLERANCE };
    }

    let note = `Anchors (3m, adaptive per spec 1.3/2.1, path=${fib.path}): CISD close ${fmtTick(fib.cisdBar.close)} @ ${etTime(fib.cisdBar.time)} | TOP (wick) ${fmtTick(fib.topAnchorPrice)} @ ${etTime(fib.topAnchorBar.time)} | BOTTOM (body) ${fmtTick(fib.bottomAnchorPrice)} @ ${etTime(fib.bottomAnchorBar.time)}`;
    note += `\n    Zone: ${fmtTick(fib.zone618)} - ${fmtTick(fib.zone79)} (0.618-0.79) | SD -4: ${fmtTick(fib.sd['SD -4'])} (off by default, spec 2.2, context only)`;
    note += crosscheck
      ? `\n    Computed 0.705: ${fmtTick(fib.ote705)} | ScriVindicator OTE tag: ${crosscheck.tag.toFixed(2)} | delta: ${crosscheck.delta.toFixed(2)} ${crosscheck.ok ? '✓' : '(drifted, informational only — no longer gates)'}`
      : `\n    Computed 0.705: ${fmtTick(fib.ote705)} (no ScriVindicator OTE tag currently showing for this direction — not required anymore)`;

    const dist = Math.abs(price - fib.ote705);
    let state = 'WATCHING';
    if (dist <= OTE_PROXIMITY) {
      state = 'EYES_ON';
      const confirmingIfvg = nearestValidIfvg(bars, direction, fib.ote705, IFVG_PROXIMITY);
      if (confirmingIfvg) {
        state = 'ARMED';
        note += `\n    Confirmed by our own IFVG @ ${fmtTick(confirmingIfvg.level)} (inverted ${etTime(confirmingIfvg.invertedTime)}, invalidation ${fmtTick(confirmingIfvg.invalidation)}) — direction independently verified (${confirmingIfvg.direction}), nearest valid match to 0.705, not first-found.`;
      } else {
        note += '\n    No independent IFVG confirmation within proximity of our computed 0.705 yet — per spec 2.1 Stage 2, no inversion = no trade.';
      }
    }

    candidates.push({
      model: 'Chrome', state, direction, level: fib.ote705, distance: dist,
      crosscheck, note,
    });
  }
  return candidates;
}

// --- Brian's model candidate classification ---
export function classifyBrians(bryanObjects, price) {
  const candidates = [];
  for (const o of bryanObjects) {
    const dist = Math.abs(price - o.price);
    if (o.type === 'CISD_RB') {
      candidates.push({
        model: "Brian's",
        state: 'ARMED',
        direction: 'UNKNOWN — not derivable from label text',
        level: o.price,
        distance: dist,
        note: `${o.tf} CISD confirmed with ${o.grade} rejection block. Per spec 3.1 Step 5, CE entry ≈ this level (indicator-reported, not independently verified against the rejection candle's actual 50%).`,
      });
    } else if (o.type === 'CISD') {
      candidates.push({
        model: "Brian's",
        state: 'EYES_ON',
        direction: 'UNKNOWN',
        level: o.price,
        distance: dist,
        note: `${o.tf} CISD marked (×${o.count}), no graded rejection block confirmed yet — waiting on Step 4 rejection close.`,
      });
    } else if (o.type === 'RB') {
      candidates.push({
        model: "Brian's",
        state: 'WATCHING',
        direction: 'UNKNOWN',
        level: o.price,
        distance: dist,
        note: `${o.tf} ${o.grade} rejection block marked, but not tied to a CISD in this same label — confluence only per spec 1.7, not a Brian's-model entry trigger by itself.`,
      });
    }
    // bare FVG objects are shared confluence (spec 1.1), not a Brian's-model trigger on their own — omitted from candidates
  }
  return candidates;
}

export function fmt(n) {
  return typeof n === 'number' ? n.toFixed(2) : n;
}

// Bars fetched for CISD search (see CISD_SEARCH_BARS above) — the fib no
// longer uses a fixed swing window, but the CISD scan still needs enough
// history to find one. 300 bars of 3m = ~15 hours.
const CHROME_FIB_LOOKBACK_BARS = 300;

export async function main() {
  const state = await getState();
  const quote = await getQuote({});
  const price = quote.last;
  const originalResolution = state.resolution;

  console.log(`\n=== CHART SCAN — ${state.symbol} @ ${price} (${state.resolution}m chart) ===`);
  console.log(`Session (hardcoded windows, display only): ${currentSessionET()}\n`);

  const bryanStudies = state.studies.filter(s => /bryan/i.test(s.name));
  const scrivStudy = state.studies.find(s => /scrivindicator/i.test(s.name));
  const liquidityStudy = state.studies.find(s => /liquidity zone/i.test(s.name));
  const killzoneStudy = state.studies.find(s => /killzone/i.test(s.name));

  if (bryanStudies.length) {
    const titles = await getStudyTitles(bryanStudies.map(s => s.id));
    console.log("Bryan's Indicator instances found:");
    for (const s of bryanStudies) {
      console.log(`  - ${s.id}: ${titles[s.id] || '(title unavailable)'}`);
    }
  }
  if (liquidityStudy) console.log(`\nExcluded per design decision: "${liquidityStudy.name}" (${liquidityStudy.id}) — untrustworthy price data.`);
  if (killzoneStudy) console.log(`Unreadable per design decision: "${killzoneStudy.name}" (${killzoneStudy.id}) — no labels/lines/boxes/tables/study-values exposed; session windows above are hardcoded instead.`);
  console.log('');

  // Pull labels once (ungrouped by our own filter — grab everything, then sort by source name)
  const labelResp = await getPineLabels({ max_labels: 200 });
  const bryanBlocksRaw = labelResp.studies.filter(s => /bryan/i.test(s.name));
  const bryanBlocks = dedupBryanBlocks(bryanBlocksRaw);
  const scrivBlock = labelResp.studies.find(s => /scrivindicator/i.test(s.name));

  console.log(`Bryan's label blocks: ${bryanBlocksRaw.length} returned, ${bryanBlocks.length} unique after content-dedup.`);
  console.log(`ScriVindicator labels: ${scrivBlock ? scrivBlock.total_labels : 0} total.\n`);

  const bryanObjectsRaw = bryanBlocks.flatMap(b => b.labels.map(l => parseBryanLabel(l.text, l.price)));
  const bryanObjects = dedupParsedObjects(bryanObjectsRaw);
  const scrivObjects = scrivBlock ? scrivBlock.labels.map(l => parseScrivLabel(l.text, l.price)) : [];

  console.log(`Bryan's parsed objects: ${bryanObjectsRaw.length} before object-level dedup, ${bryanObjects.length} after (removes shared-timeframe overlap between distinct configs — see header note).\n`);

  // Independent fib computation per spec §2.1 Stage 3: drawn on the 3-minute
  // chart. Switch timeframe, pull bars, restore original timeframe after.
  // 2026-07-18: always compute BOTH directions now (independence build) —
  // no longer gated on whether ScriVindicator happens to show an OTE tag.
  await setTimeframe({ timeframe: '3' });
  const ohlcv = await getOhlcv({ count: CHROME_FIB_LOOKBACK_BARS, summary: false });
  const fibByDirection = { BEAR: computeChromeFib(ohlcv.bars, 'BEAR'), BULL: computeChromeFib(ohlcv.bars, 'BULL') };
  await setTimeframe({ timeframe: originalResolution });

  const chromeCandidates = classifyChrome(scrivObjects, price, fibByDirection, ohlcv.bars);
  const briansCandidates = classifyBrians(bryanObjects, price);

  // Report window: always show ARMED regardless of distance (most actionable),
  // cap WATCHING/EYES_ON to a reasonable proximity so this isn't a dump of
  // every CISD back through the chart's entire history.
  const REPORT_PROXIMITY = 150; // points
  const allUnfiltered = [...chromeCandidates, ...briansCandidates].sort((a, b) => a.distance - b.distance);
  const all = allUnfiltered.filter(c => c.state === 'ARMED' || c.distance <= REPORT_PROXIMITY);
  const omitted = allUnfiltered.length - all.length;

  if (all.length === 0) {
    console.log('NO TRADE — no Chrome OTE tags or Brian\'s CISD/RB objects found on chart at all.');
  } else {
    console.log(`${all.length} candidate(s) within ${REPORT_PROXIMITY} pts (or ARMED regardless of distance), nearest first. ${omitted} farther-out candidate(s) omitted from this report:\n`);
    for (const c of all) {
      console.log(`[${c.state}] ${c.model} | dir: ${c.direction} | level: ${fmt(c.level)} | dist: ${fmt(c.distance)} pts`);
      console.log(`    ${c.note}\n`);
    }
  }

  const armed = all.filter(c => c.state === 'ARMED');
  if (armed.length === 0) {
    console.log('=> No ARMED candidates. Per spec 5.1 (no completed sequence = no trade): NO TRADE right now.');
  }

  await disconnect();
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch(async (err) => {
    console.error('scan-chart failed:', err.message);
    await disconnect();
    process.exit(1);
  });
}
