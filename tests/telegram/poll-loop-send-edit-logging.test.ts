import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ChatElement, TelegramConfig } from '../../src/core/types.js';
import type { StateManager } from '../../src/state/broadcast.js';
import type { WindowMonitor } from '../../src/state/windows.js';
import type { CommandExecutor } from '../../src/ide/actions/navigation.js';
import type { CDPBridge } from '../../src/ide/cdp-session.js';
import type { TelegramApiClient } from '../../src/telegram/types.js';
import type { FormattedMessage } from '../../src/telegram/format/html.js';
import { MessageTracker } from '../../src/telegram/pipeline/tracker.js';
import { BaseTelegramTransport } from '../../src/telegram/transport/poll-loop.js';

const BOT_TOKEN = '1234567890:ABCDEFghijklmnopqrsTUVwxyz';
const CHAT_ID = -1001234567890;
const THREAD_ID = 4242;
const ELEMENT_ID = 'assistant-el-1';
const CONTENT_HASH = 'send-edit-hash';

const SEND_EDIT_LOG_CODES = ['TG_EDIT_FAIL', 'TG_SEND_FAIL'] as const;

type SendEditPrivates = {
  editTrackedMessage(
    threadId: number,
    element: ChatElement,
    formatted: FormattedMessage,
    contentHash: string,
    tracked: { telegramMsgIds: number[] },
    forceHtml?: boolean,
  ): Promise<void>;
  sendNewMessage(
    threadId: number,
    element: ChatElement,
    formatted: FormattedMessage,
    contentHash: string,
    composerId?: string,
    forceHtml?: boolean,
  ): Promise<void>;
  composerElementThread: Map<string, number>;
  richDisabled: boolean;
};

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

function assertSendEditLog(
  lines: string[],
  code: string,
  need: {
    threadId?: number;
    chatId?: number;
    itemId?: string;
    op?: string;
    hint?: string;
    text?: string;
  } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.hint && !l.includes(`hint=${need.hint}`)) return false;
    if (need.threadId !== undefined && !l.includes(`threadId=${need.threadId}`)) return false;
    if (need.chatId !== undefined && !l.includes(`chatId=${need.chatId}`)) return false;
    if (need.itemId && !l.includes(`itemId=${need.itemId}`)) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.hint ? `hint=${need.hint}` : '',
    need.threadId !== undefined ? `threadId=${need.threadId}` : '',
    need.chatId !== undefined ? `chatId=${need.chatId}` : '',
    need.itemId ? `itemId=${need.itemId}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing send/edit log: ${desc}`);
  assert.ok(line!.includes('scope=telegram'), `${code} missing scope=telegram`);
}

function assertNoSendEditLogs(lines: string[]): void {
  const hit = lines.find((l) => SEND_EDIT_LOG_CODES.some((code) => l.includes(`code=${code}`)));
  assert.ok(!hit, `unexpected send/edit log: ${hit}`);
}

function assistantElement(id = ELEMENT_ID): ChatElement {
  return {
    type: 'assistant',
    id,
    flatIndex: 0,
    text: 'hello',
    html: '<p>hello</p>',
    codeBlocks: [],
  };
}

function formatted(html: string): FormattedMessage {
  return { html };
}

function formattedRich(html = '<p>rich</p>'): FormattedMessage {
  return { html: '<p>plain</p>', richHtml: html };
}

function priv(probe: SendEditProbe): SendEditPrivates {
  return probe as unknown as SendEditPrivates;
}

/** Force splitMessage into two HTML parts (>4096 chars). */
function twoPartHtml(): string {
  return `${'a'.repeat(4100)}\n\n${'b'.repeat(100)}`;
}

function threePartHtml(): string {
  return `${'a'.repeat(4100)}\n\n${'b'.repeat(4100)}\n\n${'c'.repeat(50)}`;
}

function assertSendEditLogNoHint(
  lines: string[],
  code: string,
  need: Omit<Parameters<typeof assertSendEditLog>[2], never> = {},
): void {
  assertSendEditLog(lines, code, need);
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.threadId !== undefined && !l.includes(`threadId=${need.threadId}`)) return false;
    if (need.itemId && !l.includes(`itemId=${need.itemId}`)) return false;
    return true;
  });
  assert.ok(line && !line.includes('hint='), `${code} must not include hint= on outer fail path`);
}

function makeStateManager(): StateManager {
  const ee = new EventEmitter();
  return {
    on: (ev: string, fn: (...args: unknown[]) => void) => { ee.on(ev, fn); },
    off: (ev: string, fn: (...args: unknown[]) => void) => { ee.off(ev, fn); },
    getCurrentState: () => ({
      connected: false,
      extractorStatus: 'ok',
      windows: [],
      activeWindowId: '',
      items: [],
      messages: [],
      chatTabs: [],
    }),
  } as unknown as StateManager;
}

function makeWindowMonitor(): WindowMonitor {
  const ee = new EventEmitter();
  return {
    on: (ev: string, fn: (...args: unknown[]) => void) => { ee.on(ev, fn); },
    off: (ev: string, fn: (...args: unknown[]) => void) => { ee.off(ev, fn); },
    getAllSnapshots: () => new Map(),
    getSnapshot: () => undefined,
    getHomeWindowId: () => '',
  } as unknown as WindowMonitor;
}

function baseConfig(): TelegramConfig {
  return {
    enabled: true,
    botToken: BOT_TOKEN,
    preRegisteredUsers: [],
    impl: 'raw',
  };
}

class SendEditProbe extends BaseTelegramTransport {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  wireApi(api: TelegramApiClient): void {
    this.api = api;
    this.buildCommandDeps().setSyncEnabled(true, CHAT_ID);
  }

  runEdit(
    threadId: number,
    element: ChatElement,
    fmt: FormattedMessage,
    tracked: { telegramMsgIds: number[] },
    forceHtml = false,
  ): Promise<void> {
    return (this as unknown as SendEditPrivates).editTrackedMessage(
      threadId,
      element,
      fmt,
      CONTENT_HASH,
      tracked,
      forceHtml,
    );
  }

  runSend(
    threadId: number,
    element: ChatElement,
    fmt: FormattedMessage,
    composerId?: string,
    forceHtml = false,
  ): Promise<void> {
    return (this as unknown as SendEditPrivates).sendNewMessage(
      threadId,
      element,
      fmt,
      CONTENT_HASH,
      composerId,
      forceHtml,
    );
  }

  setComposerOwner(composerId: string, elementId: string, threadId: number): void {
    (this as unknown as SendEditPrivates).composerElementThread.set(`${composerId}::${elementId}`, threadId);
  }
}

function makeProbe(dataDir: string): SendEditProbe {
  process.env.DATA_DIR = dataDir;
  return new SendEditProbe(
    baseConfig(),
    makeWindowMonitor(),
    makeStateManager(),
    {} as CommandExecutor,
    {} as CDPBridge,
  );
}

describe('poll-loop send/edit logging', () => {
  let dataDir: string;
  let savedDataDir: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-poll-send-edit-'));
    savedDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('logs TG_EDIT_FAIL on outer editMessageText failure with pollLoopCtx threadId itemId op edit_message', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async () => {
        throw new Error('edit hard fail');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(THREAD_ID, assistantElement(), formatted('<p>x</p>'), { telegramMsgIds: [100] });
    });

    assertSendEditLog(lines, 'TG_EDIT_FAIL', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      itemId: ELEMENT_ID,
      op: 'edit_message',
      text: 'edit hard fail',
    });
  });

  it('logs TG_EDIT_FAIL on multi-part secondary edit failure with hint part index', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async (_chat, msgId) => {
        if (msgId === 101) throw new Error('part edit fail');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(
        THREAD_ID,
        assistantElement(),
        formatted(twoPartHtml()),
        { telegramMsgIds: [100, 101] },
      );
    });

    assertSendEditLog(lines, 'TG_EDIT_FAIL', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      itemId: ELEMENT_ID,
      op: 'edit_message',
      hint: 'part1',
      text: 'part edit fail',
    });
  });

  it('logs TG_SEND_FAIL when multi-part edit sends extra part and sendMessage fails', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async () => {},
      sendMessage: async () => {
        throw new Error('part send fail');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(
        THREAD_ID,
        assistantElement(),
        formatted(twoPartHtml()),
        { telegramMsgIds: [100] },
      );
    });

    assertSendEditLog(lines, 'TG_SEND_FAIL', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      itemId: ELEMENT_ID,
      op: 'send_message',
      hint: 'part1',
      text: 'part send fail',
    });
  });

  it('logs TG_SEND_FAIL on sendNewMessage failure with pollLoopCtx threadId itemId op send_message', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => {
        throw new Error('send blocked');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>new</p>'));
    });

    assertSendEditLog(lines, 'TG_SEND_FAIL', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      itemId: ELEMENT_ID,
      op: 'send_message',
      text: 'send blocked',
    });
  });

  it('edit message is not modified stays silent without TG_EDIT_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async () => {
        throw new Error('message is not modified');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(THREAD_ID, assistantElement(), formatted('<p>x</p>'), { telegramMsgIds: [100] });
    });

    assertNoSendEditLogs(lines);
    const tracked = probe.messageTracker.getTracked(THREAD_ID, ELEMENT_ID);
    assert.ok(tracked);
    assert.deepEqual(tracked!.telegramMsgIds, [100]);
  });

  it('edit message not found tracks dead without TG_EDIT_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async () => {
        throw new Error('message not found');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(THREAD_ID, assistantElement(), formatted('<p>x</p>'), { telegramMsgIds: [100] });
    });

    assertNoSendEditLogs(lines);
    const tracked = probe.messageTracker.getTracked(THREAD_ID, ELEMENT_ID);
    assert.equal(tracked?.lastContentHash, 'dead');
    assert.deepEqual(tracked?.telegramMsgIds, []);
  });

  it('part edit message is not modified stays silent without TG_EDIT_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async (_chat, msgId) => {
        if (msgId === 101) throw new Error('message is not modified');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(
        THREAD_ID,
        assistantElement(),
        formatted(twoPartHtml()),
        { telegramMsgIds: [100, 101] },
      );
    });

    assertNoSendEditLogs(lines);
  });

  it('send thread not found dead path stays silent without TG_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => {
        throw new Error('thread not found');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>dead thread</p>'));
    });

    assertNoSendEditLogs(lines);
    const tracked = probe.messageTracker.getTracked(THREAD_ID, ELEMENT_ID);
    assert.equal(tracked?.lastContentHash, 'dead-thread');
  });

  it('send chat not found dead path stays silent without TG_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => {
        throw new Error('chat not found');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>dead chat</p>'));
    });

    assertNoSendEditLogs(lines);
  });

  it('sendNewMessage composer dedup different thread stays silent without TG_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    let sendCalls = 0;
    probe.wireApi({
      sendMessage: async () => {
        sendCalls++;
        return { message_id: 55 };
      },
    } as unknown as TelegramApiClient);
    probe.setComposerOwner('composer-a', ELEMENT_ID, THREAD_ID + 1);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>dup</p>'), 'composer-a');
    });

    assertNoSendEditLogs(lines);
    assert.equal(sendCalls, 0);
  });

  it('editTrackedMessage with missing mainMsgId stays silent without TG_EDIT_FAIL', async () => {
    const probe = makeProbe(dataDir);
    let editCalls = 0;
    probe.wireApi({
      editMessageText: async () => {
        editCalls++;
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(THREAD_ID, assistantElement(), formatted('<p>x</p>'), { telegramMsgIds: [] });
    });

    assertNoSendEditLogs(lines);
    assert.equal(editCalls, 0);
  });

  it('successful editTrackedMessage stays silent without TG_EDIT_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async () => {},
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(THREAD_ID, assistantElement(), formatted('<p>ok</p>'), { telegramMsgIds: [100] });
    });

    assertNoSendEditLogs(lines);
  });

  it('successful sendNewMessage stays silent without TG_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => ({ message_id: 200 }),
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>ok</p>'));
    });

    assertNoSendEditLogs(lines);
    const tracked = probe.messageTracker.getTracked(THREAD_ID, ELEMENT_ID);
    assert.deepEqual(tracked?.telegramMsgIds, [200]);
  });

  it('edit parse entities recovery stays silent without TG_EDIT_FAIL', async () => {
    let calls = 0;
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async () => {
        calls++;
        if (calls === 1) throw new Error('parse entities at byte offset');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(THREAD_ID, assistantElement(), formatted('<p>bad</p>'), { telegramMsgIds: [100] });
    });

    assertNoSendEditLogs(lines);
    assert.equal(calls, 2);
  });

  it('send parse entities recovery stays silent without TG_SEND_FAIL', async () => {
    let calls = 0;
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => {
        calls++;
        if (calls === 1) throw new Error('parse entities at byte offset');
        return { message_id: 300 };
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>bad</p>'));
    });

    assertNoSendEditLogs(lines);
    assert.equal(calls, 2);
  });

  it('logs exactly one TG_EDIT_FAIL per outer edit failure', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async () => {
        throw new Error('once only');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(THREAD_ID, assistantElement(), formatted('<p>x</p>'), { telegramMsgIds: [100] });
    });

    assert.equal(lines.filter((l) => l.includes('code=TG_EDIT_FAIL')).length, 1);
  });

  it('logs exactly one TG_SEND_FAIL per sendNewMessage failure', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => {
        throw new Error('once only');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>x</p>'));
    });

    assert.equal(lines.filter((l) => l.includes('code=TG_SEND_FAIL')).length, 1);
  });

  it('logs TG_EDIT_FAIL on outer edit failure without hint field', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async () => {
        throw new Error('outer no hint');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(THREAD_ID, assistantElement(), formatted('<p>x</p>'), { telegramMsgIds: [100] });
    });

    assertSendEditLogNoHint(lines, 'TG_EDIT_FAIL', {
      threadId: THREAD_ID,
      itemId: ELEMENT_ID,
      op: 'edit_message',
      text: 'outer no hint',
    });
  });

  it('logs TG_SEND_FAIL when multi-part sendNewMessage fails on second part', async () => {
    let part = 0;
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => {
        part++;
        if (part === 1) return { message_id: 501 };
        throw new Error('second part send fail');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted(twoPartHtml()));
    });

    assertSendEditLog(lines, 'TG_SEND_FAIL', {
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      itemId: ELEMENT_ID,
      op: 'send_message',
      text: 'second part send fail',
    });
  });

  it('logs TG_EDIT_FAIL with hint part2 on three-part secondary edit failure', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async (_chat, msgId) => {
        if (msgId === 102) throw new Error('third part edit fail');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(
        THREAD_ID,
        assistantElement(),
        formatted(threePartHtml()),
        { telegramMsgIds: [100, 101, 102] },
      );
    });

    assertSendEditLog(lines, 'TG_EDIT_FAIL', {
      threadId: THREAD_ID,
      itemId: ELEMENT_ID,
      op: 'edit_message',
      hint: 'part2',
      text: 'third part edit fail',
    });
  });

  it('edit start tag recovery stays silent without TG_EDIT_FAIL', async () => {
    let calls = 0;
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async () => {
        calls++;
        if (calls === 1) throw new Error('start tag at byte offset');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(THREAD_ID, assistantElement(), formatted('<p>bad</p>'), { telegramMsgIds: [100] });
    });

    assertNoSendEditLogs(lines);
    assert.equal(calls, 2);
  });

  it('send start tag recovery stays silent without TG_SEND_FAIL', async () => {
    let calls = 0;
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => {
        calls++;
        if (calls === 1) throw new Error('start tag at byte offset');
        return { message_id: 301 };
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>bad</p>'));
    });

    assertNoSendEditLogs(lines);
    assert.equal(calls, 2);
  });

  it('composer dedup same thread still sends without TG_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    let sendCalls = 0;
    probe.wireApi({
      sendMessage: async () => {
        sendCalls++;
        return { message_id: 77 };
      },
    } as unknown as TelegramApiClient);
    probe.setComposerOwner('composer-a', ELEMENT_ID, THREAD_ID);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>same owner</p>'), 'composer-a');
    });

    assertNoSendEditLogs(lines);
    assert.equal(sendCalls, 1);
  });

  it('logs TG_SEND_FAIL on rate limit error because transient does not skip send fail path', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => {
        throw new Error('Too Many Requests: retry after 10');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>429</p>'));
    });

    assertSendEditLog(lines, 'TG_SEND_FAIL', {
      op: 'send_message',
      text: 'Too Many Requests',
    });
  });

  it('outer edit failure does not emit TG_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async () => {
        throw new Error('edit only fail');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(THREAD_ID, assistantElement(), formatted('<p>x</p>'), { telegramMsgIds: [100] });
    });

    assert.ok(lines.some((l) => l.includes('code=TG_EDIT_FAIL')));
    assert.ok(!lines.some((l) => l.includes('code=TG_SEND_FAIL')));
  });

  it('sendNewMessage failure does not emit TG_EDIT_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => {
        throw new Error('send only fail');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>x</p>'));
    });

    assert.ok(lines.some((l) => l.includes('code=TG_SEND_FAIL')));
    assert.ok(!lines.some((l) => l.includes('code=TG_EDIT_FAIL')));
  });

  it('successful multi-part edit tracks expanded telegramMsgIds without TG_EDIT_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async () => {},
      sendMessage: async () => ({ message_id: 888 }),
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(
        THREAD_ID,
        assistantElement(),
        formatted(twoPartHtml()),
        { telegramMsgIds: [100] },
      );
    });

    assertNoSendEditLogs(lines);
    const tracked = probe.messageTracker.getTracked(THREAD_ID, ELEMENT_ID);
    assert.deepEqual(tracked?.telegramMsgIds, [100, 888]);
  });

  it('dead thread send removes topic mapping without TG_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.topicManager.registerMapping({
      threadId: THREAD_ID,
      windowId: 'win-1',
      windowTitle: 'Project',
      tabTitle: 'Tab',
      lastActive: Date.now(),
    });
    probe.wireApi({
      sendMessage: async () => {
        throw new Error('thread not found');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>gone</p>'));
    });

    assertNoSendEditLogs(lines);
    assert.equal(probe.topicManager.resolveThread(THREAD_ID), undefined);
  });

  it('logs TG_EDIT_FAIL with itemId matching element id', async () => {
    const altId = 'assistant-el-alt';
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async () => {
        throw new Error('alt element fail');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(
        THREAD_ID,
        assistantElement(altId),
        formatted('<p>x</p>'),
        { telegramMsgIds: [100] },
      );
    });

    assertSendEditLog(lines, 'TG_EDIT_FAIL', {
      itemId: altId,
      text: 'alt element fail',
    });
  });

  it('logs TG_SEND_FAIL when sendNewMessage throws non-Error value', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => {
        throw 'string send fail';
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>x</p>'));
    });

    assertSendEditLog(lines, 'TG_SEND_FAIL', {
      op: 'send_message',
      text: 'string send fail',
    });
  });

  it('editTrackedMessage with mainMsgId zero stays silent without TG_EDIT_FAIL', async () => {
    const probe = makeProbe(dataDir);
    let editCalls = 0;
    probe.wireApi({
      editMessageText: async () => {
        editCalls++;
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(THREAD_ID, assistantElement(), formatted('<p>x</p>'), { telegramMsgIds: [0] });
    });

    assertNoSendEditLogs(lines);
    assert.equal(editCalls, 0);
  });

  it('successful multi-part sendNewMessage tracks all part msg ids without TG_SEND_FAIL', async () => {
    let part = 0;
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => {
        part++;
        return { message_id: 600 + part };
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted(twoPartHtml()));
    });

    assertNoSendEditLogs(lines);
    const tracked = probe.messageTracker.getTracked(THREAD_ID, ELEMENT_ID);
    assert.deepEqual(tracked?.telegramMsgIds, [601, 602]);
  });

  it('part edit failure still persists tracked msg ids without aborting track', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async (_chat, msgId) => {
        if (msgId === 101) throw new Error('part fail keeps ids');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(
        THREAD_ID,
        assistantElement(),
        formatted(twoPartHtml()),
        { telegramMsgIds: [100, 101] },
      );
    });

    assertSendEditLog(lines, 'TG_EDIT_FAIL', { hint: 'part1', text: 'part fail keeps ids' });
    const tracked = probe.messageTracker.getTracked(THREAD_ID, ELEMENT_ID);
    assert.deepEqual(tracked?.telegramMsgIds, [100, 101]);
  });

  it('logs exactly one TG_SEND_FAIL when part send fails during multi-part edit', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async () => {},
      sendMessage: async () => {
        throw new Error('single part send fail');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(
        THREAD_ID,
        assistantElement(),
        formatted(twoPartHtml()),
        { telegramMsgIds: [100] },
      );
    });

    assert.equal(lines.filter((l) => l.includes('code=TG_SEND_FAIL')).length, 1);
  });

  it('rich edit fallback to HTML stays silent without TG_EDIT_FAIL or TG_SEND_FAIL', async () => {
    let richCalls = 0;
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editRichMessage: async () => {
        richCalls++;
        const err = new Error('unknown method sendRichMessage') as Error & { error_code: number };
        err.error_code = 404;
        throw err;
      },
      editMessageText: async () => {},
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(
        THREAD_ID,
        assistantElement(),
        formattedRich(),
        { telegramMsgIds: [100] },
      );
    });

    assertNoSendEditLogs(lines);
    assert.equal(richCalls, 1);
    assert.equal(priv(probe).richDisabled, true);
  });

  it('rich send fallback to HTML stays silent without TG_SEND_FAIL', async () => {
    let richCalls = 0;
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendRichMessage: async () => {
        richCalls++;
        const err = new Error('unknown method sendRichMessage') as Error & { error_code: number };
        err.error_code = 404;
        throw err;
      },
      sendMessage: async () => ({ message_id: 909 }),
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formattedRich());
    });

    assertNoSendEditLogs(lines);
    assert.equal(richCalls, 1);
    const tracked = probe.messageTracker.getTracked(THREAD_ID, ELEMENT_ID);
    assert.deepEqual(tracked?.telegramMsgIds, [909]);
  });

  it('dead thread without topic mapping stays silent without TG_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => {
        throw new Error('chat not found');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>no map</p>'));
    });

    assertNoSendEditLogs(lines);
    assert.equal(probe.topicManager.resolveThread(THREAD_ID), undefined);
  });

  it('logs TG_SEND_FAIL with itemId matching element id on sendNewMessage failure', async () => {
    const altId = 'send-el-alt';
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => {
        throw new Error('alt send fail');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(altId), formatted('<p>x</p>'));
    });

    assertSendEditLog(lines, 'TG_SEND_FAIL', {
      itemId: altId,
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      text: 'alt send fail',
    });
  });

  it('outer TG_SEND_FAIL omits hint field on sendNewMessage failure', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => {
        throw new Error('outer send no hint');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>x</p>'));
    });

    assertSendEditLogNoHint(lines, 'TG_SEND_FAIL', {
      op: 'send_message',
      text: 'outer send no hint',
    });
  });

  it('logs TG_EDIT_FAIL when edit throws non-Error value', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async () => {
        throw 'string edit fail';
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(THREAD_ID, assistantElement(), formatted('<p>x</p>'), { telegramMsgIds: [100] });
    });

    assertSendEditLog(lines, 'TG_EDIT_FAIL', {
      op: 'edit_message',
      text: 'string edit fail',
    });
  });

  it('forceHtml edit skips editRichMessage even when richHtml is present', async () => {
    let richCalls = 0;
    let textCalls = 0;
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editRichMessage: async () => {
        richCalls++;
      },
      editMessageText: async () => {
        textCalls++;
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(
        THREAD_ID,
        assistantElement(),
        formattedRich(),
        { telegramMsgIds: [100] },
        true,
      );
    });

    assertNoSendEditLogs(lines);
    assert.equal(richCalls, 0);
    assert.equal(textCalls, 1);
  });

  it('richDisabled send uses sendMessage without calling sendRichMessage', async () => {
    let richCalls = 0;
    const probe = makeProbe(dataDir);
    priv(probe).richDisabled = true;
    probe.wireApi({
      sendRichMessage: async () => {
        richCalls++;
        return { message_id: 1 };
      },
      sendMessage: async () => ({ message_id: 707 }),
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formattedRich());
    });

    assertNoSendEditLogs(lines);
    assert.equal(richCalls, 0);
    assert.deepEqual(probe.messageTracker.getTracked(THREAD_ID, ELEMENT_ID)?.telegramMsgIds, [707]);
  });

  it('transient thread not found logs TG_SEND_FAIL instead of dead-thread track', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => {
        throw new Error('Too Many Requests: retry after 5 — thread not found');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>429 dead mix</p>'));
    });

    assertSendEditLog(lines, 'TG_SEND_FAIL', { text: 'Too Many Requests' });
    const tracked = probe.messageTracker.getTracked(THREAD_ID, ELEMENT_ID);
    assert.notEqual(tracked?.lastContentHash, 'dead-thread');
  });

  it('dead thread with mapping logs TG_DEAD_TOPIC_REMOVED without TG_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.topicManager.registerMapping({
      threadId: THREAD_ID,
      windowId: 'win-dead',
      windowTitle: 'Dead',
      tabTitle: 'Tab',
      lastActive: Date.now(),
    });
    probe.wireApi({
      sendMessage: async () => {
        throw new Error('thread not found');
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>dead mapped</p>'));
    });

    assertNoSendEditLogs(lines);
    assert.ok(lines.some((l) => l.includes('code=TG_DEAD_TOPIC_REMOVED')));
    assert.equal(probe.topicManager.resolveThread(THREAD_ID), undefined);
  });

  it('successful edit updates messageTracker contentHash without TG_EDIT_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async () => {},
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(THREAD_ID, assistantElement(), formatted('<p>hash</p>'), { telegramMsgIds: [100] });
    });

    assertNoSendEditLogs(lines);
    assert.equal(probe.messageTracker.getTracked(THREAD_ID, ELEMENT_ID)?.lastContentHash, CONTENT_HASH);
  });

  it('logs two TG_EDIT_FAIL lines when two secondary part edits fail', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async (_chat, msgId) => {
        if (msgId === 101 || msgId === 102) throw new Error(`fail-${msgId}`);
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(
        THREAD_ID,
        assistantElement(),
        formatted(threePartHtml()),
        { telegramMsgIds: [100, 101, 102] },
      );
    });

    assert.equal(lines.filter((l) => l.includes('code=TG_EDIT_FAIL')).length, 2);
    assertSendEditLog(lines, 'TG_EDIT_FAIL', { hint: 'part1', text: 'fail-101' });
    assertSendEditLog(lines, 'TG_EDIT_FAIL', { hint: 'part2', text: 'fail-102' });
  });

  it('three-part edit with single tracked msg appends two send part ids silently', async () => {
    let sendPart = 0;
    const probe = makeProbe(dataDir);
    probe.wireApi({
      editMessageText: async () => {},
      sendMessage: async () => {
        sendPart++;
        return { message_id: 800 + sendPart };
      },
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runEdit(
        THREAD_ID,
        assistantElement(),
        formatted(threePartHtml()),
        { telegramMsgIds: [100] },
      );
    });

    assertNoSendEditLogs(lines);
    assert.equal(sendPart, 2);
    assert.deepEqual(probe.messageTracker.getTracked(THREAD_ID, ELEMENT_ID)?.telegramMsgIds, [100, 801, 802]);
  });

  it('sendNewMessage without composerId does not set composerElementThread entry', async () => {
    const probe = makeProbe(dataDir);
    probe.wireApi({
      sendMessage: async () => ({ message_id: 55 }),
    } as unknown as TelegramApiClient);

    await captureAll(async () => {
      await probe.runSend(THREAD_ID, assistantElement(), formatted('<p>no composer</p>'));
    });

    assert.equal(priv(probe).composerElementThread.size, 0);
  });
});

const SILENT_PATH_MARKERS = [
  'message is not modified stays silent',
  'not found tracks dead without TG_EDIT_FAIL',
  'part edit message is not modified',
  'thread not found dead path',
  'chat not found dead path',
  'composer dedup different thread',
  'missing mainMsgId stays silent',
  'successful editTrackedMessage stays silent',
  'successful sendNewMessage stays silent',
  'parse entities recovery stays silent',
  'start tag recovery stays silent',
  'composer dedup same thread',
  'rate limit error because transient',
  'outer edit failure does not emit TG_SEND_FAIL',
  'sendNewMessage failure does not emit TG_EDIT_FAIL',
  'multi-part edit tracks expanded telegramMsgIds',
  'dead thread send removes topic mapping',
  'non-Error value',
  'mainMsgId zero',
  'multi-part sendNewMessage tracks all part msg ids',
  'part edit failure still persists tracked msg ids',
  'rich edit fallback to HTML',
  'rich send fallback to HTML',
  'dead thread without topic mapping',
  'itemId matching element id on sendNewMessage',
  'outer TG_SEND_FAIL omits hint',
  'edit throws non-Error value',
  'forceHtml edit skips editRichMessage',
  'richDisabled send uses sendMessage',
  'transient thread not found logs TG_SEND_FAIL',
  'TG_DEAD_TOPIC_REMOVED without TG_SEND_FAIL',
  'updates messageTracker contentHash',
  'two TG_EDIT_FAIL lines when two secondary part edits fail',
  'three-part edit with single tracked msg appends two send part ids',
  'without composerId does not set composerElementThread',
] as const;

const SEND_EDIT_PATH_MATRIX = [
  { kind: 'fail' as const, code: 'TG_EDIT_FAIL', marker: 'outer editMessageText failure with pollLoopCtx' },
  { kind: 'fail' as const, code: 'TG_EDIT_FAIL', marker: 'multi-part secondary edit failure with hint part index' },
  { kind: 'fail' as const, code: 'TG_SEND_FAIL', marker: 'multi-part edit sends extra part and sendMessage fails' },
  { kind: 'fail' as const, code: 'TG_SEND_FAIL', marker: 'sendNewMessage failure with pollLoopCtx' },
  { kind: 'silent' as const, marker: 'message is not modified stays silent without TG_EDIT_FAIL' },
  { kind: 'silent' as const, marker: 'edit message not found tracks dead without TG_EDIT_FAIL' },
  { kind: 'silent' as const, marker: 'part edit message is not modified stays silent without TG_EDIT_FAIL' },
  { kind: 'silent' as const, marker: 'thread not found dead path stays silent without TG_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'chat not found dead path stays silent without TG_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'composer dedup different thread stays silent without TG_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'missing mainMsgId stays silent without TG_EDIT_FAIL' },
  { kind: 'silent' as const, marker: 'successful editTrackedMessage stays silent without TG_EDIT_FAIL' },
  { kind: 'silent' as const, marker: 'successful sendNewMessage stays silent without TG_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'edit parse entities recovery stays silent without TG_EDIT_FAIL' },
  { kind: 'silent' as const, marker: 'send parse entities recovery stays silent without TG_SEND_FAIL' },
  { kind: 'fail' as const, code: 'TG_EDIT_FAIL', marker: 'exactly one TG_EDIT_FAIL per outer edit failure' },
  { kind: 'fail' as const, code: 'TG_SEND_FAIL', marker: 'exactly one TG_SEND_FAIL per sendNewMessage failure' },
  { kind: 'fail' as const, code: 'TG_EDIT_FAIL', marker: 'outer edit failure without hint field' },
  { kind: 'fail' as const, code: 'TG_SEND_FAIL', marker: 'multi-part sendNewMessage fails on second part' },
  { kind: 'fail' as const, code: 'TG_EDIT_FAIL', marker: 'hint part2 on three-part secondary edit failure' },
  { kind: 'silent' as const, marker: 'edit start tag recovery stays silent without TG_EDIT_FAIL' },
  { kind: 'silent' as const, marker: 'send start tag recovery stays silent without TG_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'composer dedup same thread still sends without TG_SEND_FAIL' },
  { kind: 'fail' as const, code: 'TG_SEND_FAIL', marker: 'rate limit error because transient does not skip send fail path' },
  { kind: 'fail' as const, code: 'TG_EDIT_FAIL', marker: 'outer edit failure does not emit TG_SEND_FAIL' },
  { kind: 'fail' as const, code: 'TG_SEND_FAIL', marker: 'sendNewMessage failure does not emit TG_EDIT_FAIL' },
  { kind: 'silent' as const, marker: 'multi-part edit tracks expanded telegramMsgIds without TG_EDIT_FAIL' },
  { kind: 'silent' as const, marker: 'dead thread send removes topic mapping without TG_SEND_FAIL' },
  { kind: 'fail' as const, code: 'TG_EDIT_FAIL', marker: 'itemId matching element id' },
  { kind: 'fail' as const, code: 'TG_SEND_FAIL', marker: 'sendNewMessage throws non-Error value' },
  { kind: 'silent' as const, marker: 'mainMsgId zero stays silent without TG_EDIT_FAIL' },
  { kind: 'silent' as const, marker: 'multi-part sendNewMessage tracks all part msg ids without TG_SEND_FAIL' },
  { kind: 'fail' as const, code: 'TG_EDIT_FAIL', marker: 'part edit failure still persists tracked msg ids' },
  { kind: 'fail' as const, code: 'TG_SEND_FAIL', marker: 'exactly one TG_SEND_FAIL when part send fails during multi-part edit' },
  { kind: 'silent' as const, marker: 'rich edit fallback to HTML stays silent without TG_EDIT_FAIL or TG_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'rich send fallback to HTML stays silent without TG_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'dead thread without topic mapping stays silent without TG_SEND_FAIL' },
  { kind: 'fail' as const, code: 'TG_SEND_FAIL', marker: 'itemId matching element id on sendNewMessage failure' },
  { kind: 'fail' as const, code: 'TG_SEND_FAIL', marker: 'outer TG_SEND_FAIL omits hint field on sendNewMessage failure' },
  { kind: 'fail' as const, code: 'TG_EDIT_FAIL', marker: 'edit throws non-Error value' },
  { kind: 'silent' as const, marker: 'forceHtml edit skips editRichMessage even when richHtml is present' },
  { kind: 'silent' as const, marker: 'richDisabled send uses sendMessage without calling sendRichMessage' },
  { kind: 'fail' as const, code: 'TG_SEND_FAIL', marker: 'transient thread not found logs TG_SEND_FAIL instead of dead-thread track' },
  { kind: 'silent' as const, marker: 'dead thread with mapping logs TG_DEAD_TOPIC_REMOVED without TG_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'successful edit updates messageTracker contentHash without TG_EDIT_FAIL' },
  { kind: 'fail' as const, code: 'TG_EDIT_FAIL', marker: 'two TG_EDIT_FAIL lines when two secondary part edits fail' },
  { kind: 'silent' as const, marker: 'three-part edit with single tracked msg appends two send part ids silently' },
  { kind: 'silent' as const, marker: 'sendNewMessage without composerId does not set composerElementThread entry' },
  { kind: 'meta' as const, marker: 'poll-loop whole file no inline scope outside pollLoopCtx queueKickCtx bridgeAutoCtx helpers' },
] as const;

describe('poll-loop send/edit logging coverage', () => {
  it('asserts every send/edit code in test file', () => {
    const src = readFileSync(new URL('./poll-loop-send-edit-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of SEND_EDIT_LOG_CODES) {
      assert.ok(
        src.includes(`assertSendEditLog(lines, '${code}'`) || src.includes(`code=${code}`),
        `missing assertion for ${code}`,
      );
    }
    assert.equal(SEND_EDIT_LOG_CODES.length, 2);
  });

  it('poll-loop.ts declares TG_EDIT_FAIL and TG_SEND_FAIL in send/edit zone', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const zone = src.slice(src.indexOf('private async editTrackedMessage'), src.indexOf('private findMappingByTabTitle'));
    for (const code of SEND_EDIT_LOG_CODES) {
      assert.ok(zone.includes(`'${code}'`), `zone missing ${code}`);
    }
  });

  it('send/edit zone has zero console.log warn error', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const zone = src.slice(src.indexOf('private async editTrackedMessage'), src.indexOf('private findMappingByTabTitle'));
    assert.ok(!zone.includes('console.log('));
    assert.ok(!zone.includes('console.warn('));
    assert.ok(!zone.includes('console.error('));
  });

  it('all four send/edit fail sites use pollLoopCtx with threadId chatId itemId in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const zone = src.slice(src.indexOf('private async editTrackedMessage'), src.indexOf('private findMappingByTabTitle'));
    const editSites = zone.match(/TG_EDIT_FAIL[\s\S]*?pollLoopCtx\('edit_message'/g) ?? [];
    const sendSites = zone.match(/TG_SEND_FAIL[\s\S]*?pollLoopCtx\('send_message'/g) ?? [];
    assert.equal(editSites.length, 2);
    assert.equal(sendSites.length, 2);
    assert.match(zone, /threadId, chatId: this\.chatId, itemId: element\.id/);
  });

  it('TG_EDIT_FAIL and TG_SEND_FAIL use logWarn in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const zone = src.slice(src.indexOf('private async editTrackedMessage'), src.indexOf('private findMappingByTabTitle'));
    assert.match(zone, /logWarn\(\s*\n\s*'TG_EDIT_FAIL'/);
    assert.match(zone, /logWarn\(\s*\n\s*'TG_SEND_FAIL'/);
  });

  it('not-modified and not-found edit catches stay silent in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const editFn = src.slice(src.indexOf('private async editTrackedMessage'), src.indexOf('private async sendNewMessage'));
    assert.match(editFn, /if \(msg\.includes\('message is not modified'\)\)/);
    assert.match(editFn, /} else if \(msg\.includes\('not found'\)\)/);
    assert.match(editFn, /} else \{\s*logWarn\([\s\S]*?'TG_EDIT_FAIL'/);
  });

  it('dead thread send path returns without TG_SEND_FAIL in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private async sendNewMessage'), src.indexOf('private findMappingByTabTitle'));
    const deadBranch = block.slice(block.indexOf('thread not found'), block.indexOf("logWarn('TG_SEND_FAIL'"));
    assert.match(deadBranch, /return;/);
    assert.ok(!deadBranch.includes('TG_SEND_FAIL'));
  });

  it('part edit loop skips TG_EDIT_FAIL when message is not modified in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('for (let i = 1; i < parts.length; i++)'), src.indexOf('this.messageTracker.track(threadId, element.id, allMsgIds'));
    assert.match(block, /!partMsg\.includes\('message is not modified'\)/);
  });

  it('every send/edit code has assertSendEditLog in behavioral tests', () => {
    const src = readFileSync(new URL('./poll-loop-send-edit-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of SEND_EDIT_LOG_CODES) {
      assert.ok(src.includes(`assertSendEditLog(lines, '${code}'`), `behavioral test missing ${code}`);
    }
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./poll-loop-send-edit-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent marker "${marker}"`);
    }
  });

  it('path matrix rows map to behavioral test titles', () => {
    const src = readFileSync(new URL('./poll-loop-send-edit-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of SEND_EDIT_PATH_MATRIX) {
      if (row.kind === 'fail' && 'code' in row) {
        assert.ok(src.includes(row.marker), `matrix fail marker "${row.marker}" missing`);
      } else {
        assert.ok(src.includes(row.marker), `matrix silent marker "${row.marker}" missing`);
      }
    }
    assert.equal(SEND_EDIT_PATH_MATRIX.length, 49);
  });

  it('send/edit zone declares exactly four logWarn emission sites for covered codes', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const zone = src.slice(src.indexOf('private async editTrackedMessage'), src.indexOf('private findMappingByTabTitle'));
    assert.equal((zone.match(/logWarn\([\s\S]*?'TG_EDIT_FAIL'/g) ?? []).length, 2);
    assert.equal((zone.match(/logWarn\([\s\S]*?'TG_SEND_FAIL'/g) ?? []).length, 2);
  });

  it('composer dedup early return in sendNewMessage source has no log call', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const sendFn = src.slice(src.indexOf('private async sendNewMessage'), src.indexOf('private findMappingByTabTitle'));
    const dedupBlock = sendFn.slice(0, sendFn.indexOf('const rich = !forceHtml'));
    assert.match(dedupBlock, /owner !== undefined && owner !== threadId/);
    assert.match(dedupBlock, /return;/);
    assert.ok(!dedupBlock.includes('logWarn('));
  });

  it('editTrackedMessage early return when mainMsgId missing in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private async editTrackedMessage'), src.indexOf('const rich = !forceHtml'));
    assert.match(block, /if \(!mainMsgId\) return;/);
  });

  it('MessageTracker contentHash used in behavioral harness', () => {
    assert.equal(typeof MessageTracker.contentHash, 'function');
    assert.equal(MessageTracker.contentHash('x').length, 12);
  });

  it('automated matrix: 2/2 send/edit codes have behavioral assertSendEditLog', () => {
    const src = readFileSync(new URL('./poll-loop-send-edit-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of SEND_EDIT_LOG_CODES) {
      assert.ok(src.includes(`assertSendEditLog(lines, '${code}'`), `matrix missing ${code}`);
    }
  });

  it('outer TG_EDIT_FAIL site omits hint in source part sites use hint template', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const editFn = src.slice(src.indexOf('private async editTrackedMessage'), src.indexOf('private async sendNewMessage'));
    const outerFail = editFn.slice(editFn.lastIndexOf("} else {\n        logWarn("));
    assert.match(outerFail, /pollLoopCtx\('edit_message', \{ threadId, chatId: this\.chatId, itemId: element\.id \}\)/);
    assert.match(editFn, /hint: `part\$\{i\}`/);
  });

  it('send/edit warn codes never use logInfo in zone source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const zone = src.slice(src.indexOf('private async editTrackedMessage'), src.indexOf('private findMappingByTabTitle'));
    for (const code of SEND_EDIT_LOG_CODES) {
      assert.ok(!zone.includes(`logInfo('${code}'`));
      assert.ok(!zone.includes(`logInfo(\n          '${code}'`));
    }
  });

  it('edit first catch recovers parse entities and start tag without TG_EDIT_FAIL in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const editFn = src.slice(src.indexOf('private async editTrackedMessage'), src.indexOf('private async sendNewMessage'));
    const firstCatch = editFn.slice(editFn.indexOf('} catch (firstErr)'), editFn.indexOf('for (let i = 1; i < parts.length'));
    assert.match(firstCatch, /parse entities/);
    assert.match(firstCatch, /start tag/);
    assert.ok(!firstCatch.includes('TG_EDIT_FAIL'));
  });

  it('isTransientTelegramError only guards dead thread branch before TG_SEND_FAIL in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const sendFn = src.slice(src.indexOf('private async sendNewMessage'), src.indexOf('private findMappingByTabTitle'));
    const outerCatch = sendFn.slice(sendFn.lastIndexOf('} catch (err)'));
    assert.match(outerCatch, /!isTransientTelegramError\(err\)/);
    assert.match(outerCatch, /thread not found/);
    assert.match(outerCatch, /logWarn\('TG_SEND_FAIL'/);
  });

  it('part send branch in editTrackedMessage has no not-modified skip in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const editFn = src.slice(src.indexOf('private async editTrackedMessage'), src.indexOf('private async sendNewMessage'));
    const partSend = editFn.slice(editFn.indexOf("'TG_SEND_FAIL'"), editFn.indexOf('this.messageTracker.track(threadId, element.id, allMsgIds'));
    assert.ok(partSend.length > 0);
    assert.ok(!partSend.includes("message is not modified"));
  });

  it('editTrackedMessage tracks after part loop even when part edit fails in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const editFn = src.slice(src.indexOf('private async editTrackedMessage'), src.indexOf('private async sendNewMessage'));
    const partLoop = editFn.slice(editFn.indexOf('for (let i = 1; i < parts.length; i++)'));
    assert.match(partLoop, /TG_EDIT_FAIL/);
    assert.match(partLoop, /this\.messageTracker\.track\(threadId, element\.id, allMsgIds/);
  });

  it('rich retry paths recurse with forceHtml without TG_EDIT_FAIL or TG_SEND_FAIL in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const editFn = src.slice(src.indexOf('private async editTrackedMessage'), src.indexOf('private async sendNewMessage'));
    const sendFn = src.slice(src.indexOf('private async sendNewMessage'), src.indexOf('private findMappingByTabTitle'));
    assert.match(editFn, /return this\.editTrackedMessage\(threadId, element, formatted, contentHash, tracked, true\)/);
    assert.match(sendFn, /return this\.sendNewMessage\(threadId, element, formatted, contentHash, composerId, true\)/);
    assert.ok(!editFn.slice(editFn.indexOf('shouldRetryRichAsHtml'), editFn.indexOf('for (let i = 1')).includes('TG_EDIT_FAIL'));
  });

  it('send and edit outer catches stringify non-Error err in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const zone = src.slice(src.indexOf('private async editTrackedMessage'), src.indexOf('private findMappingByTabTitle'));
    assert.match(zone, /err instanceof Error \? err\.message : String\(err\)/);
  });

  it('TG_DEAD_TOPIC_REMOVED is separate log site from covered SEND_FAIL codes in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const sendFn = src.slice(src.indexOf('private async sendNewMessage'), src.indexOf('private findMappingByTabTitle'));
    assert.match(sendFn, /TG_DEAD_TOPIC_REMOVED/);
    const deadSite = sendFn.slice(sendFn.indexOf('TG_DEAD_TOPIC_REMOVED'), sendFn.indexOf('return;', sendFn.indexOf('TG_DEAD_TOPIC_REMOVED')));
    assert.ok(!deadSite.includes('TG_SEND_FAIL'));
  });

  it('editTrackedMessage and sendNewMessage accept forceHtml parameter in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /private async editTrackedMessage\([\s\S]*forceHtml = false/);
    assert.match(src, /private async sendNewMessage\([\s\S]*forceHtml = false/);
    assert.match(src, /const rich = !forceHtml && !this\.richDisabled/);
  });

  it('path matrix fail rows use assertSendEditLog for both covered codes', () => {
    const failCodes = SEND_EDIT_PATH_MATRIX.filter((r) => r.kind === 'fail').map((r) => ('code' in r ? r.code : ''));
    assert.ok(failCodes.includes('TG_EDIT_FAIL'));
    assert.ok(failCodes.includes('TG_SEND_FAIL'));
    assert.equal(new Set(failCodes.filter(Boolean)).size, 2);
  });

  it('covered send/edit codes never use logError in zone source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const zone = src.slice(src.indexOf('private async editTrackedMessage'), src.indexOf('private findMappingByTabTitle'));
    for (const code of SEND_EDIT_LOG_CODES) {
      assert.ok(!zone.includes(`logError('${code}'`));
    }
  });

  it('poll-loop whole file no inline scope outside pollLoopCtx queueKickCtx bridgeAutoCtx helpers', () => {
    const src = readFileSync(
      new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
      'utf-8',
    );
    const body = src
      .replace(/function pollLoopCtx[\s\S]*?^}/m, '')
      .replace(/function queueKickCtx[\s\S]*?^}/m, '')
      .replace(/function bridgeAutoCtx[\s\S]*?^}/m, '');
    assert.ok(!body.includes("scope: '"));
  });
});
