import { writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import {
  MAX_INBOUND_BYTES,
  isInboundImagePath,
  isSupportedImageMime,
  mimeToExt,
  resolveInboundDir,
  safeInboundBaseName,
} from './lifecycle.js';

/** Match Telegram album cap (10 per media group). */
export const MAX_WEB_UPLOAD_ATTACHMENTS = 10;

export interface WebImagePayload {
  mime: string;
  data: string;
}

export interface WebFilePayload {
  mime: string;
  data: string;
  name?: string;
}

export function saveWebInbound(
  buffer: Buffer,
  mime: string,
  workspacePath?: string,
  opts?: { kind?: 'image' | 'file'; baseName?: string },
): string {
  const kind = opts?.kind ?? (isSupportedImageMime(mime) ? 'image' : 'file');
  const dir = resolveInboundDir(workspacePath, kind);
  const ext = opts?.baseName ? '' : mimeToExt(mime);
  const safeName = safeInboundBaseName(opts?.baseName);
  const name = safeName
    ? `${Date.now()}-${safeName}`
    : `${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
  const dest = join(dir, name);
  writeFileSync(dest, buffer);
  return dest;
}

function decodeOnePayload(
  payload: { mime: string; data: string; name?: string },
  workspacePath?: string,
): { path: string; isImage: boolean } | { error: string } {
  if (!payload.mime?.trim()) {
    return { error: 'Missing mime type' };
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(payload.data, 'base64');
  } catch {
    return { error: 'Invalid file data' };
  }
  if (buf.length === 0) return { error: 'Empty file' };
  if (buf.length > MAX_INBOUND_BYTES) {
    return { error: `File too large (max ${MAX_INBOUND_BYTES / (1024 * 1024)} MB — Telegram Bot API limit)` };
  }
  const isImage = isSupportedImageMime(payload.mime);
  const kind = isImage ? 'image' : 'file';
  const path = saveWebInbound(buf, payload.mime, workspacePath, {
    kind,
    baseName: payload.name,
  });
  return { path, isImage };
}

export function decodeWebImagesToPaths(
  images: WebImagePayload[],
  workspacePath?: string,
): { paths: string[] } | { error: string } {
  if (!images.length) return { error: 'No images' };
  if (images.length > MAX_WEB_UPLOAD_ATTACHMENTS) {
    return { error: `Maximum ${MAX_WEB_UPLOAD_ATTACHMENTS} attachments` };
  }
  const paths: string[] = [];
  for (const img of images) {
    if (!isSupportedImageMime(img.mime)) {
      return { error: `Unsupported image format: ${img.mime || 'unknown'}` };
    }
    const decoded = decodeOnePayload(img, workspacePath);
    if ('error' in decoded) return decoded;
    paths.push(decoded.path);
  }
  return { paths };
}

export function decodeWebUploadToPaths(
  images: WebImagePayload[] | undefined,
  files: WebFilePayload[] | undefined,
  workspacePath?: string,
): { imagePaths: string[]; filePaths: string[] } | { error: string } {
  const total = (images?.length ?? 0) + (files?.length ?? 0);
  if (total === 0) return { error: 'No attachments' };
  if (total > MAX_WEB_UPLOAD_ATTACHMENTS) {
    return { error: `Maximum ${MAX_WEB_UPLOAD_ATTACHMENTS} attachments` };
  }

  const imagePaths: string[] = [];
  const filePaths: string[] = [];

  for (const img of images ?? []) {
    if (!isSupportedImageMime(img.mime)) {
      return { error: `Unsupported image format: ${img.mime || 'unknown'}` };
    }
    const decoded = decodeOnePayload(img, workspacePath);
    if ('error' in decoded) return decoded;
    imagePaths.push(decoded.path);
  }

  for (const file of files ?? []) {
    const decoded = decodeOnePayload(file, workspacePath);
    if ('error' in decoded) return decoded;
    if (decoded.isImage) imagePaths.push(decoded.path);
    else filePaths.push(decoded.path);
  }

  return { imagePaths, filePaths };
}

export { isInboundImagePath };
