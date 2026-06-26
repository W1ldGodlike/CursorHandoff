import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { formatExtensionLogLine, type LogLevel } from './log-event.js';
import { wakeExePath } from './wake-launcher.js';

const execAsync = promisify(exec);

export interface WakeStartupDeps {
  platform: NodeJS.Platform;
  existsSync: (path: string) => boolean;
  unlinkSync: (path: string) => void;
  execAsync: (cmd: string, opts?: { windowsHide?: boolean }) => Promise<{ stdout: string; stderr: string }>;
  wakeExePath: () => string;
  shortcutPath: () => string;
}

export function defaultWakeStartupDeps(): WakeStartupDeps {
  return {
    platform: process.platform,
    existsSync,
    unlinkSync,
    execAsync,
    wakeExePath,
    shortcutPath: wakeStartupShortcutPath,
  };
}

function wakeStartupLog(
  log: ((msg: string) => void) | undefined,
  level: LogLevel,
  message: string,
  code: string,
  op?: string,
): void {
  log?.(formatExtensionLogLine(level, message, { scope: 'wake', code, op }));
}

export function wakeStartupShortcutPath(): string {
  const appData = process.env.APPDATA ?? '';
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'CursorWake.lnk');
}

export function isWakeStartupShortcutPresent(deps: WakeStartupDeps = defaultWakeStartupDeps()): boolean {
  return deps.existsSync(deps.shortcutPath());
}

export async function createWakeStartupShortcut(
  exePath: string,
  installDir: string,
  log?: (msg: string) => void,
  deps: WakeStartupDeps = defaultWakeStartupDeps(),
): Promise<void> {
  const ps = [
    '$Wsh = New-Object -ComObject WScript.Shell',
    `$lnk = '${deps.shortcutPath().replace(/'/g, "''")}'`,
    '$Link = $Wsh.CreateShortcut($lnk)',
    `$Link.TargetPath = '${exePath.replace(/'/g, "''")}'`,
    `$Link.WorkingDirectory = '${installDir.replace(/'/g, "''")}'`,
    '$Link.Description = "CursorWake - Telegram companion for CursorHandoff"',
    '$Link.Save()',
  ].join('; ');
  await deps.execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`, { windowsHide: true });
  wakeStartupLog(log, 'info', 'startup shortcut created', 'WAKE_STARTUP_CREATED', 'create');
}

export async function removeWakeStartupShortcut(
  log?: (msg: string) => void,
  deps: WakeStartupDeps = defaultWakeStartupDeps(),
): Promise<boolean> {
  const path = deps.shortcutPath();
  if (deps.existsSync(path)) {
    deps.unlinkSync(path);
    wakeStartupLog(log, 'info', 'startup shortcut removed', 'WAKE_STARTUP_REMOVED', 'remove');
    return true;
  }
  return false;
}

/** Apply cursorHandoff.wake.startupEnabled to Startup folder. */
export async function applyWakeStartupSetting(
  enabled: boolean,
  log?: (msg: string) => void,
  deps: WakeStartupDeps = defaultWakeStartupDeps(),
): Promise<void> {
  if (deps.platform !== 'win32') return;
  if (!enabled) {
    await removeWakeStartupShortcut(log, deps);
    return;
  }
  const exe = deps.wakeExePath();
  if (!deps.existsSync(exe)) {
    wakeStartupLog(log, 'info', `not installed (expected ${exe})`, 'WAKE_STARTUP_SKIP_NO_EXE', 'apply');
    return;
  }
  await createWakeStartupShortcut(exe, join(exe, '..'), log, deps);
}
