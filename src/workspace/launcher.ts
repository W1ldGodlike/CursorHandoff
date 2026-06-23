import { spawn } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { CDPBridge } from '../ide/cdp-session.js';
import type { CursorWindow } from '../core/types.js';
import { getDataDir } from '../core/paths.js';
import { normalizeWindowTitle, type TopicMapping } from '../telegram/topics/manager.js';

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
  try {
    const reqPath = join(dataDir, 'open-project.json');
    writeFileSync(reqPath, JSON.stringify({ path: workspacePath, ts: Date.now() }), 'utf-8');
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[project-launcher] Extension open request failed: ${msg}`);
    return false;
  }
}

export function launchCursorProject(workspacePath: string): void {
  const dataDir = process.env.DATA_DIR?.trim() || getDataDir();
  if (requestOpenViaExtension(dataDir, workspacePath)) {
    console.log(`[project-launcher] Extension open request: "${workspacePath}"`);
    return;
  }

  const exe = defaultCursorExecutable();
  // Fallback when server runs outside the extension (dev/CLI).
  const args = ['--new-window', workspacePath];
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (err) => {
    console.warn(`[project-launcher] Spawn failed: ${err.message}`);
  });
  child.unref();
  console.log(`[project-launcher] Spawned Cursor: ${args.map((a) => `"${a}"`).join(' ')} via ${exe}`);
}

export async function waitForProjectWindow(
  cdpBridge: CDPBridge,
  windowTitle: string,
  timeoutMs = 90_000,
  pollMs = 2000
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
  console.warn(
    `[project-launcher] Timed out waiting for window "${windowTitle}" (${timeoutMs}ms). CDP windows: ${titles}`
  );
  return null;
}
