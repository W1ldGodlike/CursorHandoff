import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TopicManager } from '../../src/telegram/topics/manager.js';
import {
  ensureFileRelayBootstrap,
  isWorkspaceFileRelayBootstrapped,
  restoreOutboxWatchers,
} from '../../src/media/outbox-paths.js';
import { stopAllOutboxWatchers } from '../../src/media/outbox-watch.js';

describe('outbox-bootstrap', () => {
  let dataDir: string;
  let ws: string;

  beforeEach(() => {
    dataDir = join(tmpdir(), `handoff-outbox-bootstrap-${Date.now()}`);
    ws = join(dataDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    stopAllOutboxWatchers();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('ensureFileRelayBootstrap is idempotent and does not overwrite mdc', () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 5,
      windowId: 'w1',
      windowTitle: 'P',
      tabTitle: 'T',
      lastActive: Date.now(),
      workspacePath: ws,
    });
    const rulesDir = join(ws, '.cursor/rules');
    mkdirSync(rulesDir, { recursive: true });
    const mdc = join(rulesDir, 'cursor-handoff-tg-file-relay.mdc');
    writeFileSync(mdc, 'CUSTOM', 'utf8');

    const deps = {
      topicManager: tm,
      windowMonitor: { getSnapshot: () => undefined } as never,
      stateManager: { getCurrentState: () => ({ agentStatus: 'idle' }) } as never,
      api: {} as never,
      chatId: -100,
    };

    ensureFileRelayBootstrap(ws, 5, tm, deps);
    ensureFileRelayBootstrap(ws, 5, tm, deps);

    assert.equal(readFileSync(mdc, 'utf8'), 'CUSTOM');
    assert.ok(existsSync(join(ws, '.cursor-handoff/outbox')));
    assert.ok(isWorkspaceFileRelayBootstrapped(ws));
    const mapping = tm.resolveThread(5);
    assert.equal(mapping?.fileRelayBootstrapped, true);
    assert.ok(existsSync(join(dataDir, 'file-relay-bootstrap.json')));
  });

  it('isWorkspaceFileRelayBootstrapped requires outbox, mdc, gitignore and data record', () => {
    writeFileSync(join(dataDir, 'file-relay-bootstrap.json'), JSON.stringify({
      workspaces: { [ws.replace(/\\/g, '/').toLowerCase()]: { bootstrappedAt: 1, threadIdFirst: 1 } },
    }));
    assert.equal(isWorkspaceFileRelayBootstrapped(ws), false);
    mkdirSync(join(ws, '.cursor-handoff/outbox'), { recursive: true });
    assert.equal(isWorkspaceFileRelayBootstrapped(ws), false);
    mkdirSync(join(ws, '.cursor/rules'), { recursive: true });
    writeFileSync(join(ws, '.cursor/rules/cursor-handoff-tg-file-relay.mdc'), 'x');
    assert.equal(isWorkspaceFileRelayBootstrapped(ws), false);
    writeFileSync(join(ws, '.gitignore'), '.cursor-handoff/\n');
    assert.ok(isWorkspaceFileRelayBootstrapped(ws));
  });

  it('restoreOutboxWatchers registers from bootstrap + mapping', () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 9,
      windowId: 'w1',
      windowTitle: 'P',
      tabTitle: 'T',
      lastActive: Date.now(),
      workspacePath: ws,
      fileRelayBootstrapped: true,
    });
    writeFileSync(
      join(dataDir, 'file-relay-bootstrap.json'),
      JSON.stringify({
        workspaces: {
          [ws.replace(/\\/g, '/').toLowerCase()]: { bootstrappedAt: 1, threadIdFirst: 9 },
        },
      }),
    );
    const deps = {
      topicManager: tm,
      windowMonitor: { getSnapshot: () => undefined } as never,
      stateManager: { getCurrentState: () => ({ agentStatus: 'idle' }) } as never,
      api: {} as never,
      chatId: -100,
    };
    restoreOutboxWatchers(tm, deps);
    mkdirSync(join(ws, '.cursor-handoff/outbox'), { recursive: true });
    assert.ok(existsSync(join(ws, '.cursor-handoff/outbox')));
  });
});
