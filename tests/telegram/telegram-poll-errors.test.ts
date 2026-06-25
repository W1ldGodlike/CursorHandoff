import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isManualPollAbort } from '../../src/telegram/transport/poll-errors.js';

describe('telegram-poll-errors', () => {
  it('returns false for abort-like errors when local signal is not aborted', () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'AbortError';
    assert.equal(isManualPollAbort(err, false), false);
  });

  it('returns true for manual abort when local signal is aborted', () => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    assert.equal(isManualPollAbort(err, true), true);
  });

  it('returns false for non-abort errors even if local signal is aborted', () => {
    const err = new Error('getUpdates: Bad Gateway');
    err.name = 'FetchError';
    assert.equal(isManualPollAbort(err, true), false);
  });
});
