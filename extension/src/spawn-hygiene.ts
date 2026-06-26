import { exec } from 'child_process';
import { promisify } from 'util';
import { formatExtensionLogLine } from './log-event.js';

const execAsync = promisify(exec);

/** Cursor.exe running bundle.mjs — CursorHandoff server only. */
async function listBundlePids(): Promise<number[]> {
  if (process.platform !== 'win32') return [];

  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='Cursor.exe'\" -EA SilentlyContinue " +
    "| Where-Object { $_.CommandLine -match 'bundle\\.mjs' } " +
    '| ForEach-Object { $_.ProcessId }';

  try {
    const { stdout } = await execAsync(`powershell -NoProfile -Command "${script}"`, {
      windowsHide: true,
    });
    return stdout
      .trim()
      .split(/\s+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Before spawn: kill zombie bundle.mjs processes (EADDRINUSE / stolen TG poll).
 * Call only when /health does not respond.
 */
export async function killStaleBundleServers(log: (msg: string) => void): Promise<void> {
  const pids = await listBundlePids();
  if (pids.length === 0) return;

  for (const pid of pids) {
    log(formatExtensionLogLine('info', `kill stale bundle PID ${pid}`, {
      scope: 'extension',
      code: 'SPAWN_STALE_KILL',
    }));
    try {
      await execAsync(`taskkill /PID ${pid} /F /T`, { windowsHide: true });
    } catch {
      /* already dead */
    }
  }

  await new Promise((r) => setTimeout(r, 400));
}
