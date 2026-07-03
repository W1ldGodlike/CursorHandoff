/** Stable magic paths for Confirm search approval clicks (CDP evaluate + TG hash). */
export const CONFIRM_SEARCH_CONTINUE = 'confirm-search:continue';
export const CONFIRM_SEARCH_CANCEL = 'confirm-search:cancel';
export const CONFIRM_SEARCH_TOGGLE = 'confirm-search:auto-search-toggle';

export function isConfirmSearchSelector(path: string): boolean {
  return path.startsWith('confirm-search:');
}
