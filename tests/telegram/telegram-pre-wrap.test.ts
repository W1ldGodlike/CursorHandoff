import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { telegramBashPreBlock, wrapTelegramPreText } from '../../src/telegram/format/pre-wrap.js';

describe('telegram pre-wrap', () => {
  it('leaves short commands on one line', () => {
    assert.equal(wrapTelegramPreText('npm test'), 'npm test');
    assert.equal(telegramBashPreBlock('npm test'), '$ npm test');
  });

  it('wraps long one-liners at spaces for Telegram pre blocks', () => {
    const long = 'node -e "const fs=require(\'fs\'); const lines=fs.readFileSync(\'C:/very/long/path/recording.jsonl\',\'utf8\').trim().split(/\\n/); for (const i of [9,10,15]) { console.log(i, lines[i]); }"';
    const wrapped = wrapTelegramPreText(long, 60);
    assert.ok(wrapped.includes('\n'));
    assert.equal(wrapped.replace(/\n/g, ''), long);
    assert.ok(telegramBashPreBlock(long).startsWith('$ '));
  });
});
