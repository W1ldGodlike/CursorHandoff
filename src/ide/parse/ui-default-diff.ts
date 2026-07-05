import type { CodeBlockItem, DiffLineKind } from '../../core/types.js';

/** Map data-type / inline class on Cursor ui-default-diff lines → Handoff diff line kind. */
export function uiDefaultDiffLineKind(dataType: string | null): DiffLineKind {
  if (dataType === 'removed') return 'rem';
  if (dataType === 'added') return 'add';
  return 'ctx';
}

export function normalizeUiDefaultDiffLineText(raw: string): string {
  return raw.replace(/^\n+/, '').replace(/\u00a0/g, ' ').replace(/\s+$/, '');
}

export function languageFromFilename(filename?: string): string | undefined {
  if (!filename) return undefined;
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    py: 'python',
    rs: 'rust',
    go: 'go',
    sh: 'shell',
    ps1: 'powershell',
    yml: 'yaml',
    yaml: 'yaml',
  };
  return map[ext];
}

export function parseUiDefaultDiffRoot(diffRoot: Element): { kind: DiffLineKind; text: string }[] {
  const diffLines: { kind: DiffLineKind; text: string }[] = [];
  for (const lineEl of diffRoot.querySelectorAll('.ui-default-diff__line')) {
    const contentEl = lineEl.querySelector('.ui-default-diff__line-content');
    if (!contentEl) continue;
    const text = normalizeUiDefaultDiffLineText(contentEl.textContent || '');
    const kind = uiDefaultDiffLineKind(lineEl.getAttribute('data-type'));
    if (!text && kind === 'ctx') continue;
    diffLines.push({ kind, text });
  }
  return diffLines;
}

export function mergeDiffLineBatches(
  batches: { kind: DiffLineKind; text: string }[][],
): { kind: DiffLineKind; text: string }[] {
  const seen = new Set<string>();
  const merged: { kind: DiffLineKind; text: string }[] = [];
  for (const batch of batches) {
    for (const line of batch) {
      const key = `${line.kind}\0${line.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(line);
    }
  }
  return merged;
}

function resolveUiDefaultDiffSearchRoot(scope: Element): Element {
  return scope.querySelector('.ui-tool-call-card') || scope;
}

function pickUiDefaultDiffRoot(searchRoot: Element): Element | null {
  let best: Element | null = null;
  let bestCount = 0;
  for (const candidate of searchRoot.querySelectorAll('.ui-default-diff')) {
    const n = candidate.querySelectorAll('.ui-default-diff__line').length;
    if (n > bestCount) {
      bestCount = n;
      best = candidate;
    }
  }
  return best;
}

function buildCodeBlockItem(
  scope: Element,
  diffLines: { kind: DiffLineKind; text: string }[],
): CodeBlockItem | undefined {
  if (diffLines.length === 0) return undefined;
  const filenameEl = scope.querySelector(
    '.ui-edit-tool-call__filename, .composer-code-block-filename, .ui-code-block-filename',
  );
  const filename = filenameEl ? (filenameEl.textContent || '').trim() || undefined : undefined;
  const language = languageFromFilename(filename);
  const code = diffLines.map((d) => d.text).join('\n');
  return { blockKind: 'diff', filename, language, code, diffLines };
}

function diffViewportForRoot(diffRoot: Element): Element | null {
  const viewport = diffRoot.closest('.ui-scroll-area__viewport');
  return viewport instanceof Element ? viewport : null;
}

/** Scroll virtualized ui-default-diff viewport and merge visible slices (expand path only). */
export async function collectUiDefaultDiffLines(
  scope: Element,
  maxScrollSteps = 24,
): Promise<{ kind: DiffLineKind; text: string }[]> {
  const searchRoot = resolveUiDefaultDiffSearchRoot(scope);
  const diffRoot = pickUiDefaultDiffRoot(searchRoot);
  if (!diffRoot) return [];

  const viewport = diffViewportForRoot(diffRoot);
  const first = parseUiDefaultDiffRoot(diffRoot);
  if (!viewport || viewport.scrollHeight <= viewport.clientHeight + 2) {
    return first;
  }

  const batches: { kind: DiffLineKind; text: string }[][] = [first];
  viewport.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 40));

  const step = Math.max(32, Math.floor(viewport.clientHeight * 0.75));
  for (let guard = 0; guard < maxScrollSteps; guard++) {
    const prevTop = viewport.scrollTop;
    viewport.scrollTop = Math.min(viewport.scrollHeight, prevTop + step);
    await new Promise((r) => setTimeout(r, 45));
    batches.push(parseUiDefaultDiffRoot(diffRoot));
    const atBottom = viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 2;
    if (atBottom && viewport.scrollTop === prevTop) break;
    if (atBottom) break;
  }

  viewport.scrollTop = 0;
  return mergeDiffLineBatches(batches);
}

/** Parse Cursor `ui-default-diff` subtree (2026-07+ edit tools). */
export function extractUiDefaultDiffFromScope(scope: Element): CodeBlockItem | undefined {
  const searchRoot = resolveUiDefaultDiffSearchRoot(scope);
  const diffRoot = pickUiDefaultDiffRoot(searchRoot);
  if (!diffRoot) return undefined;
  return buildCodeBlockItem(scope, parseUiDefaultDiffRoot(diffRoot));
}

/** Async variant — scrolls virtualized diff viewports before parsing. */
export async function extractUiDefaultDiffFromScopeAsync(
  scope: Element,
): Promise<CodeBlockItem | undefined> {
  const diffLines = await collectUiDefaultDiffLines(scope);
  return buildCodeBlockItem(scope, diffLines);
}
