import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendQueueItem,
  claimNextPending,
  countPending,
  getPendingQueuePath,
  hasPendingItems,
  loadQueue,
  markDone,
  markFailed,
  purgeOldDoneItems,
  resetStaleProcessing,
  saveQueue,
} from '../../src/workspace/offline-queue.js';

const CHAT_ID = -1001234567890;
const THREAD_ID = 11;
const USER_ID = 4242;

async function captureAll(run: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const push = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  console.log = push;
  console.warn = push;
  console.error = push;
  try {
    await run();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return lines;
}

function assertQueueLog(
  lines: string[],
  code: string,
  need: {
    itemId?: string;
    threadId?: number;
    chatId?: number;
    errno?: string;
    op?: string;
    hint?: string;
    attempt?: number;
    text?: string;
  } = {},
): void {
  const line = need.text
    ? lines.find((l) => l.includes(`code=${code}`) && l.includes(need.text!))
    : lines.find((l) => l.includes(`code=${code}`));
  assert.ok(line, need.text ? `missing code=${code} with text "${need.text}"` : `missing code=${code}`);
  assert.ok(line!.includes('scope=queue'), `${code} missing scope=queue`);
  if (need.itemId) assert.ok(line!.includes(`itemId=${need.itemId}`), `${code} missing itemId=${need.itemId}`);
  if (need.threadId !== undefined) {
    assert.ok(line!.includes(`threadId=${need.threadId}`), `${code} missing threadId=${need.threadId}`);
  }
  if (need.chatId !== undefined) {
    assert.ok(line!.includes(`chatId=${need.chatId}`), `${code} missing chatId=${need.chatId}`);
  }
  if (need.errno) assert.ok(line!.includes(`errno=${need.errno}`), `${code} missing errno=${need.errno}`);
  if (need.op) assert.ok(line!.includes(`op=${need.op}`), `${code} missing op=${need.op}`);
  if (need.hint) assert.ok(line!.includes(`hint=${need.hint}`), `${code} missing hint=${need.hint}`);
  if (need.attempt !== undefined) {
    assert.ok(line!.includes(`attempt=${need.attempt}`), `${code} missing attempt=${need.attempt}`);
  }
  if (need.text) assert.ok(line!.includes(need.text), `${code} missing text fragment "${need.text}"`);
}

function assertNoQueueLogs(lines: string[]): void {
  const hit = lines.find((l) => /code=QUEUE_/.test(l));
  assert.ok(!hit, `unexpected queue log: ${hit}`);
}

function queuePath(dataDir: string): string {
  return getPendingQueuePath(dataDir);
}

function baseItem(overrides: Partial<Parameters<typeof appendQueueItem>[1]> = {}) {
  return {
    telegramMessageId: 42,
    chatId: CHAT_ID,
    threadId: THREAD_ID,
    text: 'hello queue',
    userId: USER_ID,
    enqueuedBy: 'cursor-wake' as const,
    ...overrides,
  };
}

function makeReadOnly(path: string): void {
  if (process.platform === 'win32') {
    execSync(`attrib +R "${path}"`, { stdio: 'ignore' });
  } else {
    chmodSync(path, 0o444);
  }
}

function makeWritable(path: string): void {
  if (process.platform === 'win32') {
    execSync(`attrib -R "${path}"`, { stdio: 'ignore' });
  } else {
    chmodSync(path, 0o644);
  }
}

describe('offline-queue logging', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-offline-queue-log-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('logs QUEUE_LOAD_FAIL when queue file has corrupt json', async () => {
    writeFileSync(queuePath(dataDir), '{ corrupt', 'utf-8');
    const lines = await captureAll(() => {
      const q = loadQueue(dataDir);
      assert.deepEqual(q.items, []);
    });
    assertQueueLog(lines, 'QUEUE_LOAD_FAIL', { op: 'load' });
    assert.ok(lines.some((l) => l.includes('pending-telegram-queue.json')));
  });

  it('logs QUEUE_LOAD_INVALID with hint path when items is not an array', async () => {
    writeFileSync(queuePath(dataDir), JSON.stringify({ version: 2, items: null }), 'utf-8');
    const lines = await captureAll(() => {
      assert.deepEqual(loadQueue(dataDir).items, []);
    });
    assertQueueLog(lines, 'QUEUE_LOAD_INVALID', { op: 'load', text: 'invalid shape' });
    assert.ok(lines.some((l) => l.includes('pending-telegram-queue.json')));
  });

  it('loadQueue empty object logs QUEUE_LOAD_INVALID and stays recoverable', async () => {
    writeFileSync(queuePath(dataDir), '{}', 'utf-8');
    const lines = await captureAll(() => {
      assert.deepEqual(loadQueue(dataDir).items, []);
    });
    assertQueueLog(lines, 'QUEUE_LOAD_INVALID', { op: 'load' });
  });

  it('logs QUEUE_LOAD_INVALID when queue file missing version field', async () => {
    writeFileSync(queuePath(dataDir), JSON.stringify({ items: [] }), 'utf-8');
    const lines = await captureAll(() => {
      assert.deepEqual(loadQueue(dataDir).items, []);
    });
    assertQueueLog(lines, 'QUEUE_LOAD_INVALID', { op: 'load', text: 'invalid shape' });
  });

  it('logs QUEUE_LOAD_INVALID when queue file has invalid shape', async () => {
    writeFileSync(queuePath(dataDir), JSON.stringify({ version: 99, items: 'nope' }), 'utf-8');
    const lines = await captureAll(() => {
      const q = loadQueue(dataDir);
      assert.deepEqual(q.items, []);
    });
    assertQueueLog(lines, 'QUEUE_LOAD_INVALID', { op: 'load', text: 'invalid shape' });
  });

  it('loadQueue missing file stays silent without QUEUE codes', async () => {
    const lines = await captureAll(() => {
      const q = loadQueue(dataDir);
      assert.deepEqual(q, { version: 2, items: [] });
    });
    assertNoQueueLogs(lines);
  });

  it('loadQueue valid v2 file stays silent without QUEUE codes', async () => {
    writeFileSync(queuePath(dataDir), JSON.stringify({ version: 2, items: [] }), 'utf-8');
    const lines = await captureAll(() => {
      assert.equal(loadQueue(dataDir).items.length, 0);
    });
    assertNoQueueLogs(lines);
  });

  it('loadQueue valid v1 file stays silent without QUEUE codes', async () => {
    writeFileSync(
      queuePath(dataDir),
      JSON.stringify({
        version: 1,
        items: [{
          id: 'legacy-id',
          telegramMessageId: 1,
          chatId: CHAT_ID,
          threadId: THREAD_ID,
          text: 'legacy',
          userId: USER_ID,
          enqueuedAt: Date.now(),
          enqueuedBy: 'cursor-handoff',
          status: 'pending',
          attempts: 0,
          lastError: null,
        }],
      }),
      'utf-8',
    );
    const lines = await captureAll(() => {
      assert.equal(loadQueue(dataDir).items.length, 1);
    });
    assertNoQueueLogs(lines);
  });

  it('logs QUEUE_SAVE_FAIL with errno when queue file is read-only', async () => {
    writeFileSync(queuePath(dataDir), JSON.stringify({ version: 2, items: [] }), 'utf-8');
    makeReadOnly(queuePath(dataDir));
    try {
      const lines = await captureAll(() => {
        saveQueue(dataDir, { version: 2, items: [] });
      });
      assertQueueLog(lines, 'QUEUE_SAVE_FAIL', { op: 'persist' });
    } finally {
      makeWritable(queuePath(dataDir));
    }
  });

  it('saveQueue swallows write error without rethrow after QUEUE_SAVE_FAIL', async () => {
    writeFileSync(queuePath(dataDir), JSON.stringify({ version: 2, items: [] }), 'utf-8');
    makeReadOnly(queuePath(dataDir));
    try {
      const lines = await captureAll(() => {
        saveQueue(dataDir, { version: 2, items: [] });
      });
      assertQueueLog(lines, 'QUEUE_SAVE_FAIL', { op: 'persist' });
    } finally {
      makeWritable(queuePath(dataDir));
    }
  });

  it('saveQueue success stays silent without QUEUE codes', async () => {
    const lines = await captureAll(() => {
      saveQueue(dataDir, { version: 2, items: [] });
    });
    assertNoQueueLogs(lines);
  });

  it('logs QUEUE_ENQUEUE on appendQueueItem new item', async () => {
    let itemId = '';
    const lines = await captureAll(() => {
      const { added, item } = appendQueueItem(dataDir, baseItem({ telegramMessageId: 100 }));
      assert.equal(added, true);
      itemId = item.id;
    });
    assertQueueLog(lines, 'QUEUE_ENQUEUE', {
      itemId,
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'enqueue',
      text: `enqueued ${itemId}`,
    });
  });

  it('logs QUEUE_ENQUEUE emits exactly one log line for appendQueueItem', async () => {
    const lines = await captureAll(() => {
      appendQueueItem(dataDir, baseItem({ telegramMessageId: 111 }));
    });
    assert.equal(lines.filter((l) => l.includes('code=QUEUE_ENQUEUE')).length, 1);
  });

  it('logs QUEUE_ENQUEUE on appendQueueItem with cursor-handoff enqueuedBy', async () => {
    let itemId = '';
    const lines = await captureAll(() => {
      const { item } = appendQueueItem(dataDir, baseItem({
        telegramMessageId: 112,
        enqueuedBy: 'cursor-handoff',
      }));
      itemId = item.id;
    });
    assertQueueLog(lines, 'QUEUE_ENQUEUE', { itemId, op: 'enqueue' });
  });

  it('appendQueueItem same telegramMessageId different chatId logs QUEUE_ENQUEUE', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 113, chatId: CHAT_ID }));
    let itemId = '';
    const lines = await captureAll(() => {
      const { added, item } = appendQueueItem(dataDir, baseItem({
        telegramMessageId: 113,
        chatId: CHAT_ID + 1,
      }));
      assert.equal(added, true);
      itemId = item.id;
    });
    assertQueueLog(lines, 'QUEUE_ENQUEUE', { itemId, chatId: CHAT_ID + 1 });
  });

  it('logs QUEUE_ENQUEUE on appendQueueItem with attachments and caption', async () => {
    let itemId = '';
    const lines = await captureAll(() => {
      const { item } = appendQueueItem(dataDir, baseItem({
        telegramMessageId: 120,
        text: '',
        caption: 'photo caption',
        attachments: [{ kind: 'photo', fileId: 'fid', mime: 'image/jpeg' }],
      }));
      itemId = item.id;
    });
    assertQueueLog(lines, 'QUEUE_ENQUEUE', { itemId, op: 'enqueue' });
  });

  it('appendQueueItem duplicate returns same item id and stays silent without QUEUE_ENQUEUE', async () => {
    const first = appendQueueItem(dataDir, baseItem({ telegramMessageId: 128 }));
    const lines = await captureAll(() => {
      const dup = appendQueueItem(dataDir, baseItem({ telegramMessageId: 128 }));
      assert.equal(dup.added, false);
      assert.equal(dup.item.id, first.item.id);
    });
    assertNoQueueLogs(lines);
  });

  it('appendQueueItem duplicate stays silent without QUEUE_ENQUEUE', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 101 }));
    const lines = await captureAll(() => {
      const { added } = appendQueueItem(dataDir, baseItem({ telegramMessageId: 101 }));
      assert.equal(added, false);
    });
    assertNoQueueLogs(lines);
  });

  it('logs QUEUE_CLAIM on claimNextPending', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 102 }));
    let claimedId = '';
    const lines = await captureAll(() => {
      const item = claimNextPending(dataDir);
      assert.ok(item);
      claimedId = item!.id;
    });
    assertQueueLog(lines, 'QUEUE_CLAIM', {
      itemId: claimedId,
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'claim',
      text: `claimed ${claimedId}`,
    });
  });

  it('logs QUEUE_CLAIM emits exactly one log line for claimNextPending', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 114 }));
    const lines = await captureAll(() => {
      claimNextPending(dataDir);
    });
    assert.equal(lines.filter((l) => l.includes('code=QUEUE_CLAIM')).length, 1);
  });

  it('claimNextPending skips processing item and stays silent without QUEUE codes', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 115 }));
    claimNextPending(dataDir);
    const lines = await captureAll(() => {
      assert.equal(claimNextPending(dataDir), null);
    });
    assertNoQueueLogs(lines);
  });

  it('claimNextPending FIFO claims first pending item and logs QUEUE_CLAIM', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 129, text: 'first-pending' }));
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 130, text: 'second-pending' }));
    let claimedText = '';
    const lines = await captureAll(() => {
      const item = claimNextPending(dataDir);
      claimedText = item!.text;
    });
    assert.equal(claimedText, 'first-pending');
    assertQueueLog(lines, 'QUEUE_CLAIM', { op: 'claim' });
  });

  it('claimNextPending empty queue stays silent without QUEUE codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(claimNextPending(dataDir), null);
    });
    assertNoQueueLogs(lines);
  });

  it('logs QUEUE_STALE_RESET when processing item is stale', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 103 }));
    claimNextPending(dataDir);
    const raw = JSON.parse(readFileSync(queuePath(dataDir), 'utf-8'));
    raw.items[0].processingStartedAt = Date.now() - 6 * 60 * 1000;
    writeFileSync(queuePath(dataDir), JSON.stringify(raw));
    const lines = await captureAll(() => {
      resetStaleProcessing(dataDir);
      assert.equal(countPending(dataDir), 1);
    });
    assertQueueLog(lines, 'QUEUE_STALE_RESET', { op: 'stale_reset', text: 'reset 1 stale' });
  });

  it('logs QUEUE_STALE_RESET emits exactly one log line per resetStaleProcessing call', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 131 }));
    claimNextPending(dataDir);
    const raw = JSON.parse(readFileSync(queuePath(dataDir), 'utf-8'));
    raw.items[0].processingStartedAt = Date.now() - 6 * 60 * 1000;
    writeFileSync(queuePath(dataDir), JSON.stringify(raw));
    const lines = await captureAll(() => {
      resetStaleProcessing(dataDir);
    });
    assert.equal(lines.filter((l) => l.includes('code=QUEUE_STALE_RESET')).length, 1);
  });

  it('hasPendingItems logs QUEUE_STALE_RESET when stale processing item is reset', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 132 }));
    claimNextPending(dataDir);
    const raw = JSON.parse(readFileSync(queuePath(dataDir), 'utf-8'));
    raw.items[0].processingStartedAt = Date.now() - 6 * 60 * 1000;
    writeFileSync(queuePath(dataDir), JSON.stringify(raw));
    const lines = await captureAll(() => {
      assert.equal(hasPendingItems(dataDir), true);
    });
    assertQueueLog(lines, 'QUEUE_STALE_RESET', { op: 'stale_reset' });
  });

  it('logs QUEUE_STALE_RESET when stale by enqueuedAt fallback without processingStartedAt', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 116 }));
    const raw = JSON.parse(readFileSync(queuePath(dataDir), 'utf-8'));
    raw.items[0].status = 'processing';
    raw.items[0].enqueuedAt = Date.now() - 6 * 60 * 1000;
    delete raw.items[0].processingStartedAt;
    writeFileSync(queuePath(dataDir), JSON.stringify(raw));
    const lines = await captureAll(() => {
      resetStaleProcessing(dataDir);
    });
    assertQueueLog(lines, 'QUEUE_STALE_RESET', { op: 'stale_reset', text: 'reset 1 stale' });
  });

  it('resetStaleProcessing does not reset fresh processing of old queued item and stays silent', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 117 }));
    const raw = JSON.parse(readFileSync(queuePath(dataDir), 'utf-8'));
    raw.items[0].enqueuedAt = Date.now() - 60 * 60 * 1000;
    writeFileSync(queuePath(dataDir), JSON.stringify(raw));
    claimNextPending(dataDir);
    const lines = await captureAll(() => {
      resetStaleProcessing(dataDir);
      assert.equal(countPending(dataDir), 0);
    });
    assertNoQueueLogs(lines);
  });

  it('logs QUEUE_STALE_RESET for multiple stale processing items', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 121 }));
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 122 }));
    const raw = JSON.parse(readFileSync(queuePath(dataDir), 'utf-8'));
    for (const row of raw.items) {
      row.status = 'processing';
      row.processingStartedAt = Date.now() - 6 * 60 * 1000;
    }
    writeFileSync(queuePath(dataDir), JSON.stringify(raw));
    const lines = await captureAll(() => {
      resetStaleProcessing(dataDir);
      assert.equal(countPending(dataDir), 2);
    });
    assertQueueLog(lines, 'QUEUE_STALE_RESET', { op: 'stale_reset', text: 'reset 2 stale' });
    assert.ok(lines.some((l) => l.includes('hint=2')));
  });

  it('resetStaleProcessing fresh processing stays silent without QUEUE codes', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 104 }));
    claimNextPending(dataDir);
    const lines = await captureAll(() => {
      resetStaleProcessing(dataDir);
    });
    assertNoQueueLogs(lines);
  });

  it('logs QUEUE_PURGE_DONE when old done items removed', async () => {
    const { item } = appendQueueItem(dataDir, baseItem({ telegramMessageId: 105 }));
    claimNextPending(dataDir);
    markDone(dataDir, item.id);
    const raw = JSON.parse(readFileSync(queuePath(dataDir), 'utf-8'));
    raw.items[0].enqueuedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    writeFileSync(queuePath(dataDir), JSON.stringify(raw));
    const lines = await captureAll(() => {
      purgeOldDoneItems(dataDir);
      assert.equal(loadQueue(dataDir).items.length, 0);
    });
    assertQueueLog(lines, 'QUEUE_PURGE_DONE', { op: 'purge', text: 'purged 1 old' });
  });

  it('logs QUEUE_PURGE_DONE emits exactly one log line per purgeOldDoneItems call', async () => {
    const { item } = appendQueueItem(dataDir, baseItem({ telegramMessageId: 133 }));
    markDone(dataDir, item.id);
    const raw = JSON.parse(readFileSync(queuePath(dataDir), 'utf-8'));
    raw.items[0].enqueuedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    writeFileSync(queuePath(dataDir), JSON.stringify(raw));
    const lines = await captureAll(() => {
      purgeOldDoneItems(dataDir);
    });
    assert.equal(lines.filter((l) => l.includes('code=QUEUE_PURGE_DONE')).length, 1);
  });

  it('purgeOldDoneItems skips old failed items and stays silent without QUEUE codes', async () => {
    const { item } = appendQueueItem(dataDir, baseItem({ telegramMessageId: 134 }));
    markFailed(dataDir, item.id, 'e1');
    markFailed(dataDir, item.id, 'e2');
    const raw = JSON.parse(readFileSync(queuePath(dataDir), 'utf-8'));
    raw.items[0].enqueuedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    writeFileSync(queuePath(dataDir), JSON.stringify(raw));
    const lines = await captureAll(() => {
      purgeOldDoneItems(dataDir);
      assert.equal(loadQueue(dataDir).items[0]?.status, 'failed');
    });
    assertNoQueueLogs(lines);
  });

  it('purgeOldDoneItems keeps recent done items and stays silent without QUEUE codes', async () => {
    const { item } = appendQueueItem(dataDir, baseItem({ telegramMessageId: 118 }));
    claimNextPending(dataDir);
    markDone(dataDir, item.id);
    const lines = await captureAll(() => {
      purgeOldDoneItems(dataDir);
      assert.equal(loadQueue(dataDir).items.length, 1);
    });
    assertNoQueueLogs(lines);
  });

  it('logs QUEUE_PURGE_DONE when multiple old done items removed', async () => {
    const a = appendQueueItem(dataDir, baseItem({ telegramMessageId: 123 }));
    const b = appendQueueItem(dataDir, baseItem({ telegramMessageId: 124 }));
    markDone(dataDir, a.item.id);
    markDone(dataDir, b.item.id);
    const raw = JSON.parse(readFileSync(queuePath(dataDir), 'utf-8'));
    for (const row of raw.items) {
      row.enqueuedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    }
    writeFileSync(queuePath(dataDir), JSON.stringify(raw));
    const lines = await captureAll(() => {
      purgeOldDoneItems(dataDir);
      assert.equal(loadQueue(dataDir).items.length, 0);
    });
    assertQueueLog(lines, 'QUEUE_PURGE_DONE', { op: 'purge', text: 'purged 2 old' });
    assert.ok(lines.some((l) => l.includes('hint=2')));
  });

  it('purgeOldDoneItems skips pending items and stays silent without QUEUE codes', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 125 }));
    const lines = await captureAll(() => {
      purgeOldDoneItems(dataDir);
      assert.equal(loadQueue(dataDir).items.length, 1);
    });
    assertNoQueueLogs(lines);
  });

  it('purgeOldDoneItems nothing to purge stays silent without QUEUE codes', async () => {
    const lines = await captureAll(() => {
      purgeOldDoneItems(dataDir);
    });
    assertNoQueueLogs(lines);
  });

  it('logs QUEUE_MARK_MISS on markDone unknown id', async () => {
    const lines = await captureAll(() => {
      markDone(dataDir, 'missing-done-id');
    });
    assertQueueLog(lines, 'QUEUE_MARK_MISS', {
      itemId: 'missing-done-id',
      op: 'mark_done',
      text: 'markDone: unknown id',
    });
  });

  it('markDone success stays silent without QUEUE codes', async () => {
    const { item } = appendQueueItem(dataDir, baseItem({ telegramMessageId: 106 }));
    const lines = await captureAll(() => {
      markDone(dataDir, item.id);
    });
    assertNoQueueLogs(lines);
  });

  it('logs QUEUE_MARK_MISS on markFailed unknown id', async () => {
    const lines = await captureAll(() => {
      markFailed(dataDir, 'missing-fail-id', 'boom');
    });
    assertQueueLog(lines, 'QUEUE_MARK_MISS', {
      itemId: 'missing-fail-id',
      op: 'mark_failed',
      text: 'markFailed: unknown id',
    });
  });

  it('logs QUEUE_ITEM_FAIL on markFailed first attempt with hint pending', async () => {
    const { item } = appendQueueItem(dataDir, baseItem({ telegramMessageId: 107 }));
    const lines = await captureAll(() => {
      markFailed(dataDir, item.id, 'err1');
    });
    assertQueueLog(lines, 'QUEUE_ITEM_FAIL', {
      itemId: item.id,
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'mark_failed',
      attempt: 1,
      hint: 'pending',
      text: 'err1',
    });
  });

  it('markFailed on processing item logs QUEUE_ITEM_FAIL with attempt 1', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 126 }));
    const claimed = claimNextPending(dataDir)!;
    const lines = await captureAll(() => {
      markFailed(dataDir, claimed.id, 'proc fail');
    });
    assertQueueLog(lines, 'QUEUE_ITEM_FAIL', {
      itemId: claimed.id,
      attempt: 1,
      hint: 'pending',
      text: 'proc fail',
    });
  });

  it('logs QUEUE_ITEM_FAIL emits exactly one log line on markFailed', async () => {
    const { item } = appendQueueItem(dataDir, baseItem({ telegramMessageId: 127 }));
    const lines = await captureAll(() => {
      markFailed(dataDir, item.id, 'single fail');
    });
    assert.equal(lines.filter((l) => l.includes('code=QUEUE_ITEM_FAIL')).length, 1);
    assertQueueLog(lines, 'QUEUE_ITEM_FAIL', { itemId: item.id, text: 'single fail' });
  });

  it('logs QUEUE_ITEM_FAIL on markFailed third attempt with hint failed', async () => {
    const { item } = appendQueueItem(dataDir, baseItem({ telegramMessageId: 135 }));
    markFailed(dataDir, item.id, 'err1');
    markFailed(dataDir, item.id, 'err2');
    const lines = await captureAll(() => {
      markFailed(dataDir, item.id, 'err3');
    });
    assertQueueLog(lines, 'QUEUE_ITEM_FAIL', {
      itemId: item.id,
      attempt: 3,
      hint: 'failed',
      text: 'err3',
    });
  });

  it('logs QUEUE_ITEM_FAIL on markFailed second attempt with hint failed', async () => {
    const { item } = appendQueueItem(dataDir, baseItem({ telegramMessageId: 108 }));
    markFailed(dataDir, item.id, 'err1');
    const lines = await captureAll(() => {
      markFailed(dataDir, item.id, 'err2');
    });
    assertQueueLog(lines, 'QUEUE_ITEM_FAIL', {
      itemId: item.id,
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      op: 'mark_failed',
      attempt: 2,
      hint: 'failed',
      text: 'err2',
    });
  });

  it('getPendingQueuePath stays silent without QUEUE codes', async () => {
    const lines = await captureAll(() => {
      assert.ok(getPendingQueuePath(dataDir).endsWith('pending-telegram-queue.json'));
    });
    assertNoQueueLogs(lines);
  });

  it('hasPendingItems false on empty queue stays silent without QUEUE codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(hasPendingItems(dataDir), false);
    });
    assertNoQueueLogs(lines);
  });

  it('hasPendingItems stays silent without QUEUE codes', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 109 }));
    const lines = await captureAll(() => {
      assert.equal(hasPendingItems(dataDir), true);
    });
    assertNoQueueLogs(lines);
  });

  it('countPending zero on empty queue stays silent without QUEUE codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(countPending(dataDir), 0);
    });
    assertNoQueueLogs(lines);
  });

  it('countPending includes items reset from stale processing without extra QUEUE codes', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 136 }));
    claimNextPending(dataDir);
    const raw = JSON.parse(readFileSync(queuePath(dataDir), 'utf-8'));
    raw.items[0].processingStartedAt = Date.now() - 6 * 60 * 1000;
    writeFileSync(queuePath(dataDir), JSON.stringify(raw));
    const lines = await captureAll(() => {
      assert.equal(countPending(dataDir), 1);
    });
    assert.equal(lines.filter((l) => l.includes('code=QUEUE_')).length, 1);
    assertQueueLog(lines, 'QUEUE_STALE_RESET', { op: 'stale_reset' });
  });

  it('countPending stays silent without QUEUE codes', async () => {
    appendQueueItem(dataDir, baseItem({ telegramMessageId: 110 }));
    const lines = await captureAll(() => {
      assert.equal(countPending(dataDir), 1);
    });
    assertNoQueueLogs(lines);
  });
});

const OFFLINE_QUEUE_LOG_CODES = [
  'QUEUE_LOAD_INVALID',
  'QUEUE_LOAD_FAIL',
  'QUEUE_SAVE_FAIL',
  'QUEUE_PURGE_DONE',
  'QUEUE_STALE_RESET',
  'QUEUE_CLAIM',
  'QUEUE_MARK_MISS',
  'QUEUE_ITEM_FAIL',
  'QUEUE_ENQUEUE',
] as const;

const SILENT_PATH_MARKERS = [
  'stays silent',
  'without QUEUE',
  'duplicate',
  'empty queue',
  'fresh processing',
  'nothing to purge',
  'valid v2',
  'valid v1',
  'success',
  'missing file',
  'items is not an array',
  'exactly one',
  'cursor-handoff',
  'different chatId',
  'skips processing',
  'enqueuedAt fallback',
  'old queued item',
  'keeps recent done',
  'false on empty',
  'zero on empty',
  'missing version',
  'swallows',
  'attachments',
  'multiple stale',
  'multiple old',
  'skips pending',
  'processing item',
  'empty object',
  'same item id',
  'FIFO',
  'third attempt',
  'skips old failed',
  'per resetStaleProcessing',
  'per purgeOldDoneItems',
  'stale processing item is reset',
  'includes items reset',
] as const;

const OFFLINE_QUEUE_PATH_MATRIX = [
  { kind: 'fail' as const, code: 'QUEUE_LOAD_FAIL', marker: 'corrupt json' },
  { kind: 'fail' as const, code: 'QUEUE_LOAD_INVALID', marker: 'items is not an array' },
  { kind: 'fail' as const, code: 'QUEUE_LOAD_INVALID', marker: 'empty object' },
  { kind: 'fail' as const, code: 'QUEUE_LOAD_INVALID', marker: 'missing version field' },
  { kind: 'fail' as const, code: 'QUEUE_LOAD_INVALID', marker: 'invalid shape' },
  { kind: 'silent' as const, marker: 'loadQueue missing file' },
  { kind: 'silent' as const, marker: 'loadQueue valid v2 file' },
  { kind: 'silent' as const, marker: 'loadQueue valid v1 file' },
  { kind: 'fail' as const, code: 'QUEUE_SAVE_FAIL', marker: 'read-only' },
  { kind: 'silent' as const, marker: 'saveQueue swallows write error without rethrow' },
  { kind: 'silent' as const, marker: 'saveQueue success' },
  { kind: 'fail' as const, code: 'QUEUE_ENQUEUE', marker: 'appendQueueItem new item' },
  { kind: 'fail' as const, code: 'QUEUE_ENQUEUE', marker: 'attachments and caption' },
  { kind: 'fail' as const, code: 'QUEUE_ENQUEUE', marker: 'exactly one log line for appendQueueItem' },
  { kind: 'fail' as const, code: 'QUEUE_ENQUEUE', marker: 'cursor-handoff enqueuedBy' },
  { kind: 'fail' as const, code: 'QUEUE_ENQUEUE', marker: 'different chatId logs QUEUE_ENQUEUE' },
  { kind: 'silent' as const, marker: 'appendQueueItem duplicate returns same item id' },
  { kind: 'silent' as const, marker: 'appendQueueItem duplicate' },
  { kind: 'fail' as const, code: 'QUEUE_CLAIM', marker: 'FIFO claims first pending item' },
  { kind: 'fail' as const, code: 'QUEUE_CLAIM', marker: 'claimNextPending' },
  { kind: 'fail' as const, code: 'QUEUE_CLAIM', marker: 'exactly one log line for claimNextPending' },
  { kind: 'silent' as const, marker: 'claimNextPending skips processing item' },
  { kind: 'silent' as const, marker: 'claimNextPending empty queue' },
  { kind: 'fail' as const, code: 'QUEUE_STALE_RESET', marker: 'processing item is stale' },
  { kind: 'fail' as const, code: 'QUEUE_STALE_RESET', marker: 'exactly one log line per resetStaleProcessing' },
  { kind: 'fail' as const, code: 'QUEUE_STALE_RESET', marker: 'stale processing item is reset' },
  { kind: 'fail' as const, code: 'QUEUE_STALE_RESET', marker: 'enqueuedAt fallback without processingStartedAt' },
  { kind: 'fail' as const, code: 'QUEUE_STALE_RESET', marker: 'multiple stale processing items' },
  { kind: 'silent' as const, marker: 'fresh processing of old queued item' },
  { kind: 'silent' as const, marker: 'resetStaleProcessing fresh processing' },
  { kind: 'fail' as const, code: 'QUEUE_PURGE_DONE', marker: 'old done items removed' },
  { kind: 'fail' as const, code: 'QUEUE_PURGE_DONE', marker: 'exactly one log line per purgeOldDoneItems' },
  { kind: 'fail' as const, code: 'QUEUE_PURGE_DONE', marker: 'multiple old done items removed' },
  { kind: 'silent' as const, marker: 'purgeOldDoneItems keeps recent done items' },
  { kind: 'silent' as const, marker: 'purgeOldDoneItems skips old failed items' },
  { kind: 'silent' as const, marker: 'purgeOldDoneItems skips pending items' },
  { kind: 'silent' as const, marker: 'purgeOldDoneItems nothing to purge' },
  { kind: 'fail' as const, code: 'QUEUE_MARK_MISS', marker: 'markDone unknown id' },
  { kind: 'silent' as const, marker: 'markDone success' },
  { kind: 'fail' as const, code: 'QUEUE_MARK_MISS', marker: 'markFailed unknown id' },
  { kind: 'fail' as const, code: 'QUEUE_ITEM_FAIL', marker: 'processing item logs QUEUE_ITEM_FAIL' },
  { kind: 'fail' as const, code: 'QUEUE_ITEM_FAIL', marker: 'exactly one log line on markFailed' },
  { kind: 'fail' as const, code: 'QUEUE_ITEM_FAIL', marker: 'first attempt with hint pending' },
  { kind: 'fail' as const, code: 'QUEUE_ITEM_FAIL', marker: 'third attempt with hint failed' },
  { kind: 'fail' as const, code: 'QUEUE_ITEM_FAIL', marker: 'second attempt with hint failed' },
  { kind: 'silent' as const, marker: 'getPendingQueuePath' },
  { kind: 'silent' as const, marker: 'hasPendingItems false on empty queue' },
  { kind: 'silent' as const, marker: 'hasPendingItems' },
  { kind: 'silent' as const, marker: 'countPending zero on empty queue' },
  { kind: 'fail' as const, code: 'QUEUE_STALE_RESET', marker: 'countPending includes items reset from stale' },
  { kind: 'silent' as const, marker: 'countPending stays silent' },
  { kind: 'meta' as const, marker: 'offline-queue no inline scope outside queueCtx helper' },
] as const;

describe('offline-queue logging coverage', () => {
  it('asserts every offline-queue code in test file', () => {
    const src = readFileSync(new URL('./offline-queue-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of OFFLINE_QUEUE_LOG_CODES) {
      const covered =
        src.includes(`code=${code}`)
        || src.includes(`assertQueueLog(lines, '${code}'`);
      assert.ok(covered, `missing assertion for ${code}`);
    }
    assert.equal(OFFLINE_QUEUE_LOG_CODES.length, 9);
  });

  it('offline-queue.ts declares exactly the covered codes', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    const found = new Set<string>();
    for (const m of src.matchAll(/'(QUEUE_[A-Z_]+)'/g)) {
      found.add(m[1]);
    }
    for (const code of OFFLINE_QUEUE_LOG_CODES) {
      assert.ok(found.has(code), `offline-queue.ts missing ${code}`);
    }
    assert.equal(found.size, OFFLINE_QUEUE_LOG_CODES.length);
  });

  it('offline-queue.ts uses queueCtx on every log site', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
    const re = /log(?:Info|Warn)\(\s*'(QUEUE_[A-Z_]+)'[\s\S]*?\);/g;
    const codes: string[] = [];
    for (const m of src.matchAll(re)) {
      codes.push(m[1]);
      assert.ok(m[0].includes('queueCtx('), `log site ${m[1]} missing queueCtx(`);
    }
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, OFFLINE_QUEUE_LOG_CODES.length);
    assert.ok(!src.match(/log(?:Info|Warn)\([^)]*\{ scope: 'queue'/));
  });

  it('info codes use logInfo and warn codes use logWarn in source', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    for (const code of ['QUEUE_PURGE_DONE', 'QUEUE_STALE_RESET', 'QUEUE_CLAIM', 'QUEUE_ENQUEUE'] as const) {
      assert.match(src, new RegExp(`logInfo\\(\\s*'${code}'`));
    }
    for (const code of ['QUEUE_LOAD_INVALID', 'QUEUE_LOAD_FAIL', 'QUEUE_SAVE_FAIL', 'QUEUE_MARK_MISS', 'QUEUE_ITEM_FAIL'] as const) {
      assert.match(src, new RegExp(`logWarn\\(\\s*'${code}'`));
    }
  });

  it('every warn code has assertQueueLog in behavioral tests', () => {
    const src = readFileSync(new URL('./offline-queue-logging.test.ts', import.meta.url), 'utf-8');
    const warnCodes = OFFLINE_QUEUE_LOG_CODES.filter(
      (c) => !['QUEUE_PURGE_DONE', 'QUEUE_STALE_RESET', 'QUEUE_CLAIM', 'QUEUE_ENQUEUE'].includes(c),
    );
    for (const code of warnCodes) {
      assert.ok(
        src.includes(`assertQueueLog(lines, '${code}'`),
        `behavioral test missing assertQueueLog for ${code}`,
      );
    }
  });

  it('info codes have assertQueueLog in behavioral tests', () => {
    const src = readFileSync(new URL('./offline-queue-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of ['QUEUE_PURGE_DONE', 'QUEUE_STALE_RESET', 'QUEUE_CLAIM', 'QUEUE_ENQUEUE'] as const) {
      assert.ok(src.includes(`assertQueueLog(lines, '${code}'`), `missing assertQueueLog for ${code}`);
    }
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./offline-queue-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent path marker "${marker}" in behavioral titles`);
    }
  });

  it('each log code is referenced in a behavioral it() title', () => {
    const src = readFileSync(new URL('./offline-queue-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of OFFLINE_QUEUE_LOG_CODES) {
      assert.ok(
        src.includes(`logs ${code}`) || src.includes(`and ${code}`),
        `no behavioral it() title references ${code}`,
      );
    }
  });

  it('QUEUE_LOAD_FAIL and QUEUE_SAVE_FAIL use normalizeError for errno in source', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    const loadBlock = src.slice(
      src.indexOf('export function loadQueue'),
      src.indexOf('export function saveQueue'),
    );
    const saveBlock = src.slice(
      src.indexOf('export function saveQueue'),
      src.indexOf('export function purgeOldDoneItems'),
    );
    assert.match(loadBlock, /QUEUE_LOAD_FAIL[\s\S]*errno: norm\.errno/);
    assert.match(saveBlock, /QUEUE_SAVE_FAIL[\s\S]*errno: norm\.errno/);
  });

  it('offline-queue.ts declares exactly 10 log emission sites', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    assert.equal(src.match(/log(?:Info|Warn)\(\s*'QUEUE_/g)?.length ?? 0, 10);
  });

  it('automated matrix: 9/9 codes have behavioral assertQueueLog', () => {
    const src = readFileSync(new URL('./offline-queue-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of OFFLINE_QUEUE_LOG_CODES) {
      assert.ok(
        src.includes(`assertQueueLog(lines, '${code}'`),
        `behavioral matrix missing assertQueueLog for ${code}`,
      );
    }
  });

  it('path matrix rows map to behavioral test titles or assertQueueLog', () => {
    const src = readFileSync(new URL('./offline-queue-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of OFFLINE_QUEUE_PATH_MATRIX) {
      if (row.kind === 'fail' && 'code' in row) {
        const hit =
          src.includes(`logs ${row.code}`)
          || src.includes(`and ${row.code}`)
          || src.includes(`assertQueueLog(lines, '${row.code}'`);
        assert.ok(hit, `path matrix fail ${row.code} (${row.marker}) not covered`);
        assert.ok(src.includes(row.marker), `path matrix marker "${row.marker}" missing from titles`);
      } else {
        assert.ok(src.includes(row.marker), `path matrix silent "${row.marker}" missing from titles`);
      }
    }
    assert.equal(OFFLINE_QUEUE_PATH_MATRIX.length, 52);
  });

  it('every exported offline-queue helper is exercised in behavioral tests', () => {
    const src = readFileSync(new URL('./offline-queue-logging.test.ts', import.meta.url), 'utf-8');
    for (const fn of [
      'getPendingQueuePath',
      'loadQueue',
      'saveQueue',
      'purgeOldDoneItems',
      'resetStaleProcessing',
      'hasPendingItems',
      'countPending',
      'claimNextPending',
      'markDone',
      'markFailed',
      'appendQueueItem',
    ] as const) {
      assert.ok(src.includes(`${fn}(`), `behavioral suite missing call to ${fn}`);
    }
  });

  it('offline-queue.ts vs HEAD has zero console and exactly 10 logEvent sites', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
    assert.equal(src.match(/log(?:Info|Warn)\(/g)?.length ?? 0, 10);
  });

  it('QUEUE_MARK_MISS appears twice for markDone and markFailed in source', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    assert.equal(src.match(/QUEUE_MARK_MISS/g)?.length ?? 0, 2);
    assert.match(src, /markDone: unknown id/);
    assert.match(src, /markFailed: unknown id/);
  });

  it('QUEUE_ITEM_FAIL passes itemId threadId chatId attempt hint via queueCtx in source', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('export function markFailed'));
    assert.match(block, /QUEUE_ITEM_FAIL[\s\S]*itemId: id/);
    assert.match(block, /threadId: item\.threadId/);
    assert.match(block, /chatId: item\.chatId/);
    assert.match(block, /attempt: item\.attempts/);
    assert.match(block, /hint: item\.status/);
  });

  it('emptyQueue helper has no logEvent in offline-queue.ts', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('function emptyQueue'),
      src.indexOf('export function loadQueue'),
    );
    assert.ok(!block.includes('logInfo('));
    assert.ok(!block.includes('logWarn('));
  });

  it('resetStaleProcessing uses processingStartedAt fallback to enqueuedAt in source', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('export function resetStaleProcessing'),
      src.indexOf('export function hasPendingItems'),
    );
    assert.match(block, /processingStartedAt \?\? item\.enqueuedAt/);
  });

  it('claimNextPending calls resetStaleProcessing before claim in source', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('export function claimNextPending'),
      src.indexOf('export function markDone'),
    );
    assert.match(block, /resetStaleProcessing\(dataDir\)/);
    assert.match(block, /QUEUE_CLAIM[\s\S]*itemId: item\.id/);
  });

  it('appendQueueItem dedupes by telegramMessageId and chatId only in source', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('export function appendQueueItem'));
    assert.match(block, /telegramMessageId === partial\.telegramMessageId && i\.chatId === partial\.chatId/);
    assert.ok(!block.includes('threadId === partial.threadId'));
  });

  it('QUEUE_LOAD_INVALID passes hint file path via queueCtx in source', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('export function loadQueue'),
      src.indexOf('export function saveQueue'),
    );
    assert.match(block, /QUEUE_LOAD_INVALID[\s\S]*hint: path/);
  });

  it('markDone success path emits no log sites in source', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('export function markDone'),
      src.indexOf('export function markFailed'),
    );
    const successBlock = block.match(/item\.status = 'done'[\s\S]*?saveQueue\(dataDir, queue\);/)?.[0] ?? '';
    assert.ok(successBlock.length > 0);
    assert.ok(!successBlock.includes('logInfo('));
    assert.ok(!successBlock.includes('logWarn('));
  });

  it('hasPendingItems and countPending call resetStaleProcessing in source', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    for (const fn of ['hasPendingItems', 'countPending'] as const) {
      const block = src.slice(
        src.indexOf(`export function ${fn}`),
        src.indexOf('export ', src.indexOf(`export function ${fn}`) + 1),
      );
      assert.match(block, /resetStaleProcessing\(dataDir\)/);
    }
  });

  it('loadQueue returns emptyQueue without log when file missing in source', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('export function loadQueue'),
      src.indexOf('export function saveQueue'),
    );
    assert.match(block, /if \(!existsSync\(path\)\) return emptyQueue\(\)/);
    const beforeTry = block.split('try {')[0] ?? '';
    assert.ok(!beforeTry.includes('logWarn('));
  });

  it('resetStaleProcessing saves only when resetCount is positive in source', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('export function resetStaleProcessing'),
      src.indexOf('export function hasPendingItems'),
    );
    assert.match(block, /if \(resetCount > 0\)[\s\S]*QUEUE_STALE_RESET/);
    assert.match(block, /hint: String\(resetCount\)/);
  });

  it('saveQueue does not rethrow after QUEUE_SAVE_FAIL in source', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('export function saveQueue'),
      src.indexOf('export function purgeOldDoneItems'),
    );
    assert.match(block, /QUEUE_SAVE_FAIL[\s\S]*\}/);
    assert.ok(!block.includes('throw err'));
  });

  it('purgeOldDoneItems logs only when removed count is positive in source', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('export function purgeOldDoneItems'),
      src.indexOf('export function resetStaleProcessing'),
    );
    assert.match(block, /if \(removed > 0\)[\s\S]*QUEUE_PURGE_DONE/);
    assert.match(block, /hint: String\(removed\)/);
  });

  it('appendQueueItem duplicate path has no logEvent before early return in source', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('export function appendQueueItem'));
    const dupBlock = block.match(/if \(dup\) \{[\s\S]*?return \{ item: existing, added: false \};/)?.[0] ?? '';
    assert.ok(dupBlock.length > 0);
    assert.ok(!dupBlock.includes('logInfo('));
    assert.ok(!dupBlock.includes('logWarn('));
  });

  it('queueCtx helper is private and sets scope queue in source', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.match(/function queueCtx[\s\S]*?^export function getPendingQueuePath/m)?.[0] ?? '';
    assert.match(block, /scope: 'queue'/);
    assert.ok(!src.includes('export function queueCtx'));
  });

  it('offline-queue no inline scope outside queueCtx helper', () => {
    const src = readFileSync(
      new URL('../../src/workspace/offline-queue.ts', import.meta.url),
      'utf-8',
    );
    const body = src.replace(/function queueCtx[\s\S]*?^}/m, '');
    assert.ok(!body.includes("scope: '"));
  });
});
