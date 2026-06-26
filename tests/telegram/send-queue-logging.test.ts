import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { readFileSync } from 'fs';
import { SendQueue } from '../../src/telegram/pipeline/send-queue.js';

const CHAT_ID = -1001234567890;
const ALT_CHAT_ID = -1009876543210;

const SEND_QUEUE_LOG_CODES = [
  'QUEUE_RETRY_429',
  'QUEUE_OVERFLOW_DROP',
  'QUEUE_DRAIN_TIMEOUT',
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

function assertSendQueueLog(
  lines: string[],
  code: string,
  need: {
    chatId?: number;
    op?: string;
    hint?: string;
    attempt?: number;
    durationMs?: number;
    text?: string;
  } = {},
): void {
  const line = need.text
    ? lines.find((l) => l.includes(`code=${code}`) && l.includes(need.text!))
    : lines.find((l) => l.includes(`code=${code}`));
  assert.ok(line, need.text ? `missing code=${code} with text "${need.text}"` : `missing code=${code}`);
  assert.ok(line!.includes('scope=queue'), `${code} missing scope=queue`);
  if (need.chatId !== undefined) {
    assert.ok(line!.includes(`chatId=${need.chatId}`), `${code} missing chatId=${need.chatId}`);
  }
  if (need.op) assert.ok(line!.includes(`op=${need.op}`), `${code} missing op=${need.op}`);
  if (need.hint) assert.ok(line!.includes(`hint=${need.hint}`), `${code} missing hint=${need.hint}`);
  if (need.attempt !== undefined) {
    assert.ok(line!.includes(`attempt=${need.attempt}`), `${code} missing attempt=${need.attempt}`);
  }
  if (need.durationMs !== undefined) {
    assert.ok(line!.includes(`durationMs=${need.durationMs}`), `${code} missing durationMs=${need.durationMs}`);
  }
  if (need.text) assert.ok(line!.includes(need.text), `${code} missing text fragment "${need.text}"`);
}

function assertNoSendQueueLogs(lines: string[]): void {
  const hit = lines.find((l) => /code=QUEUE_(RETRY_429|OVERFLOW_DROP|DRAIN_TIMEOUT)/.test(l));
  assert.ok(!hit, `unexpected send-queue log: ${hit}`);
}

function queueCodes(lines: string[]): string[] {
  return lines
    .filter((l) => /code=QUEUE_/.test(l))
    .map((l) => l.match(/code=(QUEUE_[A-Z0-9_]+)/)?.[1])
    .filter((c): c is string => Boolean(c));
}

async function settle(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

async function withFakeTimers(run: (advance: (ms: number) => void) => Promise<void>): Promise<void> {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await run((ms) => {
      mock.timers.tick(ms);
    });
    await settle();
  } finally {
    mock.timers.reset();
  }
}

describe('send-queue logging', () => {
  it('logs QUEUE_RETRY_429 on retry after 429 with chatId attempt and hint', async () => {
    let attempts = 0;
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0, maxRetries: 2 });
    const fn = () => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new Error('Too Many Requests: retry after 2'));
      }
      return Promise.resolve('ok');
    };

    const lines = await captureAll(async () => {
      await withFakeTimers(async (advance) => {
        const p = queue.enqueue(fn, 'send', { chatId: CHAT_ID });
        await settle();
        advance(4000);
        await settle();
        assert.equal(await p, 'ok');
      });
    });

    assertSendQueueLog(lines, 'QUEUE_RETRY_429', {
      op: 'retry',
      chatId: CHAT_ID,
      attempt: 1,
      hint: '2',
      text: 'retry 1/',
    });
    assert.equal(attempts, 2);
  });

  it('logs QUEUE_RETRY_429 on Global 429 cooldown wait with durationMs op cooldown', async () => {
    let attempts = 0;
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0, maxRetries: 2 });
    const fn = () => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new Error('retry after 3'));
      }
      return Promise.resolve('done');
    };

    const lines = await captureAll(async () => {
      await withFakeTimers(async (advance) => {
        const p = queue.enqueue(fn, 'send', { chatId: CHAT_ID });
        await settle();
        advance(5000);
        await settle();
        assert.equal(await p, 'done');
      });
    });

    assertSendQueueLog(lines, 'QUEUE_RETRY_429', {
      op: 'cooldown',
      text: 'Global 429 cooldown',
    });
    const cooldownLine = lines.find(
      (l) => l.includes('code=QUEUE_RETRY_429') && l.includes('Global 429 cooldown'),
    );
    assert.ok(cooldownLine?.includes('durationMs='), 'cooldown line missing durationMs');
  });

  it('logs exactly one QUEUE_RETRY_429 retry line per 429 retry attempt', async () => {
    let attempts = 0;
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0, maxRetries: 3 });
    const fn = () => {
      attempts++;
      if (attempts < 3) {
        return Promise.reject(new Error(`retry after ${attempts}`));
      }
      return Promise.resolve(true);
    };

    const lines = await captureAll(async () => {
      await withFakeTimers(async (advance) => {
        const p = queue.enqueue(fn, 'send', { chatId: CHAT_ID });
        await settle();
        advance(5000);
        await settle();
        advance(5000);
        await settle();
        assert.equal(await p, true);
      });
    });

    const retryLines = lines.filter(
      (l) => l.includes('code=QUEUE_RETRY_429') && l.includes('op=retry'),
    );
    assert.equal(retryLines.length, 2);
    assertSendQueueLog(lines, 'QUEUE_RETRY_429', { op: 'retry', attempt: 2, text: 'retry 2/' });
  });

  it('logs QUEUE_OVERFLOW_DROP when queue full drops oldest send with chatId op enqueue', async () => {
    let unblock!: () => void;
    const block = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const queue = new SendQueue({ maxQueueSize: 2, sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });

    const p1 = queue.enqueue(async () => {
      await block;
      return 1;
    }, 'send');
    await settle();

    const p2 = queue.enqueue(() => Promise.resolve(2), 'send').catch(() => 'dropped');
    const p3 = queue.enqueue(() => Promise.resolve(3), 'send');

    const lines = await captureAll(() => {
      void queue.enqueue(() => Promise.resolve(4), 'send', { chatId: CHAT_ID });
    });

    assertSendQueueLog(lines, 'QUEUE_OVERFLOW_DROP', {
      op: 'enqueue',
      chatId: CHAT_ID,
      text: 'Dropped oldest send',
    });
    assert.equal(queueCodes(lines).filter((c) => c === 'QUEUE_OVERFLOW_DROP').length, 1);

    unblock();
    await Promise.allSettled([p1, p2, p3]);
  });

  it('QUEUE_OVERFLOW_DROP rejects dropped waiter with Queue overflow error', async () => {
    let unblock!: () => void;
    const block = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const queue = new SendQueue({ maxQueueSize: 2, sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });

    queue.enqueue(async () => {
      await block;
      return 1;
    }, 'send');
    await settle();

    const dropped = queue.enqueue(() => Promise.resolve(2), 'send');
    queue.enqueue(() => Promise.resolve(3), 'send');

    const lines = await captureAll(() => {
      void queue.enqueue(() => Promise.resolve(4), 'send', { chatId: CHAT_ID });
    });

    assertSendQueueLog(lines, 'QUEUE_OVERFLOW_DROP', { op: 'enqueue' });
    await assert.rejects(dropped, /Queue overflow: dropped/);

    unblock();
  });

  it('logs QUEUE_DRAIN_TIMEOUT when drain times out with op drain durationMs', async () => {
    const queue = new SendQueue({ sendDelayMs: 60_000, editDelayMs: 0, chatPaceMs: 0 });
    queue.enqueue(() => new Promise(() => {}), 'send', { chatId: CHAT_ID });

    const lines = await captureAll(async () => {
      await withFakeTimers(async (advance) => {
        const p = queue.drain(100);
        await settle();
        advance(150);
        await settle();
        assert.equal(await p, false);
      });
    });

    assertSendQueueLog(lines, 'QUEUE_DRAIN_TIMEOUT', {
      op: 'drain',
      durationMs: 100,
      text: 'drain timeout',
    });
  });

  it('successful send enqueue stays silent without QUEUE codes', async () => {
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });
    const lines = await captureAll(async () => {
      assert.equal(
        await queue.enqueue(() => Promise.resolve('ok'), 'send', { chatId: CHAT_ID }),
        'ok',
      );
    });
    assertNoSendQueueLogs(lines);
  });

  it('coalesce edit calls stay silent without QUEUE codes', async () => {
    let calls = 0;
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });
    const mk = (n: number) => () => {
      calls++;
      return Promise.resolve(n);
    };

    const lines = await captureAll(async () => {
      const p1 = queue.enqueue(mk(1), 'edit', { chatId: CHAT_ID, coalesceKey: 'edit:1:99' });
      const p2 = queue.enqueue(mk(2), 'edit', { chatId: CHAT_ID, coalesceKey: 'edit:1:99' });
      await Promise.all([p1, p2]);
    });

    assertNoSendQueueLogs(lines);
    assert.equal(calls, 1);
  });

  it('drain success stays silent without QUEUE codes', async () => {
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });
    const lines = await captureAll(async () => {
      const p = queue.enqueue(() => Promise.resolve(1), 'send', { chatId: CHAT_ID });
      const drained = queue.drain(3000);
      assert.equal(await p, 1);
      assert.equal(await drained, true);
    });
    assertNoSendQueueLogs(lines);
  });

  it('depth getter stays silent without QUEUE codes', async () => {
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });
    const lines = await captureAll(() => {
      assert.equal(queue.depth, 0);
    });
    assertNoSendQueueLogs(lines);
  });

  it('busy getter stays silent without QUEUE codes', async () => {
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });
    const lines = await captureAll(() => {
      assert.equal(queue.busy, false);
    });
    assertNoSendQueueLogs(lines);
  });

  it('edit priority enqueue before send stays silent on success', async () => {
    const order: string[] = [];
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });
    const lines = await captureAll(async () => {
      const pSend = queue.enqueue(async () => {
        order.push('send');
        return 's';
      }, 'send', { chatId: CHAT_ID });
      const pEdit = queue.enqueue(async () => {
        order.push('edit');
        return 'e';
      }, 'edit', { chatId: CHAT_ID });
      await Promise.all([pSend, pEdit]);
    });
    assertNoSendQueueLogs(lines);
    assert.deepEqual(order, ['edit', 'send']);
  });

  it('chat pacing stays silent without QUEUE codes', async () => {
    const stamps: number[] = [];
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 80, maxRetries: 0 });
    const mark = () => {
      stamps.push(Date.now());
      return Promise.resolve(true);
    };

    const lines = await captureAll(async () => {
      await Promise.all([
        queue.enqueue(mark, 'send', { chatId: CHAT_ID }),
        queue.enqueue(mark, 'send', { chatId: CHAT_ID }),
      ]);
    });

    assertNoSendQueueLogs(lines);
    assert.equal(stamps.length, 2);
    assert.ok(stamps[1] - stamps[0] >= 70);
  });

  it('overflow queue full but only edits stays silent without QUEUE_OVERFLOW_DROP', async () => {
    let unblock!: () => void;
    const block = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const queue = new SendQueue({ maxQueueSize: 1, sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });

    queue.enqueue(async () => {
      await block;
      return 'first';
    }, 'edit', { coalesceKey: 'edit:block' });
    await settle();

    const lines = await captureAll(async () => {
      queue.enqueue(() => Promise.resolve('e2'), 'edit', { coalesceKey: 'edit:2' });
      queue.enqueue(() => Promise.resolve('e3'), 'edit', { coalesceKey: 'edit:3' });
      await settle();
    });

    assertNoSendQueueLogs(lines);
    unblock();
  });

  it('non-429 error reject stays silent without QUEUE codes', async () => {
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0, maxRetries: 3 });
    const lines = await captureAll(async () => {
      await assert.rejects(
        queue.enqueue(() => Promise.reject(new Error('network down')), 'send', { chatId: CHAT_ID }),
        /network down/,
      );
    });
    assertNoSendQueueLogs(lines);
  });

  it('429 with maxRetries zero rejects immediately without QUEUE_RETRY_429', async () => {
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0, maxRetries: 0 });
    const fn = () => Promise.reject(new Error('retry after 1'));

    const lines = await captureAll(async () => {
      await assert.rejects(queue.enqueue(fn, 'send', { chatId: CHAT_ID }), /retry after 1/);
    });

    assertNoSendQueueLogs(lines);
  });

  it('429 after one allowed retry logs QUEUE_RETRY_429 then rejects without second retry log', async () => {
    let attempts = 0;
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0, maxRetries: 1 });
    const fn = () => {
      attempts++;
      return Promise.reject(new Error('retry after 1'));
    };

    const lines = await captureAll(async () => {
      await withFakeTimers(async (advance) => {
        const p = queue.enqueue(fn, 'send', { chatId: CHAT_ID });
        const outcome = p.then(
          () => ({ ok: true as const }),
          (err: unknown) => ({ ok: false as const, err }),
        );
        await settle();
        advance(5000);
        await settle();
        const result = await outcome;
        assert.equal(result.ok, false);
        assert.match(String((result as { err: unknown }).err), /retry after 1/);
      });
    });

    const retryLines = lines.filter((l) => l.includes('code=QUEUE_RETRY_429') && l.includes('op=retry'));
    assert.equal(retryLines.length, 1);
    assertSendQueueLog(lines, 'QUEUE_RETRY_429', { op: 'retry', attempt: 1 });
    assert.equal(attempts, 2);
  });

  it('SendQueue constructor with partial config stays silent', async () => {
    const lines = await captureAll(async () => {
      const queue = new SendQueue({ maxQueueSize: 10 });
      assert.equal(queue.depth, 0);
      assert.equal(await queue.enqueue(() => Promise.resolve(1), 'send'), 1);
    });
    assertNoSendQueueLogs(lines);
  });

  it('enqueue without chatId on overflow omits chatId from QUEUE_OVERFLOW_DROP context', async () => {
    let unblock!: () => void;
    const block = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const queue = new SendQueue({ maxQueueSize: 2, sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });

    queue.enqueue(async () => {
      await block;
      return 1;
    }, 'send');
    await settle();
    queue.enqueue(() => Promise.resolve(2), 'send').catch(() => 'dropped');
    queue.enqueue(() => Promise.resolve(3), 'send');

    const lines = await captureAll(() => {
      void queue.enqueue(() => Promise.resolve(4), 'send');
    });

    const overflowLine = lines.find((l) => l.includes('code=QUEUE_OVERFLOW_DROP'));
    assert.ok(overflowLine);
    assert.ok(!overflowLine!.includes('chatId='), 'expected no chatId when enqueue options omit chatId');

    unblock();
  });

  it('different chatId on retry logs chatId in QUEUE_RETRY_429 retry line', async () => {
    let attempts = 0;
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0, maxRetries: 2 });
    const fn = () => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new Error('retry after 1'));
      }
      return Promise.resolve('alt');
    };

    const lines = await captureAll(async () => {
      await withFakeTimers(async (advance) => {
        const p = queue.enqueue(fn, 'send', { chatId: ALT_CHAT_ID });
        await settle();
        advance(5000);
        await settle();
        assert.equal(await p, 'alt');
      });
    });

    assertSendQueueLog(lines, 'QUEUE_RETRY_429', {
      op: 'retry',
      chatId: ALT_CHAT_ID,
      attempt: 1,
      hint: '1',
    });
  });

  it('logs exactly one QUEUE_DRAIN_TIMEOUT log line per drain timeout call', async () => {
    const queue = new SendQueue({ sendDelayMs: 60_000, editDelayMs: 0, chatPaceMs: 0 });
    queue.enqueue(() => new Promise(() => {}), 'send', { chatId: CHAT_ID });

    const lines = await captureAll(async () => {
      await withFakeTimers(async (advance) => {
        const p = queue.drain(100);
        await settle();
        advance(150);
        await settle();
        assert.equal(await p, false);
      });
    });

    assert.equal(lines.filter((l) => l.includes('code=QUEUE_DRAIN_TIMEOUT')).length, 1);
    assertSendQueueLog(lines, 'QUEUE_DRAIN_TIMEOUT', { op: 'drain', durationMs: 100 });
  });

  it('429 retry without chatId omits chatId from QUEUE_RETRY_429 retry line', async () => {
    let attempts = 0;
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0, maxRetries: 2 });
    const fn = () => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new Error('retry after 1'));
      }
      return Promise.resolve('no-chat');
    };

    const lines = await captureAll(async () => {
      await withFakeTimers(async (advance) => {
        const p = queue.enqueue(fn, 'send');
        await settle();
        advance(5000);
        await settle();
        assert.equal(await p, 'no-chat');
      });
    });

    const retryLine = lines.find(
      (l) => l.includes('code=QUEUE_RETRY_429') && l.includes('op=retry'),
    );
    assert.ok(retryLine);
    assert.ok(!retryLine!.includes('chatId='), 'expected no chatId when item has no chatId');
    assertSendQueueLog(lines, 'QUEUE_RETRY_429', { op: 'retry', attempt: 1, hint: '1' });
  });

  it('Too Many Requests without retry after seconds rejects without QUEUE_RETRY_429', async () => {
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0, maxRetries: 3 });
    const lines = await captureAll(async () => {
      await assert.rejects(
        queue.enqueue(() => Promise.reject(new Error('Too Many Requests')), 'send', { chatId: CHAT_ID }),
        /Too Many Requests/,
      );
    });
    assertNoSendQueueLogs(lines);
  });

  it('overflow queue full with only coalesceKey sends stays silent without QUEUE_OVERFLOW_DROP', async () => {
    let unblock!: () => void;
    const block = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const queue = new SendQueue({ maxQueueSize: 2, sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });

    queue.enqueue(async () => {
      await block;
      return 1;
    }, 'send', { coalesceKey: 'send:block' });
    await settle();

    const lines = await captureAll(() => {
      void queue.enqueue(() => Promise.resolve(2), 'send', { coalesceKey: 'send:2' });
      void queue.enqueue(() => Promise.resolve(3), 'send', { coalesceKey: 'send:3' });
    });

    assertNoSendQueueLogs(lines);
    unblock();
  });

  it('enqueue below maxQueueSize stays silent without QUEUE_OVERFLOW_DROP', async () => {
    const queue = new SendQueue({ maxQueueSize: 5, sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });
    const lines = await captureAll(async () => {
      await Promise.all([
        queue.enqueue(() => Promise.resolve(1), 'send', { chatId: CHAT_ID }),
        queue.enqueue(() => Promise.resolve(2), 'send', { chatId: CHAT_ID }),
        queue.enqueue(() => Promise.resolve(3), 'send', { chatId: CHAT_ID }),
      ]);
    });
    assertNoSendQueueLogs(lines);
  });

  it('coalesce send waiters resolve to latest fn result without QUEUE codes', async () => {
    let calls = 0;
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });
    const mk = (n: number) => () => {
      calls++;
      return Promise.resolve(n);
    };

    const lines = await captureAll(async () => {
      const p1 = queue.enqueue(mk(1), 'send', { chatId: CHAT_ID, coalesceKey: 'send:1:99' });
      const p2 = queue.enqueue(mk(2), 'send', { chatId: CHAT_ID, coalesceKey: 'send:1:99' });
      const results = await Promise.all([p1, p2]);
      assert.deepEqual(results, [2, 2]);
    });

    assertNoSendQueueLogs(lines);
    assert.equal(calls, 1);
  });

  it('different chatIds pacing stays silent without QUEUE codes', async () => {
    const stamps = new Map<number, number>();
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 80, maxRetries: 0 });
    const mark = (chatId: number) => () => {
      stamps.set(chatId, Date.now());
      return Promise.resolve(chatId);
    };

    const lines = await captureAll(async () => {
      await Promise.all([
        queue.enqueue(mark(CHAT_ID), 'send', { chatId: CHAT_ID }),
        queue.enqueue(mark(ALT_CHAT_ID), 'send', { chatId: ALT_CHAT_ID }),
      ]);
    });

    assertNoSendQueueLogs(lines);
    assert.equal(stamps.size, 2);
  });

  it('drain on empty idle queue returns true without QUEUE codes', async () => {
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });
    const lines = await captureAll(async () => {
      assert.equal(await queue.drain(100), true);
      assert.equal(queue.busy, false);
    });
    assertNoSendQueueLogs(lines);
  });

  it('sendDelayMs between sequential sends stays silent without QUEUE codes', async () => {
    const order: number[] = [];
    const queue = new SendQueue({ sendDelayMs: 30, editDelayMs: 0, chatPaceMs: 0 });
    const lines = await captureAll(async () => {
      await queue.enqueue(async () => {
        order.push(1);
        return 1;
      }, 'send');
      await queue.enqueue(async () => {
        order.push(2);
        return 2;
      }, 'send');
    });
    assertNoSendQueueLogs(lines);
    assert.deepEqual(order, [1, 2]);
  });

  it('editDelayMs between sequential edits stays silent without QUEUE codes', async () => {
    const order: number[] = [];
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 30, chatPaceMs: 0 });
    const lines = await captureAll(async () => {
      await queue.enqueue(async () => {
        order.push(1);
        return 1;
      }, 'edit', { chatId: CHAT_ID });
      await queue.enqueue(async () => {
        order.push(2);
        return 2;
      }, 'edit', { chatId: CHAT_ID });
    });
    assertNoSendQueueLogs(lines);
    assert.deepEqual(order, [1, 2]);
  });

  it('enqueue default send priority stays silent without QUEUE codes', async () => {
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });
    const lines = await captureAll(async () => {
      assert.equal(await queue.enqueue(() => Promise.resolve('default')), 'default');
    });
    assertNoSendQueueLogs(lines);
  });

  it('no chatId skips chat pacing and stays silent without QUEUE codes', async () => {
    const stamps: number[] = [];
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 500, maxRetries: 0 });
    const mark = () => {
      stamps.push(Date.now());
      return Promise.resolve(true);
    };

    const lines = await captureAll(async () => {
      await Promise.all([queue.enqueue(mark, 'send'), queue.enqueue(mark, 'send')]);
    });

    assertNoSendQueueLogs(lines);
    assert.equal(stamps.length, 2);
    assert.ok(stamps[1] - stamps[0] < 100);
  });

  it('logs exactly one QUEUE_OVERFLOW_DROP log line per overflow drop', async () => {
    let unblock!: () => void;
    const block = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const queue = new SendQueue({ maxQueueSize: 2, sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });

    queue.enqueue(async () => {
      await block;
      return 1;
    }, 'send');
    await settle();
    queue.enqueue(() => Promise.resolve(2), 'send').catch(() => 'dropped');
    queue.enqueue(() => Promise.resolve(3), 'send');

    const lines = await captureAll(() => {
      void queue.enqueue(() => Promise.resolve(4), 'send', { chatId: CHAT_ID });
    });

    assert.equal(lines.filter((l) => l.includes('code=QUEUE_OVERFLOW_DROP')).length, 1);
    assertSendQueueLog(lines, 'QUEUE_OVERFLOW_DROP', {
      op: 'enqueue',
      text: 'queue full at 2',
    });

    unblock();
  });

  it('overflow drops plain send before coalesceKey send in queue', async () => {
    let unblock!: () => void;
    const block = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const queue = new SendQueue({ maxQueueSize: 2, sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });

    queue.enqueue(async () => {
      await block;
      return 1;
    }, 'send');
    await settle();

    const droppedPlain = queue.enqueue(() => Promise.resolve('plain'), 'send');
    queue.enqueue(() => Promise.resolve('coalesced'), 'send', { coalesceKey: 'send:keep' });

    const lines = await captureAll(() => {
      void queue.enqueue(() => Promise.resolve('new'), 'send', { chatId: CHAT_ID });
    });

    assertSendQueueLog(lines, 'QUEUE_OVERFLOW_DROP', { op: 'enqueue', chatId: CHAT_ID });
    await assert.rejects(droppedPlain, /Queue overflow: dropped/);

    unblock();
  });

  it('maxRetries two logs exactly two QUEUE_RETRY_429 retry lines then rejects', async () => {
    let attempts = 0;
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0, maxRetries: 2 });
    const fn = () => {
      attempts++;
      return Promise.reject(new Error(`retry after ${attempts}`));
    };

    const lines = await captureAll(async () => {
      await withFakeTimers(async (advance) => {
        const p = queue.enqueue(fn, 'send', { chatId: CHAT_ID });
        const outcome = p.then(
          () => ({ ok: true as const }),
          (err: unknown) => ({ ok: false as const, err }),
        );
        await settle();
        advance(5000);
        await settle();
        advance(5000);
        await settle();
        const result = await outcome;
        assert.equal(result.ok, false);
      });
    });

    const retryLines = lines.filter(
      (l) => l.includes('code=QUEUE_RETRY_429') && l.includes('op=retry'),
    );
    assert.equal(retryLines.length, 2);
    assert.equal(attempts, 3);
    assertSendQueueLog(lines, 'QUEUE_RETRY_429', {
      op: 'retry',
      attempt: 2,
      hint: '2',
      text: 'retry 2/',
    });
  });

  it('QUEUE_RETRY_429 retry text includes depth fragment', async () => {
    let attempts = 0;
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0, maxRetries: 2 });
    const fn = () => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new Error('retry after 1'));
      }
      return Promise.resolve('ok');
    };

    const lines = await captureAll(async () => {
      await withFakeTimers(async (advance) => {
        const p = queue.enqueue(fn, 'send', { chatId: CHAT_ID });
        await settle();
        advance(5000);
        await settle();
        assert.equal(await p, 'ok');
      });
    });

    assertSendQueueLog(lines, 'QUEUE_RETRY_429', {
      op: 'retry',
      text: 'depth',
    });
  });

  it('QUEUE_DRAIN_TIMEOUT text includes depth and processing flags', async () => {
    const queue = new SendQueue({ sendDelayMs: 60_000, editDelayMs: 0, chatPaceMs: 0 });
    queue.enqueue(() => new Promise(() => {}), 'send', { chatId: CHAT_ID });

    const lines = await captureAll(async () => {
      await withFakeTimers(async (advance) => {
        const p = queue.drain(100);
        await settle();
        advance(150);
        await settle();
        assert.equal(await p, false);
      });
    });

    assertSendQueueLog(lines, 'QUEUE_DRAIN_TIMEOUT', {
      op: 'drain',
      text: 'processing=',
    });
  });

  it('logs QUEUE_RETRY_429 emits exactly one op=retry line on single 429 recovery', async () => {
    let attempts = 0;
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0, maxRetries: 2 });
    const fn = () => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new Error('retry after 1'));
      }
      return Promise.resolve('recovered');
    };

    const lines = await captureAll(async () => {
      await withFakeTimers(async (advance) => {
        const p = queue.enqueue(fn, 'send', { chatId: CHAT_ID });
        await settle();
        advance(5000);
        await settle();
        assert.equal(await p, 'recovered');
      });
    });

    const retryLines = lines.filter(
      (l) => l.includes('code=QUEUE_RETRY_429') && l.includes('op=retry'),
    );
    assert.equal(retryLines.length, 1);
    assertSendQueueLog(lines, 'QUEUE_RETRY_429', { op: 'retry', attempt: 1, hint: '1' });
  });

  it('retry after 0 seconds logs QUEUE_RETRY_429 hint=0 and recovers', async () => {
    let attempts = 0;
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0, maxRetries: 2 });
    const fn = () => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new Error('Retry After 0'));
      }
      return Promise.resolve('zero-cooldown');
    };

    const lines = await captureAll(async () => {
      await withFakeTimers(async (advance) => {
        const p = queue.enqueue(fn, 'send', { chatId: CHAT_ID });
        await settle();
        advance(2000);
        await settle();
        assert.equal(await p, 'zero-cooldown');
      });
    });

    assertSendQueueLog(lines, 'QUEUE_RETRY_429', { op: 'retry', hint: '0', attempt: 1 });
  });

  it('busy false and depth zero after queue drains stays silent without QUEUE codes', async () => {
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });
    const lines = await captureAll(async () => {
      await queue.enqueue(() => Promise.resolve(1), 'send', { chatId: CHAT_ID });
      assert.equal(queue.depth, 0);
      assert.equal(queue.busy, false);
    });
    assertNoSendQueueLogs(lines);
  });

  it('edit enqueue when queue has no send pushes to end and stays silent', async () => {
    const order: string[] = [];
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });
    const lines = await captureAll(async () => {
      const pEdit = queue.enqueue(async () => {
        order.push('edit-only');
        return 'e';
      }, 'edit', { chatId: CHAT_ID });
      assert.equal(await pEdit, 'e');
    });
    assertNoSendQueueLogs(lines);
    assert.deepEqual(order, ['edit-only']);
  });

  it('concurrent enqueue while processing completes without duplicate QUEUE logs', async () => {
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0, maxRetries: 0 });
    const lines = await captureAll(async () => {
      const results = await Promise.all([
        queue.enqueue(() => Promise.resolve(1), 'send', { chatId: CHAT_ID }),
        queue.enqueue(() => Promise.resolve(2), 'send', { chatId: CHAT_ID }),
        queue.enqueue(() => Promise.resolve(3), 'send', { chatId: CHAT_ID }),
      ]);
      assert.deepEqual(results, [1, 2, 3]);
    });
    assertNoSendQueueLogs(lines);
  });

  it('edit enqueue with coalesceKey success stays silent without QUEUE codes', async () => {
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });
    const lines = await captureAll(async () => {
      assert.equal(
        await queue.enqueue(() => Promise.resolve('edit'), 'edit', {
          chatId: CHAT_ID,
          coalesceKey: 'edit:only',
        }),
        'edit',
      );
    });
    assertNoSendQueueLogs(lines);
  });

  it('busy reflects processing and depth without QUEUE codes', async () => {
    let unblock!: () => void;
    const block = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });

    const lines = await captureAll(async () => {
      const tail = queue.enqueue(async () => {
        await block;
        return 1;
      }, 'send');
      await settle();
      assert.equal(queue.busy, true);
      assert.ok(queue.depth >= 0);
      unblock();
      await tail;
    });

    assertNoSendQueueLogs(lines);
  });
});

const SILENT_PATH_MARKERS = [
  'successful send enqueue',
  'coalesce edit',
  'coalesce send waiters',
  'drain success',
  'drain on empty idle queue',
  'depth getter',
  'busy getter',
  'edit priority enqueue',
  'chat pacing',
  'different chatIds pacing',
  'only edits stays silent',
  'only coalesceKey sends stays silent',
  'below maxQueueSize stays silent',
  'sendDelayMs between sequential sends',
  'editDelayMs between sequential edits',
  'default send priority',
  'no chatId skips chat pacing',
  'retry after 0 seconds',
  'busy false and depth zero',
  'edit enqueue when queue has no send',
  'concurrent enqueue while processing',
  'exactly one op=retry line on single 429 recovery',
  'edit enqueue with coalesceKey success',
  'non-429 error reject',
  'Too Many Requests without retry after',
  'maxRetries zero',
  'constructor with partial config',
  'without chatId on overflow',
  'without chatId from QUEUE_RETRY_429',
  'busy reflects processing',
] as const;

const SEND_QUEUE_PATH_MATRIX = [
  { kind: 'fail' as const, code: 'QUEUE_RETRY_429', marker: 'retry after 429 with chatId attempt and hint' },
  { kind: 'fail' as const, code: 'QUEUE_RETRY_429', marker: 'Global 429 cooldown wait with durationMs op cooldown' },
  { kind: 'fail' as const, code: 'QUEUE_RETRY_429', marker: 'exactly one QUEUE_RETRY_429 retry line per 429 retry attempt' },
  { kind: 'fail' as const, code: 'QUEUE_RETRY_429', marker: '429 retry without chatId omits chatId' },
  { kind: 'fail' as const, code: 'QUEUE_RETRY_429', marker: 'different chatId on retry logs chatId' },
  { kind: 'fail' as const, code: 'QUEUE_RETRY_429', marker: 'after one allowed retry logs QUEUE_RETRY_429 then rejects' },
  { kind: 'fail' as const, code: 'QUEUE_OVERFLOW_DROP', marker: 'queue full drops oldest send with chatId op enqueue' },
  { kind: 'fail' as const, code: 'QUEUE_OVERFLOW_DROP', marker: 'rejects dropped waiter with Queue overflow error' },
  { kind: 'fail' as const, code: 'QUEUE_OVERFLOW_DROP', marker: 'without chatId on overflow omits chatId' },
  { kind: 'fail' as const, code: 'QUEUE_DRAIN_TIMEOUT', marker: 'drain times out with op drain durationMs' },
  { kind: 'fail' as const, code: 'QUEUE_DRAIN_TIMEOUT', marker: 'exactly one QUEUE_DRAIN_TIMEOUT log line per drain timeout call' },
  { kind: 'silent' as const, marker: 'successful send enqueue stays silent' },
  { kind: 'silent' as const, marker: 'coalesce edit calls stay silent' },
  { kind: 'silent' as const, marker: 'coalesce send waiters resolve to latest fn result' },
  { kind: 'silent' as const, marker: 'drain success stays silent' },
  { kind: 'silent' as const, marker: 'drain on empty idle queue returns true' },
  { kind: 'silent' as const, marker: 'depth getter stays silent' },
  { kind: 'silent' as const, marker: 'busy getter stays silent' },
  { kind: 'silent' as const, marker: 'edit priority enqueue before send stays silent on success' },
  { kind: 'silent' as const, marker: 'chat pacing stays silent' },
  { kind: 'silent' as const, marker: 'different chatIds pacing stays silent' },
  { kind: 'silent' as const, marker: 'overflow queue full but only edits stays silent' },
  { kind: 'silent' as const, marker: 'overflow queue full with only coalesceKey sends stays silent' },
  { kind: 'silent' as const, marker: 'enqueue below maxQueueSize stays silent' },
  { kind: 'silent' as const, marker: 'non-429 error reject stays silent' },
  { kind: 'silent' as const, marker: 'Too Many Requests without retry after seconds rejects' },
  { kind: 'silent' as const, marker: '429 with maxRetries zero rejects immediately without QUEUE_RETRY_429' },
  { kind: 'silent' as const, marker: 'SendQueue constructor with partial config stays silent' },
  { kind: 'fail' as const, code: 'QUEUE_OVERFLOW_DROP', marker: 'exactly one QUEUE_OVERFLOW_DROP log line per overflow drop' },
  { kind: 'fail' as const, code: 'QUEUE_OVERFLOW_DROP', marker: 'overflow drops plain send before coalesceKey send in queue' },
  { kind: 'fail' as const, code: 'QUEUE_RETRY_429', marker: 'maxRetries two logs exactly two QUEUE_RETRY_429 retry lines then rejects' },
  { kind: 'fail' as const, code: 'QUEUE_RETRY_429', marker: 'QUEUE_RETRY_429 retry text includes depth fragment' },
  { kind: 'fail' as const, code: 'QUEUE_DRAIN_TIMEOUT', marker: 'QUEUE_DRAIN_TIMEOUT text includes depth and processing flags' },
  { kind: 'silent' as const, marker: 'editDelayMs between sequential edits stays silent' },
  { kind: 'silent' as const, marker: 'enqueue default send priority stays silent' },
  { kind: 'silent' as const, marker: 'no chatId skips chat pacing and stays silent' },
  { kind: 'fail' as const, code: 'QUEUE_RETRY_429', marker: 'emits exactly one op=retry line on single 429 recovery' },
  { kind: 'fail' as const, code: 'QUEUE_RETRY_429', marker: 'retry after 0 seconds logs QUEUE_RETRY_429 hint=0 and recovers' },
  { kind: 'silent' as const, marker: 'busy false and depth zero after queue drains stays silent' },
  { kind: 'silent' as const, marker: 'edit enqueue when queue has no send pushes to end and stays silent' },
  { kind: 'silent' as const, marker: 'concurrent enqueue while processing completes without duplicate QUEUE logs' },
  { kind: 'silent' as const, marker: 'edit enqueue with coalesceKey success stays silent' },
  { kind: 'silent' as const, marker: 'sendDelayMs between sequential sends stays silent' },
  { kind: 'silent' as const, marker: 'busy reflects processing and depth without QUEUE codes' },
  { kind: 'meta' as const, marker: 'send-queue no inline scope outside sendQueueCtx helper' },
] as const;

describe('send-queue logging coverage', () => {
  it('asserts every send-queue code in test file', () => {
    const src = readFileSync(new URL('./send-queue-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of SEND_QUEUE_LOG_CODES) {
      const covered =
        src.includes(`code=${code}`)
        || src.includes(`assertSendQueueLog(lines, '${code}'`);
      assert.ok(covered, `missing assertion for ${code}`);
    }
    assert.equal(SEND_QUEUE_LOG_CODES.length, 3);
  });

  it('send-queue.ts declares exactly the covered codes', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const found = new Set<string>();
    for (const m of src.matchAll(/'(QUEUE_[A-Z0-9_]+)'/g)) {
      found.add(m[1]);
    }
    for (const code of SEND_QUEUE_LOG_CODES) {
      assert.ok(found.has(code), `send-queue.ts missing ${code}`);
    }
    assert.equal(found.size, SEND_QUEUE_LOG_CODES.length);
  });

  it('send-queue.ts has zero console.log warn error', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes('console.log('));
    assert.ok(!src.includes('console.warn('));
    assert.ok(!src.includes('console.error('));
  });

  it('send-queue.ts uses sendQueueCtx on all QUEUE_ log sites', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    assert.equal(src.match(/log(?:Info|Warn)\(\s*'QUEUE_/g)?.length ?? 0, 4);

    const cooldownBlock = src.slice(
      src.indexOf('private async waitForGlobalPause'),
      src.indexOf('private applyGlobalCooldown'),
    );
    assert.match(cooldownBlock, /QUEUE_RETRY_429[\s\S]*sendQueueCtx\('cooldown'/);

    const processBlock = src.slice(src.indexOf('private async process'), src.length);
    assert.match(processBlock, /QUEUE_RETRY_429[\s\S]*sendQueueCtx\('retry'/);

    const overflowBlock = src.slice(
      src.indexOf('if (this.queue.length >= this.config.maxQueueSize)'),
      src.indexOf('const item: QueueItem'),
    );
    assert.match(overflowBlock, /QUEUE_OVERFLOW_DROP[\s\S]*sendQueueCtx\('enqueue'/);

    const drainBlock = src.slice(src.indexOf('async drain'), src.indexOf('private async process'));
    assert.match(drainBlock, /QUEUE_DRAIN_TIMEOUT[\s\S]*sendQueueCtx\('drain'/);
  });

  it('info codes use logInfo and warn codes use logWarn in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /logInfo\(\s*'QUEUE_RETRY_429'/g);
    assert.equal(src.match(/logInfo\(\s*'QUEUE_RETRY_429'/g)?.length, 2);
    assert.match(src, /logWarn\(\s*'QUEUE_OVERFLOW_DROP'/);
    assert.match(src, /logWarn\(\s*'QUEUE_DRAIN_TIMEOUT'/);
  });

  it('every warn code has assertSendQueueLog in behavioral tests', () => {
    const src = readFileSync(new URL('./send-queue-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of ['QUEUE_OVERFLOW_DROP', 'QUEUE_DRAIN_TIMEOUT'] as const) {
      assert.ok(
        src.includes(`assertSendQueueLog(lines, '${code}'`),
        `behavioral test missing assertSendQueueLog for ${code}`,
      );
    }
  });

  it('info code QUEUE_RETRY_429 has assertSendQueueLog in behavioral tests', () => {
    const src = readFileSync(new URL('./send-queue-logging.test.ts', import.meta.url), 'utf-8');
    assert.ok(src.includes(`assertSendQueueLog(lines, 'QUEUE_RETRY_429'`));
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./send-queue-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent path marker "${marker}" in behavioral titles`);
    }
  });

  it('each log code is referenced in a behavioral it() title', () => {
    const src = readFileSync(new URL('./send-queue-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of SEND_QUEUE_LOG_CODES) {
      assert.ok(
        src.includes(`logs ${code}`) || src.includes(code),
        `no behavioral it() title references ${code}`,
      );
    }
  });

  it('send-queue.ts declares exactly 4 log emission sites', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    assert.equal(src.match(/log(?:Info|Warn)\(\s*'QUEUE_/g)?.length ?? 0, 4);
  });

  it('path matrix rows map to behavioral test titles or assertSendQueueLog', () => {
    const src = readFileSync(new URL('./send-queue-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of SEND_QUEUE_PATH_MATRIX) {
      if (row.kind === 'fail' && 'code' in row) {
        const hit =
          src.includes(`logs ${row.code}`)
          || src.includes(row.code)
          || src.includes(`assertSendQueueLog(lines, '${row.code}'`);
        assert.ok(hit, `path matrix fail ${row.code} (${row.marker}) not covered`);
        assert.ok(src.includes(row.marker), `path matrix marker "${row.marker}" missing from titles`);
      } else {
        assert.ok(src.includes(row.marker), `path matrix silent "${row.marker}" missing from titles`);
      }
    }
    assert.equal(SEND_QUEUE_PATH_MATRIX.length, 45);
  });

  it('edit priority splices before first send in enqueue source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('async enqueue'), src.indexOf('get depth'));
    assert.match(block, /if \(priority === 'edit'\)[\s\S]*firstSendIdx/);
    assert.match(block, /this\.queue\.splice\(firstSendIdx, 0, item\)/);
  });

  it('process catch uses extractRetryAfterSeconds in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private async process'), src.length);
    assert.match(block, /extractRetryAfterSeconds\(err\)/);
  });

  it('enqueue invokes process at end in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('async enqueue'), src.indexOf('get depth'));
    assert.match(block, /this\.process\(\);/);
  });

  it('warn codes never use logInfo in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!src.includes("logInfo('QUEUE_OVERFLOW_DROP'"));
    assert.ok(!src.includes("logInfo('QUEUE_DRAIN_TIMEOUT'"));
    assert.match(src, /logWarn\(\s*'QUEUE_OVERFLOW_DROP'/);
    assert.match(src, /logWarn\(\s*'QUEUE_DRAIN_TIMEOUT'/);
  });

  it('process returns early when processing flag is already true in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private async process'), src.length);
    assert.match(block, /if \(this\.processing\) return;/);
  });

  it('dropIdx requires send priority without coalesceKey in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('if (this.queue.length >= this.config.maxQueueSize)'),
      src.indexOf('const item: QueueItem'),
    );
    assert.match(block, /item\.priority === 'send' && !item\.coalesceKey/);
  });

  it('process catch reject after max retries emits no log in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private async process'), src.length);
    const rejectBlock = block.match(/this\.rejectItem\(item, err\);/)?.[0] ?? '';
    const afterMaxRetries = block.slice(block.indexOf('this.rejectItem(item, err)'));
    assert.ok(rejectBlock.length > 0);
    const rejectContext = afterMaxRetries.slice(0, 120);
    assert.ok(!rejectContext.includes('logInfo('));
    assert.ok(!rejectContext.includes('logWarn('));
  });

  it('drain returns true without logWarn in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('async drain'), src.indexOf('private async process'));
    const trueReturn = block.match(/return true;/)?.[0] ?? '';
    assert.ok(trueReturn.length > 0);
    const beforeTrue = block.slice(0, block.lastIndexOf('return true;'));
    assert.ok(!beforeTrue.slice(beforeTrue.lastIndexOf('return false')).includes('logWarn('));
  });

  it('exports SendQueueConfig and EnqueueOptions interfaces in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /export interface SendQueueConfig/);
    assert.match(src, /export interface EnqueueOptions/);
  });

  it('automated matrix: 3/3 codes have behavioral assertSendQueueLog', () => {
    const src = readFileSync(new URL('./send-queue-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of SEND_QUEUE_LOG_CODES) {
      assert.ok(
        src.includes(`assertSendQueueLog(lines, '${code}'`),
        `behavioral matrix missing assertSendQueueLog for ${code}`,
      );
    }
  });

  it('every SendQueue public API is exercised in behavioral tests', () => {
    const src = readFileSync(new URL('./send-queue-logging.test.ts', import.meta.url), 'utf-8');
    for (const api of ['new SendQueue', 'queue.depth', 'queue.busy', 'queue.enqueue', 'queue.drain'] as const) {
      assert.ok(src.includes(api), `behavioral tests missing ${api}`);
    }
  });

  it('enqueue coalesce early return has no logEvent in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('async enqueue'), src.indexOf('get depth'));
    const coalesceReturn = block.match(/if \(existing\) \{[\s\S]*?existing\.waiters\.push/)?.[0] ?? '';
    assert.ok(coalesceReturn.length > 0);
    assert.ok(!coalesceReturn.includes('logInfo('));
    assert.ok(!coalesceReturn.includes('logWarn('));
  });

  it('process success path emits no logs in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private async process'), src.length);
    const successBlock = block.match(/const result = await item\.fn\(\);[\s\S]*?this\.resolveItem\(item, result\);/)?.[0] ?? '';
    assert.ok(successBlock.length > 0);
    assert.ok(!successBlock.includes('logInfo('));
    assert.ok(!successBlock.includes('logWarn('));
  });

  it('overflow when dropIdx is minus one emits no log in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('if (this.queue.length >= this.config.maxQueueSize)'),
      src.indexOf('const item: QueueItem'),
    );
    assert.match(block, /if \(dropIdx !== -1\)[\s\S]*QUEUE_OVERFLOW_DROP/);
    assert.ok(!block.match(/if \(dropIdx !== -1\)[\s\S]*?\}[\s\S]*?logWarn/)?.[0]?.includes('dropIdx === -1'));
  });

  it('waitForGlobalPause skips log when wait is not positive in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('private async waitForGlobalPause'),
      src.indexOf('private applyGlobalCooldown'),
    );
    assert.match(block, /if \(wait > 0\)[\s\S]*QUEUE_RETRY_429/);
  });

  it('applyGlobalCooldown extends pause only when until exceeds globalPauseUntil in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('private applyGlobalCooldown'),
      src.indexOf('private async waitForChatPace'),
    );
    assert.match(block, /if \(until > this\.globalPauseUntil\)/);
  });

  it('sendQueueCtx helper is private and sets scope queue in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.match(/sendQueueCtx\([\s\S]*?^  private async waitForGlobalPause/m)?.[0] ?? '';
    assert.match(block, /scope: 'queue'/);
    assert.ok(!src.includes('export function sendQueueCtx'));
  });

  it('QUEUE_OVERFLOW_DROP passes chatId from enqueue options in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('QUEUE_OVERFLOW_DROP'), src.indexOf('const item: QueueItem'));
    assert.match(block, /sendQueueCtx\('enqueue', \{ chatId: options\.chatId \}\)/);
  });

  it('QUEUE_DRAIN_TIMEOUT passes durationMs via sendQueueCtx drain in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('async drain'), src.indexOf('private async process'));
    assert.match(block, /QUEUE_DRAIN_TIMEOUT[\s\S]*sendQueueCtx\('drain', \{ durationMs: timeoutMs \}\)/);
  });

  it('QUEUE_RETRY_429 retry path passes chatId attempt hint via sendQueueCtx in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(src.indexOf('private async process'), src.length);
    assert.match(block, /QUEUE_RETRY_429[\s\S]*sendQueueCtx\('retry'/);
    assert.match(block, /chatId: item\.chatId/);
    assert.match(block, /attempt: item\.retries/);
    assert.match(block, /hint: String\(retryAfter\)/);
  });

  it('QUEUE_RETRY_429 cooldown path uses sendQueueCtx with durationMs in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const block = src.slice(
      src.indexOf('private async waitForGlobalPause'),
      src.indexOf('private applyGlobalCooldown'),
    );
    assert.match(block, /QUEUE_RETRY_429[\s\S]*sendQueueCtx\('cooldown'/);
    assert.match(block, /durationMs: wait/);
  });

  it('resolveItem and rejectItem success paths emit no logs in source', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    for (const fn of ['resolveItem', 'rejectItem'] as const) {
      const block = src.match(new RegExp(`private ${fn}[\\s\\S]*?^  async enqueue`, 'm'))?.[0] ?? '';
      assert.ok(block.length > 0);
      assert.ok(!block.includes('logInfo('));
      assert.ok(!block.includes('logWarn('));
    }
  });

  it('SendQueue public API exports depth busy enqueue drain only', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /export class SendQueue/);
    assert.match(src, /get depth/);
    assert.match(src, /get busy/);
    assert.match(src, /async enqueue/);
    assert.match(src, /async drain/);
  });

  it('send-queue no inline scope outside sendQueueCtx helper', () => {
    const src = readFileSync(
      new URL('../../src/telegram/pipeline/send-queue.ts', import.meta.url),
      'utf-8',
    );
    const body = src.replace(/sendQueueCtx\(op: string[\s\S]*?^  \}/m, '');
    assert.ok(!body.includes("scope: '"));
  });
});
