import { spawn, exec } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { syncWakeConfig } from './wake-config.js';

const execAsync = promisify(exec);

export interface CursorWakeStatus {
  installed: boolean;
  running: boolean;
  processCount: number;
  raiseCursor: boolean;
  exePath: string;
}

export function wakeExePath(): string {
  return join(process.env.LOCALAPPDATA ?? '', 'CursorWake', 'CursorWake.exe');
}

export async function countCursorWakeProcesses(): Promise<number> {
  try {
    const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq CursorWake.exe" /FO CSV /NH', {
      windowsHide: true,
    });
    return stdout.split(/\r?\n/).filter(line => /CursorWake\.exe/i.test(line)).length;
  } catch {
    return 0;
  }
}

function readRaiseCursor(dataDir: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, 'cursor-wake-state.json'), 'utf-8')) as {
      raiseCursor?: boolean;
    };
    return raw.raiseCursor !== false;
  } catch {
    return true;
  }
}

/** Same file as server `cursor-wake-state.json` — /pause /resume / tray. */
export function writeRaiseCursor(dataDir: string, raiseCursor: boolean): void {
  try {
    writeFileSync(
      join(dataDir, 'cursor-wake-state.json'),
      JSON.stringify({
        raiseCursor,
        updatedAt: new Date().toISOString(),
        updatedBy: 'cursor-handoff',
      }, null, 2),
    );
  } catch (err) {
    console.warn('[wake-launcher] writeRaiseCursor:', err instanceof Error ? err.message : err);
  }
}

export async function getCursorWakeStatus(dataDir: string): Promise<CursorWakeStatus> {
  const exePath = wakeExePath();
  const processCount = process.platform === 'win32' ? await countCursorWakeProcesses() : 0;
  return {
    installed: existsSync(exePath),
    running: processCount > 0,
    processCount,
    raiseCursor: readRaiseCursor(dataDir),
    exePath,
  };
}

function readLockPid(lockPath: string): number | null {
  try {
    const pid = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { windowsHide: true });
    return stdout.includes(`"${pid}"`);
  } catch {
    return false;
  }
}

/** True when exactly one Wake process holds the lock in this data dir. */
async function wakeHealthyForDataDir(dataDir: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  if ((await countCursorWakeProcesses()) !== 1) return false;
  const pid = readLockPid(join(dataDir, 'cursor-wake-instance.lock'));
  if (!pid) return false;
  return isProcessRunning(pid);
}

function spawnWake(exe: string, dataDir: string, log?: (msg: string) => void): void {
  const child = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: join(exe, '..'),
    env: { ...process.env, DATA_DIR: dataDir },
  });
  child.on('error', (err) => {
    log?.(`spawn error: ${err.message}`);
  });
  child.unref();
}

/** Start Wake if installed and not already running (single-instance in exe). */
export async function ensureCursorWakeRunning(
  dataDir: string,
  log?: (msg: string) => void,
): Promise<void> {
  if (process.platform !== 'win32') return;

  const exe = wakeExePath();
  if (!existsSync(exe)) {
    log?.(`not installed (expected ${exe})`);
    return;
  }

  syncWakeConfig(dataDir);

  if (await wakeHealthyForDataDir(dataDir)) {
    log?.('already running');
    return;
  }

  if ((await countCursorWakeProcesses()) > 0) {
    log?.('stale instance — restarting');
    await restartCursorWake(dataDir, log);
    return;
  }

  spawnWake(exe, dataDir, log);
  log?.('started');
}

/** Restart Wake: stop + start with current DATA_DIR. */
export async function restartCursorWake(
  dataDir: string,
  log?: (msg: string) => void,
): Promise<void> {
  if (process.platform !== 'win32') return;

  const exe = wakeExePath();
  if (!existsSync(exe)) {
    log?.(`not installed (expected ${exe})`);
    return;
  }

  try {
    await execAsync('taskkill /IM CursorWake.exe /F', { windowsHide: true });
    log?.('stopped');
  } catch {
    /* process may not exist */
  }

  await sleep(800);
  syncWakeConfig(dataDir);
  spawnWake(exe, dataDir, log);
  log?.('restarted');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
