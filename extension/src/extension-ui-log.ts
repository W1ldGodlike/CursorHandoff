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

export function formatSidebarPortKillFail(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return formatExtensionLogLine('error', `Failed to terminate process: ${msg}`, {
    scope: 'sidebar',
    code: 'SIDEBAR_PORT_KILL_FAIL',
    op: 'kill',
  });
}

export function formatSidebarPortCheckLog(
  kind: 'free' | 'handoff' | 'foreign',
  port: number,
): string {
  return formatExtensionLogLine('info', `Port check port=${port}`, {
    scope: 'sidebar',
    code: 'SIDEBAR_PORT_CHECK',
    op: kind,
  });
}

export function formatSettingsAddonFail(label: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return formatExtensionLogLine('error', `${label}: ${msg}`, {
    scope: 'settings',
    code: 'SETTINGS_ADDON_FAIL',
    op: 'addon',
  });
}
