# Backtest engine & regression harness

`engine.mjs` — walk-forward, no-lookahead Chrome-model backtest. Reuses
`scan-chart.mjs`'s real CISD/anchor/fib functions (not a reimplementation),
adds its own FVG/IFVG detector and trade-plan/outcome scoring since no
historical live-indicator tags exist. See `reports/2026-07-17-backtest.md`
and `reports/2026-07-17-recalibration.md` for the write-ups this engine
produced.

## Regression guard

`sessions.json` is the permanent test set. `baseline.json` is the frozen
"known good" metrics (cumulative R, wins/losses, armed/gate-pass counts,
per-path breakdown) from the last approved state of the detection logic.

Before shipping any change to CISD detection, anchor rules, IFVG matching,
or gate thresholds:

```
node run-regression.mjs
```

`PASS` means no session's cumulative R got worse and no session's loss count
went up. `FAIL` means investigate before shipping — a real improvement
should not make the known sessions worse; if it does, either the change is
wrong or the baseline needs a deliberate, reviewed update (not an automatic
one).

After JJ approves a change (see `reports/PROPOSALS.md`) and confirms the new
numbers are intentional, re-seed the baseline:

```
node run-regression.mjs --write
```

## Adding a new session to the test set

1. Capture the day's 3m bars. The live chart only holds ~500 recent bars in
   memory; TradingView's `scrollToDate()` and synthetic mouse-wheel scroll do
   **not** trigger it to load more history. What does: a synthetic
   click-and-drag pan (`mousePressed` → stepped `mouseMoved` → `mouseReleased`
   via CDP `Input.dispatchMouseEvent`) — this pans the chart and triggers
   lazy-loading of older bars. Repeat until `bars.firstIndex()` covers the
   date you need, then extract via
   `chart._chartWidget.model().mainSeries().bars()` (`firstIndex()` /
   `lastIndex()` / `valueAt(i)`), not `getOhlcv()` (capped at 500 bars from
   "now").
2. Save the extracted bars as `fixtures/nq_3m_bars_<range>.json`.
3. Add an entry to `sessions.json` with the session's date/time window and
   fixture path.
4. Run `node run-regression.mjs` — a new session has no baseline yet, so it
   just reports; after reviewing the numbers look sane, run `--write` to
   fold it into the baseline going forward.
