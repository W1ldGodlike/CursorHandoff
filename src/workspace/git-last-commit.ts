import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type LastCommitResult =
  | { ok: true; hash: string; subject: string }
  | { ok: false; reason: 'no_git' | 'empty' | 'git_error'; detail?: string };

/** Latest commit in workspace git repo (short hash + subject). */
export async function readLastCommit(workspacePath: string): Promise<LastCommitResult> {
  if (!existsSync(join(workspacePath, '.git'))) {
    return { ok: false, reason: 'no_git' };
  }
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspacePath, 'log', '-1', '--format=%H %s'],
      { timeout: 5000, windowsHide: true },
    );
    const line = stdout.trim();
    if (!line) return { ok: false, reason: 'empty' };
    const space = line.indexOf(' ');
    if (space <= 0) return { ok: false, reason: 'empty' };
    return {
      ok: true,
      hash: line.slice(0, space).slice(0, 12),
      subject: line.slice(space + 1),
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'git_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
