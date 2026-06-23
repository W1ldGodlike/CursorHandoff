import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type * as vscode from 'vscode';
import { cloudflaredDownloadUrl, downloadToFile } from './addon-download.js';
import { resolveCloudflaredSource } from './bundled-paths.js';
import { isCloudflaredInstalled, userCloudflaredPath, windowsCloudflaredPath } from './cloudflared-paths.js';

const execAsync = promisify(exec);

function cloudflaredDestPath(): string {
  return process.platform === 'win32' ? windowsCloudflaredPath() : userCloudflaredPath();
}

async function tryWingetInstall(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    await execAsync(
      'winget install --id Cloudflare.cloudflared -e --accept-package-agreements --accept-source-agreements',
      { windowsHide: true, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return await isCloudflaredInstalled();
  } catch {
    return false;
  }
}

async function installCloudflaredBinary(context: vscode.ExtensionContext): Promise<void> {
  const dest = cloudflaredDestPath();
  const bundled = resolveCloudflaredSource(context.extensionPath);

  if (bundled) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(bundled, dest);
    if (process.platform !== 'win32') chmodSync(dest, 0o755);
    return;
  }

  try {
    await downloadToFile(cloudflaredDownloadUrl(), dest);
    if (process.platform !== 'win32') chmodSync(dest, 0o755);
    return;
  } catch (downloadErr) {
    if (await tryWingetInstall()) return;
    const msg = downloadErr instanceof Error ? downloadErr.message : String(downloadErr);
    throw new Error(`cloudflared download failed (${msg}). Try: winget install Cloudflare.cloudflared`);
  }
}

export async function installCloudflared(context: vscode.ExtensionContext): Promise<'installed' | 'already'> {
  if (await isCloudflaredInstalled()) {
    return 'already';
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CursorHandoff: cloudflared',
      cancellable: false,
    },
    async () => installCloudflaredBinary(context),
  );

  if (!(await isCloudflaredInstalled())) {
    const hint = process.platform === 'win32'
      ? 'restart Cursor and try again.'
      : 'add ~/.local/bin to PATH or restart Cursor.';
    throw new Error(`cloudflared installed but not found yet — ${hint}`);
  }

  return 'installed';
}
