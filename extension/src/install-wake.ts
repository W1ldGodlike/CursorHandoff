import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { downloadToFile, wakeDownloadUrl } from './addon-download.js';
import { resolveWakeSource } from './bundled-paths.js';
import { resolveDataDir } from './paths-settings.js';
import { applyWakeStartupSetting } from './wake-startup.js';
import { writeWakeInstallConfig } from './wake-config.js';

const execAsync = promisify(exec);

function wakeInstallDir(): string {
  return join(process.env.LOCALAPPDATA ?? '', 'CursorWake');
}

async function stopRunningWake(): Promise<void> {
  try {
    await execAsync('taskkill /IM CursorWake.exe /F', { windowsHide: true });
    await sleep(800);
  } catch {
    /* not running */
  }
}

function spawnWake(exePath: string, dataDir: string): void {
  const child = spawn(exePath, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: join(exePath, '..'),
    env: { ...process.env, DATA_DIR: dataDir },
  });
  child.unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireWakeExe(context: vscode.ExtensionContext, dest: string): Promise<'bundled' | 'downloaded'> {
  const bundled = resolveWakeSource(context.extensionPath);
  if (bundled) {
    copyFileSync(bundled, dest);
    return 'bundled';
  }

  const url = wakeDownloadUrl(context.extensionPath);
  await downloadToFile(url, dest);
  return 'downloaded';
}

export async function installCursorWake(context: vscode.ExtensionContext): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('CursorWake is available on Windows only.');
  }

  const installDir = wakeInstallDir();
  mkdirSync(installDir, { recursive: true });
  const dest = join(installDir, 'CursorWake.exe');

  await stopRunningWake();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CursorHandoff: CursorWake',
      cancellable: false,
    },
    async () => acquireWakeExe(context, dest),
  );

  if (!existsSync(dest)) {
    throw new Error('CursorWake install failed — file missing after download.');
  }

  const dataDir = resolveDataDir(context);
  writeWakeInstallConfig(installDir, dataDir);

  const startupEnabled = vscode.workspace
    .getConfiguration('cursorHandoff')
    .get<boolean>('wake.startupEnabled', true);
  await applyWakeStartupSetting(startupEnabled);

  spawnWake(dest, dataDir);

  return dest;
}
