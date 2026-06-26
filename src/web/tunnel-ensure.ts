import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { logInfo } from '../core/log-event.js';
import type { LogContext } from '../core/log-event.js';
import { probeWebTunnelLive, readWebTunnelUrl } from './tunnel.js';

function tunnelCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'tunnel', op, ...extra };
}

const ENSURE_TIMEOUT_MS = 95_000;
const POLL_MS = 2000;

export interface EnsureWebTunnelDeps {
  platform: NodeJS.Platform;
  readWebTunnelUrl: (dataDir: string) => string | null;
  probeWebTunnelLive: (url: string) => Promise<boolean>;
  spawn: (
    command: string,
    args: string[],
    options: { stdio: 'ignore'; windowsHide: boolean },
  ) => ChildProcess;
  existsSync: (path: string) => boolean;
  now: () => number;
  delay: (ms: number) => Promise<void>;
  ensureTimeoutMs: number;
  pollMs: number;
}

export const defaultEnsureWebTunnelDeps: EnsureWebTunnelDeps = {
  platform: process.platform,
  readWebTunnelUrl,
  probeWebTunnelLive,
  spawn,
  existsSync,
  now: () => Date.now(),
  delay: (ms) => new Promise((r) => setTimeout(r, ms)),
  ensureTimeoutMs: ENSURE_TIMEOUT_MS,
  pollMs: POLL_MS,
};

function resolveEnsureScript(dataDir: string, exists: (path: string) => boolean): string | null {
  const repoScript = join(dirname(dataDir), 'scripts', 'tunnel', 'run-cloudflared-quick.ps1');
  if (exists(repoScript)) return repoScript;
  return null;
}

function runEnsureScript(
  deps: EnsureWebTunnelDeps,
  script: string,
  dataDir: string,
  port: number,
): Promise<void> {
  return new Promise((resolve) => {
    const child = deps.spawn(
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
export async function runEnsureWebTunnel(
  dataDir: string,
  port: number,
  deps: EnsureWebTunnelDeps,
): Promise<string | null> {
  if (deps.platform !== 'win32') {
    const url = deps.readWebTunnelUrl(dataDir);
    return url && (await deps.probeWebTunnelLive(url)) ? url : null;
  }

  const saved = deps.readWebTunnelUrl(dataDir);
  if (saved && (await deps.probeWebTunnelLive(saved))) return saved;

  const script = resolveEnsureScript(dataDir, deps.existsSync);
  if (!script) return saved && (await deps.probeWebTunnelLive(saved)) ? saved : null;

  logInfo('TUNNEL_ENSURE_START', 'Restarting cloudflared quick tunnel', tunnelCtx('ensure'));
  await runEnsureScript(deps, script, dataDir, port);

  const deadline = deps.now() + deps.ensureTimeoutMs;
  while (deps.now() < deadline) {
    const url = deps.readWebTunnelUrl(dataDir);
    if (url && (await deps.probeWebTunnelLive(url))) {
      logInfo('TUNNEL_ENSURE_OK', `Tunnel live ${url}`, tunnelCtx('ensure', { hint: url }));
      return url;
    }
    await deps.delay(deps.pollMs);
  }

  const fallback = deps.readWebTunnelUrl(dataDir);
  return fallback && (await deps.probeWebTunnelLive(fallback)) ? fallback : null;
}

export async function ensureWebTunnel(dataDir: string, port = 3000): Promise<string | null> {
  return runEnsureWebTunnel(dataDir, port, defaultEnsureWebTunnelDeps);
}
