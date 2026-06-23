import * as vscode from 'vscode';
import { loadLocaleStrings, normalizeLocale, tr } from './extension-locale.js';

export interface HealthData {
  ok: boolean;
  build?: {
    version: string;
    builtAt: string;
    compatVersion: number;
    fingerprint: string;
    bundleSha256: string;
  };
  connected: boolean;
  agentStatus: string;
  clients: number;
  uptime: number;
  windows: { id: string; title: string }[];
  activeWindowId: string;
  mode: string | null;
  model: string | null;
  chatTabCount: number;
  pendingApprovalCount: number;
  generation: number;
}

export type ServerState = 'running' | 'disconnected' | 'stopped' | 'error';

function loadDict(context: vscode.ExtensionContext): Record<string, string> {
  const config = vscode.workspace.getConfiguration('cursorHandoff');
  const locale = normalizeLocale(config.get<string>('locale', 'en'));
  const workspacePaths = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  return loadLocaleStrings(context.extensionPath, workspacePaths, locale);
}

function trParam(dict: Record<string, string>, key: string, fb: string, params: Record<string, string | number>): string {
  let text = tr(dict, key, fb);
  for (const [k, v] of Object.entries(params)) {
    text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

export function createStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.command = 'workbench.action.quickOpen';
  updateStatusBar(item, context, 'stopped');
  item.show();
  context.subscriptions.push(item);
  return item;
}

export function updateStatusBar(
  item: vscode.StatusBarItem,
  context: vscode.ExtensionContext,
  state: ServerState,
  health?: HealthData,
): void {
  const dict = loadDict(context);
  switch (state) {
    case 'running':
      item.text = `$(device-mobile) ${tr(dict, 'ext.statusBar.running', 'Handoff: Running')}`;
      item.backgroundColor = undefined;
      item.color = '#3fa266';
      item.tooltip = buildTooltip(dict, health);
      item.command = 'cursorHandoff.status.focus';
      break;
    case 'disconnected':
      item.text = `$(device-mobile) ${tr(dict, 'ext.statusBar.disconnected', 'Handoff: No CDP')}`;
      item.backgroundColor = undefined;
      item.color = '#e5c07b';
      item.tooltip = tr(dict, 'ext.statusBar.tooltip.disconnected', 'Server running, CDP not connected — click for panel');
      item.command = 'cursorHandoff.status.focus';
      break;
    case 'stopped':
      item.text = `$(device-mobile) ${tr(dict, 'ext.statusBar.stopped', 'Handoff: Stopped')}`;
      item.backgroundColor = undefined;
      item.color = undefined;
      item.tooltip = tr(dict, 'ext.statusBar.tooltip.stopped', 'Click to open panel');
      item.command = 'cursorHandoff.status.focus';
      break;
    case 'error':
      item.text = `$(device-mobile) ${tr(dict, 'ext.statusBar.error', 'Handoff: Error')}`;
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      item.color = undefined;
      item.tooltip = tr(dict, 'ext.statusBar.tooltip.error', 'Server crashed — click for panel');
      item.command = 'cursorHandoff.status.focus';
      break;
  }
}

function buildTooltip(dict: Record<string, string>, health?: HealthData): string {
  if (!health) return tr(dict, 'ext.statusBar.tooltip.running', 'Running');
  const lines: string[] = [];
  if (health.pendingApprovalCount > 0) {
    lines.push(trParam(dict, 'ext.statusBar.tooltip.pendingApprovals', 'Pending approve: {count}', {
      count: health.pendingApprovalCount,
    }));
  }
  return lines.length > 0 ? lines.join('\n') : tr(dict, 'ext.statusBar.tooltip.running', 'Running');
}
