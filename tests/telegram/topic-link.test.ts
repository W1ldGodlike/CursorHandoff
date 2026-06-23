import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildForumTopicDeepLink } from '../../src/telegram/topics/health-link.js';

describe('topic-link', () => {
  it('builds forum topic deep link from supergroup chat id', () => {
    assert.equal(
      buildForumTopicDeepLink(-1001234567890, 42),
      'https://t.me/c/1234567890/42',
    );
  });
});
