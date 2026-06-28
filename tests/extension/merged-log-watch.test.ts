import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('revealHandoffLog', () => {
  it('opens handoff.log in the active editor without Output tail or poll', () => {
    const src = readFileSync(join(root, 'extension/src/output-channel.ts'), 'utf8');
    assert.ok(src.includes('handoff.log'));
    assert.ok(src.includes('ViewColumn.Active'));
    assert.ok(src.includes('scrollEditorToEnd'));
    assert.ok(!src.includes('startMergedLogWatch'));
    assert.ok(!src.includes('readMergedTail'));
    assert.ok(!src.includes('workbench.panel.output.focus'));
  });
});
