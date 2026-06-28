export type LogLevel = 'info' | 'warn' | 'error';

export interface LogContext {
  scope?: string;
  op?: string;
  threadId?: number | string;
  windowId?: string;
  code?: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b\d{8,}:[A-Za-z0-9_-]{30,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]+/gi,
  /\bpassword[=:]\s*\S+/gi,
  /\btoken[=:]\s*\S+/gi,
];

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

function homeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? '';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceHomeInText(text: string): string {
  const home = homeDir();
  if (!home) return text.replace(/\\/g, '/');

  const homeSlash = home.replace(/\\/g, '/');
  if (process.platform === 'win32') {
    const re = new RegExp(escapeRegExp(homeSlash), 'gi');
    return text.replace(/\\/g, '/').replace(re, '~');
  }
  if (text.includes(home)) {
    return text.split(home).join('~').replace(/\\/g, '/');
  }
  return text.replace(/\\/g, '/');
}

export function sanitizePathForUi(path: string): string {
  const home = homeDir();
  const norm = path.replace(/\\/g, '/');
  if (home) {
    const homeSlash = home.replace(/\\/g, '/');
    if (process.platform === 'win32') {
      if (norm.toLowerCase().startsWith(homeSlash.toLowerCase())) {
        return `~${norm.slice(homeSlash.length)}`;
      }
    } else if (path.startsWith(home)) {
      return `~${path.slice(home.length).replace(/\\/g, '/')}`;
    }
  }
  return norm;
}

/** Human-facing Output lines: redact secrets and shorten home paths. */
export function sanitizeLogForUi(text: string): string {
  return replaceHomeInText(maskSecrets(text));
}

export function formatExtensionLogLine(level: LogLevel, message: string, ctx?: LogContext): string {
  const parts: string[] = [message];
  if (ctx?.scope) parts.push(`scope=${ctx.scope}`);
  if (ctx?.op) parts.push(`op=${ctx.op}`);
  if (ctx?.code) parts.push(`code=${ctx.code}`);
  const line = sanitizeLogForUi(parts.join(' '));
  if (level === 'error') return `[ERROR] ${line}`;
  if (level === 'warn') return `[WARN] ${line}`;
  return line;
}

export function parseCodeFromLine(line: string): string | undefined {
  const m = line.match(/\bcode=([A-Z][A-Z0-9_]+)/);
  return m?.[1];
}

export type ServerChildLogLevel = 'info' | 'warn' | 'error';

function appendHintTail(msg: string, hint: unknown): string {
  if (typeof hint !== 'string' || !hint.trim()) return msg;
  const safeHint = sanitizePathForUi(hint);
  return msg.includes('hint=') ? msg : `${msg} hint=${safeHint}`;
}

type StructuredChildLog = {
  level?: string;
  msg?: string;
  code?: string;
  hint?: string;
};

/** Unwrap legacy double-encoded lines: outer msg holds inner JSON string. */
function unwrapStructuredChildLog(parsed: StructuredChildLog): StructuredChildLog {
  const msg = parsed.msg ?? '';
  if (!msg.trimStart().startsWith('{')) return parsed;
  try {
    const inner = JSON.parse(msg) as StructuredChildLog;
    if (typeof inner.code !== 'string') return parsed;
    return {
      level: inner.level ?? parsed.level,
      msg: inner.msg ?? msg,
      code: inner.code,
      hint: inner.hint ?? parsed.hint,
    };
  } catch {
    return parsed;
  }
}

/** Format one server child stdout/stderr line for the extension Output channel. */
export function formatServerChildLogLine(raw: string): { level: ServerChildLogLevel; line: string } {
  const trimmed = raw.trim();
  try {
    const parsed = unwrapStructuredChildLog(JSON.parse(trimmed) as StructuredChildLog);
    const code = typeof parsed.code === 'string' ? parsed.code : parseCodeFromLine(parsed.msg ?? '');
    const suffix = code ? ` code=${code}` : '';
    const level: ServerChildLogLevel =
      parsed.level === 'error' ? 'error' : parsed.level === 'warn' ? 'warn' : 'info';
    const line = sanitizeLogForUi(appendHintTail(`${parsed.msg ?? ''}${suffix}`, parsed.hint));
    return { level, line };
  } catch {
    const code = parseCodeFromLine(trimmed);
    const line = code ? `${trimmed} code=${code}` : trimmed;
    return { level: 'info', line: sanitizeLogForUi(line) };
  }
}
