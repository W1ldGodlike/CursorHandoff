import type { Approval, CursorState } from '../core/types.js';

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
  const t = normalize(label).toLowerCase();
  if (!t || t.length > MAX_LABEL_LEN) return false;
  if (JUNK_LABELS.has(t)) return false;
  if (t.startsWith('{') && t.includes('"ok"')) return false;
  if (t === 'run' || t === 'accept' || t === 'approve' || t === 'allow') return true;
  if (t === 'accept all') return true;
  if (t.startsWith('allowlist')) return true;
  return false;
}

function isKnownRejectLabel(label: string): boolean {
  const t = normalize(label).toLowerCase();
  if (!t || t.length > MAX_LABEL_LEN) return false;
  if (JUNK_LABELS.has(t)) return false;
  return t === 'skip' || t === 'reject' || t === 'deny';
}

/** Drops false DOM matches (terminal buttons, JSON dumps, reject-only matches). */
export function isActionableApproval(approval: Approval): boolean {
  if (!approval.actions.some((a) => a.type === 'approve' || a.type === 'approve_all')) {
    return false;
  }

  if (approval.id.length > MAX_ID_LEN) return false;
  if (looksLikeJunkDescription(approval.description)) return false;

  for (const action of approval.actions) {
    const label = normalize(action.label);
    if (action.type === 'reject') {
      if (!isKnownRejectLabel(label)) return false;
    } else if (!isKnownApproveLabel(label)) {
      return false;
    }
  }

  // Primary shell-tool path: stable ids.
  if (approval.id.startsWith('tool:')) return true;

  // Legacy fallback: need at least one canonical approve label.
  return approval.actions.some(
    (a) => (a.type === 'approve' || a.type === 'approve_all') && isKnownApproveLabel(a.label)
  );
}

export function filterActionableApprovals(approvals: Approval[]): Approval[] {
  return approvals.filter(isActionableApproval);
}

/** Removes junk approvals and fixes agentStatus when none remain. */
export function applyApprovalFilter(state: CursorState): CursorState {
  const pendingApprovals = filterActionableApprovals(state.pendingApprovals);
  if (pendingApprovals.length === state.pendingApprovals.length) return state;

  let agentStatus = state.agentStatus;
  if (pendingApprovals.length === 0 && agentStatus === 'waiting_approval') {
    agentStatus = 'idle';
  }

  return { ...state, pendingApprovals, agentStatus };
}
