import { formatExtensionLogLine } from './log-event.js';

export type ExtensionUiLogLevel = 'info' | 'warn' | 'error';

export type ExtensionUiLogFn = (line: string, level?: ExtensionUiLogLevel) => void;

let extensionUiLog: ExtensionUiLogFn | undefined;

export function bindExtensionUiLog(fn: ExtensionUiLogFn | undefined): void {
  extensionUiLog = fn;
}

export function emitExtensionUiLog(line: string, level: ExtensionUiLogLevel = 'info'): void {
  extensionUiLog?.(line, level);
}

export function formatSettingsAddonFail(label: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return formatExtensionLogLine('error', `${label}: ${msg}`, {
    scope: 'settings',
    code: 'SETTINGS_ADDON_FAIL',
    op: 'addon',
  });
}
