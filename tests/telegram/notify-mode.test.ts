import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatNotifyModeLabel,
  isAgentBusy,
  normalizeNotifyMode,
  resolveNotifyMode,
  shouldSendActivity,
  shouldSendChatElement,
  shouldSendComposerQueue,
} from '../../src/telegram/ui/notify-mode.js';
import type { ChatElement } from '../../src/core/types.js';

const loadingTool: ChatElement = {
  type: 'tool',
  id: 't1',
  flatIndex: 0,
  toolCallId: 'tc1',
  status: 'loading',
  action: 'Edit',
  details: 'foo.ts',
};

const doneTool: ChatElement = {
  ...loadingTool,
  status: 'completed',
  filename: 'foo.ts',
  additions: 2,
};

const assistant: ChatElement = {
  type: 'assistant',
  id: 'a1',
  flatIndex: 1,
  text: 'ok',
  html: '<p>ok</p>',
  codeBlocks: [],
};

describe('notify-mode', () => {
  it('normalizes mode aliases', () => {
    assert.equal(normalizeNotifyMode('QUIET'), 'quiet');
    assert.equal(normalizeNotifyMode('nope'), undefined);
    assert.equal(resolveNotifyMode({ notifyMode: 'final' }), 'final');
    assert.equal(resolveNotifyMode({}), 'full');
  });

  it('full sends everything', () => {
    assert.equal(shouldSendActivity('full'), true);
    assert.equal(shouldSendComposerQueue('full'), true);
    assert.equal(
      shouldSendChatElement('full', loadingTool, { agentIdle: false, alreadyTracked: false }),
      true,
    );
  });

  it('quiet skips activity-like noise', () => {
    assert.equal(shouldSendActivity('quiet'), false);
    assert.equal(shouldSendComposerQueue('quiet'), false);
    assert.equal(
      shouldSendChatElement('quiet', { type: 'thought', id: 'th', flatIndex: 0, duration: '' }, { agentIdle: false, alreadyTracked: false }),
      false,
    );
    assert.equal(
      shouldSendChatElement('quiet', loadingTool, { agentIdle: false, alreadyTracked: false }),
      false,
    );
    assert.equal(
      shouldSendChatElement('quiet', doneTool, { agentIdle: false, alreadyTracked: false }),
      true,
    );
  });

  it('quiet defers assistant edits while busy', () => {
    assert.equal(
      shouldSendChatElement('quiet', assistant, { agentIdle: false, alreadyTracked: true }),
      false,
    );
    assert.equal(
      shouldSendChatElement('quiet', assistant, { agentIdle: true, alreadyTracked: true }),
      true,
    );
  });

  it('final sends only assistant when idle, no tools', () => {
    assert.equal(
      shouldSendChatElement('final', assistant, { agentIdle: false, alreadyTracked: false }),
      false,
    );
    assert.equal(
      shouldSendChatElement('final', assistant, { agentIdle: true, alreadyTracked: false }),
      true,
    );
    assert.equal(
      shouldSendChatElement('final', doneTool, { agentIdle: true, alreadyTracked: false }),
      false,
    );
  });

  it('detects busy agent', () => {
    assert.equal(isAgentBusy('thinking'), true);
    assert.equal(isAgentBusy('idle'), false);
  });

  it('formats labels', () => {
    assert.match(formatNotifyModeLabel('quiet'), /quiet/);
  });
});
