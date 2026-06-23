import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function userCloudflaredBinDir(): string {
  return join(homedir(), '.local', 'bin');
}

export function userCloudflaredPath(): string {
  return join(userCloudflaredBinDir(), 'cloudflared');
}

export function windowsCloudflaredPath(): string {
  return join(process.env.LOCALAPPDATA ?? '', 'cloudflared', 'cloudflared.exe');
}

function windowsCandidates(): (() => string)[] {
  return [
    () => windowsCloudflaredPath(),
    () => join(process.env.ProgramFiles ?? '', 'cloudflared', 'cloudflared.exe'),
    () => join(process.env['ProgramFiles(x86)'] ?? '', 'cloudflared', 'cloudflared.exe'),
  ];
}

function unixCandidates(): (() => string)[] {
  return [
    () => userCloudflaredPath(),
    () => '/opt/homebrew/bin/cloudflared',
    () => '/usr/local/bin/cloudflared',
    () => '/usr/bin/cloudflared',
  ];
}

export function findCloudflaredExeSync(): string | undefined {
  const picks = process.platform === 'win32' ? windowsCandidates() : unixCandidates();
  for (const pick of picks) {
    const p = pick();
    if (p && existsSync(p)) return p;
  }
  return undefined;
}

export async function isCloudflaredInstalled(): Promise<boolean> {
  if (findCloudflaredExeSync()) return true;
  const cmd = process.platform === 'win32' ? 'where cloudflared' : 'command -v cloudflared';
  try {
    const { stdout } = await execAsync(cmd, { windowsHide: true });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
