import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  clearQuestionnaireFreeformPending,
  getQuestionnaireFreeformPending,
  QUESTIONNAIRE_FREEFORM_TTL_MS,
  setQuestionnaireFreeformPending,
  tryConsumeQuestionnaireFreeformText,
} from '../../src/telegram/inbound/questionnaire-freeform.js';

describe('questionnaire-freeform', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = join(tmpdir(), `handoff-q-freeform-${Date.now()}`);
    mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('consumes text when reply matches hint message', () => {
    setQuestionnaireFreeformPending({
      chatId: -100,
      threadId: 42,
      letter: 'D',
      hintMessageId: 9001,
    });
    const result = tryConsumeQuestionnaireFreeformText({
      chatId: -100,
      threadId: 42,
      replyToMessageId: 9001,
    });
    assert.equal(result.kind, 'consumed');
    if (result.kind === 'consumed') assert.equal(result.letter, 'D');
    assert.equal(getQuestionnaireFreeformPending(-100, 42), null);
  });

  it('rejects when reply does not match hint', () => {
    setQuestionnaireFreeformPending({
      chatId: -100,
      threadId: 42,
      letter: 'D',
      hintMessageId: 9001,
    });
    const result = tryConsumeQuestionnaireFreeformText({
      chatId: -100,
      threadId: 42,
      replyToMessageId: 1111,
    });
    assert.equal(result.kind, 'wrong_reply');
    assert.ok(getQuestionnaireFreeformPending(-100, 42));
  });

  it('queue path skips reply requirement', () => {
    setQuestionnaireFreeformPending({
      chatId: 1,
      threadId: 2,
      letter: 'C',
      hintMessageId: 55,
    });
    const result = tryConsumeQuestionnaireFreeformText({
      chatId: 1,
      threadId: 2,
      requireReplyToHint: false,
    });
    assert.equal(result.kind, 'consumed');
    if (result.kind === 'consumed') assert.equal(result.letter, 'C');
  });

  it('expires pending after TTL', () => {
    setQuestionnaireFreeformPending({ chatId: 1, threadId: 2, letter: 'A' });
    const state = getQuestionnaireFreeformPending(1, 2)!;
    state.expiresAt = Date.now() - 1;
    writeFileSync(
      join(dataDir, 'telegram-questionnaire-freeform/1-2.json'),
      JSON.stringify(state),
    );
    assert.equal(getQuestionnaireFreeformPending(1, 2), null);
  });

  it('TTL constant is 10 minutes', () => {
    assert.equal(QUESTIONNAIRE_FREEFORM_TTL_MS, 10 * 60 * 1000);
  });

  it('clear removes pending file', () => {
    setQuestionnaireFreeformPending({ chatId: 9, threadId: 8, letter: 'B' });
    assert.ok(existsSync(join(dataDir, 'telegram-questionnaire-freeform/9-8.json')));
    clearQuestionnaireFreeformPending(9, 8);
    assert.equal(getQuestionnaireFreeformPending(9, 8), null);
  });
});
