import type { CursorState, FeedImageRef } from '../core/types.js';
import type { CdpClient } from './cdp-client.js';
import { feedImageContentKey, feedImageId, saveFeedImage } from '../media/feed-images.js';
import { logInfo, logWarn } from '../core/log-event.js';

export interface CollectedFeedImage {
  messageId: string;
  index: number;
  mime: string;
  data: string;
  width?: number;
  height?: number;
}

/** Runs in Cursor page — fetch imgs/canvas inside composer (incl. Generated image tool cards). */
export const FEED_IMAGE_COLLECT_EXPR = `(async () => {
  const MAX = 16;
  const MAX_BYTES = 8 * 1024 * 1024;
  const MAX_COLLECT_B64_LEN = 700000;
  const MIN_PX = 48;
  const out = [];
  const seenKey = new Set();
  const seenImg = new Set();

  const messageIdFrom = (el) => {
    const msg = el?.closest?.('[data-message-id]');
    return msg?.getAttribute('data-message-id') || '';
  };

  const skipSrc = (src) => {
    if (!src) return true;
    const s = src.trim().toLowerCase();
    if (s.startsWith('vscode-') || s.startsWith('cursor-') || s.startsWith('file:')) return true;
    if (s.endsWith('.svg') || s.includes('.svg?')) return true;
    return false;
  };

  const pushItem = (messageId, index, mime, data, width, height) => {
    if (!messageId || !data || out.length >= MAX) return;
    const key = messageId + ':' + index + ':' + data.length;
    if (seenKey.has(key)) return;
    seenKey.add(key);
    out.push({ messageId, index, mime, data, width, height });
  };

  const bytesToB64 = (bytes) => {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  };

  const encodeViaCanvas = (img) => {
    try {
      const maxDim = 2048;
      let iw = img.naturalWidth || img.width || 0;
      let ih = img.naturalHeight || img.height || 0;
      if (iw < MIN_PX || ih < MIN_PX) {
        iw = img.clientWidth || iw;
        ih = img.clientHeight || ih;
      }
      const max = Math.max(iw, ih);
      if (max > maxDim) {
        const scale = maxDim / max;
        iw = Math.max(1, Math.round(iw * scale));
        ih = Math.max(1, Math.round(ih * scale));
      }
      const canvas = document.createElement('canvas');
      canvas.width = iw;
      canvas.height = ih;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, iw, ih);
      const dataUrl = canvas.toDataURL('image/png');
      const data = dataUrl.split(',')[1];
      if (!data) return null;
      return { mime: 'image/png', data, width: iw, height: ih };
    } catch {
      return null;
    }
  };

  const encodeImg = async (img, messageId, index) => {
    if (seenImg.has(img)) return;
    seenImg.add(img);
    const src = img.currentSrc || img.src || img.getAttribute('src') || '';
    if (skipSrc(src)) return;
    const dw = img.clientWidth || img.width || 0;
    const dh = img.clientHeight || img.height || 0;
    const nw = img.naturalWidth || dw;
    const nh = img.naturalHeight || dh;
    if (Math.max(dw, dh, nw, nh) < MIN_PX) return;

    if (src.startsWith('data:image/')) {
      const m = src.match(/^data:(image\\/[^;]+);base64,(.+)$/);
      if (m?.[2] && m[2].length <= MAX_COLLECT_B64_LEN && m[2].length * 0.75 <= MAX_BYTES) {
        pushItem(messageId, index, m[1], m[2], nw || undefined, nh || undefined);
        return;
      }
    }

    const fromCanvas = encodeViaCanvas(img);
    if (fromCanvas) {
      if (fromCanvas.data.length * 0.75 > MAX_BYTES) return;
      pushItem(messageId, index, fromCanvas.mime, fromCanvas.data, fromCanvas.width, fromCanvas.height);
      return;
    }

    try {
      const resp = await fetch(src);
      const buf = await resp.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > MAX_BYTES) return;
      const mime = resp.headers.get('content-type') || 'image/png';
      pushItem(messageId, index, mime, bytesToB64(new Uint8Array(buf)), nw || undefined, nh || undefined);
    } catch { /* skip */ }
  };

  const encodeCanvasEl = (canvas, messageId, index) => {
    const w = canvas.width || 0;
    const h = canvas.height || 0;
    if (w < MIN_PX || h < MIN_PX) return;
    try {
      const dataUrl = canvas.toDataURL('image/png');
      const data = dataUrl.split(',')[1];
      if (!data || data.length * 0.75 > MAX_BYTES) return;
      pushItem(messageId, index, 'image/png', data, w, h);
    } catch { /* skip */ }
  };

  const counters = new Map();
  const nextIndex = (messageId) => {
    const n = counters.get(messageId) || 0;
    counters.set(messageId, n + 1);
    return n;
  };

  const scanRoot = async (root, forcedMessageId) => {
    if (!root) return;
    const messageId = forcedMessageId || messageIdFrom(root) || root.querySelector?.('[data-message-id]')?.getAttribute('data-message-id') || '';
    if (!messageId) return;

    const imgs = root.querySelectorAll(
      'img.image-pill-img, [class*="image-pill"] img, .markdown-root img, .composer-tool-call-container img, .ui-tool-call-card img, img[src^="blob:"], img[src^="data:image/"], img[src]'
    );
    for (const img of imgs) {
      if (out.length >= MAX) return;
      await encodeImg(img, messageId, nextIndex(messageId));
    }

    for (const canvas of root.querySelectorAll('canvas')) {
      if (out.length >= MAX) return;
      encodeCanvasEl(canvas, messageId, nextIndex(messageId));
    }
  };

  const roots = document.querySelectorAll('[data-flat-index], .virtualized-composer-messages-row');
  for (const root of roots) {
    if (out.length >= MAX) break;
    await scanRoot(root, '');
  }

  for (const row of Array.from(document.querySelectorAll('.virtualized-composer-messages-row')).reverse()) {
    if (out.length >= MAX) break;
    const actionEl = row.querySelector('.ui-tool-call-line-action, .ui-tool-call-card__header');
    const action = (actionEl?.textContent || '').replace(/\\s+/g, ' ').trim();
    const isGenerated = /^generated\\s+image$/i.test(action.slice(0, 40));
    const hasDataImg = row.querySelector('img[src^="data:image/"], img[src^="blob:"]');
    if (!isGenerated && !hasDataImg) continue;
    const messageId = messageIdFrom(row) || row.querySelector('[data-message-id]')?.getAttribute('data-message-id') || '';
    if (!messageId) continue;
    await scanRoot(row, messageId);
    if (isGenerated && out.some((x) => x.messageId === messageId)) break;
  }

  return out;
})()`;

const savedKeys = new Map<string, string>();

function attachImages<T extends { id: string; images?: FeedImageRef[] }>(
  msg: T,
  refs: FeedImageRef[],
): T {
  if (!refs.length) return msg;
  const merged = [...(msg.images ?? [])];
  for (const ref of refs) {
    if (!merged.some((x) => x.id === ref.id)) merged.push(ref);
  }
  return { ...msg, images: merged };
}

/** Copy feed images onto completed Generate-image tool lines when they share an id or sit next to a message that has images. */
export function propagateFeedImagesToGeneratedTools(
  messages: CursorState['messages'],
): CursorState['messages'] {
  if (!messages?.length) return messages;
  const byId = new Map<string, FeedImageRef[]>();
  for (const m of messages) {
    if (!('images' in m) || !m.images?.length) continue;
    byId.set(m.id, m.images);
  }
  if (byId.size === 0) return messages;

  return messages.map((m, i) => {
    if (m.type !== 'tool' || !/^generated\s+image$/i.test((m.action || '').trim())) return m;
    if (m.images?.length) return m;
    const own = byId.get(m.id);
    if (own?.length) return attachImages(m, own);
    for (let j = i + 1; j < Math.min(messages.length, i + 4); j++) {
      const next = messages[j];
      const nextImages = byId.get(next.id);
      if (nextImages?.length) return attachImages(m, nextImages);
    }
    for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
      const prev = messages[j];
      const prevImages = byId.get(prev.id);
      if (prevImages?.length) return attachImages(m, prevImages);
    }
    return m;
  });
}

/** Post-process any CDP extraction (home window or parallel window poll). */
export async function finalizeExtractedState(
  client: CdpClient,
  state: CursorState | null,
): Promise<CursorState | null> {
  if (!state) return state;
  try {
    return (await enrichStateWithFeedImages(client, state)) ?? state;
  } catch (err) {
    logWarn('FEED_IMAGE_ENRICH_FAIL', err instanceof Error ? err.message : String(err), {
      scope: 'cdp',
      op: 'feed_image_enrich',
    });
    return state;
  }
}

export async function enrichStateWithFeedImages(
  client: CdpClient,
  state: CursorState | null,
): Promise<CursorState | null> {
  if (!state?.messages?.length) return state;
  let collected: CollectedFeedImage[];
  try {
    collected = await client.evaluate(FEED_IMAGE_COLLECT_EXPR, 25_000) as CollectedFeedImage[];
  } catch (err) {
    logWarn('FEED_IMAGE_COLLECT_FAIL', err instanceof Error ? err.message : String(err), {
      scope: 'cdp',
      op: 'feed_image_collect',
    });
    return state;
  }
  if (!Array.isArray(collected) || collected.length === 0) {
    if (!Array.isArray(collected)) {
      logWarn('FEED_IMAGE_COLLECT_BAD', 'evaluate did not return an array', {
        scope: 'cdp',
        op: 'feed_image_collect',
      });
    }
    const hasGenerated = state.messages.some(
      (m) => m.type === 'tool' && /^generated\s+image$/i.test((m.action || '').trim()),
    );
    if (hasGenerated) {
      logWarn('FEED_IMAGE_COLLECT_EMPTY', 'Generated image in feed but no DOM imgs collected', {
        scope: 'cdp',
        op: 'feed_image_collect',
      });
    }
    return state;
  }

  const byMessage = new Map<string, FeedImageRef[]>();
  for (const item of collected) {
    if (!item.messageId || !item.data) continue;
    let buffer: Buffer;
    try {
      buffer = Buffer.from(item.data, 'base64');
    } catch {
      continue;
    }
    const key = feedImageContentKey(buffer);
    const id = feedImageId(item.messageId, item.index);
    const prevKey = savedKeys.get(id);
    if (prevKey !== key) {
      if (!saveFeedImage(id, item.mime || 'image/png', buffer)) continue;
      savedKeys.set(id, key);
    }
    const ref: FeedImageRef = {
      id,
      mime: item.mime || 'image/png',
      ...(item.width ? { width: item.width } : {}),
      ...(item.height ? { height: item.height } : {}),
    };
    const list = byMessage.get(item.messageId) ?? [];
    if (!list.some((x) => x.id === id)) list.push(ref);
    byMessage.set(item.messageId, list);
  }

  if (byMessage.size === 0) return state;

  logInfo('FEED_IMAGE_COLLECT_OK', `${collected.length} img(s) → ${byMessage.size} msg(s)`, {
    scope: 'cdp',
    op: 'feed_image_collect',
    hint: String(collected.length),
  });

  let messages = state.messages.map((m) => {
    const refs = byMessage.get(m.id);
    if (!refs?.length) return m;
    if (m.type === 'human' || m.type === 'assistant' || m.type === 'tool' || m.type === 'run_command') {
      return attachImages(m, refs);
    }
    return m;
  });

  messages = propagateFeedImagesToGeneratedTools(messages);
  return { ...state, messages };
}
