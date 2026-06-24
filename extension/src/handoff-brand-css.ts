/** Handoff brand palette — matches web login (`src/web/http-routes.ts`). */
export const HANDOFF_BRAND_ROOT_CSS = `
      --ho-teal: #269199;
      --ho-teal-hover: #228389;
      --ho-white: #ffffff;
      --ho-green: #3fa266;
      --btn: var(--ho-teal);
      --btn-fg: var(--ho-white);
`;

export function handoffVersionBrandHtml(version: string, escapeHtml: (s: string) => string): string {
  return `<span class="brand-cursor">Cursor</span><span class="brand-handoff">Handoff</span> <span class="brand-ver">v${escapeHtml(version)}</span>`;
}

export function handoffSidebarBrandHeaderHtml(
  version: string,
  logoUri: string,
  escapeHtml: (s: string) => string,
): string {
  return `<header class="brand-head">
    <img class="brand-mark" src="${escapeHtml(logoUri)}" width="56" height="56" alt="">
    <div class="brand-title"><span class="brand-cursor">Cursor</span><span class="brand-handoff">Handoff</span></div>
    <div class="brand-ver">v${escapeHtml(version)}</div>
  </header>`;
}
