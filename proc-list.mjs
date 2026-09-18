// Cross-platform "what's running" check. Returns one command line per line.
// macOS/Linux: `ps aux`. Windows: command lines of node.exe processes only
// (filtering to node.exe also keeps this lookup's own PowerShell process out
// of the results).
import { execSync } from 'node:child_process';

export function listProcessLines() {
  if (process.platform === 'win32') {
    return execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | ForEach-Object { $_.CommandLine }"',
      { encoding: 'utf8', timeout: 10000 },
    );
  }
  return execSync('ps aux', { encoding: 'utf8', timeout: 3000 });
}

// Matches `node <script>` / `node.exe" "C:\path with spaces\<script>`, but not
// a command line that merely mentions the script name (e.g. `node --check x.mjs`).
function scriptRegex(script) {
  return new RegExp(`node(\\.exe)?"?\\s+"?([^"\\n]*[\\\\/])?${script.replace(/\./g, '\\.')}`);
}

// Matching command lines (for reporting), empty array if none.
export function runningScriptLines(script) {
  let out = '';
  try { out = listProcessLines(); } catch { return []; }
  const re = scriptRegex(script);
  return out.split('\n').filter(line => re.test(line)).map(l => l.trim());
}

// True if a running `node <script>` process matches (script = e.g. 'shadow-poller.mjs').
export function isScriptRunning(script) {
  return runningScriptLines(script).length > 0;
}
