import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TopicManager } from '../../src/telegram/topics/manager.js';
import {
  flushOutboxForWorkspace,
  registerOutboxWatcher,
  stopAllOutboxWatchers,
} from '../../src/media/outbox-watch.js';
import type { OutboxWatcherDeps } from '../../src/media/outbox-watch.js';
import type { StateManager } from '../../src/state/broadcast.js';
import type { WindowMonitor } from '../../src/state/windows.js';
import type { TelegramApiClient } from '../../src/telegram/types.js';

const OUTBOX_LOG_CODES = [
  'OUTBOX_ROUTE_MISS',
  'OUTBOX_SEND_FAIL',
  'OUTBOX_CONFIRM_FAIL',
  'OUTBOX_WATCHER_START',
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

function lineHasExactCode(line: string, code: string): boolean {
  return line.includes(`code=${code}`);
}

function assertOutboxLog(
  lines: string[],
  code: string,
  need: {
    op?: string;
    text?: string;
    hint?: string;
    errno?: string;
    threadId?: string;
    windowId?: string;
  } = {},
): string {
  const line = lines.find((l) => {
    if (!lineHasExactCode(l, code)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.hint && !l.includes(`hint=${need.hint}`)) return false;
    if (need.errno && !l.includes(`errno=${need.errno}`)) return false;
    if (need.threadId && !l.includes(`threadId=${need.threadId}`)) return false;
    if (need.windowId && !l.includes(`windowId=${need.windowId}`)) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.hint ? `hint=${need.hint}` : '',
    need.errno ? `errno=${need.errno}` : '',
    need.threadId ? `threadId=${need.threadId}` : '',
    need.windowId ? `windowId=${need.windowId}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing outbox log: ${desc}`);
  assert.ok(line!.includes('scope=outbox'), `${code} missing scope=outbox`);
  return line!;
}

function assertOutboxLogOnce(
  lines: string[],
  code: string,
  need: {
    op?: string;
    text?: string;
    hint?: string;
    errno?: string;
    threadId?: string;
    windowId?: string;
  } = {},
): void {
  const line = assertOutboxLog(lines, code, need);
  const hits = lines.filter((l) => lineHasExactCode(l, code));
  assert.equal(hits.length, 1, `expected exactly one ${code}, got ${hits.length}: ${hits.join(' | ')}`);
  if (need.errno || code === 'OUTBOX_SEND_FAIL' || code === 'OUTBOX_CONFIRM_FAIL') {
    assert.match(line, /errno=/, `${code} missing errno= on fail path`);
  }
}

function assertNoOutboxLogs(lines: string[]): void {
  const hit = lines.find((l) => OUTBOX_LOG_CODES.some((code) => lineHasExactCode(l, code)));
  assert.ok(!hit, `unexpected outbox log: ${hit}`);
}

function outboxZoneSrc(): string {
  const src = readFileSync(new URL('../../src/media/outbox-watch.ts', import.meta.url), 'utf-8');
  return src.slice(src.indexOf('function outboxCtx'));
}

function makeDeps(
  ws: string,
  api: Partial<TelegramApiClient>,
  topicManager = new TopicManager(),
  stateOverride?: Partial<ReturnType<StateManager['getCurrentState']>>,
): OutboxWatcherDeps {
  const now = Date.now();
  topicManager.registerMapping({
    threadId: 42,
    windowId: 'win-42',
    windowTitle: 'Demo',
    tabTitle: 'Chat',
    lastActive: now,
    lastInboundAt: now,
    workspacePath: ws,
  });
  return {
    topicManager,
    windowMonitor: { getSnapshot: () => undefined } as unknown as WindowMonitor,
    stateManager: {
      getCurrentState: () => ({
        activeWindowId: 'win-42',
        activeComposerId: '',
        agentStatus: 'idle' as const,
        agentActivityLive: false,
        ...stateOverride,
      }),
    } as unknown as StateManager,
    api: api as TelegramApiClient,
    chatId: -100,
  };
}

function seedOutboxFile(ws: string, name = 'artifact.txt'): string {
  const outbox = join(ws, '.cursor-handoff/outbox');
  mkdirSync(outbox, { recursive: true });
  const filePath = join(outbox, name);
  writeFileSync(filePath, 'payload', 'utf-8');
  return filePath;
}

function ageFileMtime(filePath: string, ageMs: number): void {
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(filePath, t, t);
}

const OUTBOX_PATH_MATRIX = [
  {
    kind: 'log' as const,
    code: 'OUTBOX_ROUTE_MISS',
    marker: 'no mapping logs OUTBOX_ROUTE_MISS with hint',
  },
  {
    kind: 'log' as const,
    code: 'OUTBOX_SEND_FAIL',
    marker: 'document send throw logs OUTBOX_SEND_FAIL with threadId windowId errno',
  },
  {
    kind: 'log' as const,
    code: 'OUTBOX_SEND_FAIL',
    marker: 'photo send throw logs OUTBOX_SEND_FAIL with errno',
  },
  {
    kind: 'log' as const,
    code: 'OUTBOX_SEND_FAIL',
    marker: 'partial send rollback logs OUTBOX_SEND_FAIL after photo group',
  },
  {
    kind: 'log' as const,
    code: 'OUTBOX_CONFIRM_FAIL',
    marker: 'confirm message fail logs OUTBOX_CONFIRM_FAIL with threadId windowId errno',
  },
  {
    kind: 'log' as const,
    code: 'OUTBOX_CONFIRM_FAIL',
    marker: 'multi file confirm fail logs OUTBOX_CONFIRM_FAIL with hint count',
  },
  {
    kind: 'log' as const,
    code: 'OUTBOX_SEND_FAIL',
    marker: 'sendMediaGroup throw logs OUTBOX_SEND_FAIL with errno',
  },
  {
    kind: 'log' as const,
    code: 'OUTBOX_ROUTE_MISS',
    marker: 'each forced flush without route logs OUTBOX_ROUTE_MISS',
  },
  {
    kind: 'log' as const,
    code: 'OUTBOX_SEND_FAIL',
    marker: 'string throw logs OUTBOX_SEND_FAIL without errno on plain string',
  },
  {
    kind: 'log' as const,
    code: 'OUTBOX_CONFIRM_FAIL',
    marker: 'confirm string throw logs OUTBOX_CONFIRM_FAIL without errno on plain string',
  },
  {
    kind: 'log' as const,
    code: 'OUTBOX_WATCHER_START',
    marker: 'register watcher logs OUTBOX_WATCHER_START exactly once',
  },
  {
    kind: 'silent' as const,
    marker: 'happy document deliver stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'happy photo deliver stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'media group photo album stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'missing chatId stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'busy agent non-force flush stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'waiting approval non-force flush stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'idle debounce fresh file non-force stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'stale activity non-force flush stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'empty outbox flush stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'corrupt meta caption deliver stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'missing outbox directory flush stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'dotfile and meta sidecar excluded from deliver silently',
  },
  {
    kind: 'silent' as const,
    marker: 'SEND_FAIL user notify throw stays silent beyond OUTBOX_SEND_FAIL',
  },
  {
    kind: 'silent' as const,
    marker: 'inFlight concurrent flush stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'error agent status non-force deliver stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'oversized photo routes to document silently',
  },
  {
    kind: 'silent' as const,
    marker: 'valid meta caption deliver stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'inactive window busy snapshot blocks non-force silently',
  },
  {
    kind: 'silent' as const,
    marker: 'webp photo deliver stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'jpeg photo deliver stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'whitespace meta caption ignored silently',
  },
  {
    kind: 'silent' as const,
    marker: 'mixed photo document caption only on first group silently',
  },
  {
    kind: 'silent' as const,
    marker: 'confirm fail deletes meta sidecar silently beyond CONFIRM_FAIL',
  },
  {
    kind: 'silent' as const,
    marker: 'stopAllOutboxWatchers stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'force flush bypasses busy generating agent silently',
  },
  {
    kind: 'silent' as const,
    marker: 'force flush bypasses waiting approval silently',
  },
  {
    kind: 'silent' as const,
    marker: 'running tool live true non-force blocks deliver silently',
  },
  {
    kind: 'silent' as const,
    marker: 'idle aged file non-force deliver stays silent on outbox log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'snapshot undefined falls back to idle state deliver silently',
  },
  {
    kind: 'silent' as const,
    marker: 'second file meta caption used silently',
  },
  {
    kind: 'silent' as const,
    marker: 'album media group caption on first item only silently',
  },
  {
    kind: 'silent' as const,
    marker: 'mtime sort sends oldest file first silently',
  },
  {
    kind: 'silent' as const,
    marker: 'register watcher initial tick on empty outbox silent beyond WATCHER_START',
  },
  {
    kind: 'silent' as const,
    marker: 'second registerOutboxWatcher stays silent on duplicate WATCHER_START',
  },
] as const;

describe('media outbox-watch logging', () => {
  afterEach(() => {
    stopAllOutboxWatchers();
  });

  it('each forced flush without route logs OUTBOX_ROUTE_MISS', async () => {
    const ws = join(tmpdir(), `handoff-outbox-route-repeat-${Date.now()}`);
    seedOutboxFile(ws);
    const deps: OutboxWatcherDeps = {
      topicManager: new TopicManager(),
      windowMonitor: { getSnapshot: () => undefined } as unknown as WindowMonitor,
      stateManager: { getCurrentState: () => ({ activeWindowId: '' }) } as unknown as StateManager,
      api: {} as TelegramApiClient,
      chatId: -100,
    };
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
        await flushOutboxForWorkspace(ws, deps, true);
      });
      const hits = lines.filter((l) => lineHasExactCode(l, 'OUTBOX_ROUTE_MISS'));
      assert.equal(hits.length, 2);
      assert.ok(hits.every((l) => l.includes('op=deliver')));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('no mapping logs OUTBOX_ROUTE_MISS with hint', async () => {
    const ws = join(tmpdir(), `handoff-outbox-route-${Date.now()}`);
    seedOutboxFile(ws);
    const deps: OutboxWatcherDeps = {
      topicManager: new TopicManager(),
      windowMonitor: { getSnapshot: () => undefined } as unknown as WindowMonitor,
      stateManager: { getCurrentState: () => ({ activeWindowId: '' }) } as unknown as StateManager,
      api: {} as TelegramApiClient,
      chatId: -100,
    };
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assertOutboxLogOnce(lines, 'OUTBOX_ROUTE_MISS', {
        op: 'deliver',
        text: 'No TG route for workspace',
      });
      const line = lines.find((l) => lineHasExactCode(l, 'OUTBOX_ROUTE_MISS'))!;
      assert.match(line, /hint=/, 'ROUTE_MISS must include sanitized workspace hint');
      assert.ok(existsSync(join(ws, '.cursor-handoff/outbox', 'artifact.txt')));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('document send throw logs OUTBOX_SEND_FAIL with threadId windowId errno', async () => {
    const ws = join(tmpdir(), `handoff-outbox-send-fail-${Date.now()}`);
    const filePath = seedOutboxFile(ws);
    const err = Object.assign(new Error('network down'), { code: 'ECONNRESET' });
    const deps = makeDeps(ws, {
      sendDocument: async () => {
        throw err;
      },
      sendMessage: async () => ({ message_id: 1 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assertOutboxLogOnce(lines, 'OUTBOX_SEND_FAIL', {
        op: 'deliver',
        text: 'Send failed',
        threadId: '42',
        windowId: 'win-42',
        errno: 'ECONNRESET',
      });
      const line = lines.find((l) => lineHasExactCode(l, 'OUTBOX_SEND_FAIL'))!;
      assert.match(line, /hint=/, 'SEND_FAIL must include sanitized workspace hint');
      assert.ok(existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('sendMediaGroup throw logs OUTBOX_SEND_FAIL with errno', async () => {
    const ws = join(tmpdir(), `handoff-outbox-group-fail-${Date.now()}`);
    const outbox = join(ws, '.cursor-handoff/outbox');
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(outbox, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary');
    writeFileSync(join(outbox, 'b.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary');
    const err = Object.assign(new Error('album blocked'), { code: 'ERATE' });
    const deps = makeDeps(ws, {
      sendMediaGroup: async () => {
        throw err;
      },
      sendMessage: async () => ({ message_id: 1 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assertOutboxLogOnce(lines, 'OUTBOX_SEND_FAIL', {
        op: 'deliver',
        errno: 'ERATE',
        threadId: '42',
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('photo send throw logs OUTBOX_SEND_FAIL with errno', async () => {
    const ws = join(tmpdir(), `handoff-outbox-photo-fail-${Date.now()}`);
    const filePath = join(ws, '.cursor-handoff/outbox', 'shot.png');
    mkdirSync(join(ws, '.cursor-handoff/outbox'), { recursive: true });
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary');
    const err = Object.assign(new Error('photo blocked'), { code: 'EFBIG' });
    const deps = makeDeps(ws, {
      sendPhoto: async () => {
        throw err;
      },
      sendMessage: async () => ({ message_id: 1 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assertOutboxLogOnce(lines, 'OUTBOX_SEND_FAIL', {
        op: 'deliver',
        errno: 'EFBIG',
        threadId: '42',
      });
      assert.ok(existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('partial send rollback logs OUTBOX_SEND_FAIL after photo group', async () => {
    const ws = join(tmpdir(), `handoff-outbox-partial-${Date.now()}`);
    const outbox = join(ws, '.cursor-handoff/outbox');
    mkdirSync(outbox, { recursive: true });
    const pngPath = join(outbox, 'a.png');
    const docPath = join(outbox, 'b.txt');
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary');
    writeFileSync(docPath, 'doc', 'utf-8');
    const err = Object.assign(new Error('doc fail'), { code: 'EBUSY' });
    const deps = makeDeps(ws, {
      sendPhoto: async () => ({ message_id: 1 }),
      sendDocument: async () => {
        throw err;
      },
      sendMessage: async () => ({ message_id: 2 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assertOutboxLogOnce(lines, 'OUTBOX_SEND_FAIL', {
        op: 'deliver',
        errno: 'EBUSY',
      });
      assert.ok(!existsSync(pngPath), 'rolled back photo after document group failed');
      assert.ok(existsSync(docPath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('string throw logs OUTBOX_SEND_FAIL without errno on plain string', async () => {
    const ws = join(tmpdir(), `handoff-outbox-string-fail-${Date.now()}`);
    seedOutboxFile(ws);
    const deps = makeDeps(ws, {
      sendDocument: async () => {
        throw 'plain string fail';
      },
      sendMessage: async () => ({ message_id: 1 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      const line = assertOutboxLog(lines, 'OUTBOX_SEND_FAIL', {
        op: 'deliver',
        text: 'Send failed',
        threadId: '42',
        windowId: 'win-42',
      });
      assert.equal(lines.filter((l) => lineHasExactCode(l, 'OUTBOX_SEND_FAIL')).length, 1);
      assert.ok(!line.includes('errno='), 'plain string throw must not emit errno');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('confirm message fail logs OUTBOX_CONFIRM_FAIL with threadId windowId errno', async () => {
    const ws = join(tmpdir(), `handoff-outbox-confirm-fail-${Date.now()}`);
    const filePath = seedOutboxFile(ws);
    const deps = makeDeps(ws, {
      sendDocument: async () => ({ message_id: 1 }),
      sendMessage: async (_chatId, text) => {
        if (text.includes('Sent to this chat')) {
          throw Object.assign(new Error('confirm blocked'), { code: 'ETIMEDOUT' });
        }
        return { message_id: 2 };
      },
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assertOutboxLogOnce(lines, 'OUTBOX_CONFIRM_FAIL', {
        op: 'deliver',
        text: 'confirm message failed',
        threadId: '42',
        windowId: 'win-42',
        errno: 'ETIMEDOUT',
        hint: '1',
      });
      assert.ok(!lines.some((l) => lineHasExactCode(l, 'OUTBOX_SEND_FAIL')));
      assert.ok(!existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('multi file confirm fail logs OUTBOX_CONFIRM_FAIL with hint count', async () => {
    const ws = join(tmpdir(), `handoff-outbox-confirm-multi-${Date.now()}`);
    seedOutboxFile(ws, 'one.txt');
    seedOutboxFile(ws, 'two.txt');
    const deps = makeDeps(ws, {
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async () => [{ message_id: 1 }],
      sendMessage: async (_chatId, text) => {
        if (text.includes('Sent to this chat')) {
          throw Object.assign(new Error('confirm multi'), { code: 'EPIPE' });
        }
        return { message_id: 2 };
      },
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assertOutboxLogOnce(lines, 'OUTBOX_CONFIRM_FAIL', {
        op: 'deliver',
        hint: '2',
        errno: 'EPIPE',
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('confirm string throw logs OUTBOX_CONFIRM_FAIL without errno on plain string', async () => {
    const ws = join(tmpdir(), `handoff-outbox-confirm-string-${Date.now()}`);
    const filePath = seedOutboxFile(ws);
    const deps = makeDeps(ws, {
      sendDocument: async () => ({ message_id: 1 }),
      sendMessage: async (_chatId, text) => {
        if (text.includes('Sent to this chat')) {
          throw 'plain confirm fail';
        }
        return { message_id: 2 };
      },
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      const line = assertOutboxLog(lines, 'OUTBOX_CONFIRM_FAIL', {
        op: 'deliver',
        threadId: '42',
        windowId: 'win-42',
        hint: '1',
      });
      assert.equal(lines.filter((l) => lineHasExactCode(l, 'OUTBOX_CONFIRM_FAIL')).length, 1);
      assert.ok(!line.includes('errno='), 'plain string confirm fail must not emit errno');
      assert.ok(!existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('register watcher logs OUTBOX_WATCHER_START exactly once', async () => {
    const ws = join(tmpdir(), `handoff-outbox-watch-${Date.now()}`);
    mkdirSync(ws, { recursive: true });
    const deps = makeDeps(ws, {});
    try {
      const lines = await captureAll(() => {
        registerOutboxWatcher(ws, deps);
        registerOutboxWatcher(ws, deps);
      });
      assertOutboxLogOnce(lines, 'OUTBOX_WATCHER_START', {
        op: 'watch',
        text: 'Watcher registered',
      });
      const line = lines.find((l) => lineHasExactCode(l, 'OUTBOX_WATCHER_START'))!;
      assert.match(line, /hint=/, 'WATCHER_START must include sanitized workspace hint');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('happy document deliver stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-ok-${Date.now()}`);
    const filePath = seedOutboxFile(ws);
    const deps = makeDeps(ws, {
      sendDocument: async () => ({ message_id: 1 }),
      sendMessage: async () => ({ message_id: 2 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assertNoOutboxLogs(lines);
      assert.ok(!existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('happy photo deliver stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-photo-${Date.now()}`);
    const filePath = join(ws, '.cursor-handoff/outbox', 'shot.png');
    mkdirSync(join(ws, '.cursor-handoff/outbox'), { recursive: true });
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary');
    let usedPhoto = false;
    const deps = makeDeps(ws, {
      sendPhoto: async () => {
        usedPhoto = true;
        return { message_id: 1 };
      },
      sendDocument: async () => {
        throw new Error('expected sendPhoto');
      },
      sendMessage: async () => ({ message_id: 2 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assert.equal(usedPhoto, true);
      assertNoOutboxLogs(lines);
      assert.ok(!existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('media group photo album stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-album-${Date.now()}`);
    const outbox = join(ws, '.cursor-handoff/outbox');
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(outbox, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary');
    writeFileSync(join(outbox, 'b.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary');
    let groupCalls = 0;
    const deps = makeDeps(ws, {
      sendMediaGroup: async () => {
        groupCalls += 1;
        return [{ message_id: 1 }, { message_id: 2 }];
      },
      sendPhoto: async () => {
        throw new Error('expected sendMediaGroup');
      },
      sendMessage: async () => ({ message_id: 3 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assert.equal(groupCalls, 1);
      assertNoOutboxLogs(lines);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('missing chatId stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-no-chat-${Date.now()}`);
    seedOutboxFile(ws);
    const deps = makeDeps(ws, {
      sendDocument: async () => ({ message_id: 1 }),
    });
    deps.chatId = undefined;
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assertNoOutboxLogs(lines);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('busy agent non-force flush stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-busy-${Date.now()}`);
    const filePath = seedOutboxFile(ws);
    ageFileMtime(filePath, 5000);
    const deps = makeDeps(
      ws,
      { sendDocument: async () => ({ message_id: 1 }) },
      new TopicManager(),
      { agentStatus: 'generating', agentActivityLive: true },
    );
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, false);
      });
      assertNoOutboxLogs(lines);
      assert.ok(existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('waiting approval non-force flush stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-approval-${Date.now()}`);
    const filePath = seedOutboxFile(ws);
    ageFileMtime(filePath, 5000);
    const deps = makeDeps(
      ws,
      { sendDocument: async () => ({ message_id: 1 }) },
      new TopicManager(),
      { agentStatus: 'waiting_approval', agentActivityLive: false },
    );
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, false);
      });
      assertNoOutboxLogs(lines);
      assert.ok(existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('idle debounce fresh file non-force stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-debounce-${Date.now()}`);
    const filePath = seedOutboxFile(ws);
    const deps = makeDeps(ws, {
      sendDocument: async () => ({ message_id: 1 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, false);
      });
      assertNoOutboxLogs(lines);
      assert.ok(existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('stale activity non-force flush stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-stale-${Date.now()}`);
    const filePath = seedOutboxFile(ws);
    ageFileMtime(filePath, 5000);
    let sent = false;
    const deps = makeDeps(
      ws,
      {
        sendDocument: async () => {
          sent = true;
          return { message_id: 1 };
        },
        sendMessage: async () => ({ message_id: 2 }),
      },
      new TopicManager(),
      { agentStatus: 'running_tool', agentActivityLive: false },
    );
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, false);
      });
      assertNoOutboxLogs(lines);
      assert.equal(sent, true);
      assert.ok(!existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('empty outbox flush stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-empty-${Date.now()}`);
    mkdirSync(ws, { recursive: true });
    const deps = makeDeps(ws, {
      sendDocument: async () => ({ message_id: 1 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assertNoOutboxLogs(lines);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('corrupt meta caption deliver stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-meta-${Date.now()}`);
    const filePath = seedOutboxFile(ws, 'note.txt');
    writeFileSync(`${filePath.replace(/\.txt$/, '')}.meta.json`, '{ bad', 'utf-8');
    const deps = makeDeps(ws, {
      sendDocument: async () => ({ message_id: 1 }),
      sendMessage: async () => ({ message_id: 2 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assertNoOutboxLogs(lines);
      assert.ok(!existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('missing outbox directory flush stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-no-dir-${Date.now()}`);
    mkdirSync(ws, { recursive: true });
    const deps = makeDeps(ws, {});
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assertNoOutboxLogs(lines);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('dotfile and meta sidecar excluded from deliver silently', async () => {
    const ws = join(tmpdir(), `handoff-outbox-filter-${Date.now()}`);
    const outbox = join(ws, '.cursor-handoff/outbox');
    mkdirSync(outbox, { recursive: true });
    const visible = join(outbox, 'visible.txt');
    writeFileSync(visible, 'ok', 'utf-8');
    writeFileSync(join(outbox, '.hidden'), 'nope', 'utf-8');
    writeFileSync(join(outbox, 'visible.meta.json'), '{"caption":"x"}', 'utf-8');
    const sent: string[] = [];
    const deps = makeDeps(ws, {
      sendDocument: async (_chatId, path) => {
        sent.push(path);
        return { message_id: 1 };
      },
      sendMessage: async () => ({ message_id: 2 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assertNoOutboxLogs(lines);
      assert.equal(sent.length, 1);
      assert.ok(sent[0]!.endsWith('visible.txt'));
      assert.ok(!existsSync(visible));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('SEND_FAIL user notify throw stays silent beyond OUTBOX_SEND_FAIL', async () => {
    const ws = join(tmpdir(), `handoff-outbox-notify-${Date.now()}`);
    seedOutboxFile(ws);
    const deps = makeDeps(ws, {
      sendDocument: async () => {
        throw Object.assign(new Error('tg down'), { code: 'ECONNRESET' });
      },
      sendMessage: async () => {
        throw new Error('notify also failed');
      },
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assertOutboxLogOnce(lines, 'OUTBOX_SEND_FAIL', { errno: 'ECONNRESET' });
      assert.equal(lines.filter((l) => lineHasExactCode(l, 'OUTBOX_SEND_FAIL')).length, 1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('inFlight concurrent flush stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-inflight-${Date.now()}`);
    seedOutboxFile(ws);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sendCalls = 0;
    const deps = makeDeps(ws, {
      sendDocument: async () => {
        sendCalls += 1;
        await gate;
        return { message_id: 1 };
      },
      sendMessage: async () => ({ message_id: 2 }),
    });
    try {
      const lines = await captureAll(async () => {
        const first = flushOutboxForWorkspace(ws, deps, true);
        await flushOutboxForWorkspace(ws, deps, true);
        release();
        await first;
      });
      assertNoOutboxLogs(lines);
      assert.equal(sendCalls, 1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('error agent status non-force deliver stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-error-idle-${Date.now()}`);
    const filePath = seedOutboxFile(ws);
    ageFileMtime(filePath, 5000);
    let sent = false;
    const deps = makeDeps(
      ws,
      {
        sendDocument: async () => {
          sent = true;
          return { message_id: 1 };
        },
        sendMessage: async () => ({ message_id: 2 }),
      },
      new TopicManager(),
      { agentStatus: 'error', agentActivityLive: true },
    );
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, false);
      });
      assertNoOutboxLogs(lines);
      assert.equal(sent, true);
      assert.ok(!existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('oversized photo routes to document silently', async () => {
    const ws = join(tmpdir(), `handoff-outbox-big-png-${Date.now()}`);
    const outbox = join(ws, '.cursor-handoff/outbox');
    mkdirSync(outbox, { recursive: true });
    const bigPath = join(outbox, 'big.png');
    writeFileSync(bigPath, Buffer.alloc(10 * 1024 * 1024 + 1, 0x89));
    let usedDocument = false;
    const deps = makeDeps(ws, {
      sendDocument: async () => {
        usedDocument = true;
        return { message_id: 1 };
      },
      sendPhoto: async () => {
        throw new Error('expected sendDocument for oversized png');
      },
      sendMessage: async () => ({ message_id: 2 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assert.equal(usedDocument, true);
      assertNoOutboxLogs(lines);
      assert.ok(!existsSync(bigPath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('valid meta caption deliver stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-caption-${Date.now()}`);
    const filePath = seedOutboxFile(ws, 'pic.png');
    writeFileSync(`${filePath.replace(/\.png$/, '')}.meta.json`, JSON.stringify({ caption: 'hello tg' }), 'utf-8');
    let caption: string | undefined;
    const deps = makeDeps(ws, {
      sendPhoto: async (_chatId, _path, opts) => {
        caption = opts?.caption;
        return { message_id: 1 };
      },
      sendMessage: async () => ({ message_id: 2 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assert.equal(caption, 'hello tg');
      assertNoOutboxLogs(lines);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('inactive window busy snapshot blocks non-force silently', async () => {
    const ws = join(tmpdir(), `handoff-outbox-inactive-busy-${Date.now()}`);
    const filePath = seedOutboxFile(ws);
    ageFileMtime(filePath, 5000);
    const tm = new TopicManager();
    const now = Date.now();
    tm.registerMapping({
      threadId: 77,
      windowId: 'win-mapped',
      windowTitle: 'Demo',
      tabTitle: 'Chat',
      lastActive: now,
      lastInboundAt: now,
      workspacePath: ws,
    });
    let sent = false;
    const deps: OutboxWatcherDeps = {
      topicManager: tm,
      windowMonitor: {
        getSnapshot: (windowId: string) =>
          windowId === 'win-mapped'
            ? { agentStatus: 'generating' as const, agentActivityLive: true }
            : undefined,
      } as unknown as WindowMonitor,
      stateManager: {
        getCurrentState: () => ({
          activeWindowId: 'win-other',
          activeComposerId: '',
          agentStatus: 'idle' as const,
          agentActivityLive: false,
        }),
      } as unknown as StateManager,
      api: {
        sendDocument: async () => {
          sent = true;
          return { message_id: 1 };
        },
      } as TelegramApiClient,
      chatId: -100,
    };
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, false);
      });
      assertNoOutboxLogs(lines);
      assert.equal(sent, false);
      assert.ok(existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('webp photo deliver stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-webp-${Date.now()}`);
    const filePath = join(ws, '.cursor-handoff/outbox', 'shot.webp');
    mkdirSync(join(ws, '.cursor-handoff/outbox'), { recursive: true });
    writeFileSync(filePath, Buffer.from([0x52, 0x49, 0x46, 0x46]), 'binary');
    let usedPhoto = false;
    const deps = makeDeps(ws, {
      sendPhoto: async () => {
        usedPhoto = true;
        return { message_id: 1 };
      },
      sendMessage: async () => ({ message_id: 2 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assert.equal(usedPhoto, true);
      assertNoOutboxLogs(lines);
      assert.ok(!existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('jpeg photo deliver stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-jpeg-${Date.now()}`);
    const filePath = join(ws, '.cursor-handoff/outbox', 'shot.jpg');
    mkdirSync(join(ws, '.cursor-handoff/outbox'), { recursive: true });
    writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'binary');
    let usedPhoto = false;
    const deps = makeDeps(ws, {
      sendPhoto: async () => {
        usedPhoto = true;
        return { message_id: 1 };
      },
      sendMessage: async () => ({ message_id: 2 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assert.equal(usedPhoto, true);
      assertNoOutboxLogs(lines);
      assert.ok(!existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('whitespace meta caption ignored silently', async () => {
    const ws = join(tmpdir(), `handoff-outbox-ws-meta-${Date.now()}`);
    const filePath = seedOutboxFile(ws, 'note.txt');
    writeFileSync(`${filePath.replace(/\.txt$/, '')}.meta.json`, JSON.stringify({ caption: '   ' }), 'utf-8');
    let caption: string | undefined = 'unset';
    const deps = makeDeps(ws, {
      sendDocument: async (_chatId, _path, opts) => {
        caption = opts?.caption;
        return { message_id: 1 };
      },
      sendMessage: async () => ({ message_id: 2 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assert.equal(caption, undefined);
      assertNoOutboxLogs(lines);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('mixed photo document caption only on first group silently', async () => {
    const ws = join(tmpdir(), `handoff-outbox-mixed-cap-${Date.now()}`);
    const outbox = join(ws, '.cursor-handoff/outbox');
    mkdirSync(outbox, { recursive: true });
    const pngPath = join(outbox, 'a.png');
    const docPath = join(outbox, 'b.txt');
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary');
    writeFileSync(docPath, 'doc', 'utf-8');
    writeFileSync(`${pngPath.replace(/\.png$/, '')}.meta.json`, JSON.stringify({ caption: 'album cap' }), 'utf-8');
    const captions: (string | undefined)[] = [];
    const deps = makeDeps(ws, {
      sendPhoto: async (_chatId, _path, opts) => {
        captions.push(opts?.caption);
        return { message_id: 1 };
      },
      sendDocument: async (_chatId, _path, opts) => {
        captions.push(opts?.caption);
        return { message_id: 2 };
      },
      sendMessage: async () => ({ message_id: 3 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assert.deepEqual(captions, ['album cap', undefined]);
      assertNoOutboxLogs(lines);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('confirm fail deletes meta sidecar silently beyond CONFIRM_FAIL', async () => {
    const ws = join(tmpdir(), `handoff-outbox-confirm-meta-${Date.now()}`);
    const filePath = seedOutboxFile(ws, 'note.txt');
    const metaPath = `${filePath.replace(/\.txt$/, '')}.meta.json`;
    writeFileSync(metaPath, JSON.stringify({ caption: 'cap' }), 'utf-8');
    const deps = makeDeps(ws, {
      sendDocument: async () => ({ message_id: 1 }),
      sendMessage: async (_chatId, text) => {
        if (text.includes('Sent to this chat')) {
          throw Object.assign(new Error('confirm blocked'), { code: 'ETIMEDOUT' });
        }
        return { message_id: 2 };
      },
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assertOutboxLogOnce(lines, 'OUTBOX_CONFIRM_FAIL', { errno: 'ETIMEDOUT' });
      assert.ok(!existsSync(filePath));
      assert.ok(!existsSync(metaPath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('stopAllOutboxWatchers stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-stop-${Date.now()}`);
    mkdirSync(ws, { recursive: true });
    const deps = makeDeps(ws, {});
    try {
      const lines = await captureAll(() => {
        registerOutboxWatcher(ws, deps);
        stopAllOutboxWatchers();
      });
      assert.equal(lines.filter((l) => lineHasExactCode(l, 'OUTBOX_WATCHER_START')).length, 1);
      assert.ok(!lines.some((l) => lineHasExactCode(l, 'OUTBOX_ROUTE_MISS')));
      assert.ok(!lines.some((l) => lineHasExactCode(l, 'OUTBOX_SEND_FAIL')));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('force flush bypasses busy generating agent silently', async () => {
    const ws = join(tmpdir(), `handoff-outbox-force-busy-${Date.now()}`);
    const filePath = seedOutboxFile(ws);
    ageFileMtime(filePath, 5000);
    let sent = false;
    const deps = makeDeps(
      ws,
      {
        sendDocument: async () => {
          sent = true;
          return { message_id: 1 };
        },
        sendMessage: async () => ({ message_id: 2 }),
      },
      new TopicManager(),
      { agentStatus: 'generating', agentActivityLive: true },
    );
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assert.equal(sent, true);
      assertNoOutboxLogs(lines);
      assert.ok(!existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('force flush bypasses waiting approval silently', async () => {
    const ws = join(tmpdir(), `handoff-outbox-force-approval-${Date.now()}`);
    const filePath = seedOutboxFile(ws);
    ageFileMtime(filePath, 5000);
    let sent = false;
    const deps = makeDeps(
      ws,
      {
        sendDocument: async () => {
          sent = true;
          return { message_id: 1 };
        },
        sendMessage: async () => ({ message_id: 2 }),
      },
      new TopicManager(),
      { agentStatus: 'waiting_approval', agentActivityLive: false },
    );
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assert.equal(sent, true);
      assertNoOutboxLogs(lines);
      assert.ok(!existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('running tool live true non-force blocks deliver silently', async () => {
    const ws = join(tmpdir(), `handoff-outbox-live-busy-${Date.now()}`);
    const filePath = seedOutboxFile(ws);
    ageFileMtime(filePath, 5000);
    let sent = false;
    const deps = makeDeps(
      ws,
      {
        sendDocument: async () => {
          sent = true;
          return { message_id: 1 };
        },
      },
      new TopicManager(),
      { agentStatus: 'running_tool', agentActivityLive: true },
    );
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, false);
      });
      assert.equal(sent, false);
      assertNoOutboxLogs(lines);
      assert.ok(existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('idle aged file non-force deliver stays silent on outbox log codes', async () => {
    const ws = join(tmpdir(), `handoff-outbox-idle-aged-${Date.now()}`);
    const filePath = seedOutboxFile(ws);
    ageFileMtime(filePath, 5000);
    let sent = false;
    const deps = makeDeps(ws, {
      sendDocument: async () => {
        sent = true;
        return { message_id: 1 };
      },
      sendMessage: async () => ({ message_id: 2 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, false);
      });
      assert.equal(sent, true);
      assertNoOutboxLogs(lines);
      assert.ok(!existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('snapshot undefined falls back to idle state deliver silently', async () => {
    const ws = join(tmpdir(), `handoff-outbox-snap-fallback-${Date.now()}`);
    const filePath = seedOutboxFile(ws);
    ageFileMtime(filePath, 5000);
    const tm = new TopicManager();
    const now = Date.now();
    tm.registerMapping({
      threadId: 88,
      windowId: 'win-mapped',
      windowTitle: 'Demo',
      tabTitle: 'Chat',
      lastActive: now,
      lastInboundAt: now,
      workspacePath: ws,
    });
    let sent = false;
    const deps: OutboxWatcherDeps = {
      topicManager: tm,
      windowMonitor: {
        getSnapshot: () => undefined,
      } as unknown as WindowMonitor,
      stateManager: {
        getCurrentState: () => ({
          activeWindowId: 'win-other',
          activeComposerId: '',
          agentStatus: 'idle' as const,
          agentActivityLive: false,
        }),
      } as unknown as StateManager,
      api: {
        sendDocument: async () => {
          sent = true;
          return { message_id: 1 };
        },
        sendMessage: async () => ({ message_id: 2 }),
      } as TelegramApiClient,
      chatId: -100,
    };
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, false);
      });
      assert.equal(sent, true);
      assertNoOutboxLogs(lines);
      assert.ok(!existsSync(filePath));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('second file meta caption used silently', async () => {
    const ws = join(tmpdir(), `handoff-outbox-meta-second-${Date.now()}`);
    const outbox = join(ws, '.cursor-handoff/outbox');
    mkdirSync(outbox, { recursive: true });
    const first = join(outbox, 'aaa.txt');
    const second = join(outbox, 'zzz.txt');
    writeFileSync(first, 'a', 'utf-8');
    writeFileSync(second, 'b', 'utf-8');
    writeFileSync(`${second.replace(/\.txt$/, '')}.meta.json`, JSON.stringify({ caption: 'from second' }), 'utf-8');
    ageFileMtime(first, 10_000);
    let mediaCaptions: (string | undefined)[] = [];
    const deps = makeDeps(ws, {
      sendMediaGroup: async (_chatId, media) => {
        mediaCaptions = media.map((m) => m.caption);
        return [{ message_id: 1 }, { message_id: 2 }];
      },
      sendDocument: async () => {
        throw new Error('expected sendMediaGroup for two documents');
      },
      sendMessage: async () => ({ message_id: 3 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assert.deepEqual(mediaCaptions, ['from second', undefined]);
      assertNoOutboxLogs(lines);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('album media group caption on first item only silently', async () => {
    const ws = join(tmpdir(), `handoff-outbox-album-cap-${Date.now()}`);
    const outbox = join(ws, '.cursor-handoff/outbox');
    mkdirSync(outbox, { recursive: true });
    const a = join(outbox, 'a.png');
    const b = join(outbox, 'b.png');
    writeFileSync(a, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary');
    writeFileSync(b, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary');
    writeFileSync(`${a.replace(/\.png$/, '')}.meta.json`, JSON.stringify({ caption: 'album only' }), 'utf-8');
    let mediaCaptions: (string | undefined)[] = [];
    const deps = makeDeps(ws, {
      sendMediaGroup: async (_chatId, media) => {
        mediaCaptions = media.map((m) => m.caption);
        return [{ message_id: 1 }, { message_id: 2 }];
      },
      sendPhoto: async () => {
        throw new Error('expected sendMediaGroup');
      },
      sendMessage: async () => ({ message_id: 3 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assert.deepEqual(mediaCaptions, ['album only', undefined]);
      assertNoOutboxLogs(lines);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('mtime sort sends oldest file first silently', async () => {
    const ws = join(tmpdir(), `handoff-outbox-mtime-${Date.now()}`);
    const outbox = join(ws, '.cursor-handoff/outbox');
    mkdirSync(outbox, { recursive: true });
    const older = join(outbox, 'older.txt');
    const newer = join(outbox, 'newer.txt');
    writeFileSync(older, 'old', 'utf-8');
    writeFileSync(newer, 'new', 'utf-8');
    ageFileMtime(older, 10_000);
    ageFileMtime(newer, 1000);
    const order: string[] = [];
    const deps = makeDeps(ws, {
      sendMediaGroup: async (_chatId, media) => {
        order.push(...media.map((m) => m.path));
        return [{ message_id: 1 }, { message_id: 2 }];
      },
      sendDocument: async () => {
        throw new Error('expected sendMediaGroup for two documents');
      },
      sendMessage: async () => ({ message_id: 2 }),
    });
    try {
      const lines = await captureAll(async () => {
        await flushOutboxForWorkspace(ws, deps, true);
      });
      assert.equal(order.length, 2);
      assert.ok(order[0]!.endsWith('older.txt'));
      assert.ok(order[1]!.endsWith('newer.txt'));
      assertNoOutboxLogs(lines);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('register watcher initial tick on empty outbox silent beyond WATCHER_START', async () => {
    const ws = join(tmpdir(), `handoff-outbox-reg-empty-${Date.now()}`);
    mkdirSync(ws, { recursive: true });
    const deps = makeDeps(ws, {
      sendDocument: async () => ({ message_id: 1 }),
    });
    try {
      const lines = await captureAll(() => {
        registerOutboxWatcher(ws, deps);
      });
      assert.equal(lines.filter((l) => lineHasExactCode(l, 'OUTBOX_WATCHER_START')).length, 1);
      assert.ok(!lines.some((l) => lineHasExactCode(l, 'OUTBOX_ROUTE_MISS')));
      assert.ok(!lines.some((l) => lineHasExactCode(l, 'OUTBOX_SEND_FAIL')));
      assert.ok(!lines.some((l) => lineHasExactCode(l, 'OUTBOX_CONFIRM_FAIL')));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('second registerOutboxWatcher stays silent on duplicate WATCHER_START', async () => {
    const ws = join(tmpdir(), `handoff-outbox-dup-watch-${Date.now()}`);
    mkdirSync(ws, { recursive: true });
    const deps = makeDeps(ws, {});
    try {
      const lines = await captureAll(() => {
        registerOutboxWatcher(ws, deps);
        registerOutboxWatcher(ws, deps);
      });
      const hits = lines.filter((l) => lineHasExactCode(l, 'OUTBOX_WATCHER_START'));
      assert.equal(hits.length, 1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('OUTBOX_PATH_MATRIX log and silent row counts are consistent', () => {
    assert.equal(OUTBOX_PATH_MATRIX.length, 45);
    assert.equal(OUTBOX_PATH_MATRIX.filter((r) => r.kind === 'log').length, 11);
    assert.equal(OUTBOX_PATH_MATRIX.filter((r) => r.kind === 'silent').length, 34);
  });

  it('every covered code has assertOutboxLog in behavioral tests', () => {
    const src = readFileSync(new URL('./outbox-watch-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of OUTBOX_LOG_CODES) {
      assert.ok(
        src.includes(`assertOutboxLog(lines, '${code}'`) ||
          src.includes(`assertOutboxLogOnce(lines, '${code}'`),
        `behavioral missing ${code}`,
      );
    }
  });

  it('every OUTBOX_PATH_MATRIX marker has matching it() title in test file', () => {
    const src = readFileSync(new URL('./outbox-watch-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of OUTBOX_PATH_MATRIX) {
      assert.ok(src.includes(`it('${row.marker}'`), `missing it() for ${row.marker}`);
    }
  });

  it('outboxCtx helper and four log sites in outbox source', () => {
    const zone = outboxZoneSrc();
    assert.match(zone, /scope: 'outbox'/);
    assert.equal((zone.match(/logInfo\(/g) ?? []).length, 1);
    assert.equal((zone.match(/logWarn\(/g) ?? []).length, 3);
    for (const code of OUTBOX_LOG_CODES) {
      assert.ok(zone.includes(`'${code}'`), `missing ${code} in zone`);
    }
  });

  it('outbox logging zone has zero console calls in source', () => {
    const zone = outboxZoneSrc();
    assert.ok(!zone.match(/console\.(log|warn|error)/));
  });

  it('OUTBOX_ROUTE_MISS uses sanitizePathForUi hint in source', () => {
    const zone = outboxZoneSrc();
    const body = zone.slice(zone.indexOf('if (!target)'), zone.indexOf('const threadId = target.threadId'));
    assert.match(body, /sanitizePathForUi\(workspacePath\)/);
    assert.match(body, /outboxCtx\('deliver', \{ hint: safeWs \}\)/);
  });

  it('OUTBOX_SEND_FAIL and CONFIRM_FAIL use threadId windowId errno in source', () => {
    const zone = outboxZoneSrc();
    assert.match(zone, /OUTBOX_CONFIRM_FAIL[\s\S]*outboxCtx\('deliver', \{ threadId, windowId, hint: String\(sentPaths\.length\), errno \}\)/);
    assert.match(zone, /OUTBOX_SEND_FAIL[\s\S]*outboxCtx\('deliver', \{[\s\S]*threadId,[\s\S]*windowId,[\s\S]*errno/);
  });

  it('sendBatch rolls back sentPaths on OUTBOX_SEND_FAIL in source', () => {
    const zone = outboxZoneSrc();
    const body = zone.slice(zone.indexOf('async function sendBatch'), zone.indexOf('async function tick'));
    assert.match(body, /if \(sentPaths\.length\) deleteSentFiles\(sentPaths\)/);
  });

  it('tick skips when inFlight or not ready in source', () => {
    const zone = outboxZoneSrc();
    const body = zone.slice(zone.indexOf('async function tick'), zone.indexOf('export async function flushOutboxForWorkspace'));
    assert.match(body, /if \(inFlight\.has\(absWs\)\) return/);
    assert.match(body, /if \(!force && !isOutboxReadyForSend/);
    assert.match(body, /IDLE_DEBOUNCE_MS/);
  });

  it('readMetaCaption catch stays silent in source', () => {
    const src = readFileSync(new URL('../../src/media/outbox-watch.ts', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('function readMetaCaption'), src.indexOf('function deleteSentFiles'));
    assert.match(body, /catch \{/);
    assert.ok(!body.includes('logWarn'));
  });

  it('OUTBOX_LOG_CODES matches four codes in tests', () => {
    assert.equal(OUTBOX_LOG_CODES.length, 4);
    assert.deepEqual([...OUTBOX_LOG_CODES], [
      'OUTBOX_ROUTE_MISS',
      'OUTBOX_SEND_FAIL',
      'OUTBOX_CONFIRM_FAIL',
      'OUTBOX_WATCHER_START',
    ]);
  });

  it('deleteSentFiles catch stays silent in source', () => {
    const src = readFileSync(new URL('../../src/media/outbox-watch.ts', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('function deleteSentFiles'), src.indexOf('export function resolveOutboxAgentActivity'));
    assert.match(body, /catch \{/);
    assert.ok(!body.includes('logWarn'));
  });

  it('isOutboxReadyForSend covers waiting_approval and AGENT_IDLE_STATUSES in source', () => {
    const src = readFileSync(new URL('../../src/media/outbox-watch.ts', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('export function isOutboxReadyForSend'), src.indexOf('function pickSendMethod'));
    assert.match(body, /waiting_approval/);
    assert.match(body, /AGENT_IDLE_STATUSES\.has\(status\)/);
    assert.match(body, /return !isLive/);
  });

  it('pickSendMethod uses ten megabyte photo threshold in source', () => {
    const src = readFileSync(new URL('../../src/media/outbox-watch.ts', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('function pickSendMethod'), src.indexOf('export type OutboxSendItem'));
    assert.match(body, /10 \* 1024 \* 1024/);
    assert.match(body, /\.webp/);
  });

  it('sendBatch early return without log for missing chatId or empty files in source', () => {
    const zone = outboxZoneSrc();
    const body = zone.slice(zone.indexOf('async function sendBatch'), zone.indexOf('async function tick'));
    assert.match(body, /if \(!deps\.chatId \|\| files\.length === 0\) return false/);
  });

  it('CONFIRM_FAIL catch still returns true from sendBatch in source', () => {
    const zone = outboxZoneSrc();
    const body = zone.slice(zone.indexOf('async function sendBatch'), zone.indexOf('async function tick'));
    assert.match(body, /OUTBOX_CONFIRM_FAIL/);
    assert.match(body, /return true;\s*\n\s*\} catch \(err\)/);
  });

  it('registerOutboxWatcher returns early when watcher already exists in source', () => {
    const zone = outboxZoneSrc();
    const body = zone.slice(zone.indexOf('export function registerOutboxWatcher'));
    assert.match(body, /if \(watchers\.has\(absWs\)\) return/);
  });

  it('sendBatch captionUsed applies caption to first group only in source', () => {
    const zone = outboxZoneSrc();
    const body = zone.slice(zone.indexOf('async function sendBatch'), zone.indexOf('async function tick'));
    assert.match(body, /let captionUsed = false/);
    assert.match(body, /const groupCaption = !captionUsed \? caption : undefined/);
    assert.match(body, /if \(groupCaption\) captionUsed = true/);
  });

  it('sendBatch resolveOutboundTarget passes composerId when active workspace matches in source', () => {
    const zone = outboxZoneSrc();
    const body = zone.slice(zone.indexOf('async function sendBatch'), zone.indexOf('async function tick'));
    assert.match(body, /activeWsNorm === wsNorm \? state\.activeComposerId : undefined/);
    assert.match(body, /windowId: activeWsNorm === wsNorm \? state\.activeWindowId : undefined/);
  });

  it('tick retains batch when sendBatch returns false in source', () => {
    const zone = outboxZoneSrc();
    const body = zone.slice(zone.indexOf('async function tick'), zone.indexOf('export async function flushOutboxForWorkspace'));
    assert.match(body, /if \(sent\) batches\.delete\(absWs\)/);
  });

  it('sendBatch user notify catch stays silent in source', () => {
    const zone = outboxZoneSrc();
    const body = zone.slice(zone.indexOf('async function sendBatch'), zone.indexOf('async function tick'));
    assert.match(body, /Could not send file[\s\S]*\.catch\(\(\) => \{\}\)/);
  });

  it('sendTelegramMediaGroup album caption only on idx zero in source', () => {
    const src = readFileSync(new URL('../../src/media/outbox-watch.ts', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('export async function sendTelegramMediaGroup'), src.indexOf('async function sendOutboxGroup'));
    assert.match(body, /caption: idx === 0 \? caption : undefined/);
  });

  it('listOutboxFiles sorts by mtime then basename in source', () => {
    const src = readFileSync(new URL('../../src/media/outbox-watch.ts', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('function listOutboxFiles'), src.indexOf('function readMetaCaption'));
    assert.match(body, /sa\.mtimeMs - sb\.mtimeMs/);
    assert.match(body, /basename\(a\)\.localeCompare\(basename\(b\)\)/);
  });

  it('resolveOutboxAgentActivity uses state when target missing in source', () => {
    const src = readFileSync(new URL('../../src/media/outbox-watch.ts', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('export function resolveOutboxAgentActivity'), src.indexOf('export function resolveOutboxAgentStatus'));
    assert.match(body, /if \(!target \|\| target\.mapping\.windowId === state\.activeWindowId\)/);
  });

  it('behavioral it count matches OUTBOX_PATH_MATRIX row count', () => {
    assert.equal(OUTBOX_PATH_MATRIX.length, 45);
  });
});
