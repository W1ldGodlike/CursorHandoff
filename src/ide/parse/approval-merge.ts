import type { Approval, ChatElement, CursorState, RunAction, RunCommand } from '../../core/types.js';
import {
  CONFIRM_SEARCH_CANCEL,
  CONFIRM_SEARCH_CONTINUE,
  CONFIRM_SEARCH_TOGGLE,
} from './confirm-search-selectors.js';
import {
  deleteFileAcceptPath,
  deleteFileRejectPath,
  parseDeleteFilenameFromCardText,
} from './delete-file-selectors.js';

const SHELL_ACTION_TYPES = new Set<RunAction['type']>(['run', 'skip', 'allow', 'toggle']);

/** Strip approval-row button labels accidentally concatenated onto shell command text. */
export function stripApprovalLabelBleedFromCommand(cmd: string): string {
  let s = cmd;
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s
      .replace(/\s*(Shift\+)?⏎\s*$/g, '')
      .replace(/(Skip|Enable Auto-review|Run)+$/gi, '')
      .trimEnd();
  }
  return s;
}

/** Reject terminal table listings and compact-header junk mistaken for shell commands. */
export function isPlausibleShellCommand(cmd: string): boolean {
  const s = stripApprovalLabelBleedFromCommand(cmd).replace(/\s+/g, ' ').trim();
  if (!s || s.length > 8000) return false;
  if (/Name\s+Length/i.test(s)) return false;
  if (/----\s*-{2,}/.test(s)) return false;
  if (/(\.[a-z0-9]{1,10}\s+\d+\s*){2,}/i.test(s)) return false;
  if (/^\w{1,24},\s*\d+\+?\s*Name\s+Length/i.test(s)) return false;
  if (/^\w{1,24},\s*\d+\+?\s*$/i.test(s)) return false;
  return true;
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

function approvalCardCommand(description: string, command: string): string {
  const desc = description.trim().toLowerCase();
  if (desc === 'delete' || desc === 'confirm search') {
    return stripApprovalLabelBleedFromCommand(command).trim();
  }
  return isPlausibleShellCommand(command) ? stripApprovalLabelBleedFromCommand(command) : '';
}

function runCommandScore(msg: RunCommand): number {
  let score = 0;
  if (msg.actions?.length) score += 10_000;
  if (isPlausibleShellCommand(msg.command)) score += 100 + msg.command.length;
  return score;
}

function collapseResolvedRunCommand(msg: RunCommand): ChatElement {
  const command = approvalCardCommand(msg.description, msg.command);
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

function dedupeRunCommandMessages(messages: ChatElement[]): ChatElement[] {
  const out: ChatElement[] = [];
  const runByDesc = new Map<string, number>();
  for (const m of messages) {
    if (m.type !== 'run_command') {
      out.push(m);
      continue;
    }
    const key = m.toolCallId
      ? `tc:${m.toolCallId}`
      : `${(m.description || '').trim().toLowerCase()}\0${(m.command || '').trim().toLowerCase()}`;
    if (!key) {
      out.push(collapseResolvedRunCommand(m));
      continue;
    }
    const prevIdx = runByDesc.get(key);
    if (prevIdx === undefined) {
      const collapsed = collapseResolvedRunCommand(m);
      runByDesc.set(key, out.length);
      out.push(collapsed);
      continue;
    }
    const prev = out[prevIdx];
    if (prev.type !== 'run_command') {
      out.push(collapseResolvedRunCommand(m));
      continue;
    }
    if (runCommandScore(m) > runCommandScore(prev)) {
      out[prevIdx] = collapseResolvedRunCommand(m);
    }
  }
  return out;
}

/** Tool cards parsed with bubble-hash actions → run_command with stable click paths. */
function promoteToolApprovalCards(messages: CursorState['messages'] | undefined): CursorState['messages'] {
  if (!messages?.length) return messages ?? [];
  return messages.map((m) => {
    if (m.type !== 'tool' || !m.actions?.some(isShellApprovalAction)) return m;

    const actionLabel = (m.action || '').trim();
    if (/^delete$/i.test(actionLabel)) {
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
      if (actions.length) {
        return {
          type: 'run_command' as const,
          id: m.id,
          flatIndex: m.flatIndex,
          toolCallId: m.toolCallId,
          description: 'Delete',
          candidates: '',
          command: (m.details || m.filename || '').trim(),
          actions,
        };
      }
    }

    if (/^confirm search/i.test(actionLabel)) {
      const actions: RunAction[] = [];
      for (const a of m.actions) {
        if (a.type === 'run') {
          actions.push({ ...a, label: a.label || 'Continue', selectorPath: CONFIRM_SEARCH_CONTINUE });
        } else if (a.type === 'skip') {
          actions.push({ ...a, label: a.label || 'Cancel', selectorPath: CONFIRM_SEARCH_CANCEL });
        } else if (a.type === 'toggle') {
          actions.push({ ...a, selectorPath: CONFIRM_SEARCH_TOGGLE });
        }
      }
      if (actions.some((a) => a.type === 'run' || a.type === 'skip')) {
        return {
          type: 'run_command' as const,
          id: m.id,
          flatIndex: m.flatIndex,
          toolCallId: m.toolCallId,
          description: 'Confirm search',
          candidates: '',
          command: (m.details || '').trim(),
          actions,
        };
      }
    }

    return m;
  });
}

function isDeleteApprovalCard(description: string): boolean {
  return description.trim().toLowerCase() === 'delete';
}

function deleteFileRunActions(actions: RunAction[] | undefined): RunAction[] {
  return (actions ?? []).filter((a) => a.selectorPath?.startsWith('delete-file:'));
}

/** Clear DOM-sourced shell approval buttons; pendingApprovals is the only source of truth. */
export function stripShellApprovalActionsFromMessages(
  messages: CursorState['messages'] | undefined,
): CursorState['messages'] {
  if (!messages?.length) return messages ?? [];
  return messages.map((m) => {
    if (m.type === 'run_command') {
      const command = approvalCardCommand(m.description, m.command);
      const actions = isDeleteApprovalCard(m.description) ? deleteFileRunActions(m.actions) : [];
      return { ...m, command, actions };
    }
    if (m.type === 'tool' && m.actions?.some(isShellApprovalAction)) {
      const kept = m.actions.filter((a) => !isShellApprovalAction(a));
      return kept.length > 0 ? { ...m, actions: kept } : { ...m, actions: undefined };
    }
    return m;
  });
}

/** @deprecated use stripShellApprovalActionsFromMessages */
export const stripRunCommandApprovalActions = stripShellApprovalActionsFromMessages;

/** Attach Skip/Run (etc.) only while a matching approval is still pending in Cursor. */
export function mergeApprovalsIntoMessages(
  msgs: CursorState['messages'],
  approvals: Approval[],
): CursorState['messages'] {
  if (!approvals.length) return msgs;
  const out = msgs.slice();
  for (const approval of approvals) {
    const runActions = approvalActionsToRunActions(approval);
    if (!runActions.length) continue;

    let idx = -1;
    const rawId = approval.id.startsWith('tool:')
      ? approval.id.slice(5)
      : approval.id.startsWith('confirm-search:')
        ? approval.id.slice('confirm-search:'.length)
        : approval.id.startsWith('delete-file:')
          ? approval.id.slice('delete-file:'.length)
          : '';
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
    if (idx < 0 && approval.id.startsWith('confirm-search:')) {
      for (let i = out.length - 1; i >= 0; i--) {
        const m = out[i];
        if (m.type !== 'tool' && m.type !== 'run_command') continue;
        if (m.type === 'tool') {
          const actionText = (m.action || '').replace(/\s+/g, ' ').trim();
          if (/^Confirm search\b/i.test(actionText)) {
            idx = i;
            break;
          }
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
    if (idx < 0 && approval.id.startsWith('delete-file:')) {
      for (let i = out.length - 1; i >= 0; i--) {
        const m = out[i];
        if (m.type !== 'tool' && m.type !== 'run_command') continue;
        if ('toolCallId' in m && rawId && m.toolCallId === rawId) {
          idx = i;
          break;
        }
        if (m.type === 'run_command' && /^delete$/i.test((m.description || '').trim())) {
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
      if (approval.id.startsWith('confirm-search:')) {
        const flatIndex = out.length > 0 ? out[out.length - 1].flatIndex + 1 : 0;
        out.push({
          type: 'run_command',
          id: `confirm-search-${rawId || approval.id}`,
          flatIndex,
          toolCallId: rawId || approval.id,
          description: approval.description || 'Confirm search',
          candidates: '',
          command: approval.command || '',
          actions: runActions,
        });
      } else if (approval.id.startsWith('delete-file:')) {
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
      }
      continue;
    }

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
      command = approvalCardCommand(description, command);
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

export function applyApprovalActionsToMessages(state: CursorState): CursorState['messages'] {
  let messages = promoteToolApprovalCards(state.messages);
  messages = stripShellApprovalActionsFromMessages(messages);
  if (state.pendingApprovals.length > 0) {
    messages = mergeApprovalsIntoMessages(messages, state.pendingApprovals);
  }
  return dedupeRunCommandMessages(messages);
}
