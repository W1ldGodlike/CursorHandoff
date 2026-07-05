import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeChatMessages, applyExpandedToolDiffCache } from '../../src/state/broadcast.js';
import { applyApprovalActionsToMessages } from '../../src/ide/parse/approval-merge.js';
import type { HumanMessage, RunCommand, ToolMessage } from '../../src/core/types.js';

function human(id: string, flatIndex: number, text: string): HumanMessage {
  return { type: 'human', id, flatIndex, text, mentions: [] };
}

describe('mergeChatMessages', () => {
  it('replaces messages when composer key changes', () => {
    const prev = [human('a', 0, 'old')];
    const next = [human('b', 0, 'new tab')];
    const merged = mergeChatMessages(prev, next, 'w1:c1', 'w1:c2');
    assert.deepEqual(merged.map((m) => m.id), ['b']);
  });

  it('merges by id and sorts by flatIndex', () => {
    const prev = [human('a', 0, 'first'), human('b', 1, 'second')];
    const next = [human('c', 2, 'third'), human('b', 1, 'second updated')];
    const merged = mergeChatMessages(prev, next, 'w1:c1', 'w1:c1');
    assert.deepEqual(
      merged.map((m) => `${m.id}:${(m as HumanMessage).text}`),
      ['a:first', 'b:second updated', 'c:third'],
    );
  });

  it('keeps richer tool diffBlock when poll sends a shorter hunk', () => {
    const prev: ToolMessage[] = [{
      type: 'tool',
      id: 't1',
      flatIndex: 10,
      toolCallId: 'tc1',
      status: 'completed',
      action: 'web-diff-smoke.ts',
      details: '',
      diffBlock: {
        blockKind: 'diff',
        code: 'a\nb\nc',
        diffLines: [
          { kind: 'add', text: 'a' },
          { kind: 'add', text: 'b' },
          { kind: 'add', text: 'c' },
        ],
      },
    }];
    const next: ToolMessage[] = [{
      type: 'tool',
      id: 't1',
      flatIndex: 10,
      toolCallId: 'tc1',
      status: 'completed',
      action: 'web-diff-smoke.ts',
      details: '',
      diffBlock: {
        blockKind: 'diff',
        code: 'a',
        diffLines: [{ kind: 'add', text: 'a' }],
      },
    }];
    const merged = mergeChatMessages(prev, next, 'w1:c1', 'w1:c1');
    assert.equal(merged[0].type === 'tool' && merged[0].diffBlock?.diffLines?.length, 3);
  });

  it('applyExpandedToolDiffCache overlays cached hunk', () => {
    const msgs: ToolMessage[] = [{
      type: 'tool',
      id: 't1',
      flatIndex: 5,
      toolCallId: 'tc-x',
      status: 'completed',
      action: 'f.ts',
      details: '',
      diffBlock: { blockKind: 'diff', code: 'x', diffLines: [{ kind: 'add', text: 'x' }] },
    }];
    const cache = new Map([
      ['tc-x:5', {
        blockKind: 'diff' as const,
        code: 'x\ny\nz',
        diffLines: [
          { kind: 'add', text: 'x' },
          { kind: 'add', text: 'y' },
          { kind: 'add', text: 'z' },
        ],
      }],
    ]);
    const out = applyExpandedToolDiffCache(msgs, cache);
    assert.equal(out[0].type === 'tool' && out[0].diffBlock?.diffLines?.length, 3);
  });

  it('re-applied approval merge clears actions kept by id merge', () => {
    const prev: RunCommand[] = [{
      type: 'run_command',
      id: 'rc1',
      flatIndex: 1,
      toolCallId: 'tc1',
      description: 'npm test',
      candidates: '',
      command: 'npm test',
      actions: [{ label: 'Run', type: 'run', selectorPath: 'sp-run' }],
    }];
    const next = [human('h2', 2, 'later')];
    const merged = mergeChatMessages(prev, next, 'w1:c1', 'w1:c1');
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'running_tool',
      pendingApprovals: [],
      messages: merged,
    } as Parameters<typeof applyApprovalActionsToMessages>[0]);
    const rc = fixed.find((m) => m.id === 'rc1');
    assert.equal(rc?.type, 'run_command');
    if (rc?.type === 'run_command') assert.deepEqual(rc.actions, []);
  });
});
