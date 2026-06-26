import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TopicManager } from '../../src/telegram/topics/manager.js';
import { formatMappingForumLabel, formatMappingForumTopicDisplay } from '../../src/telegram/topics/guards.js';

describe('thread_rename', () => {
  let dataDir: string;
  let origDataDir: string | undefined;

  beforeEach(() => {
    origDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-thread-rename-'));
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = origDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('setTopicLabel stores display name without changing tabTitle', () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 990001,
      windowId: 'win-test',
      windowTitle: 'myproj',
      tabTitle: 'Fix auth',
      lastActive: Date.now(),
    });

    const updated = tm.setTopicLabel(990001, 'релиз 0.2');
    assert.ok(updated);
    assert.equal(updated!.tabTitle, 'Fix auth');
    assert.equal(updated!.topicLabel, 'релиз 0.2');
    assert.equal(
      formatMappingForumLabel(updated!),
      'myproj — релиз 0.2',
    );

    tm.removeMapping(990001);
  });

  it('setTopicMode adds display prefix only', () => {
    const tm = new TopicManager();
    tm.registerMapping({
      threadId: 990002,
      windowId: 'win-test',
      windowTitle: 'myproj',
      tabTitle: 'Fix auth',
      lastActive: Date.now(),
      topicLabel: 'релиз',
    });

    const updated = tm.setTopicMode(990002, 'debug');
    assert.equal(updated!.topicMode, 'debug');
    assert.equal(updated!.topicLabel, 'релиз');
    assert.equal(
      formatMappingForumTopicDisplay(updated!),
      '🐛 myproj — релиз',
    );

    tm.removeMapping(990002);
  });
});
