import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'os';
import { afterEach, describe, it } from 'node:test';
import { TopicManager } from '../../src/telegram/topics/manager.js';
import { handleLastCommit } from '../../src/telegram/commands/chat-threads.js';
import type { CommandDeps } from '../../src/telegram/commands/shared.js';
import type { BotContext } from '../../src/telegram/types.js';

const CHAT_ID = -1001234567890;
const THREAD_ID = 11;

function makeCtx(threadId?: number): BotContext {
  return {
    chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
    message: {
      message_id: 1,
      date: 0,
      chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
      message_thread_id: threadId,
      text: '/last_commit',
    },
    reply: async (text: string) => {
      replies.push(text);
    },
  } as unknown as BotContext;
}

let replies: string[] = [];
let dir: string;

afterEach(() => {
  replies = [];
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function deps(workspacePath?: string): CommandDeps {
  const topicManager = new TopicManager();
  topicManager.registerMapping({
    threadId: THREAD_ID,
    windowId: 'win-1',
    windowTitle: 'Proj',
    tabTitle: 'Chat',
    lastActive: Date.now(),
    workspacePath,
  });
  return {
    topicManager,
    windowMonitor: { getSnapshot: () => undefined, getAllSnapshots: () => new Map() },
  } as unknown as CommandDeps;
}

describe('handleLastCommit', () => {
  it('rejects # General', async () => {
    await handleLastCommit(makeCtx(), deps());
    assert.match(replies[0] ?? '', /last_commit/);
  });

  it('replies with short hash and subject', async () => {
    dir = mkdtempSync(join(tmpdir(), 'handoff-last-commit-'));
    execFileSync('git', ['init'], { cwd: dir, windowsHide: true });
    writeFileSync(join(dir, 'f.txt'), '1', 'utf8');
    execFileSync('git', ['add', 'f.txt'], { cwd: dir, windowsHide: true });
    execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-m', 'ship it'], {
      cwd: dir,
      windowsHide: true,
    });
    await handleLastCommit(makeCtx(THREAD_ID), deps(dir));
    assert.match(replies[0] ?? '', /ship it/);
    assert.match(replies[0] ?? '', /<code>[0-9a-f]{12}<\/code>/);
  });
});
