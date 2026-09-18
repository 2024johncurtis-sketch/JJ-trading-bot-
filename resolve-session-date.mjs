// Prints the NEXT upcoming 07:00 ET as YYYY-MM-DD, so session files are never
// named off the wrong day. Before 07:00 ET -> today; at/after -> tomorrow.
// Used by "Tomorrow 7-10.bat" (same logic as the inline snippet in the
// macOS "Tomorrow 7-10.command").
const now = new Date();
const hhmm = now.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false }).slice(0, 5);
const base = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
if (hhmm >= '07:00') {
  const d = new Date(base + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  console.log(d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));
} else {
  console.log(base);
}
