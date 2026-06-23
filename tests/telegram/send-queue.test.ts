import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SendQueue } from '../../src/telegram/pipeline/send-queue.js';

describe('SendQueue', () => {
  it('coalesces edit calls with the same key into one API call', async () => {
    let calls = 0;
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0 });

    const mk = (n: number) => () => {
      calls++;
      return Promise.resolve(n);
    };

    const p1 = queue.enqueue(mk(1), 'edit', { chatId: 1, coalesceKey: 'edit:1:99' });
    const p2 = queue.enqueue(mk(2), 'edit', { chatId: 1, coalesceKey: 'edit:1:99' });
    const p3 = queue.enqueue(mk(3), 'edit', { chatId: 1, coalesceKey: 'edit:1:99' });

    const results = await Promise.all([p1, p2, p3]);
    assert.equal(calls, 1);
    assert.deepEqual(results, [3, 3, 3]);
  });

  it('paces requests to the same chat_id', async () => {
    const stamps: number[] = [];
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 80, maxRetries: 0 });

    const mark = () => {
      stamps.push(Date.now());
      return Promise.resolve(true);
    };

    await Promise.all([
      queue.enqueue(mark, 'send', { chatId: 42 }),
      queue.enqueue(mark, 'send', { chatId: 42 }),
    ]);

    assert.equal(stamps.length, 2);
    assert.ok(stamps[1] - stamps[0] >= 70);
  });

  it('retries on 429 with global cooldown', async () => {
    let attempts = 0;
    const queue = new SendQueue({ sendDelayMs: 0, editDelayMs: 0, chatPaceMs: 0, maxRetries: 2 });

    const fn = () => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new Error('Too Many Requests: retry after 1'));
      }
      return Promise.resolve('ok');
    };

    const result = await queue.enqueue(fn, 'send', { chatId: 1 });
    assert.equal(result, 'ok');
    assert.equal(attempts, 2);
  });

  it('drain waits until queue is empty', async () => {
    const queue = new SendQueue({ sendDelayMs: 30, editDelayMs: 0, chatPaceMs: 0 });
    const p = queue.enqueue(() => Promise.resolve(1), 'send', { chatId: 1 });
    assert.equal(await queue.drain(3000), true);
    assert.equal(await p, 1);
    assert.equal(queue.busy, false);
  });
});
