#!/bin/bash
# Double-click launcher pinned to a 07:00 -> 10:00 ET live session.
# No prompts — the times are fixed. Runs pre-flight first and refuses to
# start the poller if pre-flight fails.
#
# Same precondition as every other way of starting this: JJ double-clicks
# it, physically at this Mac. Claude never launches it.
cd "$(dirname "$0")"
echo "=== Live session: 07:00 -> 10:00 ET ==="
echo "This places REAL orders on TopstepX the moment a signal ARMs."
echo ""
echo "--- pre-flight ---"
node preflight.mjs
if [ $? -ne 0 ]; then
  echo ""
  echo "Pre-flight failed — NOT starting the poller. Fix the above and re-run."
  echo "Press any key to close."
  read -n 1
  exit 1
fi
# Resolve the NEXT upcoming 07:00 ET as an explicit YYYY-MM-DD so the
# session files are never named off the wrong day. Before 07:00 ET -> today;
# at/after 07:00 ET -> tomorrow.
SESSION_DATE=$(TZ=America/New_York node -e '
const now = new Date();
const hhmm = now.toLocaleTimeString("en-GB",{timeZone:"America/New_York",hour12:false}).slice(0,5);
const base = now.toLocaleDateString("en-CA",{timeZone:"America/New_York"});
if (hhmm >= "07:00") { const d = new Date(base+"T12:00:00Z"); d.setUTCDate(d.getUTCDate()+1);
  console.log(d.toLocaleDateString("en-CA",{timeZone:"America/New_York"})); }
else console.log(base);
')
echo ""
echo "Resolved session: ${SESSION_DATE} 07:00 -> ${SESSION_DATE} 10:00 ET"
read -p "Pre-flight passed. Start the live poller now? (y/N): " GO
if [ "$GO" != "y" ] && [ "$GO" != "Y" ]; then
  echo "Not started. Press any key to close."
  read -n 1
  exit 0
fi
echo ""
echo "Starting. Will wait until ${SESSION_DATE} 07:00 ET, then watch until 10:00 ET."
echo "Ctrl+C once = reconcile any open trade then exit. Twice = force-quit."
echo ""
node topstep-live-poller.mjs "${SESSION_DATE} 07:00" "${SESSION_DATE} 10:00"
echo ""
echo "Session ended. Press any key to close this window."
read -n 1
