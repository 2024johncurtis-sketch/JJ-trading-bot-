---
description: Load JJ's trading-bot context, run the read-only pre-flight, and report what's open
---

Bring me up to speed on the trading bot so we can pick up where we left off.

1. Read `CLAUDE.md` (my profile and how I want you to work), `STATUS.md`
   (current state and open items) and the "Live trading" section of `RUNBOOK.md`.
2. Run `node preflight.mjs` from the repo root. It is read-only — it never
   places orders. Do NOT run `topstep-live-poller.mjs`, either launcher `.bat`,
   or anything that could touch a live account.
3. Run `git status -sb` and `git log --oneline -5`, and say whether anything is
   uncommitted or unpushed.
4. Check whether the dashboard is up: `http://localhost:3000`.
5. Report back briefly, in this order: pre-flight result (each check OK/FAIL),
   git state, dashboard state, then my open items from `STATUS.md` with any that
   now look done or newly blocked. Show times in ET with the CT equivalent.
   If pre-flight says `canTrade=false`, treat it as my intentional lockout —
   report it, don't work around it.
6. Never print credentials or API keys, and never put them in `STATUS.md`.
   Then ask what I want to work on.

Keep it short and neutral. If `STATUS.md` is out of date after what we do, offer
to update it before the session ends.
