import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyApprovalActionsToMessages,
  isPlausibleShellCommand,
  mergeApprovalsIntoMessages,
  stripApprovalLabelBleedFromCommand,
  stripShellApprovalActionsFromMessages,
  stripRunCommandApprovalActions,
} from '../../src/ide/parse/approval-merge.js';
import type { Approval, CursorState, RunCommand } from '../../src/core/types.js';

function runCommand(partial: Partial<RunCommand> & Pick<RunCommand, 'id' | 'toolCallId'>): RunCommand {
  return {
    type: 'run_command',
    flatIndex: 0,
    description: 'npm test',
    candidates: '',
    command: 'npm test',
    actions: [],
    ...partial,
  };
}

function approval(partial: Partial<Approval> & Pick<Approval, 'id' | 'description' | 'actions'>): Approval {
  return partial as Approval;
}

describe('approval-merge', () => {
  it('strips approval label bleed from command text', () => {
    const polluted = 'cd proj; npm testSkipEnable Auto-reviewRun';
    assert.equal(stripApprovalLabelBleedFromCommand(polluted), 'cd proj; npm test');
  });

  it('rejects dir table output mistaken for shell command', () => {
    const junk = 'dir, 15+Name Length ---- ------ lines.log 22 readme.txt 74 sample.json 47';
    assert.equal(isPlausibleShellCommand(junk), false);
  });

  it('dedupes duplicate run_command cards keeping real script', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'run_command',
        id: 'rc-junk',
        flatIndex: 1,
        toolCallId: 'tc1',
        description: 'Create test files in Downloads folder',
        candidates: '',
        command: 'dir, 15+Name Length ---- ------ lines.log 22',
        actions: [],
      },
      {
        type: 'run_command',
        id: 'rc-good',
        flatIndex: 2,
        toolCallId: 'tc1',
        description: 'Create test files in Downloads folder',
        candidates: '',
        command: '$dir = Join-Path $env:USERPROFILE "Downloads\\handoff-approval-test"',
        actions: [],
      },
    ];
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'idle',
      pendingApprovals: [],
      messages,
    } as CursorState);
    const runCards = fixed.filter((m) => m.type === 'run_command');
    assert.equal(runCards.length, 1);
    if (runCards[0].type === 'run_command') {
      assert.ok(runCards[0].command.includes('Join-Path'));
    }
  });

  it('clears DOM-sourced run_command actions', () => {
    const messages: CursorState['messages'] = [
      runCommand({
        id: 'rc1',
        toolCallId: 'tc1',
        actions: [
          { label: 'Skip', type: 'skip', selectorPath: 'sp-skip' },
          { label: 'Run', type: 'run', selectorPath: 'sp-run' },
        ],
      }),
    ];
    const stripped = stripRunCommandApprovalActions(messages);
    assert.equal(stripped[0].type, 'run_command');
    if (stripped[0].type === 'run_command') {
      assert.deepEqual(stripped[0].actions, []);
    }
  });

  it('shows actions only while approval is pending', () => {
    const messages: CursorState['messages'] = [
      runCommand({ id: 'rc1', toolCallId: 'tc-run1', description: 'Run outside sandbox', command: 'npm test' }),
    ];
    const pending = [
      approval({
        id: 'tool:tc-run1',
        description: 'Run outside sandbox',
        command: 'npm test',
        actions: [
          { label: 'Run', type: 'approve', selectorPath: 'sp-run' },
          { label: 'Skip', type: 'reject', selectorPath: 'sp-skip' },
        ],
      }),
    ];

    const withPending = applyApprovalActionsToMessages({
      agentStatus: 'waiting_approval',
      messages,
      pendingApprovals: pending,
    } as CursorState);
    const rcPending = withPending[0];
    assert.equal(rcPending.type, 'run_command');
    if (rcPending.type === 'run_command') {
      assert.equal(rcPending.actions.length, 2);
      assert.equal(rcPending.actions[0].type, 'run');
      assert.equal(rcPending.actions[1].type, 'skip');
    }

    const afterRun = applyApprovalActionsToMessages({
      agentStatus: 'running_tool',
      messages: withPending,
      pendingApprovals: [],
    } as CursorState);
    const rcDone = afterRun[0];
    assert.equal(rcDone.type, 'run_command');
    if (rcDone.type === 'run_command') {
      assert.deepEqual(rcDone.actions, []);
      assert.equal(rcDone.command, 'npm test');
    }
  });

  it('strips tool shell approval actions from DOM', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'tool',
        id: 't1',
        flatIndex: 1,
        toolCallId: 'tc1',
        status: 'loading',
        action: 'Shell',
        details: 'npm test',
        actions: [
          { label: 'Skip', type: 'skip', selectorPath: 'sp-skip' },
          { label: 'Run', type: 'run', selectorPath: 'sp-run' },
        ],
      },
    ];
    const stripped = stripShellApprovalActionsFromMessages(messages);
    assert.equal(stripped[0].type, 'tool');
    if (stripped[0].type === 'tool') {
      assert.equal(stripped[0].actions, undefined);
    }
  });

  it('mergeApprovalsIntoMessages matches by toolCallId', () => {
    const messages: CursorState['messages'] = [
      { type: 'tool', id: 't1', flatIndex: 1, toolCallId: 'tc-abc', status: 'loading', action: 'Shell', details: '' },
    ];
    const merged = mergeApprovalsIntoMessages(messages, [
      approval({
        id: 'tool:tc-abc',
        description: 'List files',
        command: 'ls',
        actions: [
          { label: 'Run', type: 'approve', selectorPath: 'sp-run' },
          { label: 'Skip', type: 'reject', selectorPath: 'sp-skip' },
        ],
      }),
    ]);
    assert.equal(merged[0].type, 'run_command');
    if (merged[0].type === 'run_command') {
      assert.equal(merged[0].command, 'ls');
      assert.equal(merged[0].actions.length, 2);
    }
  });
});
