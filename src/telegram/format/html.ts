import { parse as parseHtml, HTMLElement as ParsedEl, TextNode } from 'node-html-parser';
import type {
  ChatElement,
  CodeBlockItem,
  HumanMessage,
  AssistantMessage,
  ToolCallElement,
  ThoughtBlock,
  PlanBlock,
  PlanTodo,
  TodoListBlock,
  RunCommand,
  LoadingIndicator,
  Approval,
  ComposerQueueState,
  Questionnaire,
} from '../../core/types.js';
import { readPlanFile } from '../../web/plans.js';
import { tgKeyboard, type TgKeyboard } from '../types.js';
import { t } from '../../i18n/t.js';

const TG_MSG_LIMIT = 4096;
/** Rich Messages limit (Bot API 10.1). */
export const TG_RICH_MSG_LIMIT = 32768;

export interface FormattedMessage {
  html: string;
  /** Variant for sendRichMessage (Bot API 10.1): tables, headers, details.
   *  Absent — send plain HTML. */
  richHtml?: string;
  keyboard?: TgKeyboard;
}

const SHELL_APPROVAL_SELECTORS: Record<string, string> = {
  approve: 'button.ui-shell-tool-call__run-btn',
  reject: 'button.ui-shell-tool-call__skip-btn',
  approve_all: 'button.ui-shell-tool-call__allowlist-button',
  run: 'button.ui-shell-tool-call__run-btn',
  skip: 'button.ui-shell-tool-call__skip-btn',
  allow: 'button.ui-shell-tool-call__allowlist-button',
  toggle: '.ui-shell-tool-call__approval-row input[type="checkbox"], .ui-shell-tool-call__approval-row [role="checkbox"], .ui-shell-tool-call__approval-row [role="switch"]',
};

/** Snapshot CSS paths go stale; shell approvals use stable class selectors. */
export function stableApprovalSelector(type: string, selectorPath: string): string {
  const stable = SHELL_APPROVAL_SELECTORS[type];
  if (!stable) return selectorPath;
  if (!selectorPath || selectorPath.includes('#bubble') || selectorPath.includes('nth-of-type')) {
    return stable;
  }
  if (
    selectorPath.startsWith('button.ui-shell-tool-call__')
    || selectorPath.includes('checkbox')
    || selectorPath.includes('switch')
  ) {
    return selectorPath;
  }
  return stable;
}

export function formatElement(
  element: ChatElement,
  hashCallback: (selectorPath: string) => string
): FormattedMessage {
  switch (element.type) {
    case 'human': return formatHuman(element);
    case 'assistant': return formatAssistant(element);
    case 'tool': return formatTool(element, hashCallback);
    case 'thought': return formatThought(element);
    case 'plan': return formatPlan(element, hashCallback);
    case 'todo_list': return formatTodoList(element);
    case 'run_command': return formatRunCommand(element, hashCallback);
    case 'loading': return formatLoading(element);
  }
}

function shimmerSpoiler(active: boolean): string {
  return active ? ' <tg-spoiler>*spoiler*</tg-spoiler>' : '';
}

export function formatActivity(text: string): string {
  return `<i>● ${escapeHtml(text)}…</i>${shimmerSpoiler(true)}`;
}

/** Forum message body for composer toolbar queue; empty string if no queue. */
export function formatComposerQueue(queue: ComposerQueueState | undefined): string {
  if (!queue?.items?.length) return '';
  const hdr = queue.queueLabel?.trim() || t('tg.fmt.queueDefault', 'Queued');
  const lines: string[] = [`<b>${escapeHtml(hdr)}</b>`, ''];
  for (const it of queue.items) {
    const itemText = it.text.trim() || t('tg.fmt.empty', '(empty)');
    lines.push(`▸ ${escapeHtml(itemText.length > 220 ? `${itemText.slice(0, 219)}…` : itemText)}`);
  }
  return lines.join('\n');
}

function formatHuman(msg: HumanMessage): FormattedMessage {
  const parts: string[] = [];
  if (msg.quoted?.text) {
    parts.push(
      `<blockquote expandable="false">${escapeHtml(msg.quoted.text)}</blockquote>`
    );
  }
  parts.push(`<b>${t('tg.fmt.humanYou', 'You:')}</b> ${escapeHtml(msg.text)}`);
  let html = parts.join('\n');
  if (msg.mentions.length > 0) {
    const mentionStr = msg.mentions.map(m => `@${escapeHtml(m.name)}`).join(' ');
    html += `\n<i>${mentionStr}</i>`;
  }
  return { html };
}

function formatAssistant(msg: AssistantMessage): FormattedMessage {
  if (!msg.html) return { html: '' };
  return {
    html: cursorHtmlToTelegram(msg.html, msg.codeBlocks),
    richHtml: cursorHtmlToTelegram(msg.html, msg.codeBlocks, { rich: true }),
  };
}

function toolDiffStatsSuffix(msg: Pick<ToolCallElement, 'additions' | 'deletions'>): string {
  const stats: string[] = [];
  if (msg.additions !== undefined) stats.push(`<b>+${msg.additions}</b>`);
  if (msg.deletions !== undefined) stats.push(`<b>-${msg.deletions}</b>`);
  return stats.length > 0 ? `  ${stats.join(' ')}` : '';
}

function formatTool(
  msg: ToolCallElement,
  hashCallback: (selectorPath: string) => string
): FormattedMessage {
  const icon = msg.status === 'completed' ? '✓' : '●';

  if (msg.filename) {
    const statsStr = toolDiffStatsSuffix(msg);
    const action = msg.action ? `<b>${escapeHtml(msg.action)}</b> ` : '';
    const detailSuffix = msg.details && msg.details !== msg.filename
      ? msg.details.replace(msg.filename, '').trim() : '';
    const rangeInfo = detailSuffix ? ` ${escapeHtml(detailSuffix)}` : '';
    let html = `${icon} ${action}<code>${escapeHtml(msg.filename)}</code>${rangeInfo}${statsStr}`;

    if (msg.blocked) {
      html += `\n⚠️ ${escapeHtml(msg.blocked)}`;
    }

    const kb = tgKeyboard();
    const diffHash = hashCallback(msg.toolCallId);
    kb.text(t('tg.fmt.viewDiff', '📄 View diff'), `dif:${msg.toolCallId.substring(0, 8)}:${diffHash}`);

    if (msg.actions && msg.actions.length > 0) {
      for (const act of msg.actions) {
        const hash = hashCallback(act.selectorPath);
        const prefix = act.type === 'run' ? 'run' : act.type === 'skip' ? 'skp' : 'alw';
        const label = act.type === 'run' ? t('tg.fmt.accept', '✅ Accept')
          : act.type === 'skip' ? t('tg.fmt.skip', '⏭ Skip')
          : `🔓 ${act.label}`;
        kb.text(label, `${prefix}:${msg.id.substring(0, 8)}:${hash}`);
      }
    }

    return { html, keyboard: kb.build() };
  }

  if (msg.summaryText) {
    const text = msg.summaryText.trim();
    const firstLine = text.split('\n')[0].substring(0, 80);
    const hasCode = text.includes('{') || text.includes('(') || text.length > 100;

    if (hasCode) {
      const html = `${icon} <b>${escapeHtml(msg.action || t('tg.fmt.toolDefault', 'Tool'))}</b>\n<pre>${escapeHtml(text.substring(0, 500))}</pre>`;
      const hash = hashCallback(msg.toolCallId);
      const keyboard = tgKeyboard().text(t('tg.fmt.fullText', '📄 Full text'), `dif:${msg.toolCallId.substring(0, 8)}:${hash}`).build();
      return { html, keyboard };
    }
    return { html: `${icon} <b>${escapeHtml(msg.action || '')}</b> ${escapeHtml(firstLine)}${toolDiffStatsSuffix(msg)}` };
  }

  let line = `${icon} <b>${escapeHtml(msg.action || t('tg.fmt.toolDefault', 'Tool'))}</b>`;
  if (msg.details) line += ` <code>${escapeHtml(msg.details)}</code>`;
  line += toolDiffStatsSuffix(msg);
  return { html: line };
}

/** true while thought header looks in-flight (incomplete step summary). */
export function thoughtAppearsInProgress(msg: ThoughtBlock): boolean {
  if (msg.duration) return false;
  if (msg.thoughtKind === 'step_summary' && (msg.detail || '').trim().length > 0) return false;
  const d = msg.detail?.trim() ?? '';
  if (d && !/^for\s/i.test(d)) return false;
  return true;
}

function activityLabelMatchesThoughtAction(activity: string, thoughtAction: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/…+/gu, '')
      .replace(/\.+$/u, '')
      .replace(/\s+/g, ' ');
  const a = norm(activity);
  const b = norm(thoughtAction);
  if (!a || !b) return false;
  if (a === b) return true;
  if (b.startsWith(a) || a.startsWith(b)) return true;
  if (a.length <= 24 && b.includes(a)) return true;
  if (b.length <= 24 && a.includes(b)) return true;
  return false;
}

/**
 * When agentActivityText duplicates in-flight 📎 step-summary line, skip
 * ephemeral ● activity message — else Telegram gets two near-duplicate lines (and two spoilers).
 */
export function activityRedundantWithInProgressStepSummary(
  activityText: string | undefined,
  elements: ChatElement[]
): boolean {
  if (!activityText?.trim()) return false;
  const recent = elements.slice(-24);
  for (let i = recent.length - 1; i >= 0; i--) {
    const el = recent[i];
    if (el.type !== 'thought') continue;
    if (el.thoughtKind !== 'step_summary' || !el.action) continue;
    if (!thoughtAppearsInProgress(el)) continue;
    if (activityLabelMatchesThoughtAction(activityText, el.action)) return true;
  }
  return false;
}

function formatThought(msg: ThoughtBlock): FormattedMessage {
  const spoiler = shimmerSpoiler(thoughtAppearsInProgress(msg));
  if (msg.thoughtKind === 'step_summary' && msg.action) {
    const detail = msg.detail ? ` — <code>${escapeHtml(msg.detail)}</code>` : '';
    return { html: `<b>📎 ${escapeHtml(msg.action)}</b>${detail}${spoiler}` };
  }
  if (msg.thoughtKind === 'thinking_step' && msg.action) {
    const timing = msg.duration ? ` · ${escapeHtml(msg.duration)}` : '';
    const detail = msg.detail && !msg.duration ? ` ${escapeHtml(msg.detail)}` : '';
    return { html: `<i>◆ ${escapeHtml(msg.action)}${detail}${timing}</i>${spoiler}` };
  }
  if (msg.action) {
    const detail = msg.detail ? ` ${escapeHtml(msg.detail)}` : '';
    return { html: `<i>💭 ${escapeHtml(msg.action)}${detail}</i>${spoiler}` };
  }
  return { html: `<i>💭 ${t('tg.fmt.thoughtDuration', 'Thought for {duration}', { duration: escapeHtml(msg.duration) })}</i>` };
}

function formatLoading(msg: LoadingIndicator): FormattedMessage {
  const text = msg.text ? `● ${escapeHtml(msg.text)}…` : t('tg.fmt.loadingDefault', '💭 Thinking…');
  return { html: `<i>${text}</i>` };
}

function formatPlan(
  msg: PlanBlock,
  hashCallback: (selectorPath: string) => string
): FormattedMessage {
  const lines: string[] = [];
  lines.push(`<b>📋 ${escapeHtml(msg.title)}</b>`);
  if (msg.label) lines.push(`<i>${escapeHtml(msg.label)}</i>`);
  if (msg.description) lines.push('');
  if (msg.description) lines.push(escapeHtml(msg.description));

  if (msg.todos && msg.todos.length > 0) {
    lines.push('');
    lines.push(`<b>${t('tg.fmt.tasksProgress', 'Tasks ({completed}/{total}):', { completed: msg.todosCompleted, total: msg.todosTotal })}</b>`);
    for (const todo of msg.todos) {
      const icon = todo.status === 'completed' ? '✅'
        : todo.status === 'in_progress' ? '🔵'
        : '⚪';
      lines.push(`${icon} ${escapeHtml(todo.text)}`);
    }
  } else if (msg.todosTotal > 0) {
    lines.push(`\n${t('tg.fmt.progress', 'Progress: {completed}/{total}', { completed: msg.todosCompleted, total: msg.todosTotal })}`);
  }

  if (msg.model) lines.push(`\n${t('tg.fmt.modelLabel', 'Model: {model}', { model: escapeHtml(msg.model) })}`);

  let keyboard: TgKeyboard | undefined;
  if (msg.actions && msg.actions.length > 0) {
    const kb = tgKeyboard();
    for (const action of msg.actions) {
      const hash = hashCallback(action.selectorPath);
      const label = action.type === 'build' ? t('tg.fmt.build', '▶ Build') : t('tg.fmt.plan', '📄 Plan');
      const data = `${action.type === 'build' ? 'bld' : 'vpl'}:${msg.id.substring(0, 8)}:${hash}`;
      kb.text(label, data);
    }
    keyboard = kb.build();
  }

  return { html: lines.join('\n'), keyboard };
}

function formatTodoList(msg: TodoListBlock): FormattedMessage {
  const lines: string[] = [];
  lines.push(`<b>📝 ${escapeHtml(msg.title)} (${msg.todosCompleted}/${msg.todosTotal}):</b>`);
  for (const todo of msg.todos) {
    const icon = todo.status === 'completed' ? '✅'
      : todo.status === 'in_progress' ? '🔵'
      : '⚪';
    lines.push(`${icon} ${escapeHtml(todo.text)}`);
  }
  return { html: lines.join('\n') };
}

function formatRunCommand(
  msg: RunCommand,
  hashCallback: (selectorPath: string) => string
): FormattedMessage {
  const lines: string[] = [];
  let header = `<b>🖥 ${escapeHtml(msg.description)}</b>`;
  if (msg.candidates) header += `  <code>${escapeHtml(msg.candidates)}</code>`;
  lines.push(header);
  if (msg.command?.trim()) {
    lines.push(`<pre><code class="language-bash">$ ${escapeHtml(msg.command.trim())}</code></pre>`);
  }

  let keyboard: TgKeyboard | undefined;
  if (msg.actions.length > 0) {
    const kb = tgKeyboard();
    for (const action of msg.actions) {
      const sel = stableApprovalSelector(action.type, action.selectorPath);
      const hash = hashCallback(sel);
      if (action.type === 'toggle') {
        const mark = action.checked ? '☑' : '☐';
        kb.text(`${mark} ${action.label}`, `tog:${msg.id.substring(0, 8)}:${hash}`);
        kb.row();
        continue;
      }
      const prefix = action.type === 'run' ? 'run' : action.type === 'skip' ? 'skp' : 'alw';
      const label = action.type === 'run' ? t('tg.fmt.run', '▶ Run')
        : action.type === 'skip' ? t('tg.fmt.skip', '⏭ Skip')
        : `🔓 ${action.label}`;
      kb.text(label, `${prefix}:${msg.id.substring(0, 8)}:${hash}`);
    }
    keyboard = kb.build();
  }

  return { html: lines.join('\n'), keyboard };
}

function markdownToTelegramHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines: string[] = [];

  for (const line of lines) {
    if (inCodeBlock) {
      if (line.startsWith('```')) {
        const langAttr = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : '';
        out.push(`<pre><code${langAttr}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCodeBlock = false;
        codeLines = [];
        codeLang = '';
      } else {
        codeLines.push(line);
      }
      continue;
    }

    if (line.startsWith('```')) {
      inCodeBlock = true;
      codeLang = line.slice(3).trim();
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      out.push('');
      out.push(`<b>${inlineMarkdown(headingMatch[2])}</b>`);
      continue;
    }

    if (line.match(/^\s*[-*]\s/)) {
      const content = line.replace(/^\s*[-*]\s+/, '');
      out.push(`• ${inlineMarkdown(content)}`);
      continue;
    }

    const olMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (olMatch) {
      out.push(`${olMatch[1]}. ${inlineMarkdown(olMatch[2])}`);
      continue;
    }

    if (line.startsWith('|') && line.endsWith('|')) {
      if (line.match(/^\|[\s:-]+\|$/)) continue;
      const cells = line.split('|').slice(1, -1).map(c => inlineMarkdown(c.trim()));
      out.push(cells.join(' | '));
      continue;
    }

    if (line.trim() === '') {
      out.push('');
      continue;
    }

    out.push(inlineMarkdown(line));
  }

  if (inCodeBlock && codeLines.length > 0) {
    out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function inlineMarkdown(text: string): string {
  let result = escapeHtml(text);
  // bold+italic ***text*** or ___text___
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>');
  // bold **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');
  // italic *text* or _text_ (underscore not inside words)
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>');
  // inline code `text`
  result = result.replace(/`([^`]+?)`/g, '<code>$1</code>');
  // links [text](url) — for [path](path) plan refs strip link syntax
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    if (href.startsWith('http')) return `<a href="${href}">${label}</a>`;
    return `<code>${label}</code>`;
  });
  return result;
}

export function formatPlanFull(msg: PlanBlock): string {
  const planFile = msg.label ? readPlanFile(msg.label) : null;

  if (planFile) {
    const parts: string[] = [];

    if (planFile.todos.length > 0) {
      const completed = planFile.todos.filter(t => t.status === 'completed').length;
      parts.push(`<b>${t('tg.fmt.tasksProgress', 'Tasks ({completed}/{total}):', { completed, total: planFile.todos.length })}</b>`);
      for (const todo of planFile.todos) {
        const icon = todo.status === 'completed' ? '✅' : todo.status === 'in_progress' ? '🔵' : '⚪';
        parts.push(`${icon} ${escapeHtml(todo.text)}`);
      }
      parts.push('');
    }

    parts.push(markdownToTelegramHtml(planFile.body));
    return parts.join('\n');
  }

  // Fallback: data from DOM extraction
  const lines: string[] = [];
  lines.push(`<b>📋 ${escapeHtml(msg.title)}</b>`);
  if (msg.label) lines.push(`<i>${escapeHtml(msg.label)}</i>`);
  if (msg.description) lines.push('', escapeHtml(msg.description));

  if (msg.todos && msg.todos.length > 0) {
    lines.push('', `<b>${t('tg.fmt.tasksProgress', 'Tasks ({completed}/{total}):', { completed: msg.todosCompleted, total: msg.todosTotal })}</b>`);
    for (const todo of msg.todos) {
      const icon = todo.status === 'completed' ? '✅' : todo.status === 'in_progress' ? '🔵' : '⚪';
      lines.push(`${icon} ${escapeHtml(todo.text)}`);
    }
    if (msg.todos.length < msg.todosTotal) {
      lines.push(`<i>${t('tg.fmt.moreTodos', '… {count} more (expand in Cursor)', { count: msg.todosTotal - msg.todos.length })}</i>`);
    }
  }
  return lines.join('\n');
}

export function formatApprovals(
  approvals: Approval[],
  hashCallback: (selectorPath: string) => string
): FormattedMessage {
  if (approvals.length === 0) return { html: '' };

  const approval = approvals[0];
  const lines: string[] = [
    `${t('tg.fmt.approvalNeeded', '⚠️ Approval needed:')} ${escapeHtml(approval.description)}`,
  ];
  if (approval.command?.trim()) {
    lines.push(`<pre><code class="language-bash">$ ${escapeHtml(approval.command.trim())}</code></pre>`);
  }

  const kb = tgKeyboard();
  for (const action of approval.actions) {
    const sel = stableApprovalSelector(action.type, action.selectorPath);
    const hash = hashCallback(sel);
    if (action.type === 'toggle') {
      const mark = action.checked ? '☑' : '☐';
      kb.text(`${mark} ${action.label}`, `tog:${approval.id.substring(0, 8)}:${hash}`);
      kb.row();
      continue;
    }
    const prefix = action.type === 'approve' ? 'apr'
      : action.type === 'reject' ? 'rej'
      : 'all';
    const label = action.type === 'approve' ? `✅ ${action.label}`
      : action.type === 'reject' ? `❌ ${action.label}`
      : `✅ ${action.label}`;
    kb.text(label, `${prefix}:${approval.id.substring(0, 8)}:${hash}`);
  }

  return { html: lines.join('\n'), keyboard: kb.build() };
}

export function formatQuestionnaire(questionnaire: Questionnaire): FormattedMessage {
  if (!questionnaire.questions.length) return { html: '' };

  const activeIdx = questionnaire.activeIndex;
  const activeQ = questionnaire.questions[activeIdx] || questionnaire.questions[0];

  const lines: string[] = [];
  lines.push(`<b>${t('tg.fmt.questions', '❓ Questions')}</b> (${escapeHtml(questionnaire.totalLabel)})`);

  // Active question — full with options; others — one line with status.
  for (let i = 0; i < questionnaire.questions.length; i++) {
    const q = questionnaire.questions[i];
    if (i === activeIdx) {
      lines.push('');
      lines.push(`👉 <b>${escapeHtml(q.number)}</b> ${escapeHtml(q.text)}`);
      for (const opt of q.options) {
        lines.push(`  <b>${escapeHtml(opt.letter)})</b> ${escapeHtml(opt.label)}`);
      }
      lines.push('');
    } else {
      const icon = i < activeIdx ? '✅' : '⏳';
      const text = q.text.length > 90 ? `${q.text.slice(0, 89)}…` : q.text;
      lines.push(`${icon} <b>${escapeHtml(q.number)}</b> <i>${escapeHtml(text)}</i>`);
    }
  }

  // Buttons by option letter; click resolved on live DOM at press time,
  // snapshot CSS path stale after re-render.
  const kb = tgKeyboard();
  let hasFreeform = false;
  for (const opt of activeQ.options) {
    if (opt.isFreeform) hasFreeform = true;
    const cb = opt.isFreeform ? `qff:${opt.letter}` : `qan:${opt.letter}`;
    kb.text(`${opt.letter}) ${opt.label}`, cb);
    kb.row();
  }
  if (hasFreeform) {
    lines.push('');
    lines.push(`<i>${t('tg.fmt.questionnaireFreeformHint', 'For “Other”: tap the button, then <b>reply to the bot message</b> with your answer.')}</i>`);
  }
  if (questionnaire.skipSelectorPath) {
    kb.text(t('tg.fmt.skip', '⏭ Skip'), 'qsk:_');
  }
  if (questionnaire.continueSelectorPath && !questionnaire.continueDisabled) {
    kb.text(t('tg.fmt.continue', '▶ Continue'), 'qco:_');
  }

  return { html: lines.join('\n'), keyboard: kb.build() };
}

export function splitMessage(html: string, limit: number = TG_MSG_LIMIT): string[] {
  if (html.length <= limit) return [html];

  const parts: string[] = [];
  let remaining = html;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n\n', limit);
    if (splitAt < limit * 0.3) splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt < limit * 0.3) splitAt = limit;
    parts.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  if (remaining) parts.push(remaining);

  return parts;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function codeBlockItemTelegramBody(cb: CodeBlockItem): string {
  if (cb.blockKind === 'diff' && cb.diffLines && cb.diffLines.length > 0) {
    return cb.diffLines
      .map(l => {
        const prefix =
          l.kind === 'add' ? '+ ' : l.kind === 'rem' ? '- ' : l.kind === 'meta' || l.kind === 'hunk' ? '  ' : '  ';
        return prefix + l.text;
      })
      .join('\n');
  }
  return cb.code || '';
}

function cursorHtmlToTelegram(
  html: string,
  codeBlocks?: CodeBlockItem[],
  opts?: { rich?: boolean },
): string {
  const root = parseHtml(html);
  const rich = opts?.rich === true;
  let cbIdx = 0;

  function hasClass(el: ParsedEl, cls: string): boolean {
    return (el.getAttribute('class') || '').split(/\s+/).includes(cls);
  }

  function directChildrenByTag(el: ParsedEl, tagName: string): ParsedEl[] {
    const lower = tagName.toLowerCase();
    return el.childNodes.filter(
      (n): n is ParsedEl => n instanceof ParsedEl && (n.rawTagName || '').toLowerCase() === lower
    );
  }

  function walkChildren(parent: ParsedEl): string {
    let result = '';
    for (const node of parent.childNodes) {
      if (node instanceof TextNode) {
        const text = node.textContent;
        if (!text.trim()) {
          if (result && !result.endsWith(' ') && !result.endsWith('\n')) result += ' ';
          continue;
        }
        result += escapeHtml(text);
      } else if (node instanceof ParsedEl) {
        result += walkElement(node);
      }
    }
    return result;
  }

  function walkElement(el: ParsedEl): string {
    const tag = (el.rawTagName || '').toLowerCase();

    // Skip non-content elements
    if (tag === 'button' || tag === 'svg' || tag === 'style' || tag === 'script') return '';
    if (tag === 'div' && hasClass(el, 'ui-scroll-area__scrollbar')) return '';
    if (tag === 'div' && hasClass(el, 'ui-code-block-copy-overlay')) return '';

    // Cursor composer / Shiki code block (markdown may embed them)
    if (
      tag === 'div' &&
      (hasClass(el, 'composer-message-codeblock') || hasClass(el, 'composer-code-block-container'))
    ) {
      if (codeBlocks && cbIdx < codeBlocks.length) {
        const cb = codeBlocks[cbIdx++];
        const lang = cb.language ? ` class="language-${escapeHtml(cb.language)}"` : '';
        return `\n<pre><code${lang}>${escapeHtml(codeBlockItemTelegramBody(cb))}</code></pre>\n`;
      }
      return '\n' + extractShikiCode(el) + '\n';
    }

    // Headings: rich — real h1–h6, else bold
    if (/^h[1-6]$/.test(tag)) {
      if (rich) return `\n<${tag}>${walkChildren(el)}</${tag}>\n`;
      return `\n\n<b>${walkChildren(el)}</b>\n\n`;
    }

    // Collapsible sections — rich keeps native
    if (tag === 'details') {
      if (rich) return `\n<details>${walkChildren(el)}</details>\n`;
      return walkChildren(el);
    }
    if (tag === 'summary') {
      if (rich) return `<summary>${walkChildren(el)}</summary>`;
      return `<b>${walkChildren(el)}</b>\n`;
    }

    // Paragraph
    if (tag === 'p') return `\n${walkChildren(el)}\n`;

    // Bold / strong
    if (tag === 'b' || tag === 'strong') return `<b>${walkChildren(el)}</b>`;

    // Italic / em (skip Cursor icons)
    if (tag === 'i' || tag === 'em') {
      if (hasClass(el, 'cursor-icon')) return '';
      return `<i>${walkChildren(el)}</i>`;
    }

    // Preserved inline formatting
    if (tag === 'u') return `<u>${walkChildren(el)}</u>`;
    if (tag === 's') return `<s>${walkChildren(el)}</s>`;

    // Span — bold by class (Cursor uses span.font-semibold instead of <strong>)
    if (tag === 'span') {
      if (hasClass(el, 'font-semibold') || el.getAttribute('data-streamdown') === 'strong') {
        return `<b>${walkChildren(el)}</b>`;
      }
      return walkChildren(el);
    }

    // Inline code (no double wrap inside <pre>)
    if (tag === 'code') {
      const parent = el.parentNode;
      if (parent instanceof ParsedEl && (parent.rawTagName || '').toLowerCase() === 'pre') {
        return escapeHtml(el.textContent);
      }
      return `<code>${escapeHtml(el.textContent)}</code>`;
    }

    // Preformatted block
    if (tag === 'pre') {
      const codeEl = el.querySelector('code');
      if (codeEl) {
        const cls = codeEl.getAttribute('class') || '';
        const m = cls.match(/language-(\w+)/);
        const langAttr = m ? ` class="language-${m[1]}"` : '';
        return `\n<pre><code${langAttr}>${escapeHtml(codeEl.textContent)}</code></pre>\n`;
      }
      return `\n<pre>${escapeHtml(el.textContent)}</pre>\n`;
    }

    // Link
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href) return `<a href="${escapeHtml(href)}">${walkChildren(el)}</a>`;
      return walkChildren(el);
    }

    // Blockquote
    if (tag === 'blockquote') return `\n<blockquote>${walkChildren(el)}</blockquote>\n`;

    // Bullet list
    if (tag === 'ul') {
      const items = directChildrenByTag(el, 'li');
      if (items.length > 0) {
        return '\n' + items.map(li => `• ${walkListItem(li)}`).join('\n') + '\n';
      }
      return walkChildren(el);
    }

    // Numbered list
    if (tag === 'ol') {
      const items = directChildrenByTag(el, 'li');
      if (items.length > 0) {
        return '\n' + items.map((li, i) => `${i + 1}. ${walkListItem(li)}`).join('\n') + '\n';
      }
      return walkChildren(el);
    }

    // Table: rich — native (Bot API 10.1), else rows via " | "
    if (tag === 'table') {
      return '\n' + (rich ? convertTableRich(el) : convertTable(el)) + '\n';
    }

    // Line breaks
    if (tag === 'br') return '\n';
    if (tag === 'hr') return '\n---\n';

    // Default: recurse children
    return walkChildren(el);
  }

  function walkListItem(li: ParsedEl): string {
    let result = '';
    for (const child of li.childNodes) {
      if (child instanceof TextNode) {
        const text = child.textContent;
        if (!text.trim()) continue;
        result += escapeHtml(text);
      } else if (child instanceof ParsedEl) {
        if ((child.rawTagName || '').toLowerCase() === 'p') {
          result += walkChildren(child);
        } else {
          result += walkElement(child);
        }
      }
    }
    return result.trim();
  }

  function extractShikiCode(container: ParsedEl): string {
    const lineEls = container.querySelectorAll('.ui-default-code__line-content');
    if (lineEls.length > 0) {
      const code = lineEls.map(l => l.textContent).join('\n');
      return `<pre><code>${escapeHtml(code)}</code></pre>`;
    }
    const raw = container.textContent.trim();
    return raw ? `<pre><code>${escapeHtml(raw)}</code></pre>` : '';
  }

  function tableRowCells(tr: ParsedEl): ParsedEl[] {
    return tr.childNodes.filter(
      (n): n is ParsedEl =>
        n instanceof ParsedEl && ['td', 'th'].includes((n.rawTagName || '').toLowerCase()),
    );
  }

  function convertTable(table: ParsedEl): string {
    // Walk all tr: <th> can be in tbody (how Cursor renders markdown tables),
    // old code lost those headers.
    const lines: string[] = [];
    for (const tr of table.querySelectorAll('tr')) {
      const cells = tableRowCells(tr);
      if (cells.length === 0) continue;
      lines.push(
        cells
          .map((c) => {
            const inner = walkChildren(c).trim();
            return (c.rawTagName || '').toLowerCase() === 'th' ? `<b>${inner}</b>` : inner;
          })
          .join(' | '),
      );
    }
    return lines.join('\n');
  }

  function convertTableRich(table: ParsedEl): string {
    const rows: string[] = [];
    for (const tr of table.querySelectorAll('tr')) {
      const cells = tableRowCells(tr);
      if (cells.length === 0) continue;
      const rendered = cells
        .map((c) => {
          const t = (c.rawTagName || '').toLowerCase();
          return `<${t}>${walkChildren(c).trim()}</${t}>`;
        })
        .join('');
      rows.push(`<tr>${rendered}</tr>`);
    }
    if (rows.length === 0) return '';
    return `<table>${rows.join('')}</table>`;
  }

  let result = walkChildren(root);
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}
