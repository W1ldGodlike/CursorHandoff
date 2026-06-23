import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { wakeExePath } from './wake-launcher.js';

const execAsync = promisify(exec);

export function wakeStartupShortcutPath(): string {
  const appData = process.env.APPDATA ?? '';
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'CursorWake.lnk');
}

export function isWakeStartupShortcutPresent(): boolean {
  return existsSync(wakeStartupShortcutPath());
}

export async function createWakeStartupShortcut(exePath: string, installDir: string): Promise<void> {
  const ps = [
    '$Wsh = New-Object -ComObject WScript.Shell',
    `$lnk = '${wakeStartupShortcutPath().replace(/'/g, "''")}'`,
    '$Link = $Wsh.CreateShortcut($lnk)',
    `$Link.TargetPath = '${exePath.replace(/'/g, "''")}'`,
    `$Link.WorkingDirectory = '${installDir.replace(/'/g, "''")}'`,
    '$Link.Description = "CursorWake - Telegram companion for CursorHandoff"',
    '$Link.Save()',
  ].join('; ');
  await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`, { windowsHide: true });
}

export async function removeWakeStartupShortcut(): Promise<void> {
  const path = wakeStartupShortcutPath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/** Apply cursorHandoff.wake.startupEnabled to Startup folder. */
export async function applyWakeStartupSetting(enabled: boolean): Promise<void> {
  if (process.platform !== 'win32') return;
  if (!enabled) {
    await removeWakeStartupShortcut();
    return;
  }
  const exe = wakeExePath();
  if (!existsSync(exe)) return;
  await createWakeStartupShortcut(exe, join(exe, '..'));
}
