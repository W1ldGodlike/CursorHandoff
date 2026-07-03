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

  it('mergeApprovalsIntoMessages appends confirm-search when no message match', () => {
    const messages: CursorState['messages'] = [
      { type: 'assistant', id: 'a1', flatIndex: 1, text: 'Searching…' },
    ];
    const merged = mergeApprovalsIntoMessages(messages, [
      approval({
        id: 'confirm-search:tc-web-1',
        description: 'Confirm search',
        command: 'Cursor IDE agent confirm web search',
        actions: [
          { label: 'Continue', type: 'approve', selectorPath: 'confirm-search:continue' },
          { label: 'Cancel', type: 'reject', selectorPath: 'confirm-search:cancel' },
          { label: 'Auto-search web', type: 'toggle', selectorPath: 'confirm-search:auto-search-toggle', checked: false },
        ],
      }),
    ]);
    assert.equal(merged.length, 2);
    const rc = merged[1];
    assert.equal(rc.type, 'run_command');
    if (rc.type === 'run_command') {
      assert.equal(rc.description, 'Confirm search');
      assert.equal(rc.command, 'Cursor IDE agent confirm web search');
      assert.equal(rc.actions.length, 3);
      assert.equal(rc.actions[0].type, 'run');
      assert.equal(rc.actions[0].label, 'Continue');
      assert.equal(rc.actions[1].type, 'skip');
      assert.equal(rc.actions[2].type, 'toggle');
    }
  });

  it('mergeApprovalsIntoMessages upgrades existing Confirm search tool', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'tool',
        id: 't-search',
        flatIndex: 5,
        toolCallId: 'tc-search',
        status: 'completed',
        action: 'Confirm search',
        details: 'Cursor IDE documentation official docs',
      },
    ];
    const merged = mergeApprovalsIntoMessages(messages, [
      approval({
        id: 'confirm-search:tc-search',
        description: 'Confirm search',
        command: 'Cursor IDE documentation official docs',
        actions: [
          { label: 'Continue', type: 'approve', selectorPath: 'confirm-search:continue' },
          { label: 'Cancel', type: 'reject', selectorPath: 'confirm-search:cancel' },
        ],
      }),
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].type, 'run_command');
    if (merged[0].type === 'run_command') {
      assert.equal(merged[0].actions.length, 2);
      assert.equal(merged[0].command, 'Cursor IDE documentation official docs');
    }
  });

  it('applyApprovalActionsToMessages surfaces confirm-search card', () => {
    const withPending = applyApprovalActionsToMessages({
      agentStatus: 'running_tool',
      messages: [{ type: 'assistant', id: 'a1', flatIndex: 1, text: 'ok' }],
      pendingApprovals: [
        approval({
          id: 'confirm-search:tc-web-1',
          description: 'Confirm search',
          command: 'handoff web search query',
          actions: [
            { label: 'Continue', type: 'approve', selectorPath: 'confirm-search:continue' },
            { label: 'Cancel', type: 'reject', selectorPath: 'confirm-search:cancel' },
          ],
        }),
      ],
    } as CursorState);
    const rc = withPending.find((m) => m.type === 'run_command');
    assert.ok(rc);
    if (rc?.type === 'run_command') {
      assert.equal(rc.actions.length, 2);
      assert.equal(rc.command, 'handoff web search query');
    }
  });

  it('mergeApprovalsIntoMessages upgrades Delete tool by toolCallId', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'tool',
        id: 't-del',
        flatIndex: 8,
        toolCallId: 'tool-1526',
        status: 'completed',
        action: 'Delete',
        details: 'probe-composer-html.mjs',
      },
    ];
    const merged = mergeApprovalsIntoMessages(messages, [
      approval({
        id: 'delete-file:tool-1526',
        description: 'Delete',
        command: 'probe-composer-html.mjs',
        actions: [
          { label: 'Reject', type: 'reject', selectorPath: 'delete-file:tool-1526:reject' },
          { label: 'Accept', type: 'approve', selectorPath: 'delete-file:tool-1526:accept' },
        ],
      }),
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].type, 'run_command');
    if (merged[0].type === 'run_command') {
      assert.equal(merged[0].description, 'Delete');
      assert.equal(merged[0].command, 'probe-composer-html.mjs');
      assert.equal(merged[0].actions.length, 2);
      assert.equal(merged[0].actions[0].label, 'Reject');
      assert.equal(merged[0].actions[1].label, 'Accept');
    }
  });

  it('mergeApprovalsIntoMessages merges multiple delete-file pending approvals', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'tool',
        id: 't1',
        flatIndex: 1,
        toolCallId: 'tool-a',
        status: 'completed',
        action: 'Delete',
        details: 'a.mjs',
      },
      {
        type: 'tool',
        id: 't2',
        flatIndex: 2,
        toolCallId: 'tool-b',
        status: 'completed',
        action: 'Delete',
        details: 'b.mjs',
      },
    ];
    const merged = mergeApprovalsIntoMessages(messages, [
      approval({
        id: 'delete-file:tool-a',
        description: 'Delete',
        command: 'a.mjs',
        actions: [
          { label: 'Reject', type: 'reject', selectorPath: 'delete-file:tool-a:reject' },
          { label: 'Accept', type: 'approve', selectorPath: 'delete-file:tool-a:accept' },
        ],
      }),
      approval({
        id: 'delete-file:tool-b',
        description: 'Delete',
        command: 'b.mjs',
        actions: [
          { label: 'Reject', type: 'reject', selectorPath: 'delete-file:tool-b:reject' },
          { label: 'Accept^', type: 'approve', selectorPath: 'delete-file:tool-b:accept' },
        ],
      }),
    ]);
    const cards = merged.filter((m) => m.type === 'run_command');
    assert.equal(cards.length, 2);
  });

  it('preserves stable delete-file actions while pending', () => {
    const messages: CursorState['messages'] = [
      runCommand({
        id: 'rc-del',
        toolCallId: 'tool-1526',
        description: 'Delete',
        command: 'smoke.mjs',
        actions: [],
      }),
    ];
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'waiting_approval',
      pendingApprovals: [
        approval({
          id: 'delete-file:tool-1526',
          description: 'Delete',
          command: 'smoke.mjs',
          actions: [
            { label: 'Reject', type: 'reject', selectorPath: 'delete-file:tool-1526:reject' },
            { label: 'Accept', type: 'approve', selectorPath: 'delete-file:tool-1526:accept' },
          ],
        }),
      ],
      messages,
    } as CursorState);
    assert.equal(fixed.length, 1);
    if (fixed[0].type === 'run_command') {
      assert.equal(fixed[0].actions.length, 2);
      assert.equal(fixed[0].command, 'smoke.mjs');
    }
  });

  it('clears delete-file actions when pendingApprovals is empty', () => {
    const messages: CursorState['messages'] = [
      runCommand({
        id: 'rc-del',
        toolCallId: 'tool-1526',
        description: 'Delete',
        command: 'smoke.mjs',
        actions: [
          { label: 'Reject', type: 'skip', selectorPath: 'delete-file:tool-1526:reject' },
          { label: 'Accept', type: 'run', selectorPath: 'delete-file:tool-1526:accept' },
        ],
      }),
    ];
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'idle',
      pendingApprovals: [],
      messages,
    } as CursorState);
    if (fixed[0].type === 'run_command') {
      assert.equal(fixed[0].actions.length, 2);
      assert.equal(fixed[0].actions[0].selectorPath, 'delete-file:tool-1526:reject');
    }
  });

  it('recording: Deleted tool has no approval buttons', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'tool',
        id: 't-done',
        flatIndex: 1520,
        toolCallId: 'tool_1d664536-2d0c-4349-a43e-7b3911ebb77',
        status: 'completed',
        action: 'Deleted',
        details: 'confirm-search-smoke.mjs',
      },
    ];
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'idle',
      pendingApprovals: [],
      messages,
    } as CursorState);
    assert.equal(fixed[0].type, 'tool');
    if (fixed[0].type === 'tool') assert.equal(fixed[0].actions, undefined);
  });

  it('recording: Delete tool bubble actions survive without pendingApprovals', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'tool',
        id: '55804d20-e87e-4387-9f15-0436200e2130',
        flatIndex: 1525,
        toolCallId: 'tool-1525',
        status: 'completed',
        action: 'Delete',
        details: 'confirm-search-smoke.mjs',
        actions: [
          { label: 'Reject', type: 'skip', selectorPath: 'div#bubble-0436200e2130 > div:nth-of-type(2)' },
          { label: 'Accept^', type: 'run', selectorPath: 'div#bubble-0436200e2130 > div:nth-of-type(3)' },
        ],
      },
    ];
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'idle',
      pendingApprovals: [],
      messages,
    } as CursorState);
    assert.equal(fixed.length, 1);
    assert.equal(fixed[0].type, 'run_command');
    if (fixed[0].type === 'run_command') {
      assert.equal(fixed[0].command, 'confirm-search-smoke.mjs');
      assert.equal(fixed[0].actions.length, 2);
      assert.equal(fixed[0].actions[0].selectorPath, 'delete-file:tool-1525:confirm-search-smoke.mjs:reject');
      assert.equal(fixed[0].actions[1].selectorPath, 'delete-file:tool-1525:confirm-search-smoke.mjs:accept');
    }
  });

  it('promotes Delete tool with bubble-hash actions to run_command', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'tool',
        id: 't-del',
        flatIndex: 3,
        toolCallId: 'tool-99',
        status: 'completed',
        action: 'Delete',
        details: 'orphan.mjs',
        actions: [
          { label: 'Reject', type: 'skip', selectorPath: 'div:nth-child(1)>button:nth-child(2)' },
          { label: 'Accept^', type: 'run', selectorPath: 'div:nth-child(1)>button:nth-child(3)' },
        ],
      },
    ];
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'waiting_approval',
      pendingApprovals: [
        approval({
          id: 'delete-file:tool-99',
          description: 'Delete',
          command: 'orphan.mjs',
          actions: [
            { label: 'Reject', type: 'reject', selectorPath: 'delete-file:tool-99:reject' },
            { label: 'Accept', type: 'approve', selectorPath: 'delete-file:tool-99:accept' },
          ],
        }),
      ],
      messages,
    } as CursorState);
    assert.equal(fixed.length, 1);
    assert.equal(fixed[0].type, 'run_command');
    if (fixed[0].type === 'run_command') {
      assert.equal(fixed[0].command, 'orphan.mjs');
      assert.equal(fixed[0].actions[0].selectorPath, 'delete-file:tool-99:reject');
      assert.equal(fixed[0].actions[1].selectorPath, 'delete-file:tool-99:accept');
    }
  });

  it('dedupes delete cards by toolCallId not description alone', () => {
    const messages: CursorState['messages'] = [
      runCommand({
        id: 'rc-a',
        toolCallId: 'tool-a',
        description: 'Delete',
        command: 'a.mjs',
        actions: [],
      }),
      runCommand({
        id: 'rc-b',
        toolCallId: 'tool-b',
        description: 'Delete',
        command: 'b.mjs',
        actions: [],
      }),
    ];
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'waiting_approval',
      pendingApprovals: [
        approval({
          id: 'delete-file:tool-a',
          description: 'Delete',
          command: 'a.mjs',
          actions: [
            { label: 'Reject', type: 'reject', selectorPath: 'delete-file:tool-a:reject' },
            { label: 'Accept', type: 'approve', selectorPath: 'delete-file:tool-a:accept' },
          ],
        }),
        approval({
          id: 'delete-file:tool-b',
          description: 'Delete',
          command: 'b.mjs',
          actions: [
            { label: 'Reject', type: 'reject', selectorPath: 'delete-file:tool-b:reject' },
            { label: 'Accept', type: 'approve', selectorPath: 'delete-file:tool-b:accept' },
          ],
        }),
      ],
      messages,
    } as CursorState);
    assert.equal(fixed.filter((m) => m.type === 'run_command').length, 2);
  });
});
