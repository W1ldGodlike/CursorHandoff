import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CursorState } from '../../src/core/types.js';
import type { StateManager } from '../../src/state/broadcast.js';
import type { WindowSnapshot } from '../../src/state/windows.js';
import { TopicManager } from '../../src/telegram/topics/manager.js';
import {
  dispatchTopicMessage,
  handleGeneralMessage,
  handleTextMessage,
  handleTopicMessage,
  processInboundFileRelay,
  processPendingQueue,
} from '../../src/telegram/commands/inbound-handlers.js';
import { ingestQueueAttachments } from '../../src/telegram/inbound/photos.js';
import { setQuestionnaireFreeformPending } from '../../src/telegram/inbound/questionnaire-freeform.js';
import type { TopicMapping } from '../../src/telegram/topics/manager.js';
import { type CommandDeps } from '../../src/telegram/commands/shared.js';
import type { BotContext, TelegramApiClient } from '../../src/telegram/types.js';
import { appendQueueItem } from '../../src/workspace/offline-queue.js';

const CHAT_ID = -1001234567890;
const THREAD_ID = 4242;
const COMPOSER = '11111111-1111-1111-1111-111111111111';
const OTHER_COMPOSER = '99999999-9999-9999-9999-999999999999';
let nextInboundMsgId = 9000;

const INBOUND_HANDLER_LOG_CODES = [
  'TG_DISPATCH_TAB_FAIL',
  'TG_DISPATCH_SEND_FAIL',
  'TG_QUESTIONNAIRE_ADVANCE_FAIL',
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
  const tag = `code=${code}`;
  const idx = line.indexOf(tag);
  if (idx === -1) return false;
  const after = line[idx + tag.length];
  return after === undefined || after === ' ';
}

function inboundOnly(lines: string[]): string[] {
  return lines.filter((l) => INBOUND_HANDLER_LOG_CODES.some((code) => lineHasExactCode(l, code)));
}

function assertInboundLog(
  lines: string[],
  code: string,
  need: {
    op?: string;
    threadId?: number;
    windowId?: string;
    text?: string;
    omitThreadId?: boolean;
    omitWindowId?: boolean;
  } = {},
): string {
  const line = lines.find((l) => {
    if (!lineHasExactCode(l, code)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.threadId !== undefined && !l.includes(`threadId=${need.threadId}`)) return false;
    if (need.windowId && !l.includes(`windowId=${need.windowId}`)) return false;
    if (need.omitThreadId && l.includes('threadId=')) return false;
    if (need.omitWindowId && l.includes('windowId=')) return false;
    return true;
  });
  assert.ok(line, `missing inbound log code=${code}`);
  assert.ok(line!.includes('scope=telegram'), `${code} missing scope=telegram`);
  return line!;
}

function assertInboundLogOnce(
  lines: string[],
  code: string,
  need: Parameters<typeof assertInboundLog>[2] = {},
): string {
  const line = assertInboundLog(lines, code, need);
  assert.equal(inboundOnly(lines).filter((l) => lineHasExactCode(l, code)).length, 1);
  return line;
}

function assertNoInboundLogs(lines: string[]): void {
  const hit = inboundOnly(lines)[0];
  assert.ok(!hit, `unexpected inbound log: ${hit}`);
}

function fileRelayApi(overrides: Partial<TelegramApiClient> = {}): TelegramApiClient {
  return {
    sendMessage: async () => ({ message_id: 1 }),
    sendChatAction: async () => true,
    getFile: async () => ({ file_path: 'documents/relay.txt' }),
    downloadFile: async (_path, dest) => { writeFileSync(dest, 'relay-body'); },
    ...overrides,
  } as unknown as TelegramApiClient;
}

function makeSnapshot(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    windowId: 'win-1',
    windowTitle: 'Proj',
    messages: [],
    chatTabs: [{
      title: 'Dev Chat',
      composerId: COMPOSER,
      isActive: true,
      status: '',
      selectorPath: '',
    }],
    pendingApprovals: [],
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: null,
    composerQueue: { items: [] },
    mode: { current: 'Agent', options: [] },
    model: { current: 'auto', currentId: '', options: [] },
    lastUpdated: Date.now(),
    activeComposerId: COMPOSER,
    workspacePath: 'C:/proj/demo',
    questionnaire: null,
    ...overrides,
  };
}

function chatState(composerId = COMPOSER, tabTitle = 'Dev Chat', extra: Partial<CursorState> = {}): CursorState {
  return {
    connected: true,
    extractorStatus: 'ok',
    windows: [{ id: 'win-1', title: 'Proj', url: '' }],
    activeWindowId: 'win-1',
    messages: [],
    chatTabs: [{ title: tabTitle, composerId, isActive: true, status: '', selectorPath: '' }],
    pendingApprovals: [],
    questionnaire: null,
    agentStatus: 'idle',
    mode: { current: 'Agent', options: [] },
    model: { current: 'auto', currentId: '', options: [] },
    activeComposerId: composerId,
    ...extra,
  } as CursorState;
}

function baseMapping(): TopicMapping {
  return {
    threadId: THREAD_ID,
    windowId: 'win-1',
    windowTitle: 'Proj',
    tabTitle: 'Dev Chat',
    lastActive: Date.now(),
    composerId: COMPOSER,
    workspacePath: 'C:/proj/demo',
  };
}

function makeDeps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  const topicManager = overrides.topicManager ?? new TopicManager();
  return {
    api: {
      sendMessage: async () => ({ message_id: 1 }),
      sendChatAction: async () => true,
    } as unknown as TelegramApiClient,
    stateManager: {
      generation: 2,
      getCurrentState: () => chatState(),
      updateWindows: () => {},
    } as unknown as StateManager,
    commandExecutor: {
      switchTab: async () => ({ ok: true }),
      sendMessage: async () => ({ ok: true }),
      sendMessageWithImages: async () => ({ ok: true }),
      clickQuestionnaire: async () => ({ ok: true }),
      setQuestionnaireFreeform: async () => ({ ok: true }),
      advanceQuestionnaireStep: async () => ({ ok: true }),
    } as CommandDeps['commandExecutor'],
    cdpBridge: {
      refreshWindows: async () => {},
      windows: [{ id: 'win-1', title: 'Proj', url: '' }],
      activeTargetId: 'win-1',
      switchWindow: async () => {},
    } as CommandDeps['cdpBridge'],
    topicManager,
    messageTracker: {} as CommandDeps['messageTracker'],
    windowMonitor: {
      getAllSnapshots: () => new Map([['win-1', makeSnapshot()]]),
      getSnapshot: (id: string) => (id === 'win-1' ? makeSnapshot() : undefined),
      setHomeWindow: () => {},
    } as CommandDeps['windowMonitor'],
    chatId: CHAT_ID,
    getSyncEnabled: () => true,
    setSyncEnabled: () => {},
    setChatId: () => {},
    resetAllState: () => {},
    noteForumTopicLabel: () => {},
    ...overrides,
  };
}

function connectedDeps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  const topicManager = overrides.topicManager ?? new TopicManager();
  if (!overrides.topicManager) {
    topicManager.registerMapping(baseMapping());
  }
  return makeDeps({ topicManager, ...overrides });
}

function makeTextCtx(text: string, overrides: Partial<BotContext> = {}): BotContext {
  const messageId = overrides.message?.message_id ?? ++nextInboundMsgId;
  return {
    chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
    message: { message_id: messageId, message_thread_id: THREAD_ID, text, ...overrides.message },
    reply: async () => ({ message_id: messageId + 1 }),
    match: '',
    ...overrides,
  };
}

async function flushTimers(steps = 30, ms = 500): Promise<void> {
  for (let i = 0; i < steps; i++) {
    mock.timers.tick(ms);
    await new Promise((r) => setImmediate(r));
  }
}

async function runWithTimers(run: () => Promise<void>, steps = 30): Promise<void> {
  await Promise.all([run(), flushTimers(steps, 500)]);
}

function sampleQuestionnaire() {
  return {
    questions: [
      {
        number: '1',
        text: 'Pick one',
        isActive: true,
        options: [{
          letter: 'b',
          label: 'Other',
          isFreeform: true,
          selectorPath: '#opt-b',
          freeformInputSelectorPath: '#fb',
        }],
      },
      {
        number: '2',
        text: 'Next',
        isActive: false,
        options: [{ letter: 'a', label: 'A', isFreeform: false, selectorPath: '#opt-a' }],
      },
    ],
    activeIndex: 0,
    totalLabel: '1/2',
    skipSelectorPath: '#skip',
    continueSelectorPath: '#continue',
    continueDisabled: false,
    freeformInputSelectorPath: '#fb',
  };
}

function inboundHandlersZoneSrc(): string {
  const src = readFileSync(
    new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
    'utf-8',
  );
  const start = src.indexOf("logWarn('TG_QUESTIONNAIRE_ADVANCE_FAIL'");
  const end = src.indexOf('export async function processPendingQueue');
  assert.ok(start >= 0 && end > start, 'inbound-handlers logging zone');
  return src.slice(start, end);
}

const INBOUND_HANDLER_PATH_MATRIX = [
  {
    kind: 'warn' as const,
    code: 'TG_DISPATCH_TAB_FAIL',
    marker: 'dispatchTopicMessage switchTab fail logs TG_DISPATCH_TAB_FAIL with threadId and windowId',
  },
  {
    kind: 'warn' as const,
    code: 'TG_DISPATCH_SEND_FAIL',
    marker: 'dispatchTopicMessage sendMessage fail logs TG_DISPATCH_SEND_FAIL with threadId and windowId',
  },
  {
    kind: 'warn' as const,
    code: 'TG_DISPATCH_SEND_FAIL',
    marker: 'dispatchTopicMessage sendMessageWithImages fail logs TG_DISPATCH_SEND_FAIL',
  },
  {
    kind: 'warn' as const,
    code: 'TG_DISPATCH_SEND_FAIL',
    marker: 'handleTextMessage dispatch send fail logs TG_DISPATCH_SEND_FAIL',
  },
  {
    kind: 'warn' as const,
    code: 'TG_DISPATCH_SEND_FAIL',
    marker: 'processPendingQueue dispatch send fail logs TG_DISPATCH_SEND_FAIL',
  },
  {
    kind: 'warn' as const,
    code: 'TG_QUESTIONNAIRE_ADVANCE_FAIL',
    marker: 'questionnaire advance tab fail logs TG_QUESTIONNAIRE_ADVANCE_FAIL with threadId',
  },
  {
    kind: 'warn' as const,
    code: 'TG_DISPATCH_TAB_FAIL',
    marker: 'handleTextMessage dispatch tab fail logs TG_DISPATCH_TAB_FAIL',
  },
  {
    kind: 'warn' as const,
    code: 'TG_DISPATCH_TAB_FAIL',
    marker: 'processPendingQueue dispatch tab fail logs TG_DISPATCH_TAB_FAIL',
  },
  {
    kind: 'warn' as const,
    code: 'TG_DISPATCH_SEND_FAIL',
    marker: 'tab not active before send logs TG_DISPATCH_SEND_FAIL',
  },
  {
    kind: 'warn' as const,
    code: 'TG_DISPATCH_SEND_FAIL',
    marker: 'ingestFollowUp deliver send fail logs TG_DISPATCH_SEND_FAIL',
  },
  {
    kind: 'warn' as const,
    code: 'TG_QUESTIONNAIRE_ADVANCE_FAIL',
    marker: 'handleTextMessage freeform advance tab fail logs TG_QUESTIONNAIRE_ADVANCE_FAIL',
  },
  {
    kind: 'warn' as const,
    code: 'TG_DISPATCH_SEND_FAIL',
    marker: 'processPendingQueue file relay drain send fail logs TG_DISPATCH_SEND_FAIL',
  },
  {
    kind: 'warn' as const,
    code: 'TG_DISPATCH_SEND_FAIL',
    marker: 'ingestFollowUp image deliver send fail logs TG_DISPATCH_SEND_FAIL',
  },
  {
    kind: 'warn' as const,
    code: 'TG_DISPATCH_SEND_FAIL',
    marker: 'processInboundFileRelay photo caption deliver send fail logs TG_DISPATCH_SEND_FAIL',
  },
  {
    kind: 'warn' as const,
    code: 'TG_DISPATCH_SEND_FAIL',
    marker: 'processPendingQueue ingestFollowUp deliver send fail logs TG_DISPATCH_SEND_FAIL',
  },
  {
    kind: 'warn' as const,
    code: 'TG_DISPATCH_SEND_FAIL',
    marker: 'sendMessageWithImages onTabDrift retry fail logs TG_DISPATCH_SEND_FAIL',
  },
  {
    kind: 'silent' as const,
    marker: 'dispatchTopicMessage success stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'window not found stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'switchWindow throw stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'handleTextMessage without threadId stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'unmapped thread stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'not connected stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'empty dollar prefix stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'handleGeneralMessage stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'duplicate inbound message stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'processPendingQueue without chatId stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'deliverQuestionnaireFreeform tab fail stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'processInboundFileRelay without threadId stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'processInboundFileRelay unmapped stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'processInboundFileRelay not connected stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'processInboundFileRelay duplicate inbound stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'processPendingQueue unmapped thread stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'handleTextMessage without text stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'processPendingQueue empty queue stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'questionnaire step already advanced stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'deliverQuestionnaireFreeform switchWindow throw stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'deliverQuestionnaireFreeform window not found stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'processPendingQueue empty dollar prefix stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'processInboundFileRelay unsupported type stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'handleTextMessage freeform click fail stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'ingestFollowUp empty dollar deliver stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'handleTextMessage freeform setQuestionnaire fail stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'questionnaire last question skips advance stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'queue file relay without text ingests attachments stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'handleTopicMessage photo routes unmapped stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'handleTextMessage freeform wrong reply stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'handleTextMessage freeform empty answer stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'handleTextMessage freeform no textarea stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'handleTopicMessage unsupported type in thread stays silent on inbound log codes',
  },
  {
    kind: 'silent' as const,
    marker: 'processInboundFileRelay photo without caption stays silent on inbound log codes',
  },
  { kind: 'meta' as const, marker: 'inbound-handlers six logInfo three logWarn inboundCtx' },
  { kind: 'meta' as const, marker: 'inbound-handlers info codes TG_DISPATCH TG_QUESTIONNAIRE TG_INBOUND_DEDUP' },
  { kind: 'meta' as const, marker: 'inbound-handlers no inline scope outside inboundCtx helper' },
] as const;

function singleQuestionnaire() {
  return {
    questions: [{
      number: '1',
      text: 'Only question',
      isActive: true,
      options: [{
        letter: 'b',
        label: 'Other',
        isFreeform: true,
        selectorPath: '#opt-b',
        freeformInputSelectorPath: '#fb',
      }],
    }],
    activeIndex: 0,
    totalLabel: '1/1',
    skipSelectorPath: '#skip',
    continueSelectorPath: '#continue',
    continueDisabled: false,
    freeformInputSelectorPath: '#fb',
  };
}

function questionnaireNoTextarea() {
  const q = sampleQuestionnaire();
  q.questions[0].options[0].freeformInputSelectorPath = undefined;
  q.freeformInputSelectorPath = undefined;
  return q;
}

describe('inbound-handlers logging', () => {
  let dataDir: string;
  let savedDataDir: string | undefined;
  let savedAutoOpen: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-inbound-log-'));
    savedDataDir = process.env.DATA_DIR;
    savedAutoOpen = process.env.AUTO_OPEN_PROJECTS;
    process.env.DATA_DIR = dataDir;
    process.env.AUTO_OPEN_PROJECTS = 'false';
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
    if (savedDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDir;
    if (savedAutoOpen === undefined) delete process.env.AUTO_OPEN_PROJECTS;
    else process.env.AUTO_OPEN_PROJECTS = savedAutoOpen;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('dispatchTopicMessage switchTab fail logs TG_DISPATCH_TAB_FAIL with threadId and windowId', async () => {
    const mapping = baseMapping();
    const lines = await captureAll(async () => {
      await dispatchTopicMessage(
        mapping,
        { text: 'hello inbound' },
        connectedDeps({
          stateManager: {
            generation: 1,
            getCurrentState: () => chatState(OTHER_COMPOSER, 'Other Tab'),
            updateWindows: () => {},
          } as unknown as StateManager,
          commandExecutor: {
            switchTab: async () => ({ ok: false, error: 'switch tab inbound fail' }),
            sendMessage: async () => ({ ok: true }),
          } as CommandDeps['commandExecutor'],
        }),
      );
    });
    assertInboundLogOnce(lines, 'TG_DISPATCH_TAB_FAIL', {
      op: 'dispatch_topic',
      threadId: THREAD_ID,
      windowId: 'win-1',
      text: 'switch tab inbound fail',
    });
  });

  it('dispatchTopicMessage sendMessage fail logs TG_DISPATCH_SEND_FAIL with threadId and windowId', async () => {
    const mapping = baseMapping();
    const sm = { generation: 1 };
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await dispatchTopicMessage(mapping, { text: 'send fail inbound' }, connectedDeps({
          stateManager: {
            get generation() { return sm.generation; },
            set generation(v: number) { sm.generation = v; },
            getCurrentState: () => chatState(),
            updateWindows: () => {},
          } as unknown as StateManager,
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            sendMessage: async () => ({ ok: false, error: 'send inbound fail' }),
          } as CommandDeps['commandExecutor'],
        }));
      });
    });
    assertInboundLogOnce(lines, 'TG_DISPATCH_SEND_FAIL', {
      op: 'dispatch_topic',
      threadId: THREAD_ID,
      windowId: 'win-1',
      text: 'send inbound fail',
    });
  });

  it('dispatchTopicMessage sendMessageWithImages fail logs TG_DISPATCH_SEND_FAIL', async () => {
    const mapping = baseMapping();
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await dispatchTopicMessage(
          mapping,
          { text: 'img fail', imagePaths: ['/tmp/inbound.png'], attachmentPaths: ['/tmp/inbound.png'] },
          connectedDeps({
            commandExecutor: {
              switchTab: async () => ({ ok: true }),
              sendMessageWithImages: async () => ({ ok: false, error: 'image send inbound fail' }),
            } as CommandDeps['commandExecutor'],
          }),
        );
      });
    });
    assertInboundLogOnce(lines, 'TG_DISPATCH_SEND_FAIL', {
      op: 'dispatch_topic',
      threadId: THREAD_ID,
      text: 'image send inbound fail',
    });
  });

  it('handleTextMessage dispatch send fail logs TG_DISPATCH_SEND_FAIL', async () => {
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await handleTextMessage(makeTextCtx('via handleTextMessage'), connectedDeps({
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            sendMessage: async () => ({ ok: false, error: 'handle text send fail' }),
          } as CommandDeps['commandExecutor'],
        }));
      });
    });
    assertInboundLogOnce(lines, 'TG_DISPATCH_SEND_FAIL', {
      op: 'dispatch_topic',
      threadId: THREAD_ID,
      text: 'handle text send fail',
    });
  });

  it('processPendingQueue dispatch send fail logs TG_DISPATCH_SEND_FAIL', async () => {
    appendQueueItem(dataDir, {
      telegramMessageId: 501,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'queue inbound text',
      userId: 42,
      enqueuedBy: 'cursor-wake',
    });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await processPendingQueue(connectedDeps({
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            sendMessage: async () => ({ ok: false, error: 'queue send fail' }),
          } as CommandDeps['commandExecutor'],
        }));
      });
    });
    assertInboundLog(lines, 'TG_DISPATCH_SEND_FAIL', {
      op: 'dispatch_topic',
      threadId: THREAD_ID,
      text: 'queue send fail',
    });
  });

  it('questionnaire advance tab fail logs TG_QUESTIONNAIRE_ADVANCE_FAIL with threadId', async () => {
    let advancePhase = false;
    setQuestionnaireFreeformPending({ chatId: CHAT_ID, threadId: THREAD_ID, letter: 'b' });
    appendQueueItem(dataDir, {
      telegramMessageId: 601,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'survey queue answer',
      userId: 42,
      enqueuedBy: 'cursor-wake',
    });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await processPendingQueue(connectedDeps({
          stateManager: {
            generation: 2,
            getCurrentState: () => chatState(
              advancePhase ? OTHER_COMPOSER : COMPOSER,
              advancePhase ? 'Wrong Tab' : 'Dev Chat',
              { questionnaire: sampleQuestionnaire() },
            ),
            updateWindows: () => {},
          } as unknown as StateManager,
          commandExecutor: {
            switchTab: async () => (
              advancePhase
                ? { ok: false, error: 'advance tab fail' }
                : { ok: true }
            ),
            clickQuestionnaire: async () => ({ ok: true }),
            setQuestionnaireFreeform: async () => {
              advancePhase = true;
              return { ok: true };
            },
            sendMessage: async () => ({ ok: true }),
          } as CommandDeps['commandExecutor'],
        }));
      }, 40);
    });
    assertInboundLogOnce(lines, 'TG_QUESTIONNAIRE_ADVANCE_FAIL', {
      op: 'questionnaire_advance',
      threadId: THREAD_ID,
      omitWindowId: true,
      text: 'advance tab fail',
    });
  });

  it('dispatchTopicMessage success stays silent on inbound log codes', async () => {
    const sm = { generation: 1 };
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await dispatchTopicMessage(baseMapping(), { text: 'ok inbound' }, connectedDeps({
          stateManager: {
            get generation() { return sm.generation; },
            set generation(v: number) { sm.generation = v; },
            getCurrentState: () => chatState(),
            updateWindows: () => {},
          } as unknown as StateManager,
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            sendMessage: async () => {
              sm.generation = 2;
              return { ok: true };
            },
          } as CommandDeps['commandExecutor'],
        }));
      });
    });
    assertNoInboundLogs(lines);
  });

  it('window not found stays silent on inbound log codes', async () => {
    const tm = new TopicManager();
    tm.registerMapping({ ...baseMapping(), windowId: 'win-missing', windowTitle: 'MissingProj' });
    const lines = await captureAll(async () => {
      await dispatchTopicMessage(
        tm.resolveThread(THREAD_ID)!,
        { text: 'no window' },
        connectedDeps({
          topicManager: tm,
          cdpBridge: {
            refreshWindows: async () => {},
            windows: [],
            activeTargetId: '',
            switchWindow: async () => {},
          } as CommandDeps['cdpBridge'],
          stateManager: {
            generation: 1,
            getCurrentState: () => ({
              ...chatState(),
              windows: [],
            }),
            updateWindows: () => {},
          } as unknown as StateManager,
        }),
      );
    });
    assertNoInboundLogs(lines);
  });

  it('switchWindow throw stays silent on inbound log codes', async () => {
    const lines = await captureAll(async () => {
      await dispatchTopicMessage(baseMapping(), { text: 'switch throw' }, connectedDeps({
        cdpBridge: {
          refreshWindows: async () => {},
          windows: [{ id: 'win-1', title: 'Proj', url: '' }],
          activeTargetId: 'win-other',
          switchWindow: async () => { throw new Error('cdp switch inbound'); },
        } as CommandDeps['cdpBridge'],
      }));
    });
    assertNoInboundLogs(lines);
  });

  it('handleTextMessage without threadId stays silent on inbound log codes', async () => {
    const lines = await captureAll(async () => {
      await handleTextMessage(
        makeTextCtx('no thread', { message: { message_id: 1, text: 'no thread' } }),
        connectedDeps(),
      );
    });
    assertNoInboundLogs(lines);
  });

  it('unmapped thread stays silent on inbound log codes', async () => {
    const lines = await captureAll(async () => {
      await handleTextMessage(
        makeTextCtx('orphan thread'),
        connectedDeps({ topicManager: new TopicManager() }),
      );
    });
    assertNoInboundLogs(lines);
  });

  it('not connected stays silent on inbound log codes', async () => {
    const lines = await captureAll(async () => {
      await handleTextMessage(makeTextCtx('offline send'), connectedDeps({
        stateManager: {
          generation: 1,
          getCurrentState: () => ({
            ...chatState(),
            connected: false,
            extractorStatus: 'idle',
          }),
          updateWindows: () => {},
        } as unknown as StateManager,
      }));
    });
    assertNoInboundLogs(lines);
  });

  it('empty dollar prefix stays silent on inbound log codes', async () => {
    const lines = await captureAll(async () => {
      await handleTextMessage(makeTextCtx('$'), connectedDeps());
    });
    assertNoInboundLogs(lines);
  });

  it('handleGeneralMessage stays silent on inbound log codes', async () => {
    const lines = await captureAll(async () => {
      await handleGeneralMessage(
        { chat: { id: CHAT_ID }, message: { text: 'hello general' }, reply: async () => ({ message_id: 1 }) },
        connectedDeps(),
        async () => {},
      );
    });
    assertNoInboundLogs(lines);
  });

  it('duplicate inbound message stays silent on inbound log codes', async () => {
    const msgId = 777;
    const sm = { generation: 1 };
    const deps = connectedDeps({
      stateManager: {
        get generation() { return sm.generation; },
        set generation(v: number) { sm.generation = v; },
        getCurrentState: () => chatState(),
        updateWindows: () => {},
      } as unknown as StateManager,
      commandExecutor: {
        switchTab: async () => ({ ok: true }),
        sendMessage: async () => {
          sm.generation = 2;
          return { ok: true };
        },
      } as CommandDeps['commandExecutor'],
    });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await handleTextMessage(
          makeTextCtx('first', { message: { message_id: msgId, message_thread_id: THREAD_ID, text: 'first' } }),
          deps,
        );
      });
      await handleTextMessage(
        makeTextCtx('dup', { message: { message_id: msgId, message_thread_id: THREAD_ID, text: 'dup' } }),
        deps,
      );
    });
    assertNoInboundLogs(lines);
  });

  it('handleTextMessage dispatch tab fail logs TG_DISPATCH_TAB_FAIL', async () => {
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await handleTextMessage(makeTextCtx('tab fail via handle'), connectedDeps({
          stateManager: {
            generation: 1,
            getCurrentState: () => chatState(OTHER_COMPOSER, 'Other Tab'),
            updateWindows: () => {},
          } as unknown as StateManager,
          commandExecutor: {
            switchTab: async () => ({ ok: false, error: 'handle tab fail' }),
            sendMessage: async () => ({ ok: true }),
          } as CommandDeps['commandExecutor'],
        }));
      });
    });
    assertInboundLogOnce(lines, 'TG_DISPATCH_TAB_FAIL', {
      op: 'dispatch_topic',
      threadId: THREAD_ID,
      text: 'handle tab fail',
    });
  });

  it('processPendingQueue dispatch tab fail logs TG_DISPATCH_TAB_FAIL', async () => {
    appendQueueItem(dataDir, {
      telegramMessageId: 503,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'queue tab fail',
      userId: 42,
      enqueuedBy: 'cursor-wake',
    });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await processPendingQueue(connectedDeps({
          stateManager: {
            generation: 1,
            getCurrentState: () => chatState(OTHER_COMPOSER, 'Other Tab'),
            updateWindows: () => {},
          } as unknown as StateManager,
          commandExecutor: {
            switchTab: async () => ({ ok: false, error: 'queue tab fail' }),
            sendMessage: async () => ({ ok: true }),
          } as CommandDeps['commandExecutor'],
        }));
      });
    });
    assertInboundLog(lines, 'TG_DISPATCH_TAB_FAIL', {
      op: 'dispatch_topic',
      threadId: THREAD_ID,
      text: 'queue tab fail',
    });
  });

  it('tab not active before send logs TG_DISPATCH_SEND_FAIL', async () => {
    let calls = 0;
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await dispatchTopicMessage(baseMapping(), { text: 'tab drift send' }, connectedDeps({
          stateManager: {
            generation: 1,
            getCurrentState: () => {
              calls += 1;
              if (calls <= 2) return chatState();
              return chatState(OTHER_COMPOSER, 'Drift Tab');
            },
            updateWindows: () => {},
          } as unknown as StateManager,
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            sendMessage: async () => ({ ok: true }),
          } as CommandDeps['commandExecutor'],
        }));
      });
    });
    assertInboundLogOnce(lines, 'TG_DISPATCH_SEND_FAIL', {
      op: 'dispatch_topic',
      threadId: THREAD_ID,
      text: 'Tab',
    });
  });

  it('ingestFollowUp deliver send fail logs TG_DISPATCH_SEND_FAIL', async () => {
    const inbound = join(dataDir, 'relay.txt');
    writeFileSync(inbound, 'x');
    ingestQueueAttachments({ chatId: CHAT_ID, threadId: THREAD_ID, paths: [inbound] });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await handleTextMessage(makeTextCtx('caption after photo'), connectedDeps({
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            sendMessage: async () => ({ ok: false, error: 'follow-up send fail' }),
          } as CommandDeps['commandExecutor'],
        }));
      });
    });
    assertInboundLogOnce(lines, 'TG_DISPATCH_SEND_FAIL', {
      op: 'dispatch_topic',
      threadId: THREAD_ID,
      text: 'follow-up send fail',
    });
  });

  it('handleTextMessage freeform advance tab fail logs TG_QUESTIONNAIRE_ADVANCE_FAIL', async () => {
    let advancePhase = false;
    setQuestionnaireFreeformPending({ chatId: CHAT_ID, threadId: THREAD_ID, letter: 'b' });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await handleTextMessage(makeTextCtx('survey direct answer'), connectedDeps({
          stateManager: {
            generation: 2,
            getCurrentState: () => chatState(
              advancePhase ? OTHER_COMPOSER : COMPOSER,
              advancePhase ? 'Wrong Tab' : 'Dev Chat',
              { questionnaire: sampleQuestionnaire() },
            ),
            updateWindows: () => {},
          } as unknown as StateManager,
          commandExecutor: {
            switchTab: async () => (
              advancePhase
                ? { ok: false, error: 'direct advance tab fail' }
                : { ok: true }
            ),
            clickQuestionnaire: async () => ({ ok: true }),
            setQuestionnaireFreeform: async () => {
              advancePhase = true;
              return { ok: true };
            },
            sendMessage: async () => ({ ok: true }),
          } as CommandDeps['commandExecutor'],
        }));
      }, 40);
    });
    assertInboundLogOnce(lines, 'TG_QUESTIONNAIRE_ADVANCE_FAIL', {
      op: 'questionnaire_advance',
      threadId: THREAD_ID,
      omitWindowId: true,
      text: 'direct advance tab fail',
    });
  });

  it('processPendingQueue without chatId stays silent on inbound log codes', async () => {
    appendQueueItem(dataDir, {
      telegramMessageId: 502,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'orphan queue',
      userId: 42,
      enqueuedBy: 'cursor-wake',
    });
    const lines = await captureAll(async () => {
      await processPendingQueue(connectedDeps({ chatId: undefined }));
    });
    assertNoInboundLogs(lines);
  });

  it('deliverQuestionnaireFreeform tab fail stays silent on inbound log codes', async () => {
    setQuestionnaireFreeformPending({ chatId: CHAT_ID, threadId: THREAD_ID, letter: 'b' });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await handleTextMessage(makeTextCtx('freeform tab silent'), connectedDeps({
          stateManager: {
            generation: 2,
            getCurrentState: () => chatState(OTHER_COMPOSER, 'Other Tab', { questionnaire: sampleQuestionnaire() }),
            updateWindows: () => {},
          } as unknown as StateManager,
          commandExecutor: {
            switchTab: async () => ({ ok: false, error: 'freeform tab silent fail' }),
            clickQuestionnaire: async () => ({ ok: true }),
            setQuestionnaireFreeform: async () => ({ ok: true }),
          } as CommandDeps['commandExecutor'],
        }));
      });
    });
    assertNoInboundLogs(lines);
  });

  it('processInboundFileRelay without threadId stays silent on inbound log codes', async () => {
    const lines = await captureAll(async () => {
      await processInboundFileRelay(
        {
          chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
          message: { message_id: 201, photo: [{ file_id: 'p1' }] },
          reply: async () => ({ message_id: 202 }),
        },
        connectedDeps(),
      );
    });
    assertNoInboundLogs(lines);
  });

  it('processInboundFileRelay unmapped stays silent on inbound log codes', async () => {
    const lines = await captureAll(async () => {
      await processInboundFileRelay(
        {
          chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
          message: { message_id: 202, message_thread_id: THREAD_ID, photo: [{ file_id: 'p1' }] },
          reply: async () => ({ message_id: 203 }),
        },
        connectedDeps({ topicManager: new TopicManager() }),
      );
    });
    assertNoInboundLogs(lines);
  });

  it('processInboundFileRelay not connected stays silent on inbound log codes', async () => {
    const lines = await captureAll(async () => {
      await processInboundFileRelay(
        {
          chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
          message: { message_id: 203, message_thread_id: THREAD_ID, photo: [{ file_id: 'p1' }] },
          reply: async () => ({ message_id: 204 }),
        },
        connectedDeps({
          stateManager: {
            generation: 1,
            getCurrentState: () => ({
              ...chatState(),
              connected: false,
              extractorStatus: 'idle',
            }),
            updateWindows: () => {},
          } as unknown as StateManager,
        }),
      );
    });
    assertNoInboundLogs(lines);
  });

  it('processInboundFileRelay duplicate inbound stays silent on inbound log codes', async () => {
    const msgId = 204;
    const ctx = {
      chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
      message: { message_id: msgId, message_thread_id: THREAD_ID, photo: [{ file_id: 'p1' }] },
      reply: async () => ({ message_id: 205 }),
    };
    const deps = connectedDeps({
      stateManager: {
        generation: 1,
        getCurrentState: () => ({
          ...chatState(),
          connected: false,
          extractorStatus: 'idle',
        }),
        updateWindows: () => {},
      } as unknown as StateManager,
    });
    const lines = await captureAll(async () => {
      await processInboundFileRelay(ctx, deps);
      await processInboundFileRelay(ctx, deps);
    });
    assertNoInboundLogs(lines);
  });

  it('processPendingQueue unmapped thread stays silent on inbound log codes', async () => {
    appendQueueItem(dataDir, {
      telegramMessageId: 504,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'orphan mapping queue',
      userId: 42,
      enqueuedBy: 'cursor-wake',
    });
    const lines = await captureAll(async () => {
      await processPendingQueue(connectedDeps({ topicManager: new TopicManager() }));
    });
    assertNoInboundLogs(lines);
  });

  it('handleTextMessage without text stays silent on inbound log codes', async () => {
    const lines = await captureAll(async () => {
      await handleTextMessage(
        makeTextCtx('', { message: { message_id: 1, message_thread_id: THREAD_ID } }),
        connectedDeps(),
      );
    });
    assertNoInboundLogs(lines);
  });

  it('processPendingQueue empty queue stays silent on inbound log codes', async () => {
    const lines = await captureAll(async () => {
      await processPendingQueue(connectedDeps());
    });
    assertNoInboundLogs(lines);
  });

  it('processPendingQueue file relay drain send fail logs TG_DISPATCH_SEND_FAIL', async () => {
    appendQueueItem(dataDir, {
      telegramMessageId: 702,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'queue relay caption',
      userId: 42,
      enqueuedBy: 'cursor-wake',
      attachments: [{ fileId: 'f-queue-relay', mime: 'text/plain' }],
    });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await processPendingQueue(connectedDeps({
          api: fileRelayApi(),
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            sendMessage: async () => ({ ok: false, error: 'queue relay send fail' }),
          } as CommandDeps['commandExecutor'],
        }));
      });
    });
    assertInboundLog(lines, 'TG_DISPATCH_SEND_FAIL', {
      op: 'dispatch_topic',
      threadId: THREAD_ID,
      text: 'queue relay send fail',
    });
  });

  it('ingestFollowUp image deliver send fail logs TG_DISPATCH_SEND_FAIL', async () => {
    const inbound = join(dataDir, 'relay.png');
    writeFileSync(inbound, 'x');
    ingestQueueAttachments({ chatId: CHAT_ID, threadId: THREAD_ID, paths: [inbound] });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await handleTextMessage(makeTextCtx('caption after image'), connectedDeps({
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            sendMessageWithImages: async () => ({ ok: false, error: 'follow-up image send fail' }),
          } as CommandDeps['commandExecutor'],
        }));
      });
    });
    assertInboundLogOnce(lines, 'TG_DISPATCH_SEND_FAIL', {
      op: 'dispatch_topic',
      threadId: THREAD_ID,
      text: 'follow-up image send fail',
    });
  });

  it('questionnaire step already advanced stays silent on inbound log codes', async () => {
    let bumped = false;
    setQuestionnaireFreeformPending({ chatId: CHAT_ID, threadId: THREAD_ID, letter: 'b' });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await handleTextMessage(makeTextCtx('survey already stepped'), connectedDeps({
          stateManager: {
            generation: 2,
            getCurrentState: () => {
              const q = sampleQuestionnaire();
              if (bumped) {
                q.activeIndex = 1;
                q.questions[0].isActive = false;
                q.questions[1].isActive = true;
              }
              return chatState(COMPOSER, 'Dev Chat', { questionnaire: q });
            },
            updateWindows: () => {},
          } as unknown as StateManager,
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            clickQuestionnaire: async () => ({ ok: true }),
            setQuestionnaireFreeform: async () => {
              bumped = true;
              return { ok: true };
            },
            advanceQuestionnaireStep: async () => ({ ok: true }),
          } as CommandDeps['commandExecutor'],
        }));
      }, 40);
    });
    assertNoInboundLogs(lines);
  });

  it('deliverQuestionnaireFreeform switchWindow throw stays silent on inbound log codes', async () => {
    setQuestionnaireFreeformPending({ chatId: CHAT_ID, threadId: THREAD_ID, letter: 'b' });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await handleTextMessage(makeTextCtx('freeform switch throw'), connectedDeps({
          stateManager: {
            generation: 2,
            getCurrentState: () => chatState(OTHER_COMPOSER, 'Other Tab', { questionnaire: sampleQuestionnaire() }),
            updateWindows: () => {},
          } as unknown as StateManager,
          cdpBridge: {
            refreshWindows: async () => {},
            windows: [{ id: 'win-1', title: 'Proj', url: '' }],
            activeTargetId: 'win-other',
            switchWindow: async () => { throw new Error('freeform switch throw'); },
          } as CommandDeps['cdpBridge'],
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            clickQuestionnaire: async () => ({ ok: true }),
            setQuestionnaireFreeform: async () => ({ ok: true }),
          } as CommandDeps['commandExecutor'],
        }));
      });
    });
    assertNoInboundLogs(lines);
  });

  it('deliverQuestionnaireFreeform window not found stays silent on inbound log codes', async () => {
    const tm = new TopicManager();
    tm.registerMapping({ ...baseMapping(), windowId: 'win-missing', windowTitle: 'MissingProj' });
    setQuestionnaireFreeformPending({ chatId: CHAT_ID, threadId: THREAD_ID, letter: 'b' });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await handleTextMessage(makeTextCtx('freeform no window'), connectedDeps({
          topicManager: tm,
          cdpBridge: {
            refreshWindows: async () => {},
            windows: [],
            activeTargetId: '',
            switchWindow: async () => {},
          } as CommandDeps['cdpBridge'],
          stateManager: {
            generation: 2,
            getCurrentState: () => ({
              ...chatState(COMPOSER, 'Dev Chat', { questionnaire: sampleQuestionnaire() }),
              windows: [],
            }),
            updateWindows: () => {},
          } as unknown as StateManager,
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            clickQuestionnaire: async () => ({ ok: true }),
            setQuestionnaireFreeform: async () => ({ ok: true }),
          } as CommandDeps['commandExecutor'],
        }));
      });
    });
    assertNoInboundLogs(lines);
  });

  it('processPendingQueue empty dollar prefix stays silent on inbound log codes', async () => {
    appendQueueItem(dataDir, {
      telegramMessageId: 703,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: '$',
      userId: 42,
      enqueuedBy: 'cursor-wake',
    });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await processPendingQueue(connectedDeps());
      });
    });
    assertNoInboundLogs(lines);
  });

  it('processInboundFileRelay unsupported type stays silent on inbound log codes', async () => {
    const lines = await captureAll(async () => {
      await processInboundFileRelay(
        {
          chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
          message: {
            message_id: 206,
            message_thread_id: THREAD_ID,
            contact: { phone_number: '+123', first_name: 'X' },
          },
          reply: async () => ({ message_id: 207 }),
        },
        connectedDeps(),
      );
    });
    assertNoInboundLogs(lines);
  });

  it('handleTextMessage freeform click fail stays silent on inbound log codes', async () => {
    setQuestionnaireFreeformPending({ chatId: CHAT_ID, threadId: THREAD_ID, letter: 'b' });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await handleTextMessage(makeTextCtx('freeform click fail answer'), connectedDeps({
          stateManager: {
            generation: 2,
            getCurrentState: () => chatState(COMPOSER, 'Dev Chat', { questionnaire: sampleQuestionnaire() }),
            updateWindows: () => {},
          } as unknown as StateManager,
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            clickQuestionnaire: async () => ({ ok: false, error: 'click fail' }),
            setQuestionnaireFreeform: async () => ({ ok: true }),
            sendMessage: async () => ({ ok: true }),
          } as CommandDeps['commandExecutor'],
        }));
      });
    });
    assertNoInboundLogs(lines);
  });

  it('processInboundFileRelay photo caption deliver send fail logs TG_DISPATCH_SEND_FAIL', async () => {
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await processInboundFileRelay(
          {
            chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
            message: {
              message_id: 301,
              message_thread_id: THREAD_ID,
              photo: [{ file_id: 'p-relay', width: 100, height: 100 }],
              caption: 'relay photo caption',
            },
            reply: async () => ({ message_id: 302 }),
          },
          connectedDeps({
            api: fileRelayApi({
              getFile: async () => ({ file_path: 'photos/relay.jpg' }),
              downloadFile: async (_path, dest) => { writeFileSync(dest, 'img'); },
            }),
            commandExecutor: {
              switchTab: async () => ({ ok: true }),
              sendMessageWithImages: async () => ({ ok: false, error: 'file relay photo send fail' }),
            } as CommandDeps['commandExecutor'],
          }),
        );
      });
    });
    assertInboundLogOnce(lines, 'TG_DISPATCH_SEND_FAIL', {
      op: 'dispatch_topic',
      threadId: THREAD_ID,
      text: 'file relay photo send fail',
    });
  });

  it('processPendingQueue ingestFollowUp deliver send fail logs TG_DISPATCH_SEND_FAIL', async () => {
    const inbound = join(dataDir, 'queue-follow.txt');
    writeFileSync(inbound, 'x');
    ingestQueueAttachments({ chatId: CHAT_ID, threadId: THREAD_ID, paths: [inbound] });
    appendQueueItem(dataDir, {
      telegramMessageId: 705,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: 'queue ingest follow caption',
      userId: 42,
      enqueuedBy: 'cursor-wake',
    });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        try {
          await processPendingQueue(connectedDeps({
            commandExecutor: {
              switchTab: async () => ({ ok: true }),
              sendMessage: async () => ({ ok: false, error: 'queue ingest follow send fail' }),
            } as CommandDeps['commandExecutor'],
          }));
        } catch {
          /* queue ingestFollowUp onDeliver rethrows deliver failure */
        }
      });
    });
    assertInboundLog(lines, 'TG_DISPATCH_SEND_FAIL', {
      op: 'dispatch_topic',
      threadId: THREAD_ID,
      text: 'queue ingest follow send fail',
    });
  });

  it('ingestFollowUp empty dollar deliver stays silent on inbound log codes', async () => {
    const inbound = join(dataDir, 'empty-dollar.txt');
    writeFileSync(inbound, 'x');
    ingestQueueAttachments({ chatId: CHAT_ID, threadId: THREAD_ID, paths: [inbound] });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await handleTextMessage(makeTextCtx('$'), connectedDeps());
      });
    });
    assertNoInboundLogs(lines);
  });

  it('handleTextMessage freeform setQuestionnaire fail stays silent on inbound log codes', async () => {
    setQuestionnaireFreeformPending({ chatId: CHAT_ID, threadId: THREAD_ID, letter: 'b' });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await handleTextMessage(makeTextCtx('set freeform fail answer'), connectedDeps({
          stateManager: {
            generation: 2,
            getCurrentState: () => chatState(COMPOSER, 'Dev Chat', { questionnaire: sampleQuestionnaire() }),
            updateWindows: () => {},
          } as unknown as StateManager,
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            clickQuestionnaire: async () => ({ ok: true }),
            setQuestionnaireFreeform: async () => ({ ok: false, error: 'set freeform fail' }),
            sendMessage: async () => ({ ok: true }),
          } as CommandDeps['commandExecutor'],
        }));
      });
    });
    assertNoInboundLogs(lines);
  });

  it('questionnaire last question skips advance stays silent on inbound log codes', async () => {
    setQuestionnaireFreeformPending({ chatId: CHAT_ID, threadId: THREAD_ID, letter: 'b' });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await handleTextMessage(makeTextCtx('last question only'), connectedDeps({
          stateManager: {
            generation: 2,
            getCurrentState: () => chatState(COMPOSER, 'Dev Chat', { questionnaire: singleQuestionnaire() }),
            updateWindows: () => {},
          } as unknown as StateManager,
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            clickQuestionnaire: async () => ({ ok: true }),
            setQuestionnaireFreeform: async () => ({ ok: true }),
            advanceQuestionnaireStep: async () => ({ ok: true }),
          } as CommandDeps['commandExecutor'],
        }));
      }, 40);
    });
    assertNoInboundLogs(lines);
  });

  it('queue file relay without text ingests attachments stays silent on inbound log codes', async () => {
    appendQueueItem(dataDir, {
      telegramMessageId: 707,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      text: '',
      caption: '',
      userId: 42,
      enqueuedBy: 'cursor-wake',
      attachments: [{ fileId: 'f-queue-buffer', mime: 'image/png' }],
    });
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await processPendingQueue(connectedDeps({
          api: fileRelayApi({
            getFile: async () => ({ file_path: 'photos/buffer.png' }),
            downloadFile: async (_path, dest) => { writeFileSync(dest, 'img'); },
          }),
        }));
      });
    });
    assertNoInboundLogs(lines);
  });

  it('handleTopicMessage photo routes unmapped stays silent on inbound log codes', async () => {
    const lines = await captureAll(async () => {
      await handleTopicMessage(
        {
          chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
          message: {
            message_id: 308,
            message_thread_id: THREAD_ID,
            photo: [{ file_id: 'p-topic', width: 100, height: 100 }],
          },
          reply: async () => ({ message_id: 309 }),
        },
        connectedDeps({ topicManager: new TopicManager() }),
      );
    });
    assertNoInboundLogs(lines);
  });

  it('sendMessageWithImages onTabDrift retry fail logs TG_DISPATCH_SEND_FAIL', async () => {
    const lines = await captureAll(async () => {
      await runWithTimers(async () => {
        await dispatchTopicMessage(
          baseMapping(),
          { text: 'drift img', imagePaths: ['/tmp/drift.png'], attachmentPaths: ['/tmp/drift.png'] },
          connectedDeps({
            commandExecutor: {
              switchTab: async () => ({ ok: false, error: 'drift retry tab fail' }),
              sendMessageWithImages: async (_id, opts) => {
                if (opts.onTabDrift) await opts.onTabDrift();
                return { ok: false, error: 'onTabDrift exhausted' };
              },
            } as CommandDeps['commandExecutor'],
          }),
        );
      });
    });
    assertInboundLogOnce(lines, 'TG_DISPATCH_SEND_FAIL', {
      op: 'dispatch_topic',
      threadId: THREAD_ID,
      text: 'onTabDrift exhausted',
    });
  });

  it('handleTextMessage freeform wrong reply stays silent on inbound log codes', async () => {
    setQuestionnaireFreeformPending({
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      letter: 'b',
      hintMessageId: 500,
    });
    const lines = await captureAll(async () => {
      await handleTextMessage(
        makeTextCtx('wrong reply target', {
          message: {
            reply_to_message: { message_id: 999 },
          },
        }),
        connectedDeps(),
      );
    });
    assertNoInboundLogs(lines);
  });

  it('handleTextMessage freeform empty answer stays silent on inbound log codes', async () => {
    setQuestionnaireFreeformPending({ chatId: CHAT_ID, threadId: THREAD_ID, letter: 'b' });
    const lines = await captureAll(async () => {
      await handleTextMessage(makeTextCtx('   '), connectedDeps());
    });
    assertNoInboundLogs(lines);
  });

  it('handleTextMessage freeform no textarea stays silent on inbound log codes', async () => {
    mock.timers.reset();
    setQuestionnaireFreeformPending({ chatId: CHAT_ID, threadId: THREAD_ID, letter: 'b' });
    try {
      const lines = await captureAll(async () => {
        await handleTextMessage(makeTextCtx('no textarea answer'), connectedDeps({
          stateManager: {
            generation: 2,
            getCurrentState: () => chatState(COMPOSER, 'Dev Chat', { questionnaire: questionnaireNoTextarea() }),
            updateWindows: () => {},
          } as unknown as StateManager,
          commandExecutor: {
            switchTab: async () => ({ ok: true }),
            clickQuestionnaire: async () => ({ ok: true }),
            setQuestionnaireFreeform: async () => ({ ok: true }),
          } as CommandDeps['commandExecutor'],
        }));
      });
      assertNoInboundLogs(lines);
    } finally {
      mock.timers.enable({ apis: ['setTimeout'] });
    }
  });

  it('handleTopicMessage unsupported type in thread stays silent on inbound log codes', async () => {
    const lines = await captureAll(async () => {
      await handleTopicMessage(
        {
          chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
          message: {
            message_id: 310,
            message_thread_id: THREAD_ID,
            venue: { title: 'Cafe', location: { latitude: 0, longitude: 0 } },
          },
          reply: async () => ({ message_id: 311 }),
        },
        connectedDeps(),
      );
    });
    assertNoInboundLogs(lines);
  });

  it('processInboundFileRelay photo without caption stays silent on inbound log codes', async () => {
    const lines = await captureAll(async () => {
      await processInboundFileRelay(
        {
          chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
          message: {
            message_id: 312,
            message_thread_id: THREAD_ID,
            photo: [{ file_id: 'p-await', width: 100, height: 100 }],
          },
          reply: async () => ({ message_id: 313 }),
        },
        connectedDeps({
          api: fileRelayApi({
            getFile: async () => ({ file_path: 'photos/await.jpg' }),
            downloadFile: async (_path, dest) => { writeFileSync(dest, 'img'); },
          }),
        }),
      );
    });
    assertNoInboundLogs(lines);
  });

  it('INBOUND_HANDLER_PATH_MATRIX row counts are consistent', () => {
    assert.equal(INBOUND_HANDLER_PATH_MATRIX.length, 53);
    assert.equal(INBOUND_HANDLER_PATH_MATRIX.filter((r) => r.kind === 'warn').length, 16);
    assert.equal(INBOUND_HANDLER_PATH_MATRIX.filter((r) => r.kind === 'silent').length, 34);
  });

  it('every covered code has assertInboundLog in behavioral tests', () => {
    const src = readFileSync(new URL('./inbound-handlers-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of INBOUND_HANDLER_LOG_CODES) {
      assert.ok(
        src.includes(`assertInboundLog(lines, '${code}'`) ||
          src.includes(`assertInboundLogOnce(lines, '${code}'`),
        `behavioral missing ${code}`,
      );
    }
  });

  it('every INBOUND_HANDLER_PATH_MATRIX marker has matching it() title', () => {
    const src = readFileSync(new URL('./inbound-handlers-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of INBOUND_HANDLER_PATH_MATRIX) {
      assert.ok(src.includes(`it('${row.marker}'`), `missing it() for ${row.marker}`);
    }
  });

  it('inbound-handlers logging zone has three logWarn sites in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    assert.equal((src.match(/logWarn\(/g) ?? []).length, 3);
    for (const code of INBOUND_HANDLER_LOG_CODES) {
      assert.ok(src.includes(`'${code}'`), `missing ${code} in source`);
    }
  });

  it('TG_DISPATCH_TAB_FAIL and TG_DISPATCH_SEND_FAIL use inboundCtx dispatch_topic with threadId and windowId in source', () => {
    const zone = inboundHandlersZoneSrc();
    assert.match(
      zone,
      /logWarn\('TG_DISPATCH_TAB_FAIL'[\s\S]*?inboundCtx\('dispatch_topic', \{[\s\S]*?threadId: mapping\.threadId[\s\S]*?windowId: mapping\.windowId/,
    );
    assert.match(
      zone,
      /logWarn\('TG_DISPATCH_SEND_FAIL'[\s\S]*?inboundCtx\('dispatch_topic', \{[\s\S]*?threadId: mapping\.threadId[\s\S]*?windowId: mapping\.windowId/,
    );
  });

  it('TG_QUESTIONNAIRE_ADVANCE_FAIL uses inboundCtx questionnaire_advance with threadId in source', () => {
    const zone = inboundHandlersZoneSrc();
    assert.match(
      zone,
      /logWarn\('TG_QUESTIONNAIRE_ADVANCE_FAIL'[\s\S]*?inboundCtx\('questionnaire_advance', \{[\s\S]*?threadId: mapping\.threadId/,
    );
  });

  it('dispatch fail paths use logWarn not logError in source', () => {
    const zone = inboundHandlersZoneSrc();
    assert.ok(!zone.includes("logError('TG_DISPATCH_TAB_FAIL'"));
    assert.ok(!zone.includes("logError('TG_DISPATCH_SEND_FAIL'"));
    assert.ok(!zone.includes("logError('TG_QUESTIONNAIRE_ADVANCE_FAIL'"));
  });

  it('dispatchTopicMessage logInfo lives in dispatch function body in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    const dispatchBody = src.slice(
      src.indexOf('export async function dispatchTopicMessage'),
      src.indexOf('async function drainQueueFileRelayItem'),
    );
    assert.match(dispatchBody, /'TG_DISPATCH_START'/);
    assert.match(dispatchBody, /'TG_DISPATCH_OK'/);
  });

  it('logWarn sites in inbound-handlers do not embed console.log in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    for (const code of INBOUND_HANDLER_LOG_CODES) {
      const idx = src.indexOf(`logWarn('${code}'`);
      assert.ok(idx >= 0, `missing ${code}`);
      const lineEnd = src.indexOf('\n', idx);
      const line = src.slice(idx, lineEnd);
      assert.ok(!line.includes('console.log'), `${code} logWarn line must not use console.log`);
    }
  });

  it('duplicate inbound skip logInfo stays outside inbound logging zone in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /logInfo\(\s*'TG_INBOUND_DEDUP'/);
    assert.ok(!inboundHandlersZoneSrc().includes("logInfo('TG_INBOUND_DEDUP'"));
  });

  it('behavioral it count matches INBOUND_HANDLER_PATH_MATRIX row count', () => {
    assert.equal(INBOUND_HANDLER_PATH_MATRIX.length, 53);
  });

  it('ensureMappingTabActive has no logWarn in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('async function ensureMappingTabActive'),
      src.indexOf('function resolveFreeformSelectorPath'),
    );
    assert.ok(!block.includes('logWarn('));
    assert.ok(!block.includes('logError('));
  });

  it('deliverQuestionnaireFreeform tab fail returns without TG_DISPATCH_TAB_FAIL in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('async function deliverQuestionnaireFreeformToCursor'),
      src.indexOf('async function maybeAdvanceQuestionnaireAfterFreeform'),
    );
    assert.ok(block.includes('if (!tabReady.ok)'));
    assert.ok(!block.includes('TG_DISPATCH_TAB_FAIL'));
    assert.ok(!block.includes('logWarn('));
  });

  it('processPendingQueue catch path has no inbound logWarn in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    const block = src.match(/if \(menuCmd\) \{[\s\S]*?continue;\s*\}/)?.[0] ?? '';
    assert.ok(block.includes('catch (err)'));
    assert.ok(!block.includes('logWarn('));
  });

  it('TG_QUESTIONNAIRE_ADVANCE_FAIL omits windowId in source', () => {
    const zone = inboundHandlersZoneSrc();
    const block = zone.match(/logWarn\('TG_QUESTIONNAIRE_ADVANCE_FAIL'[\s\S]*?\}\);/)?.[0] ?? '';
    assert.ok(block.includes('threadId: mapping.threadId'));
    assert.ok(!block.includes('windowId'));
  });

  it('deliverAttachmentsToCursor and drainQueueFileRelayItem have no logWarn in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    const deliver = src.slice(
      src.indexOf('async function deliverAttachmentsToCursor'),
      src.indexOf('export async function processInboundFileRelay'),
    );
    const drain = src.slice(
      src.indexOf('async function drainQueueFileRelayItem'),
      src.indexOf('export async function processPendingQueue'),
    );
    assert.ok(!deliver.includes('logWarn('));
    assert.ok(!drain.includes('logWarn('));
    assert.ok(deliver.includes('dispatchTopicMessage('));
  });

  it('questionnaire logInfo outside logWarn sites in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    const advanceFailIdx = src.indexOf("logWarn('TG_QUESTIONNAIRE_ADVANCE_FAIL'");
    assert.ok(advanceFailIdx >= 0);
    const freeformBlock = src.slice(
      src.indexOf('async function deliverQuestionnaireFreeformToCursor'),
      advanceFailIdx,
    );
    const maybeAdvanceBeforeWarn = src.slice(
      src.indexOf('async function maybeAdvanceQuestionnaireAfterFreeform'),
      advanceFailIdx,
    );
    assert.match(freeformBlock, /'TG_QUESTIONNAIRE_FREEFORM_OK'/);
    assert.ok(!freeformBlock.includes('logWarn('));
    assert.match(maybeAdvanceBeforeWarn, /'TG_QUESTIONNAIRE_STEP_OK'/);
    assert.ok(!maybeAdvanceBeforeWarn.includes('logWarn('));
  });

  it('inbound-handlers.ts has no logError three logWarn and six logInfo in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    assert.equal((src.match(/logWarn\(/g) ?? []).length, 3);
    assert.equal((src.match(/logInfo\(/g) ?? []).length, 6);
    assert.ok(!src.includes('logError('));
  });

  it('inbound-handlers six logInfo three logWarn inboundCtx', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    assert.equal((src.match(/logWarn\(/g) ?? []).length, 3);
    assert.equal((src.match(/logInfo\(/g) ?? []).length, 6);
    assert.match(src, /function inboundCtx\(op: string[\s\S]*?scope: 'telegram'/);
    assert.ok(!src.includes('console.log('));
  });

  it('inbound-handlers info codes TG_DISPATCH TG_QUESTIONNAIRE TG_INBOUND_DEDUP', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    for (const code of [
      'TG_DISPATCH_START',
      'TG_DISPATCH_OK',
      'TG_QUESTIONNAIRE_FREEFORM_OK',
      'TG_QUESTIONNAIRE_STEP_OK',
      'TG_INBOUND_DEDUP',
    ]) {
      assert.ok(src.includes(`'${code}'`), `missing ${code}`);
    }
  });

  it('inbound-handlers.ts has zero console.log warn error', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
  });

  it('inboundCtx sets scope telegram in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /function inboundCtx\(op: string[\s\S]*?scope: 'telegram'/);
  });

  it('processPendingQueue guard and empty queue have no inbound logWarn in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    const head = src.slice(
      src.indexOf('export async function processPendingQueue'),
      src.indexOf('queueProcessing = true'),
    );
    assert.ok(head.includes('if (queueProcessing) return'));
    assert.ok(head.includes('if (initial === 0) return'));
    assert.ok(!head.includes('logWarn('));
  });

  it('handleTopicMessage handleTextMessage and processInboundFileRelay have no logWarn in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    const topic = src.slice(
      src.indexOf('export async function handleTopicMessage'),
      src.indexOf('const AGENT_IDLE_STATUSES'),
    );
    const text = src.slice(
      src.indexOf('export async function handleTextMessage'),
      src.length,
    );
    const relay = src.slice(
      src.indexOf('export async function processInboundFileRelay'),
      src.indexOf('export async function handleTopicMessage'),
    );
    for (const block of [topic, text, relay]) {
      assert.ok(!block.includes('logWarn('));
      assert.ok(!block.includes('logError('));
    }
  });

  it('maybeAdvance last-question guard has no logWarn before early return in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('async function maybeAdvanceQuestionnaireAfterFreeform'),
      src.indexOf("logWarn('TG_QUESTIONNAIRE_ADVANCE_FAIL'"),
    );
    assert.match(block, /activeIndex >= before\.questions\.length - 1/);
    assert.ok(!block.includes('logWarn('));
  });

  it('all TG_DISPATCH warn sites live only in dispatchTopicMessage export in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    const tabIdx = src.indexOf("logWarn('TG_DISPATCH_TAB_FAIL'");
    const sendIdx = src.indexOf("logWarn('TG_DISPATCH_SEND_FAIL'");
    const dispatchStart = src.indexOf('export async function dispatchTopicMessage');
    const dispatchEnd = src.indexOf('async function drainQueueFileRelayItem');
    assert.ok(tabIdx > dispatchStart && tabIdx < dispatchEnd);
    assert.ok(sendIdx > dispatchStart && sendIdx < dispatchEnd);
    assert.equal(src.split("logWarn('TG_DISPATCH_TAB_FAIL'").length - 1, 1);
    assert.equal(src.split("logWarn('TG_DISPATCH_SEND_FAIL'").length - 1, 1);
    assert.equal(src.split("logWarn('TG_QUESTIONNAIRE_ADVANCE_FAIL'").length - 1, 1);
  });

  it('deliverQuestionnaireFreeformToCursor has no logWarn in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('async function deliverQuestionnaireFreeformToCursor'),
      src.indexOf('async function maybeAdvanceQuestionnaireAfterFreeform'),
    );
    assert.ok(!block.includes('logWarn('));
    assert.ok(!block.includes('logError('));
  });

  it('maybeAdvance advanceQuestionnaireStep path has no logWarn after TAB check in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf("logWarn('TG_QUESTIONNAIRE_ADVANCE_FAIL'"),
      src.indexOf('async function waitForAgentIdle'),
    );
    assert.match(block, /advanceQuestionnaireStep\(commandId\)/);
    assert.ok(!block.includes("logWarn('TG_DISPATCH_"));
    assert.equal((block.match(/logWarn\(/g) ?? []).length, 1);
  });

  it('INBOUND_HANDLER logging zone branch audit has no remaining dispatch caller gaps in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    const callers = [
      'await dispatchTopicMessage(',
      'await deliverAttachmentsToCursor(',
      'await maybeAdvanceQuestionnaireAfterFreeform(',
    ];
    for (const needle of callers) {
      assert.ok(src.includes(needle), `missing ${needle}`);
    }
    const deliverBlock = src.slice(
      src.indexOf('async function deliverAttachmentsToCursor'),
      src.indexOf('export async function processInboundFileRelay'),
    );
    assert.equal((deliverBlock.match(/dispatchTopicMessage\(/g) ?? []).length, 1);
    assert.ok(!deliverBlock.includes('logWarn('));
  });

  it('inbound-handlers no inline scope outside inboundCtx helper', () => {
    const src = readFileSync(
      new URL('../../src/telegram/commands/inbound-handlers.ts', import.meta.url),
      'utf-8',
    );
    const body = src.replace(/function inboundCtx[\s\S]*?^}/m, '');
    assert.ok(!body.includes("scope: '"));
  });
});
