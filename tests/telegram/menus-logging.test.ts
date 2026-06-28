import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGeneralChat, setupGeneralMenuButton } from '../../src/telegram/ui/menus.js';
import type { TelegramApiClient } from '../../src/telegram/types.js';

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

function makeApi(overrides: Partial<TelegramApiClient> = {}): TelegramApiClient {
  return {
    sendMessage: async () => ({ message_id: 1 }),
    setChatMenuButton: async () => {},
    ...overrides,
  } as TelegramApiClient;
}

describe('menus', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-menus-'));
    process.env.CURSOR_HANDOFF_DATA_DIR = dataDir;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.CURSOR_HANDOFF_DATA_DIR;
  });

  it('isGeneralChat is true without message_thread_id in a forum supergroup', () => {
    assert.equal(isGeneralChat({ chat: { is_forum: true } }), true);
    assert.equal(isGeneralChat({ message: { message_thread_id: 42 }, chat: { is_forum: true } }), false);
  });

  it('setupGeneralMenuButton sets native commands menu', async () => {
    let menuType: string | undefined;
    await setupGeneralMenuButton(makeApi({
      setChatMenuButton: async (btn) => { menuType = btn.type; },
    }));
    assert.equal(menuType, 'commands');
  });

  it('logs TG_MENU_BUTTON_FAIL when setChatMenuButton throws', async () => {
    const lines = await captureAll(async () => {
      await setupGeneralMenuButton(makeApi({
        setChatMenuButton: async () => { throw new Error('menu denied'); },
      }));
    });
    assert.ok(lines.some((l) => l.includes('TG_MENU_BUTTON_FAIL') && l.includes('menu denied')));
  });
});

describe('shared slash parsing', () => {
  it('parseLeadingSlashCommand extracts command name', async () => {
    const { parseLeadingSlashCommand, THREAD_CHAT_COMMANDS } = await import('../../src/telegram/commands/shared.js');
    assert.equal(parseLeadingSlashCommand('/close_chat@Bot'), 'close_chat');
    assert.equal(parseLeadingSlashCommand('  /new_chat extra'), 'new_chat');
    assert.equal(parseLeadingSlashCommand('hello'), undefined);
    assert.ok(THREAD_CHAT_COMMANDS.has('thread_status'));
    assert.ok(!THREAD_CHAT_COMMANDS.has('bridge'));
  });
});
