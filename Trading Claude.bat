@echo off
rem One-click: open Claude Code in the trading-bot folder and run /trading,
rem which loads CLAUDE.md + STATUS.md, runs the read-only pre-flight and
rem reports what's open. Does NOT start the live poller.
cd /d "%~dp0"
title Trading Claude
claude "/trading"
pause
