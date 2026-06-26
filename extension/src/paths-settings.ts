import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
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

export type DataDirSource = 'custom' | 'project' | 'globalStorage';
export interface DataDirInfo {
  path: string;
  source: DataDirSource;
}

/** Canonical DATA_DIR: setting → `<repo>/data` → extension global storage. */
export function resolveDataDirInfo(context: vscode.ExtensionContext): DataDirInfo {
  const config = vscode.workspace.getConfiguration('cursorHandoff');
  const custom = config.get<string>('dataDir', '').trim();
  if (custom) return { path: resolve(custom), source: 'custom' };

  // Workspace git checkout before installed extension (same package name in both).
  const roots = [
    ...(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? []),
    context.extensionPath,
  ];
  const repoRoot = findHandoffRepoRoot(roots);
  if (repoRoot) return { path: join(repoRoot, 'data'), source: 'project' };

  return { path: context.globalStorageUri.fsPath, source: 'globalStorage' };
}

export function resolveDataDir(context: vscode.ExtensionContext): string {
  return resolveDataDirInfo(context).path;
}

/** Stable prefix for logs and UI when DATA_DIR cannot be written. */
export const DATA_DIR_NOT_WRITABLE = 'DATA_DIR is not writable';

export function verifyDataDirWritable(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw dataDirWriteError(dir, err);
  }
  const probe = join(dir, `.write-test-${process.pid}`);
  try {
    writeFileSync(probe, 'ok', 'utf8');
    unlinkSync(probe);
  } catch (err) {
    throw dataDirWriteError(dir, err);
  }
}

function dataDirWriteError(dir: string, err: unknown): Error {
  const e = err as NodeJS.ErrnoException;
  const code = e.code ?? 'unknown';
  const detail = e.message ?? String(err);
  return new Error(`${DATA_DIR_NOT_WRITABLE}: ${dir} (${code}: ${detail})`);
}
