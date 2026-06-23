import { isSupportedImageMime } from '../../media/lifecycle.js';
import type { BotMessage } from '../types.js';

export type InboundMediaKind = 'image' | 'file';

export interface ResolvedInboundMedia {
  fileId: string;
  mime: string;
  baseName?: string;
  kind: InboundMediaKind;
}

function largestPhotoFileId(photos: { file_id: string; width: number; height: number }[]): string {
  const best = photos.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  return best.file_id;
}

/** Unsupported TG content types — not downloadable as a file for Cursor relay. */
export function detectUnsupportedInboundType(msg: BotMessage): string | null {
  if (msg.contact) return 'contact';
  if (msg.location || msg.venue) return 'location';
  if (msg.poll) return 'poll';
  if (msg.dice) return 'dice';
  if (msg.game) return 'game';
  return null;
}

export function resolveInboundMedia(msg: BotMessage): ResolvedInboundMedia | null {
  if (msg.photo?.length) {
    return {
      fileId: largestPhotoFileId(msg.photo),
      mime: 'image/jpeg',
      kind: 'image',
    };
  }
  if (msg.document) {
    const mime = msg.document.mime_type ?? 'application/octet-stream';
    return {
      fileId: msg.document.file_id,
      mime,
      baseName: msg.document.file_name,
      kind: isSupportedImageMime(mime) ? 'image' : 'file',
    };
  }
  if (msg.video) {
    return {
      fileId: msg.video.file_id,
      mime: msg.video.mime_type ?? 'video/mp4',
      baseName: msg.video.file_name ?? 'video.mp4',
      kind: 'file',
    };
  }
  if (msg.voice) {
    return {
      fileId: msg.voice.file_id,
      mime: msg.voice.mime_type ?? 'audio/ogg',
      baseName: 'voice.ogg',
      kind: 'file',
    };
  }
  if (msg.audio) {
    return {
      fileId: msg.audio.file_id,
      mime: msg.audio.mime_type ?? 'audio/mpeg',
      baseName: msg.audio.file_name ?? 'audio.mp3',
      kind: 'file',
    };
  }
  if (msg.animation) {
    return {
      fileId: msg.animation.file_id,
      mime: msg.animation.mime_type ?? 'video/mp4',
      baseName: msg.animation.file_name ?? 'animation.mp4',
      kind: 'file',
    };
  }
  if (msg.sticker) {
    return {
      fileId: msg.sticker.file_id,
      mime: 'image/webp',
      baseName: 'sticker.webp',
      kind: 'file',
    };
  }
  return null;
}
