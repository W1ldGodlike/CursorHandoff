import { parseCodeFromLine } from './log-event.js';
import type { ServerState } from './status-bar.js';

export const TOAST_DEDUPE_MS = 30_000;

export type ServerLogDetectAction =
  | { kind: 'set_state'; state: ServerState }
  | { kind: 'error_toast'; message: string; dedupeKey: 'DATA_DIR_NOT_WRITABLE' }
  | {
    kind: 'warn_toast';
    message: string;
    dedupeKey: 'STARTUP_AUDIT_FAIL' | 'STARTUP_AUDIT_STALE' | 'STARTUP_STALE_KEYBOARD';
  }
  | { kind: 'none' };

export interface ServerLogDetectContext {
  dataDirNotWritablePrefix: string;
  staleBundleMessage: string;
  staleKeyboardMessage: string;
}

export function parseServerStdoutLine(raw: string): { msg: string; code: string | undefined } {
  let msg = raw;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(raw) as { msg?: string; code?: string };
    msg = parsed.msg ?? '';
    code = typeof parsed.code === 'string' ? parsed.code : parseCodeFromLine(msg);
  } catch {
    msg = raw;
    code = parseCodeFromLine(raw);
  }
  return { msg, code };
}

export function classifyServerStdoutLine(
  raw: string,
  ctx: ServerLogDetectContext,
): ServerLogDetectAction {
  const { msg, code } = parseServerStdoutLine(raw);

  if (msg.includes('[cdp-bridge] Connected to')) {
    return { kind: 'set_state', state: 'running' };
  }
  if (msg.includes('[cdp-bridge] Disconnected') || msg.includes('[cdp-bridge] Connection lost')) {
    return { kind: 'set_state', state: 'disconnected' };
  }
  if (msg.includes('[CRASH]') || code === 'CRASH') {
    return { kind: 'set_state', state: 'error' };
  }
  if (code === 'DATA_DIR_NOT_WRITABLE' || msg.includes(ctx.dataDirNotWritablePrefix)) {
    return {
      kind: 'error_toast',
      message: msg.trim() || raw.trim(),
      dedupeKey: 'DATA_DIR_NOT_WRITABLE',
    };
  }
  if (
    code === 'STARTUP_AUDIT_FAIL'
    || code === 'STARTUP_AUDIT_STALE'
    || msg.includes('[startup-audit] STALE OR INVALID BUILD')
  ) {
    const dedupeKey: 'STARTUP_AUDIT_FAIL' | 'STARTUP_AUDIT_STALE' =
      code === 'STARTUP_AUDIT_STALE' ? 'STARTUP_AUDIT_STALE' : 'STARTUP_AUDIT_FAIL';
    return { kind: 'warn_toast', message: ctx.staleBundleMessage, dedupeKey };
  }
  if (msg.includes('Chat keyboard init starting') || msg.includes('Posting chat keyboards to')) {
    return {
      kind: 'warn_toast',
      message: ctx.staleKeyboardMessage,
      dedupeKey: 'STARTUP_STALE_KEYBOARD',
    };
  }
  return { kind: 'none' };
}

/** Deprecation noise from Node/Electron stderr — skip Output channel. */
export function isServerStderrNoiseLine(line: string): boolean {
  return line.includes('DEP0040') || (line.includes('punycode') && line.includes('deprecated'));
}

/** First stderr line containing DATA_DIR prefix for exit toast (dedupeKey DATA_DIR_NOT_WRITABLE). */
export function pickDataDirMessageFromStderr(stderrBuffer: string, prefix: string): string | undefined {
  if (!stderrBuffer.includes(prefix)) return undefined;
  return stderrBuffer.split('\n').find((l) => l.includes(prefix))?.trim();
}

/** Non-empty lines from one child stdout/stderr data chunk. */
export function splitChildLogChunk(data: string): string[] {
  return data.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function createToastDedupe(ms = TOAST_DEDUPE_MS): {
  shouldShow(code: string): boolean;
  reset(): void;
} {
  const map = new Map<string, number>();
  return {
    shouldShow(code: string): boolean {
      const now = Date.now();
      const last = map.get(code);
      if (last !== undefined && now - last < ms) return false;
      map.set(code, now);
      for (const [key, at] of map) {
        if (now - at >= ms) map.delete(key);
      }
      return true;
    },
    reset() {
      map.clear();
    },
  };
}
