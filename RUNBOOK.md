# RUNBOOK

Operational how-to for the pieces of this project you actually run day to
day. This file didn't exist before 2026-09-06 — created alongside the
dashboard build below. Add to it as new run-commands get built; don't let
it drift the way `PROPOSALS.md`/`reports/` apparently did (see EVOLUTION.md
2026-09-06 for that finding).

## Trading Dashboard (read-only, local)

```bash
node dashboard-server.mjs
```

Opens on **http://localhost:3000**. Single command, no build step, no
dependencies beyond what's already in `package.json`.

- **Read-only** — reads `sessions/*.jsonl`, `sessions/*-candidates.json`,
  `sessions/*-rebalance-summary.json`, `EVOLUTION.md`, `rules.json`,
  `backtest/baseline.json`, `backtest/sessions.json`. Never writes to any of
  them, never places or modifies an order, never signals a poller process
  (it only reads `ps aux` to report whether one happens to be running).
- Auto-refreshes every 30s in the browser — just leave the tab open.
- Safe to run alongside a live paper or real-money poller session; they
  don't share any state.
- Custom port: `DASHBOARD_PORT=4000 node dashboard-server.mjs`.
- Stop with Ctrl+C in the terminal it's running in.

**Auto-starts at login** (macOS LaunchAgent, added 2026-09-06):
`~/Library/LaunchAgents/com.jjcurtis.trading-dashboard.plist`. Starts once
when you log in; does NOT auto-restart if you kill it yourself (only on
your next login, or a manual `launchctl kickstart`). Logs to
`/tmp/trading-dashboard.log`.
- Check it's running: `launchctl list | grep trading-dashboard`
- Stop it for this login session: `launchctl unload ~/Library/LaunchAgents/com.jjcurtis.trading-dashboard.plist`
- Turn off auto-start permanently: same `unload` command, then delete the plist file
- Re-enable: `launchctl load -w ~/Library/LaunchAgents/com.jjcurtis.trading-dashboard.plist`

Sections: header cards (price/session/poller status/scored calls/
cumulative R & $/win rate/streak), **⚠ Live Trading — Real Money** (this
eval's actual trades — planned vs. real fill price, outcome, exit, points,
$; sourced from `sessions/*-topstep-live-candidates.json`, which
`topstep-live-poller.mjs` writes automatically as trades progress, added
2026-09-08), Live Setups (today's latest scan),
Equity Curve, Gate Analytics (funnel — where candidates die), Daily $ P&L
(1 NQ, paper trades), Trade Journal (sortable/filterable), Breakdown Stats (by model/
detection path/A+ overlap/session type — grade and re-arm show "no data",
see below), Audit Panel (bootstrap CI + a live regression re-run against
`backtest/baseline.json`), System Health (recent EVOLUTION.md entries,
open proposals, known limitations).

**Known real gaps in the underlying data** (the dashboard shows these
honestly as "no data" rather than fabricate them — see `dashboard-data.mjs`
for exactly which function hits which gap):
- `PROPOSALS.md`, `SCOREBOARD.md`, and the whole `reports/` directory do
  not exist in this project, despite being referenced throughout
  `EVOLUTION.md`'s history as where open proposals / write-ups live.
- No A/B/C categorical grade exists anywhere in the data — Chrome's
  `grade` field is free text, not a letter grade (rules.json's own
  "grading" note already flags this as an unresolved spec ambiguity).
- Detection path (`single-candle`/`grind`) and re-arm-vs-first-attempt
  status are computed in-memory by `shadow-poller.mjs` during a live run
  but never written to the persisted `*-candidates.json` summary. Path is
  recoverable after the fact by re-scanning the raw JSONL logs (the
  dashboard does this); re-arm status is not recoverable at all.
- No holdout/train-test split methodology exists — every backtest number
  produced so far is in-sample.

## Paper pollers (shadow / rebalance — no real orders)

```bash
node shadow-poller.mjs "HH:MM"       # Chrome + Brian's, Discord alerts, cutoff in ET
node rebalance-poller.mjs "HH:MM"    # Rebalance Model, same cutoff convention
```

Both log to `sessions/<date>.jsonl` / `sessions/<date>-rebalance.jsonl`
and their `*-candidates.json` / `*-rebalance-summary.json` summaries —
exactly what the dashboard above reads. Requires TradingView Desktop open
with CDP enabled and the chart on `CME_MINI:NQ1!` (`tv_health_check` /
`tv_launch` via the MCP tools verify/fix this).

## Live trading (real orders — TopstepX/ProjectX Gateway API)

```bash
node topstep-live-poller.mjs "HH:MM"                    # cutoff only, starts watching immediately
node topstep-live-poller.mjs "07:00" "10:00"             # START then CUTOFF — waits until START to begin watching
node topstep-live-poller.mjs "2026-09-11 07:00" "2026-09-11 10:00"   # absolute form, spans midnight safely
```

or double-click **`Start Live Trading.command`** in this directory (prompts
for both start and cutoff — leave start blank for the old "begin
immediately" behavior).

**Pre-flight (`node preflight.mjs`)** — read-only, run it ~10 min before
the start. Checks CDP/TradingView is up and on an NQ chart, no poller
already running, TopstepX auth + account `27357686` (canTrade, balance
sane), and that the NQ front-month contract still resolves. Prints
GO/NO-GO. It cannot see whether TopstepX is logged in or Auto-OCO Brackets
are on — those stay manual. **`Tomorrow 7-10.command`** is a zero-prompt
double-click launcher pinned to `07:00`->`10:00` ET that runs pre-flight
first and won't start the poller if it fails.

**Launching the night before (2026-09-10 fix):** session log/candidates
filenames come from the START date now, not the moment you hit enter. A
plain `"07:00"` start whose time has already passed in ET is taken to mean
*tomorrow* and the files are named for tomorrow's date; the absolute form
(`"2026-09-11 07:00"`) is always unambiguous. Before this, a poller started
the evening before wrote its files under the launch day's date — which is
why 2026-09-09's session A landed in the misdated
`sessions/2026-09-08-topstep-live.jsonl`.

**Places real orders automatically, no confirm step, the moment a Chrome
signal ARMs.** Only ever run this while physically at the machine that's
running it — see the file's own header comment for the full reasoning.
Account/contract are resolved immediately on launch even with a future
START time, so a bad config still fails fast rather than waiting silently.
Daily caps (+$1,550 profit / -$1,800 loss, `rules.json`
`hard_constraints.daily_caps_enforcement`) halt new entries but don't
auto-close anything already open. Trades **full-size NQ** (not MNQ — $20/pt,
switched 2026-09-06 at JJ's request; 10x MNQ's dollar risk per point, same
stop sizes). Account `27357686` (`50KTC-V2-104488-58851500`, the current
active 50K Trading Combine — replaced `27156343` on 2026-09-06 after an eval
reactivation issued a new account id) only — the Express account is
permanently excluded, never referenced anywhere in the code path. Requires
**Auto-OCO Brackets** enabled in TopstepX (Settings → Risk Settings →
Brackets) — Position Brackets (the older default) rejects the API's
bracket-order format outright.

**Stopping it mid-session (2026-09-10):** Ctrl+C (or closing the terminal
window, which sends the same signal) now makes one best-effort attempt to
resolve whatever trade is still open against real TopstepX order/position
history and write it to the JSONL log + candidates file *before* the process
exits — hit it again to force-quit without waiting. Cutoff does the same
final check before writing its own `STOP` line. Before this fix, killing the
process (or a trade landing right at cutoff) could drop a real trade's
outcome from every file with no trace it ever happened — confirmed live
2026-09-09: one trade's candidates entry never got created at all, another's
stayed stuck at `filled: false` after it had actually filled and lost money;
the account balance was the only place either was recorded. If a
`SESSION_END_UNRESOLVED_TRADE` event shows up in a session's `.jsonl`, the
reconciliation attempt itself failed (e.g. a network blip on the way out) —
check TopstepX directly and fix the candidates file by hand for that trade.

## Regression / backtest

```bash
node backtest/run-regression.mjs              # compare current code vs backtest/baseline.json
node backtest/run-regression.mjs --write      # re-seed the baseline (only after a reviewed change)
node backtest/run-extended-backtest.mjs [fixturePath]   # full 09:30-11:30 ET stats across a whole fixture
```

The dashboard's Audit Panel re-runs the same two frozen baseline days
live, every time you load the page — that's the "last walk-forward
result" you see there, not a cached number.
