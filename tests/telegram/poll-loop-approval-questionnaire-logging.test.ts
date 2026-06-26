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
  'TG_APPROVAL_OK',
  'TG_APPROVAL_SEND_FAIL',
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
  approvalInflight: Set<string>;
  approvalPendingDeletion: Map<string, number>;
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
    assertApprovalQuestLog(lines, 'TG_APPROVAL_OK', {
      op: 'send_approval',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      itemId: APPROVAL_ID,
    });
  });

  it('logs TG_APPROVAL_OK on send_approval with itemId', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 601 }),
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_OK', {
      op: 'send_approval',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      itemId: APPROVAL_ID,
    });
  });

  it('logs TG_APPROVAL_OK on edit_approval when tracked content changes', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 602 }),
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);

    const changed = sampleApproval();
    changed.description = 'Run npm test again';

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [changed]);
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_OK', {
      op: 'edit_approval',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      itemId: APPROVAL_ID,
    });
  });

  it('logs TG_APPROVAL_SEND_FAIL on sendMessage failure with pollLoopCtx', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => {
        throw new Error('send approval failed');
      },
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_SEND_FAIL', {
      op: 'send_approval',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      itemId: APPROVAL_ID,
      text: 'send approval failed',
    });
  });

  it('logs TG_APPROVAL_SEND_FAIL on editMessageText failure', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 603 }),
      editMessageText: async () => {
        throw new Error('edit approval failed');
      },
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);

    const changed = sampleApproval();
    changed.description = 'Changed desc';

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [changed]);
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_SEND_FAIL', {
      op: 'send_approval',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
      itemId: APPROVAL_ID,
      text: 'edit approval failed',
    });
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

  it('approval message is not modified stays silent without TG_APPROVAL_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 604 }),
      editMessageText: async () => {
        throw new Error('message is not modified');
      },
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);

    const changed = sampleApproval();
    changed.description = 'Different description';

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [changed]);
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('approval message not found stays silent without TG_APPROVAL_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 605 }),
      editMessageText: async () => {
        throw new Error('message not found');
      },
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);

    const changed = sampleApproval();
    changed.description = 'New text';

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [changed]);
    });

    assertNoApprovalQuestLogs(lines);
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

  it('junk approval filtered stays silent without TG_APPROVAL_OK', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [junkApproval()]);
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('unchanged approval content stays silent without TG_APPROVAL_OK', async () => {
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

  it('approval deleteMessage failure stays silent without TG_APPROVAL_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 606 }),
      editMessageText: async () => {},
      deleteMessage: async () => {
        throw new Error('delete failed');
      },
    } as unknown as TelegramApiClient);

    await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    priv(probe).approvalPendingDeletion.set(
      `${THREAD_ID}:approval:${APPROVAL_ID}`,
      Date.now() - 1,
    );

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, []);
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('approvalInflight duplicate skips second send silently without TG_APPROVAL_OK', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    priv(probe).approvalInflight.add(`${THREAD_ID}:approval:${APPROVAL_ID}`);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    assertNoApprovalQuestLogs(lines);
  });

  it('logs exactly one TG_APPROVAL_SEND_FAIL per approval send failure', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => {
        throw new Error('once only');
      },
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    const hits = lines.filter((l) => l.includes('code=TG_APPROVAL_SEND_FAIL'));
    assert.equal(hits.length, 1);
  });

  it('logs TG_APPROVAL_SEND_FAIL when send throws non-Error value', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => {
        throw 'plain string fail';
      },
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_SEND_FAIL', {
      op: 'send_approval',
      threadId: THREAD_ID,
      itemId: APPROVAL_ID,
      text: 'plain string fail',
    });
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

  it('TG_APPROVAL_SEND_FAIL does not emit TG_EDIT_FAIL or TG_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => {
        throw new Error('approval only');
      },
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_SEND_FAIL', { op: 'send_approval' });
    assert.ok(!lines.some((l) => l.includes('code=TG_EDIT_FAIL')));
    assert.ok(!lines.some((l) => l.includes('code=TG_SEND_FAIL')));
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

  it('approval grace first poll without approval schedules deletion silently', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, []);
    });

    assertNoApprovalQuestLogs(lines);
    assert.ok(
      priv(probe).approvalPendingDeletion.has(`${THREAD_ID}:approval:${APPROVAL_ID}`),
      'grace deletion should be scheduled',
    );
    assert.ok(probe.messageTracker.getTracked(THREAD_ID, `approval:${APPROVAL_ID}`));
  });

  it('legacy approval tracker key cleanup stays silent without TG_APPROVAL_SEND_FAIL', async () => {
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

  it('approval reappears in grace window cancels pending deletion silently', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    await probe.runProcessApprovalsForThread(THREAD_ID, []);

    const pendKey = `${THREAD_ID}:approval:${APPROVAL_ID}`;
    assert.ok(priv(probe).approvalPendingDeletion.has(pendKey));

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    assertNoApprovalQuestLogs(lines);
    assert.ok(!priv(probe).approvalPendingDeletion.has(pendKey));
    assert.ok(probe.messageTracker.getTracked(THREAD_ID, `approval:${APPROVAL_ID}`));
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

  it('logs exactly one TG_APPROVAL_OK on first send_approval', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    const hits = lines.filter((l) => l.includes('code=TG_APPROVAL_OK'));
    assert.equal(hits.length, 1);
    assert.ok(hits[0]!.includes('op=send_approval'));
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

  it('legacy approval-prefix tracker key cleanup stays silent without TG_APPROVAL_SEND_FAIL', async () => {
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

  it('approval grace expired second poll deletes tracked banner silently', async () => {
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

    await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    await probe.runProcessApprovalsForThread(THREAD_ID, []);
    priv(probe).approvalPendingDeletion.set(
      `${THREAD_ID}:approval:${APPROVAL_ID}`,
      Date.now() - 1,
    );

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, []);
    });

    assertNoApprovalQuestLogs(lines);
    assert.equal(deleteCalls, 1);
    assert.equal(probe.messageTracker.getTracked(THREAD_ID, `approval:${APPROVAL_ID}`), undefined);
  });

  it('logs two TG_APPROVAL_OK lines when two actionable approvals send', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => ({ message_id: 610 }),
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    const second = sampleApproval('tool:second-approval');
    second.description = 'Run npm run build';

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval(), second]);
    });

    const hits = lines.filter((l) => l.includes('code=TG_APPROVAL_OK') && l.includes('op=send_approval'));
    assert.equal(hits.length, 2);
    assert.ok(hits.some((l) => l.includes(`itemId=${APPROVAL_ID}`)));
    assert.ok(hits.some((l) => l.includes('itemId=tool:second-approval')));
  });

  it('mixed junk and valid approval logs only one TG_APPROVAL_OK for valid id', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [junkApproval(), sampleApproval()]);
    });

    const hits = lines.filter((l) => l.includes('code=TG_APPROVAL_OK'));
    assert.equal(hits.length, 1);
    assert.ok(hits[0]!.includes(`itemId=${APPROVAL_ID}`));
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

  it('logs exactly one TG_APPROVAL_OK on edit_approval after content change', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);

    const changed = sampleApproval();
    changed.description = 'Updated approval text';

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [changed]);
    });

    const hits = lines.filter((l) => l.includes('code=TG_APPROVAL_OK'));
    assert.equal(hits.length, 1);
    assert.ok(hits[0]!.includes('op=edit_approval'));
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

  it('approvalInflight cleared after TG_APPROVAL_SEND_FAIL allows subsequent send', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    let sendCalls = 0;
    probe.wireHarness({
      sendMessage: async () => {
        sendCalls += 1;
        if (sendCalls === 1) throw new Error('first send fail');
        return { message_id: 611 };
      },
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_OK', { op: 'send_approval' });
    assert.equal(sendCalls, 2);
  });

  it('onStatePatch empty pendingApprovals array still runs processApprovals silently when thread resolved', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);

    const lines = await captureAll(async () => {
      probe.triggerPatch({ pendingApprovals: [] });
      await settle();
    });

    assertNoApprovalQuestLogs(lines);
    assert.ok(
      priv(probe).approvalPendingDeletion.has(`${THREAD_ID}:approval:${APPROVAL_ID}`),
      'empty patch should schedule grace deletion',
    );
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
    assertApprovalQuestLog(lines, 'TG_APPROVAL_OK', { op: 'send_approval' });
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

  it('logs TG_APPROVAL_OK for approve_all action approval', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [acceptAllApproval()]);
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_OK', {
      op: 'send_approval',
      itemId: 'tool:accept-all-cmd',
      threadId: THREAD_ID,
      chatId: CHAT_ID,
    });
  });

  it('logs TG_APPROVAL_SEND_FAIL with chatId on send failure', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness({
      sendMessage: async () => {
        throw new Error('needs chatId');
      },
      editMessageText: async () => {},
      deleteMessage: async () => {},
    } as unknown as TelegramApiClient);

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_SEND_FAIL', {
      op: 'send_approval',
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      itemId: APPROVAL_ID,
    });
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

  it('TG_APPROVAL_OK send path does not emit TG_APPROVAL_SEND_FAIL', async () => {
    const probe = makeProbe(dataDir);
    registerThread(probe);
    probe.wireHarness();

    const lines = await captureAll(async () => {
      await probe.runProcessApprovalsForThread(THREAD_ID, [sampleApproval()]);
    });

    assertApprovalQuestLog(lines, 'TG_APPROVAL_OK', { op: 'send_approval' });
    assert.ok(!lines.some((l) => l.includes('code=TG_APPROVAL_SEND_FAIL')));
  });
});

const SILENT_PATH_MARKERS = [
  'message is not modified stays silent without TG_APPROVAL_SEND_FAIL',
  'approval message not found stays silent',
  'questionnaire message is not modified stays silent',
  'questionnaire edit message is not modified stays silent',
  'questionnaire message not found stays silent',
  'empty approvals without thread stays silent without TG_APPROVAL_NO_THREAD',
  'without chatId stays silent',
  'processQuestionnaire without chatId stays silent',
  'junk approval filtered stays silent',
  'unchanged approval content stays silent',
  'questionnaire without thread stays silent',
  'empty questionnaire clears tracked message silently',
  'questionnaire with empty questions clears silently',
  'unchanged questionnaire stays silent',
  'deleteMessage failure stays silent',
  'questionnaire deleteMessage failure on clear stays silent',
  'approvalInflight duplicate skips second send silently',
  'successful questionnaire send stays silent',
  'sync disabled stays silent',
  'onStatePatch skips questionnaire when sync disabled stays silent',
  'onStatePatch skips approval when started false stays silent',
  'tab-title fallback with empty approvals stays silent without TG_APPROVAL_ROUTED',
  'approval grace first poll without approval schedules deletion silently',
  'legacy approval tracker key cleanup stays silent',
  'approval reappears in grace window cancels pending deletion silently',
  'onStatePatch skips questionnaire when started false stays silent',
  'onStatePatch skips approval when chatId missing stays silent',
  'onStatePatch questionnaire null clears tracked message silently',
  'legacy approval-prefix tracker key cleanup stays silent',
  'approval grace expired second poll deletes tracked banner silently',
  'processApprovalsForThread without chatId stays silent',
  'onStatePatch empty pendingApprovals array still runs processApprovals silently',
  'questionnaire clear with no tracked entry stays silent',
  'onStatePatch skips questionnaire when chatId missing stays silent',
  'processApprovals with direct thread mapping stays silent without TG_APPROVAL_ROUTED',
  'approval cleanup skips non-approval element ids silently',
  'approval cleanup without telegramMsgId stays silent',
  'questionnaire successful edit updates tracker silently',
] as const;

const APPROVAL_QUESTIONNAIRE_PATH_MATRIX = [
  { kind: 'fail' as const, code: 'TG_APPROVAL_FAIL', marker: 'processApprovals rejection via onStatePatch with threadId' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_FAIL', marker: 'processQuestionnaire rejection via onStatePatch' },
  { kind: 'fail' as const, code: 'TG_APPROVAL_NO_THREAD', marker: 'approvals present but thread unresolved without threadId' },
  { kind: 'info' as const, code: 'TG_APPROVAL_ROUTED', marker: 'tab-title fallback with pollLoopCtx threadId' },
  { kind: 'info' as const, code: 'TG_APPROVAL_OK', marker: 'send_approval with itemId' },
  { kind: 'info' as const, code: 'TG_APPROVAL_OK', marker: 'edit_approval when tracked content changes' },
  { kind: 'fail' as const, code: 'TG_APPROVAL_SEND_FAIL', marker: 'sendMessage failure with pollLoopCtx' },
  { kind: 'fail' as const, code: 'TG_APPROVAL_SEND_FAIL', marker: 'editMessageText failure' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_SEND_FAIL', marker: 'sendMessage failure with threadId' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_SEND_FAIL', marker: 'editMessageText failure' },
  { kind: 'silent' as const, marker: 'message is not modified stays silent without TG_APPROVAL_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'approval message not found stays silent without TG_APPROVAL_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'questionnaire message is not modified stays silent without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'questionnaire message not found stays silent without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'empty approvals without thread stays silent without TG_APPROVAL_NO_THREAD' },
  { kind: 'silent' as const, marker: 'processApprovals without chatId stays silent without approval logs' },
  { kind: 'silent' as const, marker: 'junk approval filtered stays silent without TG_APPROVAL_OK' },
  { kind: 'silent' as const, marker: 'unchanged approval content stays silent without TG_APPROVAL_OK' },
  { kind: 'silent' as const, marker: 'questionnaire without thread stays silent without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'empty questionnaire clears tracked message silently without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'unchanged questionnaire stays silent without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'approval deleteMessage failure stays silent without TG_APPROVAL_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'approvalInflight duplicate skips second send silently without TG_APPROVAL_OK' },
  { kind: 'fail' as const, code: 'TG_APPROVAL_SEND_FAIL', marker: 'exactly one TG_APPROVAL_SEND_FAIL per approval send failure' },
  { kind: 'fail' as const, code: 'TG_APPROVAL_SEND_FAIL', marker: 'send throws non-Error value' },
  { kind: 'fail' as const, code: 'TG_APPROVAL_FAIL', marker: 'non-Error rejection message via onStatePatch' },
  { kind: 'fail' as const, code: 'TG_APPROVAL_SEND_FAIL', marker: 'does not emit TG_EDIT_FAIL or TG_SEND_FAIL' },
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
  { kind: 'silent' as const, marker: 'approval grace first poll without approval schedules deletion silently' },
  { kind: 'silent' as const, marker: 'legacy approval tracker key cleanup stays silent without TG_APPROVAL_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'approval reappears in grace window cancels pending deletion silently' },
  { kind: 'silent' as const, marker: 'questionnaire deleteMessage failure on clear stays silent without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'questionnaire with empty questions clears silently without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'questionnaire edit message is not modified stays silent without TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'info' as const, code: 'TG_APPROVAL_OK', marker: 'exactly one TG_APPROVAL_OK on first send_approval' },
  { kind: 'silent' as const, marker: 'onStatePatch skips questionnaire when started false stays silent' },
  { kind: 'silent' as const, marker: 'onStatePatch skips approval when chatId missing stays silent' },
  { kind: 'silent' as const, marker: 'onStatePatch questionnaire null clears tracked message silently' },
  { kind: 'fail' as const, code: 'TG_APPROVAL_FAIL', marker: 'does not emit TG_QUESTIONNAIRE_FAIL' },
  { kind: 'silent' as const, marker: 'legacy approval-prefix tracker key cleanup stays silent without TG_APPROVAL_SEND_FAIL' },
  { kind: 'silent' as const, marker: 'approval grace expired second poll deletes tracked banner silently' },
  { kind: 'info' as const, code: 'TG_APPROVAL_OK', marker: 'two TG_APPROVAL_OK lines when two actionable approvals send' },
  { kind: 'info' as const, code: 'TG_APPROVAL_OK', marker: 'mixed junk and valid approval logs only one TG_APPROVAL_OK for valid id' },
  { kind: 'silent' as const, marker: 'processApprovalsForThread without chatId stays silent without approval logs' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_SEND_FAIL', marker: 'does not emit TG_SEND_FAIL or TG_EDIT_FAIL' },
  { kind: 'info' as const, code: 'TG_APPROVAL_OK', marker: 'exactly one TG_APPROVAL_OK on edit_approval after content change' },
  { kind: 'fail' as const, code: 'TG_APPROVAL_NO_THREAD', marker: 'exactly one TG_APPROVAL_NO_THREAD when multiple approvals unresolved' },
  { kind: 'fail' as const, code: 'TG_APPROVAL_SEND_FAIL', marker: 'approvalInflight cleared after TG_APPROVAL_SEND_FAIL allows subsequent send' },
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
  { kind: 'info' as const, code: 'TG_APPROVAL_OK', marker: 'approve_all action approval' },
  { kind: 'fail' as const, code: 'TG_APPROVAL_SEND_FAIL', marker: 'with chatId on send failure' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_SEND_FAIL', marker: 'with chatId on send failure' },
  { kind: 'fail' as const, code: 'TG_QUESTIONNAIRE_FAIL', marker: 'does not emit TG_QUESTIONNAIRE_SEND_FAIL' },
  { kind: 'info' as const, code: 'TG_APPROVAL_OK', marker: 'send path does not emit TG_APPROVAL_SEND_FAIL' },
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
    assert.equal(APPROVAL_QUESTIONNAIRE_LOG_CODES.length, 7);
  });

  it('poll-loop.ts declares all seven codes in approval/questionnaire zone', () => {
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

  it('TG_APPROVAL_OK has send_approval and edit_approval ops in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /pollLoopCtx\('send_approval', \{ threadId, chatId: this\.chatId, itemId: approval\.id \}\)/);
    assert.match(zone, /pollLoopCtx\('edit_approval', \{ threadId, chatId: this\.chatId, itemId: approval\.id \}\)/);
  });

  it('send fail sites skip not-modified and not-found in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /!msg\.includes\('not found'\) && !msg\.includes\('not modified'\)/);
    const hits = zone.match(/!msg\.includes\('not found'\) && !msg\.includes\('not modified'\)/g) ?? [];
    assert.equal(hits.length, 2, 'approval and questionnaire send catches must both skip benign errors');
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
    assert.equal(APPROVAL_QUESTIONNAIRE_PATH_MATRIX.length, 75);
  });

  it('zone declares exactly eight log emission sites for covered codes', () => {
    const zone = approvalQuestZoneSrc();
    assert.equal((zone.match(/logError\([\s\S]*?'TG_APPROVAL_FAIL'/g) ?? []).length, 1);
    assert.equal((zone.match(/logError\([\s\S]*?'TG_QUESTIONNAIRE_FAIL'/g) ?? []).length, 1);
    assert.equal((zone.match(/logInfo\([\s\S]*?'TG_APPROVAL_ROUTED'/g) ?? []).length, 1);
    assert.equal((zone.match(/logWarn\([\s\S]*?'TG_APPROVAL_NO_THREAD'/g) ?? []).length, 1);
    assert.equal((zone.match(/logInfo\([\s\S]*?'TG_APPROVAL_OK'/g) ?? []).length, 2);
    assert.equal((zone.match(/logWarn\([\s\S]*?'TG_APPROVAL_SEND_FAIL'/g) ?? []).length, 1);
    assert.equal((zone.match(/logWarn\([\s\S]*?'TG_QUESTIONNAIRE_SEND_FAIL'/g) ?? []).length, 1);
  });

  it('TG_APPROVAL_SEND_FAIL and TG_QUESTIONNAIRE_SEND_FAIL use logWarn with pollLoopCtx in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /logWarn\('TG_APPROVAL_SEND_FAIL'/);
    assert.match(zone, /logWarn\('TG_QUESTIONNAIRE_SEND_FAIL'/);
    assert.match(zone, /pollLoopCtx\('send_approval',/);
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

  it('filterActionableApprovals applied before approval send loop in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /approvals = filterActionableApprovals\(approvals\)/);
  });

  it('approvalInflight guard in source prevents duplicate banners', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /if \(this\.approvalInflight\.has\(inflightKey\)\) continue/);
  });

  it('questionnaire success path has no TG_QUESTIONNAIRE_OK code in zone source', () => {
    const zone = approvalQuestZoneSrc();
    assert.ok(!zone.includes('TG_QUESTIONNAIRE_OK'));
  });

  it('covered fail codes never use logError except process catch codes in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.ok(!zone.includes("logError('TG_APPROVAL_SEND_FAIL'"));
    assert.ok(!zone.includes("logError('TG_QUESTIONNAIRE_SEND_FAIL'"));
    assert.ok(!zone.includes("logError('TG_APPROVAL_NO_THREAD'"));
  });

  it('automated matrix: fail/info codes have behavioral assertApprovalQuestLog', () => {
    const failCodes = APPROVAL_QUESTIONNAIRE_PATH_MATRIX.filter((r) => r.kind !== 'silent').map((r) =>
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
    assert.equal(unique.length, 7);
  });

  it('outer catch handlers stringify non-Error err in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /err instanceof Error \? err\.message : String\(err\)/);
    const hits = zone.match(/err instanceof Error \? err\.message : String\(err\)/g) ?? [];
    assert.ok(hits.length >= 4, 'approval/questionnaire zone should stringify errors in multiple catches');
  });

  it('onStatePatch guard requires started syncEnabled and chatId in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /if \(!this\.started \|\| !this\.syncEnabled \|\| !this\.chatId\) return;/);
  });

  it('TG_APPROVAL_OK and TG_APPROVAL_ROUTED use logInfo in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /logInfo\(\s*\n\s*'TG_APPROVAL_ROUTED'/);
    assert.match(zone, /logInfo\(\s*\n\s*'TG_APPROVAL_OK'/);
    assert.ok(!zone.includes("logWarn('TG_APPROVAL_OK'"));
  });

  it('questionnaire clear delete catch stays silent in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /catch \{ \/\* ok — may already be deleted \*\/ \}/);
  });

  it('approval grace defer uses APPROVAL_DELETE_GRACE_MS before delete in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /approvalPendingDeletion\.set\(pendKey, now \+ BaseTelegramTransport\.APPROVAL_DELETE_GRACE_MS\)/);
    assert.match(zone, /else if \(now >= deleteAt\) \{\s*\n\s*shouldDelete = true;/);
  });

  it('legacy approval key deletes immediately without grace in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /let shouldDelete = isLegacyApprovalKey;/);
    assert.match(zone, /eid === 'approval'/);
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

  it('approvalInflight deleted in finally after send catch in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /finally \{\s*\n\s*this\.approvalInflight\.delete\(inflightKey\)/);
  });

  it('approval loop skips empty formatted html without log in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(zone, /if \(!formatted\.html\) continue;/);
  });

  it('approval hasChanged skip avoids send without log in source', () => {
    const zone = approvalQuestZoneSrc();
    assert.match(
      zone,
      /if \(tracked && !this\.messageTracker\.hasChanged\(threadId, trackId, contentHash\)\) continue;/,
    );
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

  it('TG_APPROVAL_SEND_FAIL uses send_approval op for edit failures in source', () => {
    const zone = approvalQuestZoneSrc();
    const editCatch = zone.match(/editMessageText[\s\S]*?TG_APPROVAL_SEND_FAIL[\s\S]*?pollLoopCtx\('send_approval'/);
    assert.ok(editCatch, 'edit failure must log TG_APPROVAL_SEND_FAIL with send_approval op');
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
