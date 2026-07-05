import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildExpandToolDiffExpr } from '../../src/ide/parse/expand-tool-diff.js';

describe('expand-tool-diff', () => {
  it('builds self-contained CDP expression without bundled symbol refs', () => {
    const expr = buildExpandToolDiffExpr('tc-abc', 42);
    assert.match(expr, /scrollComposerStep/);
    assert.match(expr, /findToolCard/);
    assert.match(expr, /collectDiffFromCard/);
    assert.match(expr, /expandCardIfCollapsed/);
    assert.match(expr, /"tc-abc"/);
    assert.match(expr, /42/);
    assert.doesNotMatch(expr, /\bN\$/);
  });
});
