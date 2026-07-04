import type { Approval, CursorState } from '../../core/types.js';
import { applyConfirmSearchApprovalCards } from './confirm-search-merge.js';
import { applyDeleteFileApprovalCards } from './delete-file-merge.js';
import { applyGenerateImageApprovalCards } from './generate-image-merge.js';
import {
  dedupeShellRunCommandMessages,
  mergeShellApprovalsIntoMessages,
  stripShellApprovalActionsFromMessages,
} from './shell-approval-merge.js';

export { isPlausibleShellCommand, stripApprovalLabelBleedFromCommand } from './approval-command-text.js';
export { stripRunCommandApprovalActions, stripShellApprovalActionsFromMessages } from './shell-approval-merge.js';
export { mergeConfirmSearchApprovals } from './confirm-search-merge.js';
export { mergeDeleteFileApprovals } from './delete-file-merge.js';
export { applyGenerateImageApprovalCards, isGenerateImageRunCommand } from './generate-image-merge.js';
export { mergeShellApprovalsIntoMessages as mergeApprovalsIntoMessages } from './shell-approval-merge.js';

export function partitionApprovals(approvals: Approval[]): {
  deletePending: Approval[];
  confirmPending: Approval[];
  generatePending: Approval[];
  shellPending: Approval[];
} {
  const deletePending: Approval[] = [];
  const confirmPending: Approval[] = [];
  const generatePending: Approval[] = [];
  const shellPending: Approval[] = [];
  for (const approval of approvals) {
    if (approval.id.startsWith('delete-file:')) deletePending.push(approval);
    else if (approval.id.startsWith('confirm-search:')) confirmPending.push(approval);
    else if (approval.id.startsWith('generate-image:')) generatePending.push(approval);
    else shellPending.push(approval);
  }
  return { deletePending, confirmPending, generatePending, shellPending };
}

export function applyApprovalActionsToMessages(state: CursorState): CursorState['messages'] {
  const { deletePending, confirmPending, generatePending, shellPending } = partitionApprovals(state.pendingApprovals);
  let messages = applyDeleteFileApprovalCards(state.messages, deletePending);
  messages = applyGenerateImageApprovalCards(messages, generatePending);
  messages = stripShellApprovalActionsFromMessages(messages);
  messages = applyConfirmSearchApprovalCards(messages, confirmPending);
  if (shellPending.length) messages = mergeShellApprovalsIntoMessages(messages, shellPending);
  return dedupeShellRunCommandMessages(messages);
}
