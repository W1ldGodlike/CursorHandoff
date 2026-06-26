export type LogLevel = 'info' | 'warn' | 'error';

export type LogScope =
  | 'startup'
  | 'telegram'
  | 'queue'
  | 'cdp'
  | 'relay'
  | 'outbox'
  | 'extension'
  | 'wake'
  | 'tunnel'
  | 'bridge'
  | 'state';

export interface LogContext {
  scope?: LogScope;
  op?: string;
  threadId?: number | string;
  windowId?: string;
  windowTitle?: string;
  chatId?: number | string;
  itemId?: string;
  rid?: string;
  attempt?: number;
  durationMs?: number;
  composerId?: string;
  errno?: string;
  hint?: string;
}

export interface FormattedLogLine {
  human: string;
  json: Record<string, unknown>;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b\d{8,}:[A-Za-z0-9_-]{30,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]+/gi,
  /\bpassword[=:]\s*\S+/gi,
  /\btoken[=:]\s*\S+/gi,
];

let dedupeEnabled = false;
const dedupeWindowMs = 30_000;
const dedupeBuckets = new Map<string, { count: number; firstAt: number; lastAt: number }>();
const commandOkThrottleMs = 2_000;
const commandOkLastAt = new Map<string, number>();

export function enableLogDedupe(enabled = true): void {
  dedupeEnabled = enabled;
}

export function resetLogDedupe(): void {
  dedupeBuckets.clear();
  commandOkLastAt.clear();
}

function commandOkThrottleKey(message: string, ctx?: LogContext): string {
  return [ctx?.op ?? '', ctx?.hint ?? '', ctx?.windowTitle ?? '', message.slice(0, 48)].join('|');
}

export function logCommandOk(message: string, ctx?: LogContext): void {
  const key = commandOkThrottleKey(message, ctx);
  const now = Date.now();
  const last = commandOkLastAt.get(key);
  if (last !== undefined && now - last < commandOkThrottleMs) return;
  commandOkLastAt.set(key, now);
  logInfo('COMMAND_OK', message, ctx);
}

export function newRid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function maskSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => {
      if (m.length <= 8) return '***';
      return `${m.slice(0, 4)}…${m.slice(-4)}`;
    });
  }
  return out;
}

export function sanitizePathForUi(path: string): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (home && path.startsWith(home)) {
    return `~${path.slice(home.length).replace(/\\/g, '/')}`;
  }
  return path.replace(/\\/g, '/');
}

export function normalizeError(err: unknown): { message: string; errno?: string; code?: string } {
  if (err instanceof Error) {
    const errno = (err as NodeJS.ErrnoException).code;
    return { message: err.message, errno, code: errno };
  }
  return { message: String(err) };
}

function contextKey(code: string, ctx?: LogContext): string {
  const parts = [
    code,
    ctx?.scope ?? '',
    ctx?.op ?? '',
    String(ctx?.threadId ?? ''),
    String(ctx?.windowId ?? ''),
    String(ctx?.itemId ?? ''),
    String(ctx?.rid ?? ''),
  ];
  return parts.join('|');
}

function isAlwaysLogged(level: LogLevel, code: string): boolean {
  if (level === 'error') return true;
  if (code.includes('FATAL') || code.endsWith('_FAIL')) return true;
  if (code === 'STARTUP_OK' || code === 'DATA_DIR_NOT_WRITABLE') return true;
  return false;
}

export function shouldEmitLog(
  level: LogLevel,
  code: string,
  ctx?: LogContext,
): { emit: boolean; messageOverride?: string } {
  if (!dedupeEnabled || isAlwaysLogged(level, code)) return { emit: true };

  const key = contextKey(code, ctx);
  const now = Date.now();
  const prev = dedupeBuckets.get(key);
  if (!prev) {
    dedupeBuckets.set(key, { count: 1, firstAt: now, lastAt: now });
    return { emit: true };
  }

  prev.count += 1;
  prev.lastAt = now;
  if (now - prev.firstAt < dedupeWindowMs) {
    if (prev.count === 2) return { emit: true };
    if (prev.count > 2 && prev.count % 10 === 0) {
      const secs = Math.round((now - prev.firstAt) / 1000);
      return {
        emit: true,
        messageOverride: `same event repeated x${prev.count} in ${secs}s (code=${code})`,
      };
    }
    return { emit: false };
  }

  dedupeBuckets.set(key, { count: 1, firstAt: now, lastAt: now });
  return { emit: true };
}

function formatContextTail(ctx?: LogContext, forUi = false): string {
  if (!ctx) return '';
  const pairs: string[] = [];
  const add = (k: string, v: string | number | undefined) => {
    if (v === undefined || v === '') return;
    pairs.push(`${k}=${forUi && typeof v === 'string' ? sanitizePathForUi(v) : v}`);
  };
  add('code', undefined); // code is separate
  if (ctx.scope) pairs.push(`scope=${ctx.scope}`);
  if (ctx.op) pairs.push(`op=${ctx.op}`);
  add('threadId', ctx.threadId);
  add('windowId', ctx.windowId);
  add('windowTitle', ctx.windowTitle);
  add('chatId', ctx.chatId);
  add('itemId', ctx.itemId);
  add('rid', ctx.rid);
  add('attempt', ctx.attempt);
  add('durationMs', ctx.durationMs);
  add('composerId', ctx.composerId);
  add('errno', ctx.errno);
  add('hint', ctx.hint);
  return pairs.length ? pairs.join(' ') : '';
}

export function formatEvent(
  level: LogLevel,
  code: string,
  message: string,
  ctx?: LogContext,
): FormattedLogLine {
  const msg = maskSecrets(message);
  const tail = formatContextTail(ctx);
  const prefix = ctx?.scope ? `[${ctx.scope}]` : '';
  const human = `${prefix} ${msg}${tail ? ` ${tail}` : ''} code=${code}`.trim();
  const json: Record<string, unknown> = {
    ts: Date.now(),
    level,
    code,
    msg,
    ...ctx,
  };
  return { human, json };
}

function emit(level: LogLevel, code: string, message: string, ctx?: LogContext): void {
  const gate = shouldEmitLog(level, code, ctx);
  if (!gate.emit) return;
  const text = gate.messageOverride ?? message;
  const { human, json } = formatEvent(level, code, text, ctx);
  if (process.env.LOG_FORMAT === 'json') {
    const line = JSON.stringify(json);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    return;
  }
  if (level === 'error') console.error(human);
  else if (level === 'warn') console.warn(human);
  else console.log(human);
}

export function logInfo(code: string, message: string, ctx?: LogContext): void {
  emit('info', code, message, ctx);
}

export function logWarn(code: string, message: string, ctx?: LogContext): void {
  emit('warn', code, message, ctx);
}

export function logError(code: string, message: string, ctx?: LogContext): void {
  emit('error', code, message, ctx);
}

export function parseCodeFromLine(line: string): string | undefined {
  const m = line.match(/\bcode=([A-Z][A-Z0-9_]+)/);
  return m?.[1];
}
