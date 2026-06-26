import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs';
import { basename, join, resolve } from 'path';
import { resolveOutboundTarget } from '../telegram/routing/outbound.js';
import type { TopicManager } from '../telegram/topics/manager.js';
import type { WindowMonitor } from '../state/windows.js';
import type { StateManager } from '../state/broadcast.js';
import type { AgentStatus } from '../core/types.js';
import type { TelegramApiClient } from '../telegram/types.js';
import { purgeStaleFileRelayFiles, purgeStaleWorkspaceOutbox } from './lifecycle.js';
import { logInfo, logWarn, normalizeError, sanitizePathForUi } from '../core/log-event.js';
import type { LogContext } from '../core/log-event.js';

const POLL_MS = 2000;
const DEBOUNCE_MS = 500;
const IDLE_DEBOUNCE_MS = 2000;
const ALBUM_MAX = 10;

export const AGENT_IDLE_STATUSES = new Set(['idle', 'error']);

interface PendingOutboxBatch {
  workspacePath: string;
  files: string[];
  firstSeenAt: number;
  lastMtime: number;
}

export interface OutboxWatcherDeps {
  topicManager: TopicManager;
  windowMonitor: WindowMonitor;
  stateManager: StateManager;
  api: TelegramApiClient;
  chatId: number | undefined;
}

const watchers = new Map<string, NodeJS.Timeout>();
const batches = new Map<string, PendingOutboxBatch>();
/** One send per workspace — poll interval (2s) can overlap paced TG calls (~2.2s+). */
const inFlight = new Set<string>();

function outboxCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'outbox', op, ...extra };
}

function outboxDir(workspacePath: string): string {
  return join(workspacePath, '.cursor-handoff/outbox');
}

function isSendableFile(name: string): boolean {
  return !name.endsWith('.meta.json') && !name.startsWith('.');
}

function listOutboxFiles(workspacePath: string): string[] {
  const dir = outboxDir(workspacePath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(isSendableFile)
    .map((name) => join(dir, name))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => {
      const sa = statSync(a);
      const sb = statSync(b);
      if (sa.mtimeMs !== sb.mtimeMs) return sa.mtimeMs - sb.mtimeMs;
      return basename(a).localeCompare(basename(b));
    });
}

function readMetaCaption(filePath: string): string | undefined {
  const metaPath = `${filePath.replace(/\.[^.]+$/, '')}.meta.json`;
  if (!existsSync(metaPath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(metaPath, 'utf8')) as { caption?: string };
    return raw.caption?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function deleteSentFiles(paths: string[]): void {
  for (const p of paths) {
    try {
      if (existsSync(p)) unlinkSync(p);
      const meta = `${p.replace(/\.[^.]+$/, '')}.meta.json`;
      if (existsSync(meta)) unlinkSync(meta);
    } catch {
      /* ignore */
    }
  }
}

/** Outbox idle: thread with lastInboundAt, not first workspace mapping (stale snapshot). */
export function resolveOutboxAgentActivity(
  deps: OutboxWatcherDeps,
  workspacePath: string,
): { status: AgentStatus; isLive: boolean } {
  const target = resolveOutboundTarget({
    workspacePath,
    topicManager: deps.topicManager,
  });
  const state = deps.stateManager.getCurrentState();
  if (!target || target.mapping.windowId === state.activeWindowId) {
    return { status: state.agentStatus, isLive: state.agentActivityLive };
  }
  const snapshot = deps.windowMonitor.getSnapshot(target.mapping.windowId);
  return {
    status: snapshot?.agentStatus ?? state.agentStatus,
    isLive: snapshot?.agentActivityLive ?? state.agentActivityLive,
  };
}

export function resolveOutboxAgentStatus(
  deps: OutboxWatcherDeps,
  workspacePath: string,
): AgentStatus {
  return resolveOutboxAgentActivity(deps, workspacePath).status;
}

/** Outbox after reply: idle/error, or status stale (no live shimmer in DOM). */
export function isOutboxReadyForSend(
  deps: OutboxWatcherDeps,
  workspacePath: string,
): boolean {
  const { status, isLive } = resolveOutboxAgentActivity(deps, workspacePath);
  if (status === 'waiting_approval') return false;
  if (AGENT_IDLE_STATUSES.has(status)) return true;
  return !isLive;
}

function pickSendMethod(path: string): 'photo' | 'document' {
  const ext = path.toLowerCase();
  if (ext.endsWith('.png') || ext.endsWith('.jpg') || ext.endsWith('.jpeg') || ext.endsWith('.webp')) {
    const size = statSync(path).size;
    if (size <= 10 * 1024 * 1024) return 'photo';
  }
  return 'document';
}

export type OutboxSendItem = { type: 'photo' | 'document'; path: string };

/** Homogeneous groups of ≤10 — Telegram albums cannot mix photo + document. */
export function groupOutboxFilesForSend(files: string[]): OutboxSendItem[][] {
  const photos: string[] = [];
  const documents: string[] = [];
  for (const path of files) {
    if (pickSendMethod(path) === 'photo') photos.push(path);
    else documents.push(path);
  }
  const groups: OutboxSendItem[][] = [];
  for (let i = 0; i < photos.length; i += ALBUM_MAX) {
    groups.push(photos.slice(i, i + ALBUM_MAX).map((path) => ({ type: 'photo' as const, path })));
  }
  for (let i = 0; i < documents.length; i += ALBUM_MAX) {
    groups.push(documents.slice(i, i + ALBUM_MAX).map((path) => ({ type: 'document' as const, path })));
  }
  return groups;
}

function resolveBatchCaption(files: string[]): string | undefined {
  for (const path of files) {
    const caption = readMetaCaption(path);
    if (caption) return caption;
  }
  return undefined;
}

async function sendOutboxGroup(
  api: TelegramApiClient,
  chatId: number,
  threadId: number,
  group: OutboxSendItem[],
  caption?: string,
): Promise<void> {
  if (group.length === 1) {
    const { type, path } = group[0];
    if (type === 'photo') {
      await api.sendPhoto(chatId, path, {
        message_thread_id: threadId,
        caption: caption || undefined,
      });
    } else {
      await api.sendDocument(chatId, path, {
        message_thread_id: threadId,
        caption: caption || undefined,
      });
    }
    return;
  }
  const media = group.map((item, idx) => ({
    type: item.type,
    path: item.path,
    caption: idx === 0 ? caption : undefined,
  }));
  await api.sendMediaGroup(chatId, media, { message_thread_id: threadId });
}

async function sendBatch(
  deps: OutboxWatcherDeps,
  workspacePath: string,
  files: string[],
): Promise<boolean> {
  if (!deps.chatId || files.length === 0) return false;

  const state = deps.stateManager.getCurrentState();
  const wsNorm = workspacePath.replace(/\\/g, '/').toLowerCase();
  const activeSnap = state.activeWindowId
    ? deps.windowMonitor.getSnapshot(state.activeWindowId)
    : undefined;
  const activeWsNorm = activeSnap?.workspacePath?.replace(/\\/g, '/').toLowerCase();

  const target = resolveOutboundTarget({
    workspacePath,
    windowId: activeWsNorm === wsNorm ? state.activeWindowId : undefined,
    composerId: activeWsNorm === wsNorm ? state.activeComposerId : undefined,
    topicManager: deps.topicManager,
  });

  if (!target) {
    const safeWs = sanitizePathForUi(workspacePath);
    logWarn(
      'OUTBOX_ROUTE_MISS',
      `No TG route for workspace ${safeWs} — retry later`,
      outboxCtx('deliver', { hint: safeWs }),
    );
    return false;
  }

  const threadId = target.threadId;
  const windowId = target.mapping.windowId;
  const chatId = deps.chatId;
  const groups = groupOutboxFilesForSend(files);
  const caption = resolveBatchCaption(files);
  const sentPaths: string[] = [];

  try {
    let captionUsed = false;
    for (const group of groups) {
      const groupCaption = !captionUsed ? caption : undefined;
      await sendOutboxGroup(deps.api, chatId, threadId, group, groupCaption);
      if (groupCaption) captionUsed = true;
      sentPaths.push(...group.map((item) => item.path));
    }
    deleteSentFiles(sentPaths);
    const lines = sentPaths.map((f) => `• ${basename(f)}`).join('\n');
    try {
      if (sentPaths.length === 1) {
        await deps.api.sendMessage(
          chatId,
          `📤 Sent to this chat: ${basename(sentPaths[0])}`,
          { message_thread_id: threadId },
        );
      } else {
        await deps.api.sendMessage(
          chatId,
          `📤 Sent to this chat (${sentPaths.length} files):\n${lines}`,
          { message_thread_id: threadId },
        );
      }
    } catch (err) {
      const { message, errno } = normalizeError(err);
      logWarn(
        'OUTBOX_CONFIRM_FAIL',
        `Delivered ${sentPaths.length} file(s); confirm message failed: ${message}`,
        outboxCtx('deliver', { threadId, windowId, hint: String(sentPaths.length), errno }),
      );
    }
    return true;
  } catch (err) {
    if (sentPaths.length) deleteSentFiles(sentPaths);
    const { message, errno } = normalizeError(err);
    logWarn(
      'OUTBOX_SEND_FAIL',
      `Send failed: ${message}`,
      outboxCtx('deliver', {
        threadId,
        windowId,
        errno,
        hint: sanitizePathForUi(workspacePath),
      }),
    );
    await deps.api.sendMessage(
      chatId,
      '⚠️ Could not send file (Telegram limit / network).\n'
      + 'File remains in outbox — will retry later or try again.',
      { message_thread_id: threadId },
    ).catch(() => {});
    return false;
  }
}

async function tick(workspacePath: string, deps: OutboxWatcherDeps, force = false): Promise<void> {
  const absWs = resolve(workspacePath);
  if (inFlight.has(absWs)) return;

  const files = listOutboxFiles(absWs);
  if (files.length === 0) {
    batches.delete(absWs);
    return;
  }

  const latestMtime = Math.max(...files.map((f) => statSync(f).mtimeMs));
  let batch = batches.get(absWs);
  if (!batch) {
    batch = { workspacePath: absWs, files, firstSeenAt: Date.now(), lastMtime: latestMtime };
    batches.set(absWs, batch);
  } else {
    batch.files = files;
    batch.lastMtime = latestMtime;
  }

  if (!force && !isOutboxReadyForSend(deps, absWs)) return;

  if (!force) {
    const idleLongEnough = Date.now() - batch.lastMtime >= IDLE_DEBOUNCE_MS;
    if (!idleLongEnough) return;
  }

  inFlight.add(absWs);
  try {
    const sent = await sendBatch(deps, absWs, files);
    if (sent) batches.delete(absWs);
  } finally {
    inFlight.delete(absWs);
  }
}

/** Immediate send attempt (redeploy/shutdown — force, no idle wait). */
export async function flushOutboxForWorkspace(
  workspacePath: string,
  deps: OutboxWatcherDeps,
  force = false,
): Promise<void> {
  await tick(resolve(workspacePath), deps, force);
}

export function registerOutboxWatcher(workspacePath: string, deps: OutboxWatcherDeps): void {
  const absWs = resolve(workspacePath);
  if (watchers.has(absWs)) return;
  purgeStaleFileRelayFiles();
  purgeStaleWorkspaceOutbox(absWs);
  const timer = setInterval(() => {
    void tick(absWs, deps);
  }, POLL_MS);
  watchers.set(absWs, timer);
  logInfo(
    'OUTBOX_WATCHER_START',
    `Watcher registered: ${sanitizePathForUi(absWs)}`,
    outboxCtx('watch', { hint: sanitizePathForUi(absWs) }),
  );
  void tick(absWs, deps);
}

export function stopAllOutboxWatchers(): void {
  for (const timer of watchers.values()) clearInterval(timer);
  watchers.clear();
  batches.clear();
  inFlight.clear();
}
