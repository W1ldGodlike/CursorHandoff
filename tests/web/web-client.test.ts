import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { JSDOM } from 'jsdom';
import * as esbuild from 'esbuild';
import type { CursorState } from '../../src/core/types.js';
import { describeFx, hasLocalFixtures, loadFixture } from '../helpers/local-fixtures.js';

/** JSDOM + client app timers keep the process alive unless every window is closed at suite end. */
const openDoms: JSDOM[] = [];

after(() => {
  while (openDoms.length > 0) {
    const dom = openDoms.pop();
    const w = dom?.window as Window & { __handoffStopTimers?: () => void };
    w?.__handoffStopTimers?.();
    dom?.window.close();
  }
});

const HTML_PATH = resolve('src/client/index.html');
const I18N_JS_PATH = resolve('src/client/i18n.js');
const CLIENT_ENTRY = resolve('src/client/js/app.js');
const CSS_PATH = resolve('src/client/styles/main.css');

let clientAppBundle: string | null = null;

/** Bundled IIFE for JSDOM (ES module graph → single script). */
function getClientAppBundle(): string {
  if (!clientAppBundle) {
    const result = esbuild.buildSync({
      entryPoints: [CLIENT_ENTRY],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      write: false,
    });
    clientAppBundle = result.outputFiles![0].text;
  }
  return clientAppBundle;
}

type EventHandler = (...args: unknown[]) => void;

interface MockSocket {
  handlers: Map<string, EventHandler>;
  emitted: Array<{ event: string; args: unknown[] }>;
  on(event: string, fn: EventHandler): void;
  emit(event: string, ...args: unknown[]): void;
  fire(event: string, ...args: unknown[]): void;
  connected: boolean;
  id: string;
}

async function waitForHandoffBootstrap(window: Window) {
  const deadline = Date.now() + 5000;
  while (!(window as unknown as { __handoffBootstrapped?: boolean }).__handoffBootstrapped) {
    if (Date.now() > deadline) throw new Error('handoff bootstrap timeout');
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function createTestEnv(opts?: {
  hostname?: string;
  webTunnelUrl?: string | null;
  telegramTopicUrl?: string | null;
}) {
  const html = readFileSync(HTML_PATH, 'utf-8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const i18nJs = readFileSync(I18N_JS_PATH, 'utf-8');
  const appJs = getClientAppBundle();
  const hostname = opts?.hostname ?? 'localhost';
  let webTunnelUrl: string | null | undefined = opts?.webTunnelUrl;
  let telegramTopicUrl: string | null | undefined = opts?.telegramTopicUrl;
  if (webTunnelUrl === undefined && hostname.endsWith('.trycloudflare.com')) {
    webTunnelUrl = null;
  }

  const dom = new JSDOM(html, {
    url: hostname === 'localhost'
      ? 'http://localhost:3000/'
      : `https://${hostname}/`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window: Window) {
      const mockSocket: MockSocket = {
        handlers: new Map(),
        emitted: [],
        connected: true,
        id: 'test-socket-id',
        on(event: string, fn: EventHandler) {
          this.handlers.set(event, fn);
        },
        emit(event: string, ...args: unknown[]) {
          this.emitted.push({ event, args });
        },
        fire(event: string, ...args: unknown[]) {
          const handler = this.handlers.get(event);
          if (handler) handler(...args);
        },
      };

      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as any).__clipboardText = text;
          },
        },
      });

      (window as any).io = function () {
        return mockSocket;
      };

      (window as any).__mockSocket = mockSocket;

      const storage: Record<string, string> = {};
      Object.defineProperty(window, 'localStorage', {
        value: {
          getItem: (key: string) => storage[key] ?? null,
          setItem: (key: string, val: string) => { storage[key] = val; },
          removeItem: (key: string) => { delete storage[key]; },
        },
      });

      (window as any).requestAnimationFrame = (cb: () => void) => {
        setTimeout(cb, 0);
        return 0;
      };

      let mockWebSettingsRecord: { updatedAt: number; settings: Record<string, unknown> } = {
        updatedAt: 0,
        settings: {},
      };
      (window as any).__mockWebSettingsRecord = mockWebSettingsRecord;
      (window as any).__setMockWebSettingsRecord = (value: typeof mockWebSettingsRecord) => {
        mockWebSettingsRecord.updatedAt = value.updatedAt;
        mockWebSettingsRecord.settings = value.settings;
      };

      (window as any).fetch = async (url: string, init?: RequestInit) => {
        if (String(url).includes('/health')) {
          const body: Record<string, unknown> = {
            authRequired: false,
            build: { version: '1.0.0', compatVersion: 1, fingerprint: 'handoff-1.0.0-compat-1' },
            webTunnelUrl: 'https://diag.test',
            connected: true,
            extractorStatus: 'ok',
            uptime: 120,
          };
          if (webTunnelUrl !== undefined) body.webTunnelUrl = webTunnelUrl;
          else if (!body.webTunnelUrl) body.webTunnelUrl = 'https://metrics.test';
          if (telegramTopicUrl !== undefined) body.telegramTopicUrl = telegramTopicUrl;
          return { ok: true, json: async () => body };
        }
        if (String(url).includes('/api/web-settings')) {
          if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body ?? '{}')) as { settings?: Record<string, unknown> };
            mockWebSettingsRecord.updatedAt = Date.now();
            mockWebSettingsRecord.settings = body.settings ?? {};
          }
          return { ok: true, json: async () => mockWebSettingsRecord };
        }
        if (String(url).includes('/api/logout') && init?.method === 'POST') {
          return { ok: true, json: async () => ({ ok: true }) };
        }
        throw new Error(`fetch not mocked: ${url}`);
      };

      (window as any).ResizeObserver = class {
        observe() { /* noop */ }
        disconnect() { /* noop */ }
      };

      if (!window.URL.createObjectURL) {
        const blobUrls = new Map<string, string>();
        window.URL.createObjectURL = (blob: Blob) => {
          const url = `blob:mock-${blobUrls.size}`;
          blobUrls.set(url, '1');
          return url;
        };
        window.URL.revokeObjectURL = (url: string) => {
          blobUrls.delete(url);
        };
      }

      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: (query: string) => ({
          matches: false,
          media: query,
          addEventListener() { /* noop */ },
          removeEventListener() { /* noop */ },
        }),
      });

      let confirmResult = true;
      (window as any).__setConfirm = (value: boolean) => {
        confirmResult = value;
      };
      window.confirm = () => confirmResult;

      (window as any).__setTelegramTopicUrl = (value: string | null | undefined) => {
        telegramTopicUrl = value;
      };
    },
  });

  const window = dom.window;
  const document = window.document;

  const css = readFileSync(CSS_PATH, 'utf-8');
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  const i18nScript = document.createElement('script');
  i18nScript.textContent = i18nJs;
  document.body.appendChild(i18nScript);

  const scriptEl = document.createElement('script');
  scriptEl.textContent = appJs;
  document.body.appendChild(scriptEl);

  const mockSocket = (window as any).__mockSocket as MockSocket;

  await waitForHandoffBootstrap(window);

  openDoms.push(dom);
  return { dom, window, document, mockSocket };
}

function fireFullState(mockSocket: MockSocket, state: CursorState) {
  mockSocket.fire('state:full', state);
}

function firePatch(mockSocket: MockSocket, patch: Partial<CursorState>) {
  mockSocket.fire('state:patch', patch);
}

// ─── Connection status render ───

function chipText(doc: Document, id: string): string {
  const el = doc.querySelector(`.status-chip[data-chip="${id}"]`);
  return el?.textContent ?? '';
}

describeFx('web: connection status', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
  });

  it('shows connected relay and cursor chips when extractorStatus is ok', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    await new Promise((r) => setTimeout(r, 30));
    assert.match(chipText(env.document, 'relay'), /Server ✓/);
    assert.match(chipText(env.document, 'cursor'), /Cursor ✓/);
  });

  it('shows warn cursor chip when extractorStatus is stale', async () => {
    const fixture = loadFixture('connection-states.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    await new Promise((r) => setTimeout(r, 30));
    const cursor = env.document.querySelector('.status-chip[data-chip="cursor"]')!;
    assert.ok(cursor.classList.contains('status-chip-warn'));
  });
});

// ─── Agent status render ───

describeFx('web: agent status', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
  });

  it('shows idle cursor chip when agent is idle', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    await new Promise((r) => setTimeout(r, 30));
    assert.match(chipText(env.document, 'cursor'), /Cursor ✓/);
  });

  it('shows thinking activity in cursor chip when shimmer active', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    await new Promise((r) => setTimeout(r, 30));
    assert.match(chipText(env.document, 'cursor'), /Planning next moves/i);
  });

  it('clears activity when shimmer stops', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    fireFullState(env.mockSocket, fixture[4].state!);
    await new Promise((r) => setTimeout(r, 30));
    assert.match(chipText(env.document, 'cursor'), /Cursor ✓/);
  });
});

// ─── Message render ───

describeFx('web: message rendering', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  it('renders human message', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const humanEl = msgs.querySelector('.el-human');
    assert.ok(humanEl, 'Should render human message (.el-human)');
    assert.match(humanEl!.textContent!, /Fix the bug/);
  });

  it('renders assistant message', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[4].state!);
    const msgs = env.document.getElementById('messages')!;
    assert.ok(msgs.querySelector('.el-assistant'), 'Should render assistant message (.el-assistant)');
  });

  it('wraps markdown tables in scroll container', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    const state = { ...fixture[4].state! };
    state.messages = [{
      id: 'tbl-1',
      type: 'assistant',
      flatIndex: 0,
      html: '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
      text: '',
      codeBlocks: [],
    }];
    fireFullState(env.mockSocket, state);
    const wrap = env.document.querySelector('.md-table-wrap');
    assert.ok(wrap, 'table should be wrapped');
    assert.ok(wrap!.querySelector('table.md-table'));
    assert.ok(wrap!.querySelector('table th'));
  });

  it('promotes first tbody row with th into thead', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    const state = { ...fixture[4].state! };
    state.messages = [{
      id: 'tbl-2',
      type: 'assistant',
      flatIndex: 0,
      html: '<table><tbody><tr><th>X</th><th>Y</th></tr><tr><td>a</td><td>b</td></tr></tbody></table>',
      text: '',
      codeBlocks: [],
    }];
    fireFullState(env.mockSocket, state);
    const table = env.document.querySelector('.md-table-wrap table');
    assert.ok(table?.querySelector('thead th'));
    assert.equal(table?.querySelectorAll('tbody tr').length, 1);
  });

  it('renders mermaid code block via client diagram renderer', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    const state = { ...fixture[4].state! };
    state.messages = [{
      id: 'mmd-2',
      type: 'assistant',
      flatIndex: 0,
      html: '<div class="composer-message-codeblock"></div>',
      text: '',
      codeBlocks: [{
        blockKind: 'code',
        language: 'mermaid',
        code: 'flowchart TD\n  A[Web] --> B[Relay]',
      }],
    }];
    await new Promise((r) => setTimeout(r, 0));
    env.window.mermaid = {
      initialize() {},
      render: async () => ({
        svg: '<svg><g class="node"><foreignObject><div>Web</div></foreignObject></g></svg>',
      }),
    };
    env.window.__mermaidThemeKey = 'dark';
    fireFullState(env.mockSocket, state);
    await new Promise((r) => setTimeout(r, 0));
    const wrap = env.document.querySelector('.md-diagram-wrap');
    assert.ok(wrap, 'mermaid code block should become diagram wrap');
    assert.ok(wrap!.querySelector('svg'), 'diagram should contain svg');
  });

  it('wraps mermaid svg in diagram container with readable labels', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    const state = { ...fixture[4].state! };
    state.messages = [{
      id: 'mmd-1',
      type: 'assistant',
      flatIndex: 0,
      html: '<svg><g class="node"><rect fill="#000000" width="80" height="40"/><foreignObject><div style="color:#000;background:#000">Relay</div></foreignObject></g></svg>',
      text: '',
      codeBlocks: [],
    }];
    await new Promise((r) => setTimeout(r, 0));
    fireFullState(env.mockSocket, state);
    await new Promise((r) => setTimeout(r, 0));
    const wrap = env.document.querySelector('.md-diagram-wrap');
    assert.ok(wrap, 'svg should be wrapped');
    assert.ok(wrap!.querySelector('svg'));
    assert.ok(wrap!.querySelector('foreignObject div'), 'label in foreignObject');
  });

  it('keeps assistant dom stable when patch payload is unchanged', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    const base = { ...fixture[4].state! };
    const messages = [{
      id: 'stable-a1',
      type: 'assistant',
      flatIndex: 0,
      text: 'Таблица',
      html: '<p>до</p><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>',
      codeBlocks: [],
    }];
    fireFullState(env.mockSocket, { ...base, messages });
    const content = env.document.querySelector('.assistant-content');
    assert.ok(content);
    const tableWrap = content.querySelector('.md-table-wrap');
    tableWrap.scrollLeft = 42;
    const nodeBefore = content.querySelector('table');
    firePatch(env.mockSocket, { messages: JSON.parse(JSON.stringify(messages)) });
    assert.equal(content.querySelector('table'), nodeBefore);
    assert.equal(tableWrap.scrollLeft, 42);
  });

  it('renders tool element with filename', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[4].state!);
    const msgs = env.document.getElementById('messages')!;
    const toolEls = msgs.querySelectorAll('.el-tool');
    assert.ok(toolEls.length > 0, 'Should render tool messages (.el-tool)');
  });

  it('updates messages on patch', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const initialCount = msgs.querySelectorAll('[data-id]').length;

    firePatch(env.mockSocket, {
      messages: fixture[4].state!.messages,
      agentStatus: 'idle',
      agentActivityText: null,
      agentActivityLive: false,
    });
    const updatedCount = msgs.querySelectorAll('[data-id]').length;
    assert.ok(updatedCount > initialCount, `Expected more messages after patch, got ${initialCount} -> ${updatedCount}`);
  });

  it('shows "New below" when user scrolled up', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    const base = { ...fixture[4].state! };
    fireFullState(env.mockSocket, base);
    const msgs = env.document.getElementById('messages')!;
    Object.defineProperty(msgs, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(msgs, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(msgs, 'scrollTop', { value: 100, writable: true, configurable: true });
    msgs.dispatchEvent(new env.window.Event('scroll'));

    const extra = { ...base.messages[base.messages.length - 1], id: 'new-below-1', flatIndex: 999 };
    firePatch(env.mockSocket, { messages: [...base.messages, extra] });
    await new Promise((r) => setTimeout(r, 0));

    const btn = env.document.getElementById('btn-new-below') as HTMLButtonElement;
    assert.ok(!btn.classList.contains('hidden'));
    assert.match(btn.textContent ?? '', /New below/i);
  });

  it('click on "New below" returns to follow mode', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    const base = { ...fixture[4].state! };
    fireFullState(env.mockSocket, base);
    const msgs = env.document.getElementById('messages')!;
    Object.defineProperty(msgs, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(msgs, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(msgs, 'scrollTop', { value: 100, writable: true, configurable: true });
    msgs.dispatchEvent(new env.window.Event('scroll'));

    const extra = { ...base.messages[base.messages.length - 1], id: 'new-below-2', flatIndex: 1000 };
    firePatch(env.mockSocket, { messages: [...base.messages, extra] });
    await new Promise((r) => setTimeout(r, 0));

    const btn = env.document.getElementById('btn-new-below') as HTMLButtonElement;
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(btn.classList.contains('hidden'));
  });

  it('linkifies bare URLs in assistant content', () => {
    fireFullState(env.mockSocket, {
      connected: true,
      extractorStatus: 'ok',
      agentStatus: 'idle',
      messages: [{
        id: 'a-url',
        type: 'assistant',
        flatIndex: 0,
        text: 'см. https://example.com/docs',
        html: '<p>см. https://example.com/docs</p>',
        codeBlocks: [],
      }],
      pendingApprovals: [],
      inputAvailable: true,
      chatTabs: [],
      mode: { current: 'agent', available: [] },
      model: { current: 'Auto', currentId: '' },
      windows: [],
      activeWindowId: '',
      composerQueue: { items: [] },
    });
    const link = env.document.querySelector('.assistant-content a') as HTMLAnchorElement;
    assert.ok(link);
    assert.match(link.href, /example\.com\/docs/);
    assert.equal(link.target, '_blank');
  });

  it('highlights src paths and copies on tap', async () => {
    fireFullState(env.mockSocket, {
      connected: true,
      extractorStatus: 'ok',
      agentStatus: 'idle',
      messages: [{
        id: 'a-path',
        type: 'assistant',
        flatIndex: 0,
        text: 'правка в src/client/app.js',
        html: '<p>правка в src/client/app.js</p>',
        codeBlocks: [],
      }],
      pendingApprovals: [],
      inputAvailable: true,
      chatTabs: [],
      mode: { current: 'agent', available: [] },
      model: { current: 'Auto', currentId: '' },
      windows: [],
      activeWindowId: '',
      composerQueue: { items: [] },
    });
    const pathBtn = env.document.querySelector('.md-src-path') as HTMLButtonElement;
    assert.ok(pathBtn);
    assert.match(pathBtn.textContent ?? '', /src\/client\/app\.js/);
    pathBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal((env.window as any).__clipboardText, 'src/client/app.js');
  });
});

describeFx('web: message feed filter', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[4].state!);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('shows filter chips when messages exist', () => {
    const bar = env.document.getElementById('message-filter-bar')!;
    assert.ok(!bar.classList.contains('hidden'));
    assert.equal(bar.querySelectorAll('.message-filter-chip').length, 4);
  });

  it('filters to human messages only', () => {
    const humanChip = env.document.querySelector('.message-filter-chip[data-filter="human"]') as HTMLButtonElement;
    humanChip.click();
    const visible = [...env.document.querySelectorAll('.chat-el')].filter((el) => !el.classList.contains('feed-hidden'));
    assert.ok(visible.every((el) => el.classList.contains('el-human')));
    assert.ok(visible.length > 0);
  });

  it('filters to tools only', () => {
    const toolsChip = env.document.querySelector('.message-filter-chip[data-filter="tools"]') as HTMLButtonElement;
    toolsChip.click();
    const visible = [...env.document.querySelectorAll('.chat-el')].filter((el) => !el.classList.contains('feed-hidden'));
    assert.ok(visible.every((el) => el.classList.contains('el-tool')));
    assert.equal(visible.length, 1);
  });
});

describeFx('web: lazy history load', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[4].state!);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('has history load indicator hidden by default', () => {
    const el = env.document.getElementById('history-load-indicator');
    assert.ok(el);
    assert.match(el!.textContent ?? '', /Loading history/i);
    assert.ok(el!.classList.contains('hidden'));
  });

  it('emits load_history when scrolled up near top', async () => {
    const msgs = env.document.getElementById('messages')!;
    Object.defineProperty(msgs, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(msgs, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(msgs, 'scrollTop', { value: 120, writable: true, configurable: true });
    msgs.dispatchEvent(new env.window.Event('scroll'));
    Object.defineProperty(msgs, 'scrollTop', { value: 0, writable: true, configurable: true });
    msgs.dispatchEvent(new env.window.Event('scroll'));
    await new Promise((r) => setTimeout(r, 0));
    const sent = env.mockSocket.emitted.filter((e) => e.event === 'command:load_history');
    assert.equal(sent.length, 1);
    const indicator = env.document.getElementById('history-load-indicator')!;
    assert.ok(!indicator.classList.contains('hidden'));
    env.mockSocket.fire('command:result', {
      commandId: (sent[0].args[0] as { commandId: string }).commandId,
      ok: true,
      data: { added: 2, total: 20 },
    });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(indicator.classList.contains('hidden'));
  });

  it('stops loading when server returns added=0', async () => {
    const msgs = env.document.getElementById('messages')!;
    Object.defineProperty(msgs, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(msgs, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(msgs, 'scrollTop', { value: 120, writable: true, configurable: true });
    msgs.dispatchEvent(new env.window.Event('scroll'));
    Object.defineProperty(msgs, 'scrollTop', { value: 0, writable: true, configurable: true });
    msgs.dispatchEvent(new env.window.Event('scroll'));
    await new Promise((r) => setTimeout(r, 0));
    const sent = env.mockSocket.emitted.filter((e) => e.event === 'command:load_history');
    assert.equal(sent.length, 1);
    env.mockSocket.fire('command:result', {
      commandId: (sent[0].args[0] as { commandId: string }).commandId,
      ok: true,
      data: { added: 0, total: 10 },
    });
    await new Promise((r) => setTimeout(r, 0));
    msgs.dispatchEvent(new env.window.Event('scroll'));
    await new Promise((r) => setTimeout(r, 0));
    const total = env.mockSocket.emitted.filter((e) => e.event === 'command:load_history').length;
    assert.equal(total, 1);
  });

  it('does not emit load_history when scrolling down from top', async () => {
    const msgs = env.document.getElementById('messages')!;
    Object.defineProperty(msgs, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(msgs, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(msgs, 'scrollTop', { value: 0, writable: true, configurable: true });
    msgs.dispatchEvent(new env.window.Event('scroll'));
    Object.defineProperty(msgs, 'scrollTop', { value: 60, writable: true, configurable: true });
    msgs.dispatchEvent(new env.window.Event('scroll'));
    await new Promise((r) => setTimeout(r, 0));
    const sent = env.mockSocket.emitted.filter((e) => e.event === 'command:load_history');
    assert.equal(sent.length, 0);
  });
});

// ─── Run command / approval render ───

describeFx('web: approval widgets', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  it('renders run_command with command text', () => {
    const fixture = loadFixture('approval-widget-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const runCard = msgs.querySelector('.run-card');
    assert.ok(runCard, 'Should render run_command card');
    assert.match(runCard!.textContent!, /npm test/);
  });

  it('renders run_command with Skip and Run buttons', () => {
    const fixture = loadFixture('approval-widget-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const buttons = msgs.querySelectorAll('.run-btn');
    assert.ok(buttons.length >= 2, `Expected 2+ run buttons, got ${buttons.length}`);
  });

  it('preserves command text across updates', () => {
    const fixture = loadFixture('approval-widget-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    fireFullState(env.mockSocket, fixture[2].state!);
    const msgs = env.document.getElementById('messages')!;
    const runCards = msgs.querySelectorAll('.run-card');
    const hasNpmTest = Array.from(runCards).some(
      card => card.textContent!.includes('npm test')
    );
    assert.ok(hasNpmTest, 'npm test should be preserved in run cards');
  });
});

// ─── Plan widget render ───

describeFx('web: plan widget', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  it('renders plan block with title and progress', () => {
    const fixture = loadFixture('plan-widget.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const planEl = msgs.querySelector('.el-plan');
    assert.ok(planEl, 'Should render plan block (.el-plan)');
    assert.match(planEl!.textContent!, /Auth System/);
  });

  it('plan toolbar allows wrapping (no forced nowrap)', () => {
    const fixture = loadFixture('plan-widget.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const toolbar = env.document.querySelector('.plan-actions-toolbar') as HTMLElement | null;
    assert.ok(toolbar, 'plan toolbar should exist');
    const nowrap = env.window.getComputedStyle(toolbar!).flexWrap;
    assert.notEqual(nowrap, 'nowrap', 'plan toolbar should not force nowrap');
  });
});

describeFx('web: header plan bar', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
  });

  it('is hidden when no plan widget', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    await new Promise((r) => setTimeout(r, 20));
    const bar = env.document.getElementById('header-plan-bar')!;
    assert.ok(bar.classList.contains('hidden'));
  });

  it('shows todo progress when plan widget is active', async () => {
    const fixture = loadFixture('plan-widget.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    await new Promise((r) => setTimeout(r, 20));
    const bar = env.document.getElementById('header-plan-bar')!;
    assert.ok(!bar.classList.contains('hidden'));
    assert.match(bar.textContent ?? '', /Auth System/);
    assert.match(bar.textContent ?? '', /0\/3/);
    const progressBar = env.document.getElementById('header-plan-progress-bar') as HTMLElement;
    assert.equal(progressBar.style.width, '0%');
  });

  it('opens plan modal on click', async () => {
    const fixture = loadFixture('plan-widget.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    await new Promise((r) => setTimeout(r, 20));
    const bar = env.document.getElementById('header-plan-bar') as HTMLButtonElement;
    bar.click();
    const overlay = env.document.getElementById('plan-modal-overlay')!;
    assert.ok(!overlay.classList.contains('hidden'));
    assert.match(env.document.getElementById('plan-modal-title')!.textContent ?? '', /Auth System/);
  });
});

describeFx('web: plan full modal', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    const fixture = loadFixture('plan-widget.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('requests get_plan_full when opened with label', async () => {
    const viewBtn = env.document.querySelector('.plan-btn-view') as HTMLButtonElement;
    viewBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    const sent = env.mockSocket.emitted.filter((e) => e.event === 'command:get_plan_full');
    assert.equal(sent.length, 1);
    assert.equal((sent[0].args[0] as { planLabel: string }).planLabel, 'Auth System');
  });

  it('renders full todos and body after get_plan_full', async () => {
    const viewBtn = env.document.querySelector('.plan-btn-view') as HTMLButtonElement;
    viewBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    const sent = env.mockSocket.emitted.filter((e) => e.event === 'command:get_plan_full');
    env.mockSocket.fire('command:result', {
      commandId: (sent[0].args[0] as { commandId: string }).commandId,
      ok: true,
      data: {
        todos: [
          { text: 'Todo A', status: 'completed' },
          { text: 'Todo B', status: 'pending' },
          { text: 'Todo C', status: 'pending' },
        ],
        bodyHtml: '<p>Full plan body</p>',
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const body = env.document.getElementById('plan-modal-body')!;
    assert.match(body.textContent ?? '', /Tasks 1\/3/);
    assert.match(body.textContent ?? '', /Todo C/);
    assert.match(body.innerHTML, /Full plan body/);
  });

  it('closes on Escape', async () => {
    const viewBtn = env.document.querySelector('.plan-btn-view') as HTMLButtonElement;
    viewBtn.click();
    const overlay = env.document.getElementById('plan-modal-overlay')!;
    assert.ok(!overlay.classList.contains('hidden'));
    env.document.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.ok(overlay.classList.contains('hidden'));
  });
});

describe('web: settings screen', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
  });

  it('has settings gear in header', () => {
    const btn = env.document.getElementById('header-settings-btn');
    assert.ok(btn);
    assert.ok((btn!.textContent ?? '').length > 0);
  });

  it('opens settings panel on gear click', async () => {
    const btn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    btn.click();
    const overlay = env.document.getElementById('settings-overlay')!;
    assert.ok(!overlay.classList.contains('hidden'));
    assert.match(overlay.textContent ?? '', /Message timestamps/i);
    const select = env.document.getElementById('setting-timezone') as HTMLSelectElement;
    assert.ok(select);
    assert.equal(select.options.length, 25);
    assert.equal(select.options[0].value, 'UTC-12');
    assert.equal(select.options[select.options.length - 1].value, 'UTC+12');
  });

  it('shows message times when enabled', async (t) => {
    if (!hasLocalFixtures) return t.skip();
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[4].state!);
    await new Promise((r) => setTimeout(r, 20));
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    const checkbox = env.document.getElementById('setting-show-message-times') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    const times = env.document.querySelectorAll('.chat-el-time');
    assert.ok(times.length > 0);
  });

  it('persists timezone to localStorage', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    const select = env.document.getElementById('setting-timezone') as HTMLSelectElement;
    select.value = 'UTC';
    select.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    const raw = env.window.localStorage.getItem('cursor-handoff-web-settings');
    assert.ok(raw);
    assert.match(raw!, /"timezone":"UTC"/);
    assert.match(raw!, /"updatedAt":\d+/);
  });

  it('hydrates newer settings from relay on connect', async () => {
    (env.window as any).__setMockWebSettingsRecord({
      updatedAt: Date.now() + 60_000,
      settings: { showMessageTimes: true, timezone: 'UTC', syncToServer: false },
    });
    env.mockSocket.fire('connect');
    await new Promise((r) => setTimeout(r, 30));
    const checkbox = env.document.getElementById('setting-show-message-times') as HTMLInputElement;
    assert.equal(checkbox.checked, true);
    const select = env.document.getElementById('setting-timezone') as HTMLSelectElement;
    assert.equal(select.value, 'UTC');
  });

  it('pushes settings to relay when sync enabled', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    const sync = env.document.getElementById('setting-sync-to-server') as HTMLInputElement;
    sync.checked = true;
    sync.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    const record = (env.window as any).__mockWebSettingsRecord;
    assert.equal(record.settings.syncToServer, true);
    assert.ok(record.updatedAt > 0);
  });

  it('applies light theme to document', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    const theme = env.document.getElementById('setting-theme') as HTMLSelectElement;
    theme.value = 'light';
    theme.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(env.document.documentElement.dataset.theme, 'light');
  });

  it('applies compact feed class on app', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    const compact = env.document.getElementById('setting-compact-feed') as HTMLInputElement;
    compact.checked = true;
    compact.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    const app = env.document.getElementById('app')!;
    assert.ok(app.classList.contains('feed-compact'));
  });
});

// ─── Code block render ───

describeFx('web: code block rendering', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  it('renders diff block with viewport', () => {
    const fixture = loadFixture('code-block-diff.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const msgs = env.document.getElementById('messages')!;
    const diffBlock = msgs.querySelector('.code-block-viewport');
    assert.ok(diffBlock, 'Should render a code block viewport');
  });

  it('preserves newlines in code blocks', () => {
    const fixture = loadFixture('code-block-diff.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const msgs = env.document.getElementById('messages')!;
    const codeEl = msgs.querySelector('.code-block-viewport pre code');
    if (codeEl) {
      const text = codeEl.textContent ?? '';
      assert.ok(text.includes('\n'), 'Code block text should preserve newlines');
    }
  });

  it('renders assistant message with code blocks', () => {
    const fixture = loadFixture('code-block-diff.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const msgs = env.document.getElementById('messages')!;
    const assistant = msgs.querySelector('.el-assistant');
    assert.ok(assistant, 'Should render assistant message (.el-assistant)');
  });

  it('keeps composer code blocks inline in assistant html order', () => {
    fireFullState(env.mockSocket, {
      connected: true,
      extractorStatus: 'ok',
      messages: [{
        type: 'assistant',
        id: 'a-inline',
        flatIndex: 0,
        text: 'before after',
        html: '<p>before</p><div class="composer-message-codeblock">x</div><p>after</p>',
        codeBlocks: [{ blockKind: 'code', code: 'Cursor (виртуальный список) → CDP' }],
      }],
      pendingApprovals: [],
      inputAvailable: true,
      chatTabs: [],
      agentStatus: 'idle',
    });
    const content = env.document.querySelector('.assistant-content');
    assert.ok(content);
    const children = Array.from(content.children).map((n) => {
      const cls = n.className ? '.' + n.className.split(/\s+/)[0] : '';
      return n.tagName + cls;
    });
    const codeIdx = children.findIndex((c) => c.startsWith('DIV.') && c.includes('code-block'));
    assert.ok(codeIdx > 0, children.join(' | '));
    assert.ok(codeIdx < children.length - 1, children.join(' | '));
  });
});

// ─── Fetch tool render ───

describeFx('web: fetch tool', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  it('renders fetch tool with action text and URL', () => {
    const fixture = loadFixture('fetch-tool.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const toolEl = msgs.querySelector('.el-tool');
    assert.ok(toolEl, 'Should render fetch tool (.el-tool)');
    assert.match(toolEl!.textContent!, /Fetch/);
    assert.match(toolEl!.textContent!, /reddit\.com/);
  });

  it('renders fetch tool with approval buttons', () => {
    const fixture = loadFixture('fetch-tool.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const toolEl = msgs.querySelector('.el-tool');
    assert.ok(toolEl, 'Should render fetch tool');
    const actionRow = toolEl!.querySelector('.tool-actions-row');
    assert.ok(actionRow, 'Should have tool-actions-row with buttons');
    const buttons = actionRow!.querySelectorAll('.run-btn');
    assert.ok(buttons.length >= 2, `Expected 2+ action buttons, got ${buttons.length}`);
  });

  it('renders completed fetch tool without approval buttons', () => {
    const fixture = loadFixture('fetch-tool.jsonl');
    fireFullState(env.mockSocket, fixture[3].state!);
    const msgs = env.document.getElementById('messages')!;
    const toolEls = msgs.querySelectorAll('.el-tool');
    assert.ok(toolEls.length > 0, 'Should render fetch tool');
    const lastTool = toolEls[toolEls.length - 1];
    const actionRow = lastTool.querySelector('.tool-actions-row');
    assert.ok(!actionRow, 'Completed tool should not have action buttons');
  });
});

// ─── Mode/pick_model pills render ───

describeFx('web: mode/pick_model pills', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  it('renders mode and model from state', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const modeText = env.document.getElementById('pill-mode-text')!;
    const modelText = env.document.getElementById('pill-model-text')!;
    assert.ok(modeText.textContent!.length > 0, 'Mode text should be set');
    assert.ok(modelText.textContent!.length > 0, 'Model text should be set');
  });
});

// ─── Questionnaire widget render ───

describe('web: questionnaire widget', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  function baseState(): CursorState {
    return {
      connected: true,
      extractorStatus: 'ok',
      lastExtractionAt: Date.now(),
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
      mode: { current: 'agent', available: [] },
      model: { current: 'Auto', currentId: '' },
      windows: [],
      activeWindowId: '',
      composerQueue: { items: [] },
      questionnaire: null,
    };
  }

  it('hides questionnaire bar when questionnaire is null', () => {
    fireFullState(env.mockSocket, baseState());
    const bar = env.document.getElementById('questionnaire-bar')!;
    assert.ok(bar.classList.contains('hidden'), 'Questionnaire bar should be hidden');
  });

  it('shows questionnaire bar with questions', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [
        {
          number: '1.', text: 'Pick a color?', isActive: true,
          options: [
            { letter: 'A', label: 'Red', isFreeform: false, selectorPath: 'sp-red' },
            { letter: 'B', label: 'Blue', isFreeform: false, selectorPath: 'sp-blue' },
          ],
        },
      ],
      activeIndex: 0,
      totalLabel: '1 of 1',
      skipSelectorPath: 'sp-skip',
      continueSelectorPath: 'sp-continue',
      continueDisabled: true,
    };
    fireFullState(env.mockSocket, state);
    const bar = env.document.getElementById('questionnaire-bar')!;
    assert.ok(!bar.classList.contains('hidden'), 'Questionnaire bar should be visible');
    const stepper = env.document.getElementById('questionnaire-stepper')!;
    assert.equal(stepper.textContent, '1 of 1');
    const questions = bar.querySelectorAll('.questionnaire-question');
    assert.equal(questions.length, 1);
    const options = bar.querySelectorAll('.questionnaire-option');
    assert.equal(options.length, 2);
    assert.match(options[0].textContent!, /A.*Red/);
    assert.match(options[1].textContent!, /B.*Blue/);
  });

  it('disables continue button when continueDisabled is true', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [{ number: '1.', text: 'Q?', isActive: true, options: [] }],
      activeIndex: 0, totalLabel: '1 of 1',
      skipSelectorPath: 'sp-skip', continueSelectorPath: 'sp-continue',
      continueDisabled: true,
    };
    fireFullState(env.mockSocket, state);
    const btn = env.document.getElementById('btn-q-continue')! as HTMLButtonElement;
    assert.ok(btn.disabled, 'Continue should be disabled');
  });

  it('hides questionnaire bar when questionnaire becomes null via patch', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [{ number: '1.', text: 'Q?', isActive: true, options: [] }],
      activeIndex: 0, totalLabel: '1 of 1',
      skipSelectorPath: '', continueSelectorPath: '',
      continueDisabled: false,
    };
    fireFullState(env.mockSocket, state);
    const bar = env.document.getElementById('questionnaire-bar')!;
    assert.ok(!bar.classList.contains('hidden'), 'Should be visible initially');

    firePatch(env.mockSocket, { questionnaire: null });
    assert.ok(bar.classList.contains('hidden'), 'Should hide after patch with null');
  });

  it('marks active question with active class', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [
        { number: '1.', text: 'Q1?', isActive: false, options: [] },
        { number: '2.', text: 'Q2?', isActive: true, options: [] },
      ],
      activeIndex: 1, totalLabel: '1 of 2',
      skipSelectorPath: '', continueSelectorPath: '',
      continueDisabled: false,
    };
    fireFullState(env.mockSocket, state);
    const questions = env.document.querySelectorAll('.questionnaire-question');
    assert.equal(questions.length, 2);
    assert.ok(!questions[0].classList.contains('questionnaire-question-active'));
    assert.ok(questions[1].classList.contains('questionnaire-question-active'));
  });
});

// ─── Adaptive web client shell ───

describeFx('web: adaptive layout shell', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  it('has chrome and bottom layout wrappers', () => {
    assert.ok(env.document.getElementById('app-chrome'));
    assert.ok(env.document.getElementById('app-bottom'));
    assert.ok(env.document.getElementById('header-menu'));
  });

  it('header status strip renders metric chips', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    fireFullState(env.mockSocket, fixture[0].state!);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(env.document.getElementById('header-status'));
    assert.ok(env.document.querySelector('.status-chip[data-chip="relay"]'));
    assert.ok(env.document.querySelector('.status-chip[data-chip="access"]'));
    assert.match(chipText(env.document, 'access'), /Local ✓/);
    assert.ok(env.document.querySelector('.status-chip[data-chip="mode"]'));
    assert.match(chipText(env.document, 'mode'), /Agent/i);
  });

  it('access chip shows Tailscale on tailscale IP', async () => {
    const tailscaleEnv = await createTestEnv({ hostname: '100.64.1.23' });
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    tailscaleEnv.mockSocket.connected = true;
    tailscaleEnv.mockSocket.fire('connect');
    fireFullState(tailscaleEnv.mockSocket, fixture[0].state!);
    await new Promise((r) => setTimeout(r, 30));
    assert.match(chipText(tailscaleEnv.document, 'access'), /Tailscale ✓/);
  });

  it('access chip shows LAN on private IP', async () => {
    const lanEnv = await createTestEnv({ hostname: '192.168.0.42' });
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    lanEnv.mockSocket.connected = true;
    lanEnv.mockSocket.fire('connect');
    fireFullState(lanEnv.mockSocket, fixture[0].state!);
    await new Promise((r) => setTimeout(r, 30));
    assert.match(chipText(lanEnv.document, 'access'), /LAN ✓/);
  });

  it('access chip shows Cloudflare on trycloudflare host', async () => {
    const cfEnv = await createTestEnv({
      hostname: 'abc.trycloudflare.com',
      webTunnelUrl: 'https://abc.trycloudflare.com',
    });
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    cfEnv.mockSocket.connected = true;
    cfEnv.mockSocket.fire('connect');
    fireFullState(cfEnv.mockSocket, fixture[0].state!);
    await new Promise((r) => setTimeout(r, 30));
    assert.match(chipText(cfEnv.document, 'access'), /Cloudflare ✓/);
  });

  it('header status includes composer queue chip', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    const state = { ...fixture[0].state! };
    state.composerQueue = { items: [{ text: 'hello' }, { text: 'world' }], queueLabel: '2 queued' };
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    fireFullState(env.mockSocket, state);
    await new Promise((r) => setTimeout(r, 30));
    assert.match(chipText(env.document, 'queue'), /queue 2/i);
  });

  it('toggles composer queue collapsed on header click', () => {
    const bar = env.document.getElementById('composer-queue-bar')!;
    const header = bar.querySelector('.composer-queue-header') as HTMLButtonElement;
    bar.classList.remove('hidden');
    assert.ok(header);
    assert.ok(!bar.classList.contains('collapsed'));
    header.click();
    assert.ok(bar.classList.contains('collapsed'));
    header.click();
    assert.ok(!bar.classList.contains('collapsed'));
  });

  it('renders force-send button per queue item', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    const state = { ...fixture[0].state! };
    state.composerQueue = {
      items: [{ id: 'q-1', text: 'first' }, { id: 'q-2', text: 'second' }],
      queueLabel: '2 queued',
    };
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    fireFullState(env.mockSocket, state);
    await new Promise((r) => setTimeout(r, 20));
    const buttons = env.document.querySelectorAll('.composer-queue-force');
    assert.equal(buttons.length, 2);
  });
});

describeFx('web: queue force send', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, {
      ...fixture[0].state!,
      agentStatus: 'idle',
      composerQueue: { items: [{ id: 'q-abc', text: 'probe text' }], queueLabel: '1 queued' },
    });
    env.window.confirm = () => true;
    await new Promise((r) => setTimeout(r, 20));
  });

  it('emits force_queue_item on arrow click', async () => {
    await new Promise((r) => setTimeout(r, 20));
    const btn = env.document.querySelector('.composer-queue-force') as HTMLButtonElement;
    assert.ok(btn);
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    const sent = env.mockSocket.emitted.filter((e) => e.event === 'command:force_queue_item');
    assert.equal(sent.length, 1);
    assert.equal((sent[0].args[0] as { queueItemId: string }).queueItemId, 'q-abc');
    env.mockSocket.fire('command:result', {
      commandId: (sent[0].args[0] as { commandId: string }).commandId,
      ok: true,
    });
    await new Promise((r) => setTimeout(r, 0));
    const toast = env.document.querySelector('.toast');
    assert.match(toast?.textContent ?? '', /forced/i);
  });
});

// ─── Window switcher ───

describeFx('web: window select', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
  });

  it('hides window select when only one window', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    await new Promise((r) => setTimeout(r, 20));
    const wrap = env.document.getElementById('window-select-wrap')!;
    assert.ok(wrap.classList.contains('hidden'));
  });

  it('renders window options in header select', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    const state = { ...fixture[0].state! };
    state.windows = [
      { id: 'w1', title: 'Project A', url: '' },
      { id: 'w2', title: 'Project B', url: '' },
    ];
    state.activeWindowId = 'w1';
    fireFullState(env.mockSocket, state);
    await new Promise((r) => setTimeout(r, 20));
    const wrap = env.document.getElementById('window-select-wrap')!;
    const label = env.document.getElementById('window-select-label')!;
    const btn = env.document.getElementById('window-select-btn') as HTMLButtonElement;
    assert.ok(!wrap.classList.contains('hidden'));
    assert.equal(label.textContent, 'Project A');
    btn.click();
    const items = env.document.querySelectorAll('#sheet-window-list .sheet-item');
    assert.equal(items.length, 2);
    assert.match(items[0].textContent!, /Project A/);
    assert.match(items[1].textContent!, /Project B/);
  });
});

// ─── Header menu ───

describeFx('web: header menu', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
  });

  it('renders header menu actions', () => {
    const panel = env.document.getElementById('header-menu-panel')!;
    const items = panel.querySelectorAll('.header-menu-item');
    assert.equal(items.length, 4);
    assert.ok([...items].some((el) => /Refresh state/i.test(el.textContent!)));
    assert.ok([...items].some((el) => /Reload page/i.test(el.textContent!)));
    assert.ok([...items].some((el) => /composerId/i.test(el.textContent!)));
    assert.ok([...items].some((el) => /\/health/i.test(el.textContent!)));
  });

  it('emits refresh_state from header menu', () => {
    const btn = env.document.getElementById('header-menu-btn') as HTMLButtonElement;
    const refresh = env.document.querySelector('[data-action="refresh"]') as HTMLButtonElement;
    btn.click();
    refresh.click();
    const hit = env.mockSocket.emitted.find((e) => e.event === 'command:refresh_state');
    assert.ok(hit);
    assert.ok((hit!.args[0] as { commandId?: string }).commandId);
  });

  it('copies active composerId from header menu', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    const state = { ...fixture[0].state! };
    state.chatTabs = [
      {
        title: 'Chat A',
        isActive: true,
        composerId: 'composer-abc-123',
        selectorPath: 'sp-a',
        status: '',
      },
    ];
    fireFullState(env.mockSocket, state);

    const btn = env.document.getElementById('header-menu-btn') as HTMLButtonElement;
    const copyBtn = env.document.querySelector('[data-action="copy-composer"]') as HTMLButtonElement;
    btn.click();
    assert.equal(copyBtn.disabled, false);
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal((env.window as any).__clipboardText, 'composer-abc-123');
  });
});

// ─── Tab management ───

function tabsState(count: number, activeIndex = 0): CursorState {
  const chatTabs = Array.from({ length: count }, (_, i) => ({
    composerId: `composer-${i}`,
    title: `Chat ${i + 1}`,
    isActive: i === activeIndex,
    status: '',
    selectorPath: `sp-${i}`,
  }));
  return {
    connected: true,
    extractorStatus: 'ok',
    lastExtractionAt: Date.now(),
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    messages: [],
    pendingApprovals: [],
    inputAvailable: true,
    chatTabs,
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: 'w0',
    composerQueue: { items: [] },
    questionnaire: null,
  };
}

describe('web: tab management', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    (env.window as any).__setConfirm(true);
  });

  it('asks before closing a tab', () => {
    fireFullState(env.mockSocket, tabsState(2, 0));
    (env.window as any).__setConfirm(false);
    const closeBtn = env.document.querySelector('.tab-item-close') as HTMLButtonElement;
    closeBtn.click();
    assert.equal(env.mockSocket.emitted.filter((e) => e.event === 'command:close_chat').length, 0);

    (env.window as any).__setConfirm(true);
    closeBtn.click();
    assert.equal(env.mockSocket.emitted.filter((e) => e.event === 'command:close_chat').length, 1);
  });

  it('shows close-others when multiple tabs', () => {
    fireFullState(env.mockSocket, tabsState(3, 1));
    const btn = env.document.getElementById('btn-tab-close-others')!;
    assert.ok(!btn.classList.contains('hidden'));
  });

  it('closes other tabs after confirm', () => {
    fireFullState(env.mockSocket, tabsState(3, 1));
    const btn = env.document.getElementById('btn-tab-close-others') as HTMLButtonElement;
    btn.click();
    assert.equal(env.mockSocket.emitted.filter((e) => e.event === 'command:close_chat').length, 2);
  });

  it('shows all-tabs menu when list overflows', () => {
    fireFullState(env.mockSocket, tabsState(4, 0));
    const list = env.document.getElementById('tab-list')!;
    Object.defineProperty(list, 'scrollWidth', { value: 800, configurable: true });
    Object.defineProperty(list, 'clientWidth', { value: 120, configurable: true });
    firePatch(env.mockSocket, {});

    const allBtn = env.document.getElementById('btn-tab-all')!;
    assert.ok(!allBtn.classList.contains('hidden'));

    allBtn.click();
    const panel = env.document.getElementById('tab-all-panel')!;
    assert.ok(!panel.classList.contains('hidden'));
    assert.equal(panel.querySelectorAll('.tab-all-item').length, 4);
  });
});

// ─── Force send ($) ───

async function ackLastSend(
  mockSocket: MockSocket,
  opts: { ok?: boolean; error?: string } = {},
) {
  const sent = mockSocket.emitted.filter((e) => e.event === 'command:send_message');
  const last = sent.at(-1);
  assert.ok(last);
  mockSocket.fire('command:result', {
    commandId: (last!.args[0] as { commandId: string }).commandId,
    ok: opts.ok !== false,
    error: opts.error,
  });
  await new Promise((r) => setTimeout(r, 0));
}

describeFx('web: force send', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, { ...fixture[0].state!, inputAvailable: true, connected: true });
    await new Promise((r) => setTimeout(r, 20));
  });

  it('emits ctrlEnter when message starts with $', async () => {
    const input = env.document.getElementById('message-input') as HTMLTextAreaElement;
    const btn = env.document.getElementById('btn-send') as HTMLButtonElement;
    input.value = '$ стоп';
    input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    btn.click();
    await ackLastSend(env.mockSocket);

    const sent = env.mockSocket.emitted.filter((e) => e.event === 'command:send_message');
    assert.equal(sent.length, 1);
    assert.equal((sent[0].args[0] as { text: string }).text, 'стоп');
    assert.equal((sent[0].args[0] as { submit: string }).submit, 'ctrlEnter');
    const toast = env.document.querySelector('.toast');
    assert.match(toast?.textContent ?? '', /forced/i);
  });

  it('emits enter for plain text', async () => {
    const input = env.document.getElementById('message-input') as HTMLTextAreaElement;
    const btn = env.document.getElementById('btn-send') as HTMLButtonElement;
    input.value = 'обычный текст';
    input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    btn.click();
    await ackLastSend(env.mockSocket);

    const sent = env.mockSocket.emitted.filter((e) => e.event === 'command:send_message');
    assert.equal(sent.length, 1);
    assert.equal((sent[0].args[0] as { text: string }).text, 'обычный текст');
    assert.equal((sent[0].args[0] as { submit?: string }).submit, 'enter');
  });

  it('rejects empty message after $', () => {
    const input = env.document.getElementById('message-input') as HTMLTextAreaElement;
    const btn = env.document.getElementById('btn-send') as HTMLButtonElement;
    input.value = '$   ';
    input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    btn.click();

    assert.equal(env.mockSocket.emitted.filter((e) => e.event === 'command:send_message').length, 0);
    const toast = env.document.querySelector('.toast');
    assert.match(toast?.textContent ?? '', /Text required after \$/i);
  });
});

describeFx('web: prompt history', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, { ...fixture[0].state!, inputAvailable: true, connected: true });
    await new Promise((r) => setTimeout(r, 20));
  });

  it('stores up to three prompts and inserts on chip click', async () => {
    const input = env.document.getElementById('message-input') as HTMLTextAreaElement;
    const sendBtn = env.document.getElementById('btn-send') as HTMLButtonElement;
    const values = ['один', 'два', 'три', 'четыре'];

    for (const text of values) {
      input.value = text;
      input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
      sendBtn.click();
      await ackLastSend(env.mockSocket);
    }

    const chips = env.document.querySelectorAll('.prompt-history-item');
    assert.equal(chips.length, 3);
    assert.match(chips[0].textContent ?? '', /четыре/i);
    assert.match(chips[2].textContent ?? '', /два/i);

    (chips[1] as HTMLButtonElement).click();
    assert.equal(input.value, 'три');
  });

  it('repeats latest prompt immediately', async () => {
    const input = env.document.getElementById('message-input') as HTMLTextAreaElement;
    const sendBtn = env.document.getElementById('btn-send') as HTMLButtonElement;
    input.value = 'повтори меня';
    input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    sendBtn.click();
    await ackLastSend(env.mockSocket);

    const repeat = env.document.getElementById('btn-repeat-last') as HTMLButtonElement;
    repeat.click();
    await ackLastSend(env.mockSocket);

    const sent = env.mockSocket.emitted.filter((e) => e.event === 'command:send_message');
    assert.equal(sent.length, 2);
    assert.equal((sent[1].args[0] as { text: string }).text, 'повтори меня');
    assert.equal((sent[1].args[0] as { submit: string }).submit, 'enter');
  });
});

describeFx('web: quick phrases', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, { ...fixture[0].state!, inputAvailable: true, connected: true });
    await new Promise((r) => setTimeout(r, 20));
  });

  it('hides bar when no phrases configured', () => {
    const bar = env.document.getElementById('quick-phrases-bar')!;
    assert.ok(bar.classList.contains('hidden'));
  });

  it('shows chips from settings and inserts on tap', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    const textarea = env.document.getElementById('setting-quick-phrases') as HTMLTextAreaElement;
    textarea.value = 'продолжай\nстатус?';
    textarea.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const bar = env.document.getElementById('quick-phrases-bar')!;
    assert.ok(!bar.classList.contains('hidden'));
    const chips = env.document.querySelectorAll('.quick-phrase-item');
    assert.equal(chips.length, 2);
    assert.match(chips[0].textContent ?? '', /продолжай/i);

    const input = env.document.getElementById('message-input') as HTMLTextAreaElement;
    (chips[1] as HTMLButtonElement).click();
    assert.equal(input.value, 'статус?');
  });

  it('allows newline while editing quick phrases', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    const textarea = env.document.getElementById('setting-quick-phrases') as HTMLTextAreaElement;
    textarea.value = 'первая\n';
    textarea.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(textarea.value, 'первая\n');
  });

  it('keeps at most six phrases', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    const textarea = env.document.getElementById('setting-quick-phrases') as HTMLTextAreaElement;
    textarea.value = '1\n2\n3\n4\n5\n6\n7';
    textarea.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(env.document.querySelectorAll('.quick-phrase-item').length, 6);
    assert.equal(textarea.value.split('\n').length, 7);
    const closeBtn = env.document.getElementById('settings-close') as HTMLButtonElement;
    closeBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(textarea.value.split('\n').length, 6);
  });
});

describe('web: send sound setting', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
  });

  it('send sound is off by default', () => {
    const checkbox = env.document.getElementById('setting-send-sound') as HTMLInputElement;
    assert.ok(checkbox);
    assert.equal(checkbox.checked, false);
  });

  it('persists send sound toggle', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    const checkbox = env.document.getElementById('setting-send-sound') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    const raw = env.window.localStorage.getItem('cursor-handoff-web-settings');
    assert.ok(raw);
    assert.match(raw!, /"sendSound":true/);
  });
});

describe('web: diagnostics and logout', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
  });

  it('shows diagnostics block when settings open', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    const panel = env.document.getElementById('settings-diagnostics')!;
    assert.match(panel.textContent ?? '', /Server: 1\.0\.0/);
    assert.match(panel.textContent ?? '', /Access:/);
  });

  it('copies diagnostics to clipboard', async () => {
    const settingsBtn = env.document.getElementById('header-settings-btn') as HTMLButtonElement;
    settingsBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    const copyBtn = env.document.getElementById('btn-copy-diagnostics') as HTMLButtonElement;
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    const text = (env.window as any).__clipboardText as string;
    assert.match(text, /CursorHandoff — diagnostics/);
    assert.match(text, /Server: 1\.0\.0/);
  });

  it('logout clears session token', async () => {
    env.window.localStorage.setItem('cursor-handoff-token', 'abc');
    const logoutBtn = env.document.getElementById('btn-logout') as HTMLButtonElement;
    logoutBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(env.window.localStorage.getItem('cursor-handoff-token'), null);
  });
});

describe('web: onboarding', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv({
      hostname: 'handoff-test.trycloudflare.com',
      webTunnelUrl: 'https://handoff-test.trycloudflare.com',
    });
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    await new Promise((r) => setTimeout(r, 30));
  });

  it('shows onboarding on first tunnel visit', () => {
    const overlay = env.document.getElementById('onboarding-overlay')!;
    assert.ok(!overlay.classList.contains('hidden'));
    assert.match(env.document.getElementById('onboarding-title')!.textContent ?? '', /Tabs/);
  });

  it('does not show onboarding on localhost', async () => {
    const local = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    local.mockSocket.connected = true;
    local.mockSocket.fire('connect');
    await new Promise((r) => setTimeout(r, 30));
    const overlay = local.document.getElementById('onboarding-overlay')!;
    assert.ok(overlay.classList.contains('hidden'));
  });

  it('skip marks onboarding done', async () => {
    const skipBtn = env.document.getElementById('onboarding-skip') as HTMLButtonElement;
    skipBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    const overlay = env.document.getElementById('onboarding-overlay')!;
    assert.ok(overlay.classList.contains('hidden'));
    const raw = env.window.localStorage.getItem('cursor-handoff-web-settings');
    assert.ok(raw);
    assert.match(raw!, /"onboardingDone":true/);
  });

  it('next navigates slides and done completes', async () => {
    const nextBtn = env.document.getElementById('onboarding-next') as HTMLButtonElement;
    nextBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.match(env.document.getElementById('onboarding-title')!.textContent ?? '', /Send/);
    nextBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    nextBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(nextBtn.textContent, 'Done');
    nextBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(env.document.getElementById('onboarding-overlay')!.classList.contains('hidden'));
  });
});

// ─── Failed send retry ───

describeFx('web: failed send retry', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, { ...fixture[0].state!, inputAvailable: true, connected: true });
    await new Promise((r) => setTimeout(r, 20));
  });

  it('shows retry bubble when send fails', async () => {
    const input = env.document.getElementById('message-input') as HTMLTextAreaElement;
    const btn = env.document.getElementById('btn-send') as HTMLButtonElement;
    input.value = 'не ушло';
    input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    btn.click();
    await ackLastSend(env.mockSocket, { ok: false, error: 'Chat input not found' });

    const bubble = env.document.querySelector('.el-failed-send');
    assert.ok(bubble);
    assert.match(bubble!.textContent ?? '', /не ушло/);
    assert.match(bubble!.textContent ?? '', /Chat input not found/);
    assert.ok(env.document.querySelector('.btn-send-retry'));
  });

  it('retries with same payload after failure', async () => {
    const input = env.document.getElementById('message-input') as HTMLTextAreaElement;
    const btn = env.document.getElementById('btn-send') as HTMLButtonElement;
    input.value = '$ retry me';
    input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    btn.click();
    await ackLastSend(env.mockSocket, { ok: false, error: 'fail' });

    const retryBtn = env.document.querySelector('.btn-send-retry') as HTMLButtonElement;
    retryBtn.click();
    await ackLastSend(env.mockSocket, { ok: true });

    assert.equal(env.document.querySelectorAll('.el-failed-send').length, 0);
    const sent = env.mockSocket.emitted.filter((e) => e.event === 'command:send_message');
    assert.equal(sent.length, 2);
    assert.equal((sent[1].args[0] as { text: string }).text, 'retry me');
    assert.equal((sent[1].args[0] as { submit: string }).submit, 'ctrlEnter');
  });
});

// ─── Photo upload ───

describeFx('web: photo upload', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 0));
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    const state = { ...fixture[0].state!, inputAvailable: true, connected: true };
    fireFullState(env.mockSocket, state);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('has attach control for files', () => {
    const btn = env.document.getElementById('btn-attach');
    const input = env.document.getElementById('photo-file-input') as HTMLInputElement;
    assert.ok(btn);
    assert.ok(input);
    assert.equal(input.accept, '');
    assert.ok(input.multiple);
  });

  it('shows preview and emits images on send', async () => {
    const originalReader = env.window.FileReader;
    class MockFileReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        this.onload?.();
      }
      get result() {
        return 'data:image/jpeg;base64,YWJj';
      }
    }
    env.window.FileReader = MockFileReader as unknown as typeof FileReader;

    const file = new env.window.File(['abc'], 'shot.jpg', { type: 'image/jpeg' });
    const photoInput = env.document.getElementById('photo-file-input') as HTMLInputElement;
    Object.defineProperty(photoInput, 'files', { value: [file], configurable: true });
    photoInput.dispatchEvent(new env.window.Event('change', { bubbles: true }));

    assert.ok(!env.document.getElementById('photo-compose-bar')!.classList.contains('hidden'));
    assert.equal(env.document.querySelectorAll('.photo-compose-item').length, 1);

    const sendBtn = env.document.getElementById('btn-send') as HTMLButtonElement;
    assert.equal(sendBtn.disabled, false);
    sendBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    await ackLastSend(env.mockSocket);

    const sent = env.mockSocket.emitted.filter((e) => e.event === 'command:send_message');
    const payload = sent.at(-1)!.args[0] as { images?: { mime: string; data: string }[] };
    assert.equal(payload.images?.length, 1);
    assert.equal(payload.images?.[0]?.mime, 'image/jpeg');
    assert.equal(payload.images?.[0]?.data, 'YWJj');

    env.window.FileReader = originalReader;
  });
});

// ─── Telegram topic link ───

describe('web: telegram topic link', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv({ telegramTopicUrl: null });
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
  });

  it('hides TG button when no mapping', async () => {
    fireFullState(env.mockSocket, tabsState(1, 0));
    await new Promise((r) => setTimeout(r, 20));
    const btn = env.document.getElementById('btn-open-telegram')!;
    assert.ok(btn.classList.contains('hidden'));
  });

  it('shows TG button with deep link when mapping exists', async () => {
    (env.window as any).__setTelegramTopicUrl('https://t.me/c/1234567890/42');
    fireFullState(env.mockSocket, tabsState(1, 0));
    await new Promise((r) => setTimeout(r, 50));
    const btn = env.document.getElementById('btn-open-telegram') as HTMLAnchorElement;
    assert.ok(!btn.classList.contains('hidden'));
    assert.equal(btn.href, 'https://t.me/c/1234567890/42');
    assert.equal(btn.target, '_blank');
  });
});

// ─── Relay offline / reconnect ───

describe('web: relay offline UI', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  it('shows offline banner after socket disconnect', (t) => {
    if (!hasLocalFixtures) return t.skip();
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    fireFullState(env.mockSocket, fixture[0].state!);

    env.mockSocket.connected = false;
    env.mockSocket.fire('disconnect');

    const banner = env.document.getElementById('offline-banner')!;
    assert.ok(banner);
    assert.ok(!banner.classList.contains('hidden'));
    const primary = env.document.getElementById('empty-state-primary')!;
    assert.match(primary.textContent!, /No connection to CursorHandoff/i);
  });

  it('shows reconnect toast after socket comes back', () => {
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');

    env.mockSocket.connected = false;
    env.mockSocket.fire('disconnect');

    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');

    const toast = env.document.querySelector('.toast');
    assert.ok(toast, 'Expected reconnect toast');
    assert.match(toast!.textContent!, /Connected again/i);
  });

  it('keeps chat messages visible while offline', (t) => {
    if (!hasLocalFixtures) return t.skip();
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    env.mockSocket.connected = true;
    env.mockSocket.fire('connect');
    fireFullState(env.mockSocket, fixture[1].state!);
    assert.ok(env.document.querySelectorAll('.chat-el').length > 0);

    env.mockSocket.connected = false;
    env.mockSocket.fire('disconnect');

    assert.ok(env.document.querySelectorAll('.chat-el').length > 0);
    const banner = env.document.getElementById('offline-banner')!;
    assert.ok(!banner.classList.contains('hidden'));
  });
});

// ─── Quick tunnel wait ───

describe('web: tunnel wait overlay', () => {
  it('hides tunnel wait overlay on localhost', async () => {
    const env = await createTestEnv();
    await new Promise((r) => setTimeout(r, 20));
    const overlay = env.document.getElementById('tunnel-wait-overlay')!;
    assert.ok(overlay.classList.contains('hidden'));
  });

  it('shows tunnel wait overlay when webTunnelUrl missing on trycloudflare', async () => {
    const env = await createTestEnv({ hostname: 'abc.trycloudflare.com', webTunnelUrl: null });
    await new Promise((r) => setTimeout(r, 50));
    const overlay = env.document.getElementById('tunnel-wait-overlay')!;
    assert.ok(!overlay.classList.contains('hidden'));
    assert.match(overlay.textContent!, /Starting cloudflared/i);
    assert.match(overlay.textContent!, /\/web_url/i);
  });

  it('skips tunnel wait overlay when webTunnelUrl already ready', async () => {
    const env = await createTestEnv({
      hostname: 'abc.trycloudflare.com',
      webTunnelUrl: 'https://abc.trycloudflare.com',
    });
    await new Promise((r) => setTimeout(r, 30));
    const overlay = env.document.getElementById('tunnel-wait-overlay')!;
    assert.ok(overlay.classList.contains('hidden'));
    assert.ok(env.document.getElementById('header-status'));
  });
});
