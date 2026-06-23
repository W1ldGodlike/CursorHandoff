import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'fs';
import { join, extname, basename } from 'path';
import { ensureProjectDirs } from '../workspace/handoff-dirs.js';
import { getDataDir } from '../core/paths.js';
import type { TelegramApiClient } from '../telegram/types.js';

export const SUPPORTED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const MAX_INBOUND_BYTES = 20 * 1024 * 1024;
/** Telegram Bot API getFile download cap — not an arbitrary product limit. */
export const TELEGRAM_BOT_FILE_MAX_BYTES = MAX_INBOUND_BYTES;
const STALE_TTL_MS = 24 * 60 * 60 * 1000;
export const OUTBOX_STALE_MS = 60 * 60 * 1000;

export function isSupportedImageMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return SUPPORTED_IMAGE_MIMES.has(mime.toLowerCase());
}

export function mimeToExt(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/webp': return '.webp';
    default: return '.bin';
  }
}

function migrateLegacyDataFileRelayDir(): void {
  const data = getDataDir();
  const legacy = join(data, 'media');
  const target = join(data, 'file-relay');
  if (!existsSync(legacy) || existsSync(target)) return;
  try {
    renameSync(legacy, target);
  } catch {
    /* ignore */
  }
}

export function isInboundImagePath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp';
}

export function safeInboundBaseName(baseName?: string): string | undefined {
  if (!baseName?.trim()) return undefined;
  const safe = basename(baseName).replace(/[^\w.\-()+ ]/g, '_').trim().slice(0, 80);
  return safe || undefined;
}

export function resolveInboundDir(workspacePath?: string, kind: 'image' | 'file' = 'image'): string {
  migrateLegacyDataFileRelayDir();
  if (workspacePath?.trim()) {
    const need = kind === 'image' ? 'photoInbound' : 'fileInbound';
    ensureProjectDirs(workspacePath, [need]);
    return join(workspacePath, kind === 'image'
      ? '.cursor-handoff/file-relay/photo/inbound'
      : '.cursor-handoff/file-relay/inbound');
  }
  const fallback = join(getDataDir(), 'file-relay/inbound');
  if (!existsSync(fallback)) mkdirSync(fallback, { recursive: true });
  return fallback;
}

export function pendingStatePath(chatId: number, threadId: number): string {
  const dir = join(getDataDir(), 'file-relay/pending');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${chatId}-${threadId}.json`);
}

export async function downloadTelegramFile(
  api: TelegramApiClient,
  fileId: string,
  destPath: string,
): Promise<void> {
  const info = await api.getFile(fileId);
  if (info.file_size != null && info.file_size > MAX_INBOUND_BYTES) {
    throw new Error(`File too large (${info.file_size} bytes)`);
  }
  const dir = join(destPath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await api.downloadFile(info.file_path, destPath);
  const size = statSync(destPath).size;
  if (size > MAX_INBOUND_BYTES) {
    unlinkSync(destPath);
    throw new Error(`Downloaded file exceeds ${MAX_INBOUND_BYTES} bytes`);
  }
}

export function deleteLocalFiles(paths: string[]): void {
  for (const p of paths) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

function purgeDirContents(dir: string, maxAgeMs: number): void {
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - maxAgeMs;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(full);
    } catch {
      /* ignore */
    }
  }
}

/** TTL purge for workspace outbox (default 1h). Uses mtime — agent should copy into outbox, not move. */
export function purgeStaleWorkspaceOutbox(workspacePath: string, maxAgeMs = OUTBOX_STALE_MS): void {
  purgeDirContents(join(workspacePath, '.cursor-handoff/outbox'), maxAgeMs);
}

/** TTL purge for inbound temp and stale outbox files (24h). */
export function purgeStaleFileRelayFiles(maxAgeMs = STALE_TTL_MS): void {
  purgeDirContents(join(getDataDir(), 'file-relay/inbound'), maxAgeMs);
  const pendingDir = join(getDataDir(), 'file-relay/pending');
  if (existsSync(pendingDir)) {
    for (const name of readdirSync(pendingDir)) {
      if (!name.endsWith('.json')) continue;
      const full = join(pendingDir, name);
      try {
        const st = statSync(full);
        if (st.mtimeMs < Date.now() - maxAgeMs) rmSync(full, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

export async function saveInboundFromTelegram(opts: {
  api: TelegramApiClient;
  fileId: string;
  mime: string;
  workspacePath?: string;
  baseName?: string;
  kind?: 'image' | 'file';
}): Promise<string> {
  const kind = opts.kind ?? (isSupportedImageMime(opts.mime) ? 'image' : 'file');
  const dir = resolveInboundDir(opts.workspacePath, kind);
  const ext = opts.baseName ? extname(opts.baseName) : mimeToExt(opts.mime);
  const safeName = safeInboundBaseName(opts.baseName);
  const name = safeName
    ? `${Date.now()}-${safeName}`
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const dest = join(dir, name);
  await downloadTelegramFile(opts.api, opts.fileId, dest);
  return dest;
}
