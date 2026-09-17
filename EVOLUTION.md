# EVOLUTION.md

Durable changelog for the multi-mentor trade-model pipeline (`scan-chart.mjs`, `shadow-poller.mjs`, `chrome-anchor-debug.pine`, `rules.json`). Each entry: what changed, why, and what evidence drove it. Written so a future session can pick this up without re-deriving the reasoning.

---

## 2026-07-16 — Day-one shadow session (09:45-11:30 ET) & review

**What ran:** First live shadow-poller session, 186 ticks over 105 minutes, 30s cadence, zero errors/gaps. Tracked 7 candidates that reached ARMED: 5 Brian's (all pre-existing structure, armed at the first tick), 2 Chrome (armed fresh at 10:00 and 10:42 ET).

**Headline finding: zero of the 7 candidates produced a trustworthy, usable trade plan.**

- **Both Chrome plans were structurally backwards** — stop on the wrong side of entry for their direction (`chrome:BEAR` stop 29415.25 *below* entry 29581.75; `chrome:BULL` stop 29459.5 *above* entry 29321.75). Root cause: the cross-check delta between our computed 0.705 and ScriVindicator's raw tag was huge (178.96pt and 100.34pt respectively) — correctly computed and flagged `ok: false`, but **nothing gated plan-building on that flag**. The confirming-IFVG search matched against the raw indicator tag while entry came from our independently-computed fib; when those disagree by 100+ points, IFVG and entry end up in different coordinate systems entirely.
- **All 5 Brian's plans stayed unresolved** (`entry/stop/tp: null`) — direction inference requires a real candle to have tapped the level; none of these 5 legacy CISD/RB levels got retested during the session. Working as designed (honest "can't tell"), not a bug.
- Likely contributing factor to the Chrome delta size: the fib used a **fixed 150-bar (7.5hr) lookback window** taking a blind global high/low over that whole window, which doesn't adapt to how much the realized range expanded during a fast, wide session (~400pt move this particular day).

Full scorecard delivered in-conversation; not duplicated here.

---

## 2026-07-17 — Fixes from the day-one review + new hard constraint

Three approved fixes, one new rule from JJ, applied together:

### 1. Gate plans on `crosscheck.ok`
`scan-chart.mjs`'s `classifyChrome` and `shadow-poller.mjs`'s tick loop now check the cross-check delta *before* treating an ARMED sequence as plan-eligible. If `delta > 1pt` (`CROSSCHECK_TOLERANCE`), the plan is withheld — `plan: null`, `planStatus: "WITHHELD — crosscheck failed (delta Xpt > 1pt tolerance)..."` — rather than presented looking clean. The candidate still shows as `ARMED` (the sequence is structurally complete per spec §6), but the numbers are not handed over until they agree with the indicator.

### 2. Single reference frame
Root-caused the backwards-stop bug: proximity (`WATCHING`→`EYES_ON`→`ARMED`), IFVG confirmation matching, and entry price now **all** derive from our computed `fib.ote705`. The raw ScriVindicator tag is used *only* as the cross-check comparator — it never again feeds into IFVG-matching or entry directly. This alone would have prevented both 2026-07-16 plans from being structurally invalid, independent of the delta-gating fix above.

### 3. Persist fib anchor bars in the poller's JSONL
Previously only `scan-chart.mjs`'s interactive console output showed anchor candle timestamps/prices — the poller's per-tick log only had the cross-check numbers, not *why*. Every Chrome tick candidate in `shadow-poller.mjs` now logs `anchors: { cisdBar, topAnchorBar, bottomAnchorBar }` (time + ET string + price each), and the built trade plan carries the same block. A future large-delta event is now diagnosable straight from the log, not by re-deriving it after the fact.

### 4. NEW hard constraint — max 20-point stop (JJ, 2026-07-17)
JJ never runs more than a 20-point stop on NQ. Added `rules.json.hard_constraints.max_stop_points = 20` as the single source of truth; `shadow-poller.mjs` reads it at startup and applies `applyHardConstraints()` to every built plan (Chrome and Brian's). Any plan with `riskPoints > 20` is rejected outright — `plan: null`, `planStatus: "REJECTED — stop exceeds max risk..."`, logged in a separate `rejectedCandidates` array per tick (numbers preserved for review, never surfaced as tradeable). This is independent of the crosscheck gate: a self-consistent plan can still fail here if it's oversized. Per JJ's own framing: a 100+ point Chrome stop is itself evidence the inversion reference is wrong, since Chrome stops should come from a tight confirming-inversion extreme — the two gates catch overlapping but distinct failure modes.

### 5. Fib rebuild: CISD-anchored, adaptive (replaces the fixed 150-bar window)
`scan-chart.mjs` gained `detectChromeCISD()` — a heuristic implementation of spec §1.3's Chrome-CISD ("a large-body candle closing beyond a preceding consolidation range"), since the spec describes this qualitatively with no numeric formula. Documented, tunable thresholds (not spec values):
- `LARGE_BODY_MULT = 1.5` — candidate body must be ≥1.5× the average body size in the search window
- `CONSOLIDATION_LOOKBACK = 10` — bars immediately preceding a candidate CISD bar, treated as "the wicks it broke"
- `CISD_SEARCH_BARS = 300` — hard cap on how far back to search (safety bound, not the swing window itself)

`findChromeAnchors()` now anchors the fib to the structure the CISD actually describes (top anchor = highest wick *within the preceding consolidation*; bottom anchor = body-bottom of the lowest-wick candle *after* the CISD — inverted for Bull) instead of taking a blind global high/low over a fixed window. Returns `null` (no fabricated anchors) when no CISD is found — confirmed live: a BEAR-direction search on the live chart today correctly returned `null` when no qualifying breakout candle existed in the window, rather than forcing a stale answer.

**Known limitation surfaced, not hidden:** the heuristic missed a bearish CISD during today's smoke test despite a large realized intraday decline — the decline likely happened as a grind rather than one large-body breakout candle, which this detector's shape doesn't catch. Worth revisiting the threshold or adding a secondary detection mode if this recurs.

### 6. Pine indicator (`chrome-anchor-debug.pine`) rewritten to match
Same CISD-detection + consolidation-anchored logic ported to Pine v6, with inputs exposed (`searchBars`, `consolidationLookback`, `largeBodyMult`, direction). Plots: CISD marker, TOP/BOTTOM anchor labels, 0.705 line, 0.618-0.79 zone box — same visual contract as before, now driven by the corrected algorithm. Compiled clean, saved to JJ's account. JJ freed a chart slot himself (removed the duplicate `tc3VFM` BRYAN-F instance) and added it to the live chart.

---

## 2026-07-17 (later same day) — Pine timeframe fix, and a real UI-automation bug found along the way

**JJ's finding, confirmed:** `chrome-anchor-debug.pine` was computing its CISD/anchors from whatever timeframe the chart was *displaying* (15m), not the 3-minute data the spec (§2.1 Stage 3) and the scanner both require. Root cause: the script read `high`/`low`/`open`/`close` directly, which in Pine always means "the chart's current timeframe" — there was no explicit lower-timeframe request. Fixed with `request.security_lower_tf(syminfo.tickerid, "3", ...)`, building a rolling buffer of 3-minute OHLC (capped at 600 bars) regardless of chart display timeframe, gated behind `timeframe.in_seconds(timeframe.period) > timeframe.in_seconds("3")` so it degrades to a clear on-chart message rather than erroring if JJ ever views on 1m/3m directly. Added the requested self-documenting `"3m OTE"` label.

**A second, unrelated bug surfaced while deploying the fix: the MCP's `pine_set_source`/`pine_compile`/`pine_get_errors` tools are currently broken against the live TradingView page.** Their `ensurePineEditorOpen()` precondition walks up the DOM from the Monaco container looking for a React fiber key to reach Monaco's instance registry — that walk now dead-ends at `<body>`/`<html>` with no fiber key found at any level, on the current TradingView build. Every tool gated behind that check fails with `"Could not open Pine Editor"` even though the editor is genuinely open and usable. Worked around by driving the editor directly: `ui_type_text`/`ui_keyboard` for input, and `Cmd+S` (dispatched via `ui_keyboard`) for compile+save, which don't depend on the broken check.

**A third bug, much more time-costly, surfaced while typing the replacement source: simulated keystroke input into this Monaco instance corrupts multi-line, indented code.** Typing line-by-line (or even one large multi-line block) via synthesized keyboard events produces *cumulative* indentation drift on consecutive indented lines — each newline appears to inherit and then compound extra leading whitespace, and in the worst cases entire lines were dropped or silently overwritten by the next typed line. This happened whether text was sent as one bulk call or split into many small ones; inserting `Escape` before `Enter` (to guard against a possible autocomplete-widget interaction) did not fix it. **What actually worked: dispatching a synthetic `paste` `ClipboardEvent`** directly at the Monaco `textarea.inputarea` via `ui_evaluate` (construct a `DataTransfer`, `setData('text/plain', fullSource)`, `new ClipboardEvent('paste', {clipboardData, bubbles:true, cancelable:true})`, `dispatchEvent`) — Monaco treats a pasted block as one atomic insert rather than interpreted keystrokes, and every subsequent paste-based edit was clean on the first try. Real OS-level `Cmd+V` (relying on the actual system clipboard, set via `pbcopy`) did *not* work — the paste silently did nothing, likely because Electron/CDP-dispatched key events don't carry real OS clipboard access. The synthetic-`ClipboardEvent` route is the one that's actually reliable.

**Verification (the part JJ specifically asked for):** read the indicator's live labels back through `data_get_pine_labels` and compared against `scan-chart.mjs`'s own `computeChromeFib('BEAR', ...)` run moments apart. CISD and TOP ANCHOR matched **exactly** (29045.00 / 29129.75, byte-for-byte). BOTTOM ANCHOR/0.705 differed by a few points on the first read; re-reading Pine's labels immediately after showed they'd moved to 29017.75 (from 29013.00), converging with the scanner's 29017.25 — confirming the small initial gap was live market movement between two sequential reads a few seconds apart, not an algorithm mismatch. Renamed to **`Chrome OTE Fib (3m)`** afterward (confirmed via `chart_get_state`) since the timeframe fix is what "final" was gated on, and it's now verified.

---

## Open items carried forward

- CISD detector missed a real bearish move on 2026-07-16 (see limitation above) — worth watching in the next shadow session.
- Brian's model direction inference and TP1 risk units remain heuristic/spec-template-based, not independently structurally derived (unchanged from day one).
- SMT (ES1! divergence) still not implemented in the read/parse pipeline.
- ICT Killzones & Pivots [TFO] still unreadable via any MCP data tool — session windows remain hardcoded constants.
- **`pine_set_source`/`pine_compile`/`pine_get_errors`/`pine_open`/`pine_new` are unreliable on the current TradingView build** (broken React-fiber walk in `ensurePineEditorOpen()`, in `tradingview-mcp-jackson/src/core/pine.js`). Future Pine edits should go straight to the synthetic-paste-event technique documented above rather than re-attempting the built-in tools first.

---

## 2026-07-17 (attempted, unresolved) — All-timeframe fix blocked by a save-persistence failure

**The ask:** `Chrome OTE Fib (3m)` only worked when the chart was displayed above 3m (`request.security_lower_tf` requires a strictly-lower target). On the 1m and 3m charts — where JJ actually takes entries — it printed "Chart timeframe must be greater than 3m" and did nothing. Rewrote the indicator with three explicit modes (chart > 3m via `request.security_lower_tf`; chart == 3m via native bars directly; chart < 3m via `request.security` pulling the higher 3m timeframe, de-duped by its own bar timestamp so each 3m bar is only pushed once). Code is correct and complete — see `chrome-anchor-debug.pine` in this repo, 204 lines, syntax and logic both sound.

**What blocked deployment:** the synthetic-paste technique that worked earlier today (see the entry above) reliably updated the Monaco editor's *visible* buffer — confirmed repeatedly via screenshot and via the Version History diff view (which showed a clean, correct diff against v7, not corruption) — but **stopped marking the document dirty**, so every save action (`Cmd+S`, the "Saved" button, the explicit "Save script" menu item, "Update on chart", remove+re-add via "Add to chart") silently no-opped. `pine_list_scripts` (internal API, one of the few reliable read tools) confirmed this directly: version stayed at `7.0`, `modified` timestamp frozen at the rename save, through over a dozen distinct save attempts across roughly two hours.

Diagnostic finding: a **genuine typed keystroke** (not pasted) *did* flip the status bar to "Unsaved version" — proving Monaco's dirty-tracking itself works, and that it's specifically the synthetic `ClipboardEvent`-based paste that doesn't reach whatever change-listener TradingView's save system depends on. This is a regression from earlier today's behavior with the *same* technique on the *same* script (the timeframe-fix and rename saves both worked via this exact paste method) — nothing else about the approach changed, so the discrepancy is not understood. Possibly session/state-dependent (long-lived editor session, repeated open/close cycles, or an internal listener that detaches after some interaction) rather than something wrong with the technique itself.

**Real risk surfaced and recovered from:** while probing for a workaround, a `Cmd+End`/`Ctrl+End` keyboard shortcut mismatch caused a genuine-keystroke test edit to insert mid-statement rather than at document end, corrupting a line in the *unsaved* buffer. Caught immediately via screenshot, undone, and the buffer was fully restored via a clean select-all-delete-paste cycle before any further action. Confirmed via the Version History diff view that the recovered buffer was clean. This was never saved, so the live indicator was never at risk — but it's a concrete example of why paste (atomic, one operation) is safer than any keystroke-based editing technique in this environment, and why a screenshot check immediately after any edit is worth the cost.

**Current state:** the live `Chrome OTE Fib (3m)` indicator is still running the v7 (rename-only) source — functionally unchanged from before this attempt, i.e. still broken on 1m/3m charts, but not further damaged. The correct all-timeframe source is saved locally at `chrome-anchor-debug.pine` and is also currently sitting correctly in the open Pine Editor's buffer (unsaved). Handed off to JJ to paste and save himself — a genuine user-initiated `Cmd+V` and `Cmd+S` from his own keyboard is likely to succeed exactly where the CDP-synthesized version didn't, consistent with the paste-vs-real-clipboard distinction already documented in the entry above.

**Open item:** if this recurs on a future edit, try: (a) making one small genuine keystroke edit first (proven to mark dirty) immediately followed by a second paste for the real content — the paste might inherit the already-dirty state rather than needing to trigger it itself; (b) a full page reload of the TradingView tab to reset whatever session state may have caused the regression, then retry the paste technique fresh.

---

## 2026-07-17 (resolved) — All-timeframe fix confirmed live, all three modes verified

JJ saved the buffer himself directly in the TradingView UI (`Cmd+S` from his own keyboard) — confirming the theory above: a genuine user-initiated save succeeded immediately where the CDP-synthesized one silently no-opped, same as the earlier paste-vs-real-clipboard split. The mechanism difference (not just the paste, but the *save* step too) is specifically about user-trust/provenance of the action, not the content or the technique's correctness.

**Verification, all three modes, cross-checked against `scan-chart.mjs`'s independently-computed `computeChromeFib('BEAR', ...)`:**

| Chart timeframe | Mode label shown | CISD | TOP ANCHOR | BOTTOM ANCHOR | 0.705 | Match |
|---|---|---|---|---|---|---|
| 1m | `3m OTE (3m via security)` | 28835.00 | 28941.00 | 28783.25 | 28894.50 | Exact |
| 3m | `3m OTE (3m native)` | 28835.00 | 28941.00 | 28783.25 | 28894.50 | Exact |
| 15m | `3m OTE (3m via lower_tf)` | 28835.00 | 28941.00 | 28783.25 | 28894.50 | Exact |

All four values byte-identical across all three chart timeframes and against the scanner, confirmed via a fresh independent scanner computation run immediately after the three chart reads (no drift). The mode label correctly identifies which of the three code paths (`request.security_lower_tf` / native bars / `request.security`) is active for each timeframe — exactly as designed, and directly verifiable on-chart rather than just inferred from code review.

**Status:** `Chrome OTE Fib (3m)` is now correct and live on all timeframes, including 1m and 3m — the ones JJ actually trades off of, which were the entire point of this fix. Superseded the day-one restriction from earlier this thread (`>3m` only).

**Not resolved:** the underlying cause of the CDP-synthesized save silently failing was never root-caused, only worked around by handing the save action to JJ. If a future session needs to deploy a Pine edit unattended, expect the same failure mode and plan for either a manual handoff or further investigation into why user-provenance affects whether TradingView's save handler fires.

**Cosmetic rename:** attempted to rename the saved script's internal name (distinct from the on-chart `indicator()` title, which was already correct) from `Chrome Anchor Debug` to `Chrome OTE Fib (3m)` via the rename dialog. The rename mechanism itself worked (bumped to v9), but the same select-all/replace unreliability seen throughout this session (Cmd+A not reliably selecting existing field content) produced a typo — `Crome OTE Fib (3m)`, missing the h. JJ corrected it himself directly in the UI rather than have the automation take another pass at it. Net effect: another data point that any select-all-then-type edit in this environment (Monaco or plain inputs alike) needs a verify-by-screenshot step before trusting it, even for one-line text fields.

---

## 2026-07-17/18 — Full backtest, two calibration fixes, and the standing continuous-improvement loop

**Backtest first.** No live poller session ran on 7/17, so ran a full no-lookahead, bar-by-bar walk-forward backtest instead, covering both July 16 (9:30-11:30am ET, range day) and July 17 (9:30-11:00am ET, crash-then-487pt-recovery day) against NQ1! 3m OHLCV. Historical bars beyond the live chart's ~500-bar buffer were pulled via a synthetic click-and-drag pan (see `backtest/README.md` — `scrollToDate()` and mouse-wheel scroll do NOT trigger TradingView's lazy history loading; a real drag gesture does), extracted via the raw `bars.firstIndex()/lastIndex()/valueAt(i)` API, and saved as a permanent fixture at `backtest/fixtures/nq_3m_bars_2026-07-14_to_17.json`. Full write-up: `reports/2026-07-17-backtest.md` (mentor-lessons project). Headline findings: July 16's 4 ARMED candidates were ALL rejected by the 20pt stop gate, 3 of them tracing to one stale, reused IFVG; July 17's model caught the crash (2 shorts, both -1R, entered right at the bottom) but completely missed the +487pt recovery because price never pulled back into an OTE zone. A fib-anchor sanity check also found CISDs re-firing every few minutes on marginal single-bar extensions during fast moves — likely the cause of JJ's "the fib looked odd" observation that day.

**Two calibration fixes, approved and implemented from that report:**

1. **Grind-CISD detection path** (`scan-chart.mjs`, `chrome-anchor-debug.pine`). Spec §1.3's own language ("a series of same-direction candles/wicks, [then] a candle with a large body closes beyond...") covers two patterns; only the single-big-body-candle path existed. Added `detectChromeCISDGrind`: 2+ consecutive same-direction closes displacing ≥80pt from the pivot bar, with the run's first bar as the stable CISD identity (mirrors Brian's-model's own "mark the turn" convention). Both paths run every evaluation; whichever CISD is more recent wins, tagged `.path` (`single-candle` | `grind`) for permanent separate scoring. Parameters (2 bars, 80pt) were fit directly against the backtest's own missed-swing sizes, not picked a priori.
2. **Anchor-freshness expiry** (`scan-chart.mjs`, `chrome-anchor-debug.pine`). New `isAnchorExpired`: a CISD from before today's 9:30 ET open (or >2hr stale intraday) is no longer used as the active fib anchor — UNLESS price is still within the 40pt OTE proximity of its own 0.705 ("actively working" exemption). Pine shows an "EXPIRED ANCHOR" label instead of drawing a stale fib.

**Deployed the Pine changes without the usual manual-handoff friction.** Per the documented history above (repeated silent-save failures requiring JJ to save himself), expected to need a handoff again — instead the synthetic-`ClipboardEvent` paste landed cleanly AND the CDP-dispatched `Cmd+S` actually persisted this time (version bumped 9.0 → 10.0, confirmed via `pine_list_scripts`). The earlier failure's root cause (user-provenance affecting whether TradingView's save handler fires) was never resolved — this run simply didn't reproduce it. Verified live via `data_get_pine_labels` against a fresh `scan-chart.mjs` computation: CISD 28760.00, TOP 28886.00, BOTTOM 28733.50, 0.705 28841.00 — exact match, path correctly tagged `single-candle`.

**Re-ran both backtest sessions with the new detection** — full comparison in `reports/2026-07-17-recalibration.md`. Grind path successfully caught real structure the old logic missed (including July 17's recovery leg, 15 minutes before the single-candle path found it), but produced zero new ARMED trades in this 2-session sample — every grind-tagged run resolved before price revisited its own OTE zone. Freshness expiry correctly retired 2 stale pre-session anchors and correctly un-expired one of them minutes later when price came back to work that exact zone — proving the exemption isn't a blanket kill-switch. Neither fix changed any of the 2 previously-scored trades' outcomes (confirmed via regression harness, see below) — the actual drivers of both sessions' results (July 16's IFVG staleness, July 17's zero pullback coverage) remain open. One side effect found and left unshipped: a transient grind run appearing-then-breaking can cause the dispatcher to "rediscover" an unchanged single-candle CISD as if new, producing harmless but noisy duplicate re-arms (3 on July 16) — logged as proposal #4, not fixed this round.

**Built the standing continuous-improvement loop** (mentor-lessons project, `reports/`):
- `SCOREBOARD.md` — cumulative record (armed/gate-pass/scored/wins/losses/R) broken out by detection path and (once it exists) grade, plus a per-session log and the append workflow.
- `PROPOSALS.md` — every improvement idea, with evidence/change/risk/status; nothing ships without JJ's explicit approval. Seeded with #1 (IFVG nearest-vs-first-match — the original report's own top recommendation, deliberately NOT implemented this round pending approval), #2 and #3 (this session's two fixes, marked implemented), and #4 (the duplicate re-arm dedup, proposed).
- `tradingview-mcp-jackson/backtest/` — the engine (`engine.mjs`, refactored to accept bars as a parameter instead of a hardcoded path), the permanent regression test set (`sessions.json`: July 16 + July 17), a frozen baseline (`baseline.json`, seeded from this session's post-fix results), and `run-regression.mjs` to diff any future change against it (`README.md` documents how to capture and add new sessions over time).

**Not done this round:** proposal #1 (IFVG nearest-match) — the actual root cause of July 16's oversized stops — remains unimplemented pending JJ's explicit approval, per the standing governance rule. Brian's-model backtesting also remains unbuilt (no historical Bryan's-indicator label data to reconstruct against).

---

## 2026-07-20 (pre-flight) — Live poller wasn't applying the freshness gate; fixed. Dry-run verified clean.

**Gap found while prepping tomorrow's live session:** `shadow-poller.mjs` imports `computeChromeFib` directly from `scan-chart.mjs`, so it automatically inherited the grind-CISD path from the 7/17 recalibration — but its own inline candidate-building logic never checked `fib.expired`, so the anchor-freshness rule (also from 7/17) was silently NOT enforced in the live path, only in the offline backtest/scanner. Fixed: added the same `fib.expired` check used in `scan-chart.mjs`'s `classifyChrome`, pushing a `WATCHING`/`expiredAnchor: true` candidate (visible in the JSONL, not silently dropped) instead of building a plan off a stale anchor. Also added `.path` to every logged Chrome candidate so `reports/SCOREBOARD.md`'s per-path breakdown can be filled in from live sessions too, not just backtests.

**Verified live, not just by inspection:** ran `computeChromeFib` directly against the current live chart — both directions currently show `expired: true` (off-hours, stale structure, price not actively working either zone), confirming the rule is live and actively suppressing stale anchors right now, not just in the backtest.

**Dry-ran the full poller** (`node shadow-poller.mjs <3-min-out cutoff>`) against the live connection: 5 real 30s ticks, clean healthy output each time, clean self-triggered cutoff-stop and disconnect — same behavior as day one. ScriVindicator had no active OTE tag during the test window, so no ARMED/EYES_ON candidate came through this particular dry run (expected off-hours, not a bug) — confirmed separately via the direct `computeChromeFib` check above that the underlying logic is correct and wired in. Test artifacts (`sessions/2026-07-20.jsonl`/`-candidates.json`) deleted afterward so they don't get appended into today's real session log (poller appends, doesn't truncate, and both share the same ET-calendar-date filename).

**Added `RUNBOOK.md`** (mentor-lessons project root) — one-page morning checklist: health check, poller start command, what healthy output looks like, what to do if the health check fails, and the after-session review prompt.

---

## 2026-07-18 (later) — Independence build: own FVG/IFVG/RB detection, crosscheck gate retired

**Status check requested first:** JJ asked whether the "self-sufficient stack" (own FVG/IFVG/RB from raw OHLCV, SMT from ES data, crosscheck dependency removed) had been fully implemented. It had not — checked `scan-chart.mjs`, `shadow-poller.mjs`, and this file's own open items: SMT was explicitly listed as unimplemented, live IFVG confirmation still read ScriVindicator's raw tags, RB detection didn't exist anywhere. Only the *backtest* had its own FVG/IFVG detector, built purely out of necessity (no historical tags to replay), never intended as a live replacement. Flagged this clearly before proceeding, since retiring the crosscheck (a safety gate) the night before a live session is a real risk decision, not just a status update. JJ chose "build it tonight, ship for tomorrow."

**Built:**
- `findFVGs`/`findIFVGs`/`ifvgValidAt` (spec §1.1/§1.2) promoted from `backtest/engine.mjs` into `scan-chart.mjs` as the single canonical detector, imported by both live and backtest (removes a duplicate-logic risk that existed since the backtest was first built).
- `findRejectionBlocks` (spec §1.7) — wick ≥2x body trading into a level and closing back against it, CE = 50% of full range. Confluence-only, no consumer wired up yet.
- `computeSMT` (spec §1.4) — NQ/ES swing-sweep divergence, informational only per spec (never gates). **Not wired to a live ES1! feed** — the only mechanism (`tab.js`'s `newTab()`) dispatches real Cmd+T keystrokes into JJ's live TradingView Desktop app, a visible side effect on his actual screen; deferred since it was active RTH hours during this build, and since spec forbids gating on SMT anyway, its absence can't affect any trade verdict.
- `nearestValidIfvg` — see correction below.
- `classifyChrome` and `shadow-poller.mjs`'s inline candidate logic rewritten: both directions (BEAR/BULL) always evaluated from `computeChromeFib`, no longer gated on whether ScriVindicator shows an OTE tag at all. The OTE-tag-vs-computed-0.705 crosscheck is now informational telemetry only (logged when the tag happens to be visible) — no longer withholds a plan.
- `buildChromeTradePlan` simplified: stop now comes directly from our own IFVG's `invalidation` value (exact, from real OHLCV) instead of `nearestExtremeBar`'s heuristic search for a candle near an approximate tag price. That function is now dead code, deleted.

**A correction made and logged, not hidden:** the first version of `nearestValidIfvg` selected by nearest PRICE to the OTE level, per the original PROPOSALS.md #1 diagnosis ("nearest, not first"). Testing against July 17 immediately showed this regressing a known-good day — it picked a closer-in-price but wider-stop IFVG, dropping both of that day's real trades below the 20pt gate (cumulative R went 0 not by winning, but by taking zero trades). Re-examined the actual 7/16 defect: `findFVGs`/`findIFVGs` return IFVGs in chronological (oldest-first) order, so `.find()` was picking the OLDEST valid match, not the farthest — the original diagnosis conflated recency with price-distance. Corrected to **freshest-within-proximity** (most recent inversion time among valid, in-range candidates), which reproduced July 17 byte-for-byte and genuinely tightened 2 of July 16's 4 stops (73→28.5pt, 52.75→21pt) without regressing anything. Full write-up: `reports/2026-07-17-independence.md`.

**Verified live, not just backtested:** ran `scan-chart.mjs` against the real chart with ScriVindicator showing zero labels (confirmed the read pipeline itself works — Chrome OTE Fib and Liquidity Zone Detector both returned real labels in the same call) and got a real ARMED BULL candidate, direction independently verified, IFVG matched with zero indicator input — something the prior code structurally could not produce without a ScriVindicator tag present. Dry-ran the full poller twice more (once late night, once during live RTH hours) — clean ticks, clean cutoff-stop both times, test log files deleted afterward so they don't pollute the real session file (same date key, poller appends not overwrites).

**Three-way regression (original baseline vs 7/17 recalibration vs tonight's independent stack), full detail in `reports/2026-07-17-independence.md`:**
- July 17: byte-identical across all three versions. Zero drift.
- July 16: cumulative R and gate-pass count unchanged (still $0 day), but 2 of 4 setups' stops tightened materially (32pt and 44.5pt), closing the gap to the 20pt gate from 32.75pt/53pt over to 1pt/8.5pt over. The other 2 setups had no fresher IFVG available in proximity at the time — falling back to the only one available may be correct (no inversion = no trade), not a remaining bug. Logged as a follow-up question, not changed without approval.

**PROPOSALS.md #1 marked superseded** — the originally-proposed "nearest by price" fix was tried, found wanting, and replaced by the corrected "freshest within proximity" version described above, which is what's actually shipped.

**Known gaps carried forward:** SMT built but not live-wired (deferred for the reason above, not a blocker since it can't gate anything). RB detection built but has no consumer yet. Whether to loosen `IFVG_PROXIMITY` or otherwise handle "no fresher IFVG available" is an open question, not decided.

**Go/no-go for tomorrow:** GO. Zero regression on the known-good day (July 17), measurable improvement on the range day, operational surface (health check, poller start, cutoff) completely unchanged — this was a detection-logic swap, not an architecture change. `RUNBOOK.md` updated with a one-line note: Chrome candidates no longer require ScriVindicator to show an OTE tag to appear.

---

## 2026-07-20 — Pine strategy() conversion, extended backtest, Discord layer, SMT proposal

Four-part follow-up request after the independence build. Status:

**1. Pine strategy() conversion — DONE, deployed, verified compiling. Extended backtest numbers obtained via a fallback path, not TradingView's own Strategy Tester UI (see below).**

Built `chrome-strategy.pine`: full sequence entry (0.705 tap → direction-verified 5-minute IFVG confirmation, own detection not a 3m proxy → limit entry → IFVG-invalidation stop → 20pt hard gate → session filter → commission $2.25/contract/side + 2-tick slippage), mirroring `scan-chart.mjs`'s canonical detection. Deployed via synthetic-paste, compiled with zero errors, added to chart.

Getting a number out of TradingView's own Strategy Tester took far longer than expected and surfaced several real, worth-remembering issues:
- A screenshot-based indentation check produced a **false alarm** — verified via direct DOM `.view-line` extraction + diff against source that the paste was actually correct. Screenshots are not reliable for verifying Pine indentation; extract and diff text instead.
- Adding the strategy hit JJ's Essential-plan **5-indicator cap** — freed a slot by removing "Liquidity Zone Detector" (already documented elsewhere as excluded/untrusted).
- The chart's own **"All" zoom preset silently changed candle aggregation to monthly**, producing zero signals until caught via `chart_get_state`'s authoritative `resolution` field.
- **"Deep Backtesting" (custom testing-period ranges) is Premium-only** — Essential only supports "Range from chart." Not documented anywhere until the upsell modal appeared. Did not upgrade the plan; worked within the constraint by loading real history onto the chart instead (drag-pan technique, confirmed ceiling: 11,822 bars, June 14 – July 20, 2026 — that's the actual max available 3m depth on this plan/symbol).
- **`data_get_strategy_results`/`data_get_trades` (the MCP tools built for exactly this) don't work for overlay strategies** — their internal filter requires `is_price_study === false`, which excludes any `overlay = true` strategy (correct for this one, since it trades on the price pane). Bypassed by querying `chart.model().model().dataSources()` directly.
- Even after finding the right object, **`reportData()`/`performance()`/`ordersData()` returned `null` persistently** through a timeframe fix, an O(n²)-scan-size reduction (5m IFVG buffer 700→120 bars), and discovering + fixing that the script had silently never been saved ("Untitled script" the whole time). Root cause not fully resolved — the report panel is very likely canvas-rendered (DOM text search for "Overview"/"Net Profit" found nothing anywhere, even with the panel confirmed open), which would explain why neither the DOM-based nor internal-API paths worked. **Flagging as unresolved, not claiming false success.**

**Fallback that worked:** extracted the 11,822 real 3m bars now loaded on the chart and ran them through `backtest/engine.mjs` (already regression-verified all session) across all 26 real trading days in that window (June 15 – July 20). Full results, with an important caveat, in `reports/2026-07-20-strategy-backtest.md`: 20 distinct gate-passing setups after deduplicating a known duplicate-re-arm artifact (PROPOSALS.md #4) that inflated the raw count to 24, 15% win rate, +79.73R cumulative, profit factor 5.69, max drawdown 6.0R — driven by 3 large-R winners against 17 -1R losses, a profile extremely sensitive to the TP1 heuristic (nearest swing extreme, not a real liquidity model). Explicitly flagged as not a reliable expectancy estimate — exactly what the 4-step audit (item 2, blocked) should stress-test once it's available. The Pine strategy itself remains live on the chart for JJ to check the Strategy Tester panel himself.

**2. Audit machinery (plutothedev repo) — BLOCKED.** Checked both project folders; the files have not landed. Nothing to build yet. Will pick this up the moment they're present — checking again is a 10-second `find`, not deferred by oversight.

**3. Discord notifications — DONE, code-complete, untested end-to-end (no webhook yet).** `src/notify/discord.mjs`: two-tier alerts (EYES_ON heads-up, ARMED full plan) plus a session-end summary, wired into `shadow-poller.mjs` at the correct state-transition points with per-zone dedup (won't spam the same still-active zone every 30s tick). Webhook URL reads from `discord-config.json` (gitignored; `.example` template committed) — every send is a silent no-op with a single startup log line if the URL isn't configured, so the poller runs identically with or without it. Verified: runs clean with no config present, logs the expected "no webhook configured" message, doesn't throw.

**4. SMT live wiring — proposed, not implemented.** `reports/PROPOSALS.md` #6: brief tab-open/set-symbol/fetch/close cycle at poller startup + a slow refresh cadence (15-30 min), not per-tick — SMT only needs recent swing structure and spec forbids gating on it anyway, so staleness on the order of minutes is fine. A few seconds of visible disruption at startup and rarely after, rather than a constant flicker. Awaiting JJ's yes before shipping, per the standing rule — this is a UX/interruption judgment call, not just a technical one.

**Regression status:** no changes to core detection logic this round (Pine strategy is a new, separate script; Discord layer is additive/no-op without config) — `backtest/run-regression.mjs` still passes against baseline, unaffected by tonight's work.

---

## 2026-07-21 — Funnel diagnostic: thin edge vs narrow funnel

JJ asked for a specific diagnostic on the 26-day extended backtest: for every session where the market offered a clean directional move but the strategy took zero trades, identify exactly which gate blocked it, and find the #1 trade-killer. Diagnosis only, no rule changes, logged through PROPOSALS.md as always.

**Method:** same offered-vs-caught approach as the daily reviews (≥30pt swings = "offered"), but run per (day, direction) across all 26 days, classifying each miss by the furthest funnel stage reached: no CISD detected → anchor expired → no 0.705 tap → no direction-verified inversion → stop over 20pts.

**Result: decisive, not ambiguous.** Of 52 offered (day, direction) opportunities, 33 were missed. **79% of misses (26/33) died at the stop gate** — detection, the 0.705 tap, and IFVG confirmation all worked the large majority of the time (94% of misses reached ARMED or further). Pulled the actual rejected-stop sizes: median 56.75pt against the 20pt limit, 46% at 60pt+. Rejections aren't clustered near 20pt (which would suggest the threshold itself is slightly off) — they're spread wide with a heavy tail, pointing at the stop-placement mechanism, not the gate calibration. **This is new, independent quantitative evidence for PROPOSALS.md #1's original diagnosis** (IFVG selection producing oversized stops) — and importantly shows the already-shipped "freshest-within-proximity" fix (7/18) is not sufficient on its own: freshest-in-time isn't the same as tightest-stop.

**Also found, distinct from the stop-gate story:** 7 cases across 26 days where a second clean move (67-137pt) was offered later the same day in the same direction, but the state machine had no path to re-arm because the same CISD was still active (no new one had formed) — a real "one attempt per zone, and then never again until unrelated structure changes" gap, not modeled the way spec §5 rule 2 intends.

**Logged, not shipped** (per standing governance): `reports/2026-07-21-funnel-diagnostic.md` has the full breakdown and tables. `PROPOSALS.md` updated — #1 annotated with this new evidence (still marked as its original fix shipped, not reopened), new #7 (IFVG selection should prefer tightest resulting stop, not just freshest — the natural next calibration fix, evidenced now rather than just theorized) and new #8 (allow re-arming within a still-valid CISD after a stop-out, distinct mechanism from #7). Both `proposed`, awaiting JJ's yes.

**Bottom line for "calibration fix vs accept the edge is narrow":** the edge is not narrow — the model finds and confirms real structure constantly. The losses are concentrated in one specific, already-identified, addressable place (stop sizing at the IFVG-selection step). Next proposal to prioritize once approved: #7.

---

## 2026-07-22 — PROPOSALS #7 and #8 implemented, regression-verified, results reported honestly

JJ asked for whatever makes the system most profitable. Scoped that to the two concrete, evidence-backed proposals already sitting in the queue (#7, #8) rather than an open-ended tuning spree — implementing untested "profitability" changes without the regression/holdout discipline already established this cycle is exactly how systems get curve-fit to 26 days of data and then fail live.

**#7 — IFVG selection: tightest valid stop, not just freshest.** `nearestValidIfvg` (`scan-chart.mjs`) now picks the valid, in-proximity IFVG with the smallest resulting `riskPoints`, replacing "freshest by time." Regression-verified: July 17 byte-identical, July 16 tightened 2 of 7 stops meaningfully (76pt→34.75pt, 73pt→31.75pt), zero regression. **Honest result on the 26-day sample:** aggregate median rejected-stop barely moved (56.75pt→54.5pt) and zero rejected trades crossed into passing the gate. Most oversized stops don't have a tighter valid IFVG available in proximity at all — the underlying market structure is wide, not just our prior selection of it. Real, correct improvement; does not resolve the bulk of the stop-gate bottleneck by itself.

**#8 — re-arm within a still-valid CISD after a stop-out.** `backtest/engine.mjs`'s walk-forward now checks the active plan's stop causally (current bar only, no lookahead); on a stop-out, drops back to WATCHING and excludes that specific IFVG from re-selection via a per-direction `Set`, cleared on a genuinely new CISD. Regression-verified: July 16 unchanged, July 17 gained one legitimate re-arm attempt (correctly gate-rejected on its own merits, doesn't change the score). **Honest result on the 26-day sample:** of 7 originally-flagged missed opportunities, only 3 converted into gate-passing trades once re-checked fresh, and all 3 lost. 26-day aggregate: +79.73R → +76.73R, 15%→13% WR, 6.0R→7.0R max drawdown. Reported exactly as found — this is not "the fix is bad," it's 3 data points, same as the original +79.73R was never "the system is great." Kept shipped since the mechanism is principled and regression-clean.

**Found in passing, not implemented:** shadow-poller.mjs's live architecture doesn't have the "stuck ARMED for a CISD's lifetime" problem #8 fixed (it recomputes fresh every tick, unlike the backtest's persistent state machine) — but its `registry` only tracks the FIRST armed plan per direction per session, so later genuinely-new opportunities the live poller correctly detects still won't get their own fill/outcome tracking or Discord alert. Logged as new PROPOSALS.md #9, not touched — a live-poller tracking change deserves its own careful pass, not a rushed addition at the end of this one.

---

## 2026-07-23 — PROPOSALS #4, #9, #6 implemented; SMT incident found and fixed same day

JJ approved implementing #4 (dedup re-arm logging), #9 (live-poller per-plan registry keys), and #6 (SMT ES1! wiring) in one sitting.

**#4 — dedup re-arm logging.** A transient 1-2 bar grind blip can briefly outrank the single-candle CISD then break, making the unchanged single-candle CISD "reappear" as if new — re-triggering an EYES_ON/ARMED log for a structure already surfaced, sometimes with a different (but still stale-structure) IFVG. Fixed with three dedup guards in `backtest/engine.mjs`'s `runSession` (seenCisdTimes suppresses the spurious reset itself; seenEyesOnFor and seenArmedCisdTimes dedup the resulting log pushes), all keyed to leave the state machine's actual transitions untouched. Regression-verified zero change to cumulative R/wins/losses on both frozen days; July 16 armed count 7→4, cisdEvents 14→10.

**#9 — live-poller per-plan registry keys.** `shadow-poller.mjs`'s `registry` was keyed by `chrome:${direction}` alone — one slot per direction for the whole session, so a genuinely new plan after the first ARMED candidate only overwrote the existing slot's grade, never got its own fill/outcome tracking. Now keyed by `chrome:${direction}:${cisdTime}:${ifvgInvertedTime}`. Verified with synthetic ticks against the registry-write logic in isolation (couldn't dry-run the live poller itself without a real CDP connection at the time).

**#6 — SMT ES1! feed — shipped after a same-day incident and redesign.** First attempt opened/closed a new tab via keyboard shortcut, identified by URL matching. Live-tested, it worked functionally (pulled real ES1! bars) but broke the shared `connection.js` singleton's lock on JJ's real chart tab — `tab.js`'s URL-based tab identification doesn't work reliably in this TradingView Desktop session (real chart tabs can report blank URLs over CDP). Root-cause fixed in `connection.js`: `findChartTarget()` now probes each open tab directly for a live, evaluable chart API instead of trusting URLs, verified to recover the connection cleanly. `#6` itself was redesigned around JJ keeping a second tab permanently open on `CME_MINI:ES1!` — no tab creation/closing/keyboard shortcuts at all, just a direct read of whichever tab already has that symbol, returning `null` (never an error) if it's not open. Live-verified end-to-end: real ES1! bars in ~200ms, NQ connection unaffected, a full poller tick logged SMT correctly.

**Note for the 2026-07-26 entry below:** none of this — #4, #9, #6, or the connection.js tab-identification fix — was logged here at the time it shipped, breaking the standing "update EVOLUTION.md same day" habit. That gap is part of what's addressed below.

---

## 2026-07-26 — Post-fix extended backtest, then a critical live bug found, root-caused, and fixed

**Morning: precise post-#7/#8/#4 backtest re-run.** JJ asked for the actual, current numbers rather than the informal mid-implementation estimate. New permanent script `backtest/run-extended-backtest.mjs` — result: cumulative R +79.73 → +75.73 (-4.0R), win rate 15.0% → 12.5%, profit factor 5.69 → 4.61, max drawdown 6.0R → 8.0R. All 3 winning trades unchanged; the entire -4.0R swing was 4 new losing trades (3 from #8's legitimate re-arms, 1 from #7 letting a marginal setup through elsewhere in the sample). Reported as a mild net negative, not spun as an improvement. Full detail: `reports/2026-07-23-post-fix-backtest.md`.

**Evening: an overnight live session exposed a critical bug within an hour.** JJ started a scan intended to run past midnight into the next morning (a session shape the poller had never supported — added absolute date+time cutoff parsing to `shadow-poller.mjs` so it correctly spans midnight). Real Discord alerts caught, in order: stops of 1.25-4.25pt (noise, not real structural inversions), one **literally backwards stop** (28613.75 above a 28607.75 BULL entry), 4 duplicate ARMED alerts for the same structure in 60 seconds, and alerts firing at 9:20-9:34 PM outside any intended session. JJ's report was precise enough (exact numbers, exact timestamps) that root-causing from the already-logged session JSONL was straightforward — no guessing required.

**Root cause, in one sentence:** `nearestValidIfvg` (fixed at #7, 2026-07-22) started explicitly minimizing risk with no floor on structural significance and no check that the resulting stop lands on the correct side of entry, and `Math.abs()` in the risk calculation erased a backwards stop's sign before the 20pt hard gate ever saw the number. Full diagnosis, fix, and re-verification: `reports/2026-07-26-discord-bugs-diagnosis-and-fix.md`, `PROPOSALS.md` #10.

**Fixed:** a minimum stop floor (2pt, evidence-based, sits below the regression baseline's legitimate 5.25pt trade), a directional-correctness check rejecting wrong-side matches (both inside `nearestValidIfvg` and as independent defense-in-depth in both `buildPlan` and `applyHardConstraints`), alert dedup keyed by `id` alone instead of `id:entry` (entry drifts tick-to-tick; id doesn't), and a configurable 09:30-11:30 ET default alert window gating signal alerts (not the session summary).

**Re-verified:** regression suite still passes, byte-identical to baseline, on both frozen days. The 26-day extended backtest landed **exactly back on the original pre-#7 numbers** (+79.73R, 15.0% WR, PF 5.69, max DD 6.0R, 20 trades) — every extra trade introduced since #7 shipped was one of these bugs, not a real opportunity. Discord stayed hard-paused at the source (`NOTIFICATIONS_PAUSED` in `discord.mjs`) through the entire diagnosis-fix-verify cycle and is only being lifted now that all of the above is documented.

### How did this ship despite the standing regression rule?

This is the question that matters most, asked directly. The honest answer has two parts.

**Part 1 — procedurally, the rule was followed.** #7 (2026-07-22) was regression-tested against both frozen days before shipping and passed. #8 was regression-tested and passed. #4 was regression-tested and passed. #9 was verified with synthetic ticks (couldn't regression-test a live-poller-only change the same way). At no point was a change shipped WITHOUT running the check the standing rule requires. Re-running the regression suite on the exact code that shipped these bugs, tonight, before touching anything, confirmed it: **it still passes, right now, on this buggy code.**

**Part 2 — the fixture set has a coverage gap, and that's the actual failure.** The frozen 7/16-7/17 regression days simply never happen to contain a degenerate micro-gap FVG or a wrong-side IFVG match with the specific anchors/CISDs those two days produce. A 2-day fixture, however carefully chosen, is a spot-check against two specific historical scenarios — it was never going to be a general proof that every future code path is safe. #7's change to the selection criterion (minimize risk, not freshest) opened up a new region of behavior (actively seeking the smallest available number) that those two days don't happen to exercise. Passing the regression suite was true and also not sufficient — the standing rule caught what it was built to catch (does a specific change break two known-good days), and this bug class was never in scope for that check to begin with.

**What actually caught it:** not a backtest, not a regression day — a live session and a careful human read of the Discord alerts, cross-referenced against the same session's own JSONL log. That's a slower, more expensive detection mechanism than an automated test, and it's the one that worked here.

**Proposed permanent fix for the gap (not yet built, flagging for JJ's review):** add a standing *invariant* check that runs independent of any specific historical day — for every plan the engine (or the live poller) ever produces, assert directly: (a) stop is on the correct side of entry for the given direction, (b) risk is within `[min_stop_points, max_stop_points]`. This is different from a regression day (which checks "did today's numbers match yesterday's") — it's a property that should hold for *any* plan, on *any* data, forever, and can be wired as an assertion inside `buildPlan`/`applyHardConstraints` themselves (which is in fact what got shipped tonight, as the defense-in-depth layer) plus a dedicated fuzz/property-style test that runs synthetic or randomized bar sequences specifically hunting for a plan that violates either invariant, rather than relying on two fixed historical days to happen to expose it. Not built yet tonight — flagged here as the concrete next step so this class of gap doesn't require another live incident to surface.

**Both #7 and #8 marked implemented in PROPOSALS.md.** Baseline not re-seeded — current `backtest/baseline.json` numbers are unaffected by these changes (same 7/16-7/17 scored outcomes), so it remains valid as-is.

---

## 2026-09-06 — Read-only local dashboard built (`dashboard-server.mjs` + `dashboard-data.mjs` + `dashboard.html`), and a real gap found in the process

JJ asked for a single local dashboard covering everything: header status cards, live setups, equity curve, trade journal, breakdown stats, an audit panel, system health/change log, and gate analytics — read-only, never touching a poller or placing an order, one command to start.

**First finding, before writing any code:** `SCOREBOARD.md`, `PROPOSALS.md`, `RUNBOOK.md`, and the entire `reports/` directory do not exist anywhere in this project (`find . -iname "SCOREBOARD*" -o -iname "PROPOSALS*" -o -iname "RUNBOOK*"` and `find . -type d -iname reports` both came back empty), despite being referenced constantly throughout this file's own history — `reports/2026-07-21-funnel-diagnostic.md`, `reports/2026-07-23-post-fix-backtest.md`, `reports/2026-07-26-discord-bugs-diagnosis-and-fix.md`, and dozens of `PROPOSALS.md #N` references above. Either removed at some point or never actually committed — not investigated further tonight, just documented honestly rather than papered over. `RUNBOOK.md` created fresh (this section's start-commands now live there); `PROPOSALS.md`/`SCOREBOARD.md`/`reports/` were NOT recreated or fabricated — the dashboard shows real "no data" for whatever depends on them, per JJ's own explicit data-integrity spec for this build.

**Architecture shipped:** `dashboard-server.mjs` (plain Node `http`, zero new dependencies) serves `dashboard.html` (single embedded page, dark/TradingView-styled, native SVG charts — no CDN) at `localhost:3000`, polling `GET /api/data` every 30s. `dashboard-data.mjs` does all the aggregation, reading `sessions/*.jsonl`, `sessions/*-candidates.json`, `sessions/*-rebalance-summary.json`, `EVOLUTION.md`, `rules.json`, `backtest/baseline.json`, `backtest/sessions.json` fresh on every request. Confirmed genuinely read-only: no `fs.write*` call anywhere in either file, no order-placement import, `ps aux` used only to report whether a poller happens to be running.

**Three real bugs found and fixed while building + screenshot-verifying this, not just cosmetic:**
1. **Timestamp unit mismatch corrupting sort order.** `shadow-poller.mjs` records use ISO-string timestamps; `rebalance-engine.mjs`'s `outcomeAt` is a raw bar timestamp — epoch **seconds** (same convention as `etParts()`/`etTimeShort()` everywhere else in this codebase). `new Date(v)` with a bare number always means milliseconds, so passing epoch-seconds straight in silently produced 1970-era timestamps for every resolved Rebalance trade, corrupting both the journal's chronological order and the equity curve's running-total sequence. Fixed with a `toEpochMs()` normalizer (treats any number `< 1e12` as seconds) used everywhere a `ts` gets sorted.
2. **"By Model" breakdown silently excluded Rebalance entirely** — `getBreakdownStats()` only ever called `loadAllChromeRecords()`, never `loadAllRebalanceRecords()`, so the 4 real resolved Rebalance trades never appeared in the by-model or by-session-type stats. Caught by literally screenshotting the section and noticing "Rebalance" wasn't there when the header card's total (250) didn't match Chrome's own count (246). Fixed; detection-path/A+-overlap/re-arm breakdowns correctly stay Chrome-only (Rebalance has neither concept), noted explicitly in the UI.
3. **`rules.json`'s own "notes" field was stale** — still described `topstep-live-poller.mjs` as requiring "an interactive terminal confirm per trade," a rule removed 2026-09-04. The dashboard's System Health panel would have surfaced this exact stale claim to JJ every time he opened it; fixed at the source instead of papering over it in the dashboard.

**Also added, past the original spec:** a "Daily $ P&L (1 NQ)" card + table, per JJ's follow-up request mid-build. R is risk-normalized and doesn't convert to dollars directly (a 32R trade might be a 3pt-risk trade that ran 96pts, not 32 literal points) — recomputed real points per trade as `riskPoints × resultR` (holds uniformly for STOP/BREAKEVEN/TP1 since that's the same relationship `resultR` is already defined by) × $20/pt. Cross-checked against two days' worth of numbers already reported to JJ earlier by hand (Sept 2: -$65, exact match; Sept 3: +$6,326 vs an earlier +$6,325 — 6-cent rounding, not a discrepancy) — real confirmation the computation is correct, not just internally consistent.

**Verified, not just written:** every section screenshot-tested against real project data via the Browser tool (header cards, live setups' honest "no scan today" state, equity curve SVG, gate analytics funnel, daily $ table, sortable/filterable journal, breakdown bars including the model-breakdown fix, audit panel's live regression re-run — both frozen baseline days PASS right now — and system health's corrected known-limitations text). `node --check` on both `.mjs` files after every change.

**Known, disclosed limitations of this build itself:** "gap-matched" and "session type" were JJ's own spec terms without a precise definition elsewhere in the codebase — interpreted as "A+ overlap between Chrome and Brian's" and "live shadow vs. backtest" respectively (the latter currently has zero backtest-schema rows to show, since `run-regression.mjs`/`run-extended-backtest.mjs` only print console summaries, never a persisted per-trade journal — flagged in the UI, not hidden). "Discipline flags" (a requested journal column) has no real source anywhere in the current data model — shown as explicit "no data," not invented.

---

## 2026-09-07 — First real live-fire attempt: three real blockers found and fixed, none of them silent

JJ ran `topstep-live-poller.mjs` live for the first time tonight (eval account, confirm-gate already removed 2026-09-04). Three genuine problems surfaced, each caught by the code's own safety checks rather than causing a bad trade — worth recording plainly since this is exactly the scenario the whole design has been built around.

**1. Account went inactive mid-session, config didn't know.** `topstep-config.json`'s `accountId` (27156343, `50KTC-V2-104488-96509284`) stopped being an active account (`canTrade:false, isVisible:false`) — JJ had reactivated an old eval, and TopStep issued it under a brand-new account id, `27357686` (`50KTC-V2-104488-58851500`, confirmed active, $50,000 balance). `resolveAccountAndContract()`'s existing `if (!match) throw` correctly refused to guess or fall back to "first active account" — it just failed loudly, placing nothing. Confirmed the new id directly with JJ before updating the config (a real account swap isn't something to silently assume, even with a plausible explanation).

**2. `practice:false` was wrong, and I (Claude) shipped it without testing first.** Reasoning at the time: an eval account trading in real time should want live market data, not a delayed practice feed. Empirically wrong — `searchContract('MNQ', {live:true})` returned zero contracts against this actual combine account, while `{live:false}` correctly found the real active contract. The account is `simulated:true` (TopStep evals trade through TopStep's own sim-execution layer regardless of funding stage) and the API's `live` flag apparently gates "does this account have LIVE (funded) contracts available" — not a data-feed quality setting. Reverted to `practice:true` same night, and added an empirical note directly in `client.mjs`'s `isLive()` so this specific wrong assumption doesn't get re-made. Lesson stated plainly: this should have been verified against the real API before shipping, not reasoned about from first principles and left untested.

**3. TopstepX's own bracket-order setting blocked the first real order.** First genuine ARMED signal (00:00 ET, BULL, 5.25pt stop) reached `placeOrder` and got rejected: `"Brackets cannot be used with Position Brackets. You must enable Auto OCO Brackets."` TopstepX has two bracket systems (legacy Position Brackets vs. newer Auto-OCO Brackets); this account was still on the old one. Fixed in TopstepX's own UI (Settings → Risk Settings → Brackets → Auto-OCO), not in code — nothing to fix here, this account-level setting simply hadn't been touched before. No position was ever opened; the order was rejected outright, not partially filled.

**Also shipped tonight, unrelated to the above but requested mid-session:**
- **Switched from MNQ to full-size NQ** at JJ's explicit request. Verified against the real API first (searching "NQ" also surfaces unrelated contracts — E-Mini Natural Gas "QGV6", E-Mini Crude Oil "QMV6" — whose internal codes happen to contain the substring; the existing exact-prefix `name.startsWith(SYMBOL)` filter already excludes those correctly once `SYMBOL='NQ'`). Stated plainly in both the code comment and to JJ: NQ's tickValue is $20/point vs MNQ's $2/point — same stop sizes now risk 10x the dollars.
- **Optional START time added** to `topstep-live-poller.mjs` (backward compatible — one arg is still cutoff-only, starts immediately). Two args (`node topstep-live-poller.mjs "07:00" "10:00"`) means the first is START: account/contract resolve immediately either way (so a bad config still fails fast), but the tick loop waits until START before actually watching for signals. Lets JJ launch it any time and walk away instead of needing to be at the keyboard at the exact minute the window opens. Argument-parsing logic (1-arg vs. 2-arg branching, same-day vs. absolute-date forms, a start-after-cutoff sanity check) verified in isolation before wiring into the real file. `Start Live Trading.command` updated to prompt for both.

**Process note:** the account swap was confirmed with JJ before acting on it; the practice-flag and MNQ-vs-NQ changes were verified against the real API before being presented as fixed, not asserted from memory. The one mistake in this list (item 2) is exactly the kind of thing empirical verification is supposed to catch, and did — a few minutes after shipping, not after a bad live fill.

**4. Bracket tick sign was wrong for shorts — found live, same morning.** First real ARMED signal after the Auto-OCO fix (07:07 ET, BEAR) was rejected: `"Invalid take profit ticks (426). Ticks should be less than zero when going short."` The docs' own example (`gateway.docs.projectx.com/docs/api-reference/order/order-place`) shows a sell order with both `stopLossBracket.ticks` and `takeProfitBracket.ticks` positive — the live API contradicts its own docs. Fixed based on the actual API behavior plus basic bracket-order logic (stop and target are always on opposite sides of entry, mirrored again by direction): BULL stop negative/target positive, BEAR stop positive/target negative. Only the BEAR-takeProfit half of this was directly confirmed by a real rejection before shipping; flagged that the BULL side still needed its first real test.

**5. `customTag` collision on restart, found immediately after fixing #4.** Tag was `chrome-${direction}-${cisdBar.time}` — deterministic from the signal's own structure. Restarting the process resets its in-memory dedup state, so the same still-valid CISD got re-detected and re-attempted with the IDENTICAL tag as the prior (rejected) attempt: `"Specified custom tag is already in use"` — confirmed live that TopStep reserves tags even for orders that themselves got rejected, not just filled ones. Fixed by appending `Date.now()` to the tag, so every actual `placeOrder` call is unique regardless of how many times the same structure gets retried across restarts.

**Pattern worth naming:** every one of tonight's five real bugs (bracket type, account swap, practice flag, tick sign, tag collision) was caught by a clean API-level rejection, never a bad fill — the layered gates (hard stop-size limits, the account-match check, and now these) are doing exactly what they're for. Five restarts in one night is a lot, but zero dollars were ever actually at risk across any of them.

---

## 2026-09-07 (later) — Output-facing model names renamed to JJ's own branding

JJ asked for the trading models to carry his own name instead of the mentors': **Chrome → "JJ's Model"**, **Brian's → "JJ's Rejection"** (it's built around rejection-block entries), **Rebalance → "JJ's Sweep"** (it's built around liquidity manipulation/sweeps).

**Scope, deliberately narrow:** renamed the `model:` string values that actually reach JJ — Discord alert titles, dashboard breakdown labels, gate-analytics/journal output — across `shadow-poller.mjs`, `rebalance-poller.mjs`, `topstep-live-poller.mjs`, `dashboard-data.mjs`. Did NOT rename internal function/variable names (`computeChromeFib`, `buildBriansTradePlan`, `chromeState`, etc. — invisible to JJ day to day, renaming them is pure risk for zero visible benefit) or `EVOLUTION.md`'s own history, or the mentor-attribution skill files — those document where the methodology actually came from, which is a different thing from branding JJ's own system's live output.

**One real bug caught mid-rename:** the A+ overlap-detection logic in `shadow-poller.mjs` (`chromeArmed`/`briansArmed` filters) compares candidates by their literal `model` string — renaming the string values without updating those two comparisons would have silently broken A+ detection entirely (nothing would ever match). Caught by grepping for every remaining "Chrome"/"Brian" occurrence after the bulk rename, not assumed safe.

**Honest tradeoff, not hidden:** historical session files on disk still literally say "Chrome"/"Brian's"/"Rebalance" (not rewritten, same principle as never rewriting `EVOLUTION.md`'s history) — only new sessions from now on produce "JJ's Model"/"JJ's Rejection"/"JJ's Sweep". Places that compare against the model string (detection-path recovery, gate analytics) now check both old and new via a shared `isJJsModel()` helper in `dashboard-data.mjs`, verified against real data post-rename (byModel/byGapMatched/gate-analytics counts identical before and after). The dashboard's "By Model" breakdown will show old and new names as separate buckets until enough new data accumulates under the new names — flagged to JJ, not silently merged.

**Not touched:** the actual Pine Script indicators deployed on the TradingView chart (`Rebalance Model [Chrome]`, `Chrome OTE Fib (3m)`, etc.) still carry the old names in their titles — that's a live-chart edit, a materially different and more delicate operation than a code rename, left as a separate task if JJ wants it done too.

---

## 2026-09-08 — Double-long risk and a silently-lost breakeven trade, both from the same root cause

JJ watched a real session on TopstepX directly and caught two things: a second BULL signal armed and placed while the first was still open (real double-long risk), and a clearly-profitable trade never got its manual 15pt breakeven stop-move despite running 90+ points in favor.

**Root cause, one thing, not two:** `chromeState[direction].activeTrade` — the ONLY place a live trade is tracked per direction — got unconditionally nulled the instant a genuinely new CISD formed, *regardless of whether the previous trade under the old CISD had actually resolved*. Two consequences from that single bug:
1. With `activeTrade` wiped, the `if (cs.activeTrade) continue` guard that's supposed to block a second entry saw nothing in the way — a real second BULL order armed and filled while the first was still open.
2. Tracking for the still-open first trade wasn't just paused, it was **replaced** — the single per-direction slot now pointed at the new (fictitious, per below) trade. The manual-breakeven watcher was still running every tick, just against the wrong trade's numbers. The real winner never got checked again until an unrelated event (TopStep's own Personal Daily Profit Target) force-closed it.

**A second, compounding bug found while tracing this:** fill-detection checked `posResp.positions.some(p => p.contractId === CONTRACT_ID)` — "does ANY position exist for this contract" — not "did THIS order fill." Confirmed against the real order history: the 08:48 entry order's own record shows `status: 3 (Cancelled), fillVolume: 0` — it never filled — yet the local log claims `TRADE_FILLED` for it, because the 08:15 trade's still-open position satisfied the same loose check.

**Fixed, both root and symptom:**
- A new CISD forming now only updates bookkeeping (`lastCisdTime`) — it never clears a real, unresolved `activeTrade`. The existing "don't arm while one's live" guard now actually has something to check.
- Position checks now filter on `PositionType` (confirmed via `gateway.docs.projectx.com`'s Realtime Updates "Enum Definitions" section: `Long=1, Short=2`, not guessed) — a BULL trade can no longer be confused for BEAR position evidence or vice versa. Same page also confirmed `OrderStatus` (`Filled=2, Cancelled=3, Rejected=5` — matches everything seen live so far).
- Breakeven math (and the actual stop-modify target) now use the position's real `averagePrice`, not the theoretical planned entry — confirmed live that a limit order can fill better than planned (29557 planned vs. 29552.25 actual on the 08:15 trade), and "breakeven" against the wrong number either leaves R on the table or isn't genuinely riskless.
- **Bonus fix, unlocked by the same investigation:** `findStopOrderFor` used a "closest stop price within 2 ticks" heuristic since the file's very first version, explicitly flagged as a guess because the docs don't mention a parent/child order link. Real order history pulled while diagnosing today showed every bracket child order actually carries `parentOrderId` back to its entry order — undocumented, but real and confirmed live. Now an exact match, not a proximity guess.

**Not live-tested yet** — the fix is verified by code review and a manual trace against today's exact real sequence (confirmed it would have blocked the third arm and kept tracking trade #2 correctly throughout), plus two syntax checks, but the next real overlapping-signal day is the actual test. Flagged plainly rather than claimed as proven.

---

## 2026-09-08 (later) — Dashboard now tracks real live-money trades, not just paper

JJ asked for the dashboard to track this eval's real trades. It didn't before — `dashboard-data.mjs` only ever read `sessions/*-candidates.json` (paper shadow-poller trades), never `sessions/*-topstep-live.jsonl` (the real ones).

**Shipped, three parts:**
1. **`topstep-live-poller.mjs` now writes an accurate summary file** (`sessions/<date>-topstep-live-candidates.json`, one record per real order, keyed by orderId) as trades progress — armed→placed, filled (with real fill price), and closed. Closing now calls a new `resolveTradeOutcome()` that checks REAL order history (not a guess) to determine whether the stop or the target actually filled — and, when neither did, best-effort identifies an external close (a standalone filled MARKET order on the closing side), labeled honestly as "likely external," not asserted as certain.
2. **Backfilled the two sessions that already ran** (2026-09-07 into 2026-09-08) by hand, using the exact real order-history reconciliation from earlier today's reports — every row marked `backfilled: true` with a `backfillNote` explaining why (mostly: predates this mechanism, or was affected by the false-fill / lost-tracking bugs fixed earlier today). Nothing here is invented; every number traces to the real `/api/Order/search` history already pulled and shown to JJ.
3. **New dashboard section, "⚠ Live Trading — Real Money"**, given its own yellow-bordered box near the top of the page — deliberately separate from the paper-trading sections so real and paper results are never visually conflated. Shows real trades (planned vs. actual fill price, outcome, exit, points, $), win rate, and total points/$ — computed from real fill/exit prices at $20/pt (full-size NQ), explicitly labeled as excluding commissions/fees since the dashboard stays read-only/file-based (no live account-balance API call added, on purpose — see dashboard's original design principles, 2026-09-06).

**Verified:** total computed ($1,405, before fees) matches the real order-history math from earlier today's reports exactly (-145 - 400 + 1950 = 1405). Screenshot-confirmed rendering: real trades table, reconciled badges, correct color-coding.

---

## 2026-09-10 — Two trades vanished from the record; poller now reconciles on every exit path

**What happened (2026-09-09 live session, -$511.34 real, 3 losing trades):** two of the three real trades left no fill/close trace in either the JSONL log or the candidates file.

- **08:03 ET trade (orderId 3503701467)** — session A, launched the evening before with START `2026-09-09 07:00` / cutoff `10:00`. Its process exited some time after 08:47 ET with no `STOP` and no crash/`FATAL` log; in-memory tracking for its still-open order went with it. No candidates file was ever written for that session. Broker order history: entry filled 29389.5, stop-loss child filled 29384.25 = -5.25pt, ~-$108.78 (matches the account-balance delta between the two poller launches).
- **10:31 ET trade (orderId 3505190991)** — session B. Order armed/placed 55 min after launch, ~29 min before cutoff. `main()`'s cutoff branch broke the loop at 11:00 ET with no final check; the OCO bracket then stopped the position out server-side at 11:06 ET, six minutes after the process was already gone. Recorded live as `filled:false / outcome:null`. Broker history: stop-loss child filled 29465.25 = -12.5pt, ~-$253.56 (again matches the balance delta).

Both are the same root gap: **nothing ever tried to resolve an order's true outcome before the process stopped watching it** — not on cutoff, not on a hand-kill.

**Fixed, three parts (`topstep-live-poller.mjs`):**
1. **`reconcileActiveTrade(direction, cs)`** — extracted verbatim from `tick()`'s per-direction body so the normal poll loop and the new final pass share one resolution path instead of two that can drift. Resolves fill state, real fill price, and stop-vs-target outcome against live positions + order history.
2. **`finalReconcile(reason)`** — best-effort, 10s-timeboxed (per direction) reconciliation, `Promise.race`d against a timeout so a network hiccup on the way out can't hang the process open. Called from **both** the cutoff branch in `main()` and a new **SIGINT/SIGTERM handler**. Anything still unresolved after a direct attempt is written as `SESSION_END_UNRESOLVED_TRADE` and printed loudly telling JJ to check TopstepX and fix the candidates file by hand — the failure is logged, never silently swallowed. A second Ctrl+C force-quits without waiting.
3. **`sessionDate` derived from START, not launch time** — it was `new Date()` at launch, so a poller started the night before named its files after the wrong trading day (this is why session A's log is the misdated `sessions/2026-09-08-topstep-live.jsonl`). Now: absolute START → that wall date; plain `HH:MM` START already past in ET → tomorrow; start-immediately → unchanged.

**Data reconciled by hand:** `sessions/2026-09-09-topstep-live-candidates.json` now has all three real trades with real fill/exit prices from `/api/Order/search`, each carrying a `note`/`reconciled_by` explaining the reconstruction. Gross on price -$500.00; actual -$511.34; the -$11.34 gap is round-turn commission across 3 trades (~$3.78/RT, right for TopstepX NQ). The misdated `2026-09-08-topstep-live.jsonl` was left in place (harmless — the dashboard's live panel reads only `*-topstep-live-candidates.json`, and its other globs match strictly `YYYY-MM-DD.jsonl`).

**Not live-tested** — `node --check` passes, the read-only connection/account path is re-verified, `reconcileActiveTrade` is the same code that already runs every tick. But the cutoff-reconcile and signal-reconcile paths only exercise with a real open order in play, so the next session with JJ at the keyboard is the actual test. A short manual run + Ctrl+C is the cheapest way to see the new "reconciling any open trade before exiting" path fire before it matters.

**Unchanged and still true:** Claude does not launch `topstep-live-poller.mjs` — not to "test the fix," not in the background, not on any trigger. JJ starts it by hand, physically at the machine. That boundary is independent of authorization.

---

## 2026-09-10 (same session, ~1h later) — the cancel branch of the new reconcile path never released the direction

**Found live, within minutes of it happening.** This morning's session armed a BEAR at 07:08 ET (order 3509131659, limit sell 29404.25). It never filled — price dropped ~150pt the other way — so JJ cancelled it in TopstepX at ~08:15 ET.

**What worked:** `reconcileActiveTrade` detected the externally-initiated cancel correctly — `searchOpenOrders` no longer listed it, `resolveEntryAndOutcome` returned `neverFilled: true`, and it logged `TRADE_CANCELLED_UNFILLED` + set the registry row to `outcome: "CANCELLED (never filled)"`. First live confirmation that the reconcile path from the entry above actually fires on a real out-of-band order change.

**The bug:** that `resolved.neverFilled` branch logged the event and wrote the registry but **never ran the `cs.activeTrade = null` cleanup** its sibling branch (filled-then-closed) does. So `chromeState.BEAR.activeTrade` stayed pinned to the dead order. Three consequences:
1. BEAR was blocked from re-arming for the rest of the session (the `if (cs.activeTrade) continue` guard had something to catch on).
2. `TRADE_CANCELLED_UNFILLED` re-fired every poll interval (~31s) — 21 identical copies in the JSONL before the restart.
3. The registry got rewritten every tick (harmless, just wasteful).

**Fix (`topstep-live-poller.mjs`, `reconcileActiveTrade` `neverFilled` branch):**
```js
cs.usedIfvgKeys.add(cs.activeTrade.ifvgKey);
cs.activeTrade = null;
```
Same two lines the filled-then-closed branch already had. Blacklisting the `ifvgKey` is deliberate, not just symmetry: a setup JJ manually cancelled shouldn't be re-entered on the identical IFVG the moment price wanders back.

**Ops note — a running poller can't pick this up.** PID 6874 had the old code; the fix only took effect after JJ `Ctrl+C`'d and relaunched (08:25 ET). On the way out, the old buggy code emitted one last `SESSION_END_UNRESOLVED_TRADE` for the BEAR order — a false alarm *in this case* (the order was genuinely already cancelled broker-side, nothing to resolve), but that's exactly why `finalReconcile` logs rather than asserts. The fresh process came up clean: `activeTrade` null, BEAR scanning again, spam stopped.

**Still not covered:** the poller does not cancel its own stale working entries. Order 3509131659 sat unfilled ~150pt out of range for 67 minutes until JJ killed it by hand. A "cancel the working entry when its CISD/IFVG is invalidated, or after N minutes unfilled" rule would have closed this without manual intervention — flagged, not built.

---

## 2026-09-10 — Live session results (2 poller sessions, account 27357686, full-size NQ)

First full day running the reconcile / cancel-branch / sessionDate fixes above.

**Morning session — 07:00-10:00 ET.** Launched the night before; took two restarts in the first minutes (once to move the SIGINT-reconcile fix live after a clean `Ctrl+C`, once for the cancel-branch bug). Net: **0 fills, flat.**
- One BEAR arm at 07:08 ET (order 3509131659, limit sell 29404.25, 2.75pt risk). Never filled — NQ dropped ~150pt the other way. JJ cancelled it by hand in TopstepX ~08:15 ET; the cancel-branch bug then pinned BEAR until the 08:25 restart.
- Nothing else armed the rest of the window. NQ was a one-way grind down (~29404 → ~29050) with no pullback for the model to anchor a CISD to.

**Afternoon session — launched 10:33 ET, cutoff 13:30 ET** (ad-hoc 3-hour run, JJ at the machine). **1 trade, -$178.78.**
- BEAR short, order 3511660545. Armed 12:00 ET: entry 29248.25, stop 29256.25 (8pt risk), tp1 29043.25 (~205pt / ~25R).
- Sat unfilled ~1h with price ~22pt below the entry. Filled 13:02 ET at 29248.25 on a pop up, and stopped the **same second** at 29257 (0.75pt past the planned stop). -8.75pt = -$175 + fees = **-$178.78, -1R**.
- The same-second fill-then-stop resolved correctly (`neverFilled:false` → `STOP` / -1R / exit 29257), not left hanging — second live confirmation of the 2026-09-09 reconcile path.
- Near the close the gate correctly rejected two BEAR plans at 68pt risk (`max_stop_points=20`).

**Account:** $50,882.32 → **$50,605.20** on the day. Poller **-$178.78**; JJ's own manual trade between sessions **-$98.34** (unrelated to the poller — see the MNQ/same-account caveat discussed live: position detection is contract-filtered so micros are invisible to it, but daily-cap math is account-level).

**Fixes validated live today:** SIGINT → `finalReconcile` → clean exit (used on every restart); `sessionDate` from START/launch (all restarts + the ad-hoc afternoon launch named files `2026-09-10-*` correctly); same-second fill-then-close resolution (afternoon trade). Cancel-branch fix shipped but not re-exercised after 08:25 — nothing was cancelled in the afternoon.

**Observation, 2 data points, not a conclusion:** both BEAR setups today carried a tp1 ~200+ points out on an 8-11pt stop (29043.25 target both times — same structural level). Neither came close (one unfilled, one stopped). Worth watching whether Chrome's tp1 projection is realistically reachable intraday or whether these are effectively "stop or bust" trades in practice.

---

## 2026-09-10 (later) — Why signal count dropped: regime, not config

JJ asked why 9/09-9/10 produced so few trades vs. earlier sessions, and whether he'd changed something. He hadn't. `rules.json` last modified 2026-09-06, `scan-chart.mjs` (detection) 2026-08-24; the only recent poller edits were the reconcile / sessionDate / cancel-branch fixes above, none of which touch detection or gating. Window unchanged at 07:00-10:00 ET.

**It's market regime, and it hits the funnel two ways:**

1. **Fewer setups form.** The Chrome sequence (CISD breaks a consolidation → retrace into OTE → 5-min IFVG inversion) is a rotational pattern — it needs a range, a break, and a pullback. 9/09 and 9/10 were one-way grinds (9/09 ~29,400 → ~29,050 near-linear). A trend without pullbacks can't produce the sequence, so little arms.

2. **The setups that do form have blown-out stops — this is the bigger effect.** On 9/10 the model re-evaluated one BEAR setup **46 times near the close and rejected all 46**, every one at `riskPoints ~68`, killed by `max_stop_points: 20`. Wide-range trend days push the fib anchors far apart → large stops → the 20pt gate rejects them wholesale. On a rotational day the same setup carries a 5-15pt stop and passes.

**Evidence — ARMED events by live session:**
| date | armed | rejected | notes |
|---|---|---|---|
| 2026-09-07 | 11 | 7 | rotational day; arm stops all 2.25-19.75pt, all under the gate |
| 2026-09-09 | 2 | 9 | one-way down grind |
| 2026-09-10 | 2 | 46 | one-way/choppy down; 45 of 46 rejects are the *same* 68pt-stop setup |

**On "there used to be more":** partly real regime difference, partly that the pre-8/12 (dedup) and pre-7/18 (crosscheck gate) paper logs counted duplicates and structurally-invalid plans the current pipeline filters — the old baseline was inflated.

**Takeaway:** the funnel is behaving as configured. `max_stop_points: 20` (JJ's rule, 2026-07-17) is the single largest filter and it bites hardest on high-volatility one-way days — exactly the last two sessions. No change warranted; noting it so a future low-signal stretch isn't mistaken for a regression.

---

## 2026-09-17 — Live: dollar-risk-normalized position sizing (backtest-gated, only the half that worked)

JJ asked why stops run 20-60pt+ on some setups and whether we could just cap the stop distance at 15-20pt instead of rejecting those trades. Answer: the stop is the IFVG's real invalidation extreme, not an arbitrary distance — shrinking it below that puts the stop inside still-valid structure (the same failure mode already found and fixed 2026-07-26 in the opposite direction, PROPOSALS #7's tightest-stop hunting). The alternative worth testing wasn't a smaller stop, it was smaller *size* on a wide stop — bound dollar risk, not point risk.

**Backtested first (`backtest/compare-stop-sizing.mjs`, new script; `engine.mjs`'s `buildPlan` gained `opts.maxStopPointsOverride`, additive, default reproduces the shipped 20pt gate exactly — regression-verified clean).** Same 26-day/09:30-11:30 ET fixture as every other comparison this month.

| variant | trades | cum $ (size=1 unless noted) |
|---|---|---|
| current (20pt reject, shipped) | 20 | $4,284.95 |
| no cap, fixed size 1 | 102 | -$12,986.15 |
| no cap, $-normalized size | 102 | +$14,993.60 |

The headline "+$14,993.60" is misleading on its own. Decomposed:
- The original 20 trades, just re-sized (up to 10 contracts on the tightest stops): **+$32,264.70**
- The 81 newly-admitted wide-stop trades (>20pt, previously rejected): **-$17,271.10**

**The wide-stop trades themselves lose money, confirmed — not just theorized.** That validates the original 20pt cap's reasoning (a stop that wide usually means the anchor/inversion reference is wrong, not that it's a valid-but-large setup) rather than overturning it. The entire apparent gain comes from a different, separable idea: sizing UP the tight-stop trades that were already being taken.

**Shipped live, 2026-09-17, scoped to that separable idea only — the 20pt reject gate is untouched:**
- `topstep-live-poller.mjs`: replaced the fixed `ORDER_SIZE=3` (2026-09-16) with `sizeForRisk(riskPoints)` — `max(1, min(MAX_CONTRACTS, floor(TARGET_DOLLAR_RISK / (riskPoints * $20))))`. `TARGET_DOLLAR_RISK=1200` matches this week's live 3-contract sizing *at the 20pt ceiling* (not a new risk appetite); `MAX_CONTRACTS=8` is a hard tail-risk ceiling the backtest itself never needed (purely retrospective) — without one a 2pt stop sizes to 30 contracts, an unrealistic, execution-risk-heavy position no matter how tight the stop looks on paper. At the boundary (20pt) this reproduces exactly this week's fixed 3-contract behavior; below it, size scales up (checked: 2pt→8 contracts/$320 actual risk, 10pt→6/$1,200, 20pt→3/$1,200).
- `size` is now recorded per-trade in the candidates registry (`sessions/*-topstep-live-candidates.json`) — needed because size is no longer constant.
- `dashboard-data.mjs`'s live-trading $ math **was silently assuming 1 contract** since it was built (2026-09-08) — wrong since the 2026-09-16 fixed-size-3 change, and would have been meaningless under variable sizing. Fixed to multiply by the recorded `size` (falls back to 1 for older records, their real actual size at the time).

**Not live-tested yet** — this is the first session it runs. Same caveat as every backtest number this project has produced: single 26-day in-sample fixture, no train/test split (`RUNBOOK.md`'s known gap). The up-sized tight-stop trades are concentrated in a handful of the same 20 known trades (likely the existing 3 TP1 winners, now heavily levered) — higher variance and higher overfitting risk than the baseline, flagged plainly, not hidden behind the aggregate backtest number.
