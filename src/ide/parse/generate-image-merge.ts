import type { Approval, ChatElement, CursorState, RunAction, RunCommand } from '../../core/types.js';
import {
  generateImageRunPath,
  generateImageSkipPath,
  isGenerateImageAction,
  isGeneratedImageAction,
} from './generate-image-selectors.js';

const SHELL_ACTION_TYPES = new Set<RunAction['type']>(['run', 'skip', 'allow', 'toggle']);

function isShellApprovalAction(action: { type: string }): boolean {
  return SHELL_ACTION_TYPES.has(action.type as RunAction['type']);
}

export function isGenerateImageApprovalCard(description: string): boolean {
  return isGenerateImageAction(description);
}

function normalizeGenerateImageActions(
  toolCallId: string,
  actions: RunAction[] | undefined,
): RunAction[] {
  const out: RunAction[] = [];
  for (const a of actions ?? []) {
    if (a.type === 'run') {
      out.push({
        ...a,
        label: a.label || 'Generate',
        selectorPath: generateImageRunPath(toolCallId),
      });
    } else if (a.type === 'skip') {
      out.push({
        ...a,
        label: a.label || 'Skip',
        selectorPath: generateImageSkipPath(toolCallId),
      });
    }
  }
  return out;
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

function toGenerateImageRunCommand(
  m: { id: string; flatIndex: number; toolCallId: string },
  command: string,
  actions: RunAction[],
): RunCommand {
  return {
    type: 'run_command',
    id: m.id,
    flatIndex: m.flatIndex,
    toolCallId: m.toolCallId,
    description: 'Generate image',
    candidates: '',
    command: command.trim(),
    actions,
  };
}

/** GenerateImage tool / run_command cards → stable generate-image paths. */
function promoteGenerateImageToolCards(messages: CursorState['messages'] | undefined): CursorState['messages'] {
  if (!messages?.length) return messages ?? [];
  return messages.map((m) => {
    if (m.type === 'tool' && isGenerateImageAction(m.action || '') && m.actions?.some(isShellApprovalAction)) {
      const actions = normalizeGenerateImageActions(m.toolCallId, m.actions);
      if (!actions.length) return m;
      return toGenerateImageRunCommand(m, m.details || '', actions);
    }
    if (m.type === 'run_command' && isGenerateImageApprovalCard(m.description) && m.actions?.some(isShellApprovalAction)) {
      const actions = normalizeGenerateImageActions(m.toolCallId, m.actions);
      if (!actions.length) return m;
      return { ...m, actions };
    }
    return m;
  });
}

function isDoneGenerateImagePeer(msg: ChatElement | undefined): boolean {
  if (!msg || msg.type !== 'tool') return false;
  const action = (msg.action || '').trim();
  return isGeneratedImageAction(action) || /^image generation skipped$/i.test(action);
}

function isActiveGenerateImagePeer(msg: ChatElement | undefined): boolean {
  if (!msg) return false;
  if (msg.type === 'tool') {
    return isGenerateImageAction(msg.action || '') && !!msg.actions?.some(isShellApprovalAction);
  }
  if (msg.type === 'run_command' && isGenerateImageApprovalCard(msg.description)) {
    return !!msg.actions?.some(isShellApprovalAction);
  }
  return false;
}

function generatePendingForCard(m: RunCommand, generatePending: Approval[]): Approval | undefined {
  return generatePending.find((a) => {
    if (!a.id.startsWith('generate-image:')) return false;
    const rawId = a.id.slice('generate-image:'.length).replace(/:(run|skip)$/, '');
    return rawId === m.toolCallId || a.id.includes(m.toolCallId);
  });
}

export function applyGenerateImageApprovalCards(
  messages: CursorState['messages'] | undefined,
  generatePending: Approval[],
): CursorState['messages'] {
  const src = messages ?? [];
  let out = promoteGenerateImageToolCards(src);
  out = out.map((m) => {
    if (m.type !== 'run_command' || !isGenerateImageApprovalCard(m.description)) return m;
    const command = (m.command || '').trim();
    const pending = generatePendingForCard(m, generatePending);
    if (pending) {
      return {
        ...m,
        command: (pending.command || command).trim(),
        actions: normalizeGenerateImageActions(
          m.toolCallId,
          approvalActionsToRunActions(pending),
        ),
      };
    }
    const srcPeer = src.find(
      (msg) => 'toolCallId' in msg && msg.toolCallId === m.toolCallId
        && (msg.type === 'tool' || msg.type === 'run_command'),
    );
    if (isDoneGenerateImagePeer(srcPeer)) {
      return { ...m, command, actions: [] };
    }
    if (!isActiveGenerateImagePeer(srcPeer) && !isActiveGenerateImagePeer(m)) {
      return { ...m, command, actions: [] };
    }
    return {
      ...m,
      command,
      actions: normalizeGenerateImageActions(m.toolCallId, m.actions),
    };
  });

  if (generatePending.length) {
    out = mergeGenerateImageApprovals(out, generatePending);
  }
  return out;
}

function mergeGenerateImageApprovals(
  msgs: CursorState['messages'],
  approvals: Approval[],
): CursorState['messages'] {
  const out = msgs.slice();
  for (const approval of approvals) {
    if (!approval.id.startsWith('generate-image:')) continue;
    const runActions = normalizeGenerateImageActions(
      approval.id.slice('generate-image:'.length).replace(/:(run|skip)$/, ''),
      approvalActionsToRunActions(approval),
    );
    if (!runActions.length) continue;

    const rawId = approval.id.slice('generate-image:'.length).replace(/:(run|skip)$/, '');
    let idx = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i];
      if (m.type !== 'tool' && m.type !== 'run_command') continue;
      if ('toolCallId' in m && rawId && m.toolCallId === rawId) {
        idx = i;
        break;
      }
    }
    if (idx < 0) continue;

    const m = out[idx];
    out[idx] = {
      type: 'run_command',
      id: m.id,
      flatIndex: m.flatIndex,
      toolCallId: ('toolCallId' in m && m.toolCallId) ? m.toolCallId : rawId,
      description: 'Generate image',
      candidates: m.type === 'run_command' ? m.candidates : '',
      command: (approval.command || (m.type === 'run_command' ? m.command : '') || '').trim(),
      actions: runActions,
    };
  }
  return out;
}

/** Shell strip must not touch Generate image run_command cards. */
export function isGenerateImageRunCommand(msg: ChatElement): msg is RunCommand {
  return msg.type === 'run_command' && isGenerateImageApprovalCard(msg.description);
}

/** Completed GenerateImage tool line (no approval). */
export function isGeneratedImageTool(msg: ChatElement): boolean {
  return msg.type === 'tool' && isGeneratedImageAction(msg.action || '');
}
