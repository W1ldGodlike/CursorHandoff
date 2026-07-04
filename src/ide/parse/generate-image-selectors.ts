/** Stable magic paths for GenerateImage approval clicks (scoped by toolCallId). */
export const GENERATE_IMAGE_PREFIX = 'generate-image:';

export function isGenerateImageAction(action: string): boolean {
  return /^generate\s*image$/i.test(action.trim());
}

export function isGeneratedImageAction(action: string): boolean {
  return /^generated\s*image$/i.test(action.trim());
}

export function generateImageRunPath(toolCallId: string): string {
  return `${GENERATE_IMAGE_PREFIX}${toolCallId}:run`;
}

export function generateImageSkipPath(toolCallId: string): string {
  return `${GENERATE_IMAGE_PREFIX}${toolCallId}:skip`;
}

export function isGenerateImageSelector(path: string): boolean {
  return path.startsWith(GENERATE_IMAGE_PREFIX);
}

export function parseGenerateImageSelector(
  path: string,
): { toolCallId: string; kind: 'run' | 'skip' } | null {
  const m = path.match(/^generate-image:(.+):(run|skip)$/);
  if (!m) return null;
  return { toolCallId: m[1], kind: m[2] as 'run' | 'skip' };
}
