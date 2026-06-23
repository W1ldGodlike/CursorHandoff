import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';

export type ProjectDirNeed = 'outbox' | 'photoInbound' | 'fileInbound';

const SUBDIRS: Record<ProjectDirNeed, string> = {
  outbox: '.cursor-handoff/outbox',
  photoInbound: '.cursor-handoff/file-relay/photo/inbound',
  fileInbound: '.cursor-handoff/file-relay/inbound',
};

const GITIGNORE_LINE = '.cursor-handoff/';

export function ensureGitignore(workspacePath: string): void {
  const gitignorePath = join(workspacePath, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf8');
    const lines = content.split(/\r?\n/);
    if (lines.some((line) => line.trim() === GITIGNORE_LINE || line.trim() === '**/.cursor-handoff/')) {
      return;
    }
    const suffix = content.endsWith('\n') ? '' : '\n';
    appendFileSync(gitignorePath, `${suffix}${GITIGNORE_LINE}\n`, 'utf8');
    return;
  }
  appendFileSync(gitignorePath, `${GITIGNORE_LINE}\n`, 'utf8');
}

/** One-time rename of legacy `.cursor-handoff/media/` → `file-relay/`. */
export function migrateLegacyWorkspaceFileRelayDir(workspacePath: string): void {
  const legacy = join(workspacePath, '.cursor-handoff/media');
  const target = join(workspacePath, '.cursor-handoff/file-relay');
  if (!existsSync(legacy) || existsSync(target)) return;
  try {
    renameSync(legacy, target);
  } catch {
    /* ignore — file-relay created below */
  }
}

/** Creates only missing subdirs; does not touch existing content. */
export function ensureProjectDirs(workspacePath: string | undefined, needs: ProjectDirNeed[]): string[] {
  if (!workspacePath?.trim()) return [];
  migrateLegacyWorkspaceFileRelayDir(workspacePath);
  const created: string[] = [];
  for (const need of needs) {
    const dir = join(workspacePath, SUBDIRS[need]);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }
  if (needs.length > 0) ensureGitignore(workspacePath);
  return created;
}
