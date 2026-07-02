import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Approval, CursorState, Questionnaire, TelegramConfig } from '../../src/core/types.js';
import type { StateManager } from '../../src/state/broadcast.js';
import type { WindowMonitor } from '../../src/state/windows.js';
import type { CommandExecutor } from '../../src/ide/actions/navigation.js';
import type { CDPBridge } from '../../src/ide/cdp-session.js';
import type { TelegramApiClient } from '../../src/telegram/types.js';
import { MessageTracker } from '../../src/telegram/pipeline/tracker.js';
import { BaseTelegramTransport } from '../../src/telegram/transport/poll-loop.js';

const BOT_TOKEN = '1234567890:ABCDEFghijklmnopqrsTUVwxyz';
const CHAT_ID = -1001234567890;
const THREAD_ID = 4242;
const APPROVAL_ID = 'tool:test-approval';

const APPROVAL_QUESTIONNAIRE_LOG_CODES = [
  'TG_APPROVAL_FAIL',
  'TG_QUESTIONNAIRE_FAIL',
  'TG_APPROVAL_ROUTED',
  'TG_APPROVAL_NO_THREAD',
  'TG_QUESTIONNAIRE_SEND_FAIL',
] as const;

type ApprovalQuestPrivates = {
  processApprovals(approvals: CursorState['pendingApprovals']): Promise<void>;
  processApprovalsForThread(
    threadId: number,
    approvals: CursorState['pendingApprovals'],
  ): Promise<void>;
  processQuestionnaire(questionnaire: Questionnaire | null): Promise<void>;
  processQuestionnaireForThread(threadId: number, questionnaire: Questionnaire | null): Promise<void>;
  onStatePatch(patch: Partial<CursorState>): void;
  started: boolean;
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

function assertApprovalQuestLog(
  lines: string[],
  code: string,
  need: {
    threadId?: number;
    chatId?: number;
    itemId?: string;
    op?: string;
    text?: string;
    omitThreadId?: boolean;
  } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.threadId !== undefined && !l.includes(`threadId=${need.threadId}`)) return false;
    if (need.chatId !== undefined && !l.includes(`chatId=${need.chatId}`)) return false;
    if (need.itemId && !l.includes(`itemId=${need.itemId}`)) return false;
    if (need.omitThreadId && l.includes('threadId=')) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.threadId !== undefined ? `threadId=${need.threadId}` : '',
    need.chatId !== undefined ? `chatId=${need.chatId}` : '',
    need.itemId ? `itemId=${need.itemId}` : '',
    need.omitThreadId ? 'no threadId' : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing approval/questionnaire log: ${desc}`);
  assert.ok(line!.includes('scope=telegram'), `${code} missing scope=telegram`);
}

function assertNoApprovalQuestLogs(lines: string[]): void {
  const hit = lines.find((l) =>
    APPROVAL_QUESTIONNAIRE_LOG_CODES.some((code) => l.includes(`code=${code}`)),
  );
  assert.ok(!hit, `unexpected approval/questionnaire log: ${hit}`);
}

async function settle(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

function sampleApproval(id = APPROVAL_ID): Approval {
  return {
    id,
    description: 'Run npm test',
    actions: [
      { label: 'Run', type: 'approve', selectorPath: 'sp-run' },
      { label: 'Skip', type: 'reject', selectorPath: 'sp-skip' },
    ],
  };
}

function acceptAllApproval(): Approval {
  return {
    id: 'tool:accept-all-cmd',
    description: 'Run dangerous command',
    actions: [
      { label: 'Accept all', type: 'approve_all', selectorPath: 'sp-all' },
      { label: 'Skip', type: 'reject', selectorPath: 'sp-skip' },
    ],
  };
}

function junkApproval(): Approval {
  return {
    id: '|Cancel',
    description: 'Pending approval',
    actions: [{ label: 'Cancel', type: 'reject', selectorPath: 'sp1' }],
  };
}

function sampleQuestionnaire(): Questionnaire {
  return {
    questions: [
      {
        number: '1',
        text: 'Pick one',
        options: [
          { letter: 'A', label: 'Option A', selectorPath: 'sp-a', isFreeform: false },
        ],
        isActive: true,
      },
    ],
    activeIndex: 0,
    totalLabel: '1 of 1',
    skipSelectorPath: 'sp-skip',
    continueSelectorPath: 'sp-cont',
    continueDisabled: false,
  };
}

function priv(probe: ApprovalQuestProbe): ApprovalQuestPrivates {
  return probe as unknown as ApprovalQuestPrivates;
}

function defaultState(): Partial<CursorState> {
  return {
    connected: true,
    extractorStatus: 'ok',
    windows: [{ id: 'win-1', title: 'Project' }],
    activeWindowId: 'win-1',
    chatTabs: [
      { title: 'Tab1', isActive: true, composerId: 'c1', status: '', selectorPath: '' },
    ],
    pendingApprovals: [],
    questionnaire: null,
    agentStatus: 'idle',
  };
}

function makeStateManager(extra?: Partial<CursorState>): StateManager {
  const ee = new EventEmitter();
  const snapshot = (): CursorState =>
    ({
      connected: false,
      extractorStatus: 'ok',
      lastExtractionAt: null,
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
      agentStatus: 'idle',
      agentActivityText: null,
      agentActivityLive: false,
      agentActivitySource: 'none',
      messages: [],
      pendingApprovals: [],
      inputAvailable: true,
      chatTabs: [],
      activeComposerId: '',
      mode: { id: '', label: '' },
      model: { id: '', label: '' },
      windows: [],
      activeWindowId: '',
      composerQueue: { items: [] },
      questionnaire: null,
      ...defaultState(),
      ...extra,
    }) as CursorState;
  return {
    on: (ev: string, fn: (...args: unknown[]) => void) => {
      ee.on(ev, fn);
    },
    off: (ev: string, fn: (...args: unknown[]) => void) => {
      ee.off(ev, fn);
    },
    getCurrentState: snapshot,
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

function registerThread(
  probe: ApprovalQuestProbe,
  opts: { windowId?: string; tabTitle?: string } = {},
): void {
  probe.topicManager.registerMapping({
    threadId: THREAD_ID,
    windowId: opts.windowId ?? 'win-1',
    windowTitle: 'Project',
    tabTitle: opts.tabTitle ?? 'Tab1',
    lastActive: Date.now(),
  });
}

class ApprovalQuestProbe extends BaseTelegramTransport {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  wireHarness(api?: TelegramApiClient): void {
    this.api = api ?? ({
      sendMessage: async () => ({ message_id: 9001 }),
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);
    this.buildCommandDeps().setSyncEnabled(true, CHAT_ID);
    priv(this).started = true;
  }

  runProcessApprovals(approvals: CursorState['pendingApprovals']): Promise<void> {
    return priv(this).processApprovals(approvals);
  }

  runProcessApprovalsForThread(
    threadId: number,
    approvals: CursorState['pendingApprovals'],
  ): Promise<void> {
    return priv(this).processApprovalsForThread(threadId, approvals);
  }

  runProcessQuestionnaire(questionnaire: Questionnaire | null): Promise<void> {
    return priv(this).processQuestionnaire(questionnaire);
  }

  runProcessQuestionnaireForThread(
    threadId: number,
    questionnaire: Questionnaire | null,
  ): Promise<void> {
    return priv(this).processQuestionnaireForThread(threadId, questionnaire);
  }

  triggerPatch(patch: Partial<CursorState>): void {
    priv(this).onStatePatch(patch);
  }
}

function makeProbe(dataDir: string, stateExtra?: Partial<CursorState>): ApprovalQuestProbe {
  process.env.DATA_DIR = dataDir;
  return new ApprovalQuestProbe(
    baseConfig(),
    makeWindowMonitor(),
    makeStateManager(stateExtra),
    {} as CommandExecutor,
    {} as CDPBridge,
  );
}

function approvalQuestZoneSrc(): string {
  const src = readFileSync(
    new URL('../../src/telegram/transport/poll-loop.ts', import.meta.url),
    'utf-8',
  );
  const patchStart = src.indexOf('private onStatePatch');
  const patchEnd = src.indexOf("if ('agentStatus' in patch");
  const processStart = src.indexOf('private async processApprovals');
  const processEnd = src.indexOf('// --- Typing indicator ---');
  assert.ok(patchStart >= 0 && patchEnd > patchStart, 'patch zone bounds');
  assert.ok(processStart >= 0 && processEnd > processStart, 'process zone bounds');
  return src.slice(patchStart, patchEnd) + src.slice(processStart, processEnd);
}

describe('poll-loop approval/questionnaire logging', () => {
  let dataDir: string;
  let savedDataDir: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-poll-approval-q-'));
    savedDataDir = process.env.DATA_DIR;
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('logs TG_APPROVAL_FAIL on processApprovals rejection via onStatePatch with threadId', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    mock.method(probe.messageTracker, 'listInThread', () => {
      throw new Error('approval list boom');
    });

    const lines = await captureAll(async () => {
      probe.triggerPatch({ pendingApprovals: [sampleApproval()] });
      await settle();
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_FAIL', {
      op: 'process_approvals',
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'approval list boom',
    });
    mock.restoreAll();
  });

  it('logs TG_QUESTIONNAIRE_FAIL on processQuestionnaire rejection via onStatePatch', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    const p = priv(probe);
    const orig = p.processQuestionnaireForThread.bind(probe);
    p.processQuestionnaireForThread = async () => {
      throw new Error('questionnaire boom');
    };

    const lines = await captureAll(async () => {
      probe.triggerPatch({ questionnaire: sampleQuestionnaire() });
      await settle();
    });

    assertApprovalQuestLog(lines, 'TG_QUESTIONNAIRE_FAIL', {
      op: 'process_questionnaire',
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'questionnaire boom',
    });
    p.processQuestionnaireForThread = orig;
  });

  it('logs TG_APPROVAL_NO_THREAD when approvals present but thread unresolved without threadId', async () => {
    const probe = makeProbe(dataDir, {
      windows: [{ id: 'win-1', title: 'Lonely' }],
      activeWindowId: 'win-1',
      chatTabs: [{ title: 'Orphan', isActive: true, composerId: '', status: '', selectorPath: '' }],
    });
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessApprovals([sampleApproval()]);
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_NO_THREAD', {
      op: 'process_approvals',
      chatId: CHAT_ID,
      omitThreadId: true,
    });
  });

  it('logs TG_APPROVAL_ROUTED on tab-title fallback with pollLoopCtx threadId', async () => {
    const probe = makeProbe(dataDir, {
      windows: [{ id: 'win-1', title: 'Current' }],
      activeWindowId: 'win-1',
      chatTabs: [
        { title: 'FallbackTab', isActive: true, composerId: 'c1', status: '', selectorPath: '' },
      ],
    });
    probe.topicManager.registerMapping({
      threadId: THREAD_ID,
      windowId: 'win-other',
      windowTitle: 'Other',
      tabTitle: 'FallbackTab',
      lastActive: Date.now(),
    });
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 501 }),
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runProcessApprovals([sampleApproval()]);
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_ROUTED', {
      op: 'process_approvals_fallback',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
    });
  });

  it('processApprovalsForThread with actionable approvals does not send approval logs', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    let sendCalls = 0;
    probe.wireHarness({
      sendMessage: async () => {
        sendCalls += 1;
        return { message_id: 601 };
      },
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    assertNoApprovalQuestLogs(lines);
    assert.equal(sendCalls, 0, 'approval UI is run_command in feed, not approval banners');
  });

  it('logs TG_QUESTIONNAIRE_SEND_FAIL on sendMessage failure with threadId', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => {
        throw new Error('send questionnaire failed');
      },
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());
    });

    assertApprovalQuestLog(lines, 'TG_QUESTIONNAIRE_SEND_FAIL', {
      op: 'send_questionnaire',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      text: 'send questionnaire failed',
    });
  });

  it('logs TG_QUESTIONNAIRE_SEND_FAIL on editMessageText failure', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 701 }),
      editMessageText: async () => {
        throw new Error('edit questionnaire failed');
      },
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());

    const changed = sampleQuestionnaire();
    changed.questions[0]!.text = 'Pick another';

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, changed);
    });

    assertApprovalQuestLog(lines, 'TG_QUESTIONNAIRE_SEND_FAIL', {
      op: 'send_questionnaire',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      text: 'edit questionnaire failed',
    });
  });

  it('legacy approval banner deleteMessage failure stays silent without approval logs', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 606 }),
      editMessageText: async () => {},
      deleteMessage: async () => {
        throw new Error('delete failed');
      },
    } as unknown as TelegramApiClient);

    probe.messageTracker.track(THREAD_ID, `approval:${APPROVAL_ID}`, [606], 'legacy-hash', 'approval');

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    assertNoApprovalQuestLogs(lines);
    assert.equal(probe.messageTracker.getTracked(THREAD_ID, `approval:${APPROVAL_ID}`), undefined);
  });

  it('questionnaire message is not modified stays silent without TG_QUESTIONNAIRE_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 702 }),
      editMessageText: async () => {
        throw new Error('message is not modified');
      },
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('questionnaire message not found stays silent without TG_QUESTIONNAIRE_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 703 }),
      editMessageText: async () => {
        throw new Error('message to edit not found');
      },
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());

    const changed = sampleQuestionnaire();
    changed.questions[0]!.text = 'Different';

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, changed);
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('empty approvals without thread stays silent without TG_APPROVAL_NO_THREAD', async () => {
    const probe = makeProbe(dataDir, {
      windows: [{ id: 'win-1', title: 'Lonely' }],
      activeWindowId: 'win-1',
      chatTabs: [{ title: 'Orphan', isActive: true, composerId: '', status: '', selectorPath: '' }],
    });
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessApprovals([]);
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('processApprovals without chatId stays silent without approval logs', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);

    const lines = await captureAll(async () => {
      await probe.runProcessApprovals([sampleApproval()]);
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('junk approval filtered stays silent without approval logs', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [junkApproval()]);
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('unchanged approval content stays silent without approval logs', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('questionnaire without thread stays silent without TG_QUESTIONNAIRE_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir, {
      windows: [{ id: 'win-1', title: 'Lonely' }],
      activeWindowId: 'win-1',
      chatTabs: [{ title: 'Orphan', isActive: true, composerId: '', status: '', selectorPath: '' }],
    });
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaire(sampleQuestionnaire());
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('empty questionnaire clears tracked message silently without TG_QUESTIONNAIRE_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, null);
    });

    assertNoApprovalQuestLogs(lines);
    const tracked = probe.messageTracker.getTracked(THREAD_ID, 'questionnaire');
    assert.deepEqual(tracked?.telegramMsgIds, []);
  });

  it('unchanged questionnaire stays silent without TG_QUESTIONNAIRE_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('logs TG_APPROVAL_FAIL with non-Error rejection message via onStatePatch', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    mock.method(probe.messageTracker, 'listInThread', () => {
      throw 'reject string';
    });

    const lines = await captureAll(async () => {
      probe.triggerPatch({ pendingApprovals: [sampleApproval()] });
      await settle();
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_FAIL', {
      op: 'process_approvals',
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'reject string',
    });
    mock.restoreAll();
  });

  it('successful questionnaire send stays silent without TG_QUESTIONNAIRE_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());
    });

    assertNoApprovalQuestLogs(lines);
    assert.ok(probe.messageTracker.getTracked(THREAD_ID, 'questionnaire')?.telegramMsgIds.length);
  });

  it('onStatePatch skips approval when sync disabled stays silent', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    probe.buildCommandDeps().setSyncEnabled(false);

    const lines = await captureAll(async () => {
      probe.triggerPatch({ pendingApprovals: [sampleApproval()] });
      await settle();
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('logs TG_QUESTIONNAIRE_FAIL with non-Error rejection message via onStatePatch', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    const p = priv(probe);
    const orig = p.processQuestionnaireForThread.bind(probe);
    p.processQuestionnaireForThread = async () => {
      throw 'questionnaire reject string';
    };

    const lines = await captureAll(async () => {
      probe.triggerPatch({ questionnaire: sampleQuestionnaire() });
      await settle();
    });

    assertApprovalQuestLog(lines, 'TG_QUESTIONNAIRE_FAIL', {
      op: 'process_questionnaire',
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'questionnaire reject string',
    });
    p.processQuestionnaireForThread = orig;
  });

  it('logs TG_APPROVAL_FAIL via onStatePatch without threadId when catch omits fallback lookup', async () => {
    const probe = makeProbe(dataDir, {
      windows: [{ id: 'win-1', title: 'Current' }],
      activeWindowId: 'win-1',
      chatTabs: [
        { title: 'FallbackTab', isActive: true, composerId: 'c1', status: '', selectorPath: '' },
      ],
    });
    probe.topicManager.registerMapping({
      threadId: THREAD_ID,
      windowId: 'win-other',
      windowTitle: 'Other',
      tabTitle: 'FallbackTab',
      lastActive: Date.now(),
    });
    probe.wireHarness();
    mock.method(probe.messageTracker, 'listInThread', () => {
      throw new Error('fail before thread');
    });

    const lines = await captureAll(async () => {
      probe.triggerPatch({ pendingApprovals: [sampleApproval()] });
      await settle();
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_FAIL', {
      op: 'process_approvals',
      chatId: CHAT_ID,
      omitThreadId: true,
      text: 'fail before thread',
    });
    mock.restoreAll();
  });

  it('tab-title fallback with empty approvals stays silent without TG_APPROVAL_ROUTED', async () => {
    const probe = makeProbe(dataDir, {
      windows: [{ id: 'win-1', title: 'Current' }],
      activeWindowId: 'win-1',
      chatTabs: [
        { title: 'FallbackTab', isActive: true, composerId: 'c1', status: '', selectorPath: '' },
      ],
    });
    probe.topicManager.registerMapping({
      threadId: THREAD_ID,
      windowId: 'win-other',
      windowTitle: 'Other',
      tabTitle: 'FallbackTab',
      lastActive: Date.now(),
    });
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessApprovals([]);
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('onStatePatch skips questionnaire when sync disabled stays silent', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    probe.buildCommandDeps().setSyncEnabled(false);

    const lines = await captureAll(async () => {
      probe.triggerPatch({ questionnaire: sampleQuestionnaire() });
      await settle();
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('onStatePatch skips approval when started false stays silent', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    priv(probe).started = false;

    const lines = await captureAll(async () => {
      probe.triggerPatch({ pendingApprovals: [sampleApproval()] });
      await settle();
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('processQuestionnaire without chatId stays silent without questionnaire logs', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaire(sampleQuestionnaire());
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('logs exactly one TG_QUESTIONNAIRE_SEND_FAIL per questionnaire send failure', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => {
        throw new Error('q once only');
      },
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());
    });

    const hits = lines.filter((l) => l.includes('code=TG_QUESTIONNAIRE_SEND_FAIL'));
    assert.equal(hits.length, 1);
  });

  it('logs TG_QUESTIONNAIRE_SEND_FAIL when send throws non-Error value', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => {
        throw 'questionnaire plain fail';
      },
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());
    });

    assertApprovalQuestLog(lines, 'TG_QUESTIONNAIRE_SEND_FAIL', {
      op: 'send_questionnaire',
      threadId: THREAD_ID,
      text: 'questionnaire plain fail',
    });
  });

  it('TG_QUESTIONNAIRE_FAIL does not emit TG_APPROVAL_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    const p = priv(probe);
    const orig = p.processQuestionnaireForThread.bind(probe);
    p.processQuestionnaireForThread = async () => {
      throw new Error('q only');
    };

    const lines = await captureAll(async () => {
      probe.triggerPatch({ questionnaire: sampleQuestionnaire() });
      await settle();
    });

    assertApprovalQuestLog(lines, 'TG_QUESTIONNAIRE_FAIL', { op: 'process_questionnaire' });
    assert.ok(!lines.some((l) => l.includes('code=TG_APPROVAL_FAIL')));
    p.processQuestionnaireForThread = orig;
  });

  it('approval: prefixed legacy banner cleanup deletes tracked message silently', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    let deleteCalls = 0;
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 609 }),
      editMessageText: async () => {},
      deleteMessage: async () => {
        deleteCalls += 1;
      },
    } as unknown as TelegramApiClient);

    probe.messageTracker.track(THREAD_ID, `approval:${APPROVAL_ID}`, [609], 'banner-hash', 'approval');

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    assertNoApprovalQuestLogs(lines);
    assert.equal(deleteCalls, 1);
    assert.equal(probe.messageTracker.getTracked(THREAD_ID, `approval:${APPROVAL_ID}`), undefined);
  });

  it('legacy approval tracker key cleanup stays silent without approval logs', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    let deleteCalls = 0;
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 607 }),
      editMessageText: async () => {},
      deleteMessage: async () => {
        deleteCalls += 1;
      },
    } as unknown as TelegramApiClient);

    probe.messageTracker.track(THREAD_ID, 'approval', [888], 'legacy-hash', 'approval');

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, []);
    });

    assertNoApprovalQuestLogs(lines);
    assert.equal(deleteCalls, 1);
    assert.equal(probe.messageTracker.getTracked(THREAD_ID, 'approval'), undefined);
  });

  it('legacy approval-prefix tracker key cleanup stays silent without approval logs', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    let deleteCalls = 0;
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 608 }),
      editMessageText: async () => {},
      deleteMessage: async () => {
        deleteCalls += 1;
      },
    } as unknown as TelegramApiClient);

    probe.messageTracker.track(THREAD_ID, 'approval-approval-999', [889], 'legacy2-hash', 'approval');

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, []);
    });

    assertNoApprovalQuestLogs(lines);
    assert.equal(deleteCalls, 1);
    assert.equal(probe.messageTracker.getTracked(THREAD_ID, 'approval-approval-999'), undefined);
  });

  it('questionnaire deleteMessage failure on clear stays silent without TG_QUESTIONNAIRE_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 704 }),
      editMessageText: async () => {},
      deleteMessage: async () => {
        throw new Error('q delete failed');
      },
    } as unknown as TelegramApiClient);

    await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, null);
    });

    assertNoApprovalQuestLogs(lines);
    assert.deepEqual(probe.messageTracker.getTracked(THREAD_ID, 'questionnaire')?.telegramMsgIds, []);
  });

  it('questionnaire with empty questions clears silently without TG_QUESTIONNAIRE_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());

    const emptyQ = sampleQuestionnaire();
    emptyQ.questions = [];

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, emptyQ);
    });

    assertNoApprovalQuestLogs(lines);
    assert.deepEqual(probe.messageTracker.getTracked(THREAD_ID, 'questionnaire')?.telegramMsgIds, []);
  });

  it('questionnaire edit message is not modified stays silent without TG_QUESTIONNAIRE_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 705 }),
      editMessageText: async () => {
        throw new Error('message is not modified');
      },
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());

    const changed = sampleQuestionnaire();
    changed.questions[0]!.text = 'Different question';

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, changed);
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('onStatePatch skips questionnaire when started false stays silent', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    priv(probe).started = false;

    const lines = await captureAll(async () => {
      probe.triggerPatch({ questionnaire: sampleQuestionnaire() });
      await settle();
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('onStatePatch skips approval when chatId missing stays silent', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    priv(probe).started = true;
    (probe as unknown as { syncEnabled: boolean }).syncEnabled = true;

    const lines = await captureAll(async () => {
      probe.triggerPatch({ pendingApprovals: [sampleApproval()] });
      await settle();
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('onStatePatch questionnaire null clears tracked message silently', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());

    const lines = await captureAll(async () => {
      probe.triggerPatch({ questionnaire: null });
      await settle();
    });

    assertNoApprovalQuestLogs(lines);
    assert.deepEqual(probe.messageTracker.getTracked(THREAD_ID, 'questionnaire')?.telegramMsgIds, []);
  });

  it('TG_APPROVAL_FAIL does not emit TG_QUESTIONNAIRE_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    mock.method(probe.messageTracker, 'listInThread', () => {
      throw new Error('approval only fail');
    });

    const lines = await captureAll(async () => {
      probe.triggerPatch({ pendingApprovals: [sampleApproval()] });
      await settle();
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_FAIL', { op: 'process_approvals' });
    assert.ok(!lines.some((l) => l.includes('code=TG_QUESTIONNAIRE_FAIL')));
    mock.restoreAll();
  });

  it('processApprovalsForThread without chatId stays silent without approval logs', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('TG_QUESTIONNAIRE_SEND_FAIL does not emit TG_SEND_FAIL or TG_EDIT_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => {
        throw new Error('questionnaire isolated fail');
      },
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());
    });

    assertApprovalQuestLog(lines, 'TG_QUESTIONNAIRE_SEND_FAIL', { op: 'send_questionnaire' });
    assert.ok(!lines.some((l) => l.includes('code=TG_SEND_FAIL')));
    assert.ok(!lines.some((l) => l.includes('code=TG_EDIT_FAIL')));
  });

  it('logs exactly one TG_APPROVAL_NO_THREAD when multiple approvals unresolved', async () => {
    const probe = makeProbe(dataDir, {
      windows: [{ id: 'win-1', title: 'Lonely' }],
      activeWindowId: 'win-1',
      chatTabs: [{ title: 'Orphan', isActive: true, composerId: '', status: '', selectorPath: '' }],
    });
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessApprovals([sampleApproval(), sampleApproval('tool:extra')]);
    });

    const hits = lines.filter((l) => l.includes('code=TG_APPROVAL_NO_THREAD'));
    assert.equal(hits.length, 1);
  });

  it('onStatePatch empty pendingApprovals array still runs processApprovals silently when thread resolved', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 620 }),
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    probe.messageTracker.track(THREAD_ID, `approval:${APPROVAL_ID}`, [620], 'banner-hash', 'approval');

    const lines = await captureAll(async () => {
      probe.triggerPatch({ pendingApprovals: [] });
      await settle();
    });

    assertNoApprovalQuestLogs(lines);
    assert.equal(probe.messageTracker.getTracked(THREAD_ID, `approval:${APPROVAL_ID}`), undefined);
  });

  it('questionnaire clear with no tracked entry stays silent without TG_QUESTIONNAIRE_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, null);
    });

    assertNoApprovalQuestLogs(lines);
    assert.equal(probe.messageTracker.getTracked(THREAD_ID, 'questionnaire'), undefined);
  });

  it('onStatePatch skips questionnaire when chatId missing stays silent', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    priv(probe).started = true;
    (probe as unknown as { syncEnabled: boolean }).syncEnabled = true;

    const lines = await captureAll(async () => {
      probe.triggerPatch({ questionnaire: sampleQuestionnaire() });
      await settle();
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('logs TG_QUESTIONNAIRE_FAIL via onStatePatch without threadId when catch omits resolved thread', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    const p = priv(probe);
    const origForThread = p.processQuestionnaireForThread.bind(probe);
    p.processQuestionnaireForThread = async () => {
      throw new Error('questionnaire catch no thread');
    };
    let getActiveCalls = 0;
    mock.method(probe.topicManager, 'getActiveThread', () => {
      getActiveCalls += 1;
      return getActiveCalls === 1 ? THREAD_ID : undefined;
    });

    const lines = await captureAll(async () => {
      probe.triggerPatch({ questionnaire: sampleQuestionnaire() });
      await settle();
    });

    assertApprovalQuestLog(lines, 'TG_QUESTIONNAIRE_FAIL', {
      op: 'process_questionnaire',
      chatId: CHAT_ID,
      omitThreadId: true,
      text: 'questionnaire catch no thread',
    });
    p.processQuestionnaireForThread = origForThread;
    mock.restoreAll();
  });

  it('logs exactly one TG_APPROVAL_ROUTED on tab-title fallback send path', async () => {
    const probe = makeProbe(dataDir, {
      windows: [{ id: 'win-1', title: 'Current' }],
      activeWindowId: 'win-1',
      chatTabs: [
        { title: 'FallbackTab', isActive: true, composerId: 'c1', status: '', selectorPath: '' },
      ],
    });
    probe.topicManager.registerMapping({
      threadId: THREAD_ID,
      windowId: 'win-other',
      windowTitle: 'Other',
      tabTitle: 'FallbackTab',
      lastActive: Date.now(),
    });
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessApprovals([sampleApproval()]);
    });

    const hits = lines.filter((l) => l.includes('code=TG_APPROVAL_ROUTED'));
    assert.equal(hits.length, 1);
    assertApprovalQuestLog(lines, 'TG_APPROVAL_ROUTED', { op: 'process_approvals_fallback' });
  });

  it('processApprovals with direct thread mapping stays silent without TG_APPROVAL_ROUTED', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessApprovals([sampleApproval()]);
    });

    assert.ok(!lines.some((l) => l.includes('code=TG_APPROVAL_ROUTED')));
    assertNoApprovalQuestLogs(lines);
  });

  it('TG_APPROVAL_ROUTED fallback path does not emit TG_APPROVAL_NO_THREAD', async () => {
    const probe = makeProbe(dataDir, {
      windows: [{ id: 'win-1', title: 'Current' }],
      activeWindowId: 'win-1',
      chatTabs: [
        { title: 'FallbackTab', isActive: true, composerId: 'c1', status: '', selectorPath: '' },
      ],
    });
    probe.topicManager.registerMapping({
      threadId: THREAD_ID,
      windowId: 'win-other',
      windowTitle: 'Other',
      tabTitle: 'FallbackTab',
      lastActive: Date.now(),
    });
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessApprovals([sampleApproval()]);
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_ROUTED', { op: 'process_approvals_fallback' });
    assert.ok(!lines.some((l) => l.includes('code=TG_APPROVAL_NO_THREAD')));
  });

  it('questionnaire successful edit updates tracker silently without TG_QUESTIONNAIRE_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());

    const before = probe.messageTracker.getTracked(THREAD_ID, 'questionnaire')?.lastContentHash;
    const changed = sampleQuestionnaire();
    changed.questions[0]!.text = 'Edited question text';

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, changed);
    });

    assertNoApprovalQuestLogs(lines);
    const after = probe.messageTracker.getTracked(THREAD_ID, 'questionnaire')?.lastContentHash;
    assert.ok(before && after && before !== after);
  });

  it('processQuestionnaireForThread without chatId stays silent without questionnaire logs', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('approval cleanup skips non-approval element ids silently without TG_APPROVAL_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    let deleteCalls = 0;
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 612 }),
      editMessageText: async () => {},
      deleteMessage: async () => {
        deleteCalls += 1;
      },
    } as unknown as TelegramApiClient);

    probe.messageTracker.track(THREAD_ID, 'assistant-el-99', [777], 'msg-hash', 'assistant');

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, []);
    });

    assertNoApprovalQuestLogs(lines);
    assert.equal(deleteCalls, 0);
    assert.ok(probe.messageTracker.getTracked(THREAD_ID, 'assistant-el-99'));
  });

  it('approval cleanup without telegramMsgId stays silent without TG_APPROVAL_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    let deleteCalls = 0;
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 613 }),
      editMessageText: async () => {},
      deleteMessage: async () => {
        deleteCalls += 1;
      },
    } as unknown as TelegramApiClient);

    probe.messageTracker.track(THREAD_ID, 'approval', [], 'legacy-empty-hash', 'approval');

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, []);
    });

    assertNoApprovalQuestLogs(lines);
    assert.equal(deleteCalls, 0);
    assert.equal(probe.messageTracker.getTracked(THREAD_ID, 'approval'), undefined);
  });

  it('logs TG_QUESTIONNAIRE_SEND_FAIL with chatId on send failure', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => {
        throw new Error('q needs chatId');
      },
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runProcessQuestionnaireForThread(THREAD_ID, sampleQuestionnaire());
    });

    assertApprovalQuestLog(lines, 'TG_QUESTIONNAIRE_SEND_FAIL', {
      op: 'send_questionnaire',
      chatId: CHAT_ID,
      threadId: THREAD_ID,
    });
  });

  it('TG_QUESTIONNAIRE_FAIL does not emit TG_QUESTIONNAIRE_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();
    const p = priv(probe);
    const orig = p.processQuestionnaireForThread.bind(probe);
    p.processQuestionnaireForThread = async () => {
      throw new Error('process fail only');
    };

    const lines = await captureAll(async () => {
      probe.triggerPatch({ questionnaire: sampleQuestionnaire() });
      await settle();
    });

    assertApprovalQuestLog(lines, 'TG_QUESTIONNAIRE_FAIL', { op: 'process_questionnaire' });
    assert.ok(!lines.some((l) => l.includes('code=TG_QUESTIONNAIRE_SEND_FAIL')));
    p.processQuestionnaireForThread = orig;
  });
});

const SILENT_PATH_MARKERS = [
  'processApprovalsForThread with actionable approvals does not send approval logs',
  'legacy approval banner deleteMessage failure stays silent without approval logs',
  'questionnaire message is not modified stays silent',
  'questionnaire message not found stays silent',
  'empty approvals without thread stays silent without TG_APPROVAL_NO_THREAD',
  'processApprovals without chatId stays silent without approval logs',
  'junk approval filtered stays silent without approval logs',
  'unchanged approval content stays silent without approval logs',
  'questionnaire without thread stays silent',
  'empty questionnaire clears tracked message silently',
  'unchanged questionnaire stays silent',
  'successful questionnaire send stays silent',
  'onStatePatch skips approval when sync disabled stays silent',
  'tab-title fallback with empty approvals stays silent without TG_APPROVAL_ROUTED',
  'onStatePatch skips questionnaire when sync disabled stays silent',
  'onStatePatch skips approval when started false stays silent',
  'processQuestionnaire without chatId stays silent without questionnaire logs',
  'approval: prefixed legacy banner cleanup deletes tracked message silently',
  'legacy approval tracker key cleanup stays silent without approval logs',
  'legacy approval-prefix tracker key cleanup stays silent without approval logs',
  'questionnaire deleteMessage failure on clear stays silent',
  'questionnaire with empty questions clears silently',
  'questionnaire edit message is not modified stays silent',
  'onStatePatch skips questionnaire when started false stays silent',
  'onStatePatch skips approval when chatId missing stays silent',
  'onStatePatch questionnaire null clears tracked message silently',
  'processApprovalsForThread without chatId stays silent without approval logs',
  'onStatePatch empty pendingApprovals array still runs processApprovals silently when thread resolved',
  'questionnaire clear with no tracked entry stays silent',
  'onStatePatch skips questionnaire when chatId missing stays silent',
  'processApprovals with direct thread mapping stays silent without TG_APPROVAL_ROUTED',
  'questionnaire successful edit updates tracker silently',
  'processQuestionnaireForThread without chatId stays silent without questionnaire logs',
  'approval cleanup skips non-approval element ids silently',
  'approval cleanup without telegramMsgId stays silent',
] as const;

const APPROVAL_QUESTIONNAIRE_PATH_MATRIX = [
  { kind: 'fail' as const, code: 'TG_APPROVAL_FAIL', marker: 'processApprovals rejection via onStatePatch with threadId' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_FAIL', marker: 'processQuestionnaire rejection via onStatePatch' },
  { kind: 'fail' as const, code: 'TG_APPROVAL_NO_THREAD', marker: 'approvals present but thread unresolved without threadId' },
  { kind: 'info' as const, code: 'TG_APPROVAL_ROUTED', marker: 'tab-title fallback with pollLoopCtx threadId' },
  { kind: 'silent' as const, marker: 'processApprovalsForThread with actionable approvals does not send approval logs' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_SEND_FAIL', marker: 'sendMessage failure with threadId' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_SEND_FAIL', marker: 'editMessageText failure' },
  { kind: 'silent' as const, marker: 'legacy approval banner deleteMessage failure stays silent without approval logs' },
  { kind: 'silent' as const, marker: 'questionnaire message is not modified stays silent without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'questionnaire message not found stays silent without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'empty approvals without thread stays silent without TG_APPROVAL_NO_THREAD' },
  { kind: 'silent' as const, marker: 'processApprovals without chatId stays silent without approval logs' },
  { kind: 'silent' as const, marker: 'junk approval filtered stays silent without approval logs' },
  { kind: 'silent' as const, marker: 'unchanged approval content stays silent without approval logs' },
  { kind: 'silent' as const, marker: 'questionnaire without thread stays silent without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'empty questionnaire clears tracked message silently without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'unchanged questionnaire stays silent without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'fail' as const, code: 'TG_APPROVAL_FAIL', marker: 'non-Error rejection message via onStatePatch' },
  { kind: 'silent' as const, marker: 'successful questionnaire send stays silent without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'onStatePatch skips approval when sync disabled stays silent' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_FAIL', marker: 'non-Error rejection message via onStatePatch' },
  { kind: 'fail' as const, code: 'TG_APPROVAL_FAIL', marker: 'via onStatePatch without threadId when catch omits fallback lookup' },
  { kind: 'silent' as const, marker: 'tab-title fallback with empty approvals stays silent without TG_APPROVAL_ROUTED' },
  { kind: 'silent' as const, marker: 'onStatePatch skips questionnaire when sync disabled stays silent' },
  { kind: 'silent' as const, marker: 'onStatePatch skips approval when started false stays silent' },
  { kind: 'silent' as const, marker: 'processQuestionnaire without chatId stays silent without questionnaire logs' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_SEND_FAIL', marker: 'exactly one TG_QUESTIONNAIRE_SEND_FAIL per questionnaire send failure' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_SEND_FAIL', marker: 'send throws non-Error value' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_FAIL', marker: 'does not emit TG_APPROVAL_FAIL' },
  { kind: 'silent' as const, marker: 'approval: prefixed legacy banner cleanup deletes tracked message silently' },
  { kind: 'silent' as const, marker: 'legacy approval tracker key cleanup stays silent without approval logs' },
  { kind: 'silent' as const, marker: 'legacy approval-prefix tracker key cleanup stays silent without approval logs' },
  { kind: 'silent' as const, marker: 'questionnaire deleteMessage failure on clear stays silent without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'questionnaire with empty questions clears silently without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'questionnaire edit message is not modified stays silent without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'onStatePatch skips questionnaire when started false stays silent' },
  { kind: 'silent' as const, marker: 'onStatePatch skips approval when chatId missing stays silent' },
  { kind: 'silent' as const, marker: 'onStatePatch questionnaire null clears tracked message silently' },
  { kind: 'fail' as const, code: 'TG_APPROVAL_FAIL', marker: 'does not emit TG_QUESTIONNAIRE_FAIL' },
  { kind: 'silent' as const, marker: 'processApprovalsForThread without chatId stays silent without approval logs' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_SEND_FAIL', marker: 'does not emit TG_SEND_FAIL or TG_EDIT_FAIL' },
  { kind: 'fail' as const, code: 'TG_APPROVAL_NO_THREAD', marker: 'exactly one TG_APPROVAL_NO_THREAD when multiple approvals unresolved' },
  { kind: 'silent' as const, marker: 'onStatePatch empty pendingApprovals array still runs processApprovals silently when thread resolved' },
  { kind: 'silent' as const, marker: 'questionnaire clear with no tracked entry stays silent without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'onStatePatch skips questionnaire when chatId missing stays silent' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_FAIL', marker: 'via onStatePatch without threadId when catch omits resolved thread' },
  { kind: 'info' as const, code: 'TG_APPROVAL_ROUTED', marker: 'exactly one TG_APPROVAL_ROUTED on tab-title fallback send path' },
  { kind: 'silent' as const, marker: 'processApprovals with direct thread mapping stays silent without TG_APPROVAL_ROUTED' },
  { kind: 'info' as const, code: 'TG_APPROVAL_ROUTED', marker: 'fallback path does not emit TG_APPROVAL_NO_THREAD' },
  { kind: 'silent' as const, marker: 'questionnaire successful edit updates tracker silently without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'processQuestionnaireForThread without chatId stays silent without questionnaire logs' },
  { kind: 'silent' as const, marker: 'approval cleanup skips non-approval element ids silently without TG_APPROVAL_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'approval cleanup without telegramMsgId stays silent without TG_APPROVAL_SEND_FAIL' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_SEND_FAIL', marker: 'with chatId on send failure' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_FAIL', marker: 'does not emit TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'meta' as const, marker: 'poll-loop whole file no inline scope outside pollLoopCtx queueKickCtx bridgeAutoCtx helpers' },
] as const;

describe('poll-loop approval/questionnaire logging coverage', () => {
  it('asserts every approval/questionnaire code in test file', () => {
    const src = readFileSync(
      new URL('./poll-loop-approval-questionnaire-logging.test.ts', import.meta.url),
      'utf-8',
    );
    for (const code of APPROVAL_QUESTIONNAIRE_LOG_CODES) {
      assert.ok(
        src.includes(`assertApprovalQuestLog(lines, '${code}'`) || src.includes(`code=${code}`),
        `missing assertion for ${code}`,
      );
    }
    assert.equal(APPROVAL_QUESTIONNAIRE_LOG_CODES.length, 5);
  });

  it('poll-loop.ts declares all five codes in approval/questionnaire zone', () => {
    const zone = approvalQuestZoneSrc();
    for (const code of APPROVAL_QUESTIONNAIRE_LOG_CODES) {
      assert.ok(zone.includes(`'${code}'`), `zone missing ${code}`);
    }
  });

  it('approval/questionnaire zone has zero console.log warn error', () => {
    const zone = approvalQuestZoneSrc();
    assert.ok(!zone.includes('console.log('));
    assert.ok(!zone.includes('console.warn('));
    assert.ok(!zone.includes('console.error('));
  });

  it('process catch sites use pollLoopCtx with chatId and threadId in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /logError\('TG_APPROVAL_FAIL'[\s\S]*?pollLoopCtx\('process_approvals'/);
    assert.match(zone, /logError\('TG_QUESTIONNAIRE_FAIL'[\s\S]*?pollLoopCtx\('process_questionnaire'/);
    assert.match(zone, /chatId: this\.chatId,\s*\n\s*threadId,/);
  });

  it('TG_APPROVAL_NO_THREAD uses logWarn without threadId in pollLoopCtx source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /logWarn\(\s*\n\s*'TG_APPROVAL_NO_THREAD'/);
    const noThreadBlock = zone.match(/TG_APPROVAL_NO_THREAD[\s\S]*?pollLoopCtx\('process_approvals', \{ chatId: this\.chatId \}\)/);
    assert.ok(noThreadBlock, 'NO_THREAD ctx must omit threadId');
  });

  it('legacy approval banners retired — no send_approval or TG_APPROVAL_OK in zone source', () => {
    const zone = approvalQuestZoneSrc();
    assert.ok(!zone.includes('TG_APPROVAL_OK'));
    assert.ok(!zone.includes('TG_APPROVAL_SEND_FAIL'));
    assert.ok(!zone.includes("pollLoopCtx('send_approval'"));
    assert.ok(!zone.includes('approvalInflight'));
    assert.ok(!zone.includes('APPROVAL_DELETE_GRACE_MS'));
  });

  it('send fail sites skip not-modified and not-found in questionnaire source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /!msg\.includes\('not found'\) && !msg\.includes\('not modified'\)/);
    const hits = zone.match(/!msg\.includes\('not found'\) && !msg\.includes\('not modified'\)/g) ?? [];
    assert.equal(hits.length, 1, 'questionnaire send catch must skip benign errors');
  });

  it('approval delete catch stays silent in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /deleteMessage\(this\.chatId!, tracked\.telegramMsgIds\[0\]\)[\s\S]*?catch \{ \/\* may already be deleted \*\/ \}/);
  });

  it('questionnaire early return when no threadId has no log in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /if \(!threadId\) return;/);
  });

  it('every covered code has assertApprovalQuestLog in behavioral tests', () => {
    const src = readFileSync(
      new URL('./poll-loop-approval-questionnaire-logging.test.ts', import.meta.url),
      'utf-8',
    );
    for (const code of APPROVAL_QUESTIONNAIRE_LOG_CODES) {
      assert.ok(src.includes(`assertApprovalQuestLog(lines, '${code}'`), `behavioral missing ${code}`);
    }
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(
      new URL('./poll-loop-approval-questionnaire-logging.test.ts', import.meta.url),
      'utf-8',
    );
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent marker: ${marker}`);
    }
  });

  it('path matrix rows map to behavioral test titles', () => {
    const src = readFileSync(
      new URL('./poll-loop-approval-questionnaire-logging.test.ts', import.meta.url),
      'utf-8',
    );
    for (const row of APPROVAL_QUESTIONNAIRE_PATH_MATRIX) {
      assert.ok(src.includes(row.marker), `matrix row missing test: ${row.marker}`);
    }
    assert.equal(APPROVAL_QUESTIONNAIRE_PATH_MATRIX.length, 56);
  });

  it('zone declares exactly five log emission sites for covered codes', () => {
    const zone = approvalQuestZoneSrc();
    assert.equal((zone.match(/logError\([\s\S]*?'TG_APPROVAL_FAIL'/g) ?? []).length, 1);
    assert.equal((zone.match(/logError\([\s\S]*?'TG_QUESTIONNAIRE_FAIL'/g) ?? []).length, 1);
    assert.equal((zone.match(/logInfo\([\s\S]*?'TG_APPROVAL_ROUTED'/g) ?? []).length, 1);
    assert.equal((zone.match(/logWarn\([\s\S]*?'TG_APPROVAL_NO_THREAD'/g) ?? []).length, 1);
    assert.equal((zone.match(/logWarn\([\s\S]*?'TG_QUESTIONNAIRE_SEND_FAIL'/g) ?? []).length, 1);
    assert.ok(!zone.includes('TG_APPROVAL_OK'));
    assert.ok(!zone.includes('TG_APPROVAL_SEND_FAIL'));
  });

  it('TG_QUESTIONNAIRE_SEND_FAIL uses logWarn with pollLoopCtx in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /logWarn\('TG_QUESTIONNAIRE_SEND_FAIL'/);
    assert.match(zone, /pollLoopCtx\('send_questionnaire',/);
  });

  it('TG_APPROVAL_ROUTED only when approvals.length > 0 in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /if \(approvals\.length > 0\) \{[\s\S]*?TG_APPROVAL_ROUTED/);
  });

  it('TG_APPROVAL_NO_THREAD only when approvals.length > 0 in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /if \(approvals\.length > 0\) \{[\s\S]*?TG_APPROVAL_NO_THREAD/);
  });

  it('filterActionableApprovals applied in processApprovalsForThread source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /approvals = filterActionableApprovals\(approvals\)/);
  });

  it('questionnaire success path has no TG_QUESTIONNAIRE_OK code in zone source', () => {
    const zone = approvalQuestZoneSrc();
    assert.ok(!zone.includes('TG_QUESTIONNAIRE_OK'));
  });

  it('covered fail codes never use logError except process catch codes in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.ok(!zone.includes("logError('TG_QUESTIONNAIRE_SEND_FAIL'"));
    assert.ok(!zone.includes("logError('TG_APPROVAL_NO_THREAD'"));
  });

  it('automated matrix: fail/info codes have behavioral assertApprovalQuestLog', () => {
    const failCodes = APPROVAL_QUESTIONNAIRE_PATH_MATRIX.filter((r) => r.kind !== 'silent' && r.kind !== 'meta').map((r) =>
      'code' in r ? r.code : '',
    );
    const unique = [...new Set(failCodes.filter(Boolean))];
    const src = readFileSync(
      new URL('./poll-loop-approval-questionnaire-logging.test.ts', import.meta.url),
      'utf-8',
    );
    for (const code of unique) {
      assert.ok(src.includes(`assertApprovalQuestLog(lines, '${code}'`), `matrix code missing assert: ${code}`);
    }
    assert.equal(unique.length, 5);
  });

  it('outer catch handlers stringify non-Error err in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /err instanceof Error \? err\.message : String\(err\)/);
    const hits = zone.match(/err instanceof Error \? err\.message : String\(err\)/g) ?? [];
    assert.ok(hits.length >= 3, 'approval/questionnaire zone should stringify errors in multiple catches');
  });

  it('onStatePatch guard requires started syncEnabled and chatId in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /if \(!this\.started \|\| !this\.syncEnabled \|\| !this\.chatId\) return;/);
  });

  it('TG_APPROVAL_ROUTED uses logInfo in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /logInfo\(\s*\n\s*'TG_APPROVAL_ROUTED'/);
    assert.ok(!zone.includes('TG_APPROVAL_OK'));
  });

  it('questionnaire clear delete catch stays silent in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /catch \{ \/\* ok — may already be deleted \*\/ \}/);
  });

  it('legacy approval key cleanup in processApprovalsForThread source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /eid === 'approval'/);
    assert.match(zone, /isCurrentFmtKey = eid\.startsWith\(APPROVAL_PREFIX\)/);
  });

  it('patch questionnaire uses in patch check not truthy questionnaire in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /if \('questionnaire' in patch\)/);
  });

  it('patch pendingApprovals uses truthy array check in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /if \(patch\.pendingApprovals\)/);
    assert.ok(!zone.includes("if ('pendingApprovals' in patch)"));
  });

  it('legacy approval-prefix keys recognized in cleanup loop source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /eid\.startsWith\('approval-'\) && !eid\.startsWith\(APPROVAL_PREFIX\)/);
  });

  it('questionnaire patch coalesces undefined to null in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /processQuestionnaire\(patch\.questionnaire \?\? null\)/);
  });

  it('processApprovals uses findMappingByTabTitle fallback in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /findMappingByTabTitle\(activeTab\.title\)/);
  });

  it('processApprovals awaits processApprovalsForThread in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /await this\.processApprovalsForThread\(threadId, approvals\)/);
  });

  it('questionnaire hasChanged skip avoids edit without log in source', () => {
    const zone = approvalQuestZoneSrc();
    const qZone = zone.slice(zone.indexOf('private async processQuestionnaireForThread'));
    assert.match(
      qZone,
      /if \(tracked && !this\.messageTracker\.hasChanged\(threadId, trackId, contentHash\)\) return;/,
    );
  });

  it('questionnaire empty formatted html returns without log in source', () => {
    const zone = approvalQuestZoneSrc();
    const qZone = zone.slice(zone.indexOf('private async processQuestionnaireForThread'));
    assert.match(qZone, /if \(!formatted\.html\) return;/);
  });

  it('approval cleanup loop skips unrelated element ids in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /if \(!isLegacyApprovalKey && !isCurrentFmtKey\) continue;/);
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
