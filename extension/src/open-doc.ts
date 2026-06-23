import { existsSync } from 'fs';
import { join } from 'path';
import * as vscode from 'vscode';
import { tr } from './extension-locale.js';
import { findHandoffRepoRoot } from './paths-settings.js';

/** Open a repo doc (`docs/guide.md`, optional `#anchor`) as Markdown preview. */
export async function openHandoffDoc(
  context: vscode.ExtensionContext,
  rel: string,
  dict: Record<string, string> = {},
): Promise<void> {
  const trimmed = rel.trim();
  if (!trimmed) return;

  const hashIdx = trimmed.indexOf('#');
  const pathPart = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const anchor = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : '';

  const roots = [
    ...(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? []),
    context.extensionPath,
  ];
  const repoRoot = findHandoffRepoRoot(roots);
  const candidates = [
    ...(repoRoot ? [join(repoRoot, pathPart)] : []),
    join(context.extensionPath, pathPart),
    ...roots.map((r) => join(r, pathPart)),
  ];
  const docPath = candidates.find((p) => existsSync(p));
  if (!docPath) {
    vscode.window.showWarningMessage(
      tr(dict, 'ext.handoffSettings.msg.docNotFound', 'Document not found: {path}').replace('{path}', trimmed),
    );
    return;
  }

  const fileUri = vscode.Uri.file(docPath);
  await vscode.commands.executeCommand(
    'markdown.showPreviewToSide',
    anchor ? fileUri.with({ fragment: anchor }) : fileUri,
  );
}
