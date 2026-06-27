import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ServerBuildInfo } from './build-meta.js';
import { HANDOFF_TESTED_CURSOR_VERSION } from './cursor-compat.js';
import { t } from '../i18n/t.js';

const HOST_FILE = 'cursor-host.json';
const SERVER_NOTIFY_FILE = 'cursor-upgrade-server-notify.json';
/** Redeploy / double-start within one window — same as startup OK. */
const SERVER_NOTIFY_DEDUPE_MS = 120_000;

export type CursorUpgradeServerChannel = 'telegram' | 'extension';

export interface CursorHostFile {
  cursorVersion: string;
}

export interface CursorUpgradeServerNotifyFile {
  at: number;
  pid: number;
  channels?: Partial<Record<CursorUpgradeServerChannel, true>>;
}

export interface CursorUpgradeHealthPayload {
  cursorUpgradeAdvisory: boolean;
  cursorVersion: string | null;
  handoffVersion: string | null;
  testedCursorVersion: string;
  /** Latest server-start notify wave (for web dismiss + 120s dedupe). */
  cursorUpgradeServerNotifyAt: number | null;
}

export function readCursorHost(dataDir: string): CursorHostFile | null {
  try {
    const path = join(dataDir, HOST_FILE);
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<CursorHostFile>;
    if (!raw.cursorVersion?.trim()) return null;
    return { cursorVersion: raw.cursorVersion.trim() };
  } catch {
    return null;
  }
}

export function writeCursorHost(dataDir: string, cursorVersion: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, HOST_FILE), JSON.stringify({ cursorVersion }, null, 2));
}

function readServerNotifyState(dataDir: string): CursorUpgradeServerNotifyFile | null {
  try {
    const path = join(dataDir, SERVER_NOTIFY_FILE);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as CursorUpgradeServerNotifyFile;
  } catch {
    return null;
  }
}

function writeServerNotifyState(dataDir: string, state: CursorUpgradeServerNotifyFile): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, SERVER_NOTIFY_FILE), JSON.stringify(state, null, 2));
}

/** Dev-pinned target from build manifest, else repo constant. */
export function resolveTestedCursorVersion(build: ServerBuildInfo | null): string {
  const fromBuild = build?.testedCursorVersion?.trim();
  if (fromBuild) return fromBuild;
  return HANDOFF_TESTED_CURSOR_VERSION;
}

/** Same rule for extension, web, and TG: running Cursor ≠ tested Handoff target. */
export function isCursorUpgradeAdvisory(
  hostVersion: string | null | undefined,
  testedVersion: string,
): boolean {
  if (!hostVersion?.trim()) return false;
  return hostVersion.trim() !== testedVersion.trim();
}

export function readCursorUpgradeServerNotifyAt(dataDir: string): number | null {
  const state = readServerNotifyState(dataDir);
  return typeof state?.at === 'number' ? state.at : null;
}

export function wasCursorUpgradeServerNotified(
  dataDir: string,
  channel: CursorUpgradeServerChannel,
): boolean {
  const prev = readServerNotifyState(dataDir);
  return Boolean(prev?.pid === process.pid && prev.channels?.[channel]);
}

/** Another server pid notified within the redeploy dedupe window. */
export function isCursorUpgradeServerNotifyDedupeBlocked(dataDir: string): boolean {
  const prev = readServerNotifyState(dataDir);
  if (!prev || typeof prev.at !== 'number') return false;
  return Date.now() - prev.at < SERVER_NOTIFY_DEDUPE_MS && prev.pid !== process.pid;
}

export function msUntilCursorUpgradeServerNotifyDedupe(dataDir: string): number {
  const prev = readServerNotifyState(dataDir);
  if (!prev || typeof prev.at !== 'number') return 0;
  return Math.max(0, SERVER_NOTIFY_DEDUPE_MS - (Date.now() - prev.at));
}

export function getCursorUpgradeHealthPayload(
  dataDir: string,
  build: ServerBuildInfo | null,
): CursorUpgradeHealthPayload {
  const host = readCursorHost(dataDir);
  const testedCursorVersion = resolveTestedCursorVersion(build);
  const cursorVersion = host?.cursorVersion ?? null;
  return {
    cursorUpgradeAdvisory: isCursorUpgradeAdvisory(cursorVersion, testedCursorVersion),
    cursorVersion,
    handoffVersion: build?.version ?? null,
    testedCursorVersion,
    cursorUpgradeServerNotifyAt: readCursorUpgradeServerNotifyAt(dataDir),
  };
}

/**
 * Extension toast / TG # General on each server start when advisory is active.
 * One notify per channel per server process; 120s blocks redeploy double-start.
 */
export function tryClaimCursorUpgradeServerNotify(
  dataDir: string,
  channel: CursorUpgradeServerChannel,
): boolean {
  const now = Date.now();
  try {
    const prev = readServerNotifyState(dataDir);

    if (prev?.pid === process.pid && prev.channels?.[channel]) {
      return false;
    }

    if (prev && typeof prev.at === 'number' && now - prev.at < SERVER_NOTIFY_DEDUPE_MS) {
      if (prev.pid !== process.pid) {
        return false;
      }
      if (prev.channels?.[channel]) return false;
      writeServerNotifyState(dataDir, {
        ...prev,
        channels: { ...prev.channels, [channel]: true },
      });
      return true;
    }

    writeServerNotifyState(dataDir, { at: now, pid: process.pid, channels: { [channel]: true } });
    return true;
  } catch {
    return true;
  }
}

export function formatCursorUpgradeMessage(cursorVersion: string, testedCursorVersion: string): string {
  return t(
    'tg.msg.cursorUpgrade',
    'Cursor {cursorVersion} — this Handoff build targets Cursor {testedCursorVersion}. Full functionality is not guaranteed. Rebuild or install the current VSIX.',
    { cursorVersion, testedCursorVersion },
  );
}
