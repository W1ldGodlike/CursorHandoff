import { appendFileSync, readFileSync } from 'fs';
import { logError, logInfo, logWarn, normalizeError, sanitizePathForUi } from './log-event.js';
import type { LogContext } from './log-event.js';
import { DATA_DIR_NOT_WRITABLE } from './paths.js';

export function formatErrDetail(err: unknown): string {
  return err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
}

export function startupCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'startup', op, ...extra };
}

export function cdpCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'cdp', op, ...extra };
}

export function telegramCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'telegram', op, ...extra };
}

export function logDataDirNotWritable(err: unknown, dataDir: string): void {
  const norm = normalizeError(err);
  logError(
    'DATA_DIR_NOT_WRITABLE',
    `${DATA_DIR_NOT_WRITABLE}: ${sanitizePathForUi(dataDir)} (${norm.errno ?? 'unknown'}: ${norm.message})`,
    startupCtx('verify_data_dir', { errno: norm.errno, hint: dataDir }),
  );
}

/** Mirror DATA_DIR fail into handoff-server.log when logEvent path may not flush before exit. */
export function appendDataDirFailMirror(logPath: string, err: unknown, ts: () => string): void {
  try {
    appendFileSync(logPath, `${ts()} [ERROR] code=DATA_DIR_NOT_WRITABLE ${normalizeError(err).message}\n`);
  } catch {
    /* DATA_DIR may be missing or read-only — silent */
  }
}

export function logCdpBridgeError(err: unknown): void {
  const norm = normalizeError(err);
  logError('CDP_BRIDGE_ERROR', norm.message, cdpCtx('bridge_error', { errno: norm.errno }));
}

export function logTgStartFail(err: unknown): void {
  logError('TG_START_FAIL', formatErrDetail(err), telegramCtx('start'));
}

export function logCdpConnecting(): void {
  logInfo('CDP_CONNECTING', 'Connecting to Cursor IDE...', cdpCtx('connect'));
}

export function logTgTransportRaw(): void {
  logInfo('TG_TRANSPORT_RAW', 'Using raw Bot API transport (no Grammy)', telegramCtx('transport_select'));
}

export function logTgAuthRegistered(names: string): void {
  logInfo('TG_AUTH_REGISTERED', `Registered user(s): ${names}`, telegramCtx('auth'));
}

export function logTgAuthHint(message: string): void {
  logInfo('TG_AUTH_HINT', message, telegramCtx('auth'));
}

export function logStartupOk(hint: string): void {
  logInfo('STARTUP_OK', 'Handoff server starting', startupCtx('boot', { hint }));
}

export function logStartupVersion(version: string): void {
  logInfo('STARTUP_VERSION', `CursorHandoff v${version}`, startupCtx('boot', { hint: version }));
}

export function logStartupConfig(hint: string): void {
  logInfo('STARTUP_CONFIG', 'Runtime configuration', startupCtx('config', { hint }));
}

export function logStartupAuditStale(): void {
  logWarn(
    'STARTUP_AUDIT_STALE',
    'Server continues but Telegram/outbound may use STALE code paths',
    startupCtx('startup_audit'),
  );
}

export function logStartupAuditSkip(entryPath: string): void {
  logInfo(
    'STARTUP_AUDIT_SKIP',
    `Dev entry (${entryPath}) — bundle audit skipped`,
    startupCtx('startup_audit', { hint: entryPath }),
  );
}

export function logShutdown(): void {
  logInfo('SHUTDOWN', 'Shutting down...', startupCtx('shutdown'));
}

export function logUncaughtException(err: unknown): void {
  if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPIPE') return;
  logError('STARTUP_UNCAUGHT', formatErrDetail(err), startupCtx('uncaught_exception'));
}

export function logUnhandledRejection(reason: unknown): void {
  logError('UNHANDLED_REJECTION', formatErrDetail(reason), startupCtx('unhandled_rejection'));
}

export function logStartupFatal(err: unknown): void {
  logError('STARTUP_FATAL', formatErrDetail(err), startupCtx('fatal'));
}

export function logShutdownFail(err: unknown): void {
  logError('SHUTDOWN_FAIL', formatErrDetail(err), startupCtx('shutdown'));
}

export function registerStartupProcessHandlers(onUncaughtExit: () => void): void {
  process.on('uncaughtException', (err) => {
    logUncaughtException(err);
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPIPE') return;
    setTimeout(onUncaughtExit, 100);
  });
  process.on('unhandledRejection', (reason) => {
    logUnhandledRejection(reason);
  });
}

export function resolvePackageVersion(importMetaUrl: string): string {
  let version = 'unknown';
  for (const rel of ['../../package.json', '../package.json', '../../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, importMetaUrl), 'utf-8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === 'cursor-handoff') {
        version = pkg.version ?? 'unknown';
        break;
      }
    } catch {
      /* try next path */
    }
  }
  return version;
}
