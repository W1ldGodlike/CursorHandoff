import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logError, normalizeError, sanitizePathForUi } from '../core/log-event.js';
import type { LogContext } from '../core/log-event.js';

function relayCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'relay', op, ...extra };
}

/** HttpOnly cookie name; must match client expectations for non-HttpOnly cases (parsed on server). */
export const WEBAPP_SESSION_COOKIE = 'cursor_handoff_session';

const MAX_SESSIONS = 128;
const TOKEN_HEX_LEN = 64; // randomBytes(32).toString('hex') — hex token length
/** Session TTL; must match Max-Age cookie in relay. */
export const WEBAPP_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface WebappSessionStore {
  has(token: string): boolean;
  add(token: string): void;
  remove(token: string): void;
}

export function createWebappSessionStore(dataDir: string): WebappSessionStore {
  const filePath = join(dataDir, 'webapp-sessions.json');
  const tokens = new Map<string, number>(); // token → createdAt

  function load(): void {
    try {
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as { tokens?: unknown };
      if (Array.isArray(data.tokens)) {
        for (const t of data.tokens) {
          // Old format — string array; new — [token, createdAt]
          if (typeof t === 'string' && isTokenShape(t)) tokens.set(t, Date.now());
          else if (Array.isArray(t) && typeof t[0] === 'string' && isTokenShape(t[0])) {
            tokens.set(t[0], typeof t[1] === 'number' ? t[1] : Date.now());
          }
        }
      }
    } catch {
      // ignore corrupt or missing file
    }
  }

  function save(): void {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(filePath, JSON.stringify({ tokens: [...tokens.entries()] }) + '\n', 'utf-8');
    } catch (e) {
      const { message, errno } = normalizeError(e);
      logError(
        'RELAY_SESSION_PERSIST_FAIL',
        `Failed to persist ${sanitizePathForUi(filePath)}: ${message}`,
        relayCtx('session_persist', { errno }),
      );
    }
  }

  function pruneExpired(): void {
    const cutoff = Date.now() - WEBAPP_SESSION_TTL_MS;
    let changed = false;
    for (const [t, createdAt] of tokens) {
      if (createdAt < cutoff) {
        tokens.delete(t);
        changed = true;
      }
    }
    if (changed) save();
  }

  load();
  pruneExpired();

  return {
    has(token: string): boolean {
      if (!isTokenShape(token)) return false;
      const createdAt = tokens.get(token);
      if (createdAt === undefined) return false;
      if (Date.now() - createdAt > WEBAPP_SESSION_TTL_MS) {
        tokens.delete(token);
        save();
        return false;
      }
      return true;
    },
    add(token: string): void {
      if (!isTokenShape(token)) return;
      if (tokens.has(token)) return;
      pruneExpired();
      tokens.set(token, Date.now());
      while (tokens.size > MAX_SESSIONS) {
        const first = tokens.keys().next().value as string | undefined;
        if (first !== undefined) tokens.delete(first);
      }
      save();
    },
    remove(token: string): void {
      if (!isTokenShape(token)) return;
      if (tokens.delete(token)) save();
    },
  };
}

function isTokenShape(s: string): boolean {
  return s.length === TOKEN_HEX_LEN && /^[a-f0-9]+$/i.test(s);
}

export function parseSessionCookie(
  cookieHeader: string | undefined,
  name: string
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === name) {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return undefined;
}
