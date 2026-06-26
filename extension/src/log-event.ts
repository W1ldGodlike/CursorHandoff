export type LogLevel = 'info' | 'warn' | 'error';

export interface LogContext {
  scope?: string;
  op?: string;
  threadId?: number | string;
  windowId?: string;
  code?: string;
}

export function sanitizePathForUi(path: string): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (home && path.startsWith(home)) {
    return `~${path.slice(home.length).replace(/\\/g, '/')}`;
  }
  return path.replace(/\\/g, '/');
}

export function formatExtensionLogLine(level: LogLevel, message: string, ctx?: LogContext): string {
  const parts: string[] = [message];
  if (ctx?.scope) parts.push(`scope=${ctx.scope}`);
  if (ctx?.op) parts.push(`op=${ctx.op}`);
  if (ctx?.code) parts.push(`code=${ctx.code}`);
  const line = parts.join(' ');
  if (level === 'error') return `[ERROR] ${line}`;
  if (level === 'warn') return `[WARN] ${line}`;
  return line;
}

export function parseCodeFromLine(line: string): string | undefined {
  const m = line.match(/\bcode=([A-Z][A-Z0-9_]+)/);
  return m?.[1];
}

export type ServerChildLogLevel = 'info' | 'warn' | 'error';

/** Format one server child stdout/stderr line for the extension Output channel. */
export function formatServerChildLogLine(raw: string): { level: ServerChildLogLevel; line: string } {
  try {
    const parsed = JSON.parse(raw) as { level?: string; msg?: string; code?: string };
    const code = typeof parsed.code === 'string' ? parsed.code : parseCodeFromLine(parsed.msg ?? '');
    const suffix = code ? ` code=${code}` : '';
    const level: ServerChildLogLevel =
      parsed.level === 'error' ? 'error' : parsed.level === 'warn' ? 'warn' : 'info';
    return { level, line: `${parsed.msg ?? ''}${suffix}` };
  } catch {
    const code = parseCodeFromLine(raw);
    return { level: 'info', line: code ? `${raw} code=${code}` : raw };
  }
}
