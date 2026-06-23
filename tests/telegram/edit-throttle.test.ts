import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITY_EDIT_MIN_MS,
  TOOL_LOADING_EDIT_MIN_MS,
  elementEditMinIntervalMs,
  shouldDeferEdit,
} from '../../src/telegram/ui/edits-notify.js';
import type { ChatElement } from '../../src/core/types.js';

describe('edit-throttle', () => {
  it('defers edit inside min interval', () => {
    assert.equal(shouldDeferEdit(1000, 3000, 2500), true);
    assert.equal(shouldDeferEdit(1000, 3000, 4001), false);
    assert.equal(shouldDeferEdit(1000, 0, 1001), false);
  });

  it('throttles only loading tools', () => {
    const loading: ChatElement = {
      type: 'tool',
      id: 't1',
      flatIndex: 0,
      toolCallId: 'tc1',
      status: 'loading',
      action: 'Edit',
      details: 'foo.ts',
    };
    const done: ChatElement = { ...loading, status: 'completed' };

    assert.equal(elementEditMinIntervalMs(loading), TOOL_LOADING_EDIT_MIN_MS);
    assert.equal(elementEditMinIntervalMs(done), 0);
    assert.equal(elementEditMinIntervalMs({ type: 'human', id: 'h', flatIndex: 0, text: 'x', mentions: [] }), 0);
  });

  it('activity interval is at least 3s', () => {
    assert.ok(ACTIVITY_EDIT_MIN_MS >= 3000);
  });
});
