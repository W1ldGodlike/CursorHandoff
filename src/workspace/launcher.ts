import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { CDPBridge } from '../ide/cdp-session.js';
import type { CursorWindow } from '../core/types.js';
import { getDataDir } from '../core/paths.js';
import { logInfo, logWarn, normalizeError, sanitizePathForUi } from '../core/log-event.js';
import type { LogContext } from '../core/log-event.js';
import { normalizeWindowTitle, type TopicMapping } from '../telegram/topics/manager.js';

function launchCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'bridge', op, ...extra };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function defaultCursorExecutable(): string {
  if (process.env.CURSOR_EXECUTABLE) return process.env.CURSOR_EXECUTABLE;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      const exe = join(local, 'Programs', 'cursor', 'Cursor.exe');
      if (existsSync(exe)) return exe;
    }
  }
  if (process.platform === 'darwin') {
    const exe = '/Applications/Cursor.app/Contents/MacOS/Cursor';
    if (existsSync(exe)) return exe;
  }
  return 'cursor';
}

export function autoOpenProjectsEnabled(): boolean {
  return process.env.AUTO_OPEN_PROJECTS !== 'false';
}

/** Resolves project folder path from mapping title. */
export function resolveProjectPath(mapping: TopicMapping): string | null {
  if (mapping.workspacePath && existsSync(mapping.workspacePath)) {
    return mapping.workspacePath;
  }

  const folderName = normalizeWindowTitle(mapping.windowTitle);

  const roots: string[] = [];
  if (process.env.PROJECTS_ROOT) roots.push(process.env.PROJECTS_ROOT);
  if (process.env.CURSOR_HANDOFF_PROJECTS_ROOT) roots.push(process.env.CURSOR_HANDOFF_PROJECTS_ROOT);

  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    for (const sub of ['Projects', 'projects', 'dev', 'code', 'src']) {
      roots.push(join(home, sub));
    }
  }

  for (const root of roots) {
    const candidate = join(root, folderName);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/** Asks the CursorHandoff extension to open a folder (more reliable than spawn from server child). */
export function requestOpenViaExtension(dataDir: string, workspacePath: string): boolean {
  const safePath = sanitizePathForUi(workspacePath);
  try {
    mkdirSync(dataDir, { recursive: true });
    const reqPath = join(dataDir, 'open-project.json');
    writeFileSync(reqPath, JSON.stringify({ path: workspacePath, ts: Date.now() }), 'utf-8');
    return true;
  } catch (err) {
    const { message, errno } = normalizeError(err);
    logWarn(
      'LAUNCH_EXT_FAIL',
      `Extension open request failed for ${safePath}: ${message}`,
      launchCtx('open_project', { hint: safePath, errno }),
    );
    return false;
  }
}

export function launchCursorProject(workspacePath: string): void {
  const safePath = sanitizePathForUi(workspacePath);
  const dataDir = process.env.DATA_DIR?.trim() || getDataDir();
  if (requestOpenViaExtension(dataDir, workspacePath)) {
    logInfo(
      'LAUNCH_EXT_OK',
      `Extension open request: ${safePath}`,
      launchCtx('open_project', { hint: safePath }),
    );
    return;
  }

  const exe = defaultCursorExecutable();
  const args = ['--new-window', workspacePath];
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('spawn', () => {
    logInfo(
      'LAUNCH_SPAWN_OK',
      `Spawned Cursor: ${args.map((a) => `"${sanitizePathForUi(a)}"`).join(' ')} via ${sanitizePathForUi(exe)}`,
      launchCtx('open_project', { hint: safePath }),
    );
  });
  child.on('error', (err) => {
    const { message, errno } = normalizeError(err);
    logWarn(
      'LAUNCH_SPAWN_FAIL',
      `Spawn failed for ${safePath}: ${message}`,
      launchCtx('open_project', { hint: safePath, errno }),
    );
  });
  child.unref();
}

export async function waitForProjectWindow(
  cdpBridge: CDPBridge,
  windowTitle: string,
  timeoutMs = 90_000,
  pollMs = 2000,
): Promise<CursorWindow | null> {
  const want = normalizeWindowTitle(windowTitle).toLowerCase();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await cdpBridge.refreshWindows();
    const win = cdpBridge.windows.find((w) => {
      const t = w.title.toLowerCase();
      const n = normalizeWindowTitle(w.title).toLowerCase();
      return (
        t === windowTitle.toLowerCase() ||
        n === want ||
        t.startsWith(`${want} `) ||
        t.startsWith(`${want}-`) ||
        n.includes(want) ||
        want.includes(n)
      );
    });
    if (win) return win;
    await sleep(pollMs);
  }

  const titles = cdpBridge.windows.map((w) => w.title).join(', ') || '(none)';
  logWarn(
    'LAUNCH_TIMEOUT',
    `Timed out waiting for window "${windowTitle}" (${timeoutMs}ms). CDP windows: ${titles}`,
    launchCtx('open_project', { windowTitle, durationMs: timeoutMs }),
  );
  return null;
}
