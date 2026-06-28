import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { join } from 'path';
import { formatServerChildLogLine, sanitizeLogForUi } from './log-event.js';
import { appendExtDiskLog } from './ext-disk-log.js';
import { tr } from './extension-locale.js';

const CHANNEL_NAME = 'CursorHandoff';

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

export interface OutputChannels {
  /** Extension messages — mirrored to data/handoff-ext.log. */
  ext: UnifiedOutputChannel;
  /** Server child stdout/stderr — Output only, not ext disk (visor reads server log). */
  serverPipe: UnifiedOutputChannel;
}

function createBaseChannel(): UnifiedOutputChannel {
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

function withSanitize(ch: UnifiedOutputChannel): UnifiedOutputChannel {
  return {
    info: (m) => ch.info(sanitizeLogForUi(m)),
    warn: (m) => ch.warn(sanitizeLogForUi(m)),
    error: (m) => ch.error(sanitizeLogForUi(m)),
    appendLine: (m) => ch.appendLine(sanitizeLogForUi(m)),
    show: (preserveFocus) => ch.show(preserveFocus),
    dispose: () => ch.dispose(),
  };
}

function withExtDiskMirror(ch: UnifiedOutputChannel): UnifiedOutputChannel {
  return {
    info: (m) => {
      const s = sanitizeLogForUi(m);
      appendExtDiskLog(s);
      ch.info(s);
    },
    warn: (m) => {
      const s = sanitizeLogForUi(m);
      appendExtDiskLog(s);
      ch.warn(s);
    },
    error: (m) => {
      const s = sanitizeLogForUi(m);
      appendExtDiskLog(s);
      ch.error(s);
    },
    appendLine: (m) => {
      const s = sanitizeLogForUi(m);
      appendExtDiskLog(s);
      ch.appendLine(s);
    },
    show: (preserveFocus) => ch.show(preserveFocus),
    dispose: () => ch.dispose(),
  };
}

export function createOutputChannels(): OutputChannels {
  const base = createBaseChannel();
  const sanitized = withSanitize(base);
  let disposed = false;
  const disposeOnce = (): void => {
    if (disposed) return;
    disposed = true;
    base.dispose();
  };
  const ext = withExtDiskMirror(sanitized);
  const serverPipe = sanitized;
  return {
    ext: { ...ext, dispose: disposeOnce },
    serverPipe: { ...serverPipe, dispose: disposeOnce },
  };
}

/** @deprecated use createOutputChannels — kept for tests importing single channel shape */
export function createOutputChannel(): UnifiedOutputChannel {
  return createOutputChannels().ext;
}

function scrollEditorToEnd(editor: vscode.TextEditor, doc: vscode.TextDocument): void {
  if (doc.lineCount === 0) return;
  const line = doc.lineAt(doc.lineCount - 1);
  const pos = line.range.end;
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(line.range, vscode.TextEditorRevealType.AtBottom);
}

/** Open merged `<data-root>/handoff.log` — visor updates the file on disk; editor reloads externally. */
export async function revealHandoffLog(
  _channel: UnifiedOutputChannel,
  dataDir: string,
  dict: Record<string, string>,
): Promise<void> {
  const mergedPath = join(dataDir, 'handoff.log');
  if (!existsSync(mergedPath)) {
    void vscode.window.showInformationMessage(
      tr(
        dict,
        'ext.output.mergedMissing',
        'CursorHandoff: merged log not ready yet — start the server; visor writes handoff.log under the runtime data folder every few seconds.',
      ),
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mergedPath));
  const editor = await vscode.window.showTextDocument(doc, {
    preview: false,
    viewColumn: vscode.ViewColumn.Active,
  });
  scrollEditorToEnd(editor, doc);
}

export function appendLogLine(channel: UnifiedOutputChannel, raw: string): void {
  const { level, line } = formatServerChildLogLine(raw);
  switch (level) {
    case 'error': channel.error(line); break;
    case 'warn': channel.warn(line); break;
    default: channel.info(line); break;
  }
}
