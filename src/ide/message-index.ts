/** Message wrapper in Cursor DOM (3.8+ — `data-message-index` instead of `data-flat-index`). */
export const MESSAGE_WRAPPER_SELECTOR = '[data-flat-index], [data-message-index]';

export function parseMessageWrapperIndex(el: {
  getAttribute(name: string): string | null;
}): number {
  const raw = el.getAttribute('data-flat-index') || el.getAttribute('data-message-index');
  return parseInt(raw || '0', 10);
}
