@echo off
rem Double-click launcher pinned to a 07:00 -> 10:00 ET live session (Windows
rem twin of "Tomorrow 7-10.command"). Runs pre-flight first and refuses to
rem start the poller if pre-flight fails. Claude never launches this; you must
rem be physically at this machine.
cd /d "%~dp0"
echo === Live session: 07:00 -^> 10:00 ET ===
echo This places REAL orders on TopstepX the moment a signal ARMs.
echo.
echo --- pre-flight ---
node preflight.mjs
if errorlevel 1 (
  echo.
  echo Pre-flight failed - NOT starting the poller. Fix the above and re-run.
  pause
  exit /b 1
)
set "SESSION_DATE="
for /f %%d in ('node resolve-session-date.mjs') do set "SESSION_DATE=%%d"
if "%SESSION_DATE%"=="" (
  echo Could not resolve the session date - NOT starting the poller.
  pause
  exit /b 1
)
echo.
echo Resolved session: %SESSION_DATE% 07:00 -^> %SESSION_DATE% 10:00 ET
set "GO="
set /p GO=Pre-flight passed. Start the live poller now? (y/N):
if /i not "%GO%"=="y" (
  echo Not started.
  pause
  exit /b 0
)
echo.
echo Starting. Will wait until %SESSION_DATE% 07:00 ET, then watch until 10:00 ET.
echo Ctrl+C once = reconcile any open trade then exit. Twice = force-quit.
echo.
node topstep-live-poller.mjs "%SESSION_DATE% 07:00" "%SESSION_DATE% 10:00"
echo.
echo Session ended.
pause
