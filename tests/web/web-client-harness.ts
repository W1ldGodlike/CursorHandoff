import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, readdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import * as esbuild from 'esbuild';
import type { CursorState } from '../../src/core/types.js';

/** JSDOM + client app timers keep the process alive unless every window is closed at suite end. */
export const openDoms: JSDOM[] = [];

after(() => {
  while (openDoms.length > 0) {
    const dom = openDoms.pop();
    const w = dom?.window as Window & { __handoffStopTimers?: () => void };
    w?.__handoffStopTimers?.();
    dom?.window.close();
  }
});

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML_PATH = join(REPO_ROOT, 'src/client/index.html');
const I18N_JS_PATH = join(REPO_ROOT, 'src/client/i18n.js');
const CLIENT_ENTRY = join(REPO_ROOT, 'src/client/js/app.js');
const CSS_PATH = join(REPO_ROOT, 'src/client/styles/main.css');

const CLIENT_JS_DIR = join(REPO_ROOT, 'src/client/js');

function getClientSourceMtime(): number {
  return readdirSync(CLIENT_JS_DIR)
    .filter((f) => f.endsWith('.js'))
    .reduce((max, f) => Math.max(max, statSync(join(CLIENT_JS_DIR, f)).mtimeMs), 0);
}

let clientAppBundle: string | null = null;
let clientAppBundleMtime = 0;

/** Bundled IIFE for JSDOM (ES module graph → single script). */
function getClientAppBundle(): string {
  const mtime = getClientSourceMtime();
  if (!clientAppBundle || mtime !== clientAppBundleMtime) {
    const result = esbuild.buildSync({
      entryPoints: [CLIENT_ENTRY],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      write: false,
    });
    clientAppBundle = result.outputFiles![0].text;
    clientAppBundleMtime = mtime;
  }
  return clientAppBundle;
}

type EventHandler = (...args: unknown[]) => void;

export interface MockSocket {
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

export async function createTestEnv(opts?: {
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
          if (
            event === 'command:questionnaire_freeform'
            || event === 'command:questionnaire_click'
          ) {
            const payload = args[0] as { commandId?: string } | undefined;
            if (payload?.commandId) {
              queueMicrotask(() => {
                this.fire('command:result', { commandId: payload.commandId, ok: true });
              });
            }
          }
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

export function fireFullState(mockSocket: MockSocket, state: CursorState) {
  mockSocket.fire('state:full', state);
}

export function firePatch(mockSocket: MockSocket, patch: Partial<CursorState>) {
  mockSocket.fire('state:patch', patch);
}

export async function ackLastSend(
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

export function chipText(doc: Document, id: string): string {
  const el = doc.querySelector(`.status-chip[data-chip="${id}"]`);
  return el?.textContent ?? '';
}

