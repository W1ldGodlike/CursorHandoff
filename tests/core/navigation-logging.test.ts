import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'fs';
import { CommandExecutor } from '../../src/ide/actions/navigation.js';
import { resetLogDedupe } from '../../src/core/log-event.js';
import type { CdpClient } from '../../src/ide/cdp-client.js';
import type { SelectorConfig } from '../../src/core/types.js';

const NAVIGATION_LOG_CODES = ['COMMAND_OK', 'COMMAND_WARN', 'COMMAND_FAIL'] as const;

async function captureAll(run: () => void | Promise<void>): Promise<string[]> {
  resetLogDedupe();
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

function assertNavigationLog(
  lines: string[],
  code: string,
  need: {
    op?: string;
    text?: string;
    hint?: string;
    attempt?: number;
    windowTitle?: string;
    itemId?: string;
  } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.hint && !l.includes(`hint=${need.hint}`)) return false;
    if (need.attempt !== undefined && !l.includes(`attempt=${need.attempt}`)) return false;
    if (need.windowTitle && !l.includes(`windowTitle=${need.windowTitle}`)) return false;
    if (need.itemId && !l.includes(`itemId=${need.itemId}`)) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.hint ? `hint=${need.hint}` : '',
    need.attempt !== undefined ? `attempt=${need.attempt}` : '',
    need.windowTitle ? `windowTitle=${need.windowTitle}` : '',
    need.itemId ? `itemId=${need.itemId}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing navigation log: ${desc}`);
  assert.ok(line!.includes('scope=cdp'), `${code} missing scope=cdp`);
}

function assertNoNavigationLogs(lines: string[]): void {
  const hit = lines.find((l) => NAVIGATION_LOG_CODES.some((code) => l.includes(`code=${code}`)));
  assert.ok(!hit, `unexpected navigation log: ${hit}`);
}

function navigationOnly(lines: string[]): string[] {
  return lines.filter((l) => NAVIGATION_LOG_CODES.some((code) => l.includes(`code=${code}`)));
}

function navigationZoneSrc(): string {
  const src = readFileSync(new URL('../../src/ide/actions/navigation.ts', import.meta.url), 'utf-8');
  return src.slice(src.indexOf('function commandCtx'), src.indexOf('function sleep'));
}

function baseSelectors(): SelectorConfig {
  return {
    chatContainer: { strategies: ['.chat-container'] },
    approveButton: { strategies: ['button.approve'], textMatch: ['Accept All'] },
    rejectButton: { strategies: ['button.reject'] },
    chatInput: { strategies: ['textarea.chat-input'] },
    agentStatus: { strategies: ['.agent-status'] },
    newChatButton: { strategies: ['button.new-chat'] },
    modeDropdown: { strategies: ['.mode-dropdown'] },
    modelDropdown: { strategies: ['.model-dropdown'] },
    composerAttachmentPreview: { strategies: ['.attachment-preview'] },
  };
}

type StubOpts = {
  connected?: boolean;
  evaluate?: (expr: string) => Promise<unknown>;
  clickThrows?: Error;
  pressKeyThrows?: Error;
  typeTextThrows?: Error;
  click?: () => Promise<void>;
  pressKey?: (...args: unknown[]) => Promise<void>;
};

function makeStubClient(opts: StubOpts = {}): CdpClient {
  const evaluate = opts.evaluate ?? (async () => ({ ok: true, info: 'TEXTAREA.chat-input' }));
  return {
    isConnected: () => opts.connected ?? true,
    evaluate,
    click: opts.click ?? (async () => {
      if (opts.clickThrows) throw opts.clickThrows;
    }),
    pressKey: opts.pressKey ?? (async () => {
      if (opts.pressKeyThrows) throw opts.pressKeyThrows;
    }),
    typeText: async () => {
      if (opts.typeTextThrows) throw opts.typeTextThrows;
    },
    dispatchKeyEvent: async () => {},
    clickAtCoords: async () => {},
    send: async () => ({}),
    exists: async () => true,
  } as unknown as CdpClient;
}

function makeExecutor(client: CdpClient | null): CommandExecutor {
  const ex = new CommandExecutor(baseSelectors());
  ex.setClient(client);
  return ex;
}

/** Matches openModelMenu + setModel evaluate sequence after model picker hardening. */
function makeSetModelEvaluateStub(opts: { pickOk?: boolean; menuStillOpen?: boolean } = {}) {
  const pickOk = opts.pickOk ?? true;
  const menuStillOpen = opts.menuStillOpen ?? false;
  let menuProbe = 0;
  return async (expr: string) => {
    if (expr.includes('pickModelById')) {
      if (!pickOk) menuProbe = 0;
      return pickOk;
    }
    if (expr.includes('strategies')) return true;
    if (expr.includes('findModelMenu')) {
      menuProbe += 1;
      if (menuProbe === 1) return false;
      if (menuProbe === 2) return true;
      if (menuProbe === 3) return menuStillOpen;
      return false;
    }
    return true;
  };
}

const NAVIGATION_PATH_MATRIX = [
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'sendMessage focus logs COMMAND_OK with commandId op and focus info' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'sendMessage insert logs COMMAND_OK with inserted char count' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'sendMessage enter submit logs COMMAND_OK press_submit hint enter' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'sendMessage ctrlEnter submit logs COMMAND_OK press_submit hint ctrlEnter' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'forceQueueItem success logs COMMAND_OK with itemId context' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'scrollChatUp logs COMMAND_OK with scroll hint times' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'scrollChatToBottom logs COMMAND_OK scrolled to bottom' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'switchTab success logs COMMAND_OK with windowTitle tab title' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'clickQuestionnaire logs COMMAND_OK with hint letter' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'advanceQuestionnaireStep logs COMMAND_OK questionnaire advance' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'setQuestionnaireFreeform logs COMMAND_OK with char count' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'newChat logs COMMAND_OK with selector hint' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'closeChat logs COMMAND_OK with windowTitle' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'setMode logs COMMAND_OK with mode hint' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'clickAction logs COMMAND_OK with truncated selector hint' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'setModel success logs COMMAND_OK with model hint' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'setPlanModel logs COMMAND_OK with planModel hint' },
  { kind: 'log' as const, code: 'COMMAND_WARN', marker: 'setModel menu still open logs COMMAND_WARN before Escape' },
  { kind: 'log' as const, code: 'COMMAND_WARN', marker: 'withRetry failure logs COMMAND_WARN with attempt number' },
  { kind: 'log' as const, code: 'COMMAND_WARN', marker: 'withRetryValue failure logs COMMAND_WARN with attempt number' },
  { kind: 'log' as const, code: 'COMMAND_FAIL', marker: 'withRetryOnce failure logs COMMAND_FAIL without retry warn chain' },
  { kind: 'silent' as const, marker: 'not connected returns ok false without navigation logs' },
  { kind: 'silent' as const, marker: 'clickApproval success stays silent on COMMAND_OK' },
  { kind: 'silent' as const, marker: 'approveAll success stays silent on COMMAND_OK' },
  { kind: 'silent' as const, marker: 'reject success stays silent on COMMAND_OK' },
  { kind: 'silent' as const, marker: 'getModelOptions success stays silent on COMMAND_OK' },
  { kind: 'silent' as const, marker: 'getPlanModelOptions success stays silent on COMMAND_OK' },
  { kind: 'silent' as const, marker: 'readActiveComposerTabInfo disconnected returns null without logs' },
  { kind: 'silent' as const, marker: 'extractToolContent disconnected returns null without logs' },
  { kind: 'silent' as const, marker: 'withRetry exhausted returns ok false without COMMAND_FAIL' },
  { kind: 'silent' as const, marker: 'advanceQuestionnaireStep not open returns ok without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'sendMessage focus failure emits COMMAND_WARN but no COMMAND_OK' },
  { kind: 'silent' as const, marker: 'setModel closed menu success stays silent on COMMAND_WARN' },
  { kind: 'silent' as const, marker: 'switchTab not found returns ok false without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'setMode failure returns ok false without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'clickAction failure after retries returns ok false without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'forceQueueItem failure returns ok false without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'closeChat failure returns ok false without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'approveAll failure returns ok false without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'clickApproval failure returns ok false without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'reject failure returns ok false without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'getModelOptions failure emits COMMAND_WARN without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'getPlanModelOptions failure emits COMMAND_WARN without COMMAND_OK' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'clickAction retry success logs COMMAND_OK after COMMAND_WARN' },
  { kind: 'silent' as const, marker: 'forceQueueItem failure emits COMMAND_WARN without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'readActiveComposerTabInfo connected stays silent on navigation logs' },
  { kind: 'silent' as const, marker: 'scrollChatUp failure returns ok false without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'sendMessage insert failure emits COMMAND_WARN without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'sendMessage submit failure emits COMMAND_WARN without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'setPlanModel failure returns ok false without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'clickQuestionnaire failure returns ok false without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'setQuestionnaireFreeform failure returns ok false without COMMAND_OK' },
  { kind: 'log' as const, code: 'COMMAND_FAIL', marker: 'advanceQuestionnaireStep failure emits COMMAND_FAIL without COMMAND_WARN' },
  { kind: 'silent' as const, marker: 'not connected getModelOptions returns error without navigation logs' },
  { kind: 'silent' as const, marker: 'not connected switchTab returns error without navigation logs' },
  { kind: 'silent' as const, marker: 'withRetry exhausted emits three COMMAND_WARN attempts without COMMAND_FAIL' },
  { kind: 'silent' as const, marker: 'clickAction failure emits COMMAND_WARN without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'extractToolContent connected returns null without navigation logs' },
  { kind: 'silent' as const, marker: 'setModel failure returns ok false without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'newChat success does not emit COMMAND_FAIL' },
  { kind: 'silent' as const, marker: 'approveAll missing button emits COMMAND_WARN without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'withRetryValue exhausted emits COMMAND_WARN attempts without COMMAND_FAIL' },
  { kind: 'silent' as const, marker: 'not connected closeChat returns error without navigation logs' },
  { kind: 'silent' as const, marker: 'not connected setModel returns error without navigation logs' },
  { kind: 'silent' as const, marker: 'not connected clickAction returns error without navigation logs' },
  { kind: 'silent' as const, marker: 'sendMessage enter path disconnected returns error without navigation logs' },
  { kind: 'silent' as const, marker: 'scrollChatToBottom failure returns ok false without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'not connected newChat returns error without navigation logs' },
  { kind: 'silent' as const, marker: 'getModelOptions succeeds on second withRetryValue attempt without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'readActiveComposerTabTitle connected stays silent on navigation logs' },
  { kind: 'silent' as const, marker: 'sendMessage ctrlEnter submit failure emits COMMAND_WARN without op=press_submit' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'clickQuestionnaire skip target logs COMMAND_OK with hint skip' },
  { kind: 'silent' as const, marker: 'withRetryOnce failure emits exactly one COMMAND_FAIL line' },
  { kind: 'silent' as const, marker: 'sendMessage success emits three COMMAND_OK lines for focus insert submit' },
  { kind: 'silent' as const, marker: 'getPlanModelOptions succeeds on second withRetryValue attempt without COMMAND_OK' },
  { kind: 'silent' as const, marker: 'not connected readActiveComposerTabTitle returns null without navigation logs' },
  { kind: 'silent' as const, marker: 'setModel menu still open emits exactly one COMMAND_WARN before COMMAND_OK' },
  { kind: 'silent' as const, marker: 'clickApproval failure emits COMMAND_WARN without COMMAND_OK' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'clickQuestionnaire continue target logs COMMAND_OK with hint continue' },
  { kind: 'silent' as const, marker: 'withRetry failure log text includes Attempt 1 of 3 pattern' },
  { kind: 'silent' as const, marker: 'setModel closed menu success log text includes menuClosed=true' },
  { kind: 'silent' as const, marker: 'clickAction truncates long selector to 60 chars in COMMAND_OK hint' },
  { kind: 'silent' as const, marker: 'not connected forceQueueItem returns error without navigation logs' },
  { kind: 'silent' as const, marker: 'not connected getPlanModelOptions returns error without navigation logs' },
  { kind: 'silent' as const, marker: 'reject failure emits COMMAND_WARN without COMMAND_OK' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'closeChat without tab title logs COMMAND_OK for active tab' },
  { kind: 'log' as const, code: 'COMMAND_OK', marker: 'scrollChatUp default times logs COMMAND_OK with hint 5' },
  { kind: 'silent' as const, marker: 'not connected advanceQuestionnaireStep returns error without navigation logs' },
] as const;

const SILENT_PATH_MARKERS = NAVIGATION_PATH_MATRIX.filter((r) => r.kind === 'silent').map((r) => r.marker);

describe('navigation logging', () => {
  it('sendMessage focus logs COMMAND_OK with commandId op and focus info', async () => {
    const client = makeStubClient();
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.sendMessage('send-msg', 'hi');
      assert.equal(result.ok, true);
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'send-msg', text: 'TEXTAREA' });
  });

  it('sendMessage insert logs COMMAND_OK with inserted char count', async () => {
    const client = makeStubClient();
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.sendMessage('send-msg', 'hello');
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'send-msg', text: 'inserted 5 chars' });
  });

  it('sendMessage enter submit logs COMMAND_OK press_submit hint enter', async () => {
    const client = makeStubClient();
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.sendMessage('send-msg', 'x', { submit: 'enter' });
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'press_submit', hint: 'enter' });
  });

  it('sendMessage ctrlEnter submit logs COMMAND_OK press_submit hint ctrlEnter', async () => {
    const client = makeStubClient();
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.sendMessage('send-msg', 'x', { submit: 'ctrlEnter' });
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'press_submit', hint: 'ctrlEnter' });
  });

  it('forceQueueItem success logs COMMAND_OK with itemId context', async () => {
    const client = makeStubClient({
      evaluate: async () => ({ ok: true }),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.forceQueueItem('force-q', 'queue-item-abc123');
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'force-q', itemId: 'queue-item-abc123' });
  });

  it('scrollChatUp logs COMMAND_OK with scroll hint times', async () => {
    const client = makeStubClient({ evaluate: async () => true });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.scrollChatUp('scroll-up', 3);
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'scroll-up', hint: '3' });
  });

  it('scrollChatToBottom logs COMMAND_OK scrolled to bottom', async () => {
    const client = makeStubClient({ evaluate: async () => true });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.scrollChatToBottom('scroll-bottom');
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'scroll-bottom', text: 'scrolled to bottom' });
  });

  it('switchTab success logs COMMAND_OK with windowTitle tab title', async () => {
    const client = makeStubClient({
      evaluate: async (expr) => {
        if (expr.includes('return false')) return true;
        return true;
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.switchTab('switch-tab', 'My Agent Tab');
    });
    assertNavigationLog(lines, 'COMMAND_OK', {
      op: 'switch-tab',
      windowTitle: 'My Agent Tab',
      text: 'tab active',
    });
  });

  it('clickQuestionnaire logs COMMAND_OK with hint letter', async () => {
    const client = makeStubClient({
      evaluate: async () => ({ ok: true, x: 10, y: 20 }),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.clickQuestionnaire('q-click', { letter: 'B' });
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'q-click', hint: 'B' });
  });

  it('advanceQuestionnaireStep logs COMMAND_OK questionnaire advance', async () => {
    const client = makeStubClient({
      evaluate: async (expr) => {
        if (expr.includes('composer-questionnaire-toolbar-freeform')) return false;
        return { ok: true, x: 5, y: 5 };
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.advanceQuestionnaireStep('q-advance');
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'q-advance', text: 'questionnaire advance' });
  });

  it('setQuestionnaireFreeform logs COMMAND_OK with char count', async () => {
    const client = makeStubClient({ evaluate: async () => true });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.setQuestionnaireFreeform('q-free', '.composer-questionnaire-toolbar-freeform-input', 'answer');
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'q-free', text: 'questionnaire freeform 6 chars' });
  });

  it('newChat logs COMMAND_OK with selector hint', async () => {
    const client = makeStubClient({
      evaluate: async () => ({ ok: true, sel: 'button.new-chat' }),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.newChat('new-chat');
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'new-chat', hint: 'button.new-chat' });
  });

  it('closeChat logs COMMAND_OK with windowTitle', async () => {
    const client = makeStubClient({ evaluate: async () => true });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.closeChat('close-chat', 'Agent One');
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'close-chat', windowTitle: 'Agent One' });
  });

  it('setMode logs COMMAND_OK with mode hint', async () => {
    const client = makeStubClient({
      evaluate: async (expr) => {
        if (expr.includes('composer-mode')) return true;
        if (expr.includes('Mode dropdown')) return true;
        return true;
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.setMode('set-mode', 'agent');
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'set-mode', hint: 'agent' });
  });

  it('clickAction logs COMMAND_OK with truncated selector hint', async () => {
    const client = makeStubClient();
    const ex = makeExecutor(client);
    const selector = '#composer-toolbar .run-button.primary-action';
    const lines = await captureAll(async () => {
      await ex.clickAction('click-act', selector);
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'click-act', hint: selector.substring(0, 60) });
  });

  it('setModel success logs COMMAND_OK with model hint', async () => {
    const client = makeStubClient({ evaluate: makeSetModelEvaluateStub() });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.setModel('set-model', 'gpt-4');
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'set-model', hint: 'gpt-4' });
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_WARN')));
  });

  it('setPlanModel logs COMMAND_OK with planModel hint', async () => {
    let n = 0;
    const client = makeStubClient({
      evaluate: async () => {
        n += 1;
        if (n <= 2) return true;
        if (n === 3) return true;
        return false;
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.setPlanModel('set-plan-model', '#plan-model-trigger', 'opus-plan');
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'set-plan-model', hint: 'opus-plan' });
  });

  it('setModel menu still open logs COMMAND_WARN before Escape', async () => {
    const client = makeStubClient({ evaluate: makeSetModelEvaluateStub({ menuStillOpen: true }) });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.setModel('set-model-warn', 'claude');
    });
    assertNavigationLog(lines, 'COMMAND_WARN', { op: 'set-model-warn', text: 'Model dropdown still open' });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'set-model-warn', hint: 'claude' });
  });

  it('withRetry failure logs COMMAND_WARN with attempt number', async () => {
    const client = makeStubClient({
      clickThrows: new Error('click boom'),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.clickAction('retry-click', '#missing');
    });
    assertNavigationLog(lines, 'COMMAND_WARN', { op: 'retry-click', attempt: 1 });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN') && l.includes('attempt=2')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_FAIL')));
  });

  it('withRetryValue failure logs COMMAND_WARN with attempt number', async () => {
    let n = 0;
    const client = makeStubClient({
      evaluate: async () => {
        n += 1;
        if (n === 1) throw new Error('menu fail');
        throw new Error('menu fail');
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.getModelOptions('get-models');
    });
    assertNavigationLog(lines, 'COMMAND_WARN', { op: 'get-models', attempt: 1 });
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('withRetryOnce failure logs COMMAND_FAIL without retry warn chain', async () => {
    const client = makeStubClient({
      evaluate: async () => ({ ok: false }),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.newChat('new-chat-fail');
    });
    assertNavigationLog(lines, 'COMMAND_FAIL', { op: 'new-chat-fail', text: 'Failed (no retry)' });
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_WARN')));
  });

  it('not connected returns ok false without navigation logs', async () => {
    const ex = makeExecutor(makeStubClient({ connected: false }));
    const lines = await captureAll(async () => {
      const result = await ex.sendMessage('send-offline', 'x');
      assert.equal(result.ok, false);
    });
    assertNoNavigationLogs(lines);
  });

  it('clickApproval success stays silent on COMMAND_OK', async () => {
    const ex = makeExecutor(makeStubClient());
    const lines = await captureAll(async () => {
      const result = await ex.clickApproval('approve-one', '#approve-btn');
      assert.equal(result.ok, true);
    });
    assertNoNavigationLogs(lines);
  });

  it('approveAll success stays silent on COMMAND_OK', async () => {
    const client = makeStubClient({ evaluate: async () => true });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.approveAll('approve-all');
      assert.equal(result.ok, true);
    });
    assertNoNavigationLogs(lines);
  });

  it('reject success stays silent on COMMAND_OK', async () => {
    const ex = makeExecutor(makeStubClient());
    const lines = await captureAll(async () => {
      const result = await ex.reject('reject-one', '#reject-btn');
      assert.equal(result.ok, true);
    });
    assertNoNavigationLogs(lines);
  });

  it('getModelOptions success stays silent on COMMAND_OK', async () => {
    let n = 0;
    const client = makeStubClient({
      evaluate: async () => {
        n += 1;
        if (n === 1) return true;
        if (n === 2) return true;
        return [{ id: 'm1', label: 'Model 1', selected: true }];
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.getModelOptions('get-models-ok');
      assert.equal(result.ok, true);
    });
    assertNoNavigationLogs(lines);
  });

  it('getPlanModelOptions success stays silent on COMMAND_OK', async () => {
    let n = 0;
    const client = makeStubClient({
      evaluate: async () => {
        n += 1;
        if (n <= 2) return true;
        return [{ id: 'p1', label: 'Plan 1', selected: false }];
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.getPlanModelOptions('get-plan-models', '#plan-trigger');
      assert.equal(result.ok, true);
    });
    assertNoNavigationLogs(lines);
  });

  it('readActiveComposerTabInfo disconnected returns null without logs', async () => {
    const ex = makeExecutor(makeStubClient({ connected: false }));
    const lines = await captureAll(async () => {
      const info = await ex.readActiveComposerTabInfo();
      assert.deepEqual(info, { title: null, composerId: null });
    });
    assertNoNavigationLogs(lines);
  });

  it('extractToolContent disconnected returns null without logs', async () => {
    const ex = makeExecutor(makeStubClient({ connected: false }));
    const lines = await captureAll(async () => {
      const content = await ex.extractToolContent('tool-1');
      assert.equal(content, null);
    });
    assertNoNavigationLogs(lines);
  });

  it('withRetry exhausted returns ok false without COMMAND_FAIL', async () => {
    const client = makeStubClient({
      clickThrows: new Error('always fail'),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.clickAction('fail-all', '#x');
      assert.equal(result.ok, false);
    });
    assert.ok(navigationOnly(lines).every((l) => l.includes('COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_FAIL')));
  });

  it('advanceQuestionnaireStep not open returns ok without COMMAND_OK', async () => {
    const client = makeStubClient({
      evaluate: async () => ({ ok: false, error: 'Questionnaire not open' }),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.advanceQuestionnaireStep('q-skip');
      assert.equal(result.ok, true);
    });
    assertNoNavigationLogs(lines);
  });

  it('sendMessage focus failure emits COMMAND_WARN but no COMMAND_OK', async () => {
    const client = makeStubClient({
      evaluate: async () => ({ ok: false, error: 'Chat input not found' }),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.sendMessage('send-fail', 'x');
      assert.equal(result.ok, false);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('setModel closed menu success stays silent on COMMAND_WARN', async () => {
    const client = makeStubClient({ evaluate: makeSetModelEvaluateStub() });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.setModel('set-model-clean', 'sonnet');
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'set-model-clean', hint: 'sonnet' });
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_WARN')));
  });

  it('switchTab not found returns ok false without COMMAND_OK', async () => {
    const client = makeStubClient({ evaluate: async () => false });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.switchTab('switch-miss', 'Missing Tab');
      assert.equal(result.ok, false);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('setMode failure returns ok false without COMMAND_OK', async () => {
    const client = makeStubClient({ evaluate: async () => false });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.setMode('set-mode-fail', 'agent');
      assert.equal(result.ok, false);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('clickAction failure after retries returns ok false without COMMAND_OK', async () => {
    const client = makeStubClient({ clickThrows: new Error('no element') });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.clickAction('click-fail', '#gone');
      assert.equal(result.ok, false);
    });
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('forceQueueItem failure returns ok false without COMMAND_OK', async () => {
    const client = makeStubClient({
      evaluate: async () => ({ ok: false, error: 'Queue item not found' }),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.forceQueueItem('force-fail', 'missing-id');
      assert.equal(result.ok, false);
    });
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('closeChat failure returns ok false without COMMAND_OK', async () => {
    const client = makeStubClient({ evaluate: async () => false });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.closeChat('close-fail', 'Gone Tab');
      assert.equal(result.ok, false);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('approveAll failure returns ok false without COMMAND_OK', async () => {
    const client = makeStubClient({ evaluate: async () => null });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.approveAll('approve-all-fail');
      assert.equal(result.ok, false);
    });
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('clickApproval failure returns ok false without COMMAND_OK', async () => {
    const client = makeStubClient({ clickThrows: new Error('approve missing') });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.clickApproval('approve-one-fail', '#approve');
      assert.equal(result.ok, false);
    });
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('reject failure returns ok false without COMMAND_OK', async () => {
    const client = makeStubClient({ clickThrows: new Error('reject missing') });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.reject('reject-fail', '#reject');
      assert.equal(result.ok, false);
    });
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('getModelOptions failure emits COMMAND_WARN without COMMAND_OK', async () => {
    const client = makeStubClient({
      evaluate: async () => {
        throw new Error('model menu missing');
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.getModelOptions('get-models-fail');
      assert.equal(result.ok, false);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('getPlanModelOptions failure emits COMMAND_WARN without COMMAND_OK', async () => {
    const client = makeStubClient({
      evaluate: async () => {
        throw new Error('plan model menu missing');
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.getPlanModelOptions('get-plan-fail', '#plan-trigger');
      assert.equal(result.ok, false);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('clickAction retry success logs COMMAND_OK after COMMAND_WARN', async () => {
    let clicks = 0;
    const client = makeStubClient({
      click: async () => {
        clicks += 1;
        if (clicks === 1) throw new Error('transient click');
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.clickAction('click-retry-ok', '#btn');
      assert.equal(result.ok, true);
    });
    assertNavigationLog(lines, 'COMMAND_WARN', { op: 'click-retry-ok', attempt: 1 });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'click-retry-ok' });
  });

  it('forceQueueItem failure emits COMMAND_WARN without COMMAND_OK', async () => {
    const client = makeStubClient({
      evaluate: async () => ({ ok: false, error: 'Queue item not found' }),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.forceQueueItem('force-warn', 'missing-id');
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('readActiveComposerTabInfo connected stays silent on navigation logs', async () => {
    const client = makeStubClient({
      evaluate: async () => ({ title: 'Active Tab', composerId: 'composer-1' }),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const info = await ex.readActiveComposerTabInfo();
      assert.equal(info.title, 'Active Tab');
    });
    assertNoNavigationLogs(lines);
  });

  it('scrollChatUp failure returns ok false without COMMAND_OK', async () => {
    const client = makeStubClient({ pressKeyThrows: new Error('page up failed') });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.scrollChatUp('scroll-up-fail', 1);
      assert.equal(result.ok, false);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('sendMessage insert failure emits COMMAND_WARN without COMMAND_OK', async () => {
    const client = makeStubClient({ typeTextThrows: new Error('insert failed') });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.sendMessage('send-insert-fail', 'hello');
      assert.equal(result.ok, false);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('inserted')));
  });

  it('sendMessage submit failure emits COMMAND_WARN without COMMAND_OK', async () => {
    const client = makeStubClient({ pressKeyThrows: new Error('enter failed') });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.sendMessage('send-submit-fail', 'hello');
      assert.equal(result.ok, false);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('op=press_submit')));
  });

  it('setPlanModel failure returns ok false without COMMAND_OK', async () => {
    let n = 0;
    const client = makeStubClient({
      evaluate: async () => {
        n += 1;
        if (n <= 2) return true;
        return false;
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.setPlanModel('set-plan-fail', '#plan-trigger', 'missing-plan');
      assert.equal(result.ok, false);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('clickQuestionnaire failure returns ok false without COMMAND_OK', async () => {
    const client = makeStubClient({
      evaluate: async () => ({ ok: false, error: 'Questionnaire already closed' }),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.clickQuestionnaire('q-click-fail', { letter: 'A' });
      assert.equal(result.ok, false);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('setQuestionnaireFreeform failure returns ok false without COMMAND_OK', async () => {
    const client = makeStubClient({ evaluate: async () => false });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.setQuestionnaireFreeform('q-free-fail', '#ta', 'answer');
      assert.equal(result.ok, false);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('advanceQuestionnaireStep failure emits COMMAND_FAIL without COMMAND_WARN', async () => {
    let n = 0;
    const client = makeStubClient({
      evaluate: async () => {
        n += 1;
        if (n === 1) return false;
        return { ok: false, error: 'Next question not visible' };
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.advanceQuestionnaireStep('q-advance-fail');
      assert.equal(result.ok, false);
    });
    assertNavigationLog(lines, 'COMMAND_FAIL', { op: 'q-advance-fail', text: 'Failed (no retry)' });
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_WARN')));
  });

  it('not connected getModelOptions returns error without navigation logs', async () => {
    const ex = makeExecutor(makeStubClient({ connected: false }));
    const lines = await captureAll(async () => {
      const result = await ex.getModelOptions('models-offline');
      assert.equal(result.ok, false);
    });
    assertNoNavigationLogs(lines);
  });

  it('not connected switchTab returns error without navigation logs', async () => {
    const ex = makeExecutor(makeStubClient({ connected: false }));
    const lines = await captureAll(async () => {
      const result = await ex.switchTab('switch-offline', 'Tab');
      assert.equal(result.ok, false);
    });
    assertNoNavigationLogs(lines);
  });

  it('withRetry exhausted emits three COMMAND_WARN attempts without COMMAND_FAIL', async () => {
    const client = makeStubClient({ clickThrows: new Error('always fail') });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.clickAction('retry-three', '#x');
    });
    const warns = navigationOnly(lines).filter((l) => l.includes('COMMAND_WARN'));
    assert.equal(warns.length, 3);
    assert.ok(warns.some((l) => l.includes('attempt=1')));
    assert.ok(warns.some((l) => l.includes('attempt=2')));
    assert.ok(warns.some((l) => l.includes('attempt=3')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_FAIL')));
  });

  it('clickAction failure emits COMMAND_WARN without COMMAND_OK', async () => {
    const client = makeStubClient({ clickThrows: new Error('no element') });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.clickAction('click-warn', '#gone');
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('extractToolContent connected returns null without navigation logs', async () => {
    const client = makeStubClient({ evaluate: async () => null });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const content = await ex.extractToolContent('missing-tool');
      assert.equal(content, null);
    });
    assertNoNavigationLogs(lines);
  });

  it('setModel failure returns ok false without COMMAND_OK', async () => {
    const client = makeStubClient({ evaluate: makeSetModelEvaluateStub({ pickOk: false }) });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.setModel('set-model-fail', 'missing-model');
      assert.equal(result.ok, false);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('newChat success does not emit COMMAND_FAIL', async () => {
    const client = makeStubClient({
      evaluate: async () => ({ ok: true, sel: 'button.new-chat' }),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.newChat('new-chat-ok');
      assert.equal(result.ok, true);
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'new-chat-ok' });
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_FAIL')));
  });

  it('approveAll missing button emits COMMAND_WARN without COMMAND_OK', async () => {
    const client = makeStubClient({ evaluate: async () => null });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.approveAll('approve-all-warn');
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('withRetryValue exhausted emits COMMAND_WARN attempts without COMMAND_FAIL', async () => {
    const client = makeStubClient({
      evaluate: async () => {
        throw new Error('plan menu fail');
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.getPlanModelOptions('plan-retry-exhaust', '#plan');
    });
    assert.ok(navigationOnly(lines).every((l) => l.includes('COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_FAIL')));
  });

  it('not connected closeChat returns error without navigation logs', async () => {
    const ex = makeExecutor(makeStubClient({ connected: false }));
    const lines = await captureAll(async () => {
      const result = await ex.closeChat('close-offline', 'Tab');
      assert.equal(result.ok, false);
    });
    assertNoNavigationLogs(lines);
  });

  it('not connected setModel returns error without navigation logs', async () => {
    const ex = makeExecutor(makeStubClient({ connected: false }));
    const lines = await captureAll(async () => {
      const result = await ex.setModel('model-offline', 'sonnet');
      assert.equal(result.ok, false);
    });
    assertNoNavigationLogs(lines);
  });

  it('not connected clickAction returns error without navigation logs', async () => {
    const ex = makeExecutor(makeStubClient({ connected: false }));
    const lines = await captureAll(async () => {
      const result = await ex.clickAction('click-offline', '#btn');
      assert.equal(result.ok, false);
    });
    assertNoNavigationLogs(lines);
  });

  it('sendMessage enter path disconnected returns error without navigation logs', async () => {
    const ex = makeExecutor(makeStubClient({ connected: false }));
    const lines = await captureAll(async () => {
      const result = await ex.sendMessage('send-offline-enter', 'hi', { submit: 'enter' });
      assert.equal(result.ok, false);
    });
    assertNoNavigationLogs(lines);
  });

  it('scrollChatToBottom failure returns ok false without COMMAND_OK', async () => {
    const client = makeStubClient({
      evaluate: async () => {
        throw new Error('scroll container missing');
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.scrollChatToBottom('scroll-bottom-fail');
      assert.equal(result.ok, false);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('not connected newChat returns error without navigation logs', async () => {
    const ex = makeExecutor(makeStubClient({ connected: false }));
    const lines = await captureAll(async () => {
      const result = await ex.newChat('new-chat-offline');
      assert.equal(result.ok, false);
    });
    assertNoNavigationLogs(lines);
  });

  it('getModelOptions succeeds on second withRetryValue attempt without COMMAND_OK', async () => {
    let n = 0;
    const client = makeStubClient({
      evaluate: async () => {
        n += 1;
        if (n === 1) throw new Error('menu not ready');
        if (n <= 3) return true;
        return [{ id: 'm1', label: 'Model 1', selected: true }];
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.getModelOptions('get-models-retry-ok');
      assert.equal(result.ok, true);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN') && l.includes('attempt=1')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('readActiveComposerTabTitle connected stays silent on navigation logs', async () => {
    const client = makeStubClient({
      evaluate: async () => ({ title: 'Composer Tab', composerId: 'cid-1' }),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const title = await ex.readActiveComposerTabTitle();
      assert.equal(title, 'Composer Tab');
    });
    assertNoNavigationLogs(lines);
  });

  it('sendMessage ctrlEnter submit failure emits COMMAND_WARN without op=press_submit', async () => {
    let keys = 0;
    const client = makeStubClient({
      pressKey: async () => {
        keys += 1;
        if (keys >= 3) throw new Error('ctrl enter failed');
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.sendMessage('send-ctrl-fail', 'hello', { submit: 'ctrlEnter' });
      assert.equal(result.ok, false);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('op=press_submit')));
  });

  it('clickQuestionnaire skip target logs COMMAND_OK with hint skip', async () => {
    const client = makeStubClient({
      evaluate: async () => ({ ok: true, x: 12, y: 34 }),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.clickQuestionnaire('q-skip', 'skip');
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'q-skip', hint: 'skip' });
  });

  it('withRetryOnce failure emits exactly one COMMAND_FAIL line', async () => {
    const client = makeStubClient({
      evaluate: async () => ({ ok: false }),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.newChat('new-chat-one-fail');
    });
    assert.equal(navigationOnly(lines).filter((l) => l.includes('code=COMMAND_FAIL')).length, 1);
  });

  it('sendMessage success emits three COMMAND_OK lines for focus insert submit', async () => {
    const client = makeStubClient();
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.sendMessage('send-triple-ok', 'ab', { submit: 'enter' });
    });
    const oks = navigationOnly(lines).filter((l) => l.includes('code=COMMAND_OK'));
    assert.equal(oks.length, 3);
    assert.ok(oks.some((l) => l.includes('op=send-triple-ok') && l.includes('TEXTAREA')));
    assert.ok(oks.some((l) => l.includes('inserted 2 chars')));
    assert.ok(oks.some((l) => l.includes('op=press_submit') && l.includes('hint=enter')));
  });

  it('getPlanModelOptions succeeds on second withRetryValue attempt without COMMAND_OK', async () => {
    let n = 0;
    const client = makeStubClient({
      evaluate: async () => {
        n += 1;
        if (n === 1) throw new Error('plan menu not ready');
        if (n <= 3) return true;
        return [{ id: 'p1', label: 'Plan 1', selected: false }];
      },
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      const result = await ex.getPlanModelOptions('get-plan-retry-ok', '#plan-trigger');
      assert.equal(result.ok, true);
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN') && l.includes('attempt=1')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('not connected readActiveComposerTabTitle returns null without navigation logs', async () => {
    const ex = makeExecutor(makeStubClient({ connected: false }));
    const lines = await captureAll(async () => {
      const title = await ex.readActiveComposerTabTitle();
      assert.equal(title, null);
    });
    assertNoNavigationLogs(lines);
  });

  it('setModel menu still open emits exactly one COMMAND_WARN before COMMAND_OK', async () => {
    const client = makeStubClient({ evaluate: makeSetModelEvaluateStub({ menuStillOpen: true }) });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.setModel('set-model-one-warn', 'claude');
    });
    const warns = navigationOnly(lines).filter((l) => l.includes('code=COMMAND_WARN'));
    assert.equal(warns.length, 1);
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'set-model-one-warn', hint: 'claude' });
  });

  it('clickApproval failure emits COMMAND_WARN without COMMAND_OK', async () => {
    const client = makeStubClient({ clickThrows: new Error('approve missing') });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.clickApproval('approve-warn', '#approve');
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('clickQuestionnaire continue target logs COMMAND_OK with hint continue', async () => {
    const client = makeStubClient({
      evaluate: async () => ({ ok: true, x: 20, y: 30 }),
    });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.clickQuestionnaire('q-continue', 'continue');
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'q-continue', hint: 'continue' });
  });

  it('withRetry failure log text includes Attempt 1 of 3 pattern', async () => {
    const client = makeStubClient({ clickThrows: new Error('boom') });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.clickAction('retry-text', '#x');
    });
    assert.ok(lines.some((l) => l.includes('Attempt 1/3 failed')));
  });

  it('setModel closed menu success log text includes menuClosed=true', async () => {
    const client = makeStubClient({ evaluate: makeSetModelEvaluateStub() });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.setModel('set-model-closed', 'sonnet');
    });
    assert.ok(lines.some((l) => l.includes('menuClosed=true')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_WARN')));
  });

  it('clickAction truncates long selector to 60 chars in COMMAND_OK hint', async () => {
    const longSel = '#'.padEnd(80, 'x');
    const client = makeStubClient();
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.clickAction('click-long', longSel);
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'click-long', hint: longSel.substring(0, 60) });
    assert.ok(!lines.some((l) => l.includes(longSel)));
  });

  it('not connected forceQueueItem returns error without navigation logs', async () => {
    const ex = makeExecutor(makeStubClient({ connected: false }));
    const lines = await captureAll(async () => {
      const result = await ex.forceQueueItem('force-offline', 'q1');
      assert.equal(result.ok, false);
    });
    assertNoNavigationLogs(lines);
  });

  it('not connected getPlanModelOptions returns error without navigation logs', async () => {
    const ex = makeExecutor(makeStubClient({ connected: false }));
    const lines = await captureAll(async () => {
      const result = await ex.getPlanModelOptions('plan-offline', '#plan');
      assert.equal(result.ok, false);
    });
    assertNoNavigationLogs(lines);
  });

  it('reject failure emits COMMAND_WARN without COMMAND_OK', async () => {
    const client = makeStubClient({ clickThrows: new Error('reject btn gone') });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.reject('reject-warn', '#reject-btn');
    });
    assert.ok(lines.some((l) => l.includes('code=COMMAND_WARN')));
    assert.ok(!lines.some((l) => l.includes('code=COMMAND_OK')));
  });

  it('closeChat without tab title logs COMMAND_OK for active tab', async () => {
    const client = makeStubClient({ evaluate: async () => true });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.closeChat('close-active');
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'close-active', text: 'closed tab: (active)' });
  });

  it('scrollChatUp default times logs COMMAND_OK with hint 5', async () => {
    const client = makeStubClient({ evaluate: async () => true });
    const ex = makeExecutor(client);
    const lines = await captureAll(async () => {
      await ex.scrollChatUp('scroll-default');
    });
    assertNavigationLog(lines, 'COMMAND_OK', { op: 'scroll-default', hint: '5' });
  });

  it('not connected advanceQuestionnaireStep returns error without navigation logs', async () => {
    const ex = makeExecutor(makeStubClient({ connected: false }));
    const lines = await captureAll(async () => {
      const result = await ex.advanceQuestionnaireStep('q-offline');
      assert.equal(result.ok, false);
    });
    assertNoNavigationLogs(lines);
  });
});

describe('navigation logging coverage', () => {
  it('path matrix rows map to behavioral test titles', () => {
    const src = readFileSync(new URL('./navigation-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of NAVIGATION_PATH_MATRIX) {
      assert.ok(src.includes(row.marker), `matrix row missing test: ${row.marker}`);
    }
    assert.equal(NAVIGATION_PATH_MATRIX.length, 88);
  });

  it('automated matrix log codes have behavioral assertNavigationLog', () => {
    const codes = NAVIGATION_PATH_MATRIX.filter((r) => r.kind !== 'silent').map((r) =>
      'code' in r ? r.code : '',
    );
    const unique = [...new Set(codes.filter(Boolean))];
    const src = readFileSync(new URL('./navigation-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of unique) {
      assert.ok(src.includes(`assertNavigationLog(lines, '${code}'`), `matrix code missing assert: ${code}`);
    }
    assert.equal(unique.length, 3);
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./navigation-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent marker: ${marker}`);
    }
  });

  it('every covered code has assertNavigationLog in behavioral tests', () => {
    const src = readFileSync(new URL('./navigation-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of NAVIGATION_LOG_CODES) {
      assert.ok(src.includes(`assertNavigationLog(lines, '${code}'`), `behavioral missing ${code}`);
    }
  });

  it('commandCtx returns scope cdp in source', () => {
    const zone = navigationZoneSrc();
    assert.match(zone, /function commandCtx\(op: string/);
    assert.match(zone, /return \{ scope: 'cdp', op, \.\.\.extra \}/);
  });

  it('logging zone has twenty COMMAND_OK logCommandOk sites in source', () => {
    const zone = navigationZoneSrc();
    assert.equal((zone.match(/logCommandOk\(/g) ?? []).length, 20);
  });

  it('logging zone has three COMMAND_WARN logWarn sites in source', () => {
    const zone = navigationZoneSrc();
    assert.equal((zone.match(/logWarn\(\s*'COMMAND_WARN'/g) ?? []).length, 3);
  });

  it('logging zone has one COMMAND_FAIL logError site in source', () => {
    const zone = navigationZoneSrc();
    assert.equal((zone.match(/logError\('COMMAND_FAIL'/g) ?? []).length, 1);
  });

  it('logging zone has zero console.log calls in source', () => {
    const zone = navigationZoneSrc();
    assert.ok(!zone.includes('console.log'));
    assert.ok(!zone.includes('console.warn'));
    assert.ok(!zone.includes('console.error'));
  });

  it('withRetry logs COMMAND_WARN with attempt in commandCtx in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('private async withRetry('), zone.indexOf('private async withRetryValue'));
    assert.match(body, /logWarn\([\s\S]*?'COMMAND_WARN'[\s\S]*?commandCtx\(commandId, \{ attempt: attempt \+ 1 \}\)/);
  });

  it('withRetryOnce logs COMMAND_FAIL on catch in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('private async withRetryOnce'), zone.indexOf('private async withRetry('));
    assert.match(body, /logError\('COMMAND_FAIL', `Failed \(no retry\): \$\{msg\}`/);
  });

  it('MAX_RETRIES is 2 in source', () => {
    const src = readFileSync(new URL('../../src/ide/actions/navigation.ts', import.meta.url), 'utf-8');
    assert.match(src, /const MAX_RETRIES = 2/);
  });

  it('RETRY_DELAY_MS is 500 in source', () => {
    const src = readFileSync(new URL('../../src/ide/actions/navigation.ts', import.meta.url), 'utf-8');
    assert.match(src, /const RETRY_DELAY_MS = 500/);
  });

  it('every log site in logging zone passes commandCtx in source', () => {
    const zone = navigationZoneSrc();
    const sites = zone.match(/log(?:CommandOk|Info|Warn|Error)\([\s\S]*?\);/g) ?? [];
    assert.equal(sites.length, 24);
    for (const site of sites) {
      assert.match(site, /commandCtx\(/);
    }
  });

  it('withRetry not connected returns early without logging in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('private async withRetry('), zone.indexOf('private async withRetryValue'));
    assert.match(body, /if \(!this\.client \|\| !this\.client\.isConnected\(\)\)/);
    assert.match(body, /return \{ commandId, ok: false, error: 'Not connected to Cursor' \}/);
  });

  it('clickApproval does not log COMMAND_OK on success in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async clickApproval'), zone.indexOf('async approveAll'));
    assert.ok(!body.includes('COMMAND_OK'));
  });

  it('approveAll does not log COMMAND_OK on success in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async approveAll'), zone.indexOf('async reject'));
    assert.ok(!body.includes('COMMAND_OK'));
  });

  it('getModelOptions returns data without COMMAND_OK in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async getModelOptions'), zone.indexOf('async getPlanModelOptions'));
    assert.ok(!body.includes('COMMAND_OK'));
  });

  it('setModel COMMAND_WARN only when menuStillOpen in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async setModel(commandId'), zone.indexOf('async getModelOptions'));
    assert.match(body, /if \(menuStillOpen\) \{[\s\S]*?logWarn\('COMMAND_WARN'/);
  });

  it('pressSubmit logs COMMAND_OK with press_submit op in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('private async pressSubmit'), zone.indexOf('private async probeAttachmentPreview'));
    assert.match(body, /commandCtx\('press_submit', \{ hint: 'ctrlEnter' \}\)/);
    assert.match(body, /commandCtx\('press_submit', \{ hint: 'enter' \}\)/);
  });

  it('sleep helper lives outside CommandExecutor class in source', () => {
    const src = readFileSync(new URL('../../src/ide/actions/navigation.ts', import.meta.url), 'utf-8');
    assert.ok(src.indexOf('function sleep') > src.lastIndexOf('export class CommandExecutor'));
    assert.ok(!navigationZoneSrc().includes('function sleep'));
  });

  it('switchTab logs COMMAND_OK with windowTitle in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async switchTab'), zone.indexOf('async clickQuestionnaire'));
    assert.match(body, /logCommandOk\(`tab active: \$\{tabTitle\}`[\s\S]*?windowTitle: tabTitle/);
  });

  it('closeChat logs COMMAND_OK with windowTitle in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async closeChat'), zone.indexOf('async readActiveComposerTabInfo'));
    assert.match(body, /logCommandOk\(`closed tab:[\s\S]*?windowTitle: tabTitle/);
  });

  it('withRetryValue not connected returns early without logging in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('private async withRetryValue'), zone.indexOf('private async clickElementCenter'));
    const early = body.slice(0, body.indexOf('let lastError'));
    assert.match(early, /if \(!this\.client \|\| !this\.client\.isConnected\(\)\)/);
    assert.match(early, /return \{ commandId, ok: false, error: 'Not connected to Cursor' \}/);
  });

  it('withRetryOnce not connected returns early without logging in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('private async withRetryOnce'), zone.indexOf('private async withRetry('));
    const early = body.slice(0, body.indexOf('try {'));
    assert.match(early, /if \(!this\.client \|\| !this\.client\.isConnected\(\)\)/);
    assert.match(early, /return \{ commandId, ok: false, error: 'Not connected to Cursor' \}/);
  });

  it('sendMessage uses withRetry in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async sendMessage'), zone.indexOf('async forceQueueItem'));
    assert.match(body, /return this\.withRetry\(commandId/);
  });

  it('forceQueueItem logs COMMAND_OK with itemId in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async forceQueueItem'), zone.indexOf('async clickApproval'));
    assert.match(body, /logCommandOk\([\s\S]*?itemId: queueItemId/);
  });

  it('scrollChatUp logs COMMAND_OK with hint times in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async scrollChatUp'), zone.indexOf('async scrollChatToBottom'));
    assert.match(body, /logCommandOk\(`scrolled up \$\{times\}x`[\s\S]*?hint: String\(times\)/);
  });

  it('reject delegates to clickApproval in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async reject'), zone.indexOf('async scrollChatUp'));
    assert.match(body, /return this\.clickApproval\(commandId, selectorPath\)/);
  });

  it('navigation imports logCommandOk logWarn logError in source', () => {
    const src = readFileSync(new URL('../../src/ide/actions/navigation.ts', import.meta.url), 'utf-8');
    assert.match(src, /import \{ logWarn, logError, logCommandOk \}/);
  });

  it('switchTab throws Tab not found when evaluate returns false in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async switchTab'), zone.indexOf('async clickQuestionnaire'));
    assert.match(body, /if \(!clicked\) throw new Error\('Tab not found: ' \+ tabTitle\)/);
  });

  it('advanceQuestionnaireStep returns early for not open without throw in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async advanceQuestionnaireStep'), zone.indexOf('async setQuestionnaireFreeform'));
    assert.match(body, /err === 'Questionnaire not open' \|\| err === 'Already on last question'/);
    assert.match(body, /return;/);
  });

  it('withRetry does not log COMMAND_FAIL in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('private async withRetry('), zone.indexOf('private async withRetryValue'));
    assert.ok(!body.includes('COMMAND_FAIL'));
  });

  it('withRetryValue does not log COMMAND_FAIL in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('private async withRetryValue'), zone.indexOf('private async clickElementCenter'));
    assert.ok(!body.includes('COMMAND_FAIL'));
  });

  it('clickQuestionnaire uses withRetry in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async clickQuestionnaire'), zone.indexOf('async advanceQuestionnaireStep'));
    assert.match(body, /return this\.withRetry\(commandId/);
  });

  it('setQuestionnaireFreeform uses withRetry in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async setQuestionnaireFreeform'), zone.indexOf('async newChat'));
    assert.match(body, /return this\.withRetry\(commandId/);
  });

  it('readActiveComposerTabInfo has no logInfo in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async readActiveComposerTabInfo'), zone.indexOf('async readActiveComposerTabTitle'));
    assert.ok(!body.includes('logInfo'));
    assert.ok(!body.includes('COMMAND_OK'));
  });

  it('extractToolContent has no navigation log codes in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async extractToolContent'), zone.indexOf('async setMode'));
    assert.ok(!body.includes('COMMAND_OK'));
    assert.ok(!body.includes('COMMAND_WARN'));
    assert.ok(!body.includes('COMMAND_FAIL'));
  });

  it('CommandExecutor setClient method exists in source', () => {
    const zone = navigationZoneSrc();
    assert.match(zone, /setClient\(client: CdpClient \| null\)/);
  });

  it('pressSubmit uses press_submit op not caller commandId in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('private async pressSubmit'), zone.indexOf('private async probeAttachmentPreview'));
    assert.match(body, /commandCtx\('press_submit'/);
    assert.ok(!body.includes('commandCtx(commandId'));
  });

  it('FOCUS_DELAY_MS constant exists in source', () => {
    const src = readFileSync(new URL('../../src/ide/actions/navigation.ts', import.meta.url), 'utf-8');
    assert.match(src, /const FOCUS_DELAY_MS = /);
  });

  it('newChat logs COMMAND_OK with selector hint in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async newChat'), zone.indexOf('async closeChat'));
    assert.match(body, /logCommandOk\(`new chat \(\$\{result\.sel/);
    assert.match(body, /hint: result\.sel/);
  });

  it('setPlanModel logs COMMAND_OK with planModel hint in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async setPlanModel'), zone.indexOf('private async withRetryOnce'));
    assert.match(body, /logCommandOk\(`planModel=\$\{planModelId\}`/);
    assert.match(body, /hint: planModelId/);
  });

  it('withRetry loop runs through MAX_RETRIES inclusive in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('private async withRetry('), zone.indexOf('private async withRetryValue'));
    assert.match(body, /for \(let attempt = 0; attempt <= MAX_RETRIES; attempt\+\+\)/);
  });

  it('commandCtx spreads extra context fields in source', () => {
    const zone = navigationZoneSrc();
    assert.match(zone, /return \{ scope: 'cdp', op, \.\.\.extra \}/);
  });

  it('setModel throws when pickModelById returns false in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async setModel(commandId'), zone.indexOf('async getModelOptions'));
    assert.match(body, /if \(!selected\) throw new Error\(`Model "\$\{modelId\}" not found in dropdown`\)/);
  });

  it('getPlanModelOptions delegates to withRetryValue in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async getPlanModelOptions'), zone.indexOf('async setPlanModel'));
    assert.match(body, /const result = await this\.withRetryValue\(commandId/);
  });

  it('approveAll uses findApproveAllButton before click in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async approveAll'), zone.indexOf('async reject'));
    assert.match(body, /const selector = await this\.findApproveAllButton\(client\)/);
    assert.match(body, /throw new Error\('"Accept All" button not found'\)/);
  });

  it('getModelOptions delegates to withRetryValue in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async getModelOptions'), zone.indexOf('async getPlanModelOptions'));
    assert.match(body, /const result = await this\.withRetryValue\(commandId/);
  });

  it('full navigation.ts has zero console log warn error calls in source', () => {
    const src = readFileSync(new URL('../../src/ide/actions/navigation.ts', import.meta.url), 'utf-8');
    assert.ok(!src.includes('console.log'));
    assert.ok(!src.includes('console.warn'));
    assert.ok(!src.includes('console.error'));
  });

  it('scrollChatToBottom logs COMMAND_OK scrolled to bottom in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async scrollChatToBottom'), zone.indexOf('async switchTab'));
    assert.match(body, /logCommandOk\('scrolled to bottom'/);
  });

  it('advanceQuestionnaireStep uses withRetryOnce in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async advanceQuestionnaireStep'), zone.indexOf('async setQuestionnaireFreeform'));
    assert.match(body, /return this\.withRetryOnce\(commandId/);
  });

  it('clickQuestionnaire continue presses Enter after click in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async clickQuestionnaire'), zone.indexOf('async advanceQuestionnaireStep'));
    assert.match(body, /if \(target === 'continue'\)/);
    assert.match(body, /await client\.pressKey\('Enter', 'Enter', 13\)/);
  });

  it('setMode logs COMMAND_OK with hint modeId in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async setMode'), zone.indexOf('async clickAction'));
    assert.match(body, /logCommandOk\(`mode=\$\{modeId\}`[\s\S]*?hint: modeId/);
  });

  it('withRetryValue WARN uses attempt in commandCtx like withRetry in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('private async withRetryValue'), zone.indexOf('private async clickElementCenter'));
    assert.match(body, /commandCtx\(commandId, \{ attempt: attempt \+ 1 \}\)/);
  });

  it('forceQueueItem uses withRetry in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async forceQueueItem'), zone.indexOf('async clickApproval'));
    assert.match(body, /return this\.withRetry\(commandId/);
  });

  it('sendMessage logs focus before insert in source order', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async sendMessage'), zone.indexOf('async forceQueueItem'));
    const focusIdx = body.indexOf('logCommandOk(result.info');
    const insertIdx = body.indexOf('inserted ${text.length} chars');
    assert.ok(focusIdx >= 0 && insertIdx > focusIdx);
  });

  it('sendMessage clicks composer send when text has @path', () => {
    const zone = navigationZoneSrc();
    const sendBody = zone.slice(zone.indexOf('async sendMessage'), zone.indexOf('async forceQueueItem'));
    assert.match(sendBody, /submitComposer\(client, commandId, text, submit\)/);
    assert.match(zone, /clickComposerSendButton/);
  });

  it('switchTab verify loop throws Tab switch did not activate in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async switchTab'), zone.indexOf('async clickQuestionnaire'));
    assert.match(body, /throw new Error\(`Tab switch did not activate: \$\{tabTitle\}`\)/);
  });

  it('logging zone has exactly twenty four log call sites in source', () => {
    const zone = navigationZoneSrc();
    assert.equal((zone.match(/log(?:CommandOk|Info|Warn|Error)\(/g) ?? []).length, 24);
  });

  it('logging zone ends before file-level sleep helper in source', () => {
    const src = readFileSync(new URL('../../src/ide/actions/navigation.ts', import.meta.url), 'utf-8');
    const zoneEnd = src.indexOf('function sleep');
    const zoneStart = src.indexOf('function commandCtx');
    assert.ok(zoneEnd > zoneStart);
    assert.ok(!src.slice(zoneStart, zoneEnd).includes('function sleep'));
  });

  it('clickQuestionnaire continue branch uses continue label in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async clickQuestionnaire'), zone.indexOf('async advanceQuestionnaireStep'));
    assert.match(body, /target === 'continue'/);
    assert.match(body, /questionnaire click: \$\{label\}/);
  });

  it('withRetry WARN message uses MAX_RETRIES plus one denominator in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('private async withRetry('), zone.indexOf('private async withRetryValue'));
    assert.match(body, /Attempt \$\{attempt \+ 1\}\/\$\{MAX_RETRIES \+ 1\} failed/);
  });

  it('setModel OK message includes menuClosed flag in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async setModel(commandId'), zone.indexOf('async getModelOptions'));
    assert.match(body, /model=\$\{modelId\} menuClosed=\$\{!menuStillOpen\}/);
  });

  it('clickAction truncates selector with substring 0 60 in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async clickAction'), zone.indexOf('async setModel(commandId'));
    assert.match(body, /selectorPath\.substring\(0, 60\)/);
  });

  it('scrollChatUp default times parameter is 5 in source', () => {
    const zone = navigationZoneSrc();
    assert.match(zone, /async scrollChatUp\(commandId: string, times: number = 5\)/);
  });

  it('closeChat logs closed tab with active fallback text in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async closeChat'), zone.indexOf('async readActiveComposerTabInfo'));
    assert.match(body, /closed tab: \$\{tabTitle \?\? '\(active\)'\}/);
  });

  it('readActiveComposerTabTitle delegates to readActiveComposerTabInfo in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async readActiveComposerTabTitle'), zone.indexOf('async setMode'));
    assert.match(body, /const info = await this\.readActiveComposerTabInfo\(\)/);
    assert.match(body, /return info\.title/);
  });

  it('CommandExecutor is exported class in source', () => {
    const src = readFileSync(new URL('../../src/ide/actions/navigation.ts', import.meta.url), 'utf-8');
    assert.match(src, /export class CommandExecutor/);
  });

  it('logging zone uses logCommandOk for all COMMAND_OK sites in source', () => {
    const zone = navigationZoneSrc();
    const okSites = zone.match(/logCommandOk\([\s\S]*?\);/g) ?? [];
    assert.equal(okSites.length, 20);
    for (const site of okSites) {
      assert.match(site, /commandCtx\(/);
    }
  });

  it('withRetryValue WARN message uses MAX_RETRIES plus one denominator in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('private async withRetryValue'), zone.indexOf('private async clickElementCenter'));
    assert.match(body, /Attempt \$\{attempt \+ 1\}\/\$\{MAX_RETRIES \+ 1\} failed/);
  });

  it('setPlanModel throws when pick returns false in source', () => {
    const zone = navigationZoneSrc();
    const body = zone.slice(zone.indexOf('async setPlanModel'), zone.indexOf('private async withRetryOnce'));
    assert.match(body, /if \(!selected\) throw new Error\(`Plan model "\$\{planModelId\}" not found`\)/);
  });

  it('every navigation log code appears in NAVIGATION_LOG_CODES constant in tests', () => {
    assert.deepEqual([...NAVIGATION_LOG_CODES].sort(), ['COMMAND_FAIL', 'COMMAND_OK', 'COMMAND_WARN'].sort());
  });
});
