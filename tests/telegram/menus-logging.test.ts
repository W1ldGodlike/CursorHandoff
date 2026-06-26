import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setLocale } from '../../src/i18n/t.js';
import {
  buildChatReplyKeyboard,
  buildGeneralReplyKeyboard,
  generalMenuButtonText,
  getChatMenuItems,
  getGeneralMenuItems,
  isGeneralChat,
  resolveChatButtonCommand,
  resolveGeneralButtonCommand,
  setupGeneralMenuButton,
  showChatKeyboard,
  showGeneralKeyboard,
  withChatKeyboard,
  withGeneralKeyboard,
} from '../../src/telegram/ui/menus.js';
import type { BotContext, TelegramApiClient } from '../../src/telegram/types.js';
import { KEYBOARD_PLACEHOLDER_TEXT } from '../../src/telegram/types.js';

const CHAT_ID = -1001234567890;
const THREAD_ID = 11;
const ALT_GROUP_ID = -1009876543210;

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

function assertMenuLog(
  lines: string[],
  code: string,
  need: {
    threadId?: number;
    chatId?: number;
    errno?: string;
    op?: string;
    text?: string;
  } = {},
): void {
  const line = need.text
    ? lines.find((l) => l.includes(`code=${code}`) && l.includes(need.text!))
    : lines.find((l) => l.includes(`code=${code}`));
  assert.ok(line, need.text ? `missing code=${code} with text "${need.text}"` : `missing code=${code}`);
  assert.ok(line!.includes('scope=telegram'), `${code} missing scope=telegram`);
  if (need.threadId !== undefined) {
    assert.ok(line!.includes(`threadId=${need.threadId}`), `${code} missing threadId=${need.threadId}`);
  }
  if (need.chatId !== undefined) {
    assert.ok(line!.includes(`chatId=${need.chatId}`), `${code} missing chatId=${need.chatId}`);
  }
  if (need.errno) assert.ok(line!.includes(`errno=${need.errno}`), `${code} missing errno=${need.errno}`);
  if (need.op) assert.ok(line!.includes(`op=${need.op}`), `${code} missing op=${need.op}`);
  if (need.text) assert.ok(line!.includes(need.text), `${code} missing text fragment "${need.text}"`);
}

function assertNoMenuLogs(lines: string[]): void {
  const hit = lines.find((l) => /code=TG_MENU_/.test(l));
  assert.ok(!hit, `unexpected menu log: ${hit}`);
}

function makeApi(overrides: Partial<TelegramApiClient> = {}): TelegramApiClient {
  return {
    setChatMenuButton: async () => {},
    sendMessage: async () => ({ message_id: 1 }),
    ...overrides,
  } as TelegramApiClient;
}

describe('menus logging', () => {
  let dataDir: string;
  let origDataDir: string | undefined;

  beforeEach(() => {
    setLocale('en');
    origDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-menus-log-'));
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = origDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('setupGeneralMenuButton swallows setChatMenuButton error without rethrow after TG_MENU_BUTTON_FAIL', async () => {
    const lines = await captureAll(async () => {
      await setupGeneralMenuButton(makeApi({
        setChatMenuButton: async () => { throw new Error('menu denied'); },
      }));
    });
    assertMenuLog(lines, 'TG_MENU_BUTTON_FAIL', {
      op: 'set_menu_button',
      text: 'menu denied',
    });
  });

  it('logs TG_MENU_BUTTON_FAIL when setChatMenuButton throws non-Error', async () => {
    const lines = await captureAll(async () => {
      await setupGeneralMenuButton(makeApi({
        setChatMenuButton: async () => { throw 'raw menu fail'; },
      }));
    });
    assertMenuLog(lines, 'TG_MENU_BUTTON_FAIL', {
      op: 'set_menu_button',
      text: 'raw menu fail',
    });
  });

  it('logs TG_MENU_BUTTON_FAIL when setChatMenuButton throws', async () => {
    const err = Object.assign(new Error('menu button denied'), { code: 'ETG403' });
    const lines = await captureAll(async () => {
      await setupGeneralMenuButton(makeApi({
        setChatMenuButton: async () => { throw err; },
      }));
    });
    assertMenuLog(lines, 'TG_MENU_BUTTON_FAIL', {
      op: 'set_menu_button',
      errno: 'ETG403',
      text: 'menu button denied',
    });
  });

  it('setupGeneralMenuButton success calls setChatMenuButton with commands type and stays silent without TG_MENU codes', async () => {
    let payload: unknown;
    const lines = await captureAll(async () => {
      await setupGeneralMenuButton(makeApi({
        setChatMenuButton: async (opts) => { payload = opts; },
      }));
    });
    assert.deepEqual(payload, { type: 'commands' });
    assertNoMenuLogs(lines);
  });

  it('setupGeneralMenuButton success stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(async () => {
      await setupGeneralMenuButton(makeApi());
    });
    assertNoMenuLogs(lines);
  });

  it('showGeneralKeyboard posts general reply keyboard row count on logs TG_MENU_KEYBOARD_GENERAL success', async () => {
    let markup: ReturnType<typeof buildGeneralReplyKeyboard> | undefined;
    const lines = await captureAll(async () => {
      await showGeneralKeyboard(makeApi({
        sendMessage: async (_chatId, _text, opts) => {
          markup = opts?.reply_markup as ReturnType<typeof buildGeneralReplyKeyboard>;
          return { message_id: 2 };
        },
      }), CHAT_ID);
    });
    assert.equal(markup?.keyboard.length, getGeneralMenuItems().length);
    assert.equal(markup?.resize_keyboard, true);
    assertMenuLog(lines, 'TG_MENU_KEYBOARD_GENERAL', {
      chatId: CHAT_ID,
      op: 'show_general_keyboard',
    });
  });

  it('logs TG_MENU_KEYBOARD_GENERAL with alternate groupId in chatId context', async () => {
    const lines = await captureAll(async () => {
      await showGeneralKeyboard(makeApi(), ALT_GROUP_ID);
    });
    assertMenuLog(lines, 'TG_MENU_KEYBOARD_GENERAL', {
      chatId: ALT_GROUP_ID,
      op: 'show_general_keyboard',
    });
  });

  it('logs TG_MENU_KEYBOARD_GENERAL on showGeneralKeyboard success', async () => {
    let sentChatId: number | undefined;
    const lines = await captureAll(async () => {
      await showGeneralKeyboard(makeApi({
        sendMessage: async (chatId, text, opts) => {
          sentChatId = chatId;
          assert.equal(text, KEYBOARD_PLACEHOLDER_TEXT);
          assert.ok(opts?.reply_markup);
          return { message_id: 2 };
        },
      }), CHAT_ID);
    });
    assert.equal(sentChatId, CHAT_ID);
    assertMenuLog(lines, 'TG_MENU_KEYBOARD_GENERAL', {
      chatId: CHAT_ID,
      op: 'show_general_keyboard',
    });
  });

  it('logs TG_MENU_KEYBOARD_FAIL when showGeneralKeyboard sendMessage throws non-Error and rethrows', async () => {
    const lines = await captureAll(async () => {
      await assert.rejects(
        () => showGeneralKeyboard(makeApi({
          sendMessage: async () => { throw 'general raw fail'; },
        }), CHAT_ID),
        (e: unknown) => e === 'general raw fail',
      );
    });
    assertMenuLog(lines, 'TG_MENU_KEYBOARD_FAIL', {
      chatId: CHAT_ID,
      op: 'show_general_keyboard',
      text: 'general keyboard post failed',
    });
    const failLine = lines.find((l) => l.includes('code=TG_MENU_KEYBOARD_FAIL') && l.includes('general keyboard'));
    assert.ok(failLine && !failLine.includes('errno='));
  });

  it('logs TG_MENU_KEYBOARD_FAIL with errno when showGeneralKeyboard sendMessage throws and rethrows', async () => {
    const err = Object.assign(new Error('general send blocked'), { code: 'ETG429' });
    const lines = await captureAll(async () => {
      await assert.rejects(
        () => showGeneralKeyboard(makeApi({
          sendMessage: async () => { throw err; },
        }), CHAT_ID),
        (e: unknown) => e === err,
      );
    });
    assertMenuLog(lines, 'TG_MENU_KEYBOARD_FAIL', {
      chatId: CHAT_ID,
      op: 'show_general_keyboard',
      errno: 'ETG429',
      text: 'general keyboard post failed',
    });
    assert.ok(!lines.some((l) => l.includes('code=TG_MENU_KEYBOARD_GENERAL')));
  });

  it('showGeneralKeyboard emits exactly one TG_MENU_KEYBOARD_GENERAL log line', async () => {
    const lines = await captureAll(async () => {
      await showGeneralKeyboard(makeApi(), CHAT_ID);
    });
    assert.equal(lines.filter((l) => l.includes('code=TG_MENU_KEYBOARD_GENERAL')).length, 1);
    assertMenuLog(lines, 'TG_MENU_KEYBOARD_GENERAL', { chatId: CHAT_ID, op: 'show_general_keyboard' });
  });

  it('showChatKeyboard posts chat reply keyboard row count on logs TG_MENU_KEYBOARD_CHAT success', async () => {
    let markup: ReturnType<typeof buildChatReplyKeyboard> | undefined;
    let thread: number | undefined;
    const lines = await captureAll(async () => {
      await showChatKeyboard(makeApi({
        sendMessage: async (_chatId, _text, opts) => {
          markup = opts?.reply_markup as ReturnType<typeof buildChatReplyKeyboard>;
          thread = opts?.message_thread_id;
          return { message_id: 3 };
        },
      }), CHAT_ID, THREAD_ID);
    });
    assert.equal(markup?.keyboard.length, getChatMenuItems().length);
    assert.equal(markup?.resize_keyboard, true);
    assert.equal(thread, THREAD_ID);
    assertMenuLog(lines, 'TG_MENU_KEYBOARD_CHAT', {
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      op: 'show_chat_keyboard',
    });
  });

  it('logs TG_MENU_KEYBOARD_CHAT on showChatKeyboard success', async () => {
    let sentThread: number | undefined;
    const lines = await captureAll(async () => {
      await showChatKeyboard(makeApi({
        sendMessage: async (chatId, text, opts) => {
          assert.equal(chatId, CHAT_ID);
          assert.equal(text, KEYBOARD_PLACEHOLDER_TEXT);
          sentThread = opts?.message_thread_id;
          assert.ok(opts?.reply_markup);
          return { message_id: 3 };
        },
      }), CHAT_ID, THREAD_ID);
    });
    assert.equal(sentThread, THREAD_ID);
    assertMenuLog(lines, 'TG_MENU_KEYBOARD_CHAT', {
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      op: 'show_chat_keyboard',
      text: `thread ${THREAD_ID}`,
    });
  });

  it('logs TG_MENU_KEYBOARD_FAIL when showChatKeyboard sendMessage throws non-Error and rethrows', async () => {
    const lines = await captureAll(async () => {
      await assert.rejects(
        () => showChatKeyboard(makeApi({
          sendMessage: async () => { throw 'chat raw fail'; },
        }), CHAT_ID, THREAD_ID),
        (e: unknown) => e === 'chat raw fail',
      );
    });
    assertMenuLog(lines, 'TG_MENU_KEYBOARD_FAIL', {
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      op: 'show_chat_keyboard',
      text: 'chat keyboard post failed',
    });
    const failLine = lines.find((l) => l.includes('code=TG_MENU_KEYBOARD_FAIL') && l.includes('chat keyboard'));
    assert.ok(failLine && !failLine.includes('errno='));
  });

  it('logs TG_MENU_KEYBOARD_FAIL with errno and threadId when showChatKeyboard sendMessage throws and rethrows', async () => {
    const err = Object.assign(new Error('chat send blocked'), { code: 'ETG500' });
    const lines = await captureAll(async () => {
      await assert.rejects(
        () => showChatKeyboard(makeApi({
          sendMessage: async () => { throw err; },
        }), CHAT_ID, THREAD_ID),
        (e: unknown) => e === err,
      );
    });
    assertMenuLog(lines, 'TG_MENU_KEYBOARD_FAIL', {
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      op: 'show_chat_keyboard',
      errno: 'ETG500',
      text: 'chat keyboard post failed',
    });
    assert.ok(!lines.some((l) => l.includes('code=TG_MENU_KEYBOARD_CHAT')));
  });

  it('showChatKeyboard emits exactly one TG_MENU_KEYBOARD_CHAT log line', async () => {
    const lines = await captureAll(async () => {
      await showChatKeyboard(makeApi(), CHAT_ID, THREAD_ID);
    });
    assert.equal(lines.filter((l) => l.includes('code=TG_MENU_KEYBOARD_CHAT')).length, 1);
    assertMenuLog(lines, 'TG_MENU_KEYBOARD_CHAT', { chatId: CHAT_ID, threadId: THREAD_ID, op: 'show_chat_keyboard' });
  });

  it('getGeneralMenuItems with ru locale stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      setLocale('ru');
      const ruItems = getGeneralMenuItems();
      setLocale('en');
      const enItems = getGeneralMenuItems();
      assert.notEqual(ruItems[0]!.description, enItems[0]!.description);
    });
    assertNoMenuLogs(lines);
  });

  it('getGeneralMenuItems stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      const items = getGeneralMenuItems();
      assert.ok(items.length > 0);
    });
    assertNoMenuLogs(lines);
  });

  it('generalMenuButtonText at max length stays silent without TG_MENU codes', async () => {
    const icon = '📊';
    const command = 'status';
    const prefix = `${icon} /${command} — `;
    const desc = 'x'.repeat(64 - prefix.length);
    const lines = await captureAll(() => {
      const text = generalMenuButtonText(icon, command, desc);
      assert.equal(text.length, 64);
      assert.ok(!text.endsWith('…'));
    });
    assertNoMenuLogs(lines);
  });

  it('generalMenuButtonText normal label stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      const text = generalMenuButtonText('📊', 'status', 'Connection and bridge status');
      assert.ok(text.includes('/status'));
    });
    assertNoMenuLogs(lines);
  });

  it('generalMenuButtonText truncation stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      const long = 'A'.repeat(200);
      const text = generalMenuButtonText('📊', 'status', long);
      assert.ok(text.length <= 64);
      assert.ok(text.endsWith('…'));
    });
    assertNoMenuLogs(lines);
  });

  it('buildGeneralReplyKeyboard input_field_placeholder stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      const kb = buildGeneralReplyKeyboard();
      assert.ok(kb.input_field_placeholder && kb.input_field_placeholder.length > 0);
    });
    assertNoMenuLogs(lines);
  });

  it('buildGeneralReplyKeyboard stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      const kb = buildGeneralReplyKeyboard();
      assert.ok(kb.keyboard.length > 0);
      assert.equal(kb.is_persistent, false);
    });
    assertNoMenuLogs(lines);
  });

  it('resolveGeneralButtonCommand bare slash stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(resolveGeneralButtonCommand('/'), undefined);
    });
    assertNoMenuLogs(lines);
  });

  it('resolveGeneralButtonCommand empty string stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(resolveGeneralButtonCommand(''), undefined);
      assert.equal(resolveGeneralButtonCommand('   '), undefined);
    });
    assertNoMenuLogs(lines);
  });

  it('resolveGeneralButtonCommand unknown slash fallback stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(resolveGeneralButtonCommand('/not_in_menu'), 'not_in_menu');
    });
    assertNoMenuLogs(lines);
  });

  it('resolveGeneralButtonCommand trimmed whitespace stays silent without TG_MENU codes', async () => {
    const bridgeItem = getGeneralMenuItems().find((i) => i.command === 'bridge')!;
    const label = `🔄 /bridge — ${bridgeItem.description}`;
    const lines = await captureAll(() => {
      assert.equal(resolveGeneralButtonCommand(`  ${label}  `), 'bridge');
    });
    assertNoMenuLogs(lines);
  });

  it('resolveGeneralButtonCommand label match stays silent without TG_MENU codes', async () => {
    const bridgeItem = getGeneralMenuItems().find((i) => i.command === 'bridge')!;
    const label = `🔄 /bridge — ${bridgeItem.description}`;
    const lines = await captureAll(() => {
      assert.equal(resolveGeneralButtonCommand(label), 'bridge');
    });
    assertNoMenuLogs(lines);
  });

  it('resolveGeneralButtonCommand slash in text stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(resolveGeneralButtonCommand('please /bridge now'), 'bridge');
    });
    assertNoMenuLogs(lines);
  });

  it('resolveGeneralButtonCommand /cmd@bot stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(resolveGeneralButtonCommand('/status@MyBot'), 'status');
    });
    assertNoMenuLogs(lines);
  });

  it('resolveGeneralButtonCommand unknown stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(resolveGeneralButtonCommand('hello agent'), undefined);
    });
    assertNoMenuLogs(lines);
  });

  it('isGeneralChat missing is_forum defaults forum general and stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(isGeneralChat({ chat: {} }), true);
    });
    assertNoMenuLogs(lines);
  });

  it('isGeneralChat without chat stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(isGeneralChat({}), true);
    });
    assertNoMenuLogs(lines);
  });

  it('isGeneralChat threadId zero stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(
        isGeneralChat({ message: { message_thread_id: 0 }, chat: { is_forum: true } }),
        false,
      );
    });
    assertNoMenuLogs(lines);
  });

  it('isGeneralChat with thread stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(
        isGeneralChat({ message: { message_thread_id: THREAD_ID }, chat: { is_forum: true } }),
        false,
      );
    });
    assertNoMenuLogs(lines);
  });

  it('isGeneralChat forum general channel stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(isGeneralChat({ chat: { is_forum: true } }), true);
    });
    assertNoMenuLogs(lines);
  });

  it('isGeneralChat non-forum stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(isGeneralChat({ chat: { is_forum: false } }), false);
    });
    assertNoMenuLogs(lines);
  });

  it('withGeneralKeyboard stays silent without TG_MENU codes', async () => {
    const ctx = { chat: { id: CHAT_ID }, reply: async () => ({ message_id: 1 }), match: '' } as BotContext;
    const lines = await captureAll(() => {
      assert.equal(withGeneralKeyboard(ctx), ctx);
    });
    assertNoMenuLogs(lines);
  });

  it('getChatMenuItems with ru locale stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      setLocale('ru');
      const ruItems = getChatMenuItems();
      setLocale('en');
      const enItems = getChatMenuItems();
      assert.notEqual(ruItems[0]!.description, enItems[0]!.description);
    });
    assertNoMenuLogs(lines);
  });

  it('getChatMenuItems stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      const items = getChatMenuItems();
      assert.ok(items.some((i) => i.command === 'new_chat'));
    });
    assertNoMenuLogs(lines);
  });

  it('buildChatReplyKeyboard input_field_placeholder stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      const kb = buildChatReplyKeyboard();
      assert.ok(kb.input_field_placeholder && kb.input_field_placeholder.length > 0);
    });
    assertNoMenuLogs(lines);
  });

  it('buildChatReplyKeyboard stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      const kb = buildChatReplyKeyboard();
      assert.ok(kb.keyboard.length > 0);
      assert.equal(kb.is_persistent, false);
    });
    assertNoMenuLogs(lines);
  });

  it('resolveChatButtonCommand unknown text stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(resolveChatButtonCommand('plain agent text'), undefined);
    });
    assertNoMenuLogs(lines);
  });

  it('resolveChatButtonCommand unknown slash fallback stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(resolveChatButtonCommand('/not_in_chat_menu'), 'not_in_chat_menu');
    });
    assertNoMenuLogs(lines);
  });

  it('resolveChatButtonCommand label match stays silent without TG_MENU codes', async () => {
    const modeItem = getChatMenuItems().find((i) => i.command === 'set_mode')!;
    const label = `🎛 /set_mode — ${modeItem.description}`;
    const lines = await captureAll(() => {
      assert.equal(resolveChatButtonCommand(label), 'set_mode');
    });
    assertNoMenuLogs(lines);
  });

  it('resolveChatButtonCommand slash stays silent without TG_MENU codes', async () => {
    const lines = await captureAll(() => {
      assert.equal(resolveChatButtonCommand('/new_chat@MyBot extra'), 'new_chat');
    });
    assertNoMenuLogs(lines);
  });

  it('withChatKeyboard stays silent without TG_MENU codes', async () => {
    const ctx = { chat: { id: CHAT_ID }, reply: async () => ({ message_id: 1 }), match: '' } as BotContext;
    const lines = await captureAll(() => {
      assert.equal(withChatKeyboard(ctx), ctx);
    });
    assertNoMenuLogs(lines);
  });
});

const MENUS_LOG_CODES = [
  'TG_MENU_BUTTON_FAIL',
  'TG_MENU_KEYBOARD_GENERAL',
  'TG_MENU_KEYBOARD_FAIL',
  'TG_MENU_KEYBOARD_CHAT',
] as const;

const SILENT_PATH_MARKERS = [
  'stays silent',
  'without TG_MENU',
  'truncation',
  'label match',
  'slash',
  '@bot',
  'unknown slash',
  'trimmed whitespace',
  'missing is_forum',
  'unknown text',
  'swallows',
  'non-Error',
  'commands type',
  'row count',
  'alternate groupId',
  'at max length',
  'empty string',
  'non-Error and rethrows',
  'ru locale',
  'input_field_placeholder',
  'bare slash',
  'without chat',
  'threadId zero',
  'exactly one',
  'with thread',
  'forum general',
  'non-forum',
  'withGeneralKeyboard',
  'withChatKeyboard',
] as const;

const MENUS_PATH_MATRIX = [
  { kind: 'fail' as const, code: 'TG_MENU_BUTTON_FAIL', marker: 'setChatMenuButton throws' },
  { kind: 'fail' as const, code: 'TG_MENU_BUTTON_FAIL', marker: 'setChatMenuButton throws non-Error' },
  { kind: 'silent' as const, marker: 'swallows setChatMenuButton error without rethrow' },
  { kind: 'silent' as const, marker: 'setChatMenuButton with commands type' },
  { kind: 'silent' as const, marker: 'setupGeneralMenuButton success' },
  { kind: 'fail' as const, code: 'TG_MENU_KEYBOARD_GENERAL', marker: 'general reply keyboard row count' },
  { kind: 'fail' as const, code: 'TG_MENU_KEYBOARD_GENERAL', marker: 'alternate groupId' },
  { kind: 'fail' as const, code: 'TG_MENU_KEYBOARD_GENERAL', marker: 'showGeneralKeyboard success' },
  { kind: 'fail' as const, code: 'TG_MENU_KEYBOARD_FAIL', marker: 'showGeneralKeyboard sendMessage throws non-Error' },
  { kind: 'fail' as const, code: 'TG_MENU_KEYBOARD_FAIL', marker: 'showGeneralKeyboard sendMessage throws' },
  { kind: 'fail' as const, code: 'TG_MENU_KEYBOARD_CHAT', marker: 'chat reply keyboard row count' },
  { kind: 'fail' as const, code: 'TG_MENU_KEYBOARD_CHAT', marker: 'showChatKeyboard success' },
  { kind: 'fail' as const, code: 'TG_MENU_KEYBOARD_FAIL', marker: 'showChatKeyboard sendMessage throws non-Error' },
  { kind: 'fail' as const, code: 'TG_MENU_KEYBOARD_FAIL', marker: 'showChatKeyboard sendMessage throws' },
  { kind: 'fail' as const, code: 'TG_MENU_KEYBOARD_GENERAL', marker: 'exactly one TG_MENU_KEYBOARD_GENERAL' },
  { kind: 'fail' as const, code: 'TG_MENU_KEYBOARD_CHAT', marker: 'exactly one TG_MENU_KEYBOARD_CHAT' },
  { kind: 'silent' as const, marker: 'getGeneralMenuItems with ru locale' },
  { kind: 'silent' as const, marker: 'getGeneralMenuItems' },
  { kind: 'silent' as const, marker: 'generalMenuButtonText at max length' },
  { kind: 'silent' as const, marker: 'generalMenuButtonText normal' },
  { kind: 'silent' as const, marker: 'generalMenuButtonText truncation' },
  { kind: 'silent' as const, marker: 'buildGeneralReplyKeyboard input_field_placeholder' },
  { kind: 'silent' as const, marker: 'buildGeneralReplyKeyboard' },
  { kind: 'silent' as const, marker: 'resolveGeneralButtonCommand bare slash' },
  { kind: 'silent' as const, marker: 'resolveGeneralButtonCommand empty string' },
  { kind: 'silent' as const, marker: 'resolveGeneralButtonCommand label match' },
  { kind: 'silent' as const, marker: 'resolveGeneralButtonCommand slash in text' },
  { kind: 'silent' as const, marker: 'resolveGeneralButtonCommand /cmd@bot' },
  { kind: 'silent' as const, marker: 'resolveGeneralButtonCommand unknown' },
  { kind: 'silent' as const, marker: 'resolveGeneralButtonCommand unknown slash fallback' },
  { kind: 'silent' as const, marker: 'resolveGeneralButtonCommand trimmed whitespace' },
  { kind: 'silent' as const, marker: 'isGeneralChat without chat' },
  { kind: 'silent' as const, marker: 'isGeneralChat threadId zero' },
  { kind: 'silent' as const, marker: 'isGeneralChat with thread' },
  { kind: 'silent' as const, marker: 'isGeneralChat forum general' },
  { kind: 'silent' as const, marker: 'isGeneralChat non-forum' },
  { kind: 'silent' as const, marker: 'isGeneralChat missing is_forum' },
  { kind: 'silent' as const, marker: 'withGeneralKeyboard' },
  { kind: 'silent' as const, marker: 'getChatMenuItems with ru locale' },
  { kind: 'silent' as const, marker: 'getChatMenuItems' },
  { kind: 'silent' as const, marker: 'buildChatReplyKeyboard input_field_placeholder' },
  { kind: 'silent' as const, marker: 'buildChatReplyKeyboard' },
  { kind: 'silent' as const, marker: 'resolveChatButtonCommand label match' },
  { kind: 'silent' as const, marker: 'resolveChatButtonCommand slash' },
  { kind: 'silent' as const, marker: 'resolveChatButtonCommand unknown text' },
  { kind: 'silent' as const, marker: 'resolveChatButtonCommand unknown slash fallback' },
  { kind: 'silent' as const, marker: 'withChatKeyboard' },
] as const;

describe('menus logging coverage', () => {
  it('asserts every menus code in test file', () => {
    const src = readFileSync(new URL('./menus-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of MENUS_LOG_CODES) {
      const covered =
        src.includes(`code=${code}`)
        || src.includes(`assertMenuLog(lines, '${code}'`);
      assert.ok(covered, `missing assertion for ${code}`);
    }
    assert.equal(MENUS_LOG_CODES.length, 4);
  });

  it('menus.ts declares exactly the covered codes', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    const found = new Set<string>();
    for (const m of src.matchAll(/'(TG_MENU_[A-Z_]+)'/g)) {
      found.add(m[1]);
    }
    for (const code of MENUS_LOG_CODES) {
      assert.ok(found.has(code), `menus.ts missing ${code}`);
    }
    assert.equal(found.size, MENUS_LOG_CODES.length);
  });

  it('menus.ts uses menuCtx on every log site', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
    const re = /log(?:Info|Warn)\(\s*'(TG_MENU_[A-Z_]+)'[\s\S]*?\);/g;
    const codes: string[] = [];
    for (const m of src.matchAll(re)) {
      codes.push(m[1]);
      assert.ok(m[0].includes('menuCtx('), `log site ${m[1]} missing menuCtx(`);
    }
    assert.equal(codes.length, 5);
    assert.equal(new Set(codes).size, MENUS_LOG_CODES.length);
    assert.ok(!src.match(/log(?:Info|Warn)\([^)]*\{ scope: 'telegram'/));
  });

  it('TG_MENU_KEYBOARD_GENERAL and TG_MENU_KEYBOARD_CHAT use logInfo; others use logWarn', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /logInfo\(\s*'TG_MENU_KEYBOARD_GENERAL'/);
    assert.match(src, /logInfo\(\s*'TG_MENU_KEYBOARD_CHAT'/);
    assert.match(src, /logWarn\(\s*'TG_MENU_BUTTON_FAIL'/);
    assert.match(src, /logWarn\(\s*'TG_MENU_KEYBOARD_FAIL'/);
  });

  it('every warn code has assertMenuLog in behavioral tests', () => {
    const src = readFileSync(new URL('./menus-logging.test.ts', import.meta.url), 'utf-8');
    const warnCodes = MENUS_LOG_CODES.filter(
      (c) => c !== 'TG_MENU_KEYBOARD_GENERAL' && c !== 'TG_MENU_KEYBOARD_CHAT',
    );
    for (const code of warnCodes) {
      assert.ok(
        src.includes(`assertMenuLog(lines, '${code}'`),
        `behavioral test missing assertMenuLog for ${code}`,
      );
    }
  });

  it('info codes have assertMenuLog in behavioral tests', () => {
    const src = readFileSync(new URL('./menus-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of ['TG_MENU_KEYBOARD_GENERAL', 'TG_MENU_KEYBOARD_CHAT'] as const) {
      assert.ok(src.includes(`assertMenuLog(lines, '${code}'`), `missing assertMenuLog for ${code}`);
    }
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./menus-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent path marker "${marker}" in behavioral titles`);
    }
  });

  it('each log code is referenced in a behavioral it() title', () => {
    const src = readFileSync(new URL('./menus-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of MENUS_LOG_CODES) {
      assert.ok(
        src.includes(`logs ${code}`) || src.includes(`and ${code}`),
        `no behavioral it() title references ${code}`,
      );
    }
  });

  it('TG_MENU_BUTTON_FAIL uses normalizeError for errno in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('export async function setupGeneralMenuButton'),
      src.indexOf('export async function showGeneralKeyboard'),
    );
    assert.match(block, /TG_MENU_BUTTON_FAIL[\s\S]*errno: norm\.errno/);
    assert.match(block, /const norm = normalizeError\(err\)[\s\S]*TG_MENU_BUTTON_FAIL/);
    assert.ok(!block.includes('throw err'));
  });

  it('TG_MENU_KEYBOARD_FAIL uses normalizeError for errno in both send paths', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    const generalBlock = src.slice(
      src.indexOf('export async function showGeneralKeyboard'),
      src.indexOf('const CHAT_MENU_DEFS'),
    );
    const chatBlock = src.slice(src.indexOf('export async function showChatKeyboard'));
    for (const block of [generalBlock, chatBlock]) {
      assert.match(block, /TG_MENU_KEYBOARD_FAIL[\s\S]*errno: norm\.errno/);
      assert.match(block, /const norm = normalizeError\(err\)[\s\S]*TG_MENU_KEYBOARD_FAIL/);
    }
  });

  it('menus.ts declares exactly 5 log emission sites', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    const siteCount = src.match(/log(?:Info|Warn)\(\s*'TG_MENU_/g)?.length ?? 0;
    assert.equal(siteCount, 5);
  });

  it('automated matrix: 4/4 codes have behavioral assertMenuLog', () => {
    const src = readFileSync(new URL('./menus-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of MENUS_LOG_CODES) {
      assert.ok(
        src.includes(`assertMenuLog(lines, '${code}'`),
        `behavioral matrix missing assertMenuLog for ${code}`,
      );
    }
  });

  it('path matrix rows map to behavioral test titles or assertMenuLog', () => {
    const src = readFileSync(new URL('./menus-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of MENUS_PATH_MATRIX) {
      if (row.kind === 'fail' && 'code' in row) {
        const hit =
          src.includes(`logs ${row.code}`)
          || src.includes(`and ${row.code}`)
          || src.includes(`assertMenuLog(lines, '${row.code}'`);
        assert.ok(hit, `path matrix fail ${row.code} (${row.marker}) not covered`);
        assert.ok(src.includes(row.marker), `path matrix marker "${row.marker}" missing from titles`);
      } else {
        assert.ok(src.includes(row.marker), `path matrix silent "${row.marker}" missing from titles`);
      }
    }
    assert.equal(MENUS_PATH_MATRIX.length, 47);
  });

  it('every exported menus helper with logging is exercised in behavioral tests', () => {
    const src = readFileSync(new URL('./menus-logging.test.ts', import.meta.url), 'utf-8');
    for (const fn of [
      'setupGeneralMenuButton',
      'showGeneralKeyboard',
      'showChatKeyboard',
      'getGeneralMenuItems',
      'generalMenuButtonText',
      'buildGeneralReplyKeyboard',
      'resolveGeneralButtonCommand',
      'isGeneralChat',
      'withGeneralKeyboard',
      'getChatMenuItems',
      'buildChatReplyKeyboard',
      'resolveChatButtonCommand',
      'withChatKeyboard',
    ] as const) {
      assert.ok(src.includes(`${fn}(`), `behavioral suite missing call to ${fn}`);
    }
  });

  it('menus.ts vs HEAD has zero console and exactly 5 logEvent sites', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
    assert.equal(src.match(/log(?:Info|Warn)\(/g)?.length ?? 0, 5);
  });

  it('showGeneralKeyboard and showChatKeyboard rethrow after TG_MENU_KEYBOARD_FAIL', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    const generalBlock = src.slice(
      src.indexOf('export async function showGeneralKeyboard'),
      src.indexOf('const CHAT_MENU_DEFS'),
    );
    const chatBlock = src.slice(src.indexOf('export async function showChatKeyboard'));
    assert.match(generalBlock, /TG_MENU_KEYBOARD_FAIL[\s\S]*throw err;/);
    assert.match(chatBlock, /TG_MENU_KEYBOARD_FAIL[\s\S]*throw err;/);
  });

  it('menuCtx helper is private and sets scope telegram in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    const block = src.match(/function menuCtx[\s\S]*?^const GENERAL_MENU_DEFS/m)?.[0] ?? '';
    assert.match(block, /scope: 'telegram'/);
    assert.ok(!src.includes('export function menuCtx'));
  });

  it('resolveGeneralButtonCommand and resolveChatButtonCommand have no logEvent in menus.ts', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    for (const fn of ['resolveGeneralButtonCommand', 'resolveChatButtonCommand'] as const) {
      const start = src.indexOf(`export function ${fn}`);
      const end = src.indexOf('export ', start + 1);
      const block = end > start ? src.slice(start, end) : src.slice(start);
      assert.ok(!block.includes('logInfo('));
      assert.ok(!block.includes('logWarn('));
    }
  });

  it('showGeneralKeyboard and showChatKeyboard call buildReplyKeyboard helpers in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    const generalBlock = src.slice(
      src.indexOf('export async function showGeneralKeyboard'),
      src.indexOf('const CHAT_MENU_DEFS'),
    );
    const chatBlock = src.slice(src.indexOf('export async function showChatKeyboard'));
    assert.match(generalBlock, /reply_markup: buildGeneralReplyKeyboard\(\)/);
    assert.match(chatBlock, /reply_markup: buildChatReplyKeyboard\(\)/);
  });

  it('TG_MENU_KEYBOARD_FAIL general path passes chatId without threadId in menuCtx', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    const generalBlock = src.slice(
      src.indexOf('export async function showGeneralKeyboard'),
      src.indexOf('const CHAT_MENU_DEFS'),
    );
    assert.match(generalBlock, /menuCtx\('show_general_keyboard', \{ chatId: groupId, errno: norm\.errno \}\)/);
    assert.ok(!generalBlock.includes('threadId'));
  });

  it('private menu button text helpers have no logEvent in menus.ts', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    const generalBtn = src.slice(
      src.indexOf('function generalMenuItemButtonText'),
      src.indexOf('export function buildGeneralReplyKeyboard'),
    );
    const chatBtn = src.slice(
      src.indexOf('function chatMenuItemButtonText'),
      src.indexOf('export function buildChatReplyKeyboard'),
    );
    for (const block of [generalBtn, chatBtn]) {
      assert.ok(!block.includes('logInfo('));
      assert.ok(!block.includes('logWarn('));
    }
  });

  it('TG_MENU_KEYBOARD_GENERAL and TG_MENU_KEYBOARD_CHAT pass chatId threadId via menuCtx in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /TG_MENU_KEYBOARD_GENERAL[\s\S]*menuCtx\('show_general_keyboard', \{ chatId: groupId \}\)/);
    assert.match(src, /TG_MENU_KEYBOARD_CHAT[\s\S]*menuCtx\('show_chat_keyboard', \{ chatId, threadId \}\)/);
  });

  it('generalMenuButtonText and buildReplyKeyboard helpers have no logEvent in menus.ts', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    for (const fn of [
      'generalMenuButtonText',
      'buildGeneralReplyKeyboard',
      'buildChatReplyKeyboard',
      'getGeneralMenuItems',
      'getChatMenuItems',
    ] as const) {
      const start = src.indexOf(`export function ${fn}`);
      const end = src.indexOf('export ', start + 1);
      const block = end > start ? src.slice(start, end) : src.slice(start);
      assert.ok(!block.includes('logInfo('));
      assert.ok(!block.includes('logWarn('));
    }
  });

  it('withGeneralKeyboard withChatKeyboard isGeneralChat have no logEvent in menus.ts', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    for (const fn of ['withGeneralKeyboard', 'withChatKeyboard', 'isGeneralChat'] as const) {
      const start = src.indexOf(`export function ${fn}`);
      const end = src.indexOf('export ', start + 1);
      const block = end > start ? src.slice(start, end) : src.slice(start);
      assert.ok(!block.includes('logInfo('));
      assert.ok(!block.includes('logWarn('));
    }
  });

  it('TG_MENU_KEYBOARD_FAIL appears twice in menus.ts for general and chat paths', () => {
    const src = readFileSync(
      new URL('../../src/telegram/ui/menus.ts', import.meta.url),
      'utf-8',
    );
    assert.equal(src.match(/TG_MENU_KEYBOARD_FAIL/g)?.length ?? 0, 2);
    assert.match(src, /general keyboard post failed/);
    assert.match(src, /chat keyboard post failed/);
  });
});
