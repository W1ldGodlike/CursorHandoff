import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { MessageTracker } from '../../src/telegram/pipeline/tracker.js';

const THREAD_ID = 11;
const ALT_THREAD_ID = 22;
const ELEMENT_ID = 'msg-el-1';
const CONTENT_HASH = 'abc123def456';
const MAX_PER_THREAD = 300;

const TRACKER_LOG_CODES = [
  'TG_TRACKER_LOAD_OK',
  'TG_TRACKER_LOAD_FAIL',
  'TG_TRACKER_SAVE_FAIL',
] as const;

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

function assertTrackerLog(
  lines: string[],
  code: string,
  need: {
    threadId?: number;
    errno?: string;
    op?: string;
    hintPath?: string;
    text?: string;
  } = {},
): void {
  const line = need.text
    ? lines.find((l) => l.includes(`code=${code}`) && l.includes(need.text!))
    : lines.find((l) => l.includes(`code=${code}`));
  assert.ok(line, need.text ? `missing code=${code} with text "${need.text}"` : `missing code=${code}`);
  assert.ok(line!.includes('scope=telegram'), `${code} missing scope=telegram`);
  if (need.threadId !== undefined) {
    assert.ok(line!.includes(`threadId=${need.threadId}`), `${code} missing threadId=${need.threadId}`);
  }
  if (need.errno) assert.ok(line!.includes(`errno=${need.errno}`), `${code} missing errno=${need.errno}`);
  if (need.op) assert.ok(line!.includes(`op=${need.op}`), `${code} missing op=${need.op}`);
  if (need.hintPath) {
    assert.ok(
      line!.includes(need.hintPath) || line!.includes(basename(need.hintPath)),
      `${code} missing hint path ${need.hintPath}`,
    );
  }
  if (need.text) assert.ok(line!.includes(need.text), `${code} missing text fragment "${need.text}"`);
}

function assertNoTrackerLogs(lines: string[]): void {
  const hit = lines.find((l) => /code=TG_TRACKER_/.test(l));
  assert.ok(!hit, `unexpected tracker log: ${hit}`);
}

function trackerPath(dataDir: string): string {
  return join(dataDir, 'telegram-messages.json');
}

function validPersisted(
  messages: Record<string, unknown> = {},
  selectorHashes: Record<string, string> = {},
): string {
  return JSON.stringify({ messages, selectorHashes });
}

function trackedEntry(overrides: Partial<{
  telegramMsgIds: number[];
  threadId: number;
  elementId: string;
  lastContentHash: string;
  type: string;
}> = {}) {
  return {
    telegramMsgIds: [99],
    threadId: THREAD_ID,
    elementId: ELEMENT_ID,
    lastContentHash: CONTENT_HASH,
    type: 'assistant',
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

async function settle(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

describe('tracker logging', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-tracker-log-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    mock.timers.reset();
  });

  it('logs TG_TRACKER_LOAD_OK when valid tracker file loads on construct with op load_tracker', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, validPersisted({ [`${THREAD_ID}:${ELEMENT_ID}`]: trackedEntry() }));

    const lines = await captureAll(() => {
      new MessageTracker(path);
    });

    assertTrackerLog(lines, 'TG_TRACKER_LOAD_OK', {
      op: 'load_tracker',
      hintPath: path,
      text: 'loaded 1 tracked messages',
    });
  });

  it('logs TG_TRACKER_LOAD_OK for empty messages object with zero count', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, validPersisted());

    const lines = await captureAll(() => {
      new MessageTracker(path);
    });

    assertTrackerLog(lines, 'TG_TRACKER_LOAD_OK', {
      op: 'load_tracker',
      text: 'loaded 0 tracked messages',
    });
  });

  it('logs exactly one TG_TRACKER_LOAD_OK log line per constructor load', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, validPersisted());

    const lines = await captureAll(() => {
      new MessageTracker(path);
    });

    assert.equal(lines.filter((l) => l.includes('code=TG_TRACKER_LOAD_OK')).length, 1);
  });

  it('logs TG_TRACKER_LOAD_FAIL when messages field is missing with invalid tracker file shape', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, JSON.stringify({ selectorHashes: {} }));

    const lines = await captureAll(() => {
      new MessageTracker(path);
    });

    assertTrackerLog(lines, 'TG_TRACKER_LOAD_FAIL', {
      op: 'load_tracker',
      hintPath: path,
      text: 'invalid tracker file shape',
    });
  });

  it('logs TG_TRACKER_LOAD_FAIL when messages is null', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, JSON.stringify({ messages: null, selectorHashes: {} }));

    const lines = await captureAll(() => {
      new MessageTracker(path);
    });

    assertTrackerLog(lines, 'TG_TRACKER_LOAD_FAIL', {
      op: 'load_tracker',
      text: 'invalid tracker file shape',
    });
  });

  it('logs exactly one TG_TRACKER_LOAD_FAIL log line for invalid shape load', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, '{}');

    const lines = await captureAll(() => {
      new MessageTracker(path);
    });

    assert.equal(lines.filter((l) => l.includes('code=TG_TRACKER_LOAD_FAIL')).length, 1);
    assertTrackerLog(lines, 'TG_TRACKER_LOAD_FAIL', { text: 'invalid tracker file shape' });
  });

  it('logs TG_TRACKER_LOAD_FAIL when messages is a string not object', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, JSON.stringify({ messages: 'not-an-object', selectorHashes: {} }));

    const lines = await captureAll(() => {
      new MessageTracker(path);
    });

    assertTrackerLog(lines, 'TG_TRACKER_LOAD_FAIL', {
      op: 'load_tracker',
      text: 'invalid tracker file shape',
    });
  });

  it('logs exactly one TG_TRACKER_LOAD_FAIL log line for corrupt json load', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, '{bad-json');

    const lines = await captureAll(() => {
      new MessageTracker(path);
    });

    assert.equal(lines.filter((l) => l.includes('code=TG_TRACKER_LOAD_FAIL')).length, 1);
  });

  it('reload from disk on new MessageTracker logs TG_TRACKER_LOAD_OK with persisted count', async () => {
    const path = trackerPath(dataDir);
    const first = new MessageTracker(path);
    first.track(THREAD_ID, ELEMENT_ID, [7], CONTENT_HASH, 'assistant');
    first.flush();

    const lines = await captureAll(() => {
      const reloaded = new MessageTracker(path);
      assert.ok(reloaded.isTracked(THREAD_ID, ELEMENT_ID));
    });

    assertTrackerLog(lines, 'TG_TRACKER_LOAD_OK', {
      op: 'load_tracker',
      text: 'loaded 1 tracked messages',
    });
  });

  it('logs TG_TRACKER_SAVE_FAIL on debounced save when persist file is read-only', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, validPersisted());
    const tracker = new MessageTracker(path);

    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');
        makeReadOnly(path);
        mock.timers.tick(5000);
        await settle();
      } finally {
        mock.timers.reset();
      }
    });

    makeWritable(path);
    assertTrackerLog(lines, 'TG_TRACKER_SAVE_FAIL', { op: 'persist_tracker' });
  });

  it('logs TG_TRACKER_SAVE_FAIL on flush when persist directory is missing', async () => {
    const path = trackerPath(dataDir);
    const tracker = new MessageTracker(path);
    tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');
    rmSync(dataDir, { recursive: true, force: true });

    const lines = await captureAll(() => {
      tracker.flush();
    });

    assertTrackerLog(lines, 'TG_TRACKER_SAVE_FAIL', {
      op: 'persist_tracker',
      hintPath: path,
    });
  });

  it('logs TG_TRACKER_LOAD_FAIL on corrupt json with errno via normalizeError', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, '{not-json');

    const lines = await captureAll(() => {
      new MessageTracker(path);
    });

    assertTrackerLog(lines, 'TG_TRACKER_LOAD_FAIL', {
      op: 'load_tracker',
      hintPath: path,
    });
    const failLine = lines.find((l) => l.includes('code=TG_TRACKER_LOAD_FAIL'));
    assert.ok(failLine && !failLine.includes('invalid tracker file shape'));
  });

  it('logs TG_TRACKER_SAVE_FAIL on flush when persist file is read-only with op persist_tracker', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, validPersisted());

    let tracker!: MessageTracker;
    await captureAll(() => {
      tracker = new MessageTracker(path);
    });

    tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');
    makeReadOnly(path);

    const lines = await captureAll(() => {
      tracker.flush();
    });

    makeWritable(path);
    assertTrackerLog(lines, 'TG_TRACKER_SAVE_FAIL', {
      op: 'persist_tracker',
      hintPath: path,
    });
  });

  it('logs exactly one TG_TRACKER_SAVE_FAIL log line on failed flush', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, validPersisted());
    const tracker = new MessageTracker(path);
    tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');
    makeReadOnly(path);

    const lines = await captureAll(() => {
      tracker.flush();
    });

    makeWritable(path);
    assert.equal(lines.filter((l) => l.includes('code=TG_TRACKER_SAVE_FAIL')).length, 1);
  });

  it('TG_TRACKER_SAVE_FAIL includes errno when write fails with Error code', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, validPersisted());
    const tracker = new MessageTracker(path);
    tracker.track(THREAD_ID, 'el-save', [2], CONTENT_HASH, 'user');
    makeReadOnly(path);

    const lines = await captureAll(() => {
      tracker.flush();
    });

    makeWritable(path);
    const saveLine = lines.find((l) => l.includes('code=TG_TRACKER_SAVE_FAIL'));
    assert.ok(saveLine);
    assert.match(saveLine!, /errno=|EPERM|EACCES/);
  });

  it('logs TG_TRACKER_LOAD_OK with correct count when multiple messages persisted', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(
      path,
      validPersisted({
        [`${THREAD_ID}:a`]: trackedEntry({ elementId: 'a' }),
        [`${THREAD_ID}:b`]: trackedEntry({ elementId: 'b' }),
        [`${ALT_THREAD_ID}:c`]: trackedEntry({ threadId: ALT_THREAD_ID, elementId: 'c' }),
      }),
    );

    const lines = await captureAll(() => {
      new MessageTracker(path);
    });

    assertTrackerLog(lines, 'TG_TRACKER_LOAD_OK', {
      op: 'load_tracker',
      text: 'loaded 3 tracked messages',
    });
  });

  it('logs TG_TRACKER_LOAD_OK includes hint persist path on load', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, validPersisted());

    const lines = await captureAll(() => {
      new MessageTracker(path);
    });

    assertTrackerLog(lines, 'TG_TRACKER_LOAD_OK', {
      op: 'load_tracker',
      hintPath: path,
    });
  });

  it('logs TG_TRACKER_LOAD_FAIL when messages is a number not object', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, JSON.stringify({ messages: 42, selectorHashes: {} }));

    const lines = await captureAll(() => {
      new MessageTracker(path);
    });

    assertTrackerLog(lines, 'TG_TRACKER_LOAD_FAIL', {
      op: 'load_tracker',
      text: 'invalid tracker file shape',
    });
  });

  it('logs exactly one TG_TRACKER_SAVE_FAIL on debounced read-only save', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, validPersisted());
    const tracker = new MessageTracker(path);

    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');
        makeReadOnly(path);
        mock.timers.tick(5000);
        await settle();
      } finally {
        mock.timers.reset();
      }
    });

    makeWritable(path);
    assert.equal(lines.filter((l) => l.includes('code=TG_TRACKER_SAVE_FAIL')).length, 1);
  });

  it('logs TG_TRACKER_SAVE_FAIL on clearAll when persist file is read-only', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, validPersisted());
    const tracker = new MessageTracker(path);
    tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');
    makeReadOnly(path);

    const lines = await captureAll(() => {
      tracker.clearAll();
    });

    makeWritable(path);
    assertTrackerLog(lines, 'TG_TRACKER_SAVE_FAIL', {
      op: 'persist_tracker',
      hintPath: path,
    });
  });

  it('logs exactly one TG_TRACKER_SAVE_FAIL on clearAll when persist file is read-only', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, validPersisted());
    const tracker = new MessageTracker(path);
    tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');
    makeReadOnly(path);

    const lines = await captureAll(() => {
      tracker.clearAll();
    });

    makeWritable(path);
    assert.equal(lines.filter((l) => l.includes('code=TG_TRACKER_SAVE_FAIL')).length, 1);
  });

  it('logs TG_TRACKER_LOAD_FAIL when messages is boolean not object', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, JSON.stringify({ messages: true, selectorHashes: {} }));

    const lines = await captureAll(() => {
      new MessageTracker(path);
    });

    assertTrackerLog(lines, 'TG_TRACKER_LOAD_FAIL', {
      op: 'load_tracker',
      text: 'invalid tracker file shape',
    });
  });

  it('corrupt json load leaves tracker empty without prior messages', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, '{bad-json');

    let tracker!: MessageTracker;
    const lines = await captureAll(() => {
      tracker = new MessageTracker(path);
    });

    assertTrackerLog(lines, 'TG_TRACKER_LOAD_FAIL', { op: 'load_tracker' });
    assert.equal(tracker.isTracked(THREAD_ID, ELEMENT_ID), false);
    assert.equal(tracker.listInThread(THREAD_ID).length, 0);
  });

  it('logs TG_TRACKER_SAVE_FAIL on debounced untrack when persist file is read-only', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, validPersisted());
    const tracker = new MessageTracker(path);
    tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');
    tracker.flush();

    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        tracker.untrack(THREAD_ID, ELEMENT_ID);
        makeReadOnly(path);
        mock.timers.tick(5000);
        await settle();
      } finally {
        mock.timers.reset();
      }
    });

    makeWritable(path);
    assertTrackerLog(lines, 'TG_TRACKER_SAVE_FAIL', { op: 'persist_tracker' });
  });

  it('load missing tracker file on construct stays silent without TG_TRACKER codes', async () => {
    const path = trackerPath(dataDir);
    const lines = await captureAll(() => {
      new MessageTracker(path);
    });
    assertNoTrackerLogs(lines);
  });

  it('MessageTracker without persistPath stays silent without TG_TRACKER codes', async () => {
    const lines = await captureAll(() => {
      const tracker = new MessageTracker();
      tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');
      assert.ok(tracker.isTracked(THREAD_ID, ELEMENT_ID));
    });
    assertNoTrackerLogs(lines);
  });

  it('track and getTracked stay silent without TG_TRACKER codes when persistPath set', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, validPersisted());

    let tracker!: MessageTracker;
    await captureAll(() => {
      tracker = new MessageTracker(path);
    });

    const lines = await captureAll(() => {
      tracker.track(THREAD_ID, ELEMENT_ID, [42], CONTENT_HASH, 'assistant');
      assert.deepEqual(tracker.getTracked(THREAD_ID, ELEMENT_ID)?.telegramMsgIds, [42]);
    });
    assertNoTrackerLogs(lines);
  });

  it('successful flush after track stays silent without TG_TRACKER codes', async () => {
    const path = trackerPath(dataDir);
    const tracker = new MessageTracker(path);
    tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');

    const lines = await captureAll(() => {
      tracker.flush();
    });
    assertNoTrackerLogs(lines);
  });

  it('debounced save after track stays silent without TG_TRACKER codes', async () => {
    const path = trackerPath(dataDir);
    const tracker = new MessageTracker(path);

    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');
        mock.timers.tick(5000);
        await settle();
      } finally {
        mock.timers.reset();
      }
    });

    assertNoTrackerLogs(lines);
  });

  it('hasChanged and isTracked stay silent without TG_TRACKER codes', async () => {
    const tracker = new MessageTracker();
    const lines = await captureAll(() => {
      assert.equal(tracker.hasChanged(THREAD_ID, ELEMENT_ID, 'new-hash'), true);
      tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');
      assert.equal(tracker.isTracked(THREAD_ID, ELEMENT_ID), true);
      assert.equal(tracker.hasChanged(THREAD_ID, ELEMENT_ID, CONTENT_HASH), false);
    });
    assertNoTrackerLogs(lines);
  });

  it('untrack stays silent without TG_TRACKER codes', async () => {
    const path = trackerPath(dataDir);
    const tracker = new MessageTracker(path);
    tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');

    const lines = await captureAll(() => {
      tracker.untrack(THREAD_ID, ELEMENT_ID);
      assert.equal(tracker.isTracked(THREAD_ID, ELEMENT_ID), false);
    });
    assertNoTrackerLogs(lines);
  });

  it('clearThread stays silent without TG_TRACKER codes on successful save', async () => {
    const path = trackerPath(dataDir);
    const tracker = new MessageTracker(path);
    tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');
    tracker.track(ALT_THREAD_ID, 'other', [2], CONTENT_HASH, 'user');

    const lines = await captureAll(() => {
      tracker.clearThread(THREAD_ID);
      assert.equal(tracker.isTracked(THREAD_ID, ELEMENT_ID), false);
      assert.equal(tracker.isTracked(ALT_THREAD_ID, 'other'), true);
      tracker.flush();
    });
    assertNoTrackerLogs(lines);
  });

  it('listInThread stays silent without TG_TRACKER codes', async () => {
    const tracker = new MessageTracker();
    tracker.track(THREAD_ID, 'a', [1], CONTENT_HASH, 'assistant');
    tracker.track(THREAD_ID, 'b', [2], CONTENT_HASH, 'user');

    const lines = await captureAll(() => {
      const all = tracker.listInThread(THREAD_ID);
      assert.equal(all.length, 2);
      const prefixed = tracker.listInThread(THREAD_ID, 'a');
      assert.equal(prefixed.length, 1);
    });
    assertNoTrackerLogs(lines);
  });

  it('hashSelector and resolveHash stay silent without TG_TRACKER codes', async () => {
    const path = trackerPath(dataDir);
    const tracker = new MessageTracker(path);

    const lines = await captureAll(() => {
      const hash = tracker.hashSelector('#chat .msg');
      assert.equal(tracker.resolveHash(hash), '#chat .msg');
      tracker.flush();
    });
    assertNoTrackerLogs(lines);
  });

  it('MessageTracker.contentHash static stays silent without TG_TRACKER codes', async () => {
    const lines = await captureAll(() => {
      const hash = MessageTracker.contentHash('hello tracker');
      assert.equal(typeof hash, 'string');
      assert.equal(hash.length, 12);
    });
    assertNoTrackerLogs(lines);
  });

  it('clearAll with persistPath stays silent without TG_TRACKER codes on successful flush', async () => {
    const path = trackerPath(dataDir);
    const tracker = new MessageTracker(path);
    tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');

    const lines = await captureAll(() => {
      tracker.clearAll();
      assert.equal(tracker.isTracked(THREAD_ID, ELEMENT_ID), false);
    });
    assertNoTrackerLogs(lines);
  });

  it('TG_TRACKER_LOAD_OK loads selectorHashes without extra log beyond LOAD_OK', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(
      path,
      validPersisted({}, { abcd1234: '#selector' }),
    );

    let tracker!: MessageTracker;
    const lines = await captureAll(() => {
      tracker = new MessageTracker(path);
    });

    assert.equal(lines.filter((l) => /code=TG_TRACKER_/.test(l)).length, 1);
    assertTrackerLog(lines, 'TG_TRACKER_LOAD_OK', { op: 'load_tracker' });
    assert.equal(tracker.resolveHash('abcd1234'), '#selector');
  });

  it('flush when not dirty stays silent without TG_TRACKER codes', async () => {
    const path = trackerPath(dataDir);
    const tracker = new MessageTracker(path);

    const lines = await captureAll(() => {
      tracker.flush();
    });
    assertNoTrackerLogs(lines);
  });

  it('track overwrite same elementId stays silent without TG_TRACKER codes', async () => {
    const tracker = new MessageTracker();
    const lines = await captureAll(() => {
      tracker.track(THREAD_ID, ELEMENT_ID, [1], 'hash-a', 'assistant');
      tracker.track(THREAD_ID, ELEMENT_ID, [2, 3], 'hash-b', 'user');
      assert.deepEqual(tracker.getTracked(THREAD_ID, ELEMENT_ID)?.telegramMsgIds, [2, 3]);
    });
    assertNoTrackerLogs(lines);
  });

  it('getTracked returns undefined for missing element without TG_TRACKER codes', async () => {
    const tracker = new MessageTracker();
    const lines = await captureAll(() => {
      assert.equal(tracker.getTracked(THREAD_ID, 'missing'), undefined);
    });
    assertNoTrackerLogs(lines);
  });

  it('resolveHash returns undefined for unknown hash without TG_TRACKER codes', async () => {
    const tracker = new MessageTracker();
    const lines = await captureAll(() => {
      assert.equal(tracker.resolveHash('deadbeef'), undefined);
    });
    assertNoTrackerLogs(lines);
  });

  it('listInThread with prefix filter empty result stays silent without TG_TRACKER codes', async () => {
    const tracker = new MessageTracker();
    tracker.track(THREAD_ID, 'only', [1], CONTENT_HASH, 'assistant');

    const lines = await captureAll(() => {
      assert.equal(tracker.listInThread(THREAD_ID, 'nope').length, 0);
    });
    assertNoTrackerLogs(lines);
  });

  it('flush without persistPath stays silent without TG_TRACKER codes', async () => {
    const tracker = new MessageTracker();
    tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');

    const lines = await captureAll(() => {
      tracker.flush();
    });
    assertNoTrackerLogs(lines);
  });

  it('flush cancels pending debounced timer and persists silently without TG_TRACKER codes', async () => {
    const path = trackerPath(dataDir);
    const tracker = new MessageTracker(path);

    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');
        tracker.flush();
        mock.timers.tick(5000);
        await settle();
      } finally {
        mock.timers.reset();
      }
    });

    assertNoTrackerLogs(lines);
    const reloaded = new MessageTracker(path);
    assert.ok(reloaded.isTracked(THREAD_ID, ELEMENT_ID));
  });

  it('second track within debounce window stays silent with single debounced save', async () => {
    const path = trackerPath(dataDir);
    const tracker = new MessageTracker(path);

    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        tracker.track(THREAD_ID, 'el-a', [1], 'hash-a', 'assistant');
        tracker.track(THREAD_ID, 'el-b', [2], 'hash-b', 'user');
        mock.timers.tick(5000);
        await settle();
      } finally {
        mock.timers.reset();
      }
    });

    assertNoTrackerLogs(lines);
    const reloaded = new MessageTracker(path);
    assert.ok(reloaded.isTracked(THREAD_ID, 'el-a'));
    assert.ok(reloaded.isTracked(THREAD_ID, 'el-b'));
  });

  it('listInThread for empty thread stays silent without TG_TRACKER codes', async () => {
    const tracker = new MessageTracker();
    tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');

    const lines = await captureAll(() => {
      assert.equal(tracker.listInThread(ALT_THREAD_ID).length, 0);
    });
    assertNoTrackerLogs(lines);
  });

  it('isTracked false for missing key stays silent without TG_TRACKER codes', async () => {
    const tracker = new MessageTracker();
    const lines = await captureAll(() => {
      assert.equal(tracker.isTracked(THREAD_ID, 'missing'), false);
    });
    assertNoTrackerLogs(lines);
  });

  it('untrack then flush successful stays silent without TG_TRACKER codes', async () => {
    const path = trackerPath(dataDir);
    const tracker = new MessageTracker(path);
    tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');
    tracker.untrack(THREAD_ID, ELEMENT_ID);

    const lines = await captureAll(() => {
      tracker.flush();
    });
    assertNoTrackerLogs(lines);
  });

  it('clearThread on empty thread stays silent without TG_TRACKER codes', async () => {
    const path = trackerPath(dataDir);
    const tracker = new MessageTracker(path);

    const lines = await captureAll(() => {
      tracker.clearThread(ALT_THREAD_ID);
      tracker.flush();
    });
    assertNoTrackerLogs(lines);
  });

  it('hashSelector debounced save after tick stays silent without TG_TRACKER codes', async () => {
    const path = trackerPath(dataDir);
    const tracker = new MessageTracker(path);
    let hash = '';

    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        hash = tracker.hashSelector('#only-selector');
        mock.timers.tick(5000);
        await settle();
      } finally {
        mock.timers.reset();
      }
    });

    assertNoTrackerLogs(lines);
    const reloaded = new MessageTracker(path);
    assert.equal(reloaded.resolveHash(hash), '#only-selector');
  });

  it('invalid shape load leaves tracker untracked without TG_TRACKER codes after construct', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, '{}');

    let tracker!: MessageTracker;
    const lines = await captureAll(() => {
      tracker = new MessageTracker(path);
    });

    assertTrackerLog(lines, 'TG_TRACKER_LOAD_FAIL', { text: 'invalid tracker file shape' });
    assert.equal(tracker.isTracked(THREAD_ID, ELEMENT_ID), false);
  });

  it('load missing selectorHashes still logs TG_TRACKER_LOAD_OK when messages valid', async () => {
    const path = trackerPath(dataDir);
    writeFileSync(path, JSON.stringify({ messages: {} }));

    const lines = await captureAll(() => {
      new MessageTracker(path);
    });

    assertTrackerLog(lines, 'TG_TRACKER_LOAD_OK', { text: 'loaded 0 tracked messages' });
  });

  it('pruneThread over MAX_PER_THREAD cap stays silent without TG_TRACKER codes', async () => {
    const tracker = new MessageTracker();

    const lines = await captureAll(() => {
      for (let i = 0; i <= MAX_PER_THREAD; i++) {
        tracker.track(THREAD_ID, `el-${i}`, [i], `hash-${i}`, 'assistant');
      }
      assert.equal(tracker.listInThread(THREAD_ID).length, MAX_PER_THREAD);
      assert.equal(tracker.isTracked(THREAD_ID, 'el-0'), false);
      assert.ok(tracker.isTracked(THREAD_ID, `el-${MAX_PER_THREAD}`));
    });

    assertNoTrackerLogs(lines);
  });

  it('MessageTracker without persistPath clearAll stays silent without TG_TRACKER codes', async () => {
    const tracker = new MessageTracker();
    tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');

    const lines = await captureAll(() => {
      tracker.clearAll();
      assert.equal(tracker.isTracked(THREAD_ID, ELEMENT_ID), false);
    });
    assertNoTrackerLogs(lines);
  });

  it('double flush when already clean stays silent without TG_TRACKER codes', async () => {
    const path = trackerPath(dataDir);
    const tracker = new MessageTracker(path);
    tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');
    tracker.flush();

    const lines = await captureAll(() => {
      tracker.flush();
      tracker.flush();
    });
    assertNoTrackerLogs(lines);
  });

  it('contentHash same input returns identical digest silently without TG_TRACKER codes', async () => {
    const lines = await captureAll(() => {
      const a = MessageTracker.contentHash('same-body');
      const b = MessageTracker.contentHash('same-body');
      assert.equal(a, b);
      assert.notEqual(a, MessageTracker.contentHash('other-body'));
    });
    assertNoTrackerLogs(lines);
  });

  it('clearThread debounced save after tick stays silent without TG_TRACKER codes', async () => {
    const path = trackerPath(dataDir);
    const tracker = new MessageTracker(path);
    tracker.track(THREAD_ID, ELEMENT_ID, [1], CONTENT_HASH, 'assistant');
    tracker.track(THREAD_ID, 'el-2', [2], CONTENT_HASH, 'user');

    const lines = await captureAll(async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        tracker.clearThread(THREAD_ID);
        mock.timers.tick(5000);
        await settle();
      } finally {
        mock.timers.reset();
      }
    });

    assertNoTrackerLogs(lines);
    const reloaded = new MessageTracker(path);
    assert.equal(reloaded.listInThread(THREAD_ID).length, 0);
  });
});

const SILENT_PATH_MARKERS = [
  'load missing tracker file',
  'without persistPath',
  'track and getTracked',
  'successful flush',
  'debounced save',
  'hasChanged and isTracked',
  'untrack stays silent',
  'clearThread stays silent',
  'listInThread stays silent',
  'hashSelector and resolveHash',
  'contentHash static',
  'clearAll with persistPath',
  'selectorHashes without extra log',
  'flush when not dirty',
  'track overwrite same elementId',
  'getTracked returns undefined',
  'resolveHash returns undefined',
  'prefix filter empty result',
  'flush without persistPath',
  'flush cancels pending debounced timer',
  'second track within debounce window',
  'listInThread for empty thread',
  'isTracked false for missing key',
  'untrack then flush successful',
  'clearThread on empty thread',
  'hashSelector debounced save after tick',
  'pruneThread over MAX_PER_THREAD cap',
  'without persistPath clearAll',
  'double flush when already clean',
  'contentHash same input returns identical digest',
  'clearThread debounced save after tick',
] as const;

const TRACKER_PATH_MATRIX = [
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_OK', marker: 'valid tracker file loads on construct with op load_tracker' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_OK', marker: 'empty messages object with zero count' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_OK', marker: 'exactly one TG_TRACKER_LOAD_OK log line per constructor load' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_OK', marker: 'loads selectorHashes without extra log beyond LOAD_OK' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_OK', marker: 'missing selectorHashes still logs TG_TRACKER_LOAD_OK when messages valid' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_FAIL', marker: 'messages field is missing with invalid tracker file shape' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_FAIL', marker: 'messages is null' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_FAIL', marker: 'exactly one TG_TRACKER_LOAD_FAIL log line for invalid shape load' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_OK', marker: 'reload from disk on new MessageTracker logs TG_TRACKER_LOAD_OK with persisted count' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_FAIL', marker: 'messages is a string not object' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_FAIL', marker: 'exactly one TG_TRACKER_LOAD_FAIL log line for corrupt json load' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_FAIL', marker: 'corrupt json with errno via normalizeError' },
  { kind: 'fail' as const, code: 'TG_TRACKER_SAVE_FAIL', marker: 'debounced save when persist file is read-only' },
  { kind: 'fail' as const, code: 'TG_TRACKER_SAVE_FAIL', marker: 'flush when persist directory is missing' },
  { kind: 'fail' as const, code: 'TG_TRACKER_SAVE_FAIL', marker: 'flush when persist file is read-only with op persist_tracker' },
  { kind: 'fail' as const, code: 'TG_TRACKER_SAVE_FAIL', marker: 'exactly one TG_TRACKER_SAVE_FAIL log line on failed flush' },
  { kind: 'fail' as const, code: 'TG_TRACKER_SAVE_FAIL', marker: 'includes errno when write fails with Error code' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_OK', marker: 'correct count when multiple messages persisted' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_OK', marker: 'includes hint persist path on load' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_FAIL', marker: 'messages is a number not object' },
  { kind: 'fail' as const, code: 'TG_TRACKER_SAVE_FAIL', marker: 'exactly one TG_TRACKER_SAVE_FAIL on debounced read-only save' },
  { kind: 'fail' as const, code: 'TG_TRACKER_SAVE_FAIL', marker: 'clearAll when persist file is read-only' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_FAIL', marker: 'invalid shape load leaves tracker untracked' },
  { kind: 'silent' as const, marker: 'load missing tracker file on construct stays silent' },
  { kind: 'silent' as const, marker: 'MessageTracker without persistPath stays silent' },
  { kind: 'silent' as const, marker: 'track and getTracked stay silent' },
  { kind: 'silent' as const, marker: 'successful flush after track stays silent' },
  { kind: 'silent' as const, marker: 'debounced save after track stays silent' },
  { kind: 'silent' as const, marker: 'hasChanged and isTracked stay silent' },
  { kind: 'silent' as const, marker: 'untrack stays silent without TG_TRACKER codes' },
  { kind: 'silent' as const, marker: 'clearThread stays silent without TG_TRACKER codes on successful save' },
  { kind: 'silent' as const, marker: 'listInThread stays silent without TG_TRACKER codes' },
  { kind: 'silent' as const, marker: 'hashSelector and resolveHash stay silent' },
  { kind: 'silent' as const, marker: 'MessageTracker.contentHash static stays silent' },
  { kind: 'silent' as const, marker: 'flush when not dirty stays silent' },
  { kind: 'silent' as const, marker: 'track overwrite same elementId stays silent' },
  { kind: 'silent' as const, marker: 'getTracked returns undefined for missing element' },
  { kind: 'silent' as const, marker: 'resolveHash returns undefined for unknown hash' },
  { kind: 'silent' as const, marker: 'listInThread with prefix filter empty result stays silent' },
  { kind: 'silent' as const, marker: 'flush without persistPath stays silent' },
  { kind: 'silent' as const, marker: 'clearAll with persistPath stays silent' },
  { kind: 'silent' as const, marker: 'flush cancels pending debounced timer and persists silently' },
  { kind: 'silent' as const, marker: 'second track within debounce window stays silent with single debounced save' },
  { kind: 'silent' as const, marker: 'listInThread for empty thread stays silent' },
  { kind: 'silent' as const, marker: 'isTracked false for missing key stays silent' },
  { kind: 'silent' as const, marker: 'untrack then flush successful stays silent' },
  { kind: 'silent' as const, marker: 'clearThread on empty thread stays silent' },
  { kind: 'fail' as const, code: 'TG_TRACKER_SAVE_FAIL', marker: 'exactly one TG_TRACKER_SAVE_FAIL on clearAll when persist file is read-only' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_FAIL', marker: 'messages is boolean not object' },
  { kind: 'fail' as const, code: 'TG_TRACKER_LOAD_FAIL', marker: 'corrupt json load leaves tracker empty without prior messages' },
  { kind: 'fail' as const, code: 'TG_TRACKER_SAVE_FAIL', marker: 'debounced untrack when persist file is read-only' },
  { kind: 'silent' as const, marker: 'pruneThread over MAX_PER_THREAD cap stays silent' },
  { kind: 'silent' as const, marker: 'MessageTracker without persistPath clearAll stays silent' },
  { kind: 'silent' as const, marker: 'double flush when already clean stays silent' },
  { kind: 'silent' as const, marker: 'contentHash same input returns identical digest silently' },
  { kind: 'silent' as const, marker: 'clearThread debounced save after tick stays silent' },
  { kind: 'silent' as const, marker: 'hashSelector debounced save after tick stays silent' },
] as const;

describe('tracker logging coverage', () => {
  it('asserts every tracker code in test file', () => {
    const src = readFileSync(new URL('./tracker-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of TRACKER_LOG_CODES) {
      const covered =
        src.includes(`code=${code}`)
        || src.includes(`assertTrackerLog(lines, '${code}'`);
      assert.ok(covered, `missing assertion for ${code}`);
    }
    assert.equal(TRACKER_LOG_CODES.length, 3);
  });

  it('tracker.ts declares exactly the covered codes', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const found = new Set<string>();
    for (const m of src.matchAll(/'(TG_TRACKER_[A-Z_]+)'/g)) {
      found.add(m[1]);
    }
    for (const code of TRACKER_LOG_CODES) {
      assert.ok(found.has(code), `tracker.ts missing ${code}`);
    }
    assert.equal(found.size, TRACKER_LOG_CODES.length);
  });

  it('tracker.ts has zero console.log warn error', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
  });

  it('tracker.ts uses trackerCtx on every log site', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    assert.equal(src.match(/log(?:Info|Warn)\(\s*'TG_TRACKER_/g)?.length ?? 0, 4);

    const invalidBlock = src.slice(
      src.indexOf("if (!data.messages || typeof data.messages !== 'object')"),
      src.indexOf('for (const [key, msg] of Object.entries(data.messages)'),
    );
    assert.match(invalidBlock, /TG_TRACKER_LOAD_FAIL[\s\S]*trackerCtx\('load_tracker'/);

    const okBlock = src.slice(src.indexOf('TG_TRACKER_LOAD_OK'), src.indexOf('} catch (err)'));
    assert.match(okBlock, /trackerCtx\('load_tracker'/);

    const catchBlock = src.slice(src.indexOf('} catch (err)'), src.indexOf('private saveToDisk'));
    assert.match(catchBlock, /TG_TRACKER_LOAD_FAIL[\s\S]*trackerCtx\('load_tracker'/);

    const saveBlock = src.slice(src.indexOf('private saveToDisk'), src.length);
    assert.match(saveBlock, /TG_TRACKER_SAVE_FAIL[\s\S]*trackerCtx\('persist_tracker'/);
  });

  it('info code uses logInfo and warn codes use logWarn in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /logInfo\(\s*'TG_TRACKER_LOAD_OK'/);
    assert.equal(src.match(/logWarn\(\s*'TG_TRACKER_LOAD_FAIL'/g)?.length, 2);
    assert.match(src, /logWarn\(\s*'TG_TRACKER_SAVE_FAIL'/);
  });

  it('every warn code has assertTrackerLog in behavioral tests', () => {
    const src = readFileSync(new URL('./tracker-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of ['TG_TRACKER_LOAD_FAIL', 'TG_TRACKER_SAVE_FAIL'] as const) {
      assert.ok(
        src.includes(`assertTrackerLog(lines, '${code}'`),
        `behavioral test missing assertTrackerLog for ${code}`,
      );
    }
  });

  it('info code TG_TRACKER_LOAD_OK has assertTrackerLog in behavioral tests', () => {
    const src = readFileSync(new URL('./tracker-logging.test.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes(`assertTrackerLog(lines, 'TG_TRACKER_LOAD_OK'`));
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./tracker-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent path marker "${marker}" in behavioral titles`);
    }
  });

  it('each log code is referenced in a behavioral it() title', () => {
    const src = readFileSync(new URL('./tracker-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of TRACKER_LOG_CODES) {
      assert.ok(
        src.includes(`logs ${code}`) || src.includes(code),
        `no behavioral it() title references ${code}`,
      );
    }
  });

  it('tracker.ts declares exactly 4 log emission sites', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    assert.equal(src.match(/log(?:Info|Warn)\(\s*'TG_TRACKER_/g)?.length ?? 0, 4);
  });

  it('path matrix rows map to behavioral test titles or assertTrackerLog', () => {
    const src = readFileSync(new URL('./tracker-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of TRACKER_PATH_MATRIX) {
      if (row.kind === 'fail' && 'code' in row) {
        const hit =
          src.includes(`logs ${row.code}`)
          || src.includes(row.code)
          || src.includes(`assertTrackerLog(lines, '${row.code}'`);
        assert.ok(hit, `path matrix fail ${row.code} (${row.marker}) not covered`);
        assert.ok(src.includes(row.marker), `path matrix marker "${row.marker}" missing from titles`);
      } else {
        assert.ok(src.includes(row.marker), `path matrix silent "${row.marker}" missing from titles`);
      }
    }
    assert.equal(TRACKER_PATH_MATRIX.length, 57);
  });

  it('automated matrix: 3/3 codes have behavioral assertTrackerLog', () => {
    const src = readFileSync(new URL('./tracker-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of TRACKER_LOG_CODES) {
      assert.ok(
        src.includes(`assertTrackerLog(lines, '${code}'`),
        `behavioral matrix missing assertTrackerLog for ${code}`,
      );
    }
  });

  it('every MessageTracker public API is exercised in behavioral tests', () => {
    const src = readFileSync(new URL('./tracker-logging.test.ts', import.meta.url), 'utf-8');
    for (const api of [
      'new MessageTracker',
      'getTracked',
      '.track(',
      'hasChanged',
      'isTracked',
      'untrack',
      'clearThread',
      'listInThread',
      'clearAll',
      'contentHash',
      'hashSelector',
      'resolveHash',
      '.flush(',
    ] as const) {
      assert.ok(src.includes(api), `behavioral tests missing ${api}`);
    }
  });

  it('trackerCtx sets scope telegram in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.match(/function trackerCtx[\s\S]*?^export class MessageTracker/m)?.[0] ?? '';
    assert.match(block, /scope: 'telegram'/);
  });

  it('TG_TRACKER_LOAD_FAIL invalid shape uses trackerCtx load_tracker hint path in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf("if (!data.messages || typeof data.messages !== 'object')"),
      src.indexOf('for (const [key, msg] of Object.entries(data.messages)'),
    );
    assert.match(block, /TG_TRACKER_LOAD_FAIL[\s\S]*trackerCtx\('load_tracker'/);
    assert.match(block, /hint: this\.persistPath/);
  });

  it('TG_TRACKER_LOAD_FAIL catch path uses normalizeError errno in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('} catch (err)'), src.indexOf('private saveToDisk'));
    assert.match(block, /TG_TRACKER_LOAD_FAIL[\s\S]*errno: norm\.errno/);
  });

  it('TG_TRACKER_SAVE_FAIL uses trackerCtx persist_tracker hint and errno in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private saveToDisk'), src.length);
    assert.match(block, /TG_TRACKER_SAVE_FAIL[\s\S]*trackerCtx\('persist_tracker'/);
    assert.match(block, /errno: norm\.errno/);
    assert.match(block, /hint: this\.persistPath/);
  });

  it('loadFromDisk returns early without log when file missing in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private loadFromDisk'), src.indexOf('private saveToDisk'));
    assert.match(block, /if \(!this\.persistPath \|\| !existsSync\(this\.persistPath\)\) return;/);
    const beforeTry = block.split('try {')[0] ?? '';
    assert.ok(!beforeTry.includes('logWarn('));
    assert.ok(!beforeTry.includes('logInfo('));
  });

  it('track pruneThread and scheduleSave emit no logs in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const trackBlock = src.slice(src.indexOf('track('), src.indexOf('private pruneThread'));
    assert.ok(!trackBlock.includes('logInfo('));
    assert.ok(!trackBlock.includes('logWarn('));
    const pruneBlock = src.slice(src.indexOf('private pruneThread'), src.indexOf('hasChanged'));
    assert.ok(!pruneBlock.includes('logInfo('));
    assert.ok(!pruneBlock.includes('logWarn('));
  });

  it('saveToDisk success path has no log sites in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private saveToDisk'), src.length);
    const successBlock = block.match(/writeFileSync\(this\.persistPath[\s\S]*?\} catch/)?.[0] ?? '';
    assert.ok(successBlock.length > 0);
    assert.ok(!successBlock.includes('logInfo('));
    assert.ok(!successBlock.includes('logWarn('));
  });

  it('SAVE_FAIL does not rethrow after log in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private saveToDisk'), src.length);
    assert.match(block, /TG_TRACKER_SAVE_FAIL[\s\S]*\}/);
    assert.ok(!block.slice(block.indexOf('TG_TRACKER_SAVE_FAIL')).includes('throw'));
  });

  it('scheduleSave returns early when persistPath is null in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private scheduleSave'), src.indexOf('flush():'));
    assert.match(block, /if \(!this\.persistPath\) return;/);
  });

  it('MAX_PER_THREAD cap is defined in source for pruneThread', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /const MAX_PER_THREAD = 300/);
    const block = src.slice(src.indexOf('private pruneThread'), src.indexOf('hasChanged'));
    assert.match(block, /if \(count <= MAX_PER_THREAD\) return;/);
  });

  it('exports TrackedMessage interface in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /export interface TrackedMessage/);
  });

  it('SAVE_DEBOUNCE_MS is 5000 in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /const SAVE_DEBOUNCE_MS = 5000/);
  });

  it('flush clears saveTimer when dirty in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('flush():'), src.indexOf('private loadFromDisk'));
    assert.match(block, /clearTimeout\(this\.saveTimer\)/);
    assert.match(block, /this\.saveTimer = null/);
  });

  it('scheduleSave skips new timer when saveTimer already set in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private scheduleSave'), src.indexOf('flush():'));
    assert.match(block, /if \(!this\.saveTimer\)/);
  });

  it('LOAD_FAIL paths do not rethrow in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private loadFromDisk'), src.indexOf('private saveToDisk'));
    assert.ok(!block.includes('throw'));
  });

  it('invalid shape load returns early without loading messages in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf("if (!data.messages || typeof data.messages !== 'object')"),
      src.indexOf('for (const [key, msg] of Object.entries(data.messages)'),
    );
    assert.match(block, /return;/);
    assert.ok(!block.includes('this.messages.set'));
  });

  it('clearAll invokes flush in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('clearAll():'), src.indexOf('static contentHash'));
    assert.match(block, /this\.flush\(\)/);
  });

  it('loadFromDisk skips selectorHashes when not object in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private loadFromDisk'), src.indexOf('private saveToDisk'));
    assert.match(block, /if \(data\.selectorHashes && typeof data\.selectorHashes === 'object'\)/);
  });

  it('makeKey uses threadId colon elementId format in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private makeKey'), src.indexOf('getTracked'));
    assert.match(block, /\$\{threadId\}:\$\{elementId\}/);
  });

  it('warn codes never use logInfo in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes("logInfo(\n          'TG_TRACKER_LOAD_FAIL'"));
    assert.ok(!src.includes("logInfo(\n        'TG_TRACKER_LOAD_FAIL'"));
    assert.ok(!src.includes("logInfo(\n        'TG_TRACKER_SAVE_FAIL'"));
  });

  it('saveToDisk returns early when persistPath is null in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private saveToDisk'), src.length);
    assert.match(block, /if \(!this\.persistPath\) return;/);
  });

  it('flush requires dirty flag and persistPath in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('flush():'), src.indexOf('private loadFromDisk'));
    assert.match(block, /if \(this\.dirty && this\.persistPath\)/);
  });

  it('hashSelector uses md5 digest substring 0 8 in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('hashSelector('), src.indexOf('resolveHash'));
    assert.match(block, /\.substring\(0, 8\)/);
  });

  it('contentHash static uses md5 digest substring 0 12 in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('static contentHash'), src.indexOf('hashSelector'));
    assert.match(block, /\.substring\(0, 12\)/);
  });

  it('track invokes pruneThread before scheduleSave in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('track('), src.indexOf('private pruneThread'));
    const idxPrune = block.indexOf('this.pruneThread');
    const idxSave = block.indexOf('this.scheduleSave');
    assert.ok(idxPrune >= 0 && idxSave >= 0 && idxPrune < idxSave);
  });

  it('loadFromDisk reads persist file as utf-8 in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/tracker.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private loadFromDisk'), src.indexOf('private saveToDisk'));
    assert.match(block, /readFileSync\(this\.persistPath, 'utf-8'\)/);
  });
});
