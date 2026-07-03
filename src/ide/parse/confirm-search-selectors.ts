/** Stable magic paths for Confirm search approval clicks (scoped by toolCallId + query). */
export const CONFIRM_SEARCH_PREFIX = 'confirm-search:';

/** @deprecated legacy global path — prefer scoped paths below */
export const CONFIRM_SEARCH_CONTINUE = 'confirm-search:continue';
/** @deprecated legacy global path — prefer scoped paths below */
export const CONFIRM_SEARCH_CANCEL = 'confirm-search:cancel';
/** @deprecated legacy global path — prefer scoped paths below */
export const CONFIRM_SEARCH_TOGGLE = 'confirm-search:auto-search-toggle';

function querySegment(query: string): string {
  const q = query.trim();
  if (!q) return '';
  return `:${encodeURIComponent(q.slice(0, 120))}`;
}

export function confirmSearchContinuePath(toolCallId: string, query = ''): string {
  return `${CONFIRM_SEARCH_PREFIX}${toolCallId}${querySegment(query)}:continue`;
}

export function confirmSearchCancelPath(toolCallId: string, query = ''): string {
  return `${CONFIRM_SEARCH_PREFIX}${toolCallId}${querySegment(query)}:cancel`;
}

export function confirmSearchTogglePath(toolCallId: string, query = ''): string {
  return `${CONFIRM_SEARCH_PREFIX}${toolCallId}${querySegment(query)}:auto-search-toggle`;
}

export function isConfirmSearchSelector(path: string): boolean {
  return path.startsWith(CONFIRM_SEARCH_PREFIX);
}

export function parseConfirmSearchSelector(
  path: string,
): { toolCallId: string; query?: string; kind: 'continue' | 'cancel' | 'toggle' } | null {
  const withQuery = path.match(/^confirm-search:([^:]+):([^:]+):(continue|cancel|auto-search-toggle)$/);
  if (withQuery && withQuery[2] !== 'continue' && withQuery[2] !== 'cancel' && withQuery[2] !== 'auto-search-toggle') {
    let query = withQuery[2];
    try {
      query = decodeURIComponent(query);
    } catch { /* keep raw */ }
    return {
      toolCallId: withQuery[1],
      query,
      kind: withQuery[3] === 'auto-search-toggle' ? 'toggle' : withQuery[3] as 'continue' | 'cancel',
    };
  }
  const plain = path.match(/^confirm-search:([^:]+):(continue|cancel|auto-search-toggle)$/);
  if (plain) {
    return {
      toolCallId: plain[1],
      kind: plain[2] === 'auto-search-toggle' ? 'toggle' : plain[2] as 'continue' | 'cancel',
    };
  }
  if (path === CONFIRM_SEARCH_CONTINUE) return { toolCallId: '', kind: 'continue' };
  if (path === CONFIRM_SEARCH_CANCEL) return { toolCallId: '', kind: 'cancel' };
  if (path === CONFIRM_SEARCH_TOGGLE) return { toolCallId: '', kind: 'toggle' };
  return null;
}
