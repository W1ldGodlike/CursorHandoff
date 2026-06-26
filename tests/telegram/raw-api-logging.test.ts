import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RawTelegramApiClient } from '../../src/telegram/transport/raw-api.js';

const BOT_TOKEN = '1234567890:ABCDEFghijklmnopqrsTUVwxyz';
const CHAT_ID = -1001234567890;
const THREAD_ID = 4242;

const RAW_API_LOG_CODES = ['TG_API_SEND_OK', 'TG_API_SEND_RICH_OK'] as const;

type RouteFn = (method: string, body?: Record<string, unknown>) => Response | Promise<Response>;

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okResult(result: unknown): Response {
  return jsonResponse({ ok: true, result });
}

function failResult(description: string, error_code?: number): Response {
  return jsonResponse({ ok: false, description, error_code });
}

function makeFetch(route: RouteFn): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf('/') + 1);
    let body: Record<string, unknown> | undefined;
    if (init?.body && typeof init.body === 'string') {
      body = JSON.parse(init.body) as Record<string, unknown>;
    }
    return route(method, body);
  }) as typeof fetch;
}

type CapturedRequest = { method: string; body?: Record<string, unknown> };

function makeCapturingFetch(route: RouteFn): { fetch: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf('/') + 1);
    let body: Record<string, unknown> | undefined;
    if (init?.body && typeof init.body === 'string') {
      body = JSON.parse(init.body) as Record<string, unknown>;
    }
    requests.push({ method, body });
    return route(method, body);
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

function assertRawApiLog(
  lines: string[],
  code: string,
  need: {
    op?: string;
    hint?: string;
    text?: string;
    threadId?: number;
    chatId?: number;
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
  assert.ok(line, `missing raw-api log: ${desc}`);
  assert.ok(line!.includes('scope=telegram'), `${code} missing scope=telegram`);
}

function assertNoRawApiLogs(lines: string[]): void {
  const hit = lines.find((l) => RAW_API_LOG_CODES.some((code) => l.includes(`code=${code}`)));
  assert.ok(!hit, `unexpected raw-api log: ${hit}`);
}

function rawApiOnly(lines: string[]): string[] {
  return lines.filter((l) => RAW_API_LOG_CODES.some((code) => l.includes(`code=${code}`)));
}

function rawApiZoneSrc(): string {
  const src = readFileSync(
    new URL('../../src/telegram/transport/raw-api.ts', import.meta.url),
    'utf-8',
  );
  return src.slice(src.indexOf('function rawApiCtx'), src.indexOf('export interface TgUpdate'));
}

async function withClient(route: RouteFn, run: (client: RawTelegramApiClient) => Promise<void>): Promise<void> {
  const orig = global.fetch;
  global.fetch = makeFetch(route);
  try {
    await run(new RawTelegramApiClient(BOT_TOKEN));
  } finally {
    global.fetch = orig;
  }
}

describe('raw-api logging', () => {
  let savedFetch: typeof fetch;

  beforeEach(() => {
    savedFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = savedFetch;
  });

  it('logs TG_API_SEND_OK on sendMessage with op send_message threadId chatId and hint msgId', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendMessage' ? okResult({ message_id: 9001 }) : okResult(true)),
        (client) => client.sendMessage(CHAT_ID, 'hello handoff', { message_thread_id: THREAD_ID }),
      );
    });

    assertRawApiLog(lines, 'TG_API_SEND_OK', {
      op: 'send_message',
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      hint: '9001',
      text: 'msgId=9001',
    });
    assertRawApiLog(lines, 'TG_API_SEND_OK', { text: '"hello handoff"' });
  });

  it('logs TG_API_SEND_OK without threadId when sendMessage omits message_thread_id', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendMessage' ? okResult({ message_id: 42 }) : okResult(true)),
        (client) => client.sendMessage(CHAT_ID, 'plain chat'),
      );
    });

    assertRawApiLog(lines, 'TG_API_SEND_OK', { op: 'send_message', chatId: CHAT_ID, hint: '42', omitThreadId: true });
  });

  it('logs TG_API_SEND_OK preview with collapsed whitespace in message text', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendMessage' ? okResult({ message_id: 7 }) : okResult(true)),
        (client) => client.sendMessage(CHAT_ID, 'line1\n\n  line2\t tab'),
      );
    });

    assertRawApiLog(lines, 'TG_API_SEND_OK', { text: '"line1 line2 tab"' });
  });

  it('logs TG_API_SEND_OK preview truncated to 60 characters', async () => {
    const long = 'a'.repeat(80);
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendMessage' ? okResult({ message_id: 8 }) : okResult(true)),
        (client) => client.sendMessage(CHAT_ID, long),
      );
    });

    assertRawApiLog(lines, 'TG_API_SEND_OK', { text: `"${'a'.repeat(60)}"` });
    assert.ok(!lines.some((l) => l.includes(`"${'a'.repeat(61)}`)));
  });

  it('sendMessage API failure throws without TG_API_SEND_OK', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendMessage' ? failResult('blocked', 403) : okResult(true)),
        async (client) => {
          await assert.rejects(
            () => client.sendMessage(CHAT_ID, 'fail me'),
            (err: unknown) => {
              assert.ok(err instanceof Error);
              assert.match(err.message, /sendMessage/);
              assert.equal((err as { error_code?: number }).error_code, 403);
              return true;
            },
          );
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('sendMessage unknown error description throws without TG_API_SEND_OK', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendMessage' ? jsonResponse({ ok: false }) : okResult(true)),
        async (client) => {
          await assert.rejects(
            () => client.sendMessage(CHAT_ID, 'fail me'),
            /unknown error/,
          );
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('editMessageText success stays silent without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'editMessageText' ? okResult(true) : okResult(true)),
        (client) => client.editMessageText(CHAT_ID, 55, 'edited'),
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('editMessageText failure throws without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'editMessageText' ? failResult('not modified', 400) : okResult(true)),
        async (client) => {
          await assert.rejects(() => client.editMessageText(CHAT_ID, 55, 'edited'), /editMessageText/);
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('logs TG_API_SEND_RICH_OK on sendRichMessage with op send_rich_message threadId chatId hint', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendRichMessage' ? okResult({ message_id: 9100 }) : okResult(true)),
        (client) => client.sendRichMessage(CHAT_ID, '<b>rich</b> body', { message_thread_id: THREAD_ID }),
      );
    });

    assertRawApiLog(lines, 'TG_API_SEND_RICH_OK', {
      op: 'send_rich_message',
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      hint: '9100',
      text: 'msgId=9100',
    });
    assertRawApiLog(lines, 'TG_API_SEND_RICH_OK', { text: '"<b>rich</b> body"' });
  });

  it('logs TG_API_SEND_RICH_OK without threadId when sendRichMessage omits message_thread_id', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendRichMessage' ? okResult({ message_id: 77 }) : okResult(true)),
        (client) => client.sendRichMessage(CHAT_ID, '<i>plain</i>'),
      );
    });

    assertRawApiLog(lines, 'TG_API_SEND_RICH_OK', {
      op: 'send_rich_message',
      chatId: CHAT_ID,
      hint: '77',
      omitThreadId: true,
    });
  });

  it('sendRichMessage API failure throws without TG_API_SEND_RICH_OK', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendRichMessage' ? failResult('rich blocked', 400) : okResult(true)),
        async (client) => {
          await assert.rejects(
            () => client.sendRichMessage(CHAT_ID, '<b>x</b>'),
            (err: unknown) => {
              assert.equal((err as { error_code?: number }).error_code, 400);
              return true;
            },
          );
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('editRichMessage success stays silent without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'editMessageText' ? okResult(true) : okResult(true)),
        (client) => client.editRichMessage(CHAT_ID, 88, '<b>edit rich</b>'),
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('deleteMessage success stays silent without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'deleteMessage' ? okResult(true) : okResult(true)),
        (client) => client.deleteMessage(CHAT_ID, 99),
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('getMe success stays silent without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) =>
          method === 'getMe'
            ? okResult({ id: 1, is_bot: true, first_name: 'Bot' })
            : okResult(true),
        (client) => client.getMe(),
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('getUpdates success stays silent without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'getUpdates' ? okResult([]) : okResult(true)),
        (client) => client.getUpdates(0, 0),
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('getUpdates failure throws without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'getUpdates' ? failResult('conflict', 409) : okResult(true)),
        async (client) => {
          await assert.rejects(
            () => client.getUpdates(0, 0),
            (err: unknown) => {
              assert.equal((err as { error_code?: number }).error_code, 409);
              assert.match(String(err), /getUpdates/);
              return true;
            },
          );
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('sendChatAction success stays silent without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendChatAction' ? okResult(true) : okResult(true)),
        (client) => client.sendChatAction(CHAT_ID, 'typing', { message_thread_id: THREAD_ID }),
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('createForumTopic success stays silent without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) =>
          method === 'createForumTopic'
            ? okResult({ message_thread_id: THREAD_ID })
            : okResult(true),
        (client) => client.createForumTopic(CHAT_ID, 'New topic'),
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('answerCallbackQuery success stays silent without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'answerCallbackQuery' ? okResult(true) : okResult(true)),
        (client) => client.answerCallbackQuery('cb-1', { text: 'ok' }),
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('setMyCommands success stays silent without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'setMyCommands' ? okResult(true) : okResult(true)),
        (client) => client.setMyCommands([{ command: 'start', description: 'Start' }]),
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('logs exactly one TG_API_SEND_OK per sendMessage call', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendMessage' ? okResult({ message_id: 100 }) : okResult(true)),
        (client) => client.sendMessage(CHAT_ID, 'once'),
      );
    });

    assert.equal(rawApiOnly(lines).filter((l) => l.includes('code=TG_API_SEND_OK')).length, 1);
  });

  it('sendMessage with parse_mode and reply_markup logs only one TG_API_SEND_OK', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendMessage' ? okResult({ message_id: 101 }) : okResult(true)),
        (client) =>
          client.sendMessage(CHAT_ID, '*bold*', {
            message_thread_id: THREAD_ID,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: 'Go', callback_data: 'go' }]] },
          }),
      );
    });

    assert.equal(rawApiOnly(lines).length, 1);
    assertRawApiLog(lines, 'TG_API_SEND_OK', { hint: '101', threadId: THREAD_ID });
  });

  it('sendPhoto multipart success stays silent without TG_API codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-raw-api-photo-'));
    const photoPath = join(dir, 'shot.png');
    writeFileSync(photoPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendPhoto' ? okResult({ message_id: 200 }) : okResult(true)),
        (client) => client.sendPhoto(CHAT_ID, photoPath, { message_thread_id: THREAD_ID }),
      );
    });

    rmSync(dir, { recursive: true, force: true });
    assertNoRawApiLogs(lines);
  });

  it('consecutive sendMessage and sendRichMessage emit one code each in order', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => {
          if (method === 'sendMessage') return okResult({ message_id: 301 });
          if (method === 'sendRichMessage') return okResult({ message_id: 302 });
          return okResult(true);
        },
        async (client) => {
          await client.sendMessage(CHAT_ID, 'plain first');
          await client.sendRichMessage(CHAT_ID, '<b>rich second</b>');
        },
      );
    });

    const sendIdx = lines.findIndex((l) => l.includes('code=TG_API_SEND_OK'));
    const richIdx = lines.findIndex((l) => l.includes('code=TG_API_SEND_RICH_OK'));
    assert.ok(sendIdx >= 0 && richIdx > sendIdx, `SEND_OK@${sendIdx} RICH_OK@${richIdx}`);
    assert.equal(rawApiOnly(lines).length, 2);
  });

  it('downloadFile HTTP failure throws without TG_API codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-raw-api-dl-'));
    const dest = join(dir, 'out.bin');

    const lines = await captureAll(async () => {
      const orig = global.fetch;
      global.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/file/bot')) {
          return new Response('', { status: 404 });
        }
        return okResult(true);
      }) as typeof fetch;
      try {
        const client = new RawTelegramApiClient(BOT_TOKEN);
        await assert.rejects(() => client.downloadFile('photos/x.jpg', dest), /downloadFile HTTP 404/);
      } finally {
        global.fetch = orig;
      }
    });

    rmSync(dir, { recursive: true, force: true });
    assertNoRawApiLogs(lines);
  });

  it('logs TG_API_SEND_RICH_OK preview with collapsed whitespace in rich html', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendRichMessage' ? okResult({ message_id: 11 }) : okResult(true)),
        (client) => client.sendRichMessage(CHAT_ID, '<b>line1</b>\n\n  <i>line2</i>'),
      );
    });

    assertRawApiLog(lines, 'TG_API_SEND_RICH_OK', { text: '"<b>line1</b> <i>line2</i>"' });
  });

  it('logs TG_API_SEND_RICH_OK preview truncated to 60 characters', async () => {
    const long = `<b>${'z'.repeat(80)}</b>`;
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendRichMessage' ? okResult({ message_id: 12 }) : okResult(true)),
        (client) => client.sendRichMessage(CHAT_ID, long),
      );
    });

    const expected = long.replace(/\s+/g, ' ').slice(0, 60);
    assertRawApiLog(lines, 'TG_API_SEND_RICH_OK', { text: `"${expected}"` });
    assert.ok(!lines.some((l) => l.includes(`"${'z'.repeat(61)}`)));
  });

  it('logs exactly one TG_API_SEND_RICH_OK per sendRichMessage call', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendRichMessage' ? okResult({ message_id: 120 }) : okResult(true)),
        (client) => client.sendRichMessage(CHAT_ID, '<b>once rich</b>'),
      );
    });

    assert.equal(rawApiOnly(lines).filter((l) => l.includes('code=TG_API_SEND_RICH_OK')).length, 1);
  });

  it('sendRichMessage unknown error description throws without TG_API_SEND_RICH_OK', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendRichMessage' ? jsonResponse({ ok: false }) : okResult(true)),
        async (client) => {
          await assert.rejects(() => client.sendRichMessage(CHAT_ID, '<b>x</b>'), /unknown error/);
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('sendRichMessage with reply_markup logs only one TG_API_SEND_RICH_OK', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendRichMessage' ? okResult({ message_id: 121 }) : okResult(true)),
        (client) =>
          client.sendRichMessage(CHAT_ID, '<b>rich btn</b>', {
            message_thread_id: THREAD_ID,
            reply_markup: { inline_keyboard: [[{ text: 'Tap', callback_data: 'tap' }]] },
          }),
      );
    });

    assert.equal(rawApiOnly(lines).length, 1);
    assertRawApiLog(lines, 'TG_API_SEND_RICH_OK', { hint: '121', threadId: THREAD_ID });
  });

  it('editRichMessage failure throws without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'editMessageText' ? failResult('rich edit fail', 400) : okResult(true)),
        async (client) => {
          await assert.rejects(() => client.editRichMessage(CHAT_ID, 88, '<b>bad</b>'), /editMessageText/);
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('deleteMessage failure throws without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'deleteMessage' ? failResult('not found', 400) : okResult(true)),
        async (client) => {
          await assert.rejects(() => client.deleteMessage(CHAT_ID, 99), /deleteMessage/);
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('getChatMember success stays silent without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'getChatMember' ? okResult({ status: 'member' }) : okResult(true)),
        (client) => client.getChatMember(CHAT_ID, 12345),
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('getFile success stays silent without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'getFile' ? okResult({ file_path: 'photos/x.jpg' }) : okResult(true)),
        (client) => client.getFile('file-abc'),
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('setChatMenuButton success stays silent without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'setChatMenuButton' ? okResult(true) : okResult(true)),
        (client) => client.setChatMenuButton({ type: 'commands' }, CHAT_ID),
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('sendDocument multipart success stays silent without TG_API codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-raw-api-doc-'));
    const docPath = join(dir, 'readme.txt');
    writeFileSync(docPath, 'hello doc');

    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendDocument' ? okResult({ message_id: 201 }) : okResult(true)),
        (client) => client.sendDocument(CHAT_ID, docPath, { message_thread_id: THREAD_ID, caption: 'cap' }),
      );
    });

    rmSync(dir, { recursive: true, force: true });
    assertNoRawApiLogs(lines);
  });

  it('sendMediaGroup multipart success stays silent without TG_API codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-raw-api-album-'));
    const p1 = join(dir, 'a.png');
    const p2 = join(dir, 'b.png');
    writeFileSync(p1, Buffer.from([0x89, 0x50]));
    writeFileSync(p2, Buffer.from([0x89, 0x51]));

    const lines = await captureAll(async () => {
      await withClient(
        (method) =>
          method === 'sendMediaGroup'
            ? okResult([{ message_id: 301 }, { message_id: 302 }])
            : okResult(true),
        (client) =>
          client.sendMediaGroup(
            CHAT_ID,
            [
              { type: 'photo', path: p1 },
              { type: 'photo', path: p2, caption: 'second' },
            ],
            { message_thread_id: THREAD_ID },
          ),
      );
    });

    rmSync(dir, { recursive: true, force: true });
    assertNoRawApiLogs(lines);
  });

  it('sendPhoto multipart failure throws without TG_API codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-raw-api-photo-fail-'));
    const photoPath = join(dir, 'bad.png');
    writeFileSync(photoPath, Buffer.from([0x89]));

    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendPhoto' ? failResult('photo too big', 413) : okResult(true)),
        async (client) => {
          await assert.rejects(
            () => client.sendPhoto(CHAT_ID, photoPath),
            (err: unknown) => {
              assert.equal((err as { error_code?: number }).error_code, 413);
              return true;
            },
          );
        },
      );
    });

    rmSync(dir, { recursive: true, force: true });
    assertNoRawApiLogs(lines);
  });

  it('getUpdates ok without result field returns empty array silently', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'getUpdates' ? jsonResponse({ ok: true }) : okResult(true)),
        async (client) => {
          const updates = await client.getUpdates(5, 2);
          assert.deepEqual(updates, []);
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('two consecutive sendMessage calls emit two TG_API_SEND_OK logs', async () => {
    let sendCalls = 0;
    const lines = await captureAll(async () => {
      await withClient(
        (method) => {
          if (method === 'sendMessage') {
            sendCalls++;
            return okResult({ message_id: 400 + sendCalls });
          }
          return okResult(true);
        },
        async (client) => {
          await client.sendMessage(CHAT_ID, 'first msg');
          await client.sendMessage(CHAT_ID, 'second msg');
        },
      );
    });

    assert.equal(sendCalls, 2);
    assert.equal(rawApiOnly(lines).filter((l) => l.includes('code=TG_API_SEND_OK')).length, 2);
    assertRawApiLog(lines, 'TG_API_SEND_OK', { hint: '401', text: '"first msg"' });
    assertRawApiLog(lines, 'TG_API_SEND_OK', { hint: '402', text: '"second msg"' });
  });

  it('logs TG_API_SEND_OK with threadId zero when message_thread_id is 0', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendMessage' ? okResult({ message_id: 500 }) : okResult(true)),
        (client) => client.sendMessage(CHAT_ID, 'general thread', { message_thread_id: 0 }),
      );
    });

    assertRawApiLog(lines, 'TG_API_SEND_OK', { threadId: 0, hint: '500' });
  });

  it('editForumTopic success stays silent without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'editForumTopic' ? okResult(true) : okResult(true)),
        (client) => client.editForumTopic(CHAT_ID, THREAD_ID, 'Renamed'),
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('deleteForumTopic success stays silent without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'deleteForumTopic' ? okResult(true) : okResult(true)),
        (client) => client.deleteForumTopic(CHAT_ID, THREAD_ID),
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('deleteForumTopic failure throws without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'deleteForumTopic' ? failResult('topic missing', 400) : okResult(true)),
        async (client) => {
          await assert.rejects(() => client.deleteForumTopic(CHAT_ID, THREAD_ID), /deleteForumTopic/);
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('getFile failure throws without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'getFile' ? failResult('invalid file', 400) : okResult(true)),
        async (client) => {
          await assert.rejects(() => client.getFile('bad-id'), /getFile/);
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('getMe failure throws without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'getMe' ? failResult('unauthorized', 401) : okResult(true)),
        async (client) => {
          await assert.rejects(
            () => client.getMe(),
            (err: unknown) => {
              assert.equal((err as { error_code?: number }).error_code, 401);
              return true;
            },
          );
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('sendChatAction failure throws without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendChatAction' ? failResult('action fail', 400) : okResult(true)),
        async (client) => {
          await assert.rejects(() => client.sendChatAction(CHAT_ID, 'typing'), /sendChatAction/);
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('sendDocument multipart failure throws without TG_API codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-raw-api-doc-fail-'));
    const docPath = join(dir, 'fail.txt');
    writeFileSync(docPath, 'fail doc');

    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendDocument' ? failResult('doc fail', 400) : okResult(true)),
        async (client) => {
          await assert.rejects(() => client.sendDocument(CHAT_ID, docPath), /sendDocument/);
        },
      );
    });

    rmSync(dir, { recursive: true, force: true });
    assertNoRawApiLogs(lines);
  });

  it('downloadFile success stays silent without TG_API codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-raw-api-dl-ok-'));
    const dest = join(dir, 'saved.bin');

    const lines = await captureAll(async () => {
      const orig = global.fetch;
      global.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/file/bot')) {
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        }
        return okResult(true);
      }) as typeof fetch;
      try {
        const client = new RawTelegramApiClient(BOT_TOKEN);
        await client.downloadFile('photos/ok.jpg', dest);
      } finally {
        global.fetch = orig;
      }
    });

    rmSync(dir, { recursive: true, force: true });
    assertNoRawApiLogs(lines);
  });

  it('sendMessage failure followed by sendRichMessage success logs only TG_API_SEND_RICH_OK', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => {
          if (method === 'sendMessage') return failResult('send blocked', 403);
          if (method === 'sendRichMessage') return okResult({ message_id: 601 });
          return okResult(true);
        },
        async (client) => {
          await assert.rejects(() => client.sendMessage(CHAT_ID, 'blocked'));
          await client.sendRichMessage(CHAT_ID, '<b>after fail</b>');
        },
      );
    });

    assert.equal(rawApiOnly(lines).length, 1);
    assertRawApiLog(lines, 'TG_API_SEND_RICH_OK', { hint: '601', text: '"<b>after fail</b>"' });
    assert.ok(!lines.some((l) => l.includes('code=TG_API_SEND_OK')));
  });

  it('sendRichMessage failure followed by sendMessage success logs only TG_API_SEND_OK', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => {
          if (method === 'sendRichMessage') return failResult('rich blocked', 400);
          if (method === 'sendMessage') return okResult({ message_id: 602 });
          return okResult(true);
        },
        async (client) => {
          await assert.rejects(() => client.sendRichMessage(CHAT_ID, '<b>blocked</b>'));
          await client.sendMessage(CHAT_ID, 'after rich fail');
        },
      );
    });

    assert.equal(rawApiOnly(lines).length, 1);
    assertRawApiLog(lines, 'TG_API_SEND_OK', { hint: '602', text: '"after rich fail"' });
    assert.ok(!lines.some((l) => l.includes('code=TG_API_SEND_RICH_OK')));
  });

  it('getUpdates posts offset and timeout in request body', async () => {
    const { fetch: fetchFn, requests } = makeCapturingFetch((method) =>
      method === 'getUpdates' ? okResult([]) : okResult(true),
    );
    const orig = global.fetch;
    global.fetch = fetchFn;
    try {
      const client = new RawTelegramApiClient(BOT_TOKEN);
      await client.getUpdates(7, 3);
    } finally {
      global.fetch = orig;
    }

    const getUpdatesReq = requests.find((r) => r.method === 'getUpdates');
    assert.ok(getUpdatesReq?.body);
    assert.equal(getUpdatesReq!.body!.offset, 7);
    assert.equal(getUpdatesReq!.body!.timeout, 3);
  });

  it('logs TG_API_SEND_OK with empty preview quotes for empty sendMessage text', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendMessage' ? okResult({ message_id: 603 }) : okResult(true)),
        (client) => client.sendMessage(CHAT_ID, ''),
      );
    });

    assertRawApiLog(lines, 'TG_API_SEND_OK', { hint: '603', text: 'msgId=603 ""' });
  });

  it('two consecutive sendRichMessage calls emit two TG_API_SEND_RICH_OK logs', async () => {
    let richCalls = 0;
    const lines = await captureAll(async () => {
      await withClient(
        (method) => {
          if (method === 'sendRichMessage') {
            richCalls++;
            return okResult({ message_id: 700 + richCalls });
          }
          return okResult(true);
        },
        async (client) => {
          await client.sendRichMessage(CHAT_ID, '<b>rich one</b>');
          await client.sendRichMessage(CHAT_ID, '<b>rich two</b>');
        },
      );
    });

    assert.equal(richCalls, 2);
    assert.equal(rawApiOnly(lines).filter((l) => l.includes('code=TG_API_SEND_RICH_OK')).length, 2);
    assertRawApiLog(lines, 'TG_API_SEND_RICH_OK', { hint: '701', text: '"<b>rich one</b>"' });
    assertRawApiLog(lines, 'TG_API_SEND_RICH_OK', { hint: '702', text: '"<b>rich two</b>"' });
  });

  it('editForumTopic failure throws without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'editForumTopic' ? failResult('rename fail', 400) : okResult(true)),
        async (client) => {
          await assert.rejects(() => client.editForumTopic(CHAT_ID, THREAD_ID, 'Bad'), /editForumTopic/);
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('createForumTopic failure throws without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'createForumTopic' ? failResult('create fail', 400) : okResult(true)),
        async (client) => {
          await assert.rejects(() => client.createForumTopic(CHAT_ID, 'Bad topic'), /createForumTopic/);
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('getChatMember failure throws without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'getChatMember' ? failResult('not member', 400) : okResult(true)),
        async (client) => {
          await assert.rejects(() => client.getChatMember(CHAT_ID, 999), /getChatMember/);
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('answerCallbackQuery failure throws without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'answerCallbackQuery' ? failResult('expired', 400) : okResult(true)),
        async (client) => {
          await assert.rejects(() => client.answerCallbackQuery('cb-expired'), /answerCallbackQuery/);
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('setMyCommands failure throws without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'setMyCommands' ? failResult('commands fail', 400) : okResult(true)),
        async (client) => {
          await assert.rejects(
            () => client.setMyCommands([{ command: 'x', description: 'X' }]),
            /setMyCommands/,
          );
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('setChatMenuButton failure throws without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'setChatMenuButton' ? failResult('menu fail', 400) : okResult(true)),
        async (client) => {
          await assert.rejects(
            () => client.setChatMenuButton({ type: 'default' }, CHAT_ID),
            /setChatMenuButton/,
          );
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('sendMediaGroup multipart failure throws without TG_API codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-raw-api-album-fail-'));
    const p1 = join(dir, 'x.png');
    writeFileSync(p1, Buffer.from([0x89]));

    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendMediaGroup' ? failResult('album fail', 400) : okResult(true)),
        async (client) => {
          await assert.rejects(
            () => client.sendMediaGroup(CHAT_ID, [{ type: 'photo', path: p1 }]),
            (err: unknown) => {
              assert.equal((err as { error_code?: number }).error_code, 400);
              return true;
            },
          );
        },
      );
    });

    rmSync(dir, { recursive: true, force: true });
    assertNoRawApiLogs(lines);
  });

  it('getUpdates unknown error description throws without TG_API codes', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'getUpdates' ? jsonResponse({ ok: false }) : okResult(true)),
        async (client) => {
          await assert.rejects(() => client.getUpdates(0, 0), /getUpdates: unknown error/);
        },
      );
    });

    assertNoRawApiLogs(lines);
  });

  it('sendMessage posts chat_id and text in request body', async () => {
    const { fetch: fetchFn, requests } = makeCapturingFetch((method) =>
      method === 'sendMessage' ? okResult({ message_id: 801 }) : okResult(true),
    );
    const orig = global.fetch;
    global.fetch = fetchFn;
    try {
      const client = new RawTelegramApiClient(BOT_TOKEN);
      await client.sendMessage(CHAT_ID, 'body check', { message_thread_id: THREAD_ID });
    } finally {
      global.fetch = orig;
    }

    const req = requests.find((r) => r.method === 'sendMessage');
    assert.equal(req?.body?.chat_id, CHAT_ID);
    assert.equal(req?.body?.text, 'body check');
    assert.equal(req?.body?.message_thread_id, THREAD_ID);
  });

  it('sendRichMessage posts rich_message html in request body', async () => {
    const { fetch: fetchFn, requests } = makeCapturingFetch((method) =>
      method === 'sendRichMessage' ? okResult({ message_id: 802 }) : okResult(true),
    );
    const orig = global.fetch;
    global.fetch = fetchFn;
    try {
      const client = new RawTelegramApiClient(BOT_TOKEN);
      await client.sendRichMessage(CHAT_ID, '<b>body rich</b>');
    } finally {
      global.fetch = orig;
    }

    const req = requests.find((r) => r.method === 'sendRichMessage');
    const rich = req?.body?.rich_message as { html?: string } | undefined;
    assert.equal(rich?.html, '<b>body rich</b>');
  });

  it('logs TG_API_SEND_RICH_OK with threadId zero when message_thread_id is 0', async () => {
    const lines = await captureAll(async () => {
      await withClient(
        (method) => (method === 'sendRichMessage' ? okResult({ message_id: 803 }) : okResult(true)),
        (client) => client.sendRichMessage(CHAT_ID, '<b>general</b>', { message_thread_id: 0 }),
      );
    });

    assertRawApiLog(lines, 'TG_API_SEND_RICH_OK', { threadId: 0, hint: '803' });
  });

  it('alternating sendMessage and sendRichMessage emit four logs in call order', async () => {
    let seq = 0;
    const lines = await captureAll(async () => {
      await withClient(
        (method) => {
          if (method === 'sendMessage') {
            seq++;
            return okResult({ message_id: 900 + seq });
          }
          if (method === 'sendRichMessage') {
            seq++;
            return okResult({ message_id: 900 + seq });
          }
          return okResult(true);
        },
        async (client) => {
          await client.sendMessage(CHAT_ID, 'alt plain 1');
          await client.sendRichMessage(CHAT_ID, '<b>alt rich 1</b>');
          await client.sendMessage(CHAT_ID, 'alt plain 2');
          await client.sendRichMessage(CHAT_ID, '<b>alt rich 2</b>');
        },
      );
    });

    assert.equal(rawApiOnly(lines).length, 4);
    const codes = rawApiOnly(lines).map((l) => l.match(/code=(TG_[A-Z_]+)/)?.[1]);
    assert.deepEqual(codes, [
      'TG_API_SEND_OK',
      'TG_API_SEND_RICH_OK',
      'TG_API_SEND_OK',
      'TG_API_SEND_RICH_OK',
    ]);
    assertRawApiLog(lines, 'TG_API_SEND_OK', { hint: '901', text: '"alt plain 1"' });
    assertRawApiLog(lines, 'TG_API_SEND_RICH_OK', { hint: '902', text: '"<b>alt rich 1</b>"' });
    assertRawApiLog(lines, 'TG_API_SEND_OK', { hint: '903', text: '"alt plain 2"' });
    assertRawApiLog(lines, 'TG_API_SEND_RICH_OK', { hint: '904', text: '"<b>alt rich 2</b>"' });
  });
});

const SILENT_PATH_MARKERS = [
  'sendMessage API failure throws without TG_API_SEND_OK',
  'sendMessage unknown error description throws without TG_API_SEND_OK',
  'editMessageText success stays silent without TG_API codes',
  'editMessageText failure throws without TG_API codes',
  'sendRichMessage API failure throws without TG_API_SEND_RICH_OK',
  'editRichMessage success stays silent without TG_API codes',
  'deleteMessage success stays silent without TG_API codes',
  'getMe success stays silent without TG_API codes',
  'getUpdates success stays silent without TG_API codes',
  'getUpdates failure throws without TG_API codes',
  'sendChatAction success stays silent without TG_API codes',
  'createForumTopic success stays silent without TG_API codes',
  'answerCallbackQuery success stays silent without TG_API codes',
  'setMyCommands success stays silent without TG_API codes',
  'sendPhoto multipart success stays silent without TG_API codes',
  'sendPhoto multipart failure throws without TG_API codes',
  'sendDocument multipart success stays silent without TG_API codes',
  'sendMediaGroup multipart success stays silent without TG_API codes',
  'getChatMember success stays silent without TG_API codes',
  'getFile success stays silent without TG_API codes',
  'setChatMenuButton success stays silent without TG_API codes',
  'sendRichMessage unknown error description throws without TG_API_SEND_RICH_OK',
  'editRichMessage failure throws without TG_API codes',
  'deleteMessage failure throws without TG_API codes',
  'getUpdates ok without result field returns empty array silently',
  'editForumTopic success stays silent without TG_API codes',
  'deleteForumTopic success stays silent without TG_API codes',
  'deleteForumTopic failure throws without TG_API codes',
  'getFile failure throws without TG_API codes',
  'getMe failure throws without TG_API codes',
  'sendChatAction failure throws without TG_API codes',
  'sendDocument multipart failure throws without TG_API codes',
  'downloadFile success stays silent without TG_API codes',
  'sendMessage failure followed by sendRichMessage success logs only TG_API_SEND_RICH_OK',
  'sendRichMessage failure followed by sendMessage success logs only TG_API_SEND_OK',
  'getUpdates posts offset and timeout in request body',
  'editForumTopic failure throws without TG_API codes',
  'createForumTopic failure throws without TG_API codes',
  'getChatMember failure throws without TG_API codes',
  'answerCallbackQuery failure throws without TG_API codes',
  'setMyCommands failure throws without TG_API codes',
  'setChatMenuButton failure throws without TG_API codes',
  'sendMediaGroup multipart failure throws without TG_API codes',
  'getUpdates unknown error description throws without TG_API codes',
  'sendMessage posts chat_id and text in request body',
  'sendRichMessage posts rich_message html in request body',
  'downloadFile HTTP failure throws without TG_API codes',
] as const;

const RAW_API_PATH_MATRIX = [
  { kind: 'info' as const, code: 'TG_API_SEND_OK', marker: 'sendMessage with op send_message threadId chatId and hint msgId' },
  { kind: 'info' as const, code: 'TG_API_SEND_OK', marker: 'without threadId when sendMessage omits message_thread_id' },
  { kind: 'info' as const, code: 'TG_API_SEND_OK', marker: 'preview with collapsed whitespace in message text' },
  { kind: 'info' as const, code: 'TG_API_SEND_OK', marker: 'preview truncated to 60 characters' },
  { kind: 'info' as const, code: 'TG_API_SEND_OK', marker: 'exactly one TG_API_SEND_OK per sendMessage call' },
  { kind: 'info' as const, code: 'TG_API_SEND_OK', marker: 'parse_mode and reply_markup logs only one TG_API_SEND_OK' },
  { kind: 'info' as const, code: 'TG_API_SEND_OK', marker: 'consecutive sendMessage and sendRichMessage emit one code each in order' },
  { kind: 'info' as const, code: 'TG_API_SEND_OK', marker: 'two consecutive sendMessage calls emit two TG_API_SEND_OK logs' },
  { kind: 'info' as const, code: 'TG_API_SEND_OK', marker: 'threadId zero when message_thread_id is 0' },
  { kind: 'info' as const, code: 'TG_API_SEND_OK', marker: 'empty preview quotes for empty sendMessage text' },
  { kind: 'info' as const, code: 'TG_API_SEND_OK', marker: 'sendRichMessage failure followed by sendMessage success logs only TG_API_SEND_OK' },
  { kind: 'silent' as const, marker: 'sendMessage API failure throws without TG_API_SEND_OK' },
  { kind: 'silent' as const, marker: 'sendMessage unknown error description throws without TG_API_SEND_OK' },
  { kind: 'silent' as const, marker: 'editMessageText success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'editMessageText failure throws without TG_API codes' },
  { kind: 'info' as const, code: 'TG_API_SEND_RICH_OK', marker: 'sendRichMessage with op send_rich_message threadId chatId hint' },
  { kind: 'info' as const, code: 'TG_API_SEND_RICH_OK', marker: 'without threadId when sendRichMessage omits message_thread_id' },
  { kind: 'info' as const, code: 'TG_API_SEND_RICH_OK', marker: 'preview with collapsed whitespace in rich html' },
  { kind: 'info' as const, code: 'TG_API_SEND_RICH_OK', marker: 'preview truncated to 60 characters' },
  { kind: 'info' as const, code: 'TG_API_SEND_RICH_OK', marker: 'exactly one TG_API_SEND_RICH_OK per sendRichMessage call' },
  { kind: 'info' as const, code: 'TG_API_SEND_RICH_OK', marker: 'reply_markup logs only one TG_API_SEND_RICH_OK' },
  { kind: 'info' as const, code: 'TG_API_SEND_RICH_OK', marker: 'two consecutive sendRichMessage calls emit two TG_API_SEND_RICH_OK logs' },
  { kind: 'info' as const, code: 'TG_API_SEND_RICH_OK', marker: 'sendMessage failure followed by sendRichMessage success logs only TG_API_SEND_RICH_OK' },
  { kind: 'info' as const, code: 'TG_API_SEND_RICH_OK', marker: 'threadId zero when message_thread_id is 0' },
  { kind: 'info' as const, code: 'TG_API_SEND_RICH_OK', marker: 'alternating sendMessage and sendRichMessage emit four logs in call order' },
  { kind: 'silent' as const, marker: 'sendRichMessage unknown error description throws without TG_API_SEND_RICH_OK' },
  { kind: 'silent' as const, marker: 'sendRichMessage API failure throws without TG_API_SEND_RICH_OK' },
  { kind: 'silent' as const, marker: 'editRichMessage success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'editRichMessage failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'deleteMessage success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'deleteMessage failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'getMe success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'getUpdates success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'getUpdates failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'getUpdates ok without result field returns empty array silently' },
  { kind: 'silent' as const, marker: 'getUpdates unknown error description throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'getChatMember success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'getChatMember failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'getFile success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'setChatMenuButton success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'sendChatAction success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'createForumTopic success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'createForumTopic failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'editForumTopic success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'editForumTopic failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'deleteForumTopic success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'deleteForumTopic failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'getFile failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'getMe failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'sendChatAction failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'answerCallbackQuery success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'answerCallbackQuery failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'setMyCommands success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'setMyCommands failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'setChatMenuButton failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'sendPhoto multipart success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'sendPhoto multipart failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'sendDocument multipart success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'sendDocument multipart failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'sendMediaGroup multipart success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'sendMediaGroup multipart failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'downloadFile success stays silent without TG_API codes' },
  { kind: 'silent' as const, marker: 'downloadFile HTTP failure throws without TG_API codes' },
  { kind: 'silent' as const, marker: 'getUpdates posts offset and timeout in request body' },
  { kind: 'silent' as const, marker: 'sendMessage posts chat_id and text in request body' },
  { kind: 'silent' as const, marker: 'sendRichMessage posts rich_message html in request body' },
] as const;

describe('raw-api logging coverage', () => {
  it('asserts every raw-api code in test file', () => {
    const src = readFileSync(new URL('./raw-api-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of RAW_API_LOG_CODES) {
      assert.ok(
        src.includes(`assertRawApiLog(lines, '${code}'`) || src.includes(`code=${code}`),
        `missing assertion for ${code}`,
      );
    }
    assert.equal(RAW_API_LOG_CODES.length, 2);
  });

  it('raw-api.ts declares both codes in logging zone', () => {
    const zone = rawApiZoneSrc();
    for (const code of RAW_API_LOG_CODES) {
      assert.ok(zone.includes(`'${code}'`), `zone missing ${code}`);
    }
  });

  it('raw-api logging zone has zero console.log warn error', () => {
    const zone = rawApiZoneSrc();
    assert.ok(!zone.includes('console.log('));
    assert.ok(!zone.includes('console.warn('));
    assert.ok(!zone.includes('console.error('));
  });

  it('rawApiCtx uses scope telegram in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-api.ts', import.meta.url), 'utf-8');
    assert.match(src, /function rawApiCtx\(op: string[\s\S]*?scope: 'telegram'/);
  });

  it('logging zone declares exactly two log emission sites', () => {
    const zone = rawApiZoneSrc();
    assert.equal((zone.match(/logInfo\([\s\S]*?'TG_API_SEND_OK'/g) ?? []).length, 1);
    assert.equal((zone.match(/logInfo\([\s\S]*?'TG_API_SEND_RICH_OK'/g) ?? []).length, 1);
    assert.equal((zone.match(/logInfo\(/g) ?? []).length, 2);
  });

  it('call throws with error_code on API ok=false without logging in source', () => {
    const zone = rawApiZoneSrc();
    const callBody = zone.slice(zone.indexOf('private async call<T>'), zone.indexOf('async sendMessage'));
    assert.match(callBody, /if \(!data\.ok\)/);
    assert.match(callBody, /err\.error_code = data\.error_code/);
    assert.match(callBody, /throw err/);
    assert.ok(!callBody.includes('logInfo'));
    assert.ok(!callBody.includes('logError'));
  });

  it('call uses HTTP_TIMEOUT_MS AbortSignal in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-api.ts', import.meta.url), 'utf-8');
    assert.match(src, /const HTTP_TIMEOUT_MS = 30_000/);
    const zone = rawApiZoneSrc();
    const callBody = zone.slice(zone.indexOf('private async call<T>'), zone.indexOf('async sendMessage'));
    assert.match(callBody, /AbortSignal\.timeout\(HTTP_TIMEOUT_MS\)/);
  });

  it('sendMessage preview uses whitespace collapse and slice 60 in source', () => {
    const zone = rawApiZoneSrc();
    assert.match(zone, /text\.replace\(\/\\s\+\/g, ' '\)\.slice\(0, 60\)/);
    assert.match(zone, /richHtml\.replace\(\/\\s\+\/g, ' '\)\.slice\(0, 60\)/);
  });

  it('TG_API_SEND_OK uses rawApiCtx send_message with hint message_id in source', () => {
    const zone = rawApiZoneSrc();
    assert.match(
      zone,
      /logInfo\([\s\S]*?'TG_API_SEND_OK'[\s\S]*?rawApiCtx\('send_message', \{[\s\S]*?hint: String\(result\.message_id\)/,
    );
  });

  it('TG_API_SEND_RICH_OK uses rawApiCtx send_rich_message with threadId in source', () => {
    const zone = rawApiZoneSrc();
    assert.match(
      zone,
      /logInfo\([\s\S]*?'TG_API_SEND_RICH_OK'[\s\S]*?rawApiCtx\('send_rich_message', \{[\s\S]*?threadId: options\?\.message_thread_id/,
    );
  });

  it('getUpdates uses separate throw path without TG_API codes in source', () => {
    const zone = rawApiZoneSrc();
    const getUpdatesBody = zone.slice(zone.indexOf('async getUpdates'));
    assert.match(getUpdatesBody, /throw err/);
    assert.ok(!getUpdatesBody.includes('TG_API_SEND'));
  });

  it('callMultipart throws without logInfo in source', () => {
    const zone = rawApiZoneSrc();
    const multipart = zone.slice(zone.indexOf('private async callMultipart'), zone.indexOf('async sendPhoto'));
    assert.match(multipart, /if \(!data\.ok\)/);
    assert.ok(!multipart.includes('logInfo'));
  });

  it('edit and delete methods delegate to call without logInfo in source', () => {
    const zone = rawApiZoneSrc();
    const editMsg = zone.slice(zone.indexOf('async editMessageText'), zone.indexOf('async sendRichMessage'));
    const deleteMsg = zone.slice(zone.indexOf('async deleteMessage'), zone.indexOf('async sendChatAction'));
    assert.ok(!editMsg.includes('logInfo'));
    assert.ok(!deleteMsg.includes('logInfo'));
  });

  it('every covered code has assertRawApiLog in behavioral tests', () => {
    const src = readFileSync(new URL('./raw-api-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of RAW_API_LOG_CODES) {
      assert.ok(src.includes(`assertRawApiLog(lines, '${code}'`), `behavioral missing ${code}`);
    }
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./raw-api-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent marker: ${marker}`);
    }
  });

  it('path matrix rows map to behavioral test titles', () => {
    const src = readFileSync(new URL('./raw-api-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of RAW_API_PATH_MATRIX) {
      assert.ok(src.includes(row.marker), `matrix row missing test: ${row.marker}`);
    }
    assert.equal(RAW_API_PATH_MATRIX.length, 66);
  });

  it('raw-api zone batch logs omit itemId in source', () => {
    const zone = rawApiZoneSrc();
    assert.ok(!zone.includes('itemId'));
  });

  it('raw-api zone uses logInfo only without logWarn or logError in source', () => {
    const zone = rawApiZoneSrc();
    assert.ok(!zone.includes('logWarn('));
    assert.ok(!zone.includes('logError('));
    assert.equal((zone.match(/logInfo\(/g) ?? []).length, 2);
  });

  it('call error message includes Telegram API method prefix in source', () => {
    const zone = rawApiZoneSrc();
    const callBody = zone.slice(zone.indexOf('private async call<T>'), zone.indexOf('async sendMessage'));
    assert.match(callBody, /Telegram API \$\{method\}:/);
  });

  it('getUpdates returns result fallback empty array in source', () => {
    const zone = rawApiZoneSrc();
    assert.match(zone, /return data\.result \?\? \[\]/);
  });

  it('getUpdates posts allowed_updates message and callback_query in source', () => {
    const zone = rawApiZoneSrc();
    assert.match(zone, /allowed_updates: \['message', 'callback_query'\]/);
  });

  it('callMultipart and downloadFile use UPLOAD_TIMEOUT_MS in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-api.ts', import.meta.url), 'utf-8');
    assert.match(src, /const UPLOAD_TIMEOUT_MS = 120_000/);
    const zone = rawApiZoneSrc();
    const multipart = zone.slice(zone.indexOf('private async callMultipart'), zone.indexOf('async sendPhoto'));
    const download = zone.slice(zone.indexOf('async downloadFile'), zone.indexOf('private async callMultipart'));
    assert.match(multipart, /AbortSignal\.timeout\(UPLOAD_TIMEOUT_MS\)/);
    assert.match(download, /AbortSignal\.timeout\(UPLOAD_TIMEOUT_MS\)/);
  });

  it('sendMessage logs TG_API_SEND_OK only after successful call in source', () => {
    const zone = rawApiZoneSrc();
    const sendBody = zone.slice(zone.indexOf('async sendMessage'), zone.indexOf('async editMessageText'));
    const callIdx = sendBody.indexOf("await this.call<{ message_id: number }>('sendMessage'");
    const logIdx = sendBody.indexOf("logInfo(\n      'TG_API_SEND_OK'");
    assert.ok(callIdx >= 0 && logIdx > callIdx);
  });

  it('sendMessage and sendRichMessage include threadId only when message_thread_id not null in source', () => {
    const zone = rawApiZoneSrc();
    assert.match(zone, /if \(options\?\.message_thread_id != null\) body\.message_thread_id/);
    assert.match(zone, /threadId: options\?\.message_thread_id/);
  });

  it('forum topic edit and delete delegate to call without logInfo in source', () => {
    const zone = rawApiZoneSrc();
    const editTopic = zone.slice(zone.indexOf('async editForumTopic'), zone.indexOf('async deleteForumTopic'));
    const deleteTopic = zone.slice(zone.indexOf('async deleteForumTopic'), zone.indexOf('async setMyCommands'));
    assert.ok(!editTopic.includes('logInfo'));
    assert.ok(!deleteTopic.includes('logInfo'));
  });

  it('getUpdates error message uses getUpdates prefix not Telegram API in source', () => {
    const zone = rawApiZoneSrc();
    const getUpdatesBody = zone.slice(zone.indexOf('async getUpdates'));
    assert.match(getUpdatesBody, /getUpdates: \$\{data\.description/);
    assert.ok(!getUpdatesBody.includes('Telegram API getUpdates'));
  });

  it('sendRichMessage logs TG_API_SEND_RICH_OK only after successful call in source', () => {
    const zone = rawApiZoneSrc();
    const richBody = zone.slice(zone.indexOf('async sendRichMessage'), zone.indexOf('async editRichMessage'));
    const callIdx = richBody.indexOf("await this.call<{ message_id: number }>('sendRichMessage'");
    const logIdx = richBody.indexOf("logInfo(\n      'TG_API_SEND_RICH_OK'");
    assert.ok(callIdx >= 0 && logIdx > callIdx);
  });

  it('call uses POST with Content-Type application/json in source', () => {
    const zone = rawApiZoneSrc();
    const callBody = zone.slice(zone.indexOf('private async call<T>'), zone.indexOf('async sendMessage'));
    assert.match(callBody, /method: 'POST'/);
    assert.match(callBody, /'Content-Type': 'application\/json'/);
  });

  it('getUpdates combines external signal with timeout via AbortSignal.any in source', () => {
    const zone = rawApiZoneSrc();
    assert.match(zone, /AbortSignal\.any\(\[signal, timeoutSignal\]\)/);
    assert.match(zone, /AbortSignal\.timeout\(\(timeout \+ 10\) \* 1000\)/);
  });

  it('constructor builds baseUrl from bot token in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-api.ts', import.meta.url), 'utf-8');
    assert.match(src, /this\.baseUrl = `https:\/\/api\.telegram\.org\/bot\$\{botToken\}`/);
  });

  it('setMyCommands includes scope only when provided in source', () => {
    const zone = rawApiZoneSrc();
    const body = zone.slice(zone.indexOf('async setMyCommands'), zone.indexOf('async setChatMenuButton'));
    assert.match(body, /if \(scope\) body\.scope = scope/);
    assert.ok(!body.includes('logInfo'));
  });

  it('editRichMessage delegates to editMessageText API in source', () => {
    const zone = rawApiZoneSrc();
    const richEdit = zone.slice(zone.indexOf('async editRichMessage'), zone.indexOf('async deleteMessage'));
    assert.match(richEdit, /await this\.call\('editMessageText', body\)/);
    assert.match(richEdit, /rich_message: \{ html: richHtml \}/);
    assert.ok(!richEdit.includes('logInfo'));
  });

  it('sendMessage parse_mode and reply_markup optional guards in source', () => {
    const zone = rawApiZoneSrc();
    const sendBody = zone.slice(zone.indexOf('async sendMessage'), zone.indexOf('async editMessageText'));
    assert.match(sendBody, /if \(options\?\.parse_mode\) body\.parse_mode/);
    assert.match(sendBody, /if \(options\?\.reply_markup\) body\.reply_markup/);
  });

  it('answerCallbackQuery text optional guard in source', () => {
    const zone = rawApiZoneSrc();
    const body = zone.slice(zone.indexOf('async answerCallbackQuery'), zone.indexOf('async getFile'));
    assert.match(body, /if \(options\?\.text\) body\.text/);
    assert.ok(!body.includes('logInfo'));
  });

  it('setChatMenuButton chatId optional guard in source', () => {
    const zone = rawApiZoneSrc();
    const body = zone.slice(zone.indexOf('async setChatMenuButton'), zone.indexOf('async getMe'));
    assert.match(body, /if \(chatId !== undefined\) body\.chat_id = chatId/);
    assert.ok(!body.includes('logInfo'));
  });

  it('callMultipart error uses Telegram API method prefix in source', () => {
    const zone = rawApiZoneSrc();
    const multipart = zone.slice(zone.indexOf('private async callMultipart'), zone.indexOf('async sendPhoto'));
    assert.match(multipart, /Telegram API \$\{method\}:/);
    assert.match(multipart, /err\.error_code = data\.error_code/);
  });

  it('downloadFile writes response bytes via writeFileSync in source', () => {
    const zone = rawApiZoneSrc();
    const download = zone.slice(zone.indexOf('async downloadFile'), zone.indexOf('private async callMultipart'));
    assert.match(download, /writeFileSync\(destPath/);
    assert.ok(!download.includes('logInfo'));
  });

  it('logInfo imported from core log-event in source', () => {
    const src = readFileSync(new URL('../../src/telegram/transport/raw-api.ts', import.meta.url), 'utf-8');
    assert.match(src, /import \{ logInfo \} from '\.\.\/\.\.\/core\/log-event\.js'/);
    assert.ok(!src.includes("import { logError"));
    assert.ok(!src.includes("import { logWarn"));
  });

  it('automated matrix: info codes have behavioral assertRawApiLog', () => {
    const codes = RAW_API_PATH_MATRIX.filter((r) => r.kind !== 'silent').map((r) =>
      'code' in r ? r.code : '',
    );
    const unique = [...new Set(codes.filter(Boolean))];
    const src = readFileSync(new URL('./raw-api-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of unique) {
      assert.ok(src.includes(`assertRawApiLog(lines, '${code}'`), `matrix code missing assert: ${code}`);
    }
    assert.equal(unique.length, 2);
  });
});
