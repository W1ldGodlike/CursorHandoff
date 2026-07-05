import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import {
  extractUiDefaultDiffFromScope,
  languageFromFilename,
  mergeDiffLineBatches,
  normalizeUiDefaultDiffLineText,
  uiDefaultDiffLineKind,
} from '../../src/ide/parse/ui-default-diff.js';

describe('ui-default-diff', () => {
  it('maps data-type to diff line kinds', () => {
    assert.equal(uiDefaultDiffLineKind('removed'), 'rem');
    assert.equal(uiDefaultDiffLineKind('added'), 'add');
    assert.equal(uiDefaultDiffLineKind('unchanged'), 'ctx');
    assert.equal(uiDefaultDiffLineKind(null), 'ctx');
  });

  it('normalizes nbsp and trailing whitespace', () => {
    assert.equal(normalizeUiDefaultDiffLineText('async \u00a0 '), 'async');
  });

  it('infers language from filename extension', () => {
    assert.equal(languageFromFilename('poll-loop.ts'), 'typescript');
    assert.equal(languageFromFilename('README.md'), 'markdown');
    assert.equal(languageFromFilename('noext'), undefined);
  });

  it('extracts add/rem/ctx lines from ui-default-diff DOM', () => {
    const dom = new JSDOM(`<div class="tool-root">
      <span class="ui-edit-tool-call__filename">outbox-watch.ts</span>
      <div class="ui-default-diff">
        <div class="ui-default-diff__line" data-type="unchanged">
          <div class="ui-default-diff__line-content"><span>ctx line</span></div>
        </div>
        <div class="ui-default-diff__line" data-type="removed">
          <div class="ui-default-diff__line-content"><span class="ui-default-diff__inline--removed">old</span></div>
        </div>
        <div class="ui-default-diff__line" data-type="added">
          <div class="ui-default-diff__line-content"><span class="ui-default-diff__inline--added">new</span></div>
        </div>
      </div>
    </div>`);
    const scope = dom.window.document.querySelector('.tool-root')!;
    const item = extractUiDefaultDiffFromScope(scope);
    assert.ok(item);
    assert.equal(item!.blockKind, 'diff');
    assert.equal(item!.filename, 'outbox-watch.ts');
    assert.equal(item!.language, 'typescript');
    assert.deepEqual(item!.diffLines, [
      { kind: 'ctx', text: 'ctx line' },
      { kind: 'rem', text: 'old' },
      { kind: 'add', text: 'new' },
    ]);
  });

  it('skips empty unchanged context lines', () => {
    const dom = new JSDOM(`<div class="tool-root">
      <div class="ui-default-diff">
        <div class="ui-default-diff__line" data-type="unchanged">
          <div class="ui-default-diff__line-content"><span></span></div>
        </div>
        <div class="ui-default-diff__line" data-type="added">
          <div class="ui-default-diff__line-content"><span>x</span></div>
        </div>
      </div>
    </div>`);
    const item = extractUiDefaultDiffFromScope(dom.window.document.querySelector('.tool-root')!);
    assert.deepEqual(item!.diffLines, [{ kind: 'add', text: 'x' }]);
  });

  it('picks the largest ui-default-diff root in a card', () => {
    const dom = new JSDOM(`<div class="tool-root">
      <div class="ui-tool-call-card">
        <span class="ui-edit-tool-call__filename">a.ts</span>
        <div class="ui-default-diff">
          <div class="ui-default-diff__line" data-type="added">
            <div class="ui-default-diff__line-content"><span>short</span></div>
          </div>
        </div>
        <div class="ui-tool-call-card__body">
          <div class="ui-default-diff">
            <div class="ui-default-diff__line" data-type="added">
              <div class="ui-default-diff__line-content"><span>one</span></div>
            </div>
            <div class="ui-default-diff__line" data-type="removed">
              <div class="ui-default-diff__line-content"><span>two</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>`);
    const item = extractUiDefaultDiffFromScope(dom.window.document.querySelector('.tool-root')!);
    assert.equal(item!.diffLines!.length, 2);
  });

  it('mergeDiffLineBatches dedupes scroll slices', () => {
    assert.deepEqual(
      mergeDiffLineBatches([
        [{ kind: 'add', text: 'a' }, { kind: 'ctx', text: 'b' }],
        [{ kind: 'ctx', text: 'b' }, { kind: 'rem', text: 'c' }],
      ]),
      [
        { kind: 'add', text: 'a' },
        { kind: 'ctx', text: 'b' },
        { kind: 'rem', text: 'c' },
      ],
    );
  });
});
