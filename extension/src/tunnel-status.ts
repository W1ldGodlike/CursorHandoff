import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { isCloudflaredInstalled } from './cloudflared-paths.js';

const execAsync = promisify(exec);

export interface TunnelAddonStatus {
  cloudflaredInstalled: boolean;
  running: boolean;
  url: string | null;
}

async function isProcessAlive(pid: number): Promise<boolean> {
  if (pid <= 0) return false;
  try {
    const { stdout } = await execAsync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { windowsHide: true });
    return stdout.includes(String(pid));
  } catch {
    return false;
  }
}

function readSavedUrl(dataDir: string): string | null {
  const path = join(dataDir, 'web-tunnel-url.json');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { url?: string };
    return typeof raw.url === 'string' ? raw.url : null;
  } catch {
    return null;
  }
}

export async function getTunnelAddonStatus(dataDir: string): Promise<TunnelAddonStatus> {
  const cloudflaredInstalled = await isCloudflaredInstalled();
  const url = readSavedUrl(dataDir);
  let running = false;

  const pidPath = join(dataDir, 'cloudflared-quick.pid');
  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      running = await isProcessAlive(pid);
    } catch {
      running = false;
    }
  }

  return { cloudflaredInstalled, running, url };
}
