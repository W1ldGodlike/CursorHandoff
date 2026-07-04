import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  generateImageRunPath,
  generateImageSkipPath,
  isGenerateImageAction,
  isGeneratedImageAction,
  parseGenerateImageSelector,
} from '../../src/ide/parse/generate-image-selectors.js';

describe('generate-image-selectors', () => {
  it('detects generate image tool actions', () => {
    assert.equal(isGenerateImageAction('Generate image'), true);
    assert.equal(isGenerateImageAction(' generate image '), true);
    assert.equal(isGeneratedImageAction('Generated image'), true);
    assert.equal(isGenerateImageAction('Generated image'), false);
  });

  it('builds and parses stable generate-image paths', () => {
    const run = generateImageRunPath('tool-abc');
    const skip = generateImageSkipPath('tool-abc');
    assert.equal(run, 'generate-image:tool-abc:run');
    assert.equal(skip, 'generate-image:tool-abc:skip');
    assert.deepEqual(parseGenerateImageSelector(run), { toolCallId: 'tool-abc', kind: 'run' });
    assert.deepEqual(parseGenerateImageSelector(skip), { toolCallId: 'tool-abc', kind: 'skip' });
    assert.equal(parseGenerateImageSelector('delete-file:x:accept'), null);
  });
});
