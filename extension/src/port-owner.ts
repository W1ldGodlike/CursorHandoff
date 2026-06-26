import { execFile } from 'child_process';

export interface PortOwnerInfo {
  pid: number;
  processName: string;
  commandLine: string;
}

const HANDOFF_BUNDLE_RE = /bundle\.mjs/i;

export function isHandoffBundleProcess(owner: PortOwnerInfo | null): boolean {
  if (!owner?.pid) return false;
  return HANDOFF_BUNDLE_RE.test(owner.commandLine);
}

/** Port listener is our server (lock PID or bundle.mjs in command line). */
export function isHandoffPortOwner(
  owner: PortOwnerInfo | null,
  lockPid: number | null | undefined,
): boolean {
  if (!owner?.pid) return false;
  if (lockPid && owner.pid === lockPid) return true;
  return isHandoffBundleProcess(owner);
}

function execFileAsync(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function getPortOwnerWindows(port: number): Promise<PortOwnerInfo | null> {
  const ps = [
    `$conn = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    'if (-not $conn) { return }',
    '$ownPid = [int]$conn.OwningProcess',
    '$proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ownPid" -ErrorAction SilentlyContinue',
    'if (-not $proc) { @{ pid=$ownPid; processName="unknown"; commandLine="" } | ConvertTo-Json -Compress; return }',
    '@{ pid=$ownPid; processName=[string]$proc.Name; commandLine=[string]$proc.CommandLine } | ConvertTo-Json -Compress',
  ].join('; ');
  const out = (await execFileAsync('powershell', ['-NoProfile', '-Command', ps])).trim();
  if (!out) return null;
  const parsed = JSON.parse(out) as { pid?: number; processName?: string; commandLine?: string };
  if (!parsed.pid) return null;
  return {
    pid: parsed.pid,
    processName: parsed.processName ?? 'unknown',
    commandLine: parsed.commandLine ?? '',
  };
}

async function getPortOwnerPosix(port: number): Promise<PortOwnerInfo | null> {
  const out = (await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'])).trim();
  if (!out) return null;
  let pid = 0;
  let processName = 'unknown';
  let commandLine = '';
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('p') && !pid) {
      pid = Number(line.slice(1)) || 0;
    } else if (line.startsWith('c') && processName === 'unknown') {
      processName = line.slice(1).trim() || 'unknown';
    }
  }
  if (!pid) return null;
  commandLine = processName;
  return { pid, processName, commandLine };
}

export async function getPortOwner(port: number): Promise<PortOwnerInfo | null> {
  try {
    if (process.platform === 'win32') return await getPortOwnerWindows(port);
    return await getPortOwnerPosix(port);
  } catch {
    return null;
  }
}

export async function killProcessByPid(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(pid), '/F']);
    return;
  }
  process.kill(pid, 'SIGKILL');
}
