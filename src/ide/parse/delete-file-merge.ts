import type { Approval, ChatElement, CursorState, RunAction, RunCommand } from '../../core/types.js';
import { deleteFileAcceptPath, deleteFileRejectPath } from './delete-file-selectors.js';

const SHELL_ACTION_TYPES = new Set<RunAction['type']>(['run', 'skip', 'allow', 'toggle']);

function isShellApprovalAction(action: { type: string }): boolean {
  return SHELL_ACTION_TYPES.has(action.type as RunAction['type']);
}

export function isDeleteApprovalCard(description: string): boolean {
  return description.trim().toLowerCase() === 'delete';
}

function deleteCardCommand(command: string): string {
  return command.trim();
}

function deleteFileRunActions(actions: RunAction[] | undefined): RunAction[] {
  return (actions ?? []).filter((a) => a.selectorPath?.startsWith('delete-file:'));
}

function approvalActionsToRunActions(approval: Approval): RunAction[] {
  return approval.actions.map((a) => ({
    label: a.label,
    type:
      a.type === 'approve' ? 'run' as const
      : a.type === 'reject' ? 'skip' as const
      : a.type === 'approve_all' ? 'allow' as const
      : 'toggle' as const,
    selectorPath: a.selectorPath,
    ...(a.checked !== undefined ? { checked: a.checked } : {}),
  }));
}

/** Delete-only: tool Delete cards → run_command with stable delete-file paths. */
function promoteDeleteToolCards(messages: CursorState['messages'] | undefined): CursorState['messages'] {
  if (!messages?.length) return messages ?? [];
  return messages.map((m) => {
    if (m.type !== 'tool' || !/^delete$/i.test((m.action || '').trim())) return m;
    if (!m.actions?.some(isShellApprovalAction)) return m;

    const filename = (m.details || m.filename || '').trim();
    const actions: RunAction[] = [];
    for (const a of m.actions) {
      if (a.type === 'run') {
        actions.push({
          ...a,
          label: a.label || 'Accept',
          selectorPath: deleteFileAcceptPath(m.toolCallId, filename),
        });
      } else if (a.type === 'skip') {
        actions.push({
          ...a,
          label: a.label || 'Reject',
          selectorPath: deleteFileRejectPath(m.toolCallId, filename),
        });
      }
    }
    if (!actions.length) return m;

    return {
      type: 'run_command' as const,
      id: m.id,
      flatIndex: m.flatIndex,
      toolCallId: m.toolCallId,
      description: 'Delete',
      candidates: '',
      command: filename,
      actions,
    };
  });
}

/** Delete-only merge from pendingApprovals (DOM scan backup path). */
export function mergeDeleteFileApprovals(
  msgs: CursorState['messages'],
  approvals: Approval[],
): CursorState['messages'] {
  if (!approvals.length) return msgs;
  const out = msgs.slice();
  for (const approval of approvals) {
    if (!approval.id.startsWith('delete-file:')) continue;
    const runActions = approvalActionsToRunActions(approval);
    if (!runActions.length) continue;

    const rawId = approval.id.slice('delete-file:'.length);
    let idx = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i];
      if (m.type !== 'tool' && m.type !== 'run_command') continue;
      if ('toolCallId' in m && rawId && m.toolCallId === rawId) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      for (let i = out.length - 1; i >= 0; i--) {
        const m = out[i];
        if (m.type !== 'tool' && m.type !== 'run_command') continue;
        if (m.type === 'run_command' && isDeleteApprovalCard(m.description || '')) {
          const cmd = (m.command || '').replace(/\s+/g, ' ').trim();
          if (approval.command && cmd && (
            cmd === approval.command
            || cmd.includes(approval.command.slice(0, 40))
            || approval.command.includes(cmd.slice(0, 40))
          )) {
            idx = i;
            break;
          }
        }
        if (m.type === 'tool' && /^delet(e|ing)$/i.test((m.action || '').trim())) {
          const detailText = (m.details || '').replace(/\s+/g, ' ').trim();
          if (approval.command && detailText && (
            detailText.includes(approval.command.slice(0, 40))
            || approval.command.includes(detailText.slice(0, 40))
          )) {
            idx = i;
            break;
          }
        }
      }
    }
    if (idx < 0) {
      const flatIndex = out.length > 0 ? out[out.length - 1].flatIndex + 1 : 0;
      out.push({
        type: 'run_command',
        id: `delete-file-${rawId || approval.id}`,
        flatIndex,
        toolCallId: rawId || approval.id,
        description: approval.description || 'Delete',
        candidates: '',
        command: approval.command || '',
        actions: runActions,
      });
      continue;
    }

    const m = out[idx];
    const description = approval.description
      || (m.type === 'run_command' ? m.description : m.type === 'tool' ? m.action : '')
      || 'Delete';
    const command = deleteCardCommand(
      approval.command
      || (m.type === 'run_command' ? m.command : '')
      || (m.type === 'tool' ? (m.details || '') : ''),
    );
    out[idx] = {
      type: 'run_command',
      id: m.id,
      flatIndex: m.flatIndex,
      toolCallId: ('toolCallId' in m && m.toolCallId) ? m.toolCallId : approval.id,
      description,
      candidates: m.type === 'run_command' ? m.candidates : '',
      command,
      actions: runActions,
    };
  }
  return out;
}

function deletePendingForCard(m: RunCommand, deletePending: Approval[]): Approval | undefined {
  const id = m.toolCallId;
  const filename = (m.command || '').trim().toLowerCase();
  return deletePending.find((a) => {
    if (!a.id.startsWith('delete-file:')) return false;
    const rawId = a.id.slice('delete-file:'.length);
    if (id && rawId === id) return true;
    const pendingFile = (a.command || '').trim().toLowerCase();
    return !!(filename && pendingFile && (pendingFile === filename || pendingFile.includes(filename) || filename.includes(pendingFile)));
  });
}

function isActiveDeleteTool(msg: ChatElement | undefined): boolean {
  if (!msg || msg.type !== 'tool') return false;
  if (!/^delete$/i.test((msg.action || '').trim())) return false;
  return !!(msg.actions?.some(isShellApprovalAction));
}

function isDeletedTool(msg: ChatElement | undefined): boolean {
  return !!msg && msg.type === 'tool' && /^deleted$/i.test((msg.action || '').trim());
}

/**
 * Delete approval pipeline — separate from shell / confirm-search.
 * Recording 2026-07-03: pendingApprovals often empty; parser tool actions are the source of truth.
 */
export function applyDeleteFileApprovalCards(
  messages: CursorState['messages'] | undefined,
  deletePending: Approval[],
): CursorState['messages'] {
  const src = messages ?? [];
  let out = promoteDeleteToolCards(src);
  out = out.map((m) => {
    if (m.type !== 'run_command' || !isDeleteApprovalCard(m.description)) return m;
    const command = deleteCardCommand(m.command);
    const pending = deletePendingForCard(m, deletePending);
    if (pending) {
      return {
        ...m,
        command: deleteCardCommand(pending.command || command),
        actions: scopeDeleteActionsFromPending(m.toolCallId, command, pending),
      };
    }
    const srcTool = src.find(
      (msg) => msg.type === 'tool' && 'toolCallId' in msg && msg.toolCallId === m.toolCallId,
    );
    if (isDeletedTool(srcTool) || !isActiveDeleteTool(srcTool)) {
      return { ...m, command, actions: [] };
    }
    if (deletePending.length === 0) {
      return { ...m, command, actions: deleteFileRunActions(m.actions) };
    }
    return { ...m, command, actions: [] };
  });
  if (deletePending.length) out = mergeDeleteFileApprovals(out, deletePending);
  return out;
}

function scopeDeleteActionsFromPending(
  toolCallId: string,
  filename: string,
  approval: Approval,
): RunAction[] {
  const fromPending = approvalActionsToRunActions(approval).filter((a) =>
    a.selectorPath?.startsWith('delete-file:'),
  );
  if (fromPending.length) return fromPending;
  return [
    { label: 'Reject', type: 'skip', selectorPath: deleteFileRejectPath(toolCallId, filename) },
    { label: 'Accept', type: 'run', selectorPath: deleteFileAcceptPath(toolCallId, filename) },
  ];
}

/** Shell strip must not touch Delete run_command cards (handled above). */
export function isDeleteRunCommand(msg: ChatElement): msg is RunCommand {
  return msg.type === 'run_command' && isDeleteApprovalCard(msg.description);
}
