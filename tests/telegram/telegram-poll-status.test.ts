import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTelegramPollActive,
  markTelegramPollEstablished,
  setTelegramPollActive,
} from '../../src/web/poll-status.js';

describe('telegram-poll-status', () => {
  beforeEach(() => {
    setTelegramPollActive(false);
  });

  it('starts inactive', () => {
    assert.equal(isTelegramPollActive(), false);
  });

  it('markTelegramPollEstablished sets active once', () => {
    markTelegramPollEstablished();
    assert.equal(isTelegramPollActive(), true);
    markTelegramPollEstablished();
    assert.equal(isTelegramPollActive(), true);
  });

  it('setTelegramPollActive clears', () => {
    markTelegramPollEstablished();
    setTelegramPollActive(false);
    assert.equal(isTelegramPollActive(), false);
  });
});
