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
import { mergeConfirmSearchApprovals } from '../../src/ide/parse/confirm-search-merge.js';
import { mergeDeleteFileApprovals } from '../../src/ide/parse/delete-file-merge.js';
import {
  confirmSearchCancelPath,
  confirmSearchContinuePath,
  confirmSearchTogglePath,
} from '../../src/ide/parse/confirm-search-selectors.js';
import {
  generateImageRunPath,
  generateImageSkipPath,
} from '../../src/ide/parse/generate-image-selectors.js';
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

  it('accepts long one-liner shell commands up to display cap', () => {
    const long = '$x=1;' + 'a'.repeat(20_000);
    assert.equal(isPlausibleShellCommand(long), true);
  });

  it('rejects shell commands above display cap', () => {
    const tooLong = 'x'.repeat(32_769);
    assert.equal(isPlausibleShellCommand(tooLong), false);
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

  it('mergeConfirmSearchApprovals appends confirm-search when no message match', () => {
    const messages: CursorState['messages'] = [
      { type: 'assistant', id: 'a1', flatIndex: 1, text: 'Searching…' },
    ];
    const merged = mergeConfirmSearchApprovals(messages, [
      approval({
        id: 'confirm-search:tc-web-1',
        description: 'Confirm search',
        command: 'Cursor IDE agent confirm web search',
        actions: [
          { label: 'Continue', type: 'approve', selectorPath: confirmSearchContinuePath('tc-web-1') },
          { label: 'Cancel', type: 'reject', selectorPath: confirmSearchCancelPath('tc-web-1') },
          { label: 'Auto-search web', type: 'toggle', selectorPath: confirmSearchTogglePath('tc-web-1'), checked: false },
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

  it('mergeConfirmSearchApprovals upgrades existing Confirm search tool', () => {
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
    const merged = mergeConfirmSearchApprovals(messages, [
      approval({
        id: 'confirm-search:tc-search',
        description: 'Confirm search',
        command: 'Cursor IDE documentation official docs',
        actions: [
          { label: 'Continue', type: 'approve', selectorPath: confirmSearchContinuePath('tc-search') },
          { label: 'Cancel', type: 'reject', selectorPath: confirmSearchCancelPath('tc-search') },
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
            { label: 'Continue', type: 'approve', selectorPath: confirmSearchContinuePath('tc-web-1') },
            { label: 'Cancel', type: 'reject', selectorPath: confirmSearchCancelPath('tc-web-1') },
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

  it('assigns confirm-search buttons per toolCallId when two cards pending', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'tool',
        id: 't1',
        flatIndex: 1,
        toolCallId: 'tc-a',
        status: 'completed',
        action: 'Confirm search',
        details: 'query one',
      },
      {
        type: 'tool',
        id: 't2',
        flatIndex: 2,
        toolCallId: 'tc-b',
        status: 'completed',
        action: 'Confirm search',
        details: 'query two',
      },
    ];
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'waiting_approval',
      pendingApprovals: [
        approval({
          id: 'confirm-search:tc-a',
          description: 'Confirm search',
          command: 'query one',
          actions: [
            { label: 'Continue', type: 'approve', selectorPath: confirmSearchContinuePath('tc-a') },
            { label: 'Cancel', type: 'reject', selectorPath: confirmSearchCancelPath('tc-a') },
          ],
        }),
        approval({
          id: 'confirm-search:tc-b',
          description: 'Confirm search',
          command: 'query two',
          actions: [
            { label: 'Continue', type: 'approve', selectorPath: confirmSearchContinuePath('tc-b') },
            { label: 'Cancel', type: 'reject', selectorPath: confirmSearchCancelPath('tc-b') },
          ],
        }),
      ],
      messages,
    } as CursorState);
    const cards = fixed.filter((m) => m.type === 'run_command') as RunCommand[];
    assert.equal(cards.length, 2);
    const a = cards.find((c) => c.toolCallId === 'tc-a');
    const b = cards.find((c) => c.toolCallId === 'tc-b');
    assert.equal(a?.actions.length, 2);
    assert.equal(b?.actions.length, 2);
    assert.equal(a?.actions[0].selectorPath, confirmSearchContinuePath('tc-a', 'query one'));
    assert.equal(b?.actions[0].selectorPath, confirmSearchContinuePath('tc-b', 'query two'));
  });

  it('scopes confirm-search paths with message toolCallId when approval id differs', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'tool',
        id: 't1',
        flatIndex: 1,
        toolCallId: 'dom-real-id',
        status: 'completed',
        action: 'Confirm search',
        details: '$ Cursor IDE documentation agent web search',
      },
    ];
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'waiting_approval',
      pendingApprovals: [
        approval({
          id: 'confirm-search:pending-scan-id',
          description: 'Confirm search',
          command: '$ Cursor IDE documentation agent web search',
          actions: [
            { label: 'Continue', type: 'approve', selectorPath: confirmSearchContinuePath('pending-scan-id') },
            { label: 'Cancel', type: 'reject', selectorPath: confirmSearchCancelPath('pending-scan-id') },
          ],
        }),
      ],
      messages,
    } as CursorState);
    const card = fixed.find((m) => m.type === 'run_command') as RunCommand | undefined;
    assert.ok(card);
    assert.equal(card.toolCallId, 'dom-real-id');
    assert.equal(
      card.actions[0].selectorPath,
      confirmSearchContinuePath('dom-real-id', '$ Cursor IDE documentation agent web search'),
    );
  });

  it('clears confirm-search buttons when approval is no longer pending', () => {
    const messages: CursorState['messages'] = [
      runCommand({
        id: 'rc1',
        toolCallId: 'tc-done',
        description: 'Confirm search',
        command: 'old query',
        actions: [
          { label: 'Continue', type: 'run', selectorPath: confirmSearchContinuePath('tc-done') },
          { label: 'Cancel', type: 'skip', selectorPath: confirmSearchCancelPath('tc-done') },
        ],
      }),
    ];
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'idle',
      pendingApprovals: [],
      messages,
    } as CursorState);
    if (fixed[0].type === 'run_command') assert.equal(fixed[0].actions.length, 0);
  });

  it('clears delete buttons when tool shows Deleted', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'tool',
        id: 't-done',
        flatIndex: 1,
        toolCallId: 'tool-9',
        status: 'completed',
        action: 'Deleted',
        details: 'smoke.mjs',
      },
      runCommand({
        id: 'rc-del',
        toolCallId: 'tool-9',
        description: 'Delete',
        command: 'smoke.mjs',
        actions: [
          { label: 'Reject', type: 'skip', selectorPath: 'delete-file:tool-9:smoke.mjs:reject' },
          { label: 'Accept', type: 'run', selectorPath: 'delete-file:tool-9:smoke.mjs:accept' },
        ],
      }),
    ];
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'idle',
      pendingApprovals: [],
      messages,
    } as CursorState);
    const card = fixed.find((m) => m.type === 'run_command');
    if (card?.type === 'run_command') assert.equal(card.actions.length, 0);
  });

  it('clears delete buttons when another delete is still pending', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'tool',
        id: 't-done',
        flatIndex: 1,
        toolCallId: 'tool-a',
        status: 'completed',
        action: 'Deleted',
        details: 'a.mjs',
      },
      runCommand({
        id: 'rc-a',
        toolCallId: 'tool-a',
        description: 'Delete',
        command: 'a.mjs',
        actions: [
          { label: 'Reject', type: 'skip', selectorPath: 'delete-file:tool-a:a.mjs:reject' },
          { label: 'Accept', type: 'run', selectorPath: 'delete-file:tool-a:a.mjs:accept' },
        ],
      }),
    ];
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'waiting_approval',
      pendingApprovals: [
        approval({
          id: 'delete-file:tool-b',
          description: 'Delete',
          command: 'b.mjs',
          actions: [
            { label: 'Reject', type: 'reject', selectorPath: 'delete-file:tool-b:b.mjs:reject' },
            { label: 'Accept', type: 'approve', selectorPath: 'delete-file:tool-b:b.mjs:accept' },
          ],
        }),
      ],
      messages,
    } as CursorState);
    const card = fixed.find((m) => m.type === 'run_command' && m.toolCallId === 'tool-a');
    if (card?.type === 'run_command') assert.equal(card.actions.length, 0);
  });

  it('mergeDeleteFileApprovals upgrades Delete tool by toolCallId', () => {
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
    const merged = mergeDeleteFileApprovals(messages, [
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

  it('mergeDeleteFileApprovals merges multiple delete-file pending approvals', () => {
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
    const merged = mergeDeleteFileApprovals(messages, [
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

  it('preserves delete-file actions without pending when Delete tool is still active', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'tool',
        id: 't-del',
        flatIndex: 1,
        toolCallId: 'tool-1526',
        status: 'completed',
        action: 'Delete',
        details: 'smoke.mjs',
        actions: [
          { label: 'Reject', type: 'skip', selectorPath: 'div#bubble > div:nth-of-type(2)' },
          { label: 'Accept', type: 'run', selectorPath: 'div#bubble > div:nth-of-type(3)' },
        ],
      },
    ];
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'idle',
      pendingApprovals: [],
      messages,
    } as CursorState);
    if (fixed[0].type === 'run_command') {
      assert.equal(fixed[0].actions.length, 2);
      assert.equal(fixed[0].actions[0].selectorPath, 'delete-file:tool-1526:smoke.mjs:reject');
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

  it('does not merge shell pending approval into delete run_command card', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'tool',
        id: 'tool-del',
        flatIndex: 0,
        toolCallId: 'tool-del',
        status: 'pending',
        action: 'Delete',
        details: 'test-file-1.txt',
        actions: [
          { label: 'Reject', type: 'skip', selectorPath: 'delete-file:tool-del:test-file-1.txt:reject' },
          { label: 'Accept', type: 'run', selectorPath: 'delete-file:tool-del:test-file-1.txt:accept' },
        ],
      },
    ];
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'waiting_approval',
      pendingApprovals: [
        approval({
          id: 'tool:shell-1',
          description: 'Delete test files from Downloads',
          command: 'Remove-Item -Path test-file-1.txt -Force',
          actions: [
            { label: 'Skip', type: 'reject', selectorPath: 'tool:shell-1:skip' },
            { label: 'Run', type: 'approve', selectorPath: 'tool:shell-1:run' },
          ],
        }),
      ],
      messages,
    } as CursorState);
    const del = fixed.find((m) => m.type === 'run_command' && m.description === 'Delete');
    assert.ok(del && del.type === 'run_command');
    assert.equal(del.command, 'test-file-1.txt');
    assert.ok(del.actions?.length);
    assert.match(del.actions[0].selectorPath || '', /^delete-file:/);
  });

  it('promotes Generate image tool with bubble actions to run_command', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'tool',
        id: 't-gen',
        flatIndex: 3,
        toolCallId: 'tool-gen-1',
        status: 'loading',
        action: 'Generate image',
        details: '',
        actions: [
          { label: 'Skip', type: 'skip', selectorPath: 'div#bubble > button:nth-of-type(1)' },
          { label: 'Generate', type: 'run', selectorPath: 'div#bubble > button:nth-of-type(2)' },
        ],
      },
    ];
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'waiting_approval',
      pendingApprovals: [
        approval({
          id: 'generate-image:tool-gen-1',
          description: 'Generate image',
          command: 'A cute cat poster',
          actions: [
            { label: 'Skip', type: 'reject', selectorPath: generateImageSkipPath('tool-gen-1') },
            { label: 'Generate', type: 'approve', selectorPath: generateImageRunPath('tool-gen-1') },
          ],
        }),
      ],
      messages,
    } as CursorState);
    assert.equal(fixed.length, 1);
    assert.equal(fixed[0].type, 'run_command');
    if (fixed[0].type === 'run_command') {
      assert.equal(fixed[0].description, 'Generate image');
      assert.equal(fixed[0].command, 'A cute cat poster');
      assert.equal(fixed[0].actions[0].selectorPath, generateImageSkipPath('tool-gen-1'));
      assert.equal(fixed[0].actions[1].selectorPath, generateImageRunPath('tool-gen-1'));
    }
  });

  it('preserves generate-image actions when extract already returned run_command', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'run_command',
        id: 'rc-gen',
        flatIndex: 2,
        toolCallId: 'tool-gen-rc',
        description: 'Generate image',
        candidates: '',
        command: '',
        actions: [
          { label: 'Skip', type: 'skip', selectorPath: 'div#bubble > button:nth-of-type(1)' },
          { label: 'Generate', type: 'run', selectorPath: 'div#bubble > button:nth-of-type(2)' },
        ],
      },
    ];
    const fixed = applyApprovalActionsToMessages({
      agentStatus: 'waiting_approval',
      pendingApprovals: [],
      messages,
    } as CursorState);
    assert.equal(fixed.length, 1);
    assert.equal(fixed[0].type, 'run_command');
    if (fixed[0].type === 'run_command') {
      assert.equal(fixed[0].actions?.length, 2);
      assert.equal(fixed[0].actions?.[0].selectorPath, generateImageSkipPath('tool-gen-rc'));
      assert.equal(fixed[0].actions?.[1].selectorPath, generateImageRunPath('tool-gen-rc'));
    }
  });

  it('preserves generate-image actions without pending when Generate image tool is active', () => {
    const messages: CursorState['messages'] = [
      {
        type: 'tool',
        id: 't-gen',
        flatIndex: 1,
        toolCallId: 'tool-gen-2',
        status: 'loading',
        action: 'Generate image',
        details: 'prompt text',
        actions: [
          { label: 'Skip', type: 'skip', selectorPath: 'div#bubble > button:nth-of-type(1)' },
          { label: 'Generate', type: 'run', selectorPath: 'div#bubble > button:nth-of-type(2)' },
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
      assert.equal(fixed[0].command, 'prompt text');
      assert.equal(fixed[0].actions?.length, 2);
      assert.equal(fixed[0].actions?.[0].selectorPath, generateImageSkipPath('tool-gen-2'));
      assert.equal(fixed[0].actions?.[1].selectorPath, generateImageRunPath('tool-gen-2'));
    }
  });
});
