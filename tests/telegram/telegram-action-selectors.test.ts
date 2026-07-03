import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_SELECTORS, resolveStableActionSelector, resolveCallbackActionSelector, parseCallbackData } from '../../src/telegram/commands/registry.js';
import {
  CONFIRM_SEARCH_CANCEL,
  CONFIRM_SEARCH_CONTINUE,
  CONFIRM_SEARCH_TOGGLE,
  confirmSearchContinuePath,
  parseConfirmSearchSelector,
} from '../../src/ide/parse/confirm-search-selectors.js';

describe('telegram ACTION_SELECTORS', () => {
  it('covers every callback action used by approval buttons', () => {
    for (const action of ['apr', 'rej', 'all', 'run', 'skp', 'alw', 'bld']) {
      assert.ok(ACTION_SELECTORS[action], `missing entry for action "${action}"`);
      assert.ok(ACTION_SELECTORS[action].length > 0, `empty entry for action "${action}"`);
    }
  });

  it('lists the current per-card class as the first strategy for shell actions', () => {
    assert.equal(ACTION_SELECTORS.apr[0], 'button.ui-shell-tool-call__run-btn');
    assert.equal(ACTION_SELECTORS.run[0], 'button.ui-shell-tool-call__run-btn');
    assert.equal(ACTION_SELECTORS.rej[0], 'button.ui-shell-tool-call__skip-btn');
    assert.equal(ACTION_SELECTORS.skp[0], 'button.ui-shell-tool-call__skip-btn');
    assert.equal(ACTION_SELECTORS.all[0], 'button.ui-shell-tool-call__allowlist-button');
    assert.equal(ACTION_SELECTORS.alw[0], 'button.ui-shell-tool-call__allowlist-button');
  });

  it('keeps a legacy fallback for older Cursor builds', () => {
    for (const action of ['apr', 'rej', 'all', 'run', 'skp', 'alw']) {
      assert.ok(
        ACTION_SELECTORS[action].length >= 2,
        `action "${action}" should have a legacy fallback`
      );
      assert.ok(
        ACTION_SELECTORS[action].some(s => s.startsWith('.composer-')),
        `action "${action}" missing legacy .composer-* fallback`
      );
    }
  });
});

describe('parseCallbackData', () => {
  it('treats the entire rest as id for model action (preserves colons in label::)', () => {
    assert.deepEqual(
      parseCallbackData('model:label::GPT-5.5 High'),
      { action: 'model', id: 'label::GPT-5.5 High', hash: '' }
    );
  });

  it('handles model action with stable id (no colons)', () => {
    assert.deepEqual(
      parseCallbackData('model:model-opus'),
      { action: 'model', id: 'model-opus', hash: '' }
    );
  });

  it('handles mode action', () => {
    assert.deepEqual(
      parseCallbackData('mode:agent'),
      { action: 'mode', id: 'agent', hash: '' }
    );
  });

  it('splits hashed actions into id + hash via last colon', () => {
    assert.deepEqual(
      parseCallbackData('apr:tool-call-42:abc12345'),
      { action: 'apr', id: 'tool-call-42', hash: 'abc12345' }
    );
    assert.deepEqual(
      parseCallbackData('run:foo:bar:0123beef'),
      { action: 'run', id: 'foo:bar', hash: '0123beef' }
    );
  });

  it('treats plan widget actions (vpl/bld) as hashed', () => {
    // From formatter.ts: `${prefix}:${msg.id.substring(0, 8)}:${hash}`
    assert.deepEqual(
      parseCallbackData('vpl:plan-1a2:abc12345'),
      { action: 'vpl', id: 'plan-1a2', hash: 'abc12345' }
    );
    assert.deepEqual(
      parseCallbackData('bld:plan-1a2:abc12345'),
      { action: 'bld', id: 'plan-1a2', hash: 'abc12345' }
    );
  });

  it('handles questionnaire actions as hash-only', () => {
    assert.deepEqual(
      parseCallbackData('qan:A'),
      { action: 'qan', id: '', hash: 'A' }
    );
    assert.deepEqual(
      parseCallbackData('qff:D'),
      { action: 'qff', id: '', hash: 'D' }
    );
  });

  it('handles action without payload', () => {
    assert.deepEqual(
      parseCallbackData('refresh'),
      { action: 'refresh', id: '', hash: '' }
    );
  });
});

describe('resolveStableActionSelector', () => {
  it('returns the joined selector list for known actions', () => {
    const sel = resolveStableActionSelector('apr');
    assert.ok(sel);
    assert.ok(sel.includes('button.ui-shell-tool-call__run-btn'));
    assert.ok(sel.includes(', '), 'should be a comma-separated selector list for querySelector cascade');
  });

  it('returns undefined for unknown actions', () => {
    assert.equal(resolveStableActionSelector('xyz'), undefined);
  });
});

describe('resolveCallbackActionSelector', () => {
  it('prefers hashed confirm-search path over shell fallback', () => {
    const hashes = new Map<string, string>([
      ['abc12345', confirmSearchContinuePath('tc-1')],
    ]);
    const sel = resolveCallbackActionSelector('run', 'abc12345', (h) => hashes.get(h));
    assert.equal(sel, confirmSearchContinuePath('tc-1'));
  });

  it('prefers hashed toggle path over shell checkbox fallback', () => {
    const hashes = new Map<string, string>([
      ['def67890', CONFIRM_SEARCH_TOGGLE],
    ]);
    const sel = resolveCallbackActionSelector('tog', 'def67890', (h) => hashes.get(h));
    assert.equal(sel, CONFIRM_SEARCH_TOGGLE);
  });

  it('falls back to shell selector when hash evicted', () => {
    const sel = resolveCallbackActionSelector('skp', 'missing', () => undefined);
    assert.ok(sel?.includes('button.ui-shell-tool-call__skip-btn'));
  });
});
