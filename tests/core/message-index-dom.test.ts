import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGE_WRAPPER_SELECTOR,
  parseMessageWrapperIndex,
} from '../../src/ide/message-index.js';

describe('message-index-dom', () => {
  it('MESSAGE_WRAPPER_SELECTOR covers flat-index and message-index', () => {
    assert.match(MESSAGE_WRAPPER_SELECTOR, /data-flat-index/);
    assert.match(MESSAGE_WRAPPER_SELECTOR, /data-message-index/);
  });

  it('parseMessageWrapperIndex prefers data-flat-index', () => {
    assert.equal(
      parseMessageWrapperIndex({
        getAttribute: (n) => (n === 'data-flat-index' ? '42' : '99'),
      }),
      42,
    );
  });

  it('parseMessageWrapperIndex falls back to data-message-index (Cursor 3.8+)', () => {
    assert.equal(
      parseMessageWrapperIndex({
        getAttribute: (n) => (n === 'data-message-index' ? '1235' : null),
      }),
      1235,
    );
  });
});
