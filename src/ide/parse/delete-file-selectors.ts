/** Stable magic paths for Delete file approval clicks (scoped by toolCallId). */
export const DELETE_FILE_PREFIX = 'delete-file:';

export function deleteFileAcceptPath(toolCallId: string): string {
  return `${DELETE_FILE_PREFIX}${toolCallId}:accept`;
}

export function deleteFileRejectPath(toolCallId: string): string {
  return `${DELETE_FILE_PREFIX}${toolCallId}:reject`;
}

export function isDeleteFileSelector(path: string): boolean {
  return path.startsWith(DELETE_FILE_PREFIX);
}

export function parseDeleteFileSelector(path: string): { toolCallId: string; kind: 'accept' | 'reject' } | null {
  const m = path.match(/^delete-file:(.+):(accept|reject)$/);
  if (!m) return null;
  return { toolCallId: m[1], kind: m[2] as 'accept' | 'reject' };
}
