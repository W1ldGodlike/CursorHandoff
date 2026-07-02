import { exec } from 'child_process';
import { promisify } from 'util';
import { formatExtensionLogLine } from './log-event.js';

const execAsync = promisify(exec);

function psEncoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

async function runPowerShell(script: string): Promise<string> {
  const { stdout } = await execAsync(
    `powershell -NoProfile -EncodedCommand ${psEncoded(script)}`,
    { windowsHide: true },
  );
  return stdout;
}

/** PIDs listening on TCP port (LISTEN). */
async function pidsListeningOnPort(port: number): Promise<number[]> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execAsync('netstat -ano -p tcp', { windowsHide: true });
      const pids = new Set<number>();
      const needle = `:${port}`;
      for (const line of stdout.split('\n')) {
        if (!line.includes(needle) || !line.includes('LISTENING')) continue;
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (Number.isFinite(pid) && pid > 0) pids.add(pid);
      }
      return [...pids];
    } catch {
      return [];
    }
  }

  try {
    const { stdout } = await execAsync(`lsof -tiTCP:${port} -sTCP:LISTEN`, { windowsHide: true });
    return stdout
      .trim()
      .split(/\s+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

async function isHandoffBundlePid(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      const script =
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -EA SilentlyContinue; ` +
        `if ($p -and $p.CommandLine -match 'bundle\\.mjs') { 'yes' }`;
      return (await runPowerShell(script)).trim() === 'yes';
    } catch {
      return false;
    }
  }

  try {
    const { stdout } = await execAsync(`ps -p ${pid} -o command=`, { windowsHide: true });
    return stdout.includes('bundle.mjs');
  } catch {
    return false;
  }
}

/** Cursor.exe running bundle.mjs — CursorHandoff server only. */
async function listBundlePids(): Promise<number[]> {
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execAsync('pgrep -f bundle\\.mjs', { windowsHide: true });
      return stdout
        .trim()
        .split(/\s+/)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch {
      return [];
    }
  }

  try {
    const stdout = await runPowerShell(
      "Get-CimInstance Win32_Process -Filter \"Name='Cursor.exe'\" -EA SilentlyContinue " +
      "| Where-Object { $_.CommandLine -match 'bundle\\.mjs' } " +
      '| ForEach-Object { $_.ProcessId }',
    );
    return stdout
      .trim()
      .split(/\s+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

async function killPid(pid: number, log: (msg: string) => void): Promise<void> {
  log(formatExtensionLogLine('info', `kill stale bundle PID ${pid}`, {
    scope: 'extension',
    code: 'SPAWN_STALE_KILL',
  }));
  try {
    if (process.platform === 'win32') {
      await execAsync(`taskkill /PID ${pid} /F /T`, { windowsHide: true });
    } else {
      await execAsync(`kill -9 ${pid}`, { windowsHide: true });
    }
  } catch {
    /* already dead */
  }
}

/**
 * Kill Handoff bundle listeners on the configured port (intentional restart).
 * Safer than blind bundle kill when multiple Cursor windows share one data dir.
 */
export async function killHandoffServerOnPort(
  port: number,
  log: (msg: string) => void,
): Promise<void> {
  const listeners = await pidsListeningOnPort(port);
  for (const pid of listeners) {
    if (await isHandoffBundlePid(pid)) {
      await killPid(pid, log);
    }
  }
  await new Promise((r) => setTimeout(r, 400));
}

/**
 * Before spawn: kill zombie bundle.mjs processes (EADDRINUSE / stolen TG poll).
 * Call when /health still responds but this window must own a fresh server.
 */
export async function killStaleBundleServers(log: (msg: string) => void): Promise<void> {
  const pids = await listBundlePids();
  if (pids.length === 0) return;

  for (const pid of pids) {
    await killPid(pid, log);
  }

  await new Promise((r) => setTimeout(r, 400));
}
