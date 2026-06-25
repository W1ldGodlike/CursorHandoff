export function isManualPollAbort(err: unknown, localAbortSignaled: boolean): boolean {
  if (!localAbortSignaled) return false;
  if (!(err instanceof Error)) return false;
  const name = err.name.toLowerCase();
  const msg = err.message.toLowerCase();
  return name.includes('abort') || msg.includes('aborted');
}
