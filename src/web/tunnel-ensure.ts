import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { probeWebTunnelLive, readWebTunnelUrl } from './tunnel.js';

const ENSURE_TIMEOUT_MS = 95_000;
const POLL_MS = 2000;

function resolveEnsureScript(dataDir: string): string | null {
  const repoScript = join(dirname(dataDir), 'scripts', 'tunnel', 'run-cloudflared-quick.ps1');
  if (existsSync(repoScript)) return repoScript;
  return null;
}

function runEnsureScript(script: string, dataDir: string, port: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        script,
        '-Action',
        'ensure',
        '-Port',
        String(port),
        '-DataDir',
        dataDir,
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });
}

/** Start quick tunnel if dead; return live URL or null. */
export async function ensureWebTunnel(dataDir: string, port = 3000): Promise<string | null> {
  if (process.platform !== 'win32') {
    const url = readWebTunnelUrl(dataDir);
    return url && await probeWebTunnelLive(url) ? url : null;
  }

  const saved = readWebTunnelUrl(dataDir);
  if (saved && await probeWebTunnelLive(saved)) return saved;

  const script = resolveEnsureScript(dataDir);
  if (!script) return saved && await probeWebTunnelLive(saved) ? saved : null;

  console.log('[web-tunnel] ensure: restarting cloudflared quick tunnel…');
  await runEnsureScript(script, dataDir, port);

  const deadline = Date.now() + ENSURE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = readWebTunnelUrl(dataDir);
    if (url && await probeWebTunnelLive(url)) {
      console.log(`[web-tunnel] ensure: live ${url}`);
      return url;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  const fallback = readWebTunnelUrl(dataDir);
  return fallback && await probeWebTunnelLive(fallback) ? fallback : null;
}
