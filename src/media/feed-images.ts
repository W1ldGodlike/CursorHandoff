import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDataDir } from '../core/paths.js';
import { logInfo, logWarn } from '../core/log-event.js';

import type { FeedImageRef } from '../core/types.js';

const MAX_FEED_IMAGE_BYTES = 8 * 1024 * 1024;
const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export function feedImagesDir(): string {
  const dir = join(getDataDir(), 'feed-images');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function feedImageId(messageId: string, index: number): string {
  const safe = messageId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return `${safe}-img-${index}`;
}

function extForMime(mime: string): string {
  const m = mime.toLowerCase().split(';')[0].trim();
  return EXT_BY_MIME[m] ?? '.png';
}

export function saveFeedImage(id: string, mime: string, buffer: Buffer): boolean {
  if (buffer.length === 0 || buffer.length > MAX_FEED_IMAGE_BYTES) {
    logWarn('FEED_IMAGE_SKIP_LARGE', `skip ${id} (${buffer.length} bytes)`, {
      scope: 'outbox',
      op: 'feed_image',
      hint: id,
    });
    return false;
  }
  const path = join(feedImagesDir(), `${id}${extForMime(mime)}`);
  writeFileSync(path, buffer);
  logInfo('FEED_IMAGE_SAVE', `${id} ${buffer.length}b`, {
    scope: 'outbox',
    op: 'feed_image',
    hint: id,
  });
  return true;
}

export function resolveFeedImagePath(id: string): string | null {
  const dir = feedImagesDir();
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
    const p = join(dir, `${id}${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

export function readFeedImage(id: string): { buffer: Buffer; mime: string } | null {
  const path = resolveFeedImagePath(id);
  if (!path) return null;
  const buffer = readFileSync(path);
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const mime =
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif'
    : 'image/png';
  return { buffer, mime };
}

/** Dedup sidecar writes when same bytes re-poll. */
export function feedImageContentKey(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}
