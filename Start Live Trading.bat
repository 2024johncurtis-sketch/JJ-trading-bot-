@echo off
rem Double-click launcher for topstep-live-poller.mjs (Windows twin of
rem "Start Live Trading.command"). A shortcut for JJ's own hands only -- Claude
rem never launches the live poller; you must be physically at this machine.
cd /d "%~dp0"
echo === TopStep Live Trading Launcher ===
echo This places REAL orders on your TopstepX account the moment it fires.
echo.
set "START="
set "CUTOFF="
set /p START=Start time in ET, e.g. 07:00 or "2026-09-07 07:00" (blank = start watching immediately):
set /p CUTOFF=Cutoff time in ET, e.g. 10:00 (blank = 10:00):
if "%CUTOFF%"=="" set "CUTOFF=10:00"
echo.
if not "%START%"=="" (
  echo Launching now - will WAIT until %START% ET to begin watching for signals, then stop at %CUTOFF% ET...
  echo.
  node topstep-live-poller.mjs "%START%" "%CUTOFF%"
) else (
  echo Starting immediately, cutoff %CUTOFF% ET...
  echo.
  node topstep-live-poller.mjs "%CUTOFF%"
)
echo.
echo Session ended.
pause
