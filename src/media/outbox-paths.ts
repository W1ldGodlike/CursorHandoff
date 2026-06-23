import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureGitignore, ensureProjectDirs } from '../workspace/handoff-dirs.js';
import { getDataDir } from '../core/paths.js';
import type { TopicManager } from '../telegram/topics/manager.js';
import {
  flushOutboxForWorkspace,
  registerOutboxWatcher,
  type OutboxWatcherDeps,
} from './outbox-watch.js';

const MDC_REL = '.cursor/rules/cursor-handoff-tg-file-relay.mdc';
const OUTBOX_REL = '.cursor-handoff/outbox';
const BOOTSTRAP_FILE = 'file-relay-bootstrap.json';

const MDC_TEMPLATE = `---
description: CursorHandoff TG File Relay — deliver photos and files to Telegram via outbox
alwaysApply: true
---

# TG File Relay: outbox in this project

This project delivers files to Telegram through CursorHandoff.

When the user asks for a screenshot, photo, or file in Telegram / "here":

1. Put deliverables only in \`.cursor-handoff/outbox/\` (**copy**, do not move originals).
2. Use short meaningful filenames (Latin): \`settings-panel.png\`, not \`out1.png\`.
3. Layout refs and assets — not in outbox unless the user explicitly asked to send them to TG.
4. Write the explanation in the chat reply — Telegram text arrives after files. Mixed photos and documents are sent as separate albums; outbox files older than 1 h are purged.

Full workflow: skill \`cursor-handoff-telegram-send\`.
`;

interface FileRelayBootstrapFile {
  workspaces: Record<string, { bootstrappedAt: number; threadIdFirst: number }>;
}

function bootstrapPath(): string {
  return join(getDataDir(), BOOTSTRAP_FILE);
}

function isBootstrapEntry(val: unknown): val is { bootstrappedAt: number; threadIdFirst: number } {
  return !!val && typeof val === 'object' && 'bootstrappedAt' in val && 'threadIdFirst' in val;
}

function loadBootstrap(): FileRelayBootstrapFile {
  try {
    const readPath = bootstrapPath();
    if (existsSync(readPath)) {
      const raw = JSON.parse(readFileSync(readPath, 'utf8')) as Record<string, unknown>;
      if (raw.workspaces && typeof raw.workspaces === 'object') {
        return { workspaces: raw.workspaces as FileRelayBootstrapFile['workspaces'] };
      }
      const workspaces: FileRelayBootstrapFile['workspaces'] = {};
      for (const [key, val] of Object.entries(raw)) {
        if (!isBootstrapEntry(val)) continue;
        workspaces[normWs(key)] = val;
      }
      if (Object.keys(workspaces).length > 0) {
        return { workspaces };
      }
    }
  } catch {
    /* fresh */
  }
  return { workspaces: {} };
}

function saveBootstrap(data: FileRelayBootstrapFile): void {
  writeFileSync(bootstrapPath(), JSON.stringify(data, null, 2));
}

function normWs(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

function hasGitignoreCursorHandoff(workspacePath: string): boolean {
  const gitignorePath = join(workspacePath, '.gitignore');
  if (!existsSync(gitignorePath)) return false;
  const content = readFileSync(gitignorePath, 'utf8');
  return content.split(/\r?\n/).some(
    (line) => line.trim() === '.cursor-handoff/' || line.trim() === '**/.cursor-handoff/',
  );
}

/** Full bootstrap: data + outbox + .mdc + .gitignore (not per mapping flag). */
export function isWorkspaceFileRelayBootstrapped(workspacePath: string): boolean {
  const data = loadBootstrap();
  return normWs(workspacePath) in data.workspaces
    && existsSync(join(workspacePath, OUTBOX_REL))
    && existsSync(join(workspacePath, MDC_REL))
    && hasGitignoreCursorHandoff(workspacePath);
}

export function markMappingsBootstrapped(topicManager: TopicManager, workspacePath: string): void {
  const ws = normWs(workspacePath);
  for (const m of topicManager.getAllMappings()) {
    if (m.workspacePath && normWs(m.workspacePath) === ws) {
      m.fileRelayBootstrapped = true;
      m.fileRelayBootstrapAt = Date.now();
    }
  }
  topicManager.persistInPlace();
}

export function ensureFileRelayBootstrap(
  workspacePath: string,
  threadIdFirst: number,
  topicManager: TopicManager,
  watcherDeps: OutboxWatcherDeps,
): void {
  ensureProjectDirs(workspacePath, ['outbox']);
  ensureGitignore(workspacePath);

  const mdcPath = join(workspacePath, MDC_REL);
  if (!existsSync(mdcPath)) {
    const dir = join(workspacePath, '.cursor/rules');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(mdcPath, MDC_TEMPLATE, 'utf8');
  }

  const data = loadBootstrap();
  data.workspaces[normWs(workspacePath)] = {
    bootstrappedAt: Date.now(),
    threadIdFirst,
  };
  saveBootstrap(data);
  markMappingsBootstrapped(topicManager, workspacePath);
  registerOutboxWatcher(workspacePath, watcherDeps);
}

function resolveWorkspacePathForBootstrap(
  wsKey: string,
  topicManager: TopicManager,
): string | undefined {
  const mapping = topicManager.getAllMappings().find(
    (m) => m.workspacePath && normWs(m.workspacePath) === wsKey,
  );
  return mapping?.workspacePath;
}

export function restoreOutboxWatchers(
  topicManager: TopicManager,
  watcherDeps: OutboxWatcherDeps,
): void {
  const data = loadBootstrap();
  const seen = new Set<string>();
  const registerWs = (workspacePath: string | undefined) => {
    if (!workspacePath) return;
    const key = normWs(workspacePath);
    if (seen.has(key)) return;
    seen.add(key);
    registerOutboxWatcher(workspacePath, watcherDeps);
  };

  for (const wsKey of Object.keys(data.workspaces)) {
    registerWs(resolveWorkspacePathForBootstrap(wsKey, topicManager));
  }
  for (const m of topicManager.getAllMappings()) {
    if (m.fileRelayBootstrapped && m.workspacePath) {
      registerWs(m.workspacePath);
    }
  }
}

/** All bootstrapped workspaces: normal tick or force before redeploy/shutdown. */
export async function flushAllOutboxWatchers(
  topicManager: TopicManager,
  watcherDeps: OutboxWatcherDeps,
  force = false,
): Promise<void> {
  const data = loadBootstrap();
  const seen = new Set<string>();
  const jobs: Promise<void>[] = [];
  const flushWs = (workspacePath: string | undefined) => {
    if (!workspacePath) return;
    const key = normWs(workspacePath);
    if (seen.has(key)) return;
    seen.add(key);
    jobs.push(flushOutboxForWorkspace(workspacePath, watcherDeps, force));
  };

  for (const wsKey of Object.keys(data.workspaces)) {
    flushWs(resolveWorkspacePathForBootstrap(wsKey, topicManager));
  }
  for (const m of topicManager.getAllMappings()) {
    if (m.fileRelayBootstrapped && m.workspacePath) {
      flushWs(m.workspacePath);
    }
  }
  await Promise.all(jobs);
}
