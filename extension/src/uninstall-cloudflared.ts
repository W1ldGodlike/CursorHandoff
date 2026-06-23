import { existsSync, unlinkSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import type * as vscode from 'vscode';
import { stopCloudflaredQuickTunnel } from './tunnel-launcher.js';
import { userCloudflaredPath, windowsCloudflaredPath } from './cloudflared-paths.js';

const execAsync = promisify(exec);

export async function uninstallCloudflared(context: vscode.ExtensionContext): Promise<void> {
  stopCloudflaredQuickTunnel(context);

  if (process.platform === 'win32') {
    const local = windowsCloudflaredPath();
    if (existsSync(local)) {
      unlinkSync(local);
      return;
    }
    try {
      await execAsync(
        'winget uninstall --id Cloudflare.cloudflared -e --accept-package-agreements --accept-source-agreements',
        { windowsHide: true, timeout: 120_000 },
      );
    } catch {
      throw new Error(
        'Could not remove cloudflared. Stop the tunnel manually or: winget uninstall Cloudflare.cloudflared',
      );
    }
    return;
  }

  try {
    await execAsync('brew uninstall cloudflared', { timeout: 120_000 });
  } catch { /* not installed via brew */ }

  const local = userCloudflaredPath();
  if (existsSync(local)) {
    unlinkSync(local);
  }
}
