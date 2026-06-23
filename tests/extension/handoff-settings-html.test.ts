import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('handoff-settings HTML template', () => {
  const src = readFileSync(new URL('../../extension/src/handoff-settings-view.ts', import.meta.url), 'utf8');

  it('uses <code> for slash commands (not markdown backticks)', () => {
    assert.match(src, /<code>\/newbot<\/code>/);
    assert.match(src, /<code>\/bridge<\/code>/);
    assert.doesNotMatch(
      src,
      /`\/[a-z][a-z0-9_]*`/,
      'Backticks around /commands break the outer template literal',
    );
  });

  it('inline script is not truncated (syntax error kills all click handlers)', () => {
    assert.match(
      src,
      /getElementById\('refreshAddons'\)\?\.addEventListener\('click', \(\) => sendMsg\(\{ type: 'refresh' \}\)\);/,
    );
    assert.match(
      src,
      /getElementById\('pauseWake'\)\?\.addEventListener\('click', \(\) => sendMsg\(\{ type: 'pauseWake' \}\)\);/,
    );
  });

});
