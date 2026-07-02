import type { CdpClient } from '../cdp-client.js';
import type {
  CodeBlockItem,
  CursorState,
  ChatElement,
  ChatTab,
  DiffLineKind,
  ModeInfo,
  ModelInfo,
  SelectorConfig,
} from '../../core/types.js';
import { applyDerivedActivityToState } from '../activity-derive.js';
import { applyApprovalFilter } from '../approval-filter.js';
import { logInfo, logWarn } from '../../core/log-event.js';
import type { LogContext } from '../../core/log-event.js';

const EVALUATE_TIMEOUT_MS = 5000;
const MAX_POLL_BACKOFF_MS = 5000;

function extractCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'cdp', op, ...extra };
}

/** Canonical tab title cleanup — matches cleanTabTitle extractionFunction for consistent lookup. */
export function cleanTabTitle(raw: string): string {
  let t = raw.trim().replace(/\s+/g, ' ');
  t = t.replace(/(@[\w./]+)+\s*$/, '');
  return t.trim().substring(0, 120);
}

/**
 * Runs in Cursor renderer via Runtime.evaluate.
 * Fully self-contained (no Node.js imports).
 *
 * Uses Cursor data attributes (data-flat-index / data-message-index, data-message-role,
 * data-message-kind, data-tool-status) for reliable extraction.
 */
export function extractionFunction(
  containerSelectors: string[],
  approveSelectors: string[],
  approveTextMatch: string[],
  rejectSelectors: string[],
  rejectTextMatch: string[],
  inputSelectors: string[],
  statusSelectors: string[],
  chatTabSelectors: string[],
  modeSelectors: string[],
  modelSelectors: string[],
  windowTitle?: string
): CursorState | null {
  function projectNameFromTitle(title: string): string {
    const idx = title.indexOf(' [');
    return (idx >= 0 ? title.substring(0, idx) : title).trim();
  }
  function findFirst(selectors: string[]): Element | null {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch { /* skip */ }
    }
    return null;
  }

  const MSG_WRAPPER_SEL = '[data-flat-index], [data-message-index]';

  function findChatContainer(selectors: string[]): Element | null {
    let best: Element | null = null;
    let bestCount = -1;
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const count = el.querySelectorAll(MSG_WRAPPER_SEL).length;
        if (count > bestCount) {
          best = el;
          bestCount = count;
        }
      } catch { /* skip */ }
    }
    return best;
  }

  function parseWrapperIndex(wrapper: Element): number {
    const raw = wrapper.getAttribute('data-flat-index') || wrapper.getAttribute('data-message-index');
    return parseInt(raw || '0', 10);
  }

  /**
   * Diff line stats from Edit tool UI. Legacy classes, then chip +N / -M
   * (Cursor sometimes omits or renames .ui-edit-tool-call__additions / __deletions).
   */
  function tryParseDiffStatsFromWrapper(scope: Element): { additions?: number; deletions?: number } {
    let additions: number | undefined;
    let deletions: number | undefined;
    const addEl = scope.querySelector('.ui-edit-tool-call__additions');
    const delEl = scope.querySelector('.ui-edit-tool-call__deletions');
    const addText = addEl?.textContent?.trim();
    const delText = delEl?.textContent?.trim();
    const addM = addText?.match(/\d+/);
    const delM = delText?.match(/\d+/);
    if (addM) additions = parseInt(addM[0], 10);
    if (delM) deletions = parseInt(delM[0], 10);
    if (additions !== undefined || deletions !== undefined) return { additions, deletions };

    for (const el of Array.from(scope.querySelectorAll('span, div, a'))) {
      const t = (el.textContent || '').trim();
      if (additions === undefined && /^\+\d+$/.test(t)) additions = parseInt(t.slice(1), 10);
      if (deletions === undefined && /^-\d+$/.test(t)) deletions = parseInt(t.slice(1), 10);
      if (additions !== undefined && deletions !== undefined) break;
    }
    return { additions, deletions };
  }

  function buildSelectorPath(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) {
        seg += `#${cur.id.replace(/([.:])/g, '\\$1')}`;
        parts.unshift(seg);
        break;
      }
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === cur!.tagName);
        if (siblings.length > 1) {
          seg += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(' > ');
  }

  try {
    const container = findChatContainer(containerSelectors);
    if (!container) return null;

    const flatIndexEls = container.querySelectorAll(MSG_WRAPPER_SEL);
    let containerComposerId =
      container.getAttribute('data-composer-id') ||
      container.closest('[data-composer-id]')?.getAttribute('data-composer-id') ||
      '';
    if (!containerComposerId && flatIndexEls.length > 0) {
      const firstMsg = flatIndexEls[0];
      containerComposerId = firstMsg.closest('[data-composer-id]')?.getAttribute('data-composer-id') || '';
    }

    const elements: ChatElement[] = [];
    const _rawElements: Array<{
      flatIndex: number; role?: string; kind?: string; messageId?: string;
      toolCallId?: string; toolStatus?: string; indicators: string[];
      textPreview: string; parsedAs: string;
    }> = [];

    function detectIndicators(el: Element): string[] {
      const flags: string[] = [];
      if (el.querySelector('.loading-indicator-v3')) flags.push('loading-v3');
      if (el.querySelector('.make-shine')) flags.push('make-shine');
      if (el.querySelector('.ui-collapsible.ui-step-group-collapsible')) flags.push('step-group');
      if (el.querySelector('.composer-tool-former-message')) flags.push('compact-tool');
      if (el.querySelector('.composer-terminal-tool-call-block-container') ||
          el.querySelector('.composer-tool-call-container.composer-terminal-compact-mode')) flags.push('run-command');
      if (el.querySelector('.plan-execution-message-content')) flags.push('plan-execution');
      if (el.querySelector('.composer-create-plan-container')) flags.push('plan-create');
      if (el.querySelector('.composer-edit-file-review-wrapper')) flags.push('edit-review');
      if (el.querySelector('.todo-list-container')) flags.push('todo-list');
      if (el.querySelector('.ui-tool-call-line-action')) flags.push('tool-line');
      if (el.querySelector('.ui-edit-tool-call__filename')) flags.push('edit-file');
      if (el.querySelector('.composer-message-group')) flags.push('message-group');
      if (el.querySelector('.markdown-root')) flags.push('markdown');
      if (el.querySelector('.aislash-editor-input-readonly')) flags.push('human-input');
      return flags;
    }

    function durationFromThoughtText(raw: string): string {
      const t = raw.trim();
      const forM = t.match(/\bfor\s+([\d.]+\s*s(?:ec(?:onds?)?)?)\b/i);
      if (forM) return forM[1].replace(/\s+/g, '');
      const bareM = t.match(/^([\d.]+\s*s(?:ec(?:onds?)?)?)$/i);
      if (bareM) return bareM[1].replace(/\s+/g, '');
      return '';
    }

    function isDurationOnlyThoughtSpan(raw: string): boolean {
      const t = raw.trim();
      if (/^for\s+/i.test(t)) return false;
      return !!durationFromThoughtText(t) && t.length <= 20;
    }

    /** Header shows completed time (for 2s or trailing 9s). */
    function collapsibleHeaderTextLooksComplete(ht: string): boolean {
      const t = ht.replace(/\s+/g, ' ').trim();
      if (!t) return false;
      if (/\bfor\s+[\d.]+\s*s(ec(onds?)?)?\b/i.test(t)) return true;
      if (/\b[\d.]+\s*s(ec(onds?)?)?\s*$/i.test(t)) return true;
      return false;
    }

    function parseThoughtSpansFromHeader(headerEl: Element | null): {
      action: string;
      detail: string;
      duration: string;
    } {
      if (!headerEl) return { action: '', detail: '', duration: '' };
      const headerSpans = headerEl.querySelectorAll(':scope > span');
      let action = '';
      let detail = '';
      let duration = '';
      for (const s of Array.from(headerSpans)) {
        if (s.classList.contains('cursor-icon') || s.classList.contains('ui-icon')) continue;
        const t = (s.textContent || '').trim();
        if (!t) continue;
        const d = durationFromThoughtText(t);
        if (d && !duration) duration = d;
        if (isDurationOnlyThoughtSpan(t)) continue;
        if (!action) {
          action = t;
          continue;
        }
        if (t.startsWith('for ')) {
          duration = duration || t.replace(/^for\s+/i, '').trim();
          detail = t;
        } else {
          detail = detail || t;
        }
      }
      if (!duration) {
        const fullHeader = (headerEl.textContent || '').replace(/\s+/g, ' ').trim();
        duration = durationFromThoughtText(fullHeader);
      }
      return { action, detail, duration };
    }

    type RawElRef = {
      flatIndex: number;
      role?: string;
      kind?: string;
      messageId?: string;
      toolCallId?: string;
      toolStatus?: string;
      indicators: string[];
      textPreview: string;
      parsedAs: string;
    };

    function cleanCodeLine(raw: string): string {
      return (raw || '').replace(/\u00a0/g, ' ').replace(/\r/g, '').trimEnd();
    }

    function trimOuterBlankCodeLines(lines: string[]): string[] {
      const out = [...lines];
      while (out.length > 0 && out[0].trim().length === 0) out.shift();
      while (out.length > 0 && out[out.length - 1].trim().length === 0) out.pop();
      return out;
    }

    function joinCodeLines(lines: string[]): string {
      return trimOuterBlankCodeLines(lines.map(cleanCodeLine)).join('\n');
    }

    function extractStructuredCodeText(root: Element): string {
      const parts: string[] = [];

      function ensureNewline(): void {
        if (parts.length === 0) return;
        const last = parts[parts.length - 1] || '';
        if (!last.endsWith('\n')) parts.push('\n');
      }

      function hasBlockishChildren(el: Element): boolean {
        return Array.from(el.children).some((child) => {
          const tag = (child.tagName || '').toLowerCase();
          return (
            tag === 'div' ||
            tag === 'p' ||
            tag === 'li' ||
            child.matches('.ui-default-code__line-content, .view-line, [data-line], .line')
          );
        });
      }

      function walk(node: Node): void {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const text = cleanCodeLine(node.textContent || '');
          if (text) parts.push(text);
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node as Element;
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'br') {
          ensureNewline();
          return;
        }

        const lineLike =
          el.matches('.ui-default-code__line-content, .view-line, [data-line], .line') ||
          ((tag === 'div' || tag === 'p' || tag === 'li') && !hasBlockishChildren(el));

        const beforeCount = parts.length;
        el.childNodes.forEach(walk);
        if (lineLike && parts.length > beforeCount) ensureNewline();
      }

      walk(root);
      return joinCodeLines(parts.join('').split('\n'));
    }

    function extractComposerPlainText(cb: Element): string {
      const codeContent = cb.querySelector('.ui-default-code__content');
      const contentRoot =
        codeContent ||
        cb.querySelector('.composer-code-block-content, .ui-code-block-content') ||
        cb;
      let code = '';
      if (codeContent) {
        const lineEls = codeContent.querySelectorAll('.ui-default-code__line-content');
        code =
          lineEls.length > 0
            ? joinCodeLines(
                Array.from(lineEls).map((l) => l.textContent || '')
              )
            : extractStructuredCodeText(codeContent);
      }
      if (!code) {
        const vl = cb.querySelectorAll('.view-line');
        if (vl.length > 0) {
          code = joinCodeLines(
            Array.from(vl)
              .map((line) => line.textContent || '')
              .filter((ln) => ln.trim().length > 0)
          );
        }
      }
      if (!code) {
        const diffEl = cb.querySelector('.composer-diff-block');
        if (diffEl) {
          const vl2 = diffEl.querySelectorAll('.view-line');
          code = joinCodeLines(Array.from(vl2).map((line) => line.textContent || ''));
        }
      }
      if (!code && contentRoot) code = extractStructuredCodeText(contentRoot);
      return code;
    }

    function parseTopPx(style: string | null | undefined): number | undefined {
      const m = (style || '').match(/top:\s*([\d.]+)px/);
      return m ? parseFloat(m[1]) : undefined;
    }

    function parseHeightPx(style: string | null | undefined): number | undefined {
      const m = (style || '').match(/height:\s*([\d.]+)px/);
      return m ? parseFloat(m[1]) : undefined;
    }

    function lineKindFromOverlays(editorRoot: Element, lineTop: number): 'add' | 'rem' | null {
      const overlayRows = editorRoot.querySelectorAll('.view-overlays > div');
      for (let i = 0; i < overlayRows.length; i++) {
        const row = overlayRows[i];
        const t = parseTopPx(row.getAttribute('style'));
        if (t === undefined || Math.abs(t - lineTop) > 2) continue;
        if (row.querySelector('.cdr.line-insert, .cdr.char-insert')) return 'add';
        if (row.querySelector('.cdr.line-delete, .cdr.char-delete')) return 'rem';
      }
      return null;
    }

    function lineRemFromViewZones(editorRoot: Element, lineTop: number, lineHeight: number): boolean {
      const zones = editorRoot.querySelectorAll('.view-zones > div');
      for (let i = 0; i < zones.length; i++) {
        const z = zones[i];
        if (!z.classList.contains('diagonal-fill')) continue;
        const t = parseTopPx(z.getAttribute('style'));
        const h = parseHeightPx(z.getAttribute('style')) || 16;
        if (t === undefined) continue;
        if (lineTop + lineHeight > t && lineTop < t + h) return true;
      }
      return false;
    }

    function extractViewLinesWithKinds(
      editorRoot: Element,
      side: 'original' | 'modified'
    ): { kind: DiffLineKind; text: string }[] {
      const lines = editorRoot.querySelectorAll('.view-lines > .view-line');
      const out: { kind: DiffLineKind; text: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const text = (line.textContent || '').replace(/\u00a0/g, ' ').replace(/\r/g, '').trimEnd();
        const lineTop = parseTopPx(line.getAttribute('style'));
        const ht = parseHeightPx(line.getAttribute('style')) || 16;
        let kind: DiffLineKind = 'ctx';
        const topPx = lineTop ?? 0;
        if (side === 'original') {
          const o = lineKindFromOverlays(editorRoot, topPx);
          if (o === 'rem') kind = 'rem';
          else if (lineRemFromViewZones(editorRoot, topPx, ht)) kind = 'rem';
        } else if (lineKindFromOverlays(editorRoot, topPx) === 'add') {
          kind = 'add';
        }
        out.push({ kind, text });
      }
      return out;
    }

    function parseUnifiedDiffLines(code: string): { kind: DiffLineKind; text: string }[] | undefined {
      const lines = (code || '').replace(/\r/g, '').split('\n');
      if (lines.length === 0) return undefined;

      let addCount = 0;
      let remCount = 0;
      let signalCount = 0;
      const diffLines: { kind: DiffLineKind; text: string }[] = [];

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        let kind: DiffLineKind = 'ctx';

        if (
          line.startsWith('*** Begin Patch') ||
          line.startsWith('*** Update File:') ||
          line.startsWith('*** Add File:') ||
          line.startsWith('*** Delete File:') ||
          line.startsWith('*** End Patch') ||
          line.startsWith('*** End of File') ||
          line.startsWith('diff --') ||
          line.startsWith('index ') ||
          line.startsWith('--- ') ||
          line.startsWith('+++ ')
        ) {
          kind = 'meta';
          signalCount++;
        } else if (line.startsWith('@@')) {
          kind = 'hunk';
          signalCount++;
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          kind = 'add';
          addCount++;
          signalCount++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          kind = 'rem';
          remCount++;
          signalCount++;
        }

        diffLines.push({ kind, text: line });
      }

      const looksDiff =
        (addCount > 0 || remCount > 0) &&
        (signalCount >= 2 || lines.some((line) => line.startsWith('@@') || line.startsWith('*** ')));

      return looksDiff ? diffLines : undefined;
    }

    function extractCodeBlockItem(cb: Element): CodeBlockItem {
      const headerEl = cb.querySelector('.ui-code-block-header');
      const filenameEl = cb.querySelector('.composer-code-block-filename, .ui-code-block-filename');
      const filename = filenameEl ? (filenameEl.textContent || '').trim() || undefined : undefined;
      const language = headerEl ? headerEl.getAttribute('data-language') || undefined : undefined;

      const diffEditor = cb.querySelector('.monaco-diff-editor');
      if (diffEditor) {
        const orig = diffEditor.querySelector('.editor.original');
        const mod = diffEditor.querySelector('.editor.modified');
        const diffLines: { kind: DiffLineKind; text: string }[] = [];
        if (orig) diffLines.push(...extractViewLinesWithKinds(orig, 'original'));
        if (mod) diffLines.push(...extractViewLinesWithKinds(mod, 'modified'));
        const code = diffLines.map(function (d) {
          return d.text;
        }).join('\n');
        return { blockKind: 'diff', filename, language, code, diffLines };
      }

      const code = extractComposerPlainText(cb);
      const parsedDiffLines = parseUnifiedDiffLines(code);
      if (parsedDiffLines) {
        return { blockKind: 'diff', filename, language, code, diffLines: parsedDiffLines };
      }
      return { blockKind: 'code', filename, language, code };
    }

    function extractDiffBlockFromScope(scope: Element): CodeBlockItem | undefined {
      const block = scope.querySelector('.composer-code-block-container, .composer-message-codeblock');
      if (!block) return undefined;
      return extractCodeBlockItem(block);
    }

    const isMenuTrigger = (btn: Element): boolean => {
      const popup = btn.getAttribute('aria-haspopup');
      return popup === 'menu' || popup === 'true' || popup === 'listbox';
    };
    const cleanBtnLabel = (raw: string): string =>
      raw.replace(/\s*(Shift\+)?⏎\s*/g, '').replace(/\s+/g, ' ').trim();

    function isPlausibleShellCommand(cmd: string): boolean {
      const s = cmd.replace(/\s+/g, ' ').trim();
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
      let text = cmdLines
        .map((l) => (l.length >= minIndent ? l.substring(minIndent) : l))
        .join('\n')
        .trim();
      let prev = '';
      while (text !== prev) {
        prev = text;
        text = text
          .replace(/\s*(Shift\+)?⏎\s*$/g, '')
          .replace(/(Skip|Enable Auto-review|Run)+$/gi, '')
          .trimEnd();
      }
      return isPlausibleShellCommand(text) ? text : '';
    }

    function shellTextWithoutApprovalRow(shellCall: Element): string {
      const clone = shellCall.cloneNode(true) as Element;
      for (const sel of [
        '.ui-shell-tool-call__approval-row',
        'button.ui-shell-tool-call__skip-btn',
        'button.ui-shell-tool-call__run-btn',
        'button.ui-shell-tool-call__allowlist-button',
      ]) {
        clone.querySelectorAll(sel).forEach((el) => el.remove());
      }
      return clone.textContent || '';
    }

    function extractShellRunFields(
      root: Element
    ): { description: string; command: string; candidates: string } | null {
      const shellCall =
        root.querySelector('.ui-shell-tool-call') ||
        (root.classList.contains('ui-shell-tool-call') ? root : null);
      if (!shellCall) return null;

      const descEl = shellCall.querySelector('.ui-shell-tool-call__description');
      const cmdEl = shellCall.querySelector('.ui-shell-tool-call__command');
      let description = (descEl?.textContent || '').trim();
      let command = cmdEl ? normalizeShellCommandText(cmdEl.textContent || '') : '';
      if (!command) {
        const legacyCmd =
          shellCall.querySelector('.composer-terminal-command-expanded-text') ||
          shellCall.querySelector('.composer-terminal-command-editor') ||
          root.querySelector('.composer-terminal-command-expanded-text') ||
          root.querySelector('.composer-terminal-command-editor');
        if (legacyCmd) command = normalizeShellCommandText(legacyCmd.textContent || '');
      }

      if (!command) {
        const raw = shellTextWithoutApprovalRow(shellCall).replace(/\s+/g, ' ');
        const dollar = raw.indexOf('$');
        if (dollar >= 0) {
          command = normalizeShellCommandText(raw.slice(dollar));
        }
      }
      if (!description && command) {
        const before = (root.textContent || '').split('$')[0] || '';
        description = before.replace(/\s+/g, ' ').trim().substring(0, 200);
      }
      if (!description && !command) return null;
      return { description: description || command.substring(0, 200), command, candidates: '' };
    }

    const SHELL_SKIP_SEL = 'button.ui-shell-tool-call__skip-btn';
    const SHELL_RUN_SEL = 'button.ui-shell-tool-call__run-btn';
    const SHELL_ALLOW_SEL = 'button.ui-shell-tool-call__allowlist-button';
    const SHELL_TOGGLE_SEL = '.ui-shell-tool-call__approval-row input[type="checkbox"], .ui-shell-tool-call__approval-row [role="checkbox"], .ui-shell-tool-call__approval-row [role="switch"]';

    function selectorForApprovalButton(btn: Element): string {
      if (btn.matches(SHELL_SKIP_SEL)) return SHELL_SKIP_SEL;
      if (btn.matches(SHELL_RUN_SEL)) return SHELL_RUN_SEL;
      if (btn.matches(SHELL_ALLOW_SEL)) return SHELL_ALLOW_SEL;
      return buildSelectorPath(btn);
    }

    function shellActionsToRunCommand(
      toolRoot: Element,
      flatIndex: number,
      messageId: string,
      toolCallId: string,
      shellFields: { description: string; command: string; candidates: string },
      actions: ReturnType<typeof extractToolActions>
    ): { element: ChatElement; parsedAs: string } {
      return {
        element: {
          type: 'run_command' as const,
          id: messageId,
          flatIndex,
          toolCallId,
          description: shellFields.description,
          candidates: shellFields.candidates,
          command: shellFields.command,
          actions,
        },
        parsedAs: 'run_command:shell',
      };
    }

    function extractToolActions(
      container: Element
    ): { label: string; type: 'run' | 'skip' | 'allow' | 'toggle'; selectorPath: string; checked?: boolean }[] {
      const actions: { label: string; type: 'run' | 'skip' | 'allow' | 'toggle'; selectorPath: string; checked?: boolean }[] = [];
      const seenPaths = new Set<string>();

      const pushAction = (action: { label: string; type: 'run' | 'skip' | 'allow' | 'toggle'; selectorPath: string; checked?: boolean }) => {
        if (!action.selectorPath || seenPaths.has(action.selectorPath)) return;
        seenPaths.add(action.selectorPath);
        actions.push(action);
      };

      const readToggleChecked = (el: Element): boolean => {
        const aria = el.getAttribute('aria-checked');
        if (aria === 'true') return true;
        if (aria === 'false') return false;
        const input = el as HTMLInputElement;
        return !!input.checked;
      };

      const readToggleLabel = (toggle: Element): string => {
        const labeled = toggle.closest('label');
        if (labeled) {
          const fromLabel = cleanBtnLabel(labeled.textContent || '');
          if (fromLabel) return fromLabel;
        }
        const aria = cleanBtnLabel(toggle.getAttribute('aria-label') || '');
        if (aria) return aria;
        const sibling = toggle.nextElementSibling;
        if (sibling) {
          const fromSibling = cleanBtnLabel(sibling.textContent || '');
          if (fromSibling) return fromSibling;
        }
        return '';
      };

      const extractShellApprovalRow = (row: Element) => {
        const skipBtn = row.querySelector(SHELL_SKIP_SEL);
        if (skipBtn && !isMenuTrigger(skipBtn)) {
          pushAction({
            label: cleanBtnLabel(skipBtn.textContent || '') || 'Skip',
            type: 'skip',
            selectorPath: SHELL_SKIP_SEL,
          });
        }

        const toggle = row.querySelector('input[type="checkbox"], [role="checkbox"], [role="switch"]');
        if (toggle && !isMenuTrigger(toggle)) {
          pushAction({
            label: readToggleLabel(toggle) || 'Enable Auto-review',
            type: 'toggle',
            selectorPath: SHELL_TOGGLE_SEL,
            checked: readToggleChecked(toggle),
          });
        }

        const runBtn = row.querySelector(SHELL_RUN_SEL);
        if (runBtn && !isMenuTrigger(runBtn)) {
          pushAction({
            label: cleanBtnLabel(runBtn.textContent || '') || 'Run',
            type: 'run',
            selectorPath: SHELL_RUN_SEL,
          });
        }

        const allowlistBtn = row.querySelector(SHELL_ALLOW_SEL);
        if (allowlistBtn && !isMenuTrigger(allowlistBtn)) {
          const lblEl = allowlistBtn.querySelector('.ui-shell-tool-call__allowlist-button-label');
          pushAction({
            label: cleanBtnLabel(lblEl?.textContent || allowlistBtn.textContent || '') || 'Allowlist',
            type: 'allow',
            selectorPath: SHELL_ALLOW_SEL,
          });
        }

        const skipLegacy = row.querySelector('.composer-skip-button');
        if (skipLegacy && !isMenuTrigger(skipLegacy)) {
          pushAction({
            label: cleanBtnLabel(skipLegacy.textContent || '') || 'Skip',
            type: 'skip',
            selectorPath: buildSelectorPath(skipLegacy),
          });
        }

        for (const btn of Array.from(row.querySelectorAll('button, [role="button"]'))) {
          if (isMenuTrigger(btn)) continue;
          const label = cleanBtnLabel(btn.textContent || btn.getAttribute('aria-label') || '');
          if (!label) continue;
          const lower = label.toLowerCase();
          const path = buildSelectorPath(btn);
          if (seenPaths.has(path)) continue;
          if (lower === 'skip' || lower === 'cancel' || lower === 'reject' || lower === 'deny') {
            pushAction({ label, type: 'skip', selectorPath: path });
          } else if (lower === 'run' || lower === 'continue' || lower === 'accept' || lower === 'approve') {
            pushAction({ label, type: 'run', selectorPath: path });
          }
        }
      };

      const approvalRow = container.querySelector('.ui-shell-tool-call__approval-row');
      if (approvalRow) extractShellApprovalRow(approvalRow);

      const statusRow = container.querySelector('.composer-tool-call-status-row');
      if (statusRow && !approvalRow) extractShellApprovalRow(statusRow);

      const skipBtn = container.querySelector('.composer-skip-button');
      if (skipBtn) {
        pushAction({
          label: 'Skip',
          type: 'skip',
          selectorPath: buildSelectorPath(skipBtn),
        });
      }

      const runBtns = container.querySelectorAll('.composer-run-button, .anysphere-secondary-button');
      for (const btn of Array.from(runBtns)) {
        const path = buildSelectorPath(btn);
        const btnText = (btn.textContent || '').replace(/[⏎⌘⇧]/g, '').trim();
        const isAllow =
          btn.classList.contains('anysphere-secondary-button') || btnText.toLowerCase().includes('allow');
        if (isAllow) {
          pushAction({ label: btnText, type: 'allow', selectorPath: path });
        } else {
          pushAction({ label: btnText || 'Run', type: 'run', selectorPath: path });
        }
      }

      return actions;
    }

    function extractAiTool(
      toolRoot: Element,
      flatIndex: number,
      messageId: string,
      patchRaw: RawElRef | null
    ): { element: ChatElement; parsedAs: string } | null {
      const toolEl = toolRoot.querySelector('[data-tool-call-id]') || toolRoot;
      const toolCallId = toolEl.getAttribute('data-tool-call-id') || `tool-${flatIndex}`;
      const toolStatus = (toolEl.getAttribute('data-tool-status') ||
        toolRoot.getAttribute('data-tool-status') ||
        'completed') as 'loading' | 'completed';
      if (patchRaw) {
        patchRaw.toolCallId = toolCallId;
        patchRaw.toolStatus = toolStatus;
      }

      const planContainer = toolRoot.querySelector('.composer-create-plan-container');
      if (planContainer) {
        const label = (planContainer.querySelector('.composer-create-plan-label')?.textContent || '').trim();
        const title = (planContainer.querySelector('.composer-create-plan-title')?.textContent || '').trim();
        const descRoot = planContainer.querySelector('.composer-create-plan-text .markdown-root');
        const description = descRoot ? (descRoot.textContent || '').trim() : undefined;
        const descriptionHtml = descRoot ? (descRoot.innerHTML || '').trim() : undefined;

        const todoItems = planContainer.querySelectorAll('.composer-create-plan-todo-item');
        const todos: { text: string; status: 'pending' | 'completed' | 'in_progress' }[] = [];
        let todosCompleted = 0;
        let todosTotal = 0;
        let todosMoreCount: number | undefined;
        for (const item of Array.from(todoItems)) {
          if (item.querySelector('.composer-plan-todo-ellipsis')) {
            const moreEl = item.querySelector('.composer-plan-todo-more-text');
            const moreText = (moreEl?.textContent || '').trim();
            const moreMatch = moreText.match(/(\d+)\s+more/i);
            if (moreMatch) todosMoreCount = parseInt(moreMatch[1], 10);
            continue;
          }
          const contentEl = item.querySelector('.composer-create-plan-todo-content');
          if (!contentEl) continue;
          const text = (contentEl.textContent || '').trim();
          if (!text) continue;
          const indicator = item.querySelector('.composer-plan-todo-indicator');
          let status: 'pending' | 'completed' | 'in_progress' = 'pending';
          if (indicator) {
            const cls = indicator.className || '';
            if (cls.includes('completed')) {
              status = 'completed';
              todosCompleted++;
            } else if (cls.includes('in_progress') || cls.includes('in-progress')) status = 'in_progress';
          }
          todosTotal++;
          todos.push({ text, status });
        }

        const todosHeader = (planContainer.querySelector('.composer-create-plan-todos-header')?.textContent || '').trim();
        const headerMatch = todosHeader.match(/(\d+)/);
        if (headerMatch && todosTotal === 0) {
          todosTotal = parseInt(headerMatch[0], 10);
        }

        const actions: { label: string; type: 'view_plan' | 'build'; selectorPath: string }[] = [];
        const viewPlanBtn = planContainer.querySelector('.composer-create-plan-view-plan-button');
        if (viewPlanBtn) {
          actions.push({
            label: 'View Plan',
            type: 'view_plan' as const,
            selectorPath: buildSelectorPath(viewPlanBtn),
          });
        }
        let buildBtn: Element | null = null;
        const buildCandidates = planContainer.querySelectorAll('.composer-create-plan-build-button');
        for (const b of Array.from(buildCandidates)) {
          const tx = (b.textContent || '').replace(/\s+/g, ' ').trim();
          if (/build/i.test(tx) && tx.length > 2) {
            buildBtn = b;
            break;
          }
        }
        if (!buildBtn && buildCandidates.length > 0) buildBtn = buildCandidates[0];
        if (buildBtn) {
          actions.push({ label: 'Build', type: 'build' as const, selectorPath: buildSelectorPath(buildBtn) });
        }

        const modelEl = planContainer.querySelector('.composer-unified-dropdown-model');
        let model: string | undefined;
        let modelDropdownSelectorPath: string | undefined;
        if (modelEl) {
          modelDropdownSelectorPath = buildSelectorPath(modelEl);
          const spans = modelEl.querySelectorAll('span');
          for (const s of Array.from(spans)) {
            const t = (s.textContent || '').trim();
            if (t && !t.includes('chevron') && t.length > 1) {
              model = t;
              break;
            }
          }
        }

        return {
          element: {
            type: 'plan' as const,
            id: messageId,
            flatIndex,
            label,
            title,
            description,
            descriptionHtml: descriptionHtml || undefined,
            todosCompleted,
            todosTotal,
            todos: todos.length > 0 ? todos : undefined,
            todosMoreCount,
            model,
            modelDropdownSelectorPath,
            actions: actions.length > 0 ? actions : undefined,
          },
          parsedAs: 'plan',
        };
      }

      const runContainer =
        toolRoot.querySelector('.composer-terminal-tool-call-block-container') ||
        toolRoot.querySelector('.composer-tool-call-container.composer-terminal-compact-mode');
      const shellFieldsEarly = extractShellRunFields(toolRoot);
      const shellActionsEarly = extractToolActions(toolRoot);
      if (
        shellFieldsEarly &&
        (shellActionsEarly.length > 0 || isPlausibleShellCommand(shellFieldsEarly.command))
      ) {
        return shellActionsToRunCommand(
          toolRoot,
          flatIndex,
          messageId,
          toolCallId,
          shellFieldsEarly,
          shellActionsEarly,
        );
      }

      if (runContainer) {
        const descEl = runContainer.querySelector('.composer-terminal-top-header-description');
        const candidatesEl = runContainer.querySelector('.composer-terminal-top-header-candidates');
        const commandEl =
          runContainer.querySelector('.composer-terminal-command-expanded-text') ||
          runContainer.querySelector('.composer-terminal-command-editor') ||
          runContainer.querySelector('.composer-terminal-command-wrapper') ||
          runContainer.querySelector('.composer-tool-call-header-content');
        const description = (descEl?.textContent || '').trim();
        const candidates = (candidatesEl?.textContent || '').trim();

        let command = '';
        if (commandEl) {
          const rawCmd = (commandEl.textContent || '').replace(/^\$\s*/, '');
          const cmdLines = rawCmd.split('\n');
          const nonEmpty = cmdLines.filter(function (l: string) {
            return l.trim().length > 0;
          });
          let minIndent = 0;
          if (nonEmpty.length > 0) {
            minIndent = Infinity;
            for (let li = 0; li < nonEmpty.length; li++) {
              const m = nonEmpty[li].match(/^(\s*)/);
              const len = m ? m[1].length : 0;
              if (len < minIndent) minIndent = len;
            }
          }
          command = cmdLines
            .map(function (l: string) {
              return l.length >= minIndent ? l.substring(minIndent) : l;
            })
            .join('\n')
            .trim();
        }

        const runActions = extractToolActions(runContainer);

        return {
          element: {
            type: 'run_command' as const,
            id: messageId,
            flatIndex,
            toolCallId,
            description,
            candidates,
            command,
            actions: runActions,
          },
          parsedAs: 'run_command',
        };
      }

      const editReviewEl = toolRoot.querySelector('.composer-edit-file-review-wrapper');
      if (editReviewEl) {
        const filenameEl = editReviewEl.querySelector('.composer-code-block-filename');
        const filename = filenameEl ? (filenameEl.textContent || '').trim() : undefined;

        const statusSpans = editReviewEl.querySelectorAll('.composer-code-block-status span');
        let additions: number | undefined;
        let deletions: number | undefined;
        for (const s of Array.from(statusSpans)) {
          const t = (s.textContent || '').trim();
          const addM = t.match(/^\+(\d+)$/);
          const delM = t.match(/^-(\d+)$/);
          if (addM) additions = parseInt(addM[1], 10);
          if (delM) deletions = parseInt(delM[1], 10);
        }
        const editDiffFb = tryParseDiffStatsFromWrapper(editReviewEl);
        if (additions === undefined) additions = editDiffFb.additions;
        if (deletions === undefined) deletions = editDiffFb.deletions;

        const blockedPill = editReviewEl.querySelector('.block-attribution-pill');
        const blocked = blockedPill
          ? (blockedPill.getAttribute('aria-label') || blockedPill.textContent || '').trim()
          : undefined;

        const statusRow = editReviewEl.querySelector('.composer-tool-call-status-row');
        const editActions = statusRow
          ? extractToolActions(statusRow)
          : extractToolActions(editReviewEl);

        const diffBlock = extractDiffBlockFromScope(editReviewEl);
        return {
          element: {
            type: 'tool' as const,
            id: messageId,
            flatIndex,
            toolCallId,
            status: toolStatus,
            action: 'Edit',
            details: '',
            filename,
            additions,
            deletions,
            blocked: blocked || undefined,
            actions: editActions.length > 0 ? editActions : undefined,
            ...(diffBlock ? { diffBlock } : {}),
          },
          parsedAs: 'tool:edit-review',
        };
      }

      const todoListContainer = toolRoot.querySelector('.todo-list-container');
      if (todoListContainer) {
        const headerElTodo = todoListContainer.querySelector('.todo-list-header-left-title');
        const title = (headerElTodo?.textContent || 'To-dos').replace(/\d+\s*$/, '').trim();
        const todoItems2 = todoListContainer.querySelectorAll('.ui-todo-item');
        const todos2: { text: string; status: 'pending' | 'completed' | 'in_progress' }[] = [];
        let todosCompleted2 = 0;
        for (const item of Array.from(todoItems2)) {
          const contentEl2 = item.querySelector('.ui-todo-item__content');
          const text = (contentEl2?.textContent || '').trim();
          if (!text) continue;
          const cls = item.className || '';
          let status: 'pending' | 'completed' | 'in_progress' = 'pending';
          if (cls.includes('completed')) {
            status = 'completed';
            todosCompleted2++;
          } else if (cls.includes('dimmed') || (contentEl2 && contentEl2.className.includes('in-progress'))) {
            status = 'in_progress';
          }
          todos2.push({ text, status });
        }
        return {
          element: {
            type: 'todo_list' as const,
            id: messageId,
            flatIndex,
            title,
            todosCompleted: todosCompleted2,
            todosTotal: todos2.length,
            todos: todos2,
          },
          parsedAs: 'todo_list',
        };
      }

      const compactEl = toolRoot.querySelector('.composer-tool-former-message');
      if (compactEl) {
        let actionPart = '';
        let descPart = '';

        const headerContent = compactEl.querySelector('.composer-tool-call-header-content');
        if (headerContent) {
          const headerSpans = headerContent.querySelectorAll('span');
          for (const s of Array.from(headerSpans)) {
            const txt = (s.textContent || '').trim();
            if (!txt) continue;
            if (s.classList.toString().includes('codicon') || s.classList.toString().includes('cursor-icon')) continue;
            if (!actionPart) {
              actionPart = txt;
            } else if (!descPart) {
              descPart = txt;
            }
          }
        } else {
          const spans = compactEl.querySelectorAll('span');
          for (const s of Array.from(spans)) {
            if (s.closest('.composer-tool-call-control-row') || s.closest('.composer-tool-call-status-row')) continue;
            const txt = (s.textContent || '').trim();
            if (!txt) continue;
            if (s.classList.toString().includes('codicon') || s.classList.toString().includes('cursor-icon')) continue;
            if (s.classList.contains('truncate-one-line') || s.classList.toString().includes('truncate')) {
              descPart = txt;
            } else if (!actionPart) {
              actionPart = txt;
            }
          }
        }

        const compactActions = extractToolActions(toolRoot);
        const shellFields = extractShellRunFields(toolRoot);
        if (shellFields && (compactActions.length > 0 || isPlausibleShellCommand(shellFields.command))) {
          return shellActionsToRunCommand(
            toolRoot,
            flatIndex,
            messageId,
            toolCallId,
            shellFields,
            compactActions,
          );
        }

        if (compactActions.length > 0) {
          const fullText = (toolRoot.textContent || '').replace(/\s+/g, ' ');
          const dollar = fullText.indexOf('$');
          if (dollar >= 0) {
            const command = normalizeShellCommandText(fullText.slice(dollar));
            const description = (actionPart || descPart || fullText.slice(0, dollar).replace(/\s+/g, ' ').trim())
              .substring(0, 200);
            return shellActionsToRunCommand(
              toolRoot,
              flatIndex,
              messageId,
              toolCallId,
              {
                description: description || command.substring(0, 80),
                command,
                candidates: '',
              },
              compactActions,
            );
          }
        }

        const summaryText = headerContent
          ? ''
          : (compactEl.textContent || '').trim();
        const compactDiff = tryParseDiffStatsFromWrapper(toolRoot);
        const diffBlockCompact = extractDiffBlockFromScope(toolRoot);
        return {
          element: {
            type: 'tool' as const,
            id: messageId,
            flatIndex,
            toolCallId,
            status: toolStatus,
            action: actionPart || '',
            details: descPart || '',
            summaryText: !actionPart && !descPart && summaryText ? summaryText : undefined,
            additions: compactDiff.additions,
            deletions: compactDiff.deletions,
            actions: compactActions.length > 0 ? compactActions : undefined,
            ...(diffBlockCompact ? { diffBlock: diffBlockCompact } : {}),
          },
          parsedAs: 'tool:compact',
        };
      }

      const actionEl = toolRoot.querySelector('.ui-tool-call-line-action');
      const detailsEl = toolRoot.querySelector('.ui-tool-call-line-details');
      let action = (actionEl?.textContent || '').trim();
      let details = (detailsEl?.textContent || '').trim();

      const filenameEl2 = toolRoot.querySelector('.ui-edit-tool-call__filename');
      const additionsEl = toolRoot.querySelector('.ui-edit-tool-call__additions');
      const deletionsEl = toolRoot.querySelector('.ui-edit-tool-call__deletions');
      const filename2 = filenameEl2 ? (filenameEl2.textContent || '').trim() : undefined;
      const addMatch = additionsEl ? (additionsEl.textContent || '').match(/\d+/) : null;
      const delMatch = deletionsEl ? (deletionsEl.textContent || '').match(/\d+/) : null;
      let additions2 = addMatch ? parseInt(addMatch[0], 10) : undefined;
      let deletions2 = delMatch ? parseInt(delMatch[0], 10) : undefined;
      const lineDiffFb = tryParseDiffStatsFromWrapper(toolRoot);
      if (additions2 === undefined) additions2 = lineDiffFb.additions;
      if (deletions2 === undefined) deletions2 = lineDiffFb.deletions;

      const shellCmd = toolRoot.querySelector('.ui-shell-tool-call__command');
      if (shellCmd && !details) details = (shellCmd.textContent || '').trim();

      if (!action) {
        const cardHeader = toolRoot.querySelector('.ui-tool-call-card__header');
        if (cardHeader) action = (cardHeader.textContent || '').trim().split('\n')[0].trim();
      }

      if (!action) {
        const fullText = (toolRoot.textContent || '').trim();
        if (fullText.length > 0 && fullText.length < 200) {
          action = fullText.substring(0, 60);
        }
      }

      const diffBlockLine = extractDiffBlockFromScope(toolRoot);
      const fallbackActions = extractToolActions(toolRoot);
      const shellFieldsFallback = extractShellRunFields(toolRoot);
      if (shellFieldsFallback && (fallbackActions.length > 0 || isPlausibleShellCommand(shellFieldsFallback.command))) {
        return shellActionsToRunCommand(
          toolRoot,
          flatIndex,
          messageId,
          toolCallId,
          shellFieldsFallback,
          fallbackActions,
        );
      }
      return {
        element: {
          type: 'tool' as const,
          id: messageId,
          flatIndex,
          toolCallId,
          status: toolStatus,
          action: action || 'Tool',
          details,
          filename: filename2 || (action === 'Edit' || action === 'Write' ? details : undefined),
          additions: additions2,
          deletions: deletions2,
          actions: fallbackActions.length > 0 ? fallbackActions : undefined,
          ...(diffBlockLine ? { diffBlock: diffBlockLine } : {}),
        },
        parsedAs: !action && !details && !filename2 ? 'tool:fallback' : 'tool',
      };
    }

    for (const wrapper of Array.from(flatIndexEls)) {
      const flatIndex = parseWrapperIndex(wrapper);

      const msgEl = wrapper.querySelector('[data-message-role]') || wrapper;
      const role = msgEl.getAttribute('data-message-role');
      const kind = msgEl.getAttribute('data-message-kind');
      const messageId = msgEl.getAttribute('data-message-id') || `fi-${flatIndex}`;

      const rawEl = {
        flatIndex,
        role: role || undefined,
        kind: kind || undefined,
        messageId,
        toolCallId: undefined as string | undefined,
        toolStatus: undefined as string | undefined,
        indicators: detectIndicators(wrapper),
        textPreview: (wrapper.textContent || '').trim().substring(0, 120),
        parsedAs: 'unknown',
      };
      _rawElements.push(rawEl);

      // --- Loading indicator (skip as content — handled as agentActivity) ---
      if (wrapper.querySelector('.loading-indicator-v3')) {
        rawEl.parsedAs = 'skipped:loading';
        continue;
      }

      // --- Composer message group: Explored + nested ui-thinking-collapsible + tools (one flat-index) ---
      const composerGroup = wrapper.querySelector('.composer-message-group');
      const stepGroupCollapsible = wrapper.querySelector('.ui-collapsible.ui-step-group-collapsible');
      if (composerGroup && stepGroupCollapsible) {
        rawEl.parsedAs = 'message-group';
        const outerHeader = stepGroupCollapsible.querySelector(':scope > .ui-collapsible-header');
        const outerParsed = parseThoughtSpansFromHeader(outerHeader);
        if (outerParsed.action || outerParsed.detail || outerParsed.duration) {
          elements.push({
            type: 'thought' as const,
            id: `thought-${flatIndex}-summary`,
            flatIndex,
            duration: outerParsed.duration,
            action: outerParsed.action || undefined,
            detail: outerParsed.detail || undefined,
            thoughtKind: 'step_summary' as const,
          });
        }
        const contentEl = stepGroupCollapsible.querySelector(':scope > .ui-collapsible-content');
        const column = contentEl?.firstElementChild;
        if (column) {
          let seq = 0;
          for (const child of Array.from(column.children)) {
            if (child.classList.contains('ui-thinking-collapsible')) {
              const h = child.querySelector(':scope > .ui-collapsible-header');
              const p = parseThoughtSpansFromHeader(h);
              if (p.action || p.detail || p.duration) {
                elements.push({
                  type: 'thought' as const,
                  id: `thought-${flatIndex}-s${seq}`,
                  flatIndex,
                  duration: p.duration,
                  action: p.action || undefined,
                  detail: p.detail || undefined,
                  thoughtKind: 'thinking_step' as const,
                });
              }
              seq++;
              continue;
            }
            const toolHost =
              child.getAttribute('data-message-role') === 'ai' && child.getAttribute('data-message-kind') === 'tool'
                ? child
                : child.querySelector(':scope > [data-message-role="ai"][data-message-kind="tool"]');
            if (toolHost) {
              const mid =
                toolHost.getAttribute('data-message-id') || `fi-${flatIndex}-g${seq}`;
              const parsedTool = extractAiTool(toolHost as Element, flatIndex, mid, null);
              if (parsedTool) {
                elements.push(parsedTool.element);
                seq++;
              }
            }
          }
        }
        continue;
      }

      // --- Step-group header (Thought, Explored, Searched, Read, etc.) — one wrapper without message-role ---
      const thoughtEl = wrapper.querySelector('.ui-collapsible.ui-step-group-collapsible');
      if (thoughtEl && !role) {
        const hdr = thoughtEl.querySelector('.ui-collapsible-header');
        const parsed = parseThoughtSpansFromHeader(hdr);
        elements.push({
          type: 'thought' as const,
          id: `thought-${flatIndex}`,
          flatIndex,
          duration: parsed.duration,
          action: parsed.action || undefined,
          detail: parsed.detail || undefined,
        });
        rawEl.parsedAs = 'thought';
        continue;
      }

      // --- Human message ---
      if (role === 'human' && kind === 'human') {
        // Plan block check
        const planContent = wrapper.querySelector('.plan-execution-message-content');
        if (planContent) {
          const label = (planContent.querySelector('.plan-execution-label')?.textContent || '').trim();
          const title = (planContent.querySelector('.plan-execution-title')?.textContent || '').trim();
          const todoSummary = wrapper.querySelector('.todo-summary-content');
          let todosCompleted = 0;
          let todosTotal = 0;
          if (todoSummary) {
            const summaryText = todoSummary.textContent || '';
            const ofMatch = summaryText.match(/(\d+)\s+of\s+(\d+)/);
            const slashMatch = summaryText.match(/(\d+)\s*\/\s*(\d+)/);
            const countMatch = ofMatch || slashMatch;
            if (countMatch) {
              todosCompleted = parseInt(countMatch[1], 10);
              todosTotal = parseInt(countMatch[2], 10);
            }
          }

          const todos: { text: string; status: 'pending' | 'completed' | 'in_progress' }[] = [];
          const summaryItems = wrapper.querySelectorAll('.todo-summary-item');
          for (const item of Array.from(summaryItems)) {
            const contentEl = item.querySelector('.todo-summary-item-content');
            const text = (contentEl?.textContent || '').trim();
            if (!text) continue;
            const contentCls = contentEl?.className || '';
            let status: 'pending' | 'completed' | 'in_progress' = 'pending';
            if (contentCls.includes('todo-completed')) { status = 'completed'; }
            else if (contentCls.includes('todo-in-progress') || item.querySelector('.todo-summary-in-progress-circle')) { status = 'in_progress'; }
            todos.push({ text, status });
          }

          // Collapsed: items not rendered yet. Click to expand; appear on next poll.
          if (todos.length === 0 && todosTotal > 0) {
            const clickable = wrapper.querySelector('.todo-summary-content-clickable') as HTMLElement | null;
            if (clickable) clickable.click();
          }

          if (todos.length > 0 && todosTotal === 0) {
            todosTotal = todos.length;
            todosCompleted = todos.filter(function(t) { return t.status === 'completed'; }).length;
          }

          elements.push({
            type: 'plan' as const,
            id: messageId,
            flatIndex,
            label,
            title,
            todosCompleted,
            todosTotal,
            todos: todos.length > 0 ? todos : undefined,
          });
          rawEl.parsedAs = 'plan';
          continue;
        }

        // Regular human message
        const inputEl = wrapper.querySelector('.aislash-editor-input-readonly');
        let text = (inputEl?.textContent || wrapper.textContent || '').trim();
        let quoted: { text: string } | undefined;
        const quoteEl = inputEl?.querySelector('blockquote');
        if (inputEl && quoteEl) {
          const qt = (quoteEl.textContent || '').trim();
          if (qt) {
            quoted = { text: qt };
            const clone = inputEl.cloneNode(true) as HTMLElement;
            clone.querySelectorAll('blockquote').forEach((el) => el.remove());
            const rest = (clone.textContent || '').trim();
            if (rest) text = rest;
          }
        }
        const mentionEls = wrapper.querySelectorAll('.mention');
        const mentions = Array.from(mentionEls).map(m => ({
          name: m.getAttribute('data-mention-name') || (m.textContent || '').trim(),
          mentionType: m.getAttribute('data-typeahead-type') || 'unknown',
        }));
        const imageEls = wrapper.querySelectorAll(
          'img.image-pill-img, [class*="image-pill"] img, [class*="message"] img[src]',
        );
        const imageCount = imageEls.length;

        elements.push({
          type: 'human' as const,
          id: messageId,
          flatIndex,
          text,
          mentions,
          ...(quoted ? { quoted } : {}),
          ...(imageCount > 0 ? { imageCount } : {}),
        });
        rawEl.parsedAs = 'human';
        continue;
      }

      // --- AI assistant message ---
      if (role === 'ai' && kind === 'assistant') {
        const markdownRoot = wrapper.querySelector('.markdown-root');
        const text = (markdownRoot?.textContent || wrapper.textContent || '').trim();
        const html = markdownRoot?.innerHTML || '';

        const codeBlockEls = wrapper.querySelectorAll('.composer-message-codeblock, .composer-code-block-container');
        const codeBlocks = Array.from(codeBlockEls)
          .map(cb => extractCodeBlockItem(cb))
          .filter((b) => !!(b.code || '').trim());

        elements.push({
          type: 'assistant' as const,
          id: messageId,
          flatIndex,
          text,
          html,
          codeBlocks,
        });
        rawEl.parsedAs = 'assistant';
        continue;
      }

      // --- Tool call ---
      if (role === 'ai' && kind === 'tool') {
        const parsedTool = extractAiTool(msgEl as Element, flatIndex, messageId, rawEl);
        if (parsedTool) {
          elements.push(parsedTool.element);
          rawEl.parsedAs = parsedTool.parsedAs;
        }
        continue;
      }

      // --- Thinking (Cursor 3.8+: kind=thinking on message wrapper) ---
      if (role === 'ai' && kind === 'thinking') {
        const thoughtEl = wrapper.querySelector('.ui-thinking-collapsible') || wrapper.querySelector('.ui-collapsible');
        const hdr = thoughtEl?.querySelector('.ui-collapsible-header');
        const parsed = parseThoughtSpansFromHeader(hdr ?? null);
        elements.push({
          type: 'thought' as const,
          id: messageId,
          flatIndex,
          duration: parsed.duration,
          action: parsed.action || undefined,
          detail: parsed.detail || undefined,
          thoughtKind: 'thinking_step' as const,
        });
        rawEl.parsedAs = 'thought:thinking';
        continue;
      }

      // --- Fallback: step-group inside message-group wrapper ---
      if (!role && wrapper.querySelector('.composer-message-group')) {
        const collapseEl = wrapper.querySelector('.ui-collapsible-header');
        if (collapseEl) {
          const spans = collapseEl.querySelectorAll(':scope > span');
          let action = '';
          let detail = '';
          let duration = '';
          const durationFromTextFb = (raw: string): string => {
            const t = raw.trim();
            const forM = t.match(/\bfor\s+([\d.]+\s*s(?:ec(?:onds?)?)?)\b/i);
            if (forM) return forM[1].replace(/\s+/g, '');
            const bareM = t.match(/^([\d.]+\s*s(?:ec(?:onds?)?)?)$/i);
            if (bareM) return bareM[1].replace(/\s+/g, '');
            return '';
          };
          const isDurationOnlySpanFb = (raw: string): boolean => {
            const t = raw.trim();
            if (/^for\s+/i.test(t)) return false;
            return !!durationFromTextFb(t) && t.length <= 20;
          };
          for (const s of Array.from(spans)) {
            if (s.classList.contains('cursor-icon') || s.classList.contains('ui-icon')) continue;
            const t = (s.textContent || '').trim();
            if (!t) continue;
            const d = durationFromTextFb(t);
            if (d && !duration) duration = d;
            if (isDurationOnlySpanFb(t)) continue;
            if (!action) { action = t; continue; }
            if (t.startsWith('for ')) { duration = duration || t.replace(/^for\s+/i, '').trim(); detail = t; }
            else { detail = detail || t; }
          }
          if (!duration) {
            const fullHeader = (collapseEl.textContent || '').replace(/\s+/g, ' ').trim();
            duration = durationFromTextFb(fullHeader);
          }
          elements.push({
            type: 'thought' as const,
            id: `thought-${flatIndex}`,
            flatIndex,
            duration,
            action: action || undefined,
            detail: detail || undefined,
          });
          rawEl.parsedAs = 'thought:fallback';
        }
      }
    }

    // --- Orphan activity indicators (outside message wrapper) ---
    const _orphanIndicators: Array<{ cls: string; text: string; parentCls: string }> = [];
    const allIndicators = container.querySelectorAll('.loading-indicator-v3, .make-shine');
    for (const ind of Array.from(allIndicators)) {
      if (ind.closest(MSG_WRAPPER_SEL)) continue;
      _orphanIndicators.push({
        cls: ind.className.substring(0, 200),
        text: (ind.textContent || '').trim().substring(0, 120),
        parentCls: (ind.parentElement?.className || '').substring(0, 200),
      });
    }

    // --- Approval extraction. Two paths:
    //
    // Primary (per-card): each pending shell tool-call card carries its own
    // Run / Skip / Allowlist and command text. One approval record per card
    // with command as description — more useful than button label only.
    //
    // Fallback (legacy/non-shell): old Cursor builds and non-shell surfaces.
    // Collapses all matches into one record.
    //
    // Both paths must:
    //   - stay within `container` (else multi-agent workbench leaks buttons
    //     between composers and approvals never clear), and
    //   - skip aria-haspopup (Cursor "Auto-Run in Sandbox" trigger with
    //     "Auto-Run …" matches generic "Run" textMatch — but opens settings menu,
    //     not approval action).
    const pendingApprovals: CursorState['pendingApprovals'] = [];

    const seenCards = new Set<Element>();
    function isShellApprovalRowActive(row: Element): boolean {
      const card = row.closest('.ui-tool-call-card') || row.closest('.ui-shell-tool-call');
      if (!card) return false;
      const runBtn = row.querySelector('button.ui-shell-tool-call__run-btn') as HTMLButtonElement | null;
      if (runBtn?.disabled) return false;

      const descEl = card.querySelector('.ui-shell-tool-call__description');
      const descText = (descEl?.textContent || '').trim().substring(0, 200);
      const cmdEl = card.querySelector('.ui-shell-tool-call__command');
      const cmdText = (cmdEl?.textContent || '')
        .trim()
        .replace(/^\$\s*/, '')
        .replace(/\s+/g, ' ')
        .substring(0, 200);

      const bubble = card.closest('[data-tool-call-id]');
      const toolCallId = bubble?.getAttribute('data-tool-call-id') || '';
      for (const m of elements) {
        if (!('toolCallId' in m)) continue;
        const actionText = m.type === 'tool'
          ? `${m.action || ''} ${m.details || ''} ${'summaryText' in m ? (m.summaryText || '') : ''}`
          : m.type === 'run_command'
            ? `${m.description || ''} ${m.command || ''}`
            : '';
        const idMatch = !!toolCallId && m.toolCallId === toolCallId;
        const descMatch = !!descText && (
          actionText.includes(descText.slice(0, 40))
          || descText.includes(actionText.trim().slice(0, 40))
        );
        const cmdMatch = !!cmdText && actionText.replace(/\s+/g, ' ').includes(cmdText.slice(0, 40));
        if (m.type === 'tool' && (m.status === 'loading' || m.status === 'completed') && (idMatch || descMatch || cmdMatch)) {
          return false;
        }
      }

      const toolStatus = bubble?.getAttribute('data-tool-status')
        || card.getAttribute('data-tool-status')
        || card.closest('[data-tool-status]')?.getAttribute('data-tool-status');
      if (toolStatus === 'completed') return false;
      return true;
    }

    function pushShellApprovalFromRow(row: Element): void {
      const card = row.closest('.ui-tool-call-card') || row.closest('.ui-shell-tool-call');
      if (!card || seenCards.has(card)) return;

      const shellActions = extractToolActions(row);
      if (!shellActions.some((a) => a.type === 'run' || a.type === 'allow')) return;

      const actions: CursorState['pendingApprovals'][0]['actions'] = shellActions.map((a) => ({
        label: a.label,
        type:
          a.type === 'run' ? 'approve' as const
          : a.type === 'skip' ? 'reject' as const
          : a.type === 'allow' ? 'approve_all' as const
          : 'toggle' as const,
        selectorPath: a.selectorPath,
        ...(a.checked !== undefined ? { checked: a.checked } : {}),
      }));

      seenCards.add(card);

      const cmdEl = card.querySelector('.ui-shell-tool-call__command');
      let cmdText = (cmdEl?.textContent || '')
        .trim()
        .replace(/^\$\s*/, '')
        .replace(/\s+/g, ' ')
        .substring(0, 240);
      if (!cmdText) {
        const raw = shellTextWithoutApprovalRow(card).replace(/\s+/g, ' ');
        const dollar = raw.indexOf('$');
        if (dollar >= 0) cmdText = normalizeShellCommandText(raw.slice(dollar)).substring(0, 240);
      }
      const descEl = card.querySelector('.ui-shell-tool-call__description');
      const descText = (descEl?.textContent || '').trim().substring(0, 200);

      const bubble = card.closest('[data-tool-call-id]');
      const toolCallId = bubble?.getAttribute('data-tool-call-id') || buildSelectorPath(card);
      pendingApprovals.push({
        id: `tool:${toolCallId}`,
        description: descText || cmdText || 'Pending approval',
        ...(cmdText ? { command: cmdText } : {}),
        actions,
      });
    }

    const approvalRows = Array.from(container.querySelectorAll('.ui-shell-tool-call__approval-row'))
      .filter(isShellApprovalRowActive);
    const activeRow = approvalRows.length > 0 ? approvalRows[approvalRows.length - 1] : null;
    if (activeRow) pushShellApprovalFromRow(activeRow);

    if (pendingApprovals.length === 0) {
      // Legacy fallback — tool-call containers only. Never scan whole composer
      // for "Run"/"Cancel"; terminal history keeps those buttons and spammed
      // approvals in Telegram.
      const isKnownApproveLabel = (raw: string): boolean => {
        const t = cleanBtnLabel(raw).toLowerCase();
        if (!t || t.length > 64) return false;
        if (t === 'run in background' || t === 'cancel') return false;
        if (t.startsWith('{') && t.includes('"ok"')) return false;
        if (t === 'run' || t === 'accept' || t === 'approve' || t === 'allow') return true;
        if (t === 'accept all' || t === 'continue') return true;
        if (t.startsWith('allowlist')) return true;
        return false;
      };
      const isKnownRejectLabel = (raw: string): boolean => {
        const t = cleanBtnLabel(raw).toLowerCase();
        return t === 'skip' || t === 'reject' || t === 'deny' || t === 'cancel';
      };
      const toolRootSelectors = [
        '.ui-tool-call-card',
        '.ui-shell-tool-call',
        '.composer-terminal-tool-call-block-container',
        '.composer-tool-call-container',
        '[data-tool-call-id]',
      ];
      const toolRoots: Element[] = [];
      const seenRoots = new Set<Element>();
      for (const rootSel of toolRootSelectors) {
        try {
          for (const el of Array.from(container.querySelectorAll(rootSel))) {
            if (seenRoots.has(el)) continue;
            seenRoots.add(el);
            toolRoots.push(el);
          }
        } catch { /* skip */ }
      }

      const approveButtons: { label: string; selector: string; root: Element }[] = [];
      const rejectButtons: { label: string; selector: string }[] = [];
      const seenApproveBtns = new Set<Element>();
      const seenRejectBtns = new Set<Element>();

      for (const root of toolRoots) {
        for (const sel of approveSelectors) {
          try {
            const btns = root.querySelectorAll(sel);
            for (const btn of Array.from(btns)) {
              if (seenApproveBtns.has(btn) || isMenuTrigger(btn)) continue;
              const label = cleanBtnLabel(btn.textContent || btn.getAttribute('aria-label') || '');
              if (label && isKnownApproveLabel(label)) {
                seenApproveBtns.add(btn);
                approveButtons.push({ label, selector: selectorForApprovalButton(btn), root });
              }
            }
          } catch { /* skip */ }
        }
        if (approveTextMatch.length > 0) {
          for (const btn of Array.from(root.querySelectorAll('button'))) {
            if (seenApproveBtns.has(btn) || isMenuTrigger(btn)) continue;
            const label = cleanBtnLabel(btn.textContent || btn.getAttribute('aria-label') || '');
            if (label && isKnownApproveLabel(label)) {
              seenApproveBtns.add(btn);
              approveButtons.push({ label, selector: buildSelectorPath(btn), root });
            }
          }
        }

        for (const sel of rejectSelectors) {
          try {
            const btns = root.querySelectorAll(sel);
            for (const btn of Array.from(btns)) {
              if (seenRejectBtns.has(btn) || isMenuTrigger(btn)) continue;
              const label = cleanBtnLabel(btn.textContent || btn.getAttribute('aria-label') || '');
              if (label && isKnownRejectLabel(label)) {
                seenRejectBtns.add(btn);
                rejectButtons.push({ label, selector: selectorForApprovalButton(btn) });
              }
            }
          } catch { /* skip */ }
        }
        if (rejectTextMatch.length > 0) {
          for (const btn of Array.from(root.querySelectorAll('button'))) {
            if (seenRejectBtns.has(btn) || isMenuTrigger(btn)) continue;
            const label = cleanBtnLabel(btn.textContent || btn.getAttribute('aria-label') || '');
            if (label && isKnownRejectLabel(label)) {
              seenRejectBtns.add(btn);
              rejectButtons.push({ label, selector: selectorForApprovalButton(btn) });
            }
          }
        }
      }

      if (approveButtons.length > 0) {
        const actions: CursorState['pendingApprovals'][0]['actions'] = [];
        for (const btn of approveButtons) {
          actions.push({
            label: btn.label,
            type: btn.label.toLowerCase().includes('all') ? 'approve_all' : 'approve',
            selectorPath: btn.selector,
          });
        }
        for (const btn of rejectButtons) {
          actions.push({ label: btn.label, type: 'reject', selectorPath: btn.selector });
        }

        const primaryRoot = approveButtons[0].root;
        const cmdEl =
          primaryRoot.querySelector('.ui-shell-tool-call__command') ||
          primaryRoot.querySelector('.composer-terminal-command-expanded-text') ||
          primaryRoot.querySelector('.composer-terminal-command-editor');
        let cmdText = (cmdEl?.textContent || '')
          .trim()
          .replace(/^\$\s*/, '')
          .replace(/\s+/g, ' ')
          .substring(0, 240);
        if (!cmdText) {
          const raw = (primaryRoot.textContent || '').replace(/\s+/g, ' ');
          const dollar = raw.indexOf('$');
          if (dollar >= 0) cmdText = normalizeShellCommandText(raw.slice(dollar)).substring(0, 240);
        }
        const descEl = primaryRoot.querySelector('.ui-shell-tool-call__description') ||
          primaryRoot.querySelector('.composer-terminal-top-header-description');
        const descText = (descEl?.textContent || '').trim().substring(0, 200);
        const description = descText || cmdText || approveButtons[0].label || 'Pending approval';

        const bubble = primaryRoot.closest('[data-tool-call-id]') || primaryRoot;
        const toolCallId = bubble.getAttribute('data-tool-call-id') || buildSelectorPath(primaryRoot);
        pendingApprovals.push({
          id: `tool:${toolCallId}`,
          description,
          ...(cmdText ? { command: cmdText } : {}),
          actions,
        });
      }
    }

    // --- Agent status ---
    const hasLoadingToolEarly = container.querySelector('[data-tool-status="loading"]') !== null;

    const statusEl = findFirst(statusSelectors);
    let agentStatus: CursorState['agentStatus'] = 'idle';
    if (hasLoadingToolEarly) {
      agentStatus = 'running_tool';
      pendingApprovals.length = 0;
    } else if (pendingApprovals.length > 0) {
      agentStatus = 'waiting_approval';
    } else if (statusEl) {
      const combined = `${(statusEl.textContent || '').toLowerCase()} ${statusEl.classList.toString().toLowerCase()}`;
      if (combined.includes('think')) agentStatus = 'thinking';
      else if (combined.includes('generat')) agentStatus = 'generating';
      else if (combined.includes('running') || combined.includes('execut')) agentStatus = 'running_tool';
      else if (combined.includes('approv') || combined.includes('wait')) agentStatus = 'waiting_approval';
      else if (combined.includes('error') || combined.includes('fail')) agentStatus = 'error';
    }

    // Element-based status detection removed: loading tool badges and
    // run_command elements stay in DOM long after completion.
    // Shimmer + .loading-indicator-v3 (below) — ground truth.

    const inputEl = findFirst(inputSelectors);

    // --- Chat tabs from agent sidebar/history cells ---
    let chatTabs: ChatTab[] = [];

    function cleanTabTitle(raw: string): string {
      let t = raw.trim().replace(/\s+/g, ' ');
      t = t.replace(/(@[\w./]+)+\s*$/, '');
      return t.trim().substring(0, 120);
    }

    try {
      const seenTitles = new Set<string>();
      let scopeRoot: Element | null = null;
      if (containerComposerId) {
        const allCells = document.querySelectorAll('.agent-sidebar-cell');
        for (const cell of Array.from(allCells)) {
          const cid = cell.getAttribute('data-composer-id') || cell.closest('[data-composer-id]')?.getAttribute('data-composer-id');
          if (cid === containerComposerId) {
            scopeRoot = cell.closest('.agent-sidebar-project-cell') || document.body;
            break;
          }
        }
      }
      const scopedWindowTitle = (windowTitle || '').trim();
      const projectName = scopedWindowTitle
        ? projectNameFromTitle(scopedWindowTitle).toLowerCase()
        : '';

      function labelMatchesProject(label: string): boolean {
        if (!projectName) return true;
        const normalized = label.trim().toLowerCase();
        if (!normalized) return false;
        const firstWord = (normalized.split(/[\s\[\]\-]/)[0] || '').toLowerCase();
        return normalized.includes(projectName)
          || projectName.includes(firstWord)
          || firstWord === projectName;
      }

      if (!scopeRoot && scopedWindowTitle) {
        if (projectName) {
          const projectCells = document.querySelectorAll('.agent-sidebar-project-cell');
          for (const cell of Array.from(projectCells)) {
            const labelEl = cell.querySelector('.agent-sidebar-section-title-text') || cell.querySelector('.agent-sidebar-workspace-name') || cell;
            const label = (labelEl.textContent || '').trim();
            if (labelMatchesProject(label)) {
              scopeRoot = cell;
              break;
            }
          }
        }
      }

      const requireWindowScope = Boolean(scopedWindowTitle && projectName);

      function tabBelongsToScopedWindow(tab: Element): boolean {
        if (!requireWindowScope) return true;
        if (scopeRoot?.contains(tab)) return true;
        const group = tab.closest('.ui-sidebar-group');
        const groupTitle = (group?.querySelector('.ui-sidebar-group-label-title')?.textContent || '').trim();
        if (groupTitle && labelMatchesProject(groupTitle)) return true;
        const projectCell = tab.closest('.agent-sidebar-project-cell');
        if (projectCell) {
          const labelEl = projectCell.querySelector('.agent-sidebar-section-title-text')
            || projectCell.querySelector('.agent-sidebar-workspace-name')
            || projectCell;
          const label = (labelEl.textContent || '').trim();
          return labelMatchesProject(label);
        }
        return false;
      }

      // Cursor Agents unified window: glass sidebar rows (replace .agent-sidebar-cell in new builds)
      const glassTabRoots = document.querySelectorAll(
        '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn'
      );
      if (glassTabRoots.length > 0 && (!requireWindowScope || scopeRoot || projectName)) {
        for (const tab of Array.from(glassTabRoots)) {
          if (!tabBelongsToScopedWindow(tab)) continue;
          if (tab.getAttribute('data-has-hover-actions') === 'false') continue;
          const labelEl = tab.querySelector('.ui-sidebar-menu-button-label');
          const rawAgentTitle = (labelEl?.textContent || '').trim();
          if (!rawAgentTitle) continue;

          const group = tab.closest('.ui-sidebar-group');
          const groupTitleEl = group?.querySelector('.ui-sidebar-group-label-title');
          const rawGroupTitle = (groupTitleEl?.textContent || '').trim();

          let displayTitle = cleanTabTitle(rawAgentTitle);
          if (rawGroupTitle) {
            const g = cleanTabTitle(rawGroupTitle);
            if (g) {
              displayTitle = `${g} / ${cleanTabTitle(rawAgentTitle)}`.substring(0, 120);
            }
          }

          const composerId =
            tab.getAttribute('data-composer-id')
            || tab.closest('[data-composer-id]')?.getAttribute('data-composer-id')
            || `glass:${displayTitle}`;

          // Dedupe by composerId: two "New Chat" tabs are two different chats.
          // Title dedupe dropped second tab from state → routing confused.
          const dedupKey = composerId.startsWith('glass:') ? `t:${displayTitle}` : `c:${composerId}`;
          if (seenTitles.has(dedupKey)) continue;
          seenTitles.add(dedupKey);

          const isActive = tab.getAttribute('data-active') === 'true';

          chatTabs.push({
            composerId,
            title: displayTitle,
            isActive,
            status: isActive ? 'active' : 'idle',
            selectorPath: buildSelectorPath(tab),
          });
        }

        if (containerComposerId) {
          let matched = false;
          for (const t of chatTabs) {
            if (t.composerId === containerComposerId) {
              matched = true;
              t.isActive = true;
              t.status = 'active';
            }
          }
          if (matched) {
            for (const t of chatTabs) {
              if (t.composerId !== containerComposerId) {
                t.isActive = false;
                t.status = 'idle';
              }
            }
          }
        }
      }

      for (const sel of chatTabSelectors) {
        if (chatTabs.length > 0) break;
        // Block only with multiple project-cells (unified UI); legacy sidebar without scopeRoot is ok.
        const projectCellCount = document.querySelectorAll('.agent-sidebar-project-cell').length;
        if (requireWindowScope && !scopeRoot && projectCellCount > 1) break;
        let tabItems: NodeListOf<Element>;
        try {
          const root: Element | Document = scopeRoot || document;
          tabItems = root.querySelectorAll(sel);
        } catch {
          continue;
        }
        if (tabItems.length === 0) continue;
        for (const tab of Array.from(tabItems)) {
          if (scopeRoot && !scopeRoot.contains(tab)) continue;
          if (tab.getAttribute('data-has-hover-actions') === 'false') continue;
          const titleEl = tab.querySelector('.agent-sidebar-cell-text');
          const rawTitle = titleEl
            ? (titleEl.textContent || '').trim()
            : (tab.getAttribute('aria-label') || tab.textContent || '').trim();
          const title = cleanTabTitle(rawTitle);
          if (!title) continue;

          const composerId = tab.getAttribute('data-composer-id')
            || tab.closest('[data-composer-id]')?.getAttribute('data-composer-id')
            || `tab-${chatTabs.length}`;

          // Dedupe by composerId (stable) or title (synthetic fallback).
          const stableId = composerId.length >= 8 && !/^tab-\d+$/i.test(composerId);
          const dedupKey = stableId ? `c:${composerId}` : `t:${title}`;
          if (seenTitles.has(dedupKey)) continue;
          seenTitles.add(dedupKey);
          const selectedAttr = tab.getAttribute('data-selected');
          const highlightedAttr = tab.getAttribute('data-highlighted');
          const isActive = selectedAttr === 'true'
            || highlightedAttr === 'true'
            || tab.classList.contains('selected')
            || tab.classList.contains('active');

          chatTabs.push({
            composerId,
            title,
            isActive,
            status: isActive ? 'active' : 'idle',
            selectorPath: buildSelectorPath(tab),
          });
        }
        if (chatTabs.length > 0) {
          if (containerComposerId) {
            let matched = false;
            for (const t of chatTabs) {
              const match = t.composerId === containerComposerId;
              if (match) {
                matched = true;
                t.isActive = true;
                t.status = 'active';
              }
            }
            if (matched) {
              // composerId matched — non-matching tabs inactive
              for (const t of chatTabs) {
                if (t.composerId !== containerComposerId) {
                  t.isActive = false;
                  t.status = 'idle';
                }
              }
            }
            // If composerId failed — keep isActive from DOM
            // (data-selected, data-highlighted, .selected, .active)
          }
          break;
        }
      }

      // Legacy sidebar: data-composer-id often on chat container only, not cell.
      if (containerComposerId && chatTabs.length > 0) {
        function stableCid(id: string): boolean {
          const s = (id || '').trim();
          if (!s || s.length < 8 || /^tab-\d+$/i.test(s)) return false;
          return true;
        }
        const active = chatTabs.find((t) => t.isActive);
        if (active && !stableCid(active.composerId)) {
          active.composerId = containerComposerId;
        }
      }
    } catch { /* skip */ }

    // Tabs for web: open editor composer tabs only (switch_tab works on them).
    try {
      const placeholderTitles = new Set([
        'new agent', 'new chat', 'automations', 'customize', 'default', 'untitled', 'agent', 'search',
      ]);
      const editorChatTabs: ChatTab[] = [];
      for (const tab of Array.from(document.querySelectorAll('[role="tab"][data-resource-name]'))) {
        const res = (tab.getAttribute('data-resource-name') || '').trim();
        if (!/^[0-9a-f-]{36}$/i.test(res)) continue;
        const label = tab.querySelector('.monaco-highlighted-label, .label-name');
        const aria = (tab.getAttribute('aria-label') || '').split(',')[0].trim();
        const title = cleanTabTitle((label?.textContent || aria || '').trim());
        if (!title || placeholderTitles.has(title.toLowerCase())) continue;
        const isActive = tab.getAttribute('aria-selected') === 'true'
          || tab.classList.contains('active')
          || tab.classList.contains('selected');
        editorChatTabs.push({
          composerId: res,
          title,
          isActive,
          status: isActive ? 'active' : 'idle',
          selectorPath: buildSelectorPath(tab),
        });
      }
      if (editorChatTabs.length > 0) {
        chatTabs = editorChatTabs;
      } else {
        chatTabs = chatTabs.filter(
          (t) => !placeholderTitles.has(cleanTabTitle(t.title).toLowerCase()),
        );
      }
    } catch { /* skip */ }

    // --- Mode extraction ---
    const modeEl = findFirst(modeSelectors);
    let currentMode = 'agent';
    if (modeEl) {
      currentMode = modeEl.getAttribute('data-mode') || 'agent';
    }
    const mode: ModeInfo = {
      current: currentMode,
      available: [],
    };

    // --- Model extraction ---
    // Skip plan-scoped dropdowns (id with "plan-exec-model") —
    // specific plan model, not composer-level model.
    let modelEl: Element | null = null;
    for (const sel of modelSelectors) {
      try {
        const candidates = document.querySelectorAll(sel);
        for (const c of Array.from(candidates)) {
          const cId = c.getAttribute('id') || '';
          if (!cId.startsWith('plan-exec-model')) {
            modelEl = c;
            break;
          }
        }
        if (modelEl) break;
      } catch { /* skip */ }
    }
    let modelName = '';
    let modelId = '';
    if (modelEl) {
      const spans = modelEl.querySelectorAll('span');
      for (const s of Array.from(spans)) {
        const t = (s.textContent || '').trim();
        if (t && !t.includes('chevron') && t.length > 1) {
          modelName = t;
          break;
        }
      }
      modelId = modelEl.getAttribute('id') || '';
    }
    const model: ModelInfo = {
      current: modelName || 'Auto',
      currentId: modelId,
    };

    // --- Raw activity signals (objective DOM snapshot for recording) ---
    const _shimmer: Array<{ text: string; inToolCall: boolean; inHeader: boolean }> = [];
    const hasLoadingIndicator = container.querySelector('.loading-indicator-v3') !== null;
    const hasLoadingTool = container.querySelector('[data-tool-status="loading"]') !== null;
    const shineEls = container.querySelectorAll('.make-shine');
    for (const sh of Array.from(shineEls).reverse()) {
      const inToolCall = !!sh.closest('[data-tool-call-id]') || !!sh.closest('.composer-terminal-tool');
      const header = sh.closest('.ui-collapsible-header');
      let text = '';
      if (header) {
        const spans = header.querySelectorAll(':scope > span');
        const parts: string[] = [];
        for (const s of Array.from(spans)) {
          if (s.classList.contains('cursor-icon') || s.classList.contains('ui-icon')) continue;
          const t = (s.textContent || '').trim();
          if (t) parts.push(t);
        }
        text = parts.join(' ');
      } else if (sh.classList.contains('composer-terminal-top-header-description') ||
                 sh.closest('.composer-terminal-top-header-text')) {
        text = (sh.textContent || '').trim();
      } else {
        const descEl = (sh.closest(MSG_WRAPPER_SEL) || sh.parentElement)
          ?.querySelector('.composer-terminal-top-header-description, .ui-tool-call-line-action, .ui-edit-tool-call__filename');
        text = descEl ? (descEl.textContent || '').trim() : (sh.textContent || '').trim();
      }
      if (text.length > 2) {
        const entry = { text: text.substring(0, 80), inToolCall, inHeader: !!header };
        _shimmer.push(entry);
      }
    }

    const _rawSignals = {
      shimmer: _shimmer,
      loadingIndicator: hasLoadingIndicator,
      statusEl: statusEl ? { text: (statusEl.textContent || '').trim(), classes: statusEl.className } : undefined,
      elements: _rawElements,
      orphanIndicators: _orphanIndicators,
    };

    const queueItems: { id: string; text: string }[] = [];
    let queueLabel: string | undefined;
    const toolbarSection = document.querySelector('#composer-toolbar-section');
    if (toolbarSection) {
      for (const lc of Array.from(toolbarSection.querySelectorAll('.opacity-80'))) {
        const lt = (lc.textContent || '').trim();
        if (lt && /queued/i.test(lt)) {
          queueLabel = lt;
          break;
        }
      }
      if (!queueLabel) {
        const fb = toolbarSection.querySelector('.group .opacity-80');
        const t0 = (fb?.textContent || '').trim();
        if (t0) queueLabel = t0;
      }
      for (const item of Array.from(toolbarSection.querySelectorAll('.composer-toolbar-queue-item'))) {
        const qid = item.getAttribute('data-queue-item-id') || '';
        let qtext = (item.getAttribute('data-queue-item-query') || '').trim();
        if (!qtext) {
          const ro = item.querySelector('.aislash-editor-input-readonly');
          qtext = (ro?.textContent || '').trim();
        }
        if (qid || qtext) queueItems.push({ id: qid || `qi-${queueItems.length}`, text: qtext });
      }
    }

    // --- Questionnaire widget ---
    type QOption = {
      letter: string;
      label: string;
      isFreeform: boolean;
      selectorPath: string;
      freeformInputSelectorPath?: string;
      selected: boolean;
    };
    type QQuestion = { number: string; text: string; options: QOption[]; isActive: boolean };
    let questionnaire: {
      questions: QQuestion[];
      activeIndex: number;
      totalLabel: string;
      skipSelectorPath: string;
      continueSelectorPath: string;
      continueDisabled: boolean;
      freeformActive: boolean;
      freeformInputSelectorPath: string;
      freeformValue: string;
    } | null = null;
    const qToolbar = document.querySelector('.composer-questionnaire-toolbar');
    if (qToolbar) {
      const stepperLabel = (qToolbar.querySelector('.composer-questionnaire-toolbar-stepper-label')?.textContent || '').trim();
      const questionEls = Array.from(qToolbar.querySelectorAll('.composer-questionnaire-toolbar-question'));
      const questions: QQuestion[] = [];
      let activeIdx = 0;
      for (let qi = 0; qi < questionEls.length; qi++) {
        const qEl = questionEls[qi];
        const isActive = qEl.classList.contains('composer-questionnaire-toolbar-question-active');
        if (isActive) activeIdx = qi;
        const num = (qEl.querySelector('.composer-questionnaire-toolbar-question-number')?.textContent || '').trim();
        const mdRoot = qEl.querySelector('.markdown-root');
        const text = (mdRoot?.textContent || '').trim();
        const optionEls = Array.from(qEl.querySelectorAll('.composer-questionnaire-toolbar-option'));
        const options: QOption[] = [];
        for (const optEl of optionEls) {
          const letterBtn = optEl.querySelector('.composer-questionnaire-toolbar-option-letter');
          const letter = (letterBtn?.textContent || '').trim();
          const isFreeform = optEl.classList.contains('composer-questionnaire-toolbar-option-freeform');
          const selected = letterBtn?.classList.contains('composer-questionnaire-toolbar-option-letter-selected') ?? false;
          const label = (optEl.querySelector('.composer-questionnaire-toolbar-option-label')?.textContent || '').trim()
            || (isFreeform ? 'Other' : '');
          let freeformInputSelectorPath: string | undefined;
          if (isFreeform) {
            const textarea = optEl.querySelector('.composer-questionnaire-toolbar-freeform-input');
            if (textarea) freeformInputSelectorPath = buildSelectorPath(textarea as Element);
          }
          options.push({
            letter,
            label,
            isFreeform,
            selectorPath: buildSelectorPath(optEl as Element),
            ...(freeformInputSelectorPath ? { freeformInputSelectorPath } : {}),
            selected,
          });
        }
        questions.push({ number: num, text, options, isActive });
      }

      let skipPath = '';
      let continuePath = '';
      let continueDisabled = false;
      let freeformActive = false;
      let freeformInputSelectorPath = '';
      let freeformValue = '';
      const actionsContainer = qToolbar.querySelector('.composer-questionnaire-toolbar-actions');
      if (actionsContainer) {
        const skipBtn = actionsContainer.querySelector('.composer-skip-button');
        if (skipBtn) skipPath = buildSelectorPath(skipBtn as Element);
        const contBtn = actionsContainer.querySelector('.composer-run-button');
        if (contBtn) {
          continuePath = buildSelectorPath(contBtn as Element);
          continueDisabled = contBtn.getAttribute('data-disabled') === 'true';
        }
      }

      const activeQEl = questionEls.find((el) => el.classList.contains('composer-questionnaire-toolbar-question-active'));
      if (activeQEl) {
        const freeformOpt = activeQEl.querySelector('.composer-questionnaire-toolbar-option-freeform');
        const ffLetter = freeformOpt?.querySelector('.composer-questionnaire-toolbar-option-letter');
        if (freeformOpt && ffLetter?.classList.contains('composer-questionnaire-toolbar-option-letter-selected')) {
          freeformActive = true;
          const textarea = freeformOpt.querySelector('.composer-questionnaire-toolbar-freeform-input') as HTMLTextAreaElement | null;
          if (textarea) {
            freeformInputSelectorPath = buildSelectorPath(textarea);
            freeformValue = textarea.value ?? '';
          }
        }
      }

      questionnaire = {
        questions,
        activeIndex: activeIdx,
        totalLabel: stepperLabel,
        skipSelectorPath: skipPath,
        continueSelectorPath: continuePath,
        continueDisabled,
        freeformActive,
        freeformInputSelectorPath,
        freeformValue,
      };
    }

    return {
      connected: true,
      extractorStatus: 'ok',
      lastExtractionAt: null,
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
      agentStatus,
      agentActivityText: null,
      agentActivityLive: false,
      agentActivitySource: 'none',
      messages: elements,
      pendingApprovals,
      inputAvailable: inputEl !== null,
      chatTabs,
      activeComposerId: containerComposerId || (chatTabs.find((t) => t.isActive)?.composerId ?? ''),
      mode,
      model,
      windows: [],
      activeWindowId: '',
      composerQueue: { items: queueItems, ...(queueLabel ? { queueLabel } : {}) },
      questionnaire,
      _rawSignals,
    };
  } catch {
    return null;
  }
}

export class DOMExtractor {
  private selectors: SelectorConfig;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private client: CdpClient | null = null;
  private onExtract: (state: CursorState | null, errorMessage?: string | null) => void;
  private getWindowTitle: () => string;
  private loggedFirstExtraction = false;
  private basePollIntervalMs = 300;
  private currentPollIntervalMs = 300;
  private pollInFlight = false;
  private failureStreak = 0;
  private running = false;

  constructor(
    selectors: SelectorConfig,
    onExtract: (state: CursorState | null, errorMessage?: string | null) => void,
    getWindowTitle: () => string = () => ''
  ) {
    this.selectors = selectors;
    this.onExtract = onExtract;
    this.getWindowTitle = getWindowTitle;
  }

  start(client: CdpClient, intervalMs: number): void {
    this.client = client;
    this.stop();
    this.running = true;
    this.basePollIntervalMs = intervalMs;
    this.currentPollIntervalMs = intervalMs;
    this.failureStreak = 0;
    logInfo('EXTRACT_START', `polling every ${intervalMs}ms`, extractCtx('extract_poll', { durationMs: intervalMs }));
    this.scheduleNextPoll(0);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.currentPollIntervalMs = this.basePollIntervalMs;
    this.failureStreak = 0;
  }

  setClient(client: CdpClient | null): void {
    this.client = client;
  }

  private scheduleNextPoll(delayMs = this.currentPollIntervalMs): void {
    if (!this.running) return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delayMs);
  }

  private handleFailure(message: string): void {
    const timedOut = message.includes('timeout');
    this.failureStreak++;
    if (timedOut) {
      const nextInterval = Math.min(
        Math.max(this.basePollIntervalMs, this.basePollIntervalMs * (2 ** (this.failureStreak - 1))),
        MAX_POLL_BACKOFF_MS
      );
      if (nextInterval !== this.currentPollIntervalMs) {
        this.currentPollIntervalMs = nextInterval;
        logWarn(
          'EXTRACT_FAIL',
          `Backing off poll interval to ${this.currentPollIntervalMs}ms after ${message}`,
          extractCtx('extract_backoff', { durationMs: this.currentPollIntervalMs, hint: String(this.failureStreak) }),
        );
      }
    }
    this.onExtract(null, message);
  }

  /** One off-schedule DOM extraction (before redeploy / shutdown). */
  async extractNow(): Promise<void> {
    if (!this.running || !this.client?.isConnected()) return;
    const deadline = Date.now() + 15_000;
    while (this.pollInFlight && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.pollInFlight) return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    await this.poll();
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) {
      this.scheduleNextPoll();
      return;
    }
    this.pollInFlight = true;

    if (!this.client || !this.client.isConnected()) {
      this.handleFailure('CDP client not connected');
      this.pollInFlight = false;
      this.scheduleNextPoll();
      return;
    }

    try {
      const state = await this.client.callFunctionWithTimeout(
        extractionFunction as (...args: never[]) => unknown,
        [
          this.selectors.chatContainer.strategies,
          this.selectors.approveButton.strategies,
          this.selectors.approveButton.textMatch ?? [],
          this.selectors.rejectButton.strategies,
          this.selectors.rejectButton.textMatch ?? [],
          this.selectors.chatInput.strategies,
          this.selectors.agentStatus.strategies,
          this.selectors.chatTabList?.strategies ?? [],
          this.selectors.modeDropdown?.strategies ?? [],
          this.selectors.modelDropdown?.strategies ?? [],
          this.getWindowTitle(),
        ],
        EVALUATE_TIMEOUT_MS
      ) as CursorState | null;

      const derivedState = state
        ? applyApprovalFilter(applyDerivedActivityToState(state))
        : null;
      this.failureStreak = 0;
      this.currentPollIntervalMs = this.basePollIntervalMs;

      if (derivedState && !this.loggedFirstExtraction) {
        this.loggedFirstExtraction = true;
        logInfo(
          'EXTRACT_FIRST_OK',
          `status=${derivedState.agentStatus} msgs=${derivedState.messages.length} approvals=${derivedState.pendingApprovals.length} tabs=${derivedState.chatTabs.length}`,
          extractCtx('extract', { hint: derivedState.agentStatus }),
        );
      }

      this.onExtract(derivedState, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.handleFailure(message);
    } finally {
      this.pollInFlight = false;
      this.scheduleNextPoll();
    }
  }
}
