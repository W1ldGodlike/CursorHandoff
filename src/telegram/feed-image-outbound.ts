/**
 * Telegram delivery for generated feed images.
 *
 * Pipeline (shared with web):
 *   CDP collect → saveFeedImage sidecar → messages[].images[] (FeedImageRef)
 *
 * Web client: `<img src="/api/feed-image/:id">` (browser loads sidecar).
 * Telegram:   read same sidecar from disk → sendPhoto / sendDocument (no DOM re-parse).
 */
import type { ChatElement, FeedImageRef } from '../core/types.js';
import { resolveFeedImagePath } from '../media/feed-images.js';
import { groupOutboxFilesForSend, sendTelegramMediaGroup } from '../media/outbox-watch.js';
import { logInfo, logWarn, normalizeError } from '../core/log-event.js';
import type { MessageTracker } from './pipeline/tracker.js';
import type { TelegramApiClient } from './types.js';
import { shouldSendChatElement, type NotifyMode } from './ui/notify-mode.js';

export function feedImageElementTrackId(composerId: string | undefined, ref: FeedImageRef): string {
  const tab = composerId?.trim() || '_';
  return `feed-img:${tab}:${ref.id}`;
}

/** Same rows as web `appendFeedImages` on completed Generate image tool lines. */
export function feedImageRefsFromMessage(element: ChatElement): FeedImageRef[] {
  if (element.type !== 'tool') return [];
  if (element.status !== 'completed') return [];
  if (!/^generated\s+image$/i.test((element.action || '').trim())) return [];
  return element.images ?? [];
}

/** Sidecar must exist on disk — mirrors web waiting for /api/feed-image to be readable. */
export function readyFeedImageSidecars(refs: FeedImageRef[]): { ref: FeedImageRef; path: string }[] {
  const out: { ref: FeedImageRef; path: string }[] = [];
  for (const ref of refs) {
    const path = resolveFeedImagePath(ref.id);
    if (path) out.push({ ref, path });
  }
  return out;
}

export async function syncFeedImagesToThread(
  api: TelegramApiClient,
  chatId: number,
  messageTracker: MessageTracker,
  opts: {
    threadId: number;
    composerId?: string;
    messages: ChatElement[];
    notifyMode: NotifyMode;
    agentIdle: boolean;
  },
): Promise<void> {
  const { threadId, composerId, messages, notifyMode, agentIdle } = opts;

  for (const element of messages) {
    const refs = feedImageRefsFromMessage(element);
    if (!refs.length) continue;

    const tracked = messageTracker.isTracked(threadId, element.id);
    if (!shouldSendChatElement(notifyMode, element, { agentIdle, alreadyTracked: tracked })) {
      continue;
    }

    const pending = readyFeedImageSidecars(refs).filter(
      ({ ref }) => !messageTracker.isTracked(threadId, feedImageElementTrackId(composerId, ref)),
    );
    if (!pending.length) continue;

    const paths = pending.map((p) => p.path);
    try {
      for (const group of groupOutboxFilesForSend(paths)) {
        await sendTelegramMediaGroup(api, chatId, threadId, group);
      }
      for (const { ref } of pending) {
        messageTracker.track(
          threadId,
          feedImageElementTrackId(composerId, ref),
          [],
          ref.id,
          'feed_image',
        );
      }
      logInfo(
        'TG_FEED_IMAGE_OK',
        `sent ${pending.length} sidecar image(s) thread ${threadId}`,
        { scope: 'telegram', op: 'feed_image', threadId, hint: String(pending.length) },
      );
    } catch (err) {
      const norm = normalizeError(err);
      logWarn(
        'TG_FEED_IMAGE_FAIL',
        norm.message,
        { scope: 'telegram', op: 'feed_image', threadId, errno: norm.errno, hint: element.id },
      );
    }
  }
}
