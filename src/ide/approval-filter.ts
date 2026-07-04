import type { Approval, CursorState } from '../core/types.js';
import { applyApprovalActionsToMessages } from './parse/approval-merge.js';

const MAX_DESC_LEN = 280;
const MAX_LABEL_LEN = 64;
const MAX_ID_LEN = 240;

/** Terminal output / JSON blobs mistaken for approval descriptions. */
const JUNK_DESC_PATTERNS = [
  /^\s*\{[\s\S]*"ok"\s*:/,
  /^\s*\{[\s\S]*"connected"\s*:/,
  /loading\s+[A-Za-z]:\//,
  /\+\d+\s+-\d+:/,
  /did not complete\s*\[E\]/i,
  /vector_math\s+\d/i,
];

const JUNK_LABELS = new Set(['run in background', 'cancel']);

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function looksLikeJunkDescription(description: string): boolean {
  const desc = normalize(description);
  if (!desc || desc.length > MAX_DESC_LEN) return true;
  return JUNK_DESC_PATTERNS.some((pat) => pat.test(desc));
}

function isKnownApproveLabel(label: string): boolean {
  const t = normalize(label).toLowerCase().replace(/\^+$/g, '');
  if (!t || t.length > MAX_LABEL_LEN) return false;
  if (JUNK_LABELS.has(t)) return false;
  if (t.startsWith('{') && t.includes('"ok"')) return false;
  if (t === 'run' || t === 'accept' || t === 'approve' || t === 'allow') return true;
  if (t === 'accept all' || t === 'continue' || t === 'generate') return true;
  if (t.startsWith('allowlist')) return true;
  return false;
}

function isKnownRejectLabel(label: string): boolean {
  const t = normalize(label).toLowerCase();
  if (!t || t.length > MAX_LABEL_LEN) return false;
  if (t === 'skip' || t === 'reject' || t === 'deny' || t === 'cancel') return true;
  if (JUNK_LABELS.has(t)) return false;
  return false;
}

function isKnownToggleLabel(label: string): boolean {
  const t = normalize(label).toLowerCase();
  return !!t && t.length <= MAX_LABEL_LEN;
}

/** Drops false DOM matches (terminal buttons, JSON dumps, reject-only matches). */
export function isActionableApproval(approval: Approval): boolean {
  if (!approval.actions.some((a) => a.type === 'approve' || a.type === 'approve_all')) {
    return false;
  }

  // delete-file ids may embed a DOM fallback path; do not drop before stable-prefix check
  if (!approval.id.startsWith('delete-file:') && !approval.id.startsWith('generate-image:') && approval.id.length > MAX_ID_LEN) return false;
  if (looksLikeJunkDescription(approval.description)) return false;

  for (const action of approval.actions) {
    const label = normalize(action.label);
    if (action.type === 'reject') {
      if (!isKnownRejectLabel(label)) return false;
    } else if (action.type === 'toggle') {
      if (!isKnownToggleLabel(label)) return false;
    } else if (!isKnownApproveLabel(label)) {
      return false;
    }
  }

  // Primary shell-tool / confirm-search / delete-file paths: stable ids.
  if (approval.id.startsWith('tool:') || approval.id.startsWith('confirm-search:') || approval.id.startsWith('delete-file:') || approval.id.startsWith('generate-image:')) return true;

  // Legacy fallback: need at least one canonical approve label.
  return approval.actions.some(
    (a) => (a.type === 'approve' || a.type === 'approve_all') && isKnownApproveLabel(a.label)
  );
}

export function filterActionableApprovals(approvals: Approval[]): Approval[] {
  return approvals.filter(isActionableApproval);
}

/** Removes junk approvals, syncs run_command action buttons, fixes agentStatus. */
export function applyApprovalFilter(state: CursorState): CursorState {
  const pendingApprovals = filterActionableApprovals(state.pendingApprovals);
  const messages = applyApprovalActionsToMessages({ ...state, pendingApprovals });

  let agentStatus = state.agentStatus;
  if (pendingApprovals.length > 0) {
    agentStatus = 'waiting_approval';
  } else if (agentStatus === 'waiting_approval') {
    agentStatus = 'idle';
  }

  return { ...state, pendingApprovals, messages, agentStatus };
}
