/** Stable magic paths for Delete file approval clicks (scoped by toolCallId). */
export const DELETE_FILE_PREFIX = 'delete-file:';

/** Recording 2026-07-03: header text is `Deletefile.mjsRejectAccept^` with no spaces. */
export function parseDeleteFilenameFromCardText(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!/^delete/i.test(text) || /^deleted/i.test(text)) return '';
  return text
    .replace(/^delete\s*/i, '')
    .replace(/reject\s*accept\^?.*/i, '')
    .replace(/⏎.*$/g, '')
    .trim();
}

export function deleteFileAcceptPath(toolCallId: string, filename = ''): string {
  const fileSeg = filename ? `:${encodeURIComponent(filename)}` : '';
  return `${DELETE_FILE_PREFIX}${toolCallId}${fileSeg}:accept`;
}

export function deleteFileRejectPath(toolCallId: string, filename = ''): string {
  const fileSeg = filename ? `:${encodeURIComponent(filename)}` : '';
  return `${DELETE_FILE_PREFIX}${toolCallId}${fileSeg}:reject`;
}

export function isDeleteFileSelector(path: string): boolean {
  return path.startsWith(DELETE_FILE_PREFIX);
}

export function parseDeleteFileSelector(
  path: string,
): { toolCallId: string; filename?: string; kind: 'accept' | 'reject' } | null {
  const withFile = path.match(/^delete-file:([^:]+):([^:]+):(accept|reject)$/);
  if (withFile && withFile[2] !== 'accept' && withFile[2] !== 'reject') {
    let filename = withFile[2];
    try {
      filename = decodeURIComponent(filename);
    } catch { /* keep raw */ }
    return { toolCallId: withFile[1], filename, kind: withFile[3] as 'accept' | 'reject' };
  }
  const plain = path.match(/^delete-file:(.+):(accept|reject)$/);
  if (!plain) return null;
  return { toolCallId: plain[1], kind: plain[2] as 'accept' | 'reject' };
}
