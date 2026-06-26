import { spawn, exec } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { formatExtensionLogLine, type LogLevel } from './log-event.js';
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
export function writeRaiseCursor(dataDir: string, raiseCursor: boolean, log?: (msg: string) => void): void {
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
    const msg = err instanceof Error ? err.message : String(err);
    wakeLog(log, 'warn', `writeRaiseCursor: ${msg}`, 'WAKE_RAISE_CURSOR_FAIL');
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

function wakeLog(
  log: ((msg: string) => void) | undefined,
  level: LogLevel,
  message: string,
  code: string,
): void {
  log?.(formatExtensionLogLine(level, message, { scope: 'wake', code }));
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
    wakeLog(log, 'error', `spawn error: ${err.message}`, 'WAKE_SPAWN_ERR');
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
    wakeLog(log, 'info', `not installed (expected ${exe})`, 'WAKE_NOT_INSTALLED');
    return;
  }

  syncWakeConfig(dataDir);

  const count = await countCursorWakeProcesses();
  if (count > 2) {
    wakeLog(log, 'warn', 'too many instances — restarting', 'WAKE_TOO_MANY');
    await restartCursorWake(dataDir, log);
    return;
  }
  if (count > 0) {
    wakeLog(log, 'info', 'already running', 'WAKE_ALREADY_RUNNING');
    return;
  }

  spawnWake(exe, dataDir, log);
  wakeLog(log, 'info', 'started', 'WAKE_STARTED');
}

/** Restart Wake: stop + start with current DATA_DIR. */
export async function restartCursorWake(
  dataDir: string,
  log?: (msg: string) => void,
): Promise<void> {
  if (process.platform !== 'win32') return;

  const exe = wakeExePath();
  if (!existsSync(exe)) {
    wakeLog(log, 'info', `not installed (expected ${exe})`, 'WAKE_NOT_INSTALLED');
    return;
  }

  try {
    await execAsync('taskkill /IM CursorWake.exe /F', { windowsHide: true });
    wakeLog(log, 'info', 'stopped', 'WAKE_STOPPED');
  } catch {
    /* process may not exist */
  }

  await sleep(800);
  syncWakeConfig(dataDir);
  spawnWake(exe, dataDir, log);
  wakeLog(log, 'info', 'restarted', 'WAKE_RESTARTED');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
