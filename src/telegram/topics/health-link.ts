import type { TelegramApiClient } from '../types.js';
import { isRateLimitError } from '../transport/telegram-errors.js';
import type { TopicManager } from './manager.js';

export function isTopicNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('thread not found') || msg.includes('TOPIC_DELETED');
}

export type TopicProbeResult = 'alive' | 'dead' | 'unknown';

/** Forum topic check: alive / dead / unknown (429 etc.). */
export async function probeForumTopic(
  api: TelegramApiClient,
  chatId: number,
  threadId: number,
): Promise<TopicProbeResult> {
  try {
    await api.sendChatAction(chatId, 'typing', { message_thread_id: threadId });
    return 'alive';
  } catch (err) {
    if (isTopicNotFoundError(err)) return 'dead';
    if (isRateLimitError(err)) return 'unknown';
    return 'dead';
  }
}

/** false only when topic is definitely deleted. unknown/429 → true (do not drop mapping in sync). */
export async function isTopicReachable(
  api: TelegramApiClient,
  chatId: number,
  threadId: number,
): Promise<boolean> {
  const probe = await probeForumTopic(api, chatId, threadId);
  return probe !== 'dead';
}

/** Deep link into Telegram supergroup forum topic. */
export function buildForumTopicDeepLink(chatId: number, threadId: number): string {
  const chatPart = String(chatId).replace(/^-100/, '');
  return `https://t.me/c/${chatPart}/${threadId}`;
}

export function resolveTopicDeepLink(opts: {
  chatId: number | undefined;
  topicManager: TopicManager;
  windowId: string;
  windowTitle: string;
  tabTitle: string;
  composerId?: string;
}): string | null {
  if (!opts.chatId) return null;

  let threadId: number | undefined;
  if (opts.composerId) {
    const byComposer = opts.topicManager.findByComposerIdInWindow(opts.composerId, opts.windowId)
      ?? opts.topicManager.findByComposerId(opts.composerId);
    threadId = byComposer?.threadId;
  }
  if (!threadId) {
    threadId = opts.topicManager.getThreadForSnapshot(
      opts.windowId,
      opts.windowTitle,
      opts.tabTitle,
    );
  }
  if (!threadId) return null;
  return buildForumTopicDeepLink(opts.chatId, threadId);
}
