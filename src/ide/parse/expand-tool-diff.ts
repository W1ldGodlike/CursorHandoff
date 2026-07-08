import type { CdpClient } from '../cdp-client.js';
import type { CodeBlockItem } from '../../core/types.js';

/** One-shot expand: scroll diff viewport at most this many steps (not on every poll). */
export const EXPAND_DIFF_MAX_SCROLL_STEPS = 24;

/** Self-contained page script — must not reference bundled module helpers (CDP evaluate). */
const COMPOSER_SCROLL_SELECTORS = [
  '.agent-ui',
  '[class*="agent-ui"]',
  '[class*="composer"]',
  '.part.auxiliarybar',
];

const PAGE_HELPERS = `
  const SCROLL_SELECTORS = ${JSON.stringify(COMPOSER_SCROLL_SELECTORS)};
  const MAX_DIFF_SCROLL_STEPS = ${EXPAND_DIFF_MAX_SCROLL_STEPS};

  function scrollComposerStep(deltaY) {
    for (const sel of SCROLL_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const scrollable = el.querySelector('[class*="scroll"]') || el;
        scrollable.scrollTop = Math.max(0, scrollable.scrollTop + deltaY);
        scrollable.dispatchEvent(new WheelEvent('wheel', {
          deltaY,
          bubbles: true,
          cancelable: true,
        }));
        return true;
      } catch { /* skip */ }
    }
    return false;
  }

  async function scrollUntilFlatIndex(flatIndex) {
    for (let i = 0; i < 48; i++) {
      const anchor = document.querySelector('[data-flat-index="' + flatIndex + '"]');
      if (anchor) return anchor;
      scrollComposerStep(-Math.max(400, Math.floor(window.innerHeight * 0.7)));
      await new Promise((r) => setTimeout(r, 90));
    }
    return document.querySelector('[data-flat-index="' + flatIndex + '"]');
  }

  function findToolCard(toolCallId, flatIndex) {
    if (toolCallId && toolCallId.indexOf('edit-file-') === 0) {
      const wantFn = toolCallId.slice('edit-file-'.length);
      for (const card of document.querySelectorAll('.ui-tool-call-card')) {
        const fn = (card.querySelector('.ui-edit-tool-call__filename')?.textContent || '').trim();
        if (fn === wantFn) return card;
      }
    }
    for (const card of document.querySelectorAll('.ui-tool-call-card')) {
      const tid =
        card.querySelector('[data-tool-call-id]')?.getAttribute('data-tool-call-id')
        || card.closest('[data-tool-call-id]')?.getAttribute('data-tool-call-id');
      if (toolCallId && tid === toolCallId) return card;
      const row = card.closest('.virtualized-composer-messages-row, [data-flat-index]');
      const fi = row?.getAttribute('data-flat-index');
      if (flatIndex != null && fi != null && String(fi) === String(flatIndex)) return card;
    }
    return null;
  }

  function parseDiffLineKind(dataType) {
    if (dataType === 'removed') return 'rem';
    if (dataType === 'added') return 'add';
    return 'ctx';
  }

  function parseDiffRoot(diffRoot) {
    const diffLines = [];
    for (const lineEl of diffRoot.querySelectorAll('.ui-default-diff__line')) {
      const contentEl = lineEl.querySelector('.ui-default-diff__line-content');
      if (!contentEl) continue;
      const text = (contentEl.textContent || '').replace(/^\\n+/, '').replace(/\\u00a0/g, ' ').replace(/\\s+$/, '');
      const kind = parseDiffLineKind(lineEl.getAttribute('data-type'));
      if (!text && kind === 'ctx') continue;
      diffLines.push({ kind, text });
    }
    return diffLines;
  }

  function mergeDiffBatches(batches) {
    const seen = new Set();
    const merged = [];
    for (const batch of batches) {
      for (const line of batch) {
        const key = line.kind + '\\0' + line.text;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(line);
      }
    }
    return merged;
  }

  function pickDiffRoot(card) {
    let best = null;
    let bestCount = 0;
    for (const candidate of card.querySelectorAll('.ui-default-diff')) {
      const n = candidate.querySelectorAll('.ui-default-diff__line').length;
      if (n > bestCount) {
        bestCount = n;
        best = candidate;
      }
    }
    return best;
  }

  async function collectDiffFromCard(card) {
    const diffRoot = pickDiffRoot(card);
    if (!diffRoot) return null;

    const viewport = diffRoot.closest('.ui-scroll-area__viewport');
    const batches = [parseDiffRoot(diffRoot)];
    if (viewport && viewport.scrollHeight > viewport.clientHeight + 2) {
      viewport.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 40));
      const step = Math.max(32, Math.floor(viewport.clientHeight * 0.75));
      for (let i = 0; i < MAX_DIFF_SCROLL_STEPS; i++) {
        const prevTop = viewport.scrollTop;
        viewport.scrollTop = Math.min(viewport.scrollHeight, prevTop + step);
        await new Promise((r) => setTimeout(r, 45));
        batches.push(parseDiffRoot(diffRoot));
        const atBottom = viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 2;
        if (atBottom && viewport.scrollTop === prevTop) break;
        if (atBottom) break;
      }
      viewport.scrollTop = 0;
    }

    const diffLines = mergeDiffBatches(batches);
    if (!diffLines.length) return null;

    const filenameEl = card.querySelector(
      '.ui-edit-tool-call__filename, .composer-code-block-filename, .ui-code-block-filename',
    );
    const filename = filenameEl ? (filenameEl.textContent || '').trim() || undefined : undefined;
    let language;
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase();
      if (ext === 'ts' || ext === 'tsx') language = 'typescript';
      else if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') language = 'javascript';
      else if (ext === 'json') language = 'json';
      else if (ext === 'md') language = 'markdown';
      else if (ext === 'css') language = 'css';
      else if (ext === 'py') language = 'python';
    }
    const code = diffLines.map((d) => d.text).join('\\n');
    return { blockKind: 'diff', filename, language, code, diffLines };
  }

  async function expandCardIfCollapsed(card) {
    const body = card.querySelector('.ui-tool-call-card__body');
    const style = body?.getAttribute('style') || '';
    const collapsed = /max-height:\\s*80px/i.test(style);
    if (!collapsed) {
      return card.querySelectorAll('.ui-default-diff__line').length;
    }
    const btn = card.querySelector('.ui-tool-call-card__expand-button');
    if (btn instanceof HTMLElement) btn.click();
    else {
      const header = card.querySelector('.ui-tool-call-card__header');
      if (header instanceof HTMLElement) header.click();
      else return 0;
    }
    await new Promise((r) => setTimeout(r, 450));
    let lines = card.querySelectorAll('.ui-default-diff__line').length;
    if (lines < 6) {
      await new Promise((r) => setTimeout(r, 250));
      lines = card.querySelectorAll('.ui-default-diff__line').length;
    }
    return lines;
  }
`;

export function buildExpandToolDiffExpr(
  toolCallId: string,
  flatIndex: number | null,
): string {
  const fi = flatIndex == null ? 'null' : String(flatIndex);
  return `(async () => {
    ${PAGE_HELPERS}
    const toolCallId = ${JSON.stringify(toolCallId)};
    const flatIndex = ${fi};

    if (flatIndex != null) {
      const anchor = await scrollUntilFlatIndex(flatIndex);
      if (anchor) anchor.scrollIntoView({ block: 'center', behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 150));
    }

    let card = findToolCard(toolCallId, flatIndex);
    if (!card && flatIndex != null) {
      await new Promise((r) => setTimeout(r, 200));
      card = findToolCard(toolCallId, flatIndex);
    }
    if (!card) return { ok: false, reason: 'card_not_found' };

    card.scrollIntoView({ block: 'center', behavior: 'instant' });

    const body = card.querySelector('.ui-tool-call-card__body');
    const style = body?.getAttribute('style') || '';
    const collapsed = /max-height:\\s*80px/i.test(style);
    if (collapsed) {
      const lineCount = await expandCardIfCollapsed(card);
      if (!lineCount) return { ok: false, reason: 'no_expand_control' };
    }

    const diffBlock = await collectDiffFromCard(card);
    if (!diffBlock) return { ok: false, reason: 'no_diff' };
    return {
      ok: true,
      expanded: !collapsed,
      alreadyExpanded: !collapsed,
      lineCount: diffBlock.diffLines.length,
      diffBlock,
    };
  })()`;
}

export function expandedToolDiffKey(toolCallId?: string, flatIndex?: number): string {
  return `${toolCallId ?? ''}:${flatIndex ?? ''}`;
}

export async function expandToolDiffInCursor(
  client: CdpClient,
  opts: { toolCallId?: string; flatIndex?: number },
): Promise<{ ok: boolean; reason?: string; diffBlock?: CodeBlockItem }> {
  const expression = buildExpandToolDiffExpr(
    opts.toolCallId ?? '',
    opts.flatIndex ?? null,
  );
  const result = await client.evaluate(expression, 12000) as {
    ok: boolean;
    reason?: string;
    diffBlock?: CodeBlockItem;
  };
  if (!result?.ok) {
    return { ok: false, reason: result?.reason ?? 'expand_failed' };
  }
  return { ok: true, diffBlock: result.diffBlock };
}
