import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { CursorState } from './types.js';
import type { ServerBuildInfo } from './build-meta.js';

const NOTIFY_FILE = 'startup-notify.json';
/** Two bundles in a row during redeploy / window race — do not spam General. */
const DEDUPE_MS = 120_000;
/** After a new bundle starts the old process still sends "Disconnected" — suppress. */
const DISCONNECT_SUPPRESS_AFTER_STARTUP_MS = 90_000;

export function wasRecentStartupNotify(dataDir: string, withinMs = DISCONNECT_SUPPRESS_AFTER_STARTUP_MS): boolean {
  const path = join(dataDir, NOTIFY_FILE);
  try {
    if (!existsSync(path)) return false;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { at?: number };
    return typeof raw.at === 'number' && Date.now() - raw.at < withinMs;
  } catch {
    return false;
  }
}

export function tryClaimStartupNotify(dataDir: string): boolean {
  const path = join(dataDir, NOTIFY_FILE);
  const now = Date.now();
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { at?: number };
      if (typeof raw.at === 'number' && now - raw.at < DEDUPE_MS) {
        return false;
      }
    }
    writeFileSync(path, JSON.stringify({ at: now, pid: process.pid }));
    return true;
  } catch {
    return true;
  }
}

export interface StartupNotifyInput {
  state: CursorState;
  build: ServerBuildInfo | null;
  wakeRaiseCursor: boolean;
  webTunnelUrl: string | null;
}

export function formatStartupNotifyMessage(input: StartupNotifyInput): string {
  const { state, build, wakeRaiseCursor, webTunnelUrl } = input;
  const version = build?.version ?? '?';
  const compatVersion = build?.compatVersion ?? '?';
  const winCount = state.windows?.length ?? 0;
  const tunnelLine = webTunnelUrl
    ? `Web: ${webTunnelUrl}`
    : 'Web tunnel: none (cloudflared starting)';
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const startedAt = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;

  return [
    '🟢 CursorHandoff — startup OK',
    `Started: ${startedAt}`,
    `v${version} · compatVersion ${compatVersion}`,
    `CDP ✓ · extractor ${state.extractorStatus ?? '?'}`,
    `Wake: ${wakeRaiseCursor ? 'raises Cursor' : 'paused'}`,
    tunnelLine,
    `Cursor windows: ${winCount}`,
  ].join('\n');
}
