import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import * as vscode from 'vscode';

function readPackageName(dir: string): string | undefined {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
    return pkg.name;
  } catch {
    return undefined;
  }
}

/** cursor-handoff repo root (dev workspace or installed extension). */
export function findHandoffRepoRoot(startPaths: string[]): string | undefined {
  const seen = new Set<string>();
  for (const start of startPaths) {
    let dir = resolve(start);
    for (let depth = 0; depth < 12; depth++) {
      if (seen.has(dir)) break;
      seen.add(dir);
      if (readPackageName(dir) === 'cursor-handoff') return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

/** Canonical DATA_DIR: setting → `<repo>/data` → extension bundle `data/`. */
export function resolveDataDir(context: vscode.ExtensionContext): string {
  const config = vscode.workspace.getConfiguration('cursorHandoff');
  const custom = config.get<string>('dataDir', '').trim();
  if (custom) return resolve(custom);

  // Workspace git checkout before installed extension (same package name in both).
  const roots = [
    ...(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? []),
    context.extensionPath,
  ];
  const repoRoot = findHandoffRepoRoot(roots);
  if (repoRoot) return join(repoRoot, 'data');

  return join(context.extensionPath, 'data');
}
