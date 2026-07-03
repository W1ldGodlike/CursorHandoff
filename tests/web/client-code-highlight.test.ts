import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  detectCommandLanguage,
  escapeHtml,
  highlightCommandHtml,
  normalizeHighlightLang,
} from '../../src/client/js/code-highlight.js';

describe('web client code highlight', () => {
  const tabs = readFileSync(new URL('../../src/client/js/tabs-messages.js', import.meta.url), 'utf8');

  it('detects powershell vs bash shell commands', () => {
    assert.equal(detectCommandLanguage('$x=1; Write-Output 1'), 'powershell');
    assert.equal(detectCommandLanguage('npm test'), 'bash');
    assert.equal(detectCommandLanguage('node -e "console.log(1)"'), 'javascript');
  });

  it('highlights keywords and variables without injecting HTML', () => {
    const html = highlightCommandHtml('npm test && echo "ok"', 'bash');
    assert.match(html, /class="tok-keyword">npm</);
    assert.match(html, /class="tok-string">&quot;ok&quot;/);
    assert.doesNotMatch(html, /<script/i);
    assert.equal(escapeHtml('<bad>'), '&lt;bad&gt;');
  });

  it('normalizes markdown fence languages', () => {
    assert.equal(normalizeHighlightLang('sh'), 'bash');
    assert.equal(normalizeHighlightLang('ps1'), 'powershell');
    assert.equal(normalizeHighlightLang('node'), 'javascript');
  });

  it('wires highlight into shell run_command only, not delete cards', () => {
    assert.match(tabs, /from '\.\/code-highlight\.js'/);
    assert.match(tabs, /isDeleteRunCommandMsg/);
    assert.match(tabs, /run-delete-filename/);
    assert.match(tabs, /highlightCommandHtml\(msg\.command, lang\)/);
    assert.match(tabs, /isDeleteRunCommandMsg\(msg\)[\s\S]*run-delete-block/);
  });
});
