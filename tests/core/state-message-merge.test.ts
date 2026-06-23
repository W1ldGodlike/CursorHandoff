import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeChatMessages } from '../../src/state/broadcast.js';
import type { HumanMessage } from '../../src/core/types.js';

function human(id: string, flatIndex: number, text: string): HumanMessage {
  return { type: 'human', id, flatIndex, text, mentions: [] };
}

describe('mergeChatMessages', () => {
  it('replaces messages when composer key changes', () => {
    const prev = [human('a', 0, 'old')];
    const next = [human('b', 0, 'new tab')];
    const merged = mergeChatMessages(prev, next, 'w1:c1', 'w1:c2');
    assert.deepEqual(merged.map((m) => m.id), ['b']);
  });

  it('merges by id and sorts by flatIndex', () => {
    const prev = [human('a', 0, 'first'), human('b', 1, 'second')];
    const next = [human('c', 2, 'third'), human('b', 1, 'second updated')];
    const merged = mergeChatMessages(prev, next, 'w1:c1', 'w1:c1');
    assert.deepEqual(
      merged.map((m) => `${m.id}:${(m as HumanMessage).text}`),
      ['a:first', 'b:second updated', 'c:third'],
    );
  });
});
