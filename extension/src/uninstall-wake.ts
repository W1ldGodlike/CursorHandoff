import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { removeWakeStartupShortcut } from './wake-startup.js';

const execAsync = promisify(exec);

export async function uninstallCursorWake(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('CursorWake is available on Windows only.');
  }

  try {
    await execAsync('taskkill /IM CursorWake.exe /F', { windowsHide: true });
  } catch {
    /* not running */
  }

  await removeWakeStartupShortcut();

  const installDir = join(process.env.LOCALAPPDATA ?? '', 'CursorWake');
  if (existsSync(installDir)) {
    rmSync(installDir, { recursive: true, force: true });
  }
}
