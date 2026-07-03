import type { Approval, ChatElement, CursorState, RunAction, RunCommand } from '../../core/types.js';
import {
  confirmSearchCancelPath,
  confirmSearchContinuePath,
  confirmSearchTogglePath,
} from './confirm-search-selectors.js';

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

export function isConfirmSearchApprovalCard(description: string): boolean {
  return description.trim().toLowerCase() === 'confirm search';
}

export function isConfirmSearchRunCommand(msg: ChatElement): msg is RunCommand {
  return msg.type === 'run_command' && isConfirmSearchApprovalCard(msg.description);
}

function confirmSearchCardCommand(command: string): string {
  return command.trim();
}

function commandsRoughMatch(a: string, b: string): boolean {
  const x = a.replace(/\s+/g, ' ').trim().toLowerCase();
  const y = b.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!x || !y) return false;
  return x === y || x.includes(y.slice(0, 40)) || y.includes(x.slice(0, 40));
}

function messageCommand(m: ChatElement): string {
  if (m.type === 'run_command') return m.command || '';
  if (m.type === 'tool') return m.details || '';
  return '';
}

function scopeConfirmSearchActions(toolCallId: string, query: string, actions: RunAction[]): RunAction[] {
  return actions.map((a) => {
    const t = a.type;
    if (t === 'run') return { ...a, selectorPath: confirmSearchContinuePath(toolCallId, query) };
    if (t === 'skip') return { ...a, selectorPath: confirmSearchCancelPath(toolCallId, query) };
    if (t === 'toggle') return { ...a, selectorPath: confirmSearchTogglePath(toolCallId, query) };
    return a;
  });
}

function confirmSearchToolCallId(approval: Approval): string {
  return approval.id.startsWith('confirm-search:')
    ? approval.id.slice('confirm-search:'.length)
    : '';
}

function findConfirmSearchMessageIndex(
  msgs: CursorState['messages'],
  toolCallId: string,
  command: string,
): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.type !== 'tool' && m.type !== 'run_command') continue;
    if (!isConfirmSearchMessage(m)) continue;
    if (toolCallId && 'toolCallId' in m && m.toolCallId === toolCallId) return i;
  }
  if (!command) return -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!isConfirmSearchMessage(m)) continue;
    if (commandsRoughMatch(messageCommand(m), command)) return i;
  }
  return -1;
}

function isConfirmSearchMessage(m: ChatElement): boolean {
  if (m.type === 'run_command') return isConfirmSearchApprovalCard(m.description);
  if (m.type === 'tool') return /^confirm search\b/i.test((m.action || '').trim());
  return false;
}

/** Confirm-search only — match by toolCallId, else by query text. */
export function mergeConfirmSearchApprovals(
  msgs: CursorState['messages'],
  approvals: Approval[],
): CursorState['messages'] {
  if (!approvals.length) return msgs;
  const out = msgs.slice();
  const used = new Set<number>();
  for (const approval of approvals) {
    if (!approval.id.startsWith('confirm-search:')) continue;
    const toolCallId = confirmSearchToolCallId(approval);
    if (!toolCallId) continue;
    const query = approval.command || '';
    if (!query && !toolCallId) continue;

    let idx = findConfirmSearchMessageIndex(out, toolCallId, query);
    if (idx >= 0 && used.has(idx)) idx = -1;
    if (idx < 0) idx = findConfirmSearchMessageIndex(out, '', query);
    if (idx >= 0 && used.has(idx)) idx = -1;

    const mAtIdx = idx >= 0 ? out[idx] : undefined;
    const resolvedToolCallId =
      mAtIdx && (mAtIdx.type === 'run_command' || mAtIdx.type === 'tool') && mAtIdx.toolCallId
        ? mAtIdx.toolCallId
        : toolCallId;
    const resolvedQuery = idx >= 0
      ? confirmSearchCardCommand(query || messageCommand(out[idx]))
      : query;
    const runActions = scopeConfirmSearchActions(
      resolvedToolCallId,
      resolvedQuery,
      approvalActionsToRunActions(approval),
    );
    if (!runActions.length) continue;

    if (idx < 0) {
      const flatIndex = out.length > 0 ? out[out.length - 1].flatIndex + 1 : 0;
      out.push({
        type: 'run_command',
        id: `confirm-search-${resolvedToolCallId}`,
        flatIndex,
        toolCallId: resolvedToolCallId,
        description: approval.description || 'Confirm search',
        candidates: '',
        command: resolvedQuery,
        actions: runActions,
      });
      continue;
    }

    used.add(idx);
    const m = out[idx];
    const description = approval.description
      || (m.type === 'run_command' ? m.description : m.type === 'tool' ? m.action : '')
      || 'Confirm search';
    const command = resolvedQuery;
    out[idx] = {
      type: 'run_command',
      id: m.id,
      flatIndex: m.flatIndex,
      toolCallId: resolvedToolCallId,
      description,
      candidates: m.type === 'run_command' ? m.candidates : '',
      command,
      actions: runActions,
    };
  }
  return out;
}

/** Attach Continue/Cancel only while matching confirm-search approval is pending. */
export function applyConfirmSearchApprovalCards(
  messages: CursorState['messages'] | undefined,
  confirmPending: Approval[],
): CursorState['messages'] {
  const src = messages ?? [];
  let out: CursorState['messages'] = src.map((m) => {
    if (!isConfirmSearchRunCommand(m)) return m;
    return { ...m, command: confirmSearchCardCommand(m.command), actions: [] };
  });
  if (confirmPending.length) out = mergeConfirmSearchApprovals(out, confirmPending);
  return out;
}
