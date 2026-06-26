import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

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

export function findHandoffRepoRoot(cwd?: string): string | undefined {
  let dir = resolve(cwd ?? process.cwd());
  for (let depth = 0; depth < 12; depth++) {
    if (readPackageName(dir) === 'cursor-handoff') return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function defaultDataDir(cwd?: string): string {
  const repo = findHandoffRepoRoot(cwd);
  if (repo) return join(repo, 'data');
  return resolve(cwd ?? process.cwd(), 'data');
}

export function resolveDataDirFromEnv(cwd?: string): string {
  const fromEnv = process.env.DATA_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  return defaultDataDir(cwd);
}

/** Canonical DATA_DIR for all runtime bot files. */
export function getDataDir(cwd?: string): string {
  const dir = resolveDataDirFromEnv(cwd);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Set DATA_DIR env when unset (extension child process). */
export function ensureDataDirEnv(cwd?: string): string {
  const dir = resolveDataDirFromEnv(cwd);
  if (!process.env.DATA_DIR?.trim()) {
    process.env.DATA_DIR = dir;
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Stable prefix for logs and extension UI when DATA_DIR cannot be written. */
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
  const wrapped = new Error(`${DATA_DIR_NOT_WRITABLE}: ${dir} (${code}: ${detail})`);
  if (code !== 'unknown') {
    (wrapped as NodeJS.ErrnoException).code = code;
  }
  return wrapped;
}
