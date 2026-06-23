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
