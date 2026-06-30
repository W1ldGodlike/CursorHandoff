import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import type { WindowMonitor } from '../state/windows.js';
import { uriPathToNative } from '../state/workspace-uri.js';
import type { TopicManager } from '../telegram/topics/manager.js';

export interface WorkspaceSources {
  windowMonitor?: WindowMonitor;
  topicManager?: TopicManager;
}

/** Test override: path to Cursor `storage.json`. */
export function cursorStorageJsonPath(): string | null {
  const override = process.env.CURSOR_HANDOFF_CURSOR_STORAGE?.trim();
  if (override) return override;

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) return null;
    return join(appData, 'Cursor', 'User', 'globalStorage', 'storage.json');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'storage.json');
  }
  return join(homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'storage.json');
}

/** Decodes `file://` folder / workspace URIs from Cursor storage to native paths. */
export function folderUriToPath(uri: string): string | null {
  if (!uri || typeof uri !== 'string') return null;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return null;
    const native = uriPathToNative(decodeURIComponent(parsed.pathname));
    return native || null;
  } catch {
    return null;
  }
}

function collectUrisFromStorage(raw: unknown, out: Set<string>): void {
  if (!raw || typeof raw !== 'object') return;
  const obj = raw as Record<string, unknown>;

  const profileWorkspaces = (obj.profileAssociations as { workspaces?: Record<string, unknown> } | undefined)?.workspaces;
  if (profileWorkspaces && typeof profileWorkspaces === 'object') {
    for (const key of Object.keys(profileWorkspaces)) out.add(key);
  }

  const backup = obj.backupWorkspaces as {
    folders?: Array<{ folderUri?: string }>;
    workspaces?: Array<{ configPath?: string; workspace?: { configPath?: string } }>;
  } | undefined;
  if (backup?.folders) {
    for (const entry of backup.folders) {
      if (entry?.folderUri) out.add(entry.folderUri);
    }
  }
  if (backup?.workspaces) {
    for (const entry of backup.workspaces) {
      const configPath = entry?.configPath ?? entry?.workspace?.configPath;
      if (configPath) out.add(configPath);
    }
  }

  const pushFolder = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const folder = (value as { folder?: string }).folder;
    if (folder) out.add(folder);
  };

  const windowsState = obj.windowsState as {
    lastActiveWindow?: { folder?: string };
    openedWindows?: Array<{ folder?: string }>;
  } | undefined;
  pushFolder(windowsState?.lastActiveWindow);
  if (Array.isArray(windowsState?.openedWindows)) {
    for (const win of windowsState.openedWindows) pushFolder(win);
  }
}

/** Folder paths Cursor has opened before (from global `storage.json`). */
export function readCursorStorageWorkspacePaths(): string[] {
  const storagePath = cursorStorageJsonPath();
  if (!storagePath || !existsSync(storagePath)) return [];

  try {
    const raw = JSON.parse(readFileSync(storagePath, 'utf-8'));
    const uris = new Set<string>();
    collectUrisFromStorage(raw, uris);
    const paths: string[] = [];
    for (const uri of uris) {
      const native = folderUriToPath(uri);
      if (native && existsSync(native)) paths.push(resolve(native));
    }
    return paths;
  } catch {
    return [];
  }
}

function pathsFromOpenWindows(windowMonitor?: WindowMonitor): string[] {
  if (!windowMonitor) return [];
  const paths: string[] = [];
  for (const snap of windowMonitor.getAllSnapshots().values()) {
    if (snap.workspacePath && existsSync(snap.workspacePath)) {
      paths.push(resolve(snap.workspacePath));
    }
  }
  return paths;
}

function pathsFromTopicMappings(topicManager?: TopicManager): string[] {
  if (!topicManager) return [];
  const paths: string[] = [];
  for (const mapping of topicManager.getAllMappings()) {
    if (mapping.workspacePath && existsSync(mapping.workspacePath)) {
      paths.push(resolve(mapping.workspacePath));
    }
  }
  return paths;
}

/**
 * Known workspace folders: open Cursor windows, Cursor recent storage, bridged TG mappings.
 * Order: live windows → Cursor history → Handoff mappings (deduped).
 */
export function collectKnownWorkspacePaths(sources?: WorkspaceSources): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (value: string) => {
    const abs = resolve(value);
    const key = abs.toLowerCase();
    if (seen.has(key) || !existsSync(abs)) return;
    seen.add(key);
    out.push(abs);
  };

  for (const p of pathsFromOpenWindows(sources?.windowMonitor)) push(p);
  for (const p of readCursorStorageWorkspacePaths()) push(p);
  for (const p of pathsFromTopicMappings(sources?.topicManager)) push(p);

  return out;
}

export function projectScore(query: string, fullPath: string): number {
  const q = query.toLowerCase();
  const name = basename(fullPath).toLowerCase();
  const pathLower = fullPath.toLowerCase();
  if (name === q) return 400;
  if (name.startsWith(q)) return 300;
  const idx = name.indexOf(q);
  if (idx >= 0) return 200 - idx;
  if (pathLower.includes(q)) return 80;
  return 0;
}

/** Builds storage.json fixture for tests. */
export function workspacePathsToStorageJson(paths: string[]): string {
  const workspaces: Record<string, string> = {};
  for (const p of paths) {
    workspaces[pathToFileURL(resolve(p)).href] = '__default__profile__';
  }
  return JSON.stringify({ profileAssociations: { workspaces } }, null, 2);
}
