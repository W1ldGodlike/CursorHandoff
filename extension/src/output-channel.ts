import * as vscode from 'vscode';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { loadLocaleStrings, normalizeLocale, tr } from './extension-locale.js';

const CHANNEL_NAME = 'CursorHandoff';
const EXT_LOG_REL = join('exthost', 'cursor-handoff.cursor-handoff', 'CursorHandoff.log');

/**
 * Wraps LogOutputChannel or plain OutputChannel in a unified interface
 * so the rest of the extension can use `.info()`, `.warn()`, `.error()`, etc.
 */
export interface UnifiedOutputChannel extends vscode.Disposable {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  show(preserveFocus?: boolean): void;
  appendLine(msg: string): void;
}

export function createOutputChannel(): UnifiedOutputChannel {
  try {
    const ch = vscode.window.createOutputChannel(CHANNEL_NAME, { log: true });
    return ch as UnifiedOutputChannel;
  } catch {
    const ch = vscode.window.createOutputChannel(CHANNEL_NAME);
    return {
      info:  (m) => ch.appendLine(m),
      warn:  (m) => ch.appendLine(`[WARN] ${m}`),
      error: (m) => ch.appendLine(`[ERROR] ${m}`),
      show:  (preserveFocus) => ch.show(preserveFocus),
      appendLine: (m) => ch.appendLine(m),
      dispose: () => ch.dispose(),
    };
  }
}

interface JsonLogLine {
  ts: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

/** Latest CursorHandoff.log under Cursor logs (LogOutputChannel sink). */
export function findLatestExtensionLogUri(): vscode.Uri | undefined {
  const logsRoot = cursorLogsRoot();
  if (!logsRoot || !existsSync(logsRoot)) return undefined;

  let newest: { path: string; mtime: number } | undefined;

  for (const session of readdirSync(logsRoot)) {
    const sessionPath = join(logsRoot, session);
    try {
      if (!statSync(sessionPath).isDirectory()) continue;
    } catch {
      continue;
    }

    for (const windowDir of readdirSync(sessionPath)) {
      const logPath = join(sessionPath, windowDir, EXT_LOG_REL);
      if (!existsSync(logPath)) continue;
      const mtime = statSync(logPath).mtimeMs;
      if (!newest || mtime > newest.mtime) {
        newest = { path: logPath, mtime };
      }
    }
  }

  return newest ? vscode.Uri.file(newest.path) : undefined;
}

function cursorLogsRoot(): string | undefined {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    return appData ? join(appData, 'Cursor', 'logs') : undefined;
  }
  const home = process.env.HOME;
  if (!home) return undefined;
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Cursor', 'logs');
  }
  return join(home, '.config', 'Cursor', 'logs');
}

/** Output panel focus is unreliable in Cursor Glass — also open the on-disk log. */
export async function revealOutputChannel(channel: UnifiedOutputChannel): Promise<void> {
  for (const cmd of [
    'workbench.panel.output.focus',
    'workbench.action.output.show',
    'workbench.action.output.toggleOutput',
  ]) {
    try {
      await vscode.commands.executeCommand(cmd);
      break;
    } catch {
      /* try next command */
    }
  }

  channel.show(false);

  const logUri = findLatestExtensionLogUri();
  if (logUri) {
    const doc = await vscode.workspace.openTextDocument(logUri);
    await vscode.window.showTextDocument(doc, { preview: false });
    return;
  }

  const config = vscode.workspace.getConfiguration('cursorHandoff');
  const locale = normalizeLocale(config.get<string>('locale', 'en'));
  const workspacePaths = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  const extPath = vscode.extensions.getExtension('cursor-handoff.cursor-handoff')?.extensionPath ?? '';
  const dict = loadLocaleStrings(extPath, workspacePaths, locale);

  void vscode.window.showInformationMessage(
    tr(dict, 'ext.output.openedHint', 'CursorHandoff: Output panel opened. Select the «CursorHandoff» channel if empty.'),
  );
}

export function appendLogLine(channel: UnifiedOutputChannel, raw: string): void {
  try {
    const parsed: JsonLogLine = JSON.parse(raw);
    switch (parsed.level) {
      case 'error': channel.error(parsed.msg); break;
      case 'warn':  channel.warn(parsed.msg);  break;
      default:      channel.info(parsed.msg);   break;
    }
  } catch {
    channel.info(raw);
  }
}
