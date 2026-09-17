#!/bin/bash
# Double-click launcher for topstep-live-poller.mjs.
#
# This exists so JJ doesn't have to type the full command by hand each
# morning. It does NOT change who starts the process or when — Claude still
# never launches topstep-live-poller.mjs; this is purely a shortcut for JJ's
# own hands, still requiring him to be physically at this Mac to double-click
# it (same precondition the poller's own file header documents).
cd "$(dirname "$0")"
echo "=== TopStep Live Trading Launcher ==="
echo "This places REAL orders on your TopstepX account the moment it fires."
echo ""
read -p "Start time in ET, e.g. 07:00 or '2026-09-07 07:00' (blank = start watching immediately): " START
read -p "Cutoff time in ET, e.g. 10:00 (blank = 10:00): " CUTOFF
CUTOFF="${CUTOFF:-10:00}"
echo ""
if [ -n "$START" ]; then
  echo "Launching now — will WAIT until ${START} ET to begin watching for signals, then stop at ${CUTOFF} ET..."
  echo ""
  node topstep-live-poller.mjs "$START" "$CUTOFF"
else
  echo "Starting immediately, cutoff ${CUTOFF} ET..."
  echo ""
  node topstep-live-poller.mjs "$CUTOFF"
fi
echo ""
echo "Session ended. Press any key to close this window."
read -n 1
