import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findDocAnchorLine } from '../../extension/src/doc-anchor.js';

describe('findDocAnchorLine', () => {
  it('finds explicit html id anchors', () => {
    const text = '# Title\n\n<a id="cloudflare"></a>\n\n### Cloudflare\n';
    assert.equal(findDocAnchorLine(text, 'cloudflare'), 2);
  });

  it('finds pandoc {#anchor} on headings', () => {
    const text = '### Tailscale {#tailscale}\n';
    assert.equal(findDocAnchorLine(text, 'tailscale'), 0);
  });

  it('finds github-style heading slugs', () => {
    const text = '## CursorWake (Windows)\n';
    assert.equal(findDocAnchorLine(text, 'cursorwake-windows'), 0);
  });
});
