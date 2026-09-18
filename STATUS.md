# STATUS — where the project stands

Living handoff note. Read this at the start of a session (the `/trading`
command does). **This repo is public, so keep secrets, account IDs and
balances out of this file** — those live in the gitignored
`topstep-config.json`.

Last updated: 2026-09-18.

## Setup on this machine (Windows, Central Time)

- Repo: `C:\Users\JJ Curtis\JJ-trading-bot`. Started life on a Mac; the Windows
  pieces below were added 2026-09-18.
- Dashboard: http://localhost:3000, auto-starts at login via
  `Trading Dashboard.lnk` in the Startup folder -> `scripts/start-dashboard-hidden.vbs`
  (logs to `sessions/dashboard.log`). Details in `RUNBOOK.md`.
- Launchers: `Start Live Trading.bat` (prompts for start/cutoff) and
  `Tomorrow 7-10.bat` (pre-flight, then 07:00 -> 10:00 ET). Both lead to REAL
  orders — JJ runs them himself, at the machine. Claude never launches the
  live poller.
- Windows helpers: `proc-list.mjs` (process check, replaces `ps aux`),
  `resolve-session-date.mjs` (next 07:00 ET date for the .bat).
- `preflight.mjs` exits via a 250 ms delay to avoid a Node 24/Windows libuv
  crash that would have read as "failed" to the .bat.
- Credentials: `topstep-config.json` (username, apiKey, accountId) and
  `discord-config.json` are gitignored and were filled in locally.

## Account

- `accountId` is set in the local `topstep-config.json`. The old IDs in
  `RUNBOOK.md` / `rules.json` are stale (the Combine was reissued under new
  IDs) — trust the config, and confirm with a read-only account listing.
- JJ sometimes **locks the account himself** as a discipline tool. Then
  pre-flight correctly reports `canTrade=false`. That is intentional: never
  switch accounts, edit the config, or otherwise route around it. Just report it.

## Open items

- [ ] Rotate the TopstepX API key (it was printed into a chat transcript on
      2026-09-18 by mistake).
- [ ] Re-run `node preflight.mjs` once the account lockout lifts; expect ALL GREEN.
- [ ] Turn on **Auto-OCO Brackets** in TopstepX (Settings -> Risk Settings ->
      Brackets). Pre-flight cannot check this.
- [ ] Next real NY-morning session: Monday 2026-09-21, 07:00 ET (6:00 CT).
      `Tomorrow 7-10.bat` resolves the *next* 07:00 ET, so launching on a
      Friday evening or Saturday plans a weekend day — launch Sunday or later, or
      pass an explicit date to `Start Live Trading.bat`.
- [ ] Still Mac-only: the `.command` launchers, the LaunchAgent, and
      `sessions/backtest-engine-2026-07-17.mjs` (hardcoded `/Users/jjcurtis/...` paths).
- [ ] Consider making this GitHub repo private (it exposes `rules.json`,
      `sessions/` trade history and old account IDs).

## Known limits (from CLAUDE.md / EVOLUTION.md)

- All backtest numbers are in-sample — not proof. No holdout split exists.
- Full automation is the goal, not today's reality: the live poller assumes JJ
  is at the machine.
- Regression baseline passes (`node backtest/run-regression.mjs`).

## Keep this file current

When something material changes (account, launch flow, open item done), update
the relevant line and the "Last updated" date, and log pipeline changes in
`EVOLUTION.md`.
