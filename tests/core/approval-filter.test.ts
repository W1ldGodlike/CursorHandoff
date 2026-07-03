import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyApprovalFilter,
  filterActionableApprovals,
  isActionableApproval,
} from '../../src/ide/approval-filter.js';
import type { Approval } from '../../src/core/types.js';

function approval(partial: Partial<Approval> & Pick<Approval, 'id' | 'description' | 'actions'>): Approval {
  return partial as Approval;
}

describe('approval-filter', () => {
  it('keeps primary shell-tool approvals', () => {
    const ok = approval({
      id: 'tool:tc-abc',
      description: 'npm test',
      actions: [
        { label: 'Run', type: 'approve', selectorPath: 'sp-run' },
        { label: 'Skip', type: 'reject', selectorPath: 'sp-skip' },
      ],
    });
    assert.equal(isActionableApproval(ok), true);
  });

  it('rejects health JSON masquerading as approval', () => {
    const junk = approval({
      id: '{"ok":true,"connected":true}|Cancel',
      description: '{"ok":true,"authRequired":true,"connected":true}',
      actions: [
        { label: '{"ok":true', type: 'approve', selectorPath: 'sp1' },
        { label: 'Cancel', type: 'reject', selectorPath: 'sp2' },
      ],
    });
    assert.equal(isActionableApproval(junk), false);
  });

  it('rejects terminal Run in background buttons', () => {
    const junk = approval({
      id: 'Run in background|',
      description: 'Run in background',
      actions: [{ label: 'Run in background', type: 'approve', selectorPath: 'sp1' }],
    });
    assert.equal(isActionableApproval(junk), false);
  });

  it('rejects reject-only matches', () => {
    const junk = approval({
      id: '|Cancel',
      description: 'Pending approval',
      actions: [{ label: 'Cancel', type: 'reject', selectorPath: 'sp1' }],
    });
    assert.equal(isActionableApproval(junk), false);
  });

  it('rejects test output descriptions', () => {
    const junk = approval({
      id: 'tool:bad',
      description: '00:04 +0 -1: capture_test - did not complete [E]',
      actions: [
        { label: 'Run', type: 'approve', selectorPath: 'sp-run' },
        { label: 'Skip', type: 'reject', selectorPath: 'sp-skip' },
      ],
    });
    assert.equal(isActionableApproval(junk), false);
  });

  it('applyApprovalFilter clears waiting_approval when all junk removed', () => {
    const filtered = applyApprovalFilter({
      agentStatus: 'waiting_approval',
      pendingApprovals: [
        approval({
          id: '|Cancel',
          description: 'Pending approval',
          actions: [{ label: 'Cancel', type: 'reject', selectorPath: 'sp1' }],
        }),
      ],
    } as Parameters<typeof applyApprovalFilter>[0]);

    assert.equal(filtered.pendingApprovals.length, 0);
    assert.equal(filtered.agentStatus, 'idle');
  });

  it('applyApprovalFilter strips run_command actions when approval resolved', () => {
    const pending = approval({
      id: 'tool:tc1',
      description: 'npm test',
      command: 'npm test',
      actions: [
        { label: 'Run', type: 'approve', selectorPath: 'sp-run' },
        { label: 'Skip', type: 'reject', selectorPath: 'sp-skip' },
      ],
    });
    const runMsg = {
      type: 'run_command' as const,
      id: 'rc1',
      flatIndex: 1,
      toolCallId: 'tc1',
      description: 'npm test',
      candidates: '',
      command: 'npm testSkipRun',
      actions: [
        { label: 'Skip', type: 'skip' as const, selectorPath: 'dom-skip' },
        { label: 'Run', type: 'run' as const, selectorPath: 'dom-run' },
      ],
    };

    const waiting = applyApprovalFilter({
      agentStatus: 'waiting_approval',
      pendingApprovals: [pending],
      messages: [runMsg],
    } as Parameters<typeof applyApprovalFilter>[0]);
    assert.equal(waiting.agentStatus, 'waiting_approval');
    const waitingRc = waiting.messages[0];
    assert.equal(waitingRc.type, 'run_command');
    if (waitingRc.type === 'run_command') {
      assert.equal(waitingRc.actions.length, 2);
      assert.equal(waitingRc.actions[0].type, 'run');
    }

    const resolved = applyApprovalFilter({
      agentStatus: 'running_tool',
      pendingApprovals: [],
      messages: [runMsg],
    } as Parameters<typeof applyApprovalFilter>[0]);
    const resolvedRc = resolved.messages[0];
    assert.equal(resolvedRc.type, 'run_command');
    if (resolvedRc.type === 'run_command') {
      assert.deepEqual(resolvedRc.actions, []);
      assert.equal(resolvedRc.command, 'npm test');
    }
  });

  it('applyApprovalFilter hides actions after pending clears', () => {
    const filtered = applyApprovalFilter({
      agentStatus: 'idle',
      pendingApprovals: [],
      messages: [{
        type: 'run_command',
        id: 'rc-old',
        flatIndex: 1,
        toolCallId: 'tc-old',
        description: 'old command',
        candidates: '',
        command: 'npm test',
        actions: [{ label: 'Run', type: 'run', selectorPath: 'dom' }],
      }],
    } as Parameters<typeof applyApprovalFilter>[0]);
    assert.equal(filtered.pendingApprovals.length, 0);
    const rc = filtered.messages[0];
    assert.equal(rc.type, 'run_command');
    if (rc.type === 'run_command') assert.deepEqual(rc.actions, []);
  });

  it('keeps approvals with Continue button', () => {
    const ok = approval({
      id: 'tool:web-search',
      description: 'Confirm search Cursor settings',
      actions: [
        { label: 'Continue', type: 'approve', selectorPath: 'sp-cont' },
        { label: 'Cancel', type: 'reject', selectorPath: 'sp-cancel' },
      ],
    });
    assert.equal(isActionableApproval(ok), true);
  });

  it('keeps delete-file stable id with Accept^ label', () => {
    const ok = approval({
      id: 'delete-file:tool-1526',
      description: 'Delete',
      command: 'probe-composer-html.mjs',
      actions: [
        { label: 'Reject', type: 'reject', selectorPath: 'delete-file:tool-1526:reject' },
        { label: 'Accept^', type: 'approve', selectorPath: 'delete-file:tool-1526:accept' },
      ],
    });
    assert.equal(isActionableApproval(ok), true);
  });

  it('keeps toggle checkbox actions', () => {
    const ok = approval({
      id: 'tool:shell-1',
      description: 'List local dev folder contents',
      command: 'Get-ChildItem local',
      actions: [
        { label: 'Skip', type: 'reject', selectorPath: 'sp-skip' },
        { label: 'Enable Auto-review', type: 'toggle', selectorPath: 'sp-toggle', checked: false },
        { label: 'Run', type: 'approve', selectorPath: 'sp-run' },
      ],
    });
    assert.equal(isActionableApproval(ok), true);
  });

  it('filterActionableApprovals keeps real mixed with junk', () => {
    const real = approval({
      id: 'tool:real',
      description: 'git status',
      actions: [
        { label: 'Run', type: 'approve', selectorPath: 'a' },
        { label: 'Skip', type: 'reject', selectorPath: 'b' },
      ],
    });
    const junk = approval({
      id: 'Run in background',
      description: 'Run in background',
      actions: [{ label: 'Run in background', type: 'approve', selectorPath: 'c' }],
    });
    assert.deepEqual(filterActionableApprovals([real, junk]), [real]);
  });
});
