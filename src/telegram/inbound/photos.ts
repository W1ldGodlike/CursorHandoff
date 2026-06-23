import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  deleteLocalFiles,
  pendingStatePath,
  saveInboundFromTelegram,
} from '../../media/lifecycle.js';
import { getDataDir } from '../../core/paths.js';
import { t } from '../../i18n/t.js';
import type { TelegramApiClient } from '../types.js';

export const PHOTO_BUFFER_TTL_MS = 10 * 60 * 1000;

export function photoExpiredMessage(): string {
  return t(
    'tg.msg.photo.expired',
    '⏱ Time expired — photo cancelled. Send again: photo with caption or photo then text.',
  );
}
const MEDIA_GROUP_DEBOUNCE_MS = 2000;

export interface PendingPhotoState {
  chatId: number;
  threadId: number;
  localPaths: string[];
  caption?: string;
  createdAt: number;
  expiresAt: number;
  telegramMessageIds: number[];
}

const groupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const groupBuffers = new Map<string, { paths: string[]; messageIds: number[]; caption?: string }>();
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let expiryNotifier: ((chatId: number, threadId: number) => Promise<void>) | null = null;

function pendingKey(chatId: number, threadId: number): string {
  return `${chatId}:${threadId}`;
}

export function setPhotoBufferExpiryNotifier(
  fn: (chatId: number, threadId: number) => Promise<void>,
): void {
  expiryNotifier = fn;
}

function cancelPendingExpiry(chatId: number, threadId: number): void {
  const key = pendingKey(chatId, threadId);
  const timer = expiryTimers.get(key);
  if (timer) clearTimeout(timer);
  expiryTimers.delete(key);
}

async function firePendingExpiry(chatId: number, threadId: number): Promise<void> {
  cancelPendingExpiry(chatId, threadId);
  await expirePendingIfNeeded(chatId, threadId, async () => {
    await expiryNotifier?.(chatId, threadId);
  });
}

function schedulePendingExpiry(chatId: number, threadId: number): void {
  cancelPendingExpiry(chatId, threadId);
  const state = loadPending(chatId, threadId);
  if (!state) return;
  const delay = Math.max(0, state.expiresAt - Date.now());
  expiryTimers.set(
    pendingKey(chatId, threadId),
    setTimeout(() => {
      void firePendingExpiry(chatId, threadId);
    }, delay),
  );
}

/** After server restart — restore timers or expire overdue items immediately. */
export function restorePendingExpiryTimers(): void {
  const dir = join(getDataDir(), 'file-relay/pending');
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const match = /^(-?\d+)-(\d+)\.json$/.exec(name);
    if (!match) continue;
    const chatId = parseInt(match[1], 10);
    const threadId = parseInt(match[2], 10);
    const state = loadPending(chatId, threadId);
    if (!state) continue;
    if (Date.now() > state.expiresAt) {
      void firePendingExpiry(chatId, threadId);
    } else {
      schedulePendingExpiry(chatId, threadId);
    }
  }
}

export function stopAllPendingExpiryTimers(): void {
  for (const timer of expiryTimers.values()) clearTimeout(timer);
  expiryTimers.clear();
}
function loadPending(chatId: number, threadId: number): PendingPhotoState | null {
  const path = pendingStatePath(chatId, threadId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PendingPhotoState;
  } catch {
    return null;
  }
}

function savePending(state: PendingPhotoState): void {
  writeFileSync(pendingStatePath(state.chatId, state.threadId), JSON.stringify(state, null, 2));
  schedulePendingExpiry(state.chatId, state.threadId);
}

function clearPending(chatId: number, threadId: number): void {
  cancelPendingExpiry(chatId, threadId);
  const path = pendingStatePath(chatId, threadId);
  if (existsSync(path)) rmSync(path, { force: true });
}

export function getPending(chatId: number, threadId: number): PendingPhotoState | null {
  const state = loadPending(chatId, threadId);
  if (!state) return null;
  if (Date.now() > state.expiresAt) {
    deleteLocalFiles(state.localPaths);
    clearPending(chatId, threadId);
    return null;
  }
  return state;
}

export async function expirePendingIfNeeded(
  chatId: number,
  threadId: number,
  onExpired: () => Promise<void>,
): Promise<boolean> {
  const state = loadPending(chatId, threadId);
  if (!state) return false;
  if (Date.now() <= state.expiresAt) return false;
  deleteLocalFiles(state.localPaths);
  clearPending(chatId, threadId);
  await onExpired();
  return true;
}

function newPending(
  chatId: number,
  threadId: number,
  paths: string[],
  messageIds: number[],
  caption?: string,
): PendingPhotoState {
  const now = Date.now();
  return {
    chatId,
    threadId,
    localPaths: paths,
    caption,
    createdAt: now,
    expiresAt: now + PHOTO_BUFFER_TTL_MS,
    telegramMessageIds: messageIds,
  };
}

export async function ingestPhoto(opts: {
  api: TelegramApiClient;
  chatId: number;
  threadId: number;
  fileId: string;
  mime: string;
  messageId: number;
  caption?: string;
  mediaGroupId?: string;
  workspacePath?: string;
  baseName?: string;
  kind?: 'image' | 'file';
  onAwaitingText: () => Promise<void>;
  onDeliver: (paths: string[], text: string) => Promise<void>;
}): Promise<'delivered' | 'pending' | 'replaced'> {
  const caption = opts.caption?.trim();
  const localPath = await saveInboundFromTelegram({
    api: opts.api,
    fileId: opts.fileId,
    mime: opts.mime,
    workspacePath: opts.workspacePath,
    baseName: opts.baseName,
    kind: opts.kind,
  });

  if (opts.mediaGroupId) {
    const hadPending = !!getPending(opts.chatId, opts.threadId);
    const key = `${opts.chatId}:${opts.mediaGroupId}`;
    const buf = groupBuffers.get(key) ?? { paths: [], messageIds: [] };
    buf.paths.push(localPath);
    buf.messageIds.push(opts.messageId);
    if (caption && !buf.caption) buf.caption = caption;
    groupBuffers.set(key, buf);

    const existingTimer = groupTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);

    groupTimers.set(key, setTimeout(async () => {
      groupTimers.delete(key);
      const batch = groupBuffers.get(key);
      groupBuffers.delete(key);
      if (!batch) return;

      const albumCaption = batch.caption?.trim();
      const pending = getPending(opts.chatId, opts.threadId);
      const paths = pending ? [...pending.localPaths, ...batch.paths] : batch.paths;
      const messageIds = pending
        ? [...pending.telegramMessageIds, ...batch.messageIds]
        : batch.messageIds;
      if (pending) {
        deleteLocalFiles(pending.localPaths);
        clearPending(opts.chatId, opts.threadId);
      }

      if (albumCaption) {
        await opts.onDeliver(paths, albumCaption);
        return;
      }

      const state = newPending(opts.chatId, opts.threadId, paths, messageIds);
      savePending(state);
      await opts.onAwaitingText();
    }, MEDIA_GROUP_DEBOUNCE_MS));

    return hadPending ? 'replaced' : 'pending';
  }

  if (caption) {
    const existing = getPending(opts.chatId, opts.threadId);
    const paths = existing ? [...existing.localPaths, localPath] : [localPath];
    if (existing) clearPending(opts.chatId, opts.threadId);
    await opts.onDeliver(paths, caption);
    return 'delivered';
  }

  const pending = getPending(opts.chatId, opts.threadId);
  if (pending) deleteLocalFiles(pending.localPaths);

  const state = newPending(opts.chatId, opts.threadId, [localPath], [opts.messageId]);
  savePending(state);
  await opts.onAwaitingText();
  return pending ? 'replaced' : 'pending';
}

export async function ingestFollowUpText(opts: {
  chatId: number;
  threadId: number;
  text: string;
  onDeliver: (paths: string[], text: string) => Promise<void>;
}): Promise<boolean> {
  const pending = getPending(opts.chatId, opts.threadId);
  if (!pending) return false;
  clearPending(opts.chatId, opts.threadId);
  await opts.onDeliver(pending.localPaths, opts.text);
  return true;
}

export function clearPendingAfterDeliver(chatId: number, threadId: number, paths: string[]): void {
  clearPending(chatId, threadId);
  deleteLocalFiles(paths);
}

export function ingestQueueAttachments(opts: {
  chatId: number;
  threadId: number;
  paths: string[];
  caption?: string;
}): void {
  const state = newPending(
    opts.chatId,
    opts.threadId,
    opts.paths,
    [],
    opts.caption,
  );
  savePending(state);
}
