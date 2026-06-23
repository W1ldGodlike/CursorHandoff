import { readFileSync, writeFileSync, existsSync } from 'fs';

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
          updatedBy: raw.updatedBy ?? 'cursor-handoff',
        };
      }
    }
  } catch {
    /* fresh start */
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
  try {
    writeFileSync(getCursorWakeStatePath(dataDir), JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn(
      '[cursor-wake-state] Failed to save:',
      err instanceof Error ? err.message : err
    );
  }
  return state;
}

export function isRaiseCursorEnabled(dataDir: string): boolean {
  return readCursorWakeState(dataDir).raiseCursor;
}
