import { existsSync, readdirSync } from 'fs';
import { join, relative, sep } from 'path';

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.cache',
  'coverage',
  '.cursor-handoff',
  '.turbo',
  '.next',
  'out',
  '__pycache__',
  'vendor',
]);

const CACHE_TTL_MS = 3 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type FileIndexCache = {
  root: string;
  paths: string[];
  builtAt: number;
};

let cache: FileIndexCache | undefined;

export function invalidateFileIndex(): void {
  cache = undefined;
}

function toPosixPath(p: string): string {
  return p.split(sep).join('/');
}

function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIR_NAMES.has(name);
}

function walkFiles(root: string, dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (shouldSkipDir(ent.name)) continue;
      walkFiles(root, full, out);
      continue;
    }
    if (!ent.isFile()) continue;
    if (ent.name.startsWith('.')) continue;
    out.push(toPosixPath(relative(root, full)));
  }
}

export function buildFileIndex(workspaceRoot: string): string[] {
  const now = Date.now();
  if (cache && cache.root === workspaceRoot && now - cache.builtAt < CACHE_TTL_MS) {
    return cache.paths;
  }
  if (!existsSync(workspaceRoot)) {
    cache = { root: workspaceRoot, paths: [], builtAt: now };
    return [];
  }
  const paths: string[] = [];
  walkFiles(workspaceRoot, workspaceRoot, paths);
  paths.sort((a, b) => a.localeCompare(b));
  cache = { root: workspaceRoot, paths, builtAt: now };
  return paths;
}

function rankMatch(path: string, query: string): number | null {
  const lower = path.toLowerCase();
  const idx = lower.indexOf(query);
  if (idx < 0) return null;
  let score = idx;
  if (lower.startsWith(query)) score -= 200;
  else if (lower.includes(`/${query}`)) score -= 100;
  if (lower.startsWith(`${query}.`) || lower === query) score -= 50;
  score += lower.length * 0.001;
  return score;
}

export function searchWorkspaceFiles(
  workspaceRoot: string,
  query: string,
  limit = DEFAULT_LIMIT,
): string[] {
  const cap = Math.min(MAX_LIMIT, Math.max(1, limit));
  const paths = buildFileIndex(workspaceRoot);
  const q = query.trim().toLowerCase().replace(/\\/g, '/');
  if (!q) return paths.slice(0, cap);

  const hits: { path: string; score: number }[] = [];
  for (const p of paths) {
    const score = rankMatch(p, q);
    if (score === null) continue;
    hits.push({ path: p, score });
  }
  hits.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
  return hits.slice(0, cap).map((h) => h.path);
}
