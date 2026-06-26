import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logWarn, normalizeError, sanitizePathForUi } from '../core/log-event.js';
import type { LogContext } from '../core/log-event.js';

function wakeCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'wake', op, ...extra };
}

export type CursorWakeUpdatedBy = 'tray' | 'telegram' | 'cursor-handoff';

export interface CursorWakeState {
  raiseCursor: boolean;
  updatedAt: string;
  updatedBy: CursorWakeUpdatedBy;
}

const DEFAULT_STATE: CursorWakeState = {
  raiseCursor: true,
  updatedAt: new Date().toISOString(),
  updatedBy: 'cursor-handoff',
};

const VALID_UPDATED_BY = new Set<CursorWakeUpdatedBy>(['tray', 'telegram', 'cursor-handoff']);

function parseUpdatedBy(value: unknown): CursorWakeUpdatedBy {
  return VALID_UPDATED_BY.has(value as CursorWakeUpdatedBy)
    ? (value as CursorWakeUpdatedBy)
    : 'cursor-handoff';
}

export function getCursorWakeStatePath(dataDir: string): string {
  return `${dataDir}/cursor-wake-state.json`;
}

export function readCursorWakeState(dataDir: string): CursorWakeState {
  const path = getCursorWakeStatePath(dataDir);
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<CursorWakeState>;
      if (typeof raw.raiseCursor === 'boolean') {
        return {
          raiseCursor: raw.raiseCursor,
          updatedAt: raw.updatedAt ?? new Date().toISOString(),
          updatedBy: parseUpdatedBy(raw.updatedBy),
        };
      }
    }
  } catch {
    /* corrupt or unreadable — bootstrap below, no read-side log */
  }
  writeCursorWakeState(dataDir, DEFAULT_STATE);
  return { ...DEFAULT_STATE };
}

export function writeCursorWakeState(
  dataDir: string,
  partial: Pick<CursorWakeState, 'raiseCursor' | 'updatedBy'>
): CursorWakeState {
  const state: CursorWakeState = {
    raiseCursor: partial.raiseCursor,
    updatedAt: new Date().toISOString(),
    updatedBy: partial.updatedBy,
  };
  const path = getCursorWakeStatePath(dataDir);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  } catch (err) {
    const { message, errno } = normalizeError(err);
    logWarn(
      'WAKE_STATE_SAVE_FAIL',
      `Failed to save ${sanitizePathForUi(path)}: ${message}`,
      wakeCtx('persist_state', { hint: partial.updatedBy, errno }),
    );
  }
  return state;
}

export function isRaiseCursorEnabled(dataDir: string): boolean {
  return readCursorWakeState(dataDir).raiseCursor;
}
