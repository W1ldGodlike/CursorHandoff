/**
 * pretest: stale node --test / tsx --test from this repo (often web-client.test.ts + jsdom, 2–3 GB).
 * Does not touch bundle.mjs / CursorHandoff server — spawn-cleanup is in extension.
 */
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { basename, dirname } from 'path';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoName = basename(repoRoot);
const myPid = process.pid;

function matchesStaleTest(cmd) {
  if (!cmd) return false;
  const inRepo =
    cmd.includes(repoRoot) ||
    cmd.includes(repoName) ||
    /tests[\\/][^"']+\.test\.ts/i.test(cmd) ||
    /tests[\\/]_debug-mermaid/i.test(cmd);
  if (!inRepo) return false;
  if (/\.test\.ts/i.test(cmd)) {
    return /--test\b/.test(cmd) || /\btsx\b/.test(cmd) || /node\.exe"\s+--test/i.test(cmd);
  }
  return /_debug-mermaid/i.test(cmd);
}

function killPids(pids) {
  const uniq = [...new Set(pids)].filter((p) => p > 0 && p !== myPid);
  if (uniq.length === 0) return;
  for (const pid of uniq) {
    console.log(`[pretest] kill stale test runner PID ${pid}`);
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
  }
}

if (process.platform === 'win32') {
  const rootLit = repoRoot.replace(/'/g, "''");
  const nameLit = repoName.replace(/'/g, "''");
  const ps = `
$root = '${rootLit}'
$name = '${nameLit}'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
  Where-Object {
    $c = $_.CommandLine
    if (-not $c) { return $false }
  $inRepo = $c.Contains($root) -or $c.Contains($name) -or $c -match 'tests[\\\\/][^"'' ]+\\.test\\.ts' -or $c -match '_debug-mermaid'
    if (-not $inRepo) { return $false }
    if ($c -match '\\.test\\.ts') {
      return ($c -match '--test' -or $c -match 'tsx' -or $c -match 'node\\.exe.*--test')
    }
    return ($c -match '_debug-mermaid')
  } |
  ForEach-Object { $_.ProcessId }
`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  const pids = (r.stdout || '')
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  killPids(pids);
} else {
  const r = spawnSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' });
  const pids = [];
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (matchesStaleTest(m[2])) pids.push(pid);
  }
  killPids(pids);
}
