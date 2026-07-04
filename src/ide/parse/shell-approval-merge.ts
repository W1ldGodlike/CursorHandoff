import type { Approval, ChatElement, CursorState, RunAction, RunCommand } from '../../core/types.js';
import { isPlausibleShellCommand, stripApprovalLabelBleedFromCommand } from './approval-command-text.js';

const SHELL_ACTION_TYPES = new Set<RunAction['type']>(['run', 'skip', 'allow', 'toggle']);

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

function isShellApprovalAction(action: { type: string }): boolean {
  return SHELL_ACTION_TYPES.has(action.type as RunAction['type']);
}

function normalizeShellCommandText(raw: string): string {
  const cmdLines = raw.replace(/^\$\s*/, '').split('\n');
  const nonEmpty = cmdLines.filter((l) => l.trim().length > 0);
  let minIndent = 0;
  if (nonEmpty.length > 0) {
    minIndent = Infinity;
    for (const line of nonEmpty) {
      const m = line.match(/^(\s*)/);
      const len = m ? m[1].length : 0;
      if (len < minIndent) minIndent = len;
    }
  }
  const text = stripApprovalLabelBleedFromCommand(
    cmdLines
      .map((l) => (l.length >= minIndent ? l.substring(minIndent) : l))
      .join('\n')
      .trim(),
  );
  return isPlausibleShellCommand(text) ? text : '';
}

function shellApprovalCardCommand(command: string): string {
  return isPlausibleShellCommand(command) ? stripApprovalLabelBleedFromCommand(command) : '';
}

function runCommandScore(msg: RunCommand): number {
  let score = 0;
  if (msg.actions?.length) score += 10_000;
  if (isPlausibleShellCommand(msg.command)) score += 100 + msg.command.length;
  return score;
}

function collapseResolvedShellRunCommand(msg: RunCommand): ChatElement {
  const command = shellApprovalCardCommand(msg.command);
  if (msg.actions?.length) {
    return { ...msg, command, actions: msg.actions };
  }
  if (command) {
    return { ...msg, command, actions: [] };
  }
  return {
    type: 'tool',
    id: msg.id,
    flatIndex: msg.flatIndex,
    toolCallId: msg.toolCallId,
    status: 'completed',
    action: msg.description || 'Shell',
    details: '',
  };
}

function isShellDedupeExempt(msg: RunCommand): boolean {
  const desc = msg.description.trim().toLowerCase();
  return desc === 'delete' || desc === 'confirm search' || desc === 'generate image';
}

export function dedupeShellRunCommandMessages(messages: ChatElement[]): ChatElement[] {
  const out: ChatElement[] = [];
  const runByDesc = new Map<string, number>();
  for (const m of messages) {
    if (m.type !== 'run_command') {
      out.push(m);
      continue;
    }
    if (isShellDedupeExempt(m)) {
      out.push(m);
      continue;
    }
    const key = m.toolCallId
      ? `tc:${m.toolCallId}`
      : `${(m.description || '').trim().toLowerCase()}\0${(m.command || '').trim().toLowerCase()}`;
    if (!key) {
      out.push(collapseResolvedShellRunCommand(m));
      continue;
    }
    const prevIdx = runByDesc.get(key);
    if (prevIdx === undefined) {
      const collapsed = collapseResolvedShellRunCommand(m);
      runByDesc.set(key, out.length);
      out.push(collapsed);
      continue;
    }
    const prev = out[prevIdx];
    if (prev.type !== 'run_command') {
      out.push(collapseResolvedShellRunCommand(m));
      continue;
    }
    if (runCommandScore(m) > runCommandScore(prev)) {
      out[prevIdx] = collapseResolvedShellRunCommand(m);
    }
  }
  return out;
}

/** Clear DOM-sourced shell approval buttons; shell pendingApprovals is the only source. */
export function stripShellApprovalActionsFromMessages(
  messages: CursorState['messages'] | undefined,
): CursorState['messages'] {
  if (!messages?.length) return messages ?? [];
  return messages.map((m) => {
    if (m.type === 'run_command') {
      const desc = m.description.trim().toLowerCase();
      if (desc === 'delete') return m;
      if (desc === 'confirm search') {
        return { ...m, command: m.command.trim(), actions: [] };
      }
      if (desc === 'generate image') return m;
      const command = shellApprovalCardCommand(m.command);
      return { ...m, command, actions: [] };
    }
    if (m.type === 'tool' && m.actions?.some(isShellApprovalAction)) {
      const action = (m.action || '').trim().toLowerCase();
      if (action === 'delete' || action === 'deleting') return m;
      if (action === 'generate image' || action === 'generating image') return m;
      const kept = m.actions.filter((a) => !isShellApprovalAction(a));
      return kept.length > 0 ? { ...m, actions: kept } : { ...m, actions: undefined };
    }
    return m;
  });
}

/** @deprecated use stripShellApprovalActionsFromMessages */
export const stripRunCommandApprovalActions = stripShellApprovalActionsFromMessages;

/** Shell Run/Skip only — tool: pending ids. */
export function mergeShellApprovalsIntoMessages(
  msgs: CursorState['messages'],
  approvals: Approval[],
): CursorState['messages'] {
  if (!approvals.length) return msgs;
  const out = msgs.slice();
  for (const approval of approvals) {
    if (approval.id.startsWith('delete-file:') || approval.id.startsWith('confirm-search:') || approval.id.startsWith('generate-image:')) continue;
    const runActions = approvalActionsToRunActions(approval);
    if (!runActions.length) continue;

    let idx = -1;
    const rawId = approval.id.startsWith('tool:') ? approval.id.slice(5) : '';
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i];
      if (m.type !== 'tool' && m.type !== 'run_command') continue;
      if (m.type === 'run_command' && isShellDedupeExempt(m)) continue;
      if ('toolCallId' in m && rawId && m.toolCallId === rawId) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      for (let i = out.length - 1; i >= 0; i--) {
        const m = out[i];
        if (m.type !== 'tool' && m.type !== 'run_command') continue;
        if (m.type === 'run_command' && isShellDedupeExempt(m)) continue;
        const actionText = m.type === 'tool' ? (m.action || '') : (m.description || '');
        if (
          actionText === approval.description
          || (actionText && approval.description && actionText.includes(approval.description))
          || (actionText && approval.description && approval.description.includes(actionText))
        ) {
          idx = i;
          break;
        }
      }
    }
    if (idx < 0) continue;

    const m = out[idx];
    const description =
      approval.description
      || (m.type === 'run_command' ? m.description : m.type === 'tool' ? m.action : '')
      || 'Pending approval';
    let command =
      approval.command
      || (m.type === 'run_command' ? m.command : '')
      || (m.type === 'tool' ? (m.details || '') : '');
    if (!command) {
      const blob = m.type === 'tool'
        ? `${m.action || ''} ${m.details || ''} ${'summaryText' in m ? (m.summaryText || '') : ''}`
        : description;
      const dollar = blob.replace(/\s+/g, ' ').indexOf('$');
      if (dollar >= 0) {
        command = normalizeShellCommandText(blob.slice(dollar));
      }
    } else {
      command = shellApprovalCardCommand(command);
    }
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

export function applyShellApprovalCards(
  messages: CursorState['messages'] | undefined,
  shellPending: Approval[],
): CursorState['messages'] {
  let out = stripShellApprovalActionsFromMessages(messages);
  if (shellPending.length) out = mergeShellApprovalsIntoMessages(out, shellPending);
  return dedupeShellRunCommandMessages(out);
}
