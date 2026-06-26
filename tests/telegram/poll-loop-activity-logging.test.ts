import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ChatElement, TelegramConfig } from '../../src/core/types.js';
import type { StateManager } from '../../src/state/broadcast.js';
import type { WindowMonitor, WindowSnapshot } from '../../src/state/windows.js';
import type { CommandExecutor } from '../../src/ide/actions/navigation.js';
import type { CDPBridge } from '../../src/ide/cdp-session.js';
import type { TelegramApiClient } from '../../src/telegram/types.js';
import { AGENT_ACTIVITY_STALE_MS } from '../../src/ide/activity-stale.js';
import { ACTIVITY_EDIT_MIN_MS } from '../../src/telegram/ui/edits-notify.js';
import { BaseTelegramTransport } from '../../src/telegram/transport/poll-loop.js';

const BOT_TOKEN = '1234567890:ABCDEFghijklmnopqrsTUVwxyz';
const CHAT_ID = -1001234567890;
const THREAD_ID = 4242;
const WINDOW_ID = 'win-1';
const ACTIVITY_MSG_ID = 8801;
const ACTIVITY_TEXT = 'Planning next moves';

const ACTIVITY_LOG_CODES = [
  'TG_ACTIVITY_OK',
  'TG_ACTIVITY_DELETED',
  'TG_ACTIVITY_STALE',
  'TG_ACTIVITY_CLEANUP',
  'TG_ACTIVITY_SEND_FAIL',
] as const;

type ActivityPrivates = {
  doProcessWindow(windowId: string, snapshot: WindowSnapshot): Promise<void>;
  deleteActivityMessage(threadId: number): void;
  deleteAllActivityMessages(): void;
  cleanStaleActivity(): void;
  cleanupPersistedActivity(): void;
  activityMsgIds: Map<number, number>;
  lastActivityText: Map<number, string>;
  activityTimestamps: Map<number, number>;
  lastActivityEditAt: Map<number, number>;
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

function assertActivityLog(
  lines: string[],
  code: string,
  need: {
    threadId?: number;
    chatId?: number;
    op?: string;
    text?: string;
    hint?: string;
    omitThreadId?: boolean;
  } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.hint && !l.includes(`hint=${need.hint}`)) return false;
    if (need.threadId !== undefined && !l.includes(`threadId=${need.threadId}`)) return false;
    if (need.chatId !== undefined && !l.includes(`chatId=${need.chatId}`)) return false;
    if (need.omitThreadId && l.includes('threadId=')) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.hint ? `hint=${need.hint}` : '',
    need.threadId !== undefined ? `threadId=${need.threadId}` : '',
    need.chatId !== undefined ? `chatId=${need.chatId}` : '',
    need.omitThreadId ? 'no threadId' : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing activity log: ${desc}`);
  assert.ok(line!.includes('scope=telegram'), `${code} missing scope=telegram`);
}

function assertNoActivityLogs(lines: string[]): void {
  const hit = lines.find((l) => ACTIVITY_LOG_CODES.some((code) => l.includes(`code=${code}`)));
  assert.ok(!hit, `unexpected activity log: ${hit}`);
}

function priv(probe: ActivityProbe): ActivityPrivates {
  return probe as unknown as ActivityPrivates;
}

function redundantThoughtMessage(): ChatElement {
  return {
    type: 'thought',
    id: 't1',
    flatIndex: 0,
    duration: '',
    action: ACTIVITY_TEXT,
    thoughtKind: 'step_summary',
  };
}

function activitySnapshot(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    windowId: WINDOW_ID,
    windowTitle: 'Project',
    messages: [],
    chatTabs: [
      { title: 'Tab1', isActive: true, composerId: 'c1', status: '', selectorPath: '' },
    ],
    pendingApprovals: [],
    agentStatus: 'thinking',
    agentActivityText: ACTIVITY_TEXT,
    agentActivityLive: true,
    agentActivitySource: 'dom',
    composerQueue: { items: [] },
    mode: { current: 'agent', available: [] },
    model: { current: 'gpt-4', currentId: 'gpt-4' },
    lastUpdated: Date.now(),
    activeComposerId: 'c1',
    questionnaire: null,
    ...overrides,
  };
}

function makeStateManager(): StateManager {
  const ee = new EventEmitter();
  return {
    on: (ev: string, fn: (...args: unknown[]) => void) => {
      ee.on(ev, fn);
    },
    off: (ev: string, fn: (...args: unknown[]) => void) => {
      ee.off(ev, fn);
    },
    getCurrentState: () =>
      ({
        connected: true,
        extractorStatus: 'ok',
        windows: [{ id: WINDOW_ID, title: 'Project' }],
        activeWindowId: WINDOW_ID,
        chatTabs: [{ title: 'Tab1', isActive: true, composerId: 'c1', status: '', selectorPath: '' }],
        pendingApprovals: [],
        questionnaire: null,
        agentStatus: 'thinking',
      }) as ReturnType<StateManager['getCurrentState']>,
  } as unknown as StateManager;
}

function makeWindowMonitor(): WindowMonitor {
  const ee = new EventEmitter();
  return {
    on: (ev: string, fn: (...args: unknown[]) => void) => {
      ee.on(ev, fn);
    },
    off: (ev: string, fn: (...args: unknown[]) => void) => {
      ee.off(ev, fn);
    },
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

function registerThread(probe: ActivityProbe, extra: { notifyMode?: string } = {}): void {
  probe.topicManager.registerMapping({
    threadId: THREAD_ID,
    windowId: WINDOW_ID,
    windowTitle: 'Project',
    tabTitle: 'Tab1',
    lastActive: Date.now(),
    ...(extra.notifyMode ? { notifyMode: extra.notifyMode } : {}),
  });
}

function stubApi(overrides: Partial<TelegramApiClient> = {}): TelegramApiClient {
  return {
    sendMessage: async () => ({ message_id: ACTIVITY_MSG_ID }),
    editMessageText: async () => {},
    deleteMessage: async () => {},
    editForumTopic: async () => {},
    ...overrides,
  } as unknown as TelegramApiClient;
}

class ActivityProbe extends BaseTelegramTransport {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  wireHarness(api?: TelegramApiClient): void {
    this.api = api ?? stubApi();
    this.buildCommandDeps().setSyncEnabled(true, CHAT_ID);
  }

  runDoProcessWindow(windowId: string, snapshot: WindowSnapshot): Promise<void> {
    return priv(this).doProcessWindow(windowId, snapshot);
  }

  runDeleteActivity(threadId: number): void {
    priv(this).deleteActivityMessage(threadId);
  }

  runCleanStaleActivity(): void {
    priv(this).cleanStaleActivity();
  }

  runCleanupPersistedActivity(): void {
    priv(this).cleanupPersistedActivity();
  }

  runDeleteAllActivity(): void {
    priv(this).deleteAllActivityMessages();
  }

  clearGroupId(): void {
    (this as unknown as { groupId: number | undefined }).groupId = undefined;
  }
}

function activityFilePath(dataDir: string): string {
  return join(dataDir, 'telegram-activity.json');
}

function readActivityFile(dataDir: string): Record<string, number> {
  return JSON.parse(readFileSync(activityFilePath(dataDir), 'utf-8')) as Record<string, number>;
}

function makeProbe(dataDir: string): ActivityProbe {
  process.env.DATA_DIR = dataDir;
  return new ActivityProbe(
    baseConfig(),
    makeWindowMonitor(),
    makeStateManager(),
    {} as CommandExecutor,
    {} as CDPBridge,
  );
}

function activityZoneSrc(): string {
  const src = readFileSync(
    new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
    'utf-8',
  );
  const helperStart = src.indexOf('private deleteActivityMessage');
  const helperEnd = src.indexOf('// --- Sync state persistence ---');
  const procStart = src.indexOf('const activityText = snapshot.agentActivityLive');
  const procEnd = src.indexOf('if (shouldSendComposerQueue(notifyMode)');
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'activity helper zone bounds');
  assert.ok(procStart >= 0 && procEnd > procStart, 'activity processWindow zone bounds');
  return src.slice(helperStart, helperEnd) + src.slice(procStart, procEnd);
}

describe('poll-loop activity logging', () => {
  let dataDir: string;
  let savedDataDir: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-poll-activity-'));
    savedDataDir = process.env.DATA_DIR;
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('logs TG_ACTIVITY_OK on send_activity with threadId and chatId', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness(stubApi({ sendMessage: async () => ({ message_id: 901 }) }));

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    assertActivityLog(lines, 'TG_ACTIVITY_OK', {
      op: 'send_activity',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      text: ACTIVITY_TEXT,
    });
    assert.equal(priv(probe).activityMsgIds.get(THREAD_ID), 901);
  });

  it('logs TG_ACTIVITY_SEND_FAIL on sendMessage failure with pollLoopCtx', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw new Error('activity send failed');
        },
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    assertActivityLog(lines, 'TG_ACTIVITY_SEND_FAIL', {
      op: 'send_activity',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      text: 'activity send failed',
    });
  });

  it('logs TG_ACTIVITY_SEND_FAIL when send throws non-Error value', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw 'plain activity fail';
        },
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    assertActivityLog(lines, 'TG_ACTIVITY_SEND_FAIL', {
      op: 'send_activity',
      threadId: THREAD_ID,
      text: 'plain activity fail',
    });
  });

  it('logs TG_ACTIVITY_DELETED on deleteActivityMessage with hint msgId', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);

    const lines = await captureAll(async () => {
      probe.runDeleteActivity(THREAD_ID);
    });

    assertActivityLog(lines, 'TG_ACTIVITY_DELETED', {
      op: 'delete_activity',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      hint: String(ACTIVITY_MSG_ID),
    });
    assert.equal(priv(probe).activityMsgIds.has(THREAD_ID), false);
  });

  it('logs TG_ACTIVITY_STALE before deleting stale activity message', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);
    priv(probe).activityTimestamps.set(THREAD_ID, Date.now() - AGENT_ACTIVITY_STALE_MS - 1000);

    const lines = await captureAll(async () => {
      probe.runCleanStaleActivity();
    });

    assertActivityLog(lines, 'TG_ACTIVITY_STALE', {
      op: 'clean_stale',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
    });
    assertActivityLog(lines, 'TG_ACTIVITY_DELETED', { op: 'delete_activity', threadId: THREAD_ID });
  });

  it('logs TG_ACTIVITY_CLEANUP on persisted activity file with chatId hint count', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    writeFileSync(join(dataDir, 'telegram-activity.json'), JSON.stringify({ [String(THREAD_ID)]: 777 }));

    const lines = await captureAll(async () => {
      probe.runCleanupPersistedActivity();
    });

    assertActivityLog(lines, 'TG_ACTIVITY_CLEANUP', {
      op: 'cleanup_persisted',
      chatId: CHAT_ID,
      hint: '1',
      omitThreadId: true,
    });
  });

  it('activity editMessageText failure stays silent without TG_ACTIVITY_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => ({ message_id: 902 }),
        editMessageText: async () => {
          throw new Error('edit activity failed');
        },
      }),
    );

    await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    priv(probe).lastActivityEditAt.set(THREAD_ID, 0);

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(
        WINDOW_ID,
        activitySnapshot({ agentActivityText: 'Reading files' }),
      );
    });

    assertNoActivityLogs(lines);
  });

  it('activity edit message is not modified stays silent without TG_ACTIVITY_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => ({ message_id: 903 }),
        editMessageText: async () => {
          throw new Error('message is not modified');
        },
      }),
    );

    await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    priv(probe).lastActivityEditAt.set(THREAD_ID, 0);

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(
        WINDOW_ID,
        activitySnapshot({ agentActivityText: 'Different label' }),
      );
    });

    assertNoActivityLogs(lines);
  });

  it('deleteActivityMessage without tracked msgId stays silent without TG_ACTIVITY_DELETED', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      probe.runDeleteActivity(THREAD_ID);
    });

    assertNoActivityLogs(lines);
  });

  it('cleanStaleActivity when timestamp fresh stays silent without TG_ACTIVITY_STALE', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);
    priv(probe).activityTimestamps.set(THREAD_ID, Date.now());

    const lines = await captureAll(async () => {
      probe.runCleanStaleActivity();
    });

    assertNoActivityLogs(lines);
  });

  it('cleanupPersistedActivity without file stays silent without TG_ACTIVITY_CLEANUP', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      probe.runCleanupPersistedActivity();
    });

    assertNoActivityLogs(lines);
  });

  it('cleanupPersistedActivity with empty file stays silent without TG_ACTIVITY_CLEANUP', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    writeFileSync(join(dataDir, 'telegram-activity.json'), '{}');

    const lines = await captureAll(async () => {
      probe.runCleanupPersistedActivity();
    });

    assertNoActivityLogs(lines);
  });

  it('doProcessWindow without chatId stays silent without activity logs', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    assertNoActivityLogs(lines);
  });

  it('quiet notify mode deletes existing activity with TG_ACTIVITY_DELETED silently of SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe, { notifyMode: 'quiet' });
    probe.wireHarness();
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);
    priv(probe).lastActivityText.set(THREAD_ID, ACTIVITY_TEXT);

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    assertActivityLog(lines, 'TG_ACTIVITY_DELETED', { op: 'delete_activity', threadId: THREAD_ID });
    assert.ok(!lines.some((l) => l.includes('code=TG_ACTIVITY_OK')));
    assert.ok(!lines.some((l) => l.includes('code=TG_ACTIVITY_SEND_FAIL')));
  });

  it('redundant activity with in-progress step summary deletes existing message silently of OK', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(
        WINDOW_ID,
        activitySnapshot({ messages: [redundantThoughtMessage()] }),
      );
    });

    assertActivityLog(lines, 'TG_ACTIVITY_DELETED', { op: 'delete_activity', threadId: THREAD_ID });
    assert.ok(!lines.some((l) => l.includes('code=TG_ACTIVITY_OK')));
  });

  it('cleared agentActivityLive deletes activity with TG_ACTIVITY_DELETED without SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(
        WINDOW_ID,
        activitySnapshot({ agentActivityLive: false, agentActivityText: null }),
      );
    });

    assertActivityLog(lines, 'TG_ACTIVITY_DELETED', { op: 'delete_activity', threadId: THREAD_ID });
    assert.ok(!lines.some((l) => l.includes('code=TG_ACTIVITY_SEND_FAIL')));
  });

  it('unchanged activity text skips edit silently without TG_ACTIVITY_OK or SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    let editCalls = 0;
    probe.wireHarness(
      stubApi({
        sendMessage: async () => ({ message_id: 904 }),
        editMessageText: async () => {
          editCalls += 1;
        },
      }),
    );

    await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    assertNoActivityLogs(lines);
    assert.equal(editCalls, 0);
  });

  it('deferred activity edit within ACTIVITY_EDIT_MIN_MS stays silent without TG_ACTIVITY_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    let editCalls = 0;
    probe.wireHarness(
      stubApi({
        sendMessage: async () => ({ message_id: 905 }),
        editMessageText: async () => {
          editCalls += 1;
        },
      }),
    );

    await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    priv(probe).lastActivityEditAt.set(THREAD_ID, Date.now());

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(
        WINDOW_ID,
        activitySnapshot({ agentActivityText: 'New activity label' }),
      );
    });

    assertNoActivityLogs(lines);
    assert.equal(editCalls, 0);
  });

  it('logs exactly one TG_ACTIVITY_SEND_FAIL per send failure', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw new Error('once only');
        },
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    const hits = lines.filter((l) => l.includes('code=TG_ACTIVITY_SEND_FAIL'));
    assert.equal(hits.length, 1);
  });

  it('logs exactly one TG_ACTIVITY_OK on first activity send', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    const hits = lines.filter((l) => l.includes('code=TG_ACTIVITY_OK'));
    assert.equal(hits.length, 1);
  });

  it('TG_ACTIVITY_OK send path does not emit TG_ACTIVITY_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    assertActivityLog(lines, 'TG_ACTIVITY_OK', { op: 'send_activity' });
    assert.ok(!lines.some((l) => l.includes('code=TG_ACTIVITY_SEND_FAIL')));
  });

  it('deleteActivityMessage API failure still logs TG_ACTIVITY_DELETED without SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        deleteMessage: async () => {
          throw new Error('telegram delete failed');
        },
      }),
    );
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);

    const lines = await captureAll(async () => {
      probe.runDeleteActivity(THREAD_ID);
    });

    assertActivityLog(lines, 'TG_ACTIVITY_DELETED', { op: 'delete_activity', threadId: THREAD_ID });
    assert.ok(!lines.some((l) => l.includes('code=TG_ACTIVITY_SEND_FAIL')));
  });

  it('final notify mode deletes existing activity with TG_ACTIVITY_DELETED without OK', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe, { notifyMode: 'final' });
    probe.wireHarness();
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    assertActivityLog(lines, 'TG_ACTIVITY_DELETED', { op: 'delete_activity', threadId: THREAD_ID });
    assert.ok(!lines.some((l) => l.includes('code=TG_ACTIVITY_OK')));
  });

  it('deleteAllActivityMessages logs TG_ACTIVITY_DELETED for each tracked thread', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    const otherThread = THREAD_ID + 1;
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);
    priv(probe).activityMsgIds.set(otherThread, ACTIVITY_MSG_ID + 1);

    const lines = await captureAll(async () => {
      probe.runDeleteAllActivity();
    });

    const hits = lines.filter((l) => l.includes('code=TG_ACTIVITY_DELETED'));
    assert.equal(hits.length, 2);
    assert.ok(hits.some((l) => l.includes(`threadId=${THREAD_ID}`)));
    assert.ok(hits.some((l) => l.includes(`threadId=${otherThread}`)));
  });

  it('successful activity edit updates lastActivityText silently without TG_ACTIVITY_OK', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => ({ message_id: 906 }),
        editMessageText: async () => {},
      }),
    );

    await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    priv(probe).lastActivityEditAt.set(THREAD_ID, 0);

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(
        WINDOW_ID,
        activitySnapshot({ agentActivityText: 'Reading files now' }),
      );
    });

    assertNoActivityLogs(lines);
    assert.equal(priv(probe).lastActivityText.get(THREAD_ID), 'Reading files now');
    assert.ok(priv(probe).activityTimestamps.has(THREAD_ID));
  });

  it('logs TG_ACTIVITY_CLEANUP with hint 2 for two persisted entries', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    writeFileSync(
      join(dataDir, 'telegram-activity.json'),
      JSON.stringify({ [String(THREAD_ID)]: 777, '9999': 888 }),
    );

    const lines = await captureAll(async () => {
      probe.runCleanupPersistedActivity();
    });

    assertActivityLog(lines, 'TG_ACTIVITY_CLEANUP', { op: 'cleanup_persisted', hint: '2' });
  });

  it('cleanupPersistedActivity delete API failure stays silent after TG_ACTIVITY_CLEANUP', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        deleteMessage: async () => {
          throw new Error('cleanup delete failed');
        },
      }),
    );
    writeFileSync(join(dataDir, 'telegram-activity.json'), JSON.stringify({ [String(THREAD_ID)]: 777 }));

    const lines = await captureAll(async () => {
      probe.runCleanupPersistedActivity();
    });

    assertActivityLog(lines, 'TG_ACTIVITY_CLEANUP', { op: 'cleanup_persisted' });
    assert.equal(readFileSync(join(dataDir, 'telegram-activity.json'), 'utf-8'), '{}');
  });

  it('cleanStaleActivity with stale timestamp but no activityMsgId stays silent', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    priv(probe).activityTimestamps.set(THREAD_ID, Date.now() - AGENT_ACTIVITY_STALE_MS - 1000);

    const lines = await captureAll(async () => {
      probe.runCleanStaleActivity();
    });

    assertNoActivityLogs(lines);
  });

  it('redundant activity without existing message stays silent without TG_ACTIVITY_DELETED', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(
        WINDOW_ID,
        activitySnapshot({ messages: [redundantThoughtMessage()] }),
      );
    });

    assertNoActivityLogs(lines);
  });

  it('quiet notify mode without existing activity stays silent without TG_ACTIVITY_OK', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe, { notifyMode: 'quiet' });
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    assertNoActivityLogs(lines);
  });

  it('empty activityText with agentActivityLive clears existing message with TG_ACTIVITY_DELETED', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(
        WINDOW_ID,
        activitySnapshot({ agentActivityText: '', agentActivityLive: true }),
      );
    });

    assertActivityLog(lines, 'TG_ACTIVITY_DELETED', { op: 'delete_activity', threadId: THREAD_ID });
    assert.ok(!lines.some((l) => l.includes('code=TG_ACTIVITY_OK')));
  });

  it('agentActivityLive false skips send even when activityText present', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    let sendCalls = 0;
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          sendCalls += 1;
          return { message_id: 907 };
        },
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(
        WINDOW_ID,
        activitySnapshot({ agentActivityLive: false, agentActivityText: ACTIVITY_TEXT }),
      );
    });

    assertNoActivityLogs(lines);
    assert.equal(sendCalls, 0);
  });

  it('TG_ACTIVITY_SEND_FAIL does not emit TG_ACTIVITY_OK or TG_ACTIVITY_DELETED', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw new Error('isolated send fail');
        },
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    assertActivityLog(lines, 'TG_ACTIVITY_SEND_FAIL', { op: 'send_activity' });
    assert.ok(!lines.some((l) => l.includes('code=TG_ACTIVITY_OK')));
    assert.ok(!lines.some((l) => l.includes('code=TG_ACTIVITY_DELETED')));
  });

  it('TG_ACTIVITY_STALE path does not emit TG_ACTIVITY_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);
    priv(probe).activityTimestamps.set(THREAD_ID, Date.now() - AGENT_ACTIVITY_STALE_MS - 1000);

    const lines = await captureAll(async () => {
      probe.runCleanStaleActivity();
    });

    assertActivityLog(lines, 'TG_ACTIVITY_STALE', { op: 'clean_stale' });
    assert.ok(!lines.some((l) => l.includes('code=TG_ACTIVITY_SEND_FAIL')));
  });

  it('doProcessWindow with empty chatTabs stays silent without activity logs', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot({ chatTabs: [] }));
    });

    assertNoActivityLogs(lines);
  });

  it('deleteActivityMessage clears lastActivityText and activityTimestamps without SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);
    priv(probe).lastActivityText.set(THREAD_ID, ACTIVITY_TEXT);
    priv(probe).activityTimestamps.set(THREAD_ID, Date.now());

    const lines = await captureAll(async () => {
      probe.runDeleteActivity(THREAD_ID);
    });

    assertActivityLog(lines, 'TG_ACTIVITY_DELETED', { op: 'delete_activity', threadId: THREAD_ID });
    assert.equal(priv(probe).lastActivityText.has(THREAD_ID), false);
    assert.equal(priv(probe).activityTimestamps.has(THREAD_ID), false);
    assert.ok(!lines.some((l) => l.includes('code=TG_ACTIVITY_SEND_FAIL')));
  });

  it('TG_ACTIVITY_OK persists msgId to telegram-activity.json after send', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness(stubApi({ sendMessage: async () => ({ message_id: 907 }) }));

    await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    assert.deepEqual(readActivityFile(dataDir), { [String(THREAD_ID)]: 907 });
  });

  it('TG_ACTIVITY_SEND_FAIL leaves activityMsgIds empty and skips persistence file', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          throw new Error('no persist on fail');
        },
      }),
    );

    await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    assert.equal(priv(probe).activityMsgIds.has(THREAD_ID), false);
    assert.equal(existsSync(activityFilePath(dataDir)), false);
  });

  it('TG_ACTIVITY_STALE log line precedes TG_ACTIVITY_DELETED in output order', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);
    priv(probe).activityTimestamps.set(THREAD_ID, Date.now() - AGENT_ACTIVITY_STALE_MS - 5000);

    const lines = await captureAll(async () => {
      probe.runCleanStaleActivity();
    });

    const staleIdx = lines.findIndex((l) => l.includes('code=TG_ACTIVITY_STALE'));
    const deletedIdx = lines.findIndex((l) => l.includes('code=TG_ACTIVITY_DELETED'));
    assert.ok(staleIdx >= 0 && deletedIdx >= 0);
    assert.ok(staleIdx < deletedIdx, 'STALE must precede DELETED');
  });

  it('cleanupPersistedActivity with malformed JSON stays silent without TG_ACTIVITY_CLEANUP', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    writeFileSync(activityFilePath(dataDir), '{not-json');

    const lines = await captureAll(async () => {
      probe.runCleanupPersistedActivity();
    });

    assertNoActivityLogs(lines);
  });

  it('cleanupPersistedActivity without chatId logs CLEANUP and skips deleteMessage API', async () => {
    let deleteCalls = 0;
    const probe = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        deleteMessage: async () => {
          deleteCalls++;
        },
      }),
    );
    probe.clearGroupId();
    writeFileSync(activityFilePath(dataDir), JSON.stringify({ [String(THREAD_ID)]: 777 }));

    const lines = await captureAll(async () => {
      probe.runCleanupPersistedActivity();
    });

    assertActivityLog(lines, 'TG_ACTIVITY_CLEANUP', {
      op: 'cleanup_persisted',
      hint: '1',
      omitThreadId: true,
    });
    assert.equal(deleteCalls, 0);
    assert.deepEqual(readActivityFile(dataDir), {});
  });

  it('deleteActivityMessage removes thread from telegram-activity.json', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    writeFileSync(activityFilePath(dataDir), JSON.stringify({ [String(THREAD_ID)]: ACTIVITY_MSG_ID, '9999': 888 }));
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);
    priv(probe).activityMsgIds.set(9999, 888);

    await captureAll(async () => {
      probe.runDeleteActivity(THREAD_ID);
    });

    assert.deepEqual(readActivityFile(dataDir), { '9999': 888 });
  });

  it('successful activity edit sets lastActivityEditAt silently without TG_ACTIVITY_OK', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => ({ message_id: 908 }),
        editMessageText: async () => {},
      }),
    );

    await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    priv(probe).lastActivityEditAt.set(THREAD_ID, 0);

    const before = Date.now();
    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(
        WINDOW_ID,
        activitySnapshot({ agentActivityText: 'Scanning workspace' }),
      );
    });
    const after = Date.now();

    assertNoActivityLogs(lines);
    const editedAt = priv(probe).lastActivityEditAt.get(THREAD_ID) ?? 0;
    assert.ok(editedAt >= before && editedAt <= after);
  });

  it('empty agentActivityText with agentActivityLive true clears existing message with DELETED', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);
    priv(probe).lastActivityText.set(THREAD_ID, ACTIVITY_TEXT);

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(
        WINDOW_ID,
        activitySnapshot({ agentActivityLive: true, agentActivityText: '' }),
      );
    });

    assertActivityLog(lines, 'TG_ACTIVITY_DELETED', { op: 'delete_activity', threadId: THREAD_ID });
    assert.ok(!lines.some((l) => l.includes('code=TG_ACTIVITY_OK')));
  });

  it('doProcessWindow with two inactive chatTabs stays silent without activity logs', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(
        WINDOW_ID,
        activitySnapshot({
          chatTabs: [
            { title: 'TabA', isActive: false, composerId: 'c1', status: '', selectorPath: '' },
            { title: 'TabB', isActive: false, composerId: 'c2', status: '', selectorPath: '' },
          ],
        }),
      );
    });

    assertNoActivityLogs(lines);
  });

  it('TG_ACTIVITY_OK sets lastActivityText and activityTimestamps on first send', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    const nowBefore = Date.now();
    probe.wireHarness(stubApi({ sendMessage: async () => ({ message_id: 909 }) }));

    await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    assert.equal(priv(probe).lastActivityText.get(THREAD_ID), ACTIVITY_TEXT);
    const ts = priv(probe).activityTimestamps.get(THREAD_ID) ?? 0;
    assert.ok(ts >= nowBefore);
  });

  it('TG_ACTIVITY_DELETED after cleanStale removes tracked msgId without SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);
    priv(probe).activityTimestamps.set(THREAD_ID, Date.now() - AGENT_ACTIVITY_STALE_MS - 2000);

    const lines = await captureAll(async () => {
      probe.runCleanStaleActivity();
    });

    assert.equal(priv(probe).activityMsgIds.has(THREAD_ID), false);
    assertActivityLog(lines, 'TG_ACTIVITY_STALE', { op: 'clean_stale', threadId: THREAD_ID });
    assert.ok(!lines.some((l) => l.includes('code=TG_ACTIVITY_SEND_FAIL')));
  });

  it('cleanupPersistedActivity with chatId calls deleteMessage for each persisted entry', async () => {
    let deleteCalls = 0;
    const probe = makeProbe(dataDir);
    probe.wireHarness(
      stubApi({
        deleteMessage: async () => {
          deleteCalls++;
        },
      }),
    );
    writeFileSync(
      activityFilePath(dataDir),
      JSON.stringify({ [String(THREAD_ID)]: 777, '9999': 888 }),
    );

    const lines = await captureAll(async () => {
      probe.runCleanupPersistedActivity();
    });

    assert.equal(deleteCalls, 2);
    assertActivityLog(lines, 'TG_ACTIVITY_CLEANUP', { op: 'cleanup_persisted', hint: '2', omitThreadId: true });
    assert.deepEqual(readActivityFile(dataDir), {});
  });

  it('deleteAllActivityMessages empties activityMsgIds and telegram-activity.json', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    writeFileSync(
      activityFilePath(dataDir),
      JSON.stringify({ [String(THREAD_ID)]: ACTIVITY_MSG_ID, '9999': 888 }),
    );
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);
    priv(probe).activityMsgIds.set(9999, 888);

    const lines = await captureAll(async () => {
      probe.runDeleteAllActivity();
    });

    assert.equal(priv(probe).activityMsgIds.size, 0);
    assert.deepEqual(readActivityFile(dataDir), {});
    assert.equal(lines.filter((l) => l.includes('code=TG_ACTIVITY_DELETED')).length, 2);
  });

  it('deleteAllActivityMessages with empty map stays silent without TG_ACTIVITY_DELETED', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      probe.runDeleteAllActivity();
    });

    assertNoActivityLogs(lines);
  });

  it('TG_ACTIVITY_STALE log detail includes elapsed seconds suffix', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);
    priv(probe).activityTimestamps.set(THREAD_ID, Date.now() - 32_000);

    const lines = await captureAll(async () => {
      probe.runCleanStaleActivity();
    });

    const staleLine = lines.find((l) => l.includes('code=TG_ACTIVITY_STALE'));
    assert.ok(staleLine, 'missing STALE line');
    assert.match(staleLine!, /\b32s\b/);
  });

  it('send failure then successful retry emits TG_ACTIVITY_SEND_FAIL then TG_ACTIVITY_OK', async () => {
    let attempts = 0;
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => {
          attempts++;
          if (attempts === 1) throw new Error('transient activity send');
          return { message_id: 911 };
        },
      }),
    );

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    assertActivityLog(lines, 'TG_ACTIVITY_SEND_FAIL', { text: 'transient activity send' });
    assertActivityLog(lines, 'TG_ACTIVITY_OK', { op: 'send_activity', threadId: THREAD_ID });
    const failIdx = lines.findIndex((l) => l.includes('code=TG_ACTIVITY_SEND_FAIL'));
    const okIdx = lines.findIndex((l) => l.includes('code=TG_ACTIVITY_OK'));
    assert.ok(failIdx >= 0 && okIdx >= 0 && failIdx < okIdx);
    assert.deepEqual(readActivityFile(dataDir), { [String(THREAD_ID)]: 911 });
  });

  it('deferred edit after ACTIVITY_EDIT_MIN_MS elapses calls editMessageText silently', async () => {
    let editCalls = 0;
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness(
      stubApi({
        sendMessage: async () => ({ message_id: 912 }),
        editMessageText: async () => {
          editCalls++;
        },
      }),
    );

    await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    priv(probe).lastActivityEditAt.set(THREAD_ID, Date.now() - ACTIVITY_EDIT_MIN_MS - 200);

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(
        WINDOW_ID,
        activitySnapshot({ agentActivityText: 'Running terminal command' }),
      );
    });

    assertNoActivityLogs(lines);
    assert.equal(editCalls, 1);
    assert.equal(priv(probe).lastActivityText.get(THREAD_ID), 'Running terminal command');
  });

  it('activitySuppressed in full mode deletes existing message without TG_ACTIVITY_OK resend', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);
    priv(probe).lastActivityText.set(THREAD_ID, ACTIVITY_TEXT);

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(
        WINDOW_ID,
        activitySnapshot({ messages: [redundantThoughtMessage()] }),
      );
    });

    assertActivityLog(lines, 'TG_ACTIVITY_DELETED', { op: 'delete_activity', threadId: THREAD_ID });
    assert.ok(!lines.some((l) => l.includes('code=TG_ACTIVITY_OK')));
    assert.ok(!lines.some((l) => l.includes('code=TG_ACTIVITY_SEND_FAIL')));
  });

  it('TG_ACTIVITY_CLEANUP detail mentions persisted message count in log text', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    writeFileSync(activityFilePath(dataDir), JSON.stringify({ [String(THREAD_ID)]: 777, '9999': 888 }));

    const lines = await captureAll(async () => {
      probe.runCleanupPersistedActivity();
    });

    const cleanupLine = lines.find((l) => l.includes('code=TG_ACTIVITY_CLEANUP'));
    assert.ok(cleanupLine?.includes('2 persisted message(s)'), cleanupLine ?? 'missing CLEANUP line');
  });

  it('TG_ACTIVITY_DELETED log detail includes msgId= prefix in log text', async () => {
    const probe = makeProbe(dataDir);
    probe.wireHarness();
    priv(probe).activityMsgIds.set(THREAD_ID, ACTIVITY_MSG_ID);

    const lines = await captureAll(async () => {
      probe.runDeleteActivity(THREAD_ID);
    });

    const deletedLine = lines.find((l) => l.includes('code=TG_ACTIVITY_DELETED'));
    assert.ok(deletedLine?.includes(`msgId=${ACTIVITY_MSG_ID}`), deletedLine ?? 'missing DELETED line');
  });

  it('second doProcessWindow with unchanged activityText does not emit duplicate TG_ACTIVITY_OK', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness(stubApi({ sendMessage: async () => ({ message_id: 913 }) }));

    await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());

    const lines = await captureAll(async () => {
      await probe.runDoProcessWindow(WINDOW_ID, activitySnapshot());
    });

    assertNoActivityLogs(lines);
    assert.equal(priv(probe).activityMsgIds.get(THREAD_ID), 913);
  });
});

const SILENT_PATH_MARKERS = [
  'editMessageText failure stays silent without TG_ACTIVITY_SEND_FAIL',
  'edit message is not modified stays silent',
  'deleteActivityMessage without tracked msgId stays silent',
  'cleanStaleActivity when timestamp fresh stays silent',
  'cleanupPersistedActivity without file stays silent',
  'cleanupPersistedActivity with empty file stays silent',
  'doProcessWindow without chatId stays silent',
  'unchanged activity text skips edit silently',
  'deferred activity edit within ACTIVITY_EDIT_MIN_MS stays silent',
  'deleteActivityMessage API failure still logs TG_ACTIVITY_DELETED',
  'cleanStaleActivity with stale timestamp but no activityMsgId stays silent',
  'redundant activity without existing message stays silent',
  'quiet notify mode without existing activity stays silent',
  'agentActivityLive false skips send even when activityText present',
  'doProcessWindow with empty chatTabs stays silent',
  'successful activity edit updates lastActivityText silently',
  'cleanupPersistedActivity delete API failure stays silent after TG_ACTIVITY_CLEANUP',
  'cleanupPersistedActivity with malformed JSON stays silent',
  'doProcessWindow with two inactive chatTabs stays silent',
  'successful activity edit sets lastActivityEditAt silently',
  'deleteAllActivityMessages with empty map stays silent',
  'deferred edit after ACTIVITY_EDIT_MIN_MS elapses calls editMessageText silently',
  'second doProcessWindow with unchanged activityText does not emit duplicate TG_ACTIVITY_OK',
] as const;

const ACTIVITY_PATH_MATRIX = [
  { kind: 'info' as const, code: 'TG_ACTIVITY_OK', marker: 'send_activity with threadId and chatId' },
  { kind: 'fail' as const, code: 'TG_ACTIVITY_SEND_FAIL', marker: 'sendMessage failure with pollLoopCtx' },
  { kind: 'fail' as const, code: 'TG_ACTIVITY_SEND_FAIL', marker: 'send throws non-Error value' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_DELETED', marker: 'deleteActivityMessage with hint msgId' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_STALE', marker: 'before deleting stale activity message' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_CLEANUP', marker: 'persisted activity file with chatId hint count' },
  { kind: 'silent' as const, marker: 'activity editMessageText failure stays silent without TG_ACTIVITY_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'activity edit message is not modified stays silent without TG_ACTIVITY_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'deleteActivityMessage without tracked msgId stays silent without TG_ACTIVITY_DELETED' },
  { kind: 'silent' as const, marker: 'cleanStaleActivity when timestamp fresh stays silent without TG_ACTIVITY_STALE' },
  { kind: 'silent' as const, marker: 'cleanupPersistedActivity without file stays silent without TG_ACTIVITY_CLEANUP' },
  { kind: 'silent' as const, marker: 'cleanupPersistedActivity with empty file stays silent without TG_ACTIVITY_CLEANUP' },
  { kind: 'silent' as const, marker: 'doProcessWindow without chatId stays silent without activity logs' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_DELETED', marker: 'quiet notify mode deletes existing activity' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_DELETED', marker: 'redundant activity with in-progress step summary deletes existing message' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_DELETED', marker: 'cleared agentActivityLive deletes activity' },
  { kind: 'silent' as const, marker: 'unchanged activity text skips edit silently without TG_ACTIVITY_OK or SEND_FAIL' },
  { kind: 'silent' as const, marker: 'deferred activity edit within ACTIVITY_EDIT_MIN_MS stays silent without TG_ACTIVITY_SEND_FAIL' },
  { kind: 'fail' as const, code: 'TG_ACTIVITY_SEND_FAIL', marker: 'exactly one TG_ACTIVITY_SEND_FAIL per send failure' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_OK', marker: 'exactly one TG_ACTIVITY_OK on first activity send' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_OK', marker: 'send path does not emit TG_ACTIVITY_SEND_FAIL' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_DELETED', marker: 'deleteActivityMessage API failure still logs TG_ACTIVITY_DELETED' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_DELETED', marker: 'final notify mode deletes existing activity' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_DELETED', marker: 'deleteAllActivityMessages logs TG_ACTIVITY_DELETED for each tracked thread' },
  { kind: 'silent' as const, marker: 'successful activity edit updates lastActivityText silently without TG_ACTIVITY_OK' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_CLEANUP', marker: 'hint 2 for two persisted entries' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_CLEANUP', marker: 'delete API failure stays silent after TG_ACTIVITY_CLEANUP' },
  { kind: 'silent' as const, marker: 'cleanStaleActivity with stale timestamp but no activityMsgId stays silent' },
  { kind: 'silent' as const, marker: 'redundant activity without existing message stays silent without TG_ACTIVITY_DELETED' },
  { kind: 'silent' as const, marker: 'quiet notify mode without existing activity stays silent without TG_ACTIVITY_OK' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_DELETED', marker: 'empty activityText with agentActivityLive clears existing message' },
  { kind: 'silent' as const, marker: 'agentActivityLive false skips send even when activityText present' },
  { kind: 'fail' as const, code: 'TG_ACTIVITY_SEND_FAIL', marker: 'does not emit TG_ACTIVITY_OK or TG_ACTIVITY_DELETED' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_STALE', marker: 'path does not emit TG_ACTIVITY_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'doProcessWindow with empty chatTabs stays silent without activity logs' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_DELETED', marker: 'clears lastActivityText and activityTimestamps without SEND_FAIL' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_OK', marker: 'persists msgId to telegram-activity.json after send' },
  { kind: 'fail' as const, code: 'TG_ACTIVITY_SEND_FAIL', marker: 'leaves activityMsgIds empty and skips persistence file' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_STALE', marker: 'log line precedes TG_ACTIVITY_DELETED in output order' },
  { kind: 'silent' as const, marker: 'cleanupPersistedActivity with malformed JSON stays silent without TG_ACTIVITY_CLEANUP' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_CLEANUP', marker: 'without chatId logs CLEANUP and skips deleteMessage API' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_DELETED', marker: 'deleteActivityMessage removes thread from telegram-activity.json' },
  { kind: 'silent' as const, marker: 'successful activity edit sets lastActivityEditAt silently without TG_ACTIVITY_OK' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_DELETED', marker: 'empty agentActivityText with agentActivityLive true clears existing message' },
  { kind: 'silent' as const, marker: 'doProcessWindow with two inactive chatTabs stays silent without activity logs' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_OK', marker: 'sets lastActivityText and activityTimestamps on first send' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_DELETED', marker: 'after cleanStale removes tracked msgId without SEND_FAIL' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_CLEANUP', marker: 'with chatId calls deleteMessage for each persisted entry' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_DELETED', marker: 'deleteAllActivityMessages empties activityMsgIds and telegram-activity.json' },
  { kind: 'silent' as const, marker: 'deleteAllActivityMessages with empty map stays silent without TG_ACTIVITY_DELETED' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_STALE', marker: 'log detail includes elapsed seconds suffix' },
  { kind: 'fail' as const, code: 'TG_ACTIVITY_SEND_FAIL', marker: 'then successful retry emits TG_ACTIVITY_SEND_FAIL then TG_ACTIVITY_OK' },
  { kind: 'silent' as const, marker: 'deferred edit after ACTIVITY_EDIT_MIN_MS elapses calls editMessageText silently' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_DELETED', marker: 'activitySuppressed in full mode deletes existing message without TG_ACTIVITY_OK resend' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_CLEANUP', marker: 'detail mentions persisted message count in log text' },
  { kind: 'info' as const, code: 'TG_ACTIVITY_DELETED', marker: 'log detail includes msgId= prefix in log text' },
  { kind: 'silent' as const, marker: 'second doProcessWindow with unchanged activityText does not emit duplicate TG_ACTIVITY_OK' },
  { kind: 'meta' as const, marker: 'poll-loop whole file no inline scope outside pollLoopCtx queueKickCtx bridgeAutoCtx helpers' },
] as const;

describe('poll-loop activity logging coverage', () => {
  it('asserts every activity code in test file', () => {
    const src = readFileSync(new URL('./poll-loop-activity-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of ACTIVITY_LOG_CODES) {
      assert.ok(
        src.includes(`assertActivityLog(lines, '${code}'`) || src.includes(`code=${code}`),
        `missing assertion for ${code}`,
      );
    }
    assert.equal(ACTIVITY_LOG_CODES.length, 5);
  });

  it('poll-loop.ts declares all five activity codes in activity zone', () => {
    const zone = activityZoneSrc();
    for (const code of ACTIVITY_LOG_CODES) {
      assert.ok(zone.includes(`'${code}'`), `zone missing ${code}`);
    }
  });

  it('activity zone has zero console.log warn error', () => {
    const zone = activityZoneSrc();
    assert.ok(!zone.includes('console.log('));
    assert.ok(!zone.includes('console.warn('));
    assert.ok(!zone.includes('console.error('));
  });

  it('TG_ACTIVITY_SEND_FAIL uses logWarn with pollLoopCtx send_activity in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /logWarn\('TG_ACTIVITY_SEND_FAIL'/);
    assert.match(zone, /pollLoopCtx\('send_activity', \{[\s\S]*?threadId,[\s\S]*?chatId: this\.chatId/);
  });

  it('activity edit catch stays silent without log in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /editMessageText[\s\S]*?catch \{ \/\* message may be unchanged \*\/ \}/);
    assert.ok(!zone.includes("logWarn('TG_ACTIVITY_EDIT_FAIL'"));
  });

  it('TG_ACTIVITY_DELETED uses logInfo with delete_activity op in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /logInfo\([\s\S]*?'TG_ACTIVITY_DELETED'/);
    assert.match(zone, /pollLoopCtx\('delete_activity'/);
  });

  it('cleanStaleActivity uses AGENT_ACTIVITY_STALE_MS threshold in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /now - ts > AGENT_ACTIVITY_STALE_MS/);
  });

  it('shouldSendActivity guards quiet and final modes in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /if \(!shouldSendActivity\(notifyMode\)\)/);
  });

  it('activitySuppressed deletes existing message in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /if \(activitySuppressed && existingActivityMsgId\)/);
  });

  it('every covered code has assertActivityLog in behavioral tests', () => {
    const src = readFileSync(new URL('./poll-loop-activity-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of ACTIVITY_LOG_CODES) {
      assert.ok(src.includes(`assertActivityLog(lines, '${code}'`), `behavioral missing ${code}`);
    }
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./poll-loop-activity-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent marker: ${marker}`);
    }
  });

  it('path matrix rows map to behavioral test titles', () => {
    const src = readFileSync(new URL('./poll-loop-activity-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of ACTIVITY_PATH_MATRIX) {
      assert.ok(src.includes(row.marker), `matrix row missing test: ${row.marker}`);
    }
    assert.equal(ACTIVITY_PATH_MATRIX.length, 58);
  });

  it('activity zone declares exactly five log emission sites for covered codes', () => {
    const zone = activityZoneSrc();
    assert.equal((zone.match(/logInfo\([\s\S]*?'TG_ACTIVITY_DELETED'/g) ?? []).length, 1);
    assert.equal((zone.match(/logInfo\([\s\S]*?'TG_ACTIVITY_STALE'/g) ?? []).length, 1);
    assert.equal((zone.match(/logInfo\([\s\S]*?'TG_ACTIVITY_CLEANUP'/g) ?? []).length, 1);
    assert.equal((zone.match(/logInfo\([\s\S]*?'TG_ACTIVITY_OK'/g) ?? []).length, 1);
    assert.equal((zone.match(/logWarn\([\s\S]*?'TG_ACTIVITY_SEND_FAIL'/g) ?? []).length, 1);
  });

  it('activity send catch stringifies non-Error err in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /err instanceof Error \? err\.message : String\(err\)/);
  });

  it('activity edit path has no TG_ACTIVITY_OK code in source', () => {
    const zone = activityZoneSrc();
    const proc = zone.slice(zone.indexOf('const activityText = snapshot.agentActivityLive'));
    const editBlock = proc.match(/else if \(activityText && this\.activityMsgIds\.get\(threadId\)[\s\S]*?catch \{ \/\* message may be unchanged \*\/ \}/);
    assert.ok(editBlock, 'edit block missing');
    assert.ok(!editBlock![0].includes('TG_ACTIVITY_OK'));
  });

  it('shouldDeferEdit guards activity edit rate in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /shouldDeferEdit\(lastEdit, ACTIVITY_EDIT_MIN_MS, now\)/);
  });

  it('cleared activityText deletes tracked message in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /if \(!activityText && this\.activityMsgIds\.has\(threadId\)\)/);
  });

  it('automated matrix: fail/info codes have behavioral assertActivityLog', () => {
    const codes = ACTIVITY_PATH_MATRIX.filter((r) => r.kind !== 'silent').map((r) =>
      'code' in r ? r.code : '',
    );
    const unique = [...new Set(codes.filter(Boolean))];
    const src = readFileSync(new URL('./poll-loop-activity-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of unique) {
      assert.ok(src.includes(`assertActivityLog(lines, '${code}'`), `matrix code missing assert: ${code}`);
    }
    assert.equal(unique.length, 5);
  });

  it('deleteAllActivityMessages iterates activityMsgIds keys in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /for \(const threadId of \[\.\.\.this\.activityMsgIds\.keys\(\)\]\)/);
  });

  it('activity OK send calls saveActivityState before TG_ACTIVITY_OK in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /this\.saveActivityState\(\);[\s\S]*?logInfo\([\s\S]*?'TG_ACTIVITY_OK'/);
  });

  it('cleanupPersistedActivity catch stays silent in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /cleanupPersistedActivity[\s\S]*?catch \{ \/\* normal on first run \*\/ \}/);
  });

  it('activityText derived from agentActivityLive in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /const activityText = snapshot\.agentActivityLive \? snapshot\.agentActivityText : null/);
  });

  it('deleteActivityMessage clears activity maps in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /this\.activityMsgIds\.delete\(threadId\)/);
    assert.match(zone, /this\.lastActivityText\.delete\(threadId\)/);
    assert.match(zone, /this\.activityTimestamps\.delete\(threadId\)/);
  });

  it('deleteActivityMessage deleteMessage API uses fire-and-forget catch in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /this\.api\.deleteMessage\(this\.chatId!, msgId\)\.catch\(\(\) => \{\}\)/);
  });

  it('saveActivityState catch stays silent best effort in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /private saveActivityState\(\)[\s\S]*?catch \{ \/\* best effort \*\/ \}/);
  });

  it('cleanupPersistedActivity guards deleteMessage with chatId in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /if \(this\.chatId\) \{[\s\S]*?this\.api\.deleteMessage\(this\.chatId, msgId\)/);
  });

  it('TG_ACTIVITY_STALE message includes elapsed seconds in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /\$\{\(\(now - ts\) \/ 1000\)\.toFixed\(0\)\}s/);
  });

  it('cleanupPersistedActivity writes empty object after delete loop in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /writeFileSync\(activityPath\(\), '\{\}'\)/);
  });

  it('TG_ACTIVITY_OK detail quotes activityText in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /`"\$\{activityText\}" msgId=\$\{sent\.message_id\}`/);
  });

  it('cleanStaleActivity requires activityMsgIds.has before STALE in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /now - ts > AGENT_ACTIVITY_STALE_MS && this\.activityMsgIds\.has\(threadId\)/);
  });

  it('activity send path uses formatActivity before sendMessage in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /const html = formatActivity\(activityText\)/);
    assert.match(zone, /await this\.api\.sendMessage\(this\.chatId!, html/);
  });

  it('deleteAllActivityMessages delegates each key to deleteActivityMessage in source', () => {
    const zone = activityZoneSrc();
    assert.match(zone, /deleteAllActivityMessages[\s\S]*?this\.deleteActivityMessage\(threadId\)/);
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
