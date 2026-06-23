import type { StateManager } from '../../state/broadcast.js';
import type { CommandExecutor } from '../../ide/actions/navigation.js';
import type { CDPBridge } from '../../ide/cdp-session.js';
import type { TopicManager } from '../topics/manager.js';
import type { MessageTracker } from '../pipeline/tracker.js';
import type { WindowMonitor } from '../../state/windows.js';
import { cleanTabTitle } from '../../ide/parse/tabs.js';
import { isPlaceholderTabTitle, normalizeComposerId } from '../topics/guards.js';
import type { SendQueue } from '../pipeline/send-queue.js';
import type { BotContext, TelegramApiClient } from '../types.js';

export interface CommandDeps {
  api: TelegramApiClient;
  stateManager: StateManager;
  commandExecutor: CommandExecutor;
  cdpBridge: CDPBridge;
  topicManager: TopicManager;
  messageTracker: MessageTracker;
  windowMonitor: WindowMonitor;
  chatId: number | undefined;
  getSyncEnabled: () => boolean;
  setSyncEnabled: (enabled: boolean, chatId?: number) => void;
  setChatId: (id: number) => void;
  resetAllState: () => void;
  syncForumTopicLabel?: (
    threadId: number,
    sourceWindowId: string,
    tabTitle: string,
    opts?: { snapshotComposerId?: string; allowMappingRename?: boolean; snapshotMode?: string },
  ) => Promise<void>;
  noteForumTopicLabel?: (threadId: number, label: string) => void;
  sendQueue?: SendQueue;
}

export interface RegisterDeps {
  authState: { token: string };
  registeredUsers: Set<number>;
  /** TELEGRAM_ALLOWED_USERS from env; non-empty list is strict allowlist for /register. */
  envAllowedUsers: number[];
  registerUser: (id: number, username?: string, firstName?: string) => void;
}

export function resolveTopicThreadId(ctx: BotContext): number | undefined {
  return ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
}

export async function syncThreadTopicModeLabel(
  deps: CommandDeps,
  threadId: number,
  mode: string,
): Promise<void> {
  const mapping = deps.topicManager.resolveThread(threadId);
  if (!mapping || !deps.syncForumTopicLabel) return;
  deps.topicManager.setTopicMode(threadId, mode);
  await deps.syncForumTopicLabel(
    threadId,
    mapping.windowId,
    mapping.tabTitle,
    { snapshotComposerId: mapping.composerId, snapshotMode: mode },
  );
}

export function genId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForFreshExtraction(stateManager: StateManager, genBefore: number, maxWaitMs: number): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (stateManager.generation <= genBefore && Date.now() < deadline) {
    await sleep(200);
  }
}

export function shouldOfferSyncTopic(
  snapshot: {
    messages: unknown[];
    activeComposerId?: string;
    chatTabs?: { title: string; isActive?: boolean; composerId?: string }[];
  },
  tabTitle: string,
  topicManager: TopicManager,
): boolean {
  const cleaned = cleanTabTitle(tabTitle);
  if (isPlaceholderTabTitle(cleaned)) return false;
  if (snapshot.messages.length === 0) return false;
  const activeTab = snapshot.chatTabs?.find((t) => t.isActive)
    ?? (snapshot.chatTabs?.length === 1 ? snapshot.chatTabs[0] : undefined);
  const composerId = normalizeComposerId(snapshot.activeComposerId || activeTab?.composerId);
  if (!composerId) return false;
  if (topicManager.findByComposerId(composerId)) return false;
  return true;
}

export const TOPIC_CREATE_DELAY_MS = 500;
export const PURGE_SCAN_MAX = 10000;
export const PROJECT_PICK_TTL_MS = 10 * 60 * 1000;
export const PROJECT_PICK_MAX = 8;
export const PROJECT_SCAN_MAX = 600;
export const PROJECT_LIST_MAX = 30;

export interface ProjectCandidate {
  path: string;
  name: string;
  score: number;
}

export interface PendingProjectPick {
  chatId: number;
  createdAt: number;
  query: string;
  candidates: ProjectCandidate[];
}

export const pendingProjectPicks = new Map<string, PendingProjectPick>();

export function makeProjectPickToken(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function cleanupExpiredProjectPicks(): void {
  const now = Date.now();
  for (const [token, item] of pendingProjectPicks) {
    if (now - item.createdAt > PROJECT_PICK_TTL_MS) pendingProjectPicks.delete(token);
  }
}
