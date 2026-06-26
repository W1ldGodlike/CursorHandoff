import { beforeEach, describe, it } from 'node:test';
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

  it('markTelegramPollEstablished sets active and idempotent state', () => {
    markTelegramPollEstablished();
    assert.equal(isTelegramPollActive(), true);
    markTelegramPollEstablished();
    assert.equal(isTelegramPollActive(), true);
  });

  it('setTelegramPollActive clears and restores flag', () => {
    markTelegramPollEstablished();
    setTelegramPollActive(false);
    assert.equal(isTelegramPollActive(), false);
    setTelegramPollActive(true);
    assert.equal(isTelegramPollActive(), true);
  });

  it('re-establish after clear sets active again', () => {
    markTelegramPollEstablished();
    setTelegramPollActive(false);
    markTelegramPollEstablished();
    assert.equal(isTelegramPollActive(), true);
  });
});
