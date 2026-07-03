import type { CdpClient } from '../cdp-client.js';
import type { SelectorConfig, CommandResult, PlanModelOption, ModeOption, ModelOptionsSnapshot, ModelRowOptionsSnapshot } from '../../core/types.js';
import { logWarn, logError, logCommandOk } from '../../core/log-event.js';
import type { LogContext } from '../../core/log-event.js';
import { setClipboardImage } from '../../media/clipboard-win.js';
import { MESSAGE_WRAPPER_SELECTOR } from '../message-index.js';
import {
  CONFIRM_SEARCH_CANCEL,
  CONFIRM_SEARCH_CONTINUE,
  CONFIRM_SEARCH_TOGGLE,
} from '../parse/confirm-search-selectors.js';
import { parseDeleteFileSelector } from '../parse/delete-file-selectors.js';

function commandCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'cdp', op, ...extra };
}

const MSG_IDX = JSON.stringify(MESSAGE_WRAPPER_SELECTOR);

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;
const FOCUS_DELAY_MS = 100;

/** Plain `@path` in insertText opens Cursor mention UI; Enter submits menu, not chat. */
export function textMayOpenMentionTypeahead(text: string): boolean {
  return /(?:^|\s)@[\w./-]+/.test(text);
}

// Finds open model picker menu across Cursor versions.
// Old builds: `[data-testid="model-picker-menu"]`; new (~3.5.17)
// dropped testid and render picker as generic `[role="menu"]` via
// `.ui-model-picker__trigger` — cascade of lookups.
// Stable across picker renders — React 19 useId (`_r_ld_`, `_r_qm_`, …)
// changes every mount, poor round-trip as model id. Treat matching pattern
// as no-id and fallback to synthetic `label::<text>`.
const REACT_USE_ID_RE = /^_r_[a-z0-9]+_$/;

export const MODE_ITEM_HELPERS_JS = `
  const labelOfMode = (el) => {
    const clone = el.cloneNode(true);
    for (const b of Array.from(clone.querySelectorAll('button'))) b.remove();
    return (clone.textContent || '').replace(/\\s+/g, ' ').trim();
  };

  const modeIdFromEl = (el) => {
    const raw = el.id || '';
    const m = raw.match(/composer-mode-([a-z0-9_-]+)$/i);
    if (m) return m[1];
    return '';
  };

  const collectModeItems = () => {
    const raw = document.querySelectorAll('[id*="composer-mode-"]');
    const out = [];
    const seen = new Set();
    for (const item of Array.from(raw)) {
      const id = modeIdFromEl(item);
      if (!id || seen.has(id)) continue;
      const label = labelOfMode(item);
      if (!label) continue;
      seen.add(id);
      const clickable = item.querySelector('.composer-unified-context-menu-item') || item;
      const cls = clickable.className || item.className || '';
      const aria = clickable.getAttribute?.('aria-checked') || item.getAttribute?.('aria-checked') || '';
      const selected = /selected|active|checked/.test(cls) || aria === 'true';
      out.push({ id, label, selected });
    }
    return out;
  };

  const pickModeById = (modeId) => {
    if (!modeId) return false;
    const items = document.querySelectorAll('[id*="composer-mode-"][id$="-' + modeId + '"]');
    for (const item of Array.from(items)) {
      const clickable = item.querySelector('.composer-unified-context-menu-item') || item;
      clickable.click();
      return true;
    }
    return false;
  };
`;

export const MODE_ITEM_COLLECTOR_JS = MODE_ITEM_HELPERS_JS;

// Shared in-browser helpers to read and click model picker rows.
// Read (`get_model_options`) and write (`set_model` / `set_plan_model`) use
// same `collectModelItems()` / `pickModelById()` — consistent round-trip:
// one definition of model row and how id maps to row.
// Inject as `${MODEL_ITEM_HELPERS_JS}` inside evaluate().
export const MODEL_ITEM_HELPERS_JS = `
  const REACT_USE_ID_RE = ${REACT_USE_ID_RE.toString()};

  // Row label without text from descendant <button> (each row has inner
  // "Edit", else button text pollutes label).
  const labelOf = (el) => {
    const clone = el.cloneNode(true);
    for (const b of Array.from(clone.querySelectorAll('button'))) b.remove();
    return (clone.textContent || '').replace(/\\s+/g, ' ').trim();
  };

  // Returns DOM id only if stable; React useId poor round-trip.
  const stableIdOf = (el) => {
    const raw = el.id || '';
    if (!raw || REACT_USE_ID_RE.test(raw)) return '';
    return raw;
  };

  // Top-level menu rows — drops items inside another candidate so row
  // Edit buttons are not separate "models".
  const modelRowsIn = (menu) => {
    if (!menu) return [];
    const raw = Array.from(menu.querySelectorAll('[id], [role="menuitem"], button, [data-testid]'));
    return raw.filter(item => !raw.some(other => other !== item && other.contains(item)));
  };

  const isAutoRowLabel = (label) => /^auto/i.test((label || '').trim());
  const isMaxModeRowLabel = (label) => /max\\s*mode/i.test((label || '').trim());

  const findAutoRow = (menu) => {
    if (!menu) return null;
    for (const row of modelRowsIn(menu)) {
      if (isAutoRowLabel(labelOf(row))) return row;
    }
    for (const row of modelRowsIn(menu)) {
      const raw = (row.textContent || '').replace(/\\s+/g, ' ').trim();
      if (isAutoRowLabel(raw)) return row;
    }
    return null;
  };

  const autoDescriptionFromRow = (row) => {
    if (!row) return '';
    const raw = (row.textContent || '').replace(/\\s+/g, ' ').trim();
    const withoutAuto = raw.replace(/^auto\\s*/i, '').trim();
    if (withoutAuto.length > 2) return withoutAuto.slice(0, 240);
    return '';
  };

  const toggleLooksOn = (root) => {
    if (!root) return false;
    const switches = root.querySelectorAll('[role="switch"], [role="checkbox"], input[type="checkbox"]');
    for (const sw of Array.from(switches)) {
      const ac = sw.getAttribute('aria-checked');
      if (ac === 'true') return true;
      if (ac === 'false') return false;
      const ds = sw.getAttribute('data-state');
      if (ds === 'checked' || ds === 'on') return true;
      if (ds === 'unchecked' || ds === 'off') return false;
      if (sw.querySelector('[data-state="checked"], [data-state="on"]')) return true;
      if (sw.querySelector('[data-state="unchecked"], [data-state="off"]')) return false;
    }
    const ariaRow = root.getAttribute('aria-checked');
    if (ariaRow === 'true') return true;
    if (ariaRow === 'false') return false;
    if (root.querySelector('[data-state="checked"], [data-state="on"]')) return true;
    const cls = root.className || '';
    return /\\b(checked|on|enabled)\\b/i.test(cls);
  };

  const autoLooksOnFromMenu = (menu) => {
    if (!menu) return true;
    const autoRow = findAutoRow(menu);
    if (!autoRow) return true;
    if (toggleLooksOn(autoRow)) return true;
    if (collectModelItems(menu).length === 0) return true;
    return false;
  };

  const clickAutoToggleInRow = (row) => {
    if (!row) return false;
    const switches = row.querySelectorAll('[role="switch"]');
    if (switches.length > 0) {
      switches[switches.length - 1].click();
      return true;
    }
    const candidates = row.querySelectorAll('[role="checkbox"], input[type="checkbox"], [aria-checked], button, [data-state]');
    for (const el of Array.from(candidates)) {
      if (el === row) continue;
      if (/^edit$/i.test((el.textContent || '').trim())) continue;
      el.click();
      return true;
    }
    row.click();
    return true;
  };

  const clickModelRow = (item) => {
    const clickable = item.querySelector('.composer-unified-context-menu-item') || item;
    clickable.click();
  };

  const collectModelItems = (menu) => {
    const items = modelRowsIn(menu);
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const label = labelOf(item);
      if (!label) continue;
      // Skip pure action buttons after nesting filter
      // (guard — e.g. floating Edit/Configure outside row).
      if (/^(edit|configure|remove|delete|star)$/i.test(label)) continue;
      if (isAutoRowLabel(label) || isMaxModeRowLabel(label)) continue;
      if (/^(add models?|search)$/i.test(label)) continue;
      const stableId = stableIdOf(item);
      const key = stableId || label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const clickable = item.querySelector('.composer-unified-context-menu-item') || item;
      const cls = clickable.className || item.className || '';
      const aria = clickable.getAttribute?.('aria-checked') || item.getAttribute?.('aria-checked') || '';
      const selected = /selected|active|checked/.test(cls) || aria === 'true';
      out.push({
        id: stableId || ('label::' + label),
        label,
        selected,
        hasEdit: !!findEditButtonInRow(item),
      });
    }
    return out;
  };

  const findEditButtonInRow = (row) => {
    if (!row) return null;
    for (const btn of Array.from(row.querySelectorAll('button'))) {
      const t = (btn.textContent || '').replace(/\\s+/g, ' ').trim();
      if (/^edit$/i.test(t)) return btn;
    }
    return null;
  };

  const findModelRowForId = (menu, targetId) => {
    if (!menu || !targetId) return null;
    const isLabelId = targetId.startsWith('label::');
    const isUnstable = REACT_USE_ID_RE.test(targetId);
    const labelTarget = (isLabelId ? targetId.slice(7) : '').trim().toLowerCase();
    const targetLc = targetId.toLowerCase();
    const fuzzy = (isLabelId || isUnstable) ? '' : targetLc.replace(/[-_]/g, ' ');

    if (!isLabelId && !isUnstable) {
      const byId = document.getElementById(targetId);
      if (byId && (byId === menu || menu.contains(byId))) return byId;
    }

    const rows = modelRowsIn(menu);
    for (const item of rows) {
      const label = labelOf(item);
      if (!label) continue;
      const labelLc = label.toLowerCase();
      const stableId = stableIdOf(item);
      if (isLabelId || isUnstable) {
        if (labelLc === labelTarget || labelLc === targetLc) return item;
      } else if (stableId === targetId || ('label::' + label) === targetId) {
        return item;
      }
    }
    for (const item of rows) {
      const label = labelOf(item);
      if (!label) continue;
      const labelLc = label.toLowerCase();
      if (isLabelId || isUnstable) {
        if (labelTarget.length >= 4 && labelLc.includes(labelTarget)) return item;
      } else if (fuzzy && labelLc.includes(fuzzy)) {
        return item;
      }
    }
    return null;
  };

  // Finds and clicks row by id (or synthetic label::id).
  // Target: real DOM id ("model-opus"), "label::<text>" (no stable id),
  // unstable React useId ("_r_ld_") or bare label. true on success.
  const pickModelById = (menu, targetId) => {
    const row = findModelRowForId(menu, targetId);
    if (!row) return false;
    clickModelRow(row);
    return true;
  };
`;

// Back-compat alias for tests with old import name.
export const MODEL_ITEM_COLLECTOR_JS = MODEL_ITEM_HELPERS_JS;

// Inject as `${MODEL_MENU_LOOKUP_JS}` in evaluate; call `findModelMenu()`.
export const MODEL_MENU_LOOKUP_JS = `
  const findModelMenu = () => {
    const byTestId = document.querySelector('[data-testid="model-picker-menu"]');
    if (byTestId) return byTestId;
    const triggers = document.querySelectorAll(
      '.ui-model-picker__trigger[aria-expanded="true"],' +
      '.composer-unified-dropdown-model[aria-expanded="true"],' +
      '.composer-unified-dropdown[aria-expanded="true"]'
    );
    for (const t of Array.from(triggers)) {
      const controls = t.getAttribute('aria-controls');
      if (controls) {
        const byControls = document.getElementById(controls);
        if (byControls) return byControls;
      }
    }
    const openMenu = document.querySelector('[role="menu"][data-state="open"]');
    if (openMenu) return openMenu;
    const visibleMenus = document.querySelectorAll('[role="menu"]:not([hidden])');
    for (const m of Array.from(visibleMenus)) {
      const rect = m.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return m;
    }
    const poppers = document.querySelectorAll('[data-radix-popper-content-wrapper]');
    for (const p of Array.from(poppers)) {
      const m = p.querySelector('[role="menu"]');
      if (!m) continue;
      const rect = m.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return m;
    }
    return null;
  };
`;

export const MODEL_SNAPSHOT_READ_JS = `
  const readModelMenuSnapshot = () => {
    ${MODEL_MENU_LOOKUP_JS}
    ${MODEL_ITEM_HELPERS_JS}
    const menu = findModelMenu();
    if (!menu) return { autoOn: true, autoDescription: '', maxModeOn: false, options: [] };

    const autoRow = findAutoRow(menu);
    let autoOn = false;
    let autoDescription = '';
    if (autoRow) {
      autoOn = autoLooksOnFromMenu(menu);
      autoDescription = autoDescriptionFromRow(autoRow);
    }

    let maxModeOn = false;
    for (const row of modelRowsIn(menu)) {
      if (isMaxModeRowLabel(labelOf(row))) maxModeOn = toggleLooksOn(row);
    }

    const options = autoOn ? [] : collectModelItems(menu);
    return { autoOn, autoDescription, maxModeOn, options };
  };
`;

export const MODEL_OPTIONS_HELPERS_JS = `
  const isVisibleEl = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const rowLooksSelected = (el) => {
    if (!el) return false;
    const aria = el.getAttribute('aria-checked') || el.getAttribute('aria-selected');
    if (aria === 'true') return true;
    const cls = el.className || '';
    if (/selected|active|checked/.test(cls)) return true;
    if (el.querySelector('[aria-checked="true"], [aria-selected="true"]')) return true;
    const text = (el.textContent || '');
    if (/[\\u2713\\u2714]/.test(text)) return true;
    return false;
  };

  const findModelOptionsPanel = (mainMenu) => {
    const scorePanel = (el) => {
      if (!isVisibleEl(el)) return 0;
      if (mainMenu && (el === mainMenu || mainMenu.contains(el))) return 0;
      const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (/search models/i.test(text)) return 0;
      if (/add models/i.test(text)) return 0;
      if (!/options/i.test(text) && !el.querySelector('[role="switch"]')) return 0;
      let score = 5;
      if (/^options/i.test(text) || /\\boptions\\b/i.test(text)) score += 8;
      if (el.querySelector('[role="switch"]')) score += 4;
      return score;
    };
    const roots = Array.from(document.querySelectorAll(
      '[role="menu"], [data-radix-popper-content-wrapper]'
    ));
    let best = null;
    let bestScore = 0;
    for (const root of roots) {
      const candidates = root.getAttribute('role') === 'menu'
        ? [root]
        : Array.from(root.querySelectorAll('[role="menu"]')).concat(
            root.getAttribute('data-radix-popper-content-wrapper') !== null ? [root] : []
          );
      for (const el of candidates) {
        const s = scorePanel(el);
        if (s > bestScore) { bestScore = s; best = el; }
      }
    }
    return best;
  };

  const optionRowsIn = (panel) => {
    if (!panel) return [];
    let raw = Array.from(panel.querySelectorAll('[role="menuitem"], [role="option"], [role="radio"]'));
    if (raw.length === 0) {
      raw = Array.from(panel.children).filter((el) => {
        const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        return t && !/^options$/i.test(t);
      });
    }
    return raw.filter(item => !raw.some(other => other !== item && other.contains(item)));
  };

  const parseModelOptionsPanel = (panel) => {
    const controls = [];
    if (!panel) return controls;
    const rows = optionRowsIn(panel);
    let groupLabel = '';
    const groupOptions = [];

    const flushGroup = () => {
      if (!groupLabel || groupOptions.length === 0) return;
      const selected = groupOptions.find((o) => o.selected);
      controls.push({
        kind: 'choice',
        id: 'choice::' + groupLabel,
        label: groupLabel,
        value: selected ? selected.label : groupOptions[0].label,
        options: groupOptions.map((o) => o.label),
      });
      groupLabel = '';
      groupOptions.length = 0;
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const label = labelOf(row);
      if (!label || /^options$/i.test(label)) continue;

      if (row.querySelector('[role="switch"]') || row.getAttribute('role') === 'switch') {
        flushGroup();
        controls.push({
          kind: 'toggle',
          id: 'toggle::' + label,
          label,
          on: toggleLooksOn(row),
        });
        continue;
      }

      const selected = rowLooksSelected(row);
      const nextLabel = i + 1 < rows.length ? labelOf(rows[i + 1]) : '';
      const looksHeader = !selected && label.length >= 5 && !/\\d/.test(label) &&
        nextLabel && (/\\d/.test(nextLabel) || nextLabel.length <= 4);
      if (looksHeader) {
        flushGroup();
        groupLabel = label;
        continue;
      }

      if (groupLabel) {
        groupOptions.push({ label, selected });
        continue;
      }

      flushGroup();
      groupLabel = label;
      groupOptions.push({ label, selected: true });
      flushGroup();
    }
    flushGroup();
    return controls;
  };

  const clickModelRowEdit = (menu, targetId) => {
    const row = findModelRowForId(menu, targetId);
    if (!row) return false;
    const edit = findEditButtonInRow(row);
    if (!edit) return false;
    edit.click();
    return true;
  };

  const readModelRowOptions = (menu, targetId) => {
    const row = findModelRowForId(menu, targetId);
    const modelLabel = row ? labelOf(row) : '';
    const panel = findModelOptionsPanel(menu);
    const controls = parseModelOptionsPanel(panel);
    return { rowId: targetId, modelLabel, controls };
  };

  const clickModelControl = (panel, controlId, value) => {
    if (!panel || !controlId) return false;
    if (controlId.startsWith('toggle::')) {
      const wantLabel = controlId.slice(8).toLowerCase();
      for (const row of optionRowsIn(panel)) {
        const rowLabel = labelOf(row).toLowerCase();
        if (rowLabel !== wantLabel) continue;
        const sw = row.querySelector('[role="switch"]');
        if (!sw) return false;
        const isOn = toggleLooksOn(row);
        const wantOn = value === undefined || value === null || value === ''
          ? !isOn
          : (value === true || value === 'true');
        if (isOn !== wantOn) sw.click();
        return true;
      }
      return false;
    }
    if (controlId.startsWith('choice::')) {
      const rest = controlId.slice(8);
      const parts = rest.split('::');
      const targetValue = (value || parts[1] || '').toString().trim().toLowerCase();
      if (!targetValue) return false;
      for (const row of optionRowsIn(panel)) {
        const rowLabel = labelOf(row).toLowerCase();
        if (rowLabel !== targetValue) continue;
        const clickable = row.querySelector('.composer-unified-context-menu-item') || row;
        clickable.click();
        return true;
      }
      return false;
    }
    return false;
  };
`;

export class CommandExecutor {
  private selectors: SelectorConfig;
  private client: CdpClient | null = null;

  constructor(selectors: SelectorConfig) {
    this.selectors = selectors;
  }

  setClient(client: CdpClient | null): void {
    this.client = client;
  }

  async sendMessage(
    commandId: string,
    text: string,
    opts?: { submit?: 'enter' | 'ctrlEnter' },
  ): Promise<CommandResult> {
    const submit = opts?.submit ?? 'enter';
    return this.withRetry(commandId, async (client) => {
      const strategies = this.selectors.chatInput.strategies;

      // Step 1: find and focus input (evaluate for DOM query + focus only)
      const result = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          let input = null;
          let matchedSelector = '';
          for (const sel of strategies) {
            try {
              input = document.querySelector(sel);
              if (input) { matchedSelector = sel; break; }
            } catch {}
          }
          if (!input) return { ok: false, error: 'Chat input not found (tried ' + strategies.length + ' selectors)' };

          const info = input.tagName + '.' + Array.from(input.classList).join('.') + ' | sel=' + matchedSelector;
          input.scrollIntoView({ block: 'center', behavior: 'instant' });
          input.focus();
          input.click();
          return { ok: true, info };
        })()
      `) as { ok: boolean; error?: string; info?: string } | null;

      if (!result?.ok) {
        throw new Error(result?.error ?? 'Failed to focus input');
      }

      logCommandOk(result.info ?? 'focused', commandCtx(commandId));
      await sleep(FOCUS_DELAY_MS);

      // Step 2: clear text Ctrl+A, then Delete (CDP Input domain)
      await client.pressKey('a', 'KeyA', 65, 2); // 2 = Ctrl modifier
      await sleep(50);
      await client.pressKey('Backspace', 'Backspace', 8);
      await sleep(50);

      // Step 3: paste via CDP Input.insertText (native Chromium input pipeline)
      await client.typeText(text);
      logCommandOk(`inserted ${text.length} chars`, commandCtx(commandId));
      await sleep(150);

      await this.submitComposer(client, commandId, text, submit);
    });
  }

  async forceQueueItem(commandId: string, queueItemId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const result = await client.evaluate(`
        (() => {
          const id = ${JSON.stringify(queueItemId)};
          let item = document.querySelector('.composer-toolbar-queue-item[data-queue-item-id="' + id.replace(/"/g, '') + '"]');
          if (!item) {
            item = Array.from(document.querySelectorAll('.composer-toolbar-queue-item')).find((el) => {
              const qid = el.getAttribute('data-queue-item-id') || '';
              return qid === id || qid.endsWith(id);
            }) || null;
          }
          if (!item) return { ok: false, error: 'Queue item not found' };
          const actions = item.querySelector('.composer-toolbar-queue-item-actions');
          if (!actions) return { ok: false, error: 'Queue buttons not found' };
          let btn = actions.querySelector('.codicon-arrow-up-two')?.closest(
            'button, [role="button"], .anysphere-icon-button',
          );
          if (!btn) {
            const buttons = actions.querySelectorAll(
              'button, [role="button"], .anysphere-icon-button',
            );
            btn = buttons.length >= 2 ? buttons[1] : buttons[0] || null;
          }
          if (!btn) return { ok: false, error: 'Send button not found' };
          btn.scrollIntoView({ block: 'center', behavior: 'instant' });
          btn.click();
          return { ok: true };
        })()
      `) as { ok: boolean; error?: string } | null;
      if (!result?.ok) {
        throw new Error(result?.error ?? 'Force queue submit failed');
      }
      logCommandOk(queueItemId.slice(0, 32), commandCtx(commandId, { itemId: queueItemId }));
    });
  }

  async sendMessageWithImages(
    commandId: string,
    opts: {
      text: string;
      imagePaths: string[];
      verifyStillOnTab: () => boolean;
      onTabDrift?: () => Promise<boolean>;
      submit?: 'enter' | 'ctrlEnter';
    },
  ): Promise<CommandResult> {
    const submit = opts.submit ?? 'enter';
    const previewSelectors = this.selectors.composerAttachmentPreview?.strategies ?? [];
    return this.withRetry(commandId, async (client) => {
      const strategies = this.selectors.chatInput.strategies;

      const focusResult = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          for (const sel of strategies) {
            try {
              const input = document.querySelector(sel);
              if (input) {
                input.scrollIntoView({ block: 'center', behavior: 'instant' });
                input.focus();
                input.click();
                return { ok: true };
              }
            } catch {}
          }
          return { ok: false, error: 'Chat input not found' };
        })()
      `) as { ok: boolean; error?: string };
      if (!focusResult?.ok) throw new Error(focusResult?.error ?? 'Failed to focus input');
      await sleep(FOCUS_DELAY_MS);

      for (const imagePath of opts.imagePaths) {
        if (!opts.verifyStillOnTab()) {
          if (opts.onTabDrift) {
            const ok = await opts.onTabDrift();
            if (!ok) throw new Error('Tab changed during image paste — aborted');
          } else {
            throw new Error('Tab changed during image paste — aborted');
          }
        }
        await setClipboardImage(imagePath);
        await sleep(150);
        if (!opts.verifyStillOnTab()) {
          throw new Error('Tab changed before paste — aborted');
        }
        const mod = 2;
        await client.dispatchKeyEvent('keyDown', {
          key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: mod,
        });
        await client.dispatchKeyEvent('keyUp', {
          key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: mod,
        });
        await sleep(300);
        let preview = await this.probeAttachmentPreview(client, previewSelectors);
        if (!preview.found) {
          await sleep(200);
          preview = await this.probeAttachmentPreview(client, previewSelectors);
        }
        if (!preview.found) {
          const fallback = await this.trySetFileInputFiles(client, imagePath);
          if (!fallback) throw new Error(`Attachment preview not found for ${imagePath}`);
        }
      }

      if (opts.text.trim()) {
        await client.typeText(opts.text);
        await sleep(150);
      }
      await this.submitComposer(client, commandId, opts.text, submit);
    });
  }

  private async submitComposer(
    client: CdpClient,
    commandId: string,
    text: string,
    submit: 'enter' | 'ctrlEnter',
  ): Promise<void> {
    if (textMayOpenMentionTypeahead(text)) {
      await sleep(250);
      if (await this.clickComposerSendButton(client, commandId)) return;
      await client.pressKey('Escape', 'Escape', 27);
      await sleep(80);
      await this.pressSubmit(client, 'ctrlEnter');
      return;
    }
    await this.pressSubmit(client, submit);
  }

  private async clickComposerSendButton(client: CdpClient, commandId: string): Promise<boolean> {
    const result = await client.evaluate(`
      (() => {
        const root = document.querySelector('.composer-bar')
          || document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar');
        if (!root) return { ok: false, error: 'Composer not found' };
        const pick = () => {
          const icons = root.querySelectorAll('.codicon-arrow-up-two, .codicon-arrow-up');
          for (const icon of Array.from(icons)) {
            const btn = icon.closest('button, [role="button"], .anysphere-icon-button');
            if (btn) return btn;
          }
          const labeled = root.querySelector('[aria-label*="Send" i], [aria-label*="Отправ" i]');
          if (labeled) return labeled.closest('button, [role="button"]') || labeled;
          return null;
        };
        const btn = pick();
        if (!btn) return { ok: false, error: 'Composer send button not found' };
        const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
        if (disabled) return { ok: false, error: 'Composer send button disabled' };
        btn.scrollIntoView({ block: 'center', behavior: 'instant' });
        btn.click();
        return { ok: true };
      })()
    `) as { ok: boolean; error?: string } | null;
    if (!result?.ok) return false;
    logCommandOk('composer send click', commandCtx(commandId));
    return true;
  }

  private async pressSubmit(client: CdpClient, submit: 'enter' | 'ctrlEnter'): Promise<void> {
    if (submit === 'ctrlEnter') {
      await client.pressKey('Enter', 'Enter', 13, 2);
      logCommandOk('Ctrl+Enter via CDP', commandCtx('press_submit', { hint: 'ctrlEnter' }));
    } else {
      await client.pressKey('Enter', 'Enter', 13);
      logCommandOk('Enter via CDP', commandCtx('press_submit', { hint: 'enter' }));
    }
  }

  private async probeAttachmentPreview(
    client: CdpClient,
    extraSelectors: string[],
  ): Promise<{ found: boolean }> {
    const patterns = [
      ...extraSelectors,
      '[class*="attachment"]',
      '[class*="composer-bar"] img',
      '[class*="composer"] img[src]',
      'img.image-pill-img',
    ];
    const hits = await client.evaluate(`
      (() => {
        const patterns = ${JSON.stringify(patterns)};
        const root = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar')
          || document.querySelector('.composer-bar')
          || document.body;
        for (const sel of patterns) {
          try {
            for (const el of Array.from(root.querySelectorAll(sel)).slice(0, 3)) {
              const rect = el.getBoundingClientRect();
              if (rect.width >= 8 && rect.height >= 8) return true;
            }
          } catch {}
        }
        return false;
      })()
    `) as boolean;
    return { found: !!hits };
  }

  private async trySetFileInputFiles(client: CdpClient, imagePath: string): Promise<boolean> {
    const { resolve } = await import('path');
    const abs = resolve(imagePath);
    await client.send('DOM.enable');
    const doc = await client.send('DOM.getDocument');
    const rootId = (doc.root as { nodeId: number }).nodeId;
    const qs = await client.send('DOM.querySelector', {
      nodeId: rootId,
      selector: 'input[type="file"]',
    });
    const nodeId = (qs.nodeId as number) ?? 0;
    if (!nodeId) return false;
    await client.send('DOM.setFileInputFiles', { nodeId, files: [abs] });
    await sleep(400);
    return true;
  }

  async clickApproval(
    commandId: string,
    selectorPath: string
  ): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const ok = await this.clickResolvedSelector(client, selectorPath);
      if (!ok) throw new Error(`Element not found: ${selectorPath}`);
    });
  }

  async approveAll(commandId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const selector = await this.findApproveAllButton(client);
      if (!selector) {
        throw new Error('"Accept All" button not found');
      }
      await client.click(selector);
    });
  }

  async reject(
    commandId: string,
    selectorPath: string
  ): Promise<CommandResult> {
    return this.clickApproval(commandId, selectorPath);
  }

  async scrollChatUp(commandId: string, times: number = 5): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const containerSelectors = this.selectors.chatContainer.strategies;
      for (let i = 0; i < times; i++) {
        await client.evaluate(`
          (() => {
            const strategies = ${JSON.stringify(containerSelectors)};
            for (const sel of strategies) {
              try {
                const el = document.querySelector(sel);
                if (el) {
                  const scrollable = el.querySelector('[class*="scroll"]') || el;
                  const step = Math.max(240, Math.floor(scrollable.clientHeight * 0.85));
                  scrollable.scrollTop = Math.max(0, scrollable.scrollTop - step);
                  scrollable.dispatchEvent(new WheelEvent('wheel', {
                    deltaY: -step,
                    bubbles: true,
                    cancelable: true,
                  }));
                  return true;
                }
              } catch {}
            }
            return false;
          })()
        `);
        await client.pressKey('PageUp', 'PageUp', 33);
        await sleep(500);
      }
      logCommandOk(`scrolled up ${times}x`, commandCtx(commandId, { hint: String(times) }));
    });
  }

  async scrollChatToBottom(commandId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const containerSelectors = this.selectors.chatContainer.strategies;
      await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(containerSelectors)};
          for (const sel of strategies) {
            try {
              const el = document.querySelector(sel);
              if (el) {
                const scrollable = el.querySelector('[class*="scroll"]') || el;
                scrollable.scrollTop = scrollable.scrollHeight;
                return true;
              }
            } catch {}
          }
          return false;
        })()
      `);
      logCommandOk('scrolled to bottom', commandCtx(commandId));
    });
  }

  async switchTab(
    commandId: string,
    tabTitle: string,
    _selectorPath?: string,
    opts?: { composerId?: string },
  ): Promise<CommandResult> {
    const composerId = (opts?.composerId ?? '').trim();
    return this.withRetry(commandId, async (client) => {
      const clicked = await client.evaluate(`
        (() => {
          const title = ${JSON.stringify(tabTitle)};
          const composerId = ${JSON.stringify(composerId)};
          const norm = s => s.trim().replace(/\\s+/g, ' ').toLowerCase();
          const target = norm(title);
          function cleanTabTitle(raw) {
            let t = (raw || '').trim().replace(/\\s+/g, ' ');
            t = t.replace(/(@[\\w./]+)+\\s*$/, '');
            return t.trim().substring(0, 120);
          }
          function clickSidebarByTitle() {
            const cells = Array.from(document.querySelectorAll('.agent-sidebar-cell'))
              .filter((c) => !c.closest('.agent-sidebar-header'));
            const exactCells = cells.filter((cell) => {
              const titleEl = cell.querySelector('.agent-sidebar-cell-text');
              const text = norm(titleEl ? (titleEl.textContent || '') : (cell.textContent || ''));
              return text === target;
            });
            if (exactCells.length === 1) {
              exactCells[0].click();
              return true;
            }
            if (exactCells.length > 1) {
              throw new Error('Ambiguous tab title: ' + title);
            }
            return false;
          }
          // Legacy Agents sidebar: row click — only working switch in this build.
          if (clickSidebarByTitle()) return true;
          function glassCompositeForBtn(btn) {
            const labelEl = btn.querySelector('.ui-sidebar-menu-button-label');
            const rawAgent = (labelEl?.textContent || '').trim();
            if (!rawAgent) return { composite: '', agentOnly: '' };
            const group = btn.closest('.ui-sidebar-group');
            const gt = group?.querySelector('.ui-sidebar-group-label-title');
            const rawGroup = (gt?.textContent || '').trim();
            let composite = cleanTabTitle(rawAgent);
            if (rawGroup) {
              const g = cleanTabTitle(rawGroup);
              if (g) composite = (g + ' / ' + cleanTabTitle(rawAgent)).substring(0, 120);
            }
            return { composite: norm(composite), agentOnly: norm(rawAgent) };
          }
          if (composerId) {
            for (const btn of Array.from(document.querySelectorAll(
              '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn'
            ))) {
              const cid = btn.getAttribute('data-composer-id')
                || btn.closest('[data-composer-id]')?.getAttribute('data-composer-id')
                || '';
              if (cid === composerId) {
                btn.click();
                return true;
              }
            }
          }
          const glassBtns = Array.from(document.querySelectorAll(
            '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn'
          ));
          if (glassBtns.length > 0) {
            const rows = glassBtns.map((btn) => ({
              btn,
              ...glassCompositeForBtn(btn),
            })).filter((r) => r.composite);
            const byComp = rows.filter((r) => r.composite === target);
            if (byComp.length === 1) {
              byComp[0].btn.click();
              return true;
            }
            const byAgent = rows.filter((r) => r.agentOnly === target);
            if (byAgent.length === 1) {
              byAgent[0].btn.click();
              return true;
            }
            if (byComp.length > 1 || byAgent.length > 1) {
              throw new Error('Ambiguous tab title for glass sidebar: ' + title);
            }
          }
          // Editor tabs (composer tabs)
          for (const tab of Array.from(document.querySelectorAll('.tabs-container .tab'))) {
            const label = tab.querySelector('a.label-name');
            const text = norm(cleanTabTitle(label ? (label.textContent || '') : ''));
            if (text && text === target) {
              tab.click();
              return true;
            }
          }
          return false;
        })()
      `) as boolean;
      if (!clicked) throw new Error('Tab not found: ' + tabTitle);

      const verifyDeadline = Date.now() + 5000;
      while (Date.now() < verifyDeadline) {
        const active = await client.evaluate(`
          (() => {
            const title = ${JSON.stringify(tabTitle)};
            const composerId = ${JSON.stringify(composerId)};
            const norm = s => s.trim().replace(/\\s+/g, ' ').toLowerCase();
            const target = norm(title);
            function cleanTabTitle(raw) {
              let t = (raw || '').trim().replace(/\\s+/g, ' ');
              t = t.replace(/(@[\\w./]+)+\\s*$/, '');
              return t.trim().substring(0, 120);
            }
            function activeContainerComposerId() {
              const el = document.querySelector('[data-composer-id]');
              return el?.getAttribute('data-composer-id') || '';
            }
            if (composerId && activeContainerComposerId() === composerId) return true;
            if (composerId) {
              const selTab = document.querySelector(
                '[role="tab"][data-resource-name="' + composerId + '"]'
              );
              if (selTab) {
                if (selTab.getAttribute('aria-selected') === 'true') return true;
                if (selTab.classList.contains('active') || selTab.classList.contains('selected')) {
                  return true;
                }
              }
            }
            function glassCompositeForBtn(btn) {
              const labelEl = btn.querySelector('.ui-sidebar-menu-button-label');
              const rawAgent = (labelEl?.textContent || '').trim();
              if (!rawAgent) return { composite: '', agentOnly: '' };
              const group = btn.closest('.ui-sidebar-group');
              const gt = group?.querySelector('.ui-sidebar-group-label-title');
              const rawGroup = (gt?.textContent || '').trim();
              let composite = cleanTabTitle(rawAgent);
              if (rawGroup) {
                const g = cleanTabTitle(rawGroup);
                if (g) composite = (g + ' / ' + cleanTabTitle(rawAgent)).substring(0, 120);
              }
              return { composite: norm(composite), agentOnly: norm(rawAgent) };
            }
            const glassBtns = Array.from(document.querySelectorAll(
              '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn'
            ));
            if (composerId) {
              for (const btn of glassBtns) {
                const cid = btn.getAttribute('data-composer-id')
                  || btn.closest('[data-composer-id]')?.getAttribute('data-composer-id')
                  || '';
                if (cid === composerId && btn.getAttribute('data-active') === 'true') return true;
              }
            }
            for (const btn of glassBtns) {
              if (btn.getAttribute('data-active') !== 'true') continue;
              const { composite, agentOnly } = glassCompositeForBtn(btn);
              if (composite === target || agentOnly === target) return true;
            }
            for (const tab of Array.from(document.querySelectorAll(
              '[role="tab"].tab, .tabs-container .tab[role="tab"]'
            ))) {
              const isSel = tab.getAttribute('aria-selected') === 'true'
                || tab.classList.contains('active')
                || tab.classList.contains('selected');
              if (!isSel) continue;
              const aria = (tab.getAttribute('aria-label') || '').split(',')[0].trim();
              const text = norm(cleanTabTitle(aria || (tab.textContent || '')));
              if (text === target) return true;
              if (composerId && tab.getAttribute('data-resource-name') === composerId) return true;
            }
            for (const cell of Array.from(document.querySelectorAll('.agent-sidebar-cell'))
              .filter((c) => !c.closest('.agent-sidebar-header'))) {
              const selected = cell.getAttribute('data-selected') === 'true'
                || cell.getAttribute('data-highlighted') === 'true'
                || cell.classList.contains('selected')
                || cell.classList.contains('active');
              if (!selected) continue;
              const titleEl = cell.querySelector('.agent-sidebar-cell-text');
              const text = norm(cleanTabTitle(titleEl ? (titleEl.textContent || '') : (cell.textContent || '')));
              if (text === target) return true;
            }
            return false;
          })()
        `) as boolean;
        if (active) {
          logCommandOk(`tab active: ${tabTitle}`, commandCtx(commandId, { windowTitle: tabTitle }));
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`Tab switch did not activate: ${tabTitle}`);
    });
  }

  /** Questionnaire click on live DOM: active question option letter,
   *  skip or continue. Selector built at click time — snapshot CSS path
   *  stale after re-render. */
  async clickQuestionnaire(
    commandId: string,
    target: 'skip' | 'continue' | { letter: string } | { selectorPath: string },
    options?: { forceContinue?: boolean },
  ): Promise<CommandResult> {
    const targetJson = JSON.stringify(target);
    const forceContinue = options?.forceContinue === true;
    return this.withRetry(commandId, async (client) => {
      const result = await client.evaluate(`
        (() => {
          const target = ${targetJson};
          function normLetter(s) {
            return (s || '').trim().toLowerCase().replace(/[).:\\s]+$/g, '');
          }
          function center(el) {
            if (!el) return null;
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return null;
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
          const toolbar = document.querySelector('.composer-questionnaire-toolbar');
          if (!toolbar) return { ok: false, error: 'Questionnaire already closed' };
          if (target === 'skip' || target === 'continue') {
            const actions = toolbar.querySelector('.composer-questionnaire-toolbar-actions');
            if (!actions) return { ok: false, error: 'Actions not found' };
            const classSel = target === 'skip' ? '.composer-skip-button' : '.composer-run-button';
            let btn = actions.querySelector(classSel);
            if (!btn) {
              const buttons = actions.querySelectorAll(
                'button, [role="button"], .anysphere-icon-button',
              );
              btn = target === 'skip' ? buttons[0] : buttons[buttons.length - 1] || null;
            }
            if (!btn) return { ok: false, error: 'Button not found' };
            if (target === 'continue' && btn.getAttribute('data-disabled') === 'true' && !${forceContinue}) {
              return { ok: false, error: 'Continue button unavailable' };
            }
            const pt = center(btn);
            if (!pt) return { ok: false, error: 'Button not visible' };
            return { ok: true, ...pt };
          }
          if (target && typeof target.selectorPath === 'string' && target.selectorPath.trim()) {
            const explicit = document.querySelector(target.selectorPath);
            if (!explicit) {
              return { ok: false, error: 'Questionnaire option not found by selectorPath' };
            }
            const pt = center(explicit);
            if (!pt) return { ok: false, error: 'Questionnaire option not visible' };
            return { ok: true, ...pt };
          }
          const active = toolbar.querySelector('.composer-questionnaire-toolbar-question-active')
            || toolbar.querySelector('.composer-questionnaire-toolbar-question');
          if (!active) return { ok: false, error: 'Active question not found' };
          const want = normLetter(target.letter);
          for (const opt of Array.from(active.querySelectorAll('.composer-questionnaire-toolbar-option'))) {
            const letterBtn = opt.querySelector('.composer-questionnaire-toolbar-option-letter');
            const letter = normLetter(letterBtn ? letterBtn.textContent : '');
            if (letter === want) {
              const pt = center(opt);
              if (!pt) return { ok: false, error: 'Option not visible' };
              return { ok: true, ...pt };
            }
          }
          return { ok: false, error: 'Option "' + target.letter + '" not found — question may have changed' };
        })()
      `) as { ok: boolean; error?: string; x?: number; y?: number };
      if (!result?.ok || result.x == null || result.y == null) {
        throw new Error(result?.error ?? 'Questionnaire click failed');
      }
      await client.clickAtCoords(result.x, result.y);
      if (target === 'continue') {
        await sleep(120);
        await client.pressKey('Enter', 'Enter', 13);
      }
      const label =
        typeof target === 'string'
          ? target
          : 'selectorPath' in target
            ? target.selectorPath.slice(-40)
            : target.letter;
      logCommandOk(`questionnaire click: ${label}`, commandCtx(commandId, { hint: label }));
    });
  }

  /** After freeform on a non-final question: Enter in textarea, then click next stepper question (once). */
  async advanceQuestionnaireStep(commandId: string): Promise<CommandResult> {
    return this.withRetryOnce(commandId, async (client) => {
      const hasTextarea = await client.evaluate(`
        (() => {
          const active = document.querySelector('.composer-questionnaire-toolbar-question-active');
          const ta = active?.querySelector('.composer-questionnaire-toolbar-freeform-input');
          if (!ta) return false;
          ta.focus();
          return true;
        })()
      `) as boolean;
      if (hasTextarea) {
        await client.pressKey('Enter', 'Enter', 13);
        await sleep(250);
      }

      const result = await client.evaluate(`
        (() => {
          const toolbar = document.querySelector('.composer-questionnaire-toolbar');
          if (!toolbar) return { ok: false, error: 'Questionnaire not open' };
          const questions = Array.from(toolbar.querySelectorAll('.composer-questionnaire-toolbar-question'));
          const activeIdx = questions.findIndex((q) => q.classList.contains('composer-questionnaire-toolbar-question-active'));
          if (activeIdx < 0 || activeIdx >= questions.length - 1) {
            return { ok: false, error: 'Already on last question' };
          }
          const next = questions[activeIdx + 1];
          const hit = next.querySelector('.composer-questionnaire-toolbar-question-number') || next;
          hit.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = hit.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return { ok: false, error: 'Next question not visible' };
          return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()
      `) as { ok: boolean; error?: string; x?: number; y?: number };
      if (!result?.ok || result.x == null || result.y == null) {
        const err = result?.error ?? 'Questionnaire step advance failed';
        if (err === 'Questionnaire not open' || err === 'Already on last question') {
          return;
        }
        throw new Error(err);
      }
      await client.clickAtCoords(result.x, result.y);
      logCommandOk('questionnaire advance', commandCtx(commandId));
    });
  }

  async setQuestionnaireFreeform(
    commandId: string,
    selectorPath: string,
    text: string,
  ): Promise<CommandResult> {
    const pathJson = JSON.stringify(selectorPath);
    const textJson = JSON.stringify(text);
    return this.withRetry(commandId, async (client) => {
      const ok = await client.evaluate(`
        (() => {
          const el = document.querySelector(${pathJson});
          if (!el || el.tagName !== 'TEXTAREA') return false;
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value',
          )?.set;
          if (setter) setter.call(el, ${textJson});
          else el.value = ${textJson};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()
      `) as boolean;
      if (!ok) throw new Error('Questionnaire freeform textarea not found');
      logCommandOk(`questionnaire freeform ${text.length} chars`, commandCtx(commandId));
    });
  }

  async newChat(commandId: string): Promise<CommandResult> {
    return this.withRetryOnce(commandId, async (client) => {
      const strategies = this.selectors.newChatButton?.strategies ?? [];
      const result = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          for (const sel of strategies) {
            try {
              const el = document.querySelector(sel);
              if (!el) continue;
              el.click();
              return { ok: true, sel };
            } catch {}
          }
          return { ok: false };
        })()
      `) as { ok: boolean; sel?: string };
      if (!result?.ok) throw new Error('New Chat button not found');
      logCommandOk(`new chat (${result.sel ?? '?'})`, commandCtx(commandId, { hint: result.sel }));
    });
  }

  /** Close composer tab in Agents Window (× on tab bar). */
  async closeChat(
    commandId: string,
    tabTitle?: string,
    opts?: { composerId?: string },
  ): Promise<CommandResult> {
    const composerId = (opts?.composerId ?? '').trim();
    return this.withRetry(commandId, async (client) => {
      const clicked = await client.evaluate(`
        (() => {
          const tabTitle = ${JSON.stringify(tabTitle ?? '')};
          const composerId = ${JSON.stringify(composerId)};
          const norm = s => s.trim().replace(/\\s+/g, ' ').toLowerCase();
          function cleanTabTitle(raw) {
            let t = (raw || '').trim().replace(/\\s+/g, ' ');
            t = t.replace(/(@[\\w./]+)+\\s*$/, '');
            return t.trim().substring(0, 120);
          }
          function tabLabel(tab) {
            const label = tab.querySelector('.monaco-highlighted-label, .label-name');
            const fromLabel = label ? (label.textContent || '').trim() : '';
            const aria = (tab.getAttribute('aria-label') || '').split(',')[0].trim();
            return cleanTabTitle(fromLabel || aria || (tab.textContent || ''));
          }
          const tabs = Array.from(document.querySelectorAll(
            '.tabs-container .tab[role="tab"], [role="tab"].tab'
          ));
          let target = null;
          if (composerId) {
            target = tabs.find((t) => t.getAttribute('data-resource-name') === composerId) ?? null;
          }
          if (!target && tabTitle) {
            const want = norm(tabTitle);
            const matches = tabs.filter((t) => {
              const label = norm(tabLabel(t));
              return label === want || label.startsWith(want) || want.startsWith(label);
            });
            if (matches.length === 1) target = matches[0];
            else if (matches.length > 1) throw new Error('Ambiguous chat tab: ' + tabTitle);
          }
          if (!target) {
            target = tabs.find((t) =>
              t.classList.contains('active')
              || t.classList.contains('selected')
              || t.getAttribute('aria-selected') === 'true'
            ) ?? null;
          }
          if (!target) return false;
          const closeBtn = target.querySelector(
            '.tab-actions .codicon-close, .tab-actions a.action-label.codicon-close'
          );
          if (!closeBtn) return false;
          closeBtn.click();
          return true;
        })()
      `) as boolean;
      if (!clicked) {
        throw new Error(tabTitle ? `Chat tab not found: ${tabTitle}` : 'No active chat tab to close');
      }
      logCommandOk(`closed tab: ${tabTitle ?? '(active)'}`, commandCtx(commandId, { windowTitle: tabTitle }));
    });
  }

  /** Read active composer tab: title and composer-id (direct CDP, no poll wait). */
  async readActiveComposerTabInfo(): Promise<{ title: string | null; composerId: string | null }> {
    if (!this.client || !this.client.isConnected()) {
      return { title: null, composerId: null };
    }
    const raw = await this.client.evaluate(`
      (() => {
        function cleanTabTitle(raw) {
          let t = (raw || '').trim().replace(/\\s+/g, ' ');
          t = t.replace(/(@[\\w./]+)+\\s*$/, '');
          return t.trim().substring(0, 120);
        }
        function readGlass(btn) {
          const labelEl = btn.querySelector('.ui-sidebar-menu-button-label');
          const rawAgentTitle = (labelEl?.textContent || '').trim();
          if (!rawAgentTitle) return null;
          const group = btn.closest('.ui-sidebar-group');
          const groupTitleEl = group?.querySelector('.ui-sidebar-group-label-title');
          const rawGroupTitle = (groupTitleEl?.textContent || '').trim();
          let displayTitle = cleanTabTitle(rawAgentTitle);
          if (rawGroupTitle) {
            const g = cleanTabTitle(rawGroupTitle);
            if (g) displayTitle = (g + ' / ' + cleanTabTitle(rawAgentTitle)).substring(0, 120);
          }
          const composerId =
            btn.getAttribute('data-composer-id')
            || btn.closest('[data-composer-id]')?.getAttribute('data-composer-id')
            || ('glass:' + displayTitle);
          return { title: displayTitle, composerId };
        }
        const glassBtns = Array.from(document.querySelectorAll(
          '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn'
        ));
        if (glassBtns.length > 0) {
          const active = glassBtns.find((btn) =>
            btn.getAttribute('data-active') === 'true'
            || btn.classList.contains('selected')
          ) ?? glassBtns[0];
          const info = readGlass(active);
          if (info?.title) return info;
        }
        const legacyTab = document.querySelector(
          '.tabs-container .tab.active, .tabs-container .tab.selected, [role="tab"].active, [role="tab"].selected'
        );
        if (legacyTab) {
          const label = legacyTab.querySelector('.monaco-highlighted-label, .label-name, .agent-sidebar-cell-text');
          const fromLabel = label ? (label.textContent || '').trim() : '';
          const aria = (legacyTab.getAttribute('aria-label') || '').split(',')[0].trim();
          const title = cleanTabTitle(fromLabel || aria || (legacyTab.textContent || '').trim().split('\\n')[0].trim());
          const composerId =
            legacyTab.getAttribute('data-composer-id')
            || legacyTab.closest('[data-composer-id]')?.getAttribute('data-composer-id')
            || '';
          if (title) return { title, composerId };
        }
        const container = document.querySelector('[data-composer-id]');
        const containerComposerId = container?.getAttribute('data-composer-id') || '';
        return { title: null, composerId: containerComposerId || null };
      })()
    `) as { title: string | null; composerId: string | null };
    return {
      title: raw?.title?.trim() || null,
      composerId: raw?.composerId?.trim() || null,
    };
  }

  /** Read active composer tab title from Agents Window tab bar. */
  async readActiveComposerTabTitle(): Promise<string | null> {
    const info = await this.readActiveComposerTabInfo();
    return info.title;
  }

  async setMode(commandId: string, modeId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      await this.openModeMenu(client);

      const selected = await client.evaluate(`
        (() => {
          ${MODE_ITEM_HELPERS_JS}
          return pickModeById(${JSON.stringify(modeId)});
        })()
      `) as boolean;
      if (!selected) throw new Error(`Mode "${modeId}" not found in dropdown`);
      logCommandOk(`mode=${modeId}`, commandCtx(commandId, { hint: modeId }));
    });
  }

  async getModeOptions(commandId: string): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      return await this.openModeMenuAndReadOptions(client);
    });
    if (!result.ok) return result;
    return { commandId, ok: true, data: result.data };
  }

  async toggleModelAuto(commandId: string, on: boolean): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      await this.openModelMenu(client);
      for (let attempt = 0; attempt < 2; attempt++) {
        const toggled = await client.evaluate(`
          (() => {
            ${MODEL_MENU_LOOKUP_JS}
            ${MODEL_ITEM_HELPERS_JS}
            const menu = findModelMenu();
            if (!menu) return false;
            const autoRow = findAutoRow(menu);
            if (!autoRow) return false;
            const isOn = autoLooksOnFromMenu(menu);
            if (isOn !== ${JSON.stringify(on)}) clickAutoToggleInRow(autoRow);
            return true;
          })()
        `) as boolean;
        if (!toggled) throw new Error('Auto toggle not found in model menu');
        await sleep(500);
        const snapshot = await client.evaluate(`
          (() => {
            ${MODEL_SNAPSHOT_READ_JS}
            return readModelMenuSnapshot();
          })()
        `) as ModelOptionsSnapshot;
        if (snapshot.autoOn === on) {
          await client.pressKey('Escape', 'Escape', 27);
          await sleep(100);
          return snapshot;
        }
      }
      const snapshot = await client.evaluate(`
        (() => {
          ${MODEL_SNAPSHOT_READ_JS}
          return readModelMenuSnapshot();
        })()
      `) as ModelOptionsSnapshot;
      await client.pressKey('Escape', 'Escape', 27);
      await sleep(100);
      return snapshot;
    });
    if (!result.ok) return result;
    return { commandId, ok: true, data: result.data };
  }

  async getModelRowOptions(commandId: string, modelId: string): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      await this.openModelMenu(client);
      const edited = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          ${MODEL_ITEM_HELPERS_JS}
          ${MODEL_OPTIONS_HELPERS_JS}
          const menu = findModelMenu();
          if (!menu) return false;
          return clickModelRowEdit(menu, ${JSON.stringify(modelId)});
        })()
      `) as boolean;
      if (!edited) throw new Error('Edit button not found for model row');

      let snapshot: ModelRowOptionsSnapshot | null = null;
      for (let i = 0; i < 12; i++) {
        await sleep(100);
        snapshot = await client.evaluate(`
          (() => {
            ${MODEL_MENU_LOOKUP_JS}
            ${MODEL_ITEM_HELPERS_JS}
            ${MODEL_OPTIONS_HELPERS_JS}
            const menu = findModelMenu();
            if (!menu) return null;
            return readModelRowOptions(menu, ${JSON.stringify(modelId)});
          })()
        `) as ModelRowOptionsSnapshot | null;
        if (snapshot && snapshot.controls.length > 0) break;
      }
      if (!snapshot || snapshot.controls.length === 0) {
        throw new Error('Model options panel not found');
      }
      await this.closeModelMenus(client);
      logCommandOk(`rowOptions=${snapshot.controls.length}`, commandCtx(commandId, { hint: modelId }));
      return snapshot;
    });
    if (!result.ok) return result;
    return { commandId, ok: true, data: result.data };
  }

  async setModelControl(
    commandId: string,
    modelId: string,
    controlId: string,
    value?: string,
  ): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      await this.openModelMenu(client);
      const edited = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          ${MODEL_ITEM_HELPERS_JS}
          ${MODEL_OPTIONS_HELPERS_JS}
          const menu = findModelMenu();
          if (!menu) return false;
          return clickModelRowEdit(menu, ${JSON.stringify(modelId)});
        })()
      `) as boolean;
      if (!edited) throw new Error('Edit button not found for model row');

      let panelReady = false;
      for (let i = 0; i < 12; i++) {
        await sleep(100);
        panelReady = await client.evaluate(`
          (() => {
            ${MODEL_MENU_LOOKUP_JS}
            ${MODEL_OPTIONS_HELPERS_JS}
            const menu = findModelMenu();
            return findModelOptionsPanel(menu) !== null;
          })()
        `) as boolean;
        if (panelReady) break;
      }
      if (!panelReady) throw new Error('Model options panel not found');

      const clicked = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          ${MODEL_ITEM_HELPERS_JS}
          ${MODEL_OPTIONS_HELPERS_JS}
          const menu = findModelMenu();
          const panel = findModelOptionsPanel(menu);
          return clickModelControl(panel, ${JSON.stringify(controlId)}, ${JSON.stringify(value ?? '')});
        })()
      `) as boolean;
      if (!clicked) throw new Error('Model control not found in options panel');

      await sleep(250);
      const snapshot = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          ${MODEL_ITEM_HELPERS_JS}
          ${MODEL_OPTIONS_HELPERS_JS}
          const menu = findModelMenu();
          if (!menu) return null;
          return readModelRowOptions(menu, ${JSON.stringify(modelId)});
        })()
      `) as ModelRowOptionsSnapshot;
      await this.closeModelMenus(client);
      logCommandOk(`control=${controlId}`, commandCtx(commandId, { hint: modelId }));
      return snapshot;
    });
    if (!result.ok) return result;
    return { commandId, ok: true, data: result.data };
  }

  async clickAction(commandId: string, selectorPath: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      if (
        selectorPath === CONFIRM_SEARCH_CONTINUE
        || selectorPath === CONFIRM_SEARCH_CANCEL
        || selectorPath === CONFIRM_SEARCH_TOGGLE
      ) {
        const result = await this.clickConfirmSearchAtCoords(client, selectorPath);
        if (!result.ok || result.x == null || result.y == null) {
          throw new Error(result.error ?? `Element not found: ${selectorPath}`);
        }
        await client.clickAtCoords(result.x, result.y);
        logCommandOk(selectorPath.substring(0, 60), commandCtx(commandId, { hint: selectorPath.substring(0, 60) }));
        return;
      }
      const deleteClick = parseDeleteFileSelector(selectorPath);
      if (deleteClick) {
        const result = await this.clickDeleteFileAtCoords(client, deleteClick.toolCallId, deleteClick.kind);
        if (!result.ok || result.x == null || result.y == null) {
          throw new Error(result.error ?? `Element not found: ${selectorPath}`);
        }
        await client.clickAtCoords(result.x, result.y);
        logCommandOk(selectorPath.substring(0, 60), commandCtx(commandId, { hint: selectorPath.substring(0, 60) }));
        return;
      }
      const ok = await this.clickResolvedSelector(client, selectorPath);
      if (!ok) throw new Error(`Element not found: ${selectorPath}`);
      logCommandOk(selectorPath.substring(0, 60), commandCtx(commandId, { hint: selectorPath.substring(0, 60) }));
    });
  }

  /** Confirm search uses empty-text .cursor-button divs — coordinate click (see sandbox recording frame 16). */
  private async clickConfirmSearchAtCoords(
    client: CdpClient,
    selectorPath: string,
  ): Promise<{ ok: boolean; error?: string; x?: number; y?: number }> {
    return (await client.evaluate(`
      (() => {
        const path = ${JSON.stringify(selectorPath)};
        const CONFIRM_SEARCH_CONTINUE = ${JSON.stringify(CONFIRM_SEARCH_CONTINUE)};
        const CONFIRM_SEARCH_CANCEL = ${JSON.stringify(CONFIRM_SEARCH_CANCEL)};
        const CONFIRM_SEARCH_TOGGLE = ${JSON.stringify(CONFIRM_SEARCH_TOGGLE)};
        const kind = path === CONFIRM_SEARCH_TOGGLE ? 'toggle'
          : path === CONFIRM_SEARCH_CONTINUE ? 'continue'
          : path === CONFIRM_SEARCH_CANCEL ? 'cancel'
          : '';
        if (!kind) return { ok: false, error: 'Unknown confirm-search path' };

        const cleanLabel = (raw) => raw.replace(/\\s*(Shift\\+)?⏎\\s*/g, '').replace(/\\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none' && st.pointerEvents !== 'none';
        };
        const center = (el) => {
          if (!visible(el)) return null;
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        };

        const findActiveConfirmSearchRoot = () => {
          const headers = Array.from(document.querySelectorAll('.composer-tool-call-header'));
          for (let i = headers.length - 1; i >= 0; i--) {
            const h = headers[i];
            const raw = (h.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!/^Confirm search/i.test(raw)) continue;
            const root = h.closest('.virtualized-composer-messages-row')
              || h.closest('.ui-tool-call-card')
              || h.closest('[data-tool-call-id]')
              || h.parentElement;
            if (!root) continue;
            const scope = root.querySelector('.composer-tool-call-status-row')
              || root.querySelector('.composer-tool-call-control-row')
              || root;
            const txt = (root.textContent || '').replace(/\\s+/g, ' ');
            if (scope.querySelector('.cursor-setting-value-checkbox') || /Cancel\\s*Continue/i.test(txt)) {
              return root;
            }
          }
          return null;
        };

        const confirmSearchAreas = (root) => {
          const scope = root.querySelector('.composer-tool-call-status-row')
            || root.querySelector('.composer-tool-call-control-row')
            || root;
          return scope === root ? [root] : [scope, root];
        };

        const findToggle = (root) => {
          for (const area of confirmSearchAreas(root)) {
            const el = area.querySelector('.cursor-setting-value-checkbox[role="checkbox"]')
              || area.querySelector('.cursor-setting-value-checkbox');
            if (el) return el;
          }
          return null;
        };

        const isExcluded = (el, toggle) => {
          if (!el || el === toggle || toggle?.contains(el) || el.contains(toggle)) return true;
          return !!el.closest('.usage-limit-policy-banner');
        };

        const collectClickables = (area, toggle) => Array.from(area.querySelectorAll(
          '.cursor-button, button.ui-button, button, [role="button"], .composer-run-button, .composer-skip-button'
        )).filter((el) => !isExcluded(el, toggle) && visible(el));

        const findByLabel = (root, word, toggle) => {
          const want = word.toLowerCase();
          let best = null;
          let bestLen = Infinity;
          for (const el of Array.from(root.querySelectorAll(
            '.cursor-button, button, [role="button"], .composer-run-button, .composer-skip-button, .ui-button'
          ))) {
            if (isExcluded(el, toggle) || !visible(el)) continue;
            const label = cleanLabel(el.getAttribute('aria-label') || el.textContent || '');
            const norm = label.toLowerCase();
            if (norm !== want && !norm.startsWith(want)) continue;
            const len = (el.textContent || '').length;
            if (len < bestLen) { best = el; bestLen = len; }
          }
          return best;
        };

        const hasSize = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };

        const findConfirmSearchTextPoint = (root, wordKind) => {
          const areas = confirmSearchAreas(root);
          for (const area of areas) {
            const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              const raw = node.textContent || '';
              if (!raw.trim()) continue;
              let idx = -1;
              let len = 0;
              if (wordKind === 'cancel') {
                const m = raw.match(/Cancel(?=Continue|\\s|$)/i);
                if (m) { idx = m.index; len = m[0].length; }
              } else if (wordKind === 'continue') {
                const m = raw.match(/Continue(?=\\s|⏎|$)/i);
                if (m) { idx = m.index; len = m[0].length; }
              }
              if (idx < 0) continue;
              const range = document.createRange();
              range.setStart(node, idx);
              range.setEnd(node, idx + len);
              const r = range.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) continue;
              let hit = node.parentElement;
              while (hit && hit !== area && !hit.matches('.cursor-button, button, [role=\"button\"]')) {
                hit = hit.parentElement;
              }
              const target = hit && hasSize(hit) ? hit : node.parentElement;
              if (target) target.scrollIntoView({ block: 'center', behavior: 'instant' });
              const ptRect = target && hasSize(target) ? target.getBoundingClientRect() : r;
              return { x: ptRect.left + ptRect.width / 2, y: ptRect.top + ptRect.height / 2 };
            }
          }
          return null;
        };

        const resolveButtons = (root) => {
          const toggle = findToggle(root);
          let cancel = null;
          let cont = null;

          for (const area of confirmSearchAreas(root)) {
            const clickables = collectClickables(area, toggle);
            if (clickables.length >= 2) {
              cancel = clickables[0];
              cont = clickables[clickables.length - 1];
              break;
            }
            const cursorBtns = Array.from(area.querySelectorAll('.cursor-button'))
              .filter((el) => !isExcluded(el, toggle) && (visible(el) || hasSize(el)));
            if (cursorBtns.length >= 2) {
              cancel = cursorBtns.find((b) => b.classList.contains('cursor-button-secondary-clickable')) || cursorBtns[0];
              cont = cursorBtns.find((b) => b.classList.contains('cursor-button-primary-clickable')) || cursorBtns[cursorBtns.length - 1];
              break;
            }
            if (cursorBtns.length === 1 && /Cancel\\s*Continue/i.test(area.textContent || '')) {
              cancel = cursorBtns[0];
              cont = cursorBtns[0];
            }
          }

          if (toggle) {
            const row = toggle.closest('.composer-tool-call-status-row')
              || toggle.closest('.composer-tool-call-control-row')
              || toggle.parentElement;
            if (row) {
              const rowClickables = collectClickables(row, toggle);
              if (rowClickables.length >= 2) {
                cancel = cancel || rowClickables[0];
                cont = cont || rowClickables[rowClickables.length - 1];
              }
              const rowCursor = Array.from(row.querySelectorAll('.cursor-button'))
                .filter((el) => !isExcluded(el, toggle) && (visible(el) || hasSize(el)));
              if (rowCursor.length >= 2) {
                cancel = cancel || rowCursor[0];
                cont = cont || rowCursor[rowCursor.length - 1];
              }
            }
          }

          for (const area of confirmSearchAreas(root)) {
            cancel = cancel || findByLabel(area, 'cancel', toggle);
            cont = cont || findByLabel(area, 'continue', toggle);
          }

          const bar = document.querySelector('.composer-bar')
            || document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar');
          if (bar) {
            cancel = cancel || findByLabel(bar, 'cancel', toggle);
            cont = cont || findByLabel(bar, 'continue', toggle);
            const barClickables = collectClickables(bar, toggle);
            if (!cancel && !cont && barClickables.length >= 2) {
              cancel = barClickables[0];
              cont = barClickables[barClickables.length - 1];
            }
          }

          return { toggle, cancel, continue: cont };
        };

        const pointForKind = (root, wordKind) => {
          const { toggle, cancel, continue: contBtn } = resolveButtons(root);
          if (wordKind === 'toggle') {
            if (!toggle) return null;
            const pt = center(toggle);
            return pt ? { ok: true, ...pt } : null;
          }
          const btn = wordKind === 'continue' ? contBtn : cancel;
          if (btn) {
            const pt = center(btn);
            if (pt) return { ok: true, ...pt };
          }
          const textPt = findConfirmSearchTextPoint(root, wordKind);
          return textPt ? { ok: true, ...textPt } : null;
        };

        const root = findActiveConfirmSearchRoot();
        if (!root) return { ok: false, error: 'Confirm search card not found' };

        if (kind === 'toggle') {
          const hit = pointForKind(root, 'toggle');
          return hit || { ok: false, error: 'Auto-search toggle not found' };
        }
        const hit = pointForKind(root, kind);
        return hit || { ok: false, error: kind + ' button not found' };
      })()
    `)) as { ok: boolean; error?: string; x?: number; y?: number };
  }

  /** Delete file cards use Reject/Accept text like Confirm search (recording 2026-07-03). */
  private async clickDeleteFileAtCoords(
    client: CdpClient,
    toolCallId: string,
    kind: 'accept' | 'reject',
  ): Promise<{ ok: boolean; error?: string; x?: number; y?: number }> {
    return (await client.evaluate(`
      (() => {
        const toolCallId = ${JSON.stringify(toolCallId)};
        const kind = ${JSON.stringify(kind)};
        const visible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none' && st.pointerEvents !== 'none';
        };
        const hasSize = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const center = (el) => {
          if (!visible(el) && !hasSize(el)) return null;
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        };
        const cleanAction = (raw) => (raw || '').replace(/\^+/g, '').trim().toLowerCase();
        const isActiveDeleteRow = (row) => {
          const action = row.querySelector('.ui-tool-call-line-action');
          const actionText = cleanAction(action?.textContent);
          if (actionText === 'deleted') return false;
          if (actionText === 'delete' || actionText === 'deleting') return true;
          const scope = row.querySelector('.composer-tool-call-status-row') || row;
          return /Reject\\s*Accept/i.test(scope.textContent || '');
        };
        const rowToolCallId = (row) => {
          const bubble = row.querySelector('[data-tool-call-id]') || row.closest('[data-tool-call-id]');
          return bubble?.getAttribute('data-tool-call-id') || '';
        };
        const findRoot = () => {
          const activeRows = [];
          for (const row of Array.from(document.querySelectorAll('.virtualized-composer-messages-row'))) {
            if (!isActiveDeleteRow(row)) continue;
            activeRows.push(row);
          }
          for (const row of activeRows) {
            if (rowToolCallId(row) === toolCallId) return row;
          }
          const byId = document.querySelector('[data-tool-call-id="' + toolCallId + '"]');
          if (byId) {
            const row = byId.closest('.virtualized-composer-messages-row') || byId;
            if (isActiveDeleteRow(row)) return row;
          }
          if (activeRows.length === 1) return activeRows[0];
          return null;
        };
        const findTextPoint = (root, wordKind) => {
          const scope = root.querySelector('.composer-tool-call-status-row') || root;
          const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const raw = node.textContent || '';
            if (!raw.trim()) continue;
            let idx = -1;
            let len = 0;
            if (wordKind === 'reject') {
              const m = raw.match(/Reject(?=Accept|\\s|$)/i);
              if (m) { idx = m.index; len = m[0].length; }
            } else if (wordKind === 'accept') {
              const m = raw.match(/Accept\\^?(?=\\s|⏎|$)/i);
              if (m) { idx = m.index; len = m[0].length; }
            }
            if (idx < 0) continue;
            const range = document.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + len);
            const r = range.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
          return null;
        };
        const root = findRoot();
        if (!root) return { ok: false, error: 'Delete file card not found' };
        const scope = root.querySelector('.composer-tool-call-status-row') || root;
        const clickables = Array.from(scope.querySelectorAll('.cursor-button, button, [role="button"]'))
          .filter((el) => hasSize(el));
        let target = null;
        if (clickables.length >= 2) {
          target = kind === 'reject' ? clickables[0] : clickables[clickables.length - 1];
        } else {
          for (const btn of clickables) {
            const label = (btn.textContent || '').replace(/\\^+/g, '').trim().toLowerCase();
            if (kind === 'reject' && label === 'reject') target = btn;
            if (kind === 'accept' && (label === 'accept' || label.startsWith('accept'))) target = btn;
          }
        }
        if (target) {
          const pt = center(target);
          if (pt) return { ok: true, ...pt };
        }
        const textPt = findTextPoint(root, kind);
        return textPt ? { ok: true, ...textPt } : { ok: false, error: kind + ' button not found' };
      })()
    `)) as { ok: boolean; error?: string; x?: number; y?: number };
  }

  private async clickResolvedSelector(client: CdpClient, selectorPath: string): Promise<boolean> {
    return (await client.evaluate(`
      (() => {
        const path = ${JSON.stringify(selectorPath)};
        const CONFIRM_SEARCH_CONTINUE = ${JSON.stringify(CONFIRM_SEARCH_CONTINUE)};
        const CONFIRM_SEARCH_CANCEL = ${JSON.stringify(CONFIRM_SEARCH_CANCEL)};
        const CONFIRM_SEARCH_TOGGLE = ${JSON.stringify(CONFIRM_SEARCH_TOGGLE)};
        const SHELL_SKIP = 'button.ui-shell-tool-call__skip-btn';
        const SHELL_RUN = 'button.ui-shell-tool-call__run-btn';
        const SHELL_ALLOW = 'button.ui-shell-tool-call__allowlist-button';
        const stable = [SHELL_SKIP, SHELL_RUN, SHELL_ALLOW];
        const cleanLabel = (raw) => raw.replace(/\\s*(Shift\\+)?⏎\\s*/g, '').replace(/\\s+/g, ' ').trim();
        const clickEl = (el) => {
          if (!el) return false;
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          el.click();
          return true;
        };
        const findActiveConfirmSearchRoot = () => {
          const headers = Array.from(document.querySelectorAll('.composer-tool-call-header'));
          for (let i = headers.length - 1; i >= 0; i--) {
            const h = headers[i];
            const raw = (h.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!/^Confirm search/i.test(raw)) continue;
            const root = h.closest('.virtualized-composer-messages-row')
              || h.closest('.ui-tool-call-card')
              || h.closest('[data-tool-call-id]')
              || h.parentElement;
            if (!root) continue;
            const scope = root.querySelector('.composer-tool-call-status-row')
              || root.querySelector('.composer-tool-call-control-row')
              || root;
            const hasControls = (el) => {
              if (!el) return false;
              if (el.querySelector('.cursor-setting-value-checkbox')) return true;
              for (const btn of Array.from(el.querySelectorAll('.cursor-button'))) {
                if (btn.closest('.usage-limit-policy-banner')) continue;
                return true;
              }
              const txt = (el.textContent || '').replace(/\\s+/g, ' ');
              return /Cancel\\s*Continue/i.test(txt);
            };
            if (hasControls(scope) || hasControls(root)) return root;
          }
          return null;
        };
        const confirmSearchAreas = (root) => {
          const scope = root.querySelector('.composer-tool-call-status-row')
            || root.querySelector('.composer-tool-call-control-row')
            || root;
          return scope === root ? [root] : [scope, root];
        };
        const clickConfirmSearchButton = (root, kind) => {
          for (const area of confirmSearchAreas(root)) {
            for (const btn of Array.from(area.querySelectorAll('.cursor-button'))) {
              if (btn.closest('.usage-limit-policy-banner')) continue;
              const label = cleanLabel(btn.textContent || '');
              if (kind === 'continue' && (/^continue$/i.test(label) || btn.classList.contains('cursor-button-primary-clickable'))) {
                return clickEl(btn);
              }
              if (kind === 'cancel' && (/^cancel$/i.test(label) || btn.classList.contains('cursor-button-secondary-clickable'))) {
                return clickEl(btn);
              }
            }
          }
          return false;
        };
        const findConfirmSearchToggle = (root) => {
          for (const area of confirmSearchAreas(root)) {
            const el = area.querySelector('.cursor-setting-value-checkbox[role="checkbox"]')
              || area.querySelector('.cursor-setting-value-checkbox');
            if (el) return el;
          }
          return null;
        };
        const tryConfirmSearchClick = (kind) => {
          const root = findActiveConfirmSearchRoot();
          if (!root) return false;
          if (kind === 'toggle') return clickEl(findConfirmSearchToggle(root));
          return clickConfirmSearchButton(root, kind);
        };
        if (path === CONFIRM_SEARCH_CONTINUE || path === CONFIRM_SEARCH_CANCEL || path === CONFIRM_SEARCH_TOGGLE) {
          if (path === CONFIRM_SEARCH_TOGGLE) return tryConfirmSearchClick('toggle');
          if (path === CONFIRM_SEARCH_CONTINUE) return tryConfirmSearchClick('continue');
          if (path === CONFIRM_SEARCH_CANCEL) return tryConfirmSearchClick('cancel');
        }
        const row = document.querySelector('.ui-shell-tool-call__approval-row');
        if (row) {
          if (stable.includes(path)) return clickEl(row.querySelector(path));
          if (path.includes('checkbox') || path.includes('switch')) {
            return clickEl(row.querySelector('input[type="checkbox"], [role="checkbox"], [role="switch"]'));
          }
          if (path.includes('#bubble') || path.includes('nth-of-type')) {
            return clickEl(row.querySelector(SHELL_RUN))
              || clickEl(row.querySelector(SHELL_SKIP))
              || clickEl(row.querySelector(SHELL_ALLOW));
          }
        }
        if (stable.includes(path)) {
          const hit = clickEl(document.querySelector(path));
          if (hit) return true;
          if (path === SHELL_RUN) return tryConfirmSearchClick('continue');
          if (path === SHELL_SKIP) return tryConfirmSearchClick('cancel');
          return false;
        }
        if (path.includes('checkbox') || path.includes('switch')) {
          return clickEl(document.querySelector('.ui-shell-tool-call__approval-row input[type="checkbox"], .ui-shell-tool-call__approval-row [role="checkbox"], .ui-shell-tool-call__approval-row [role="switch"]'))
            || tryConfirmSearchClick('toggle');
        }
        if (path.startsWith('confirm-search:')) {
          if (path === CONFIRM_SEARCH_TOGGLE) return tryConfirmSearchClick('toggle');
          if (path === CONFIRM_SEARCH_CONTINUE) return tryConfirmSearchClick('continue');
          if (path === CONFIRM_SEARCH_CANCEL) return tryConfirmSearchClick('cancel');
        }
        return clickEl(document.querySelector(path));
      })()
    `)) as boolean;
  }

  async extractToolContent(toolCallId: string): Promise<{ code: string; language?: string; filename?: string } | null> {
    if (!this.client || !this.client.isConnected()) return null;

    const result = await this.client.evaluate(`
      (() => {
        const tcId = ${JSON.stringify(toolCallId)};
        const wrapper = document.querySelector('[data-tool-call-id="' + tcId + '"]')
          || document.querySelector('[data-tool-call-id="' + tcId + '"]')?.closest(${MSG_IDX})
          || (() => {
            for (const el of document.querySelectorAll(${MSG_IDX})) {
              const inner = el.querySelector('[data-tool-call-id="' + tcId + '"]');
              if (inner) return el;
            }
            return null;
          })();
        if (!wrapper) return null;

        const wasCollapsed = !!wrapper.querySelector('.composer-tool-former-message');
        if (wasCollapsed) {
          const header = wrapper.querySelector('.composer-tool-former-message') || wrapper.querySelector('.ui-collapsible-header');
          if (header) header.click();
        }

        function extract() {
          // Edit tool: code in diff viewer
          const codeContent = wrapper.querySelector('.ui-default-code__content');
          if (codeContent) {
            const lines = codeContent.querySelectorAll('.ui-default-code__line-content');
            const code = lines.length > 0
              ? Array.from(lines).map(l => l.textContent || '').join('\\n')
              : (codeContent.textContent || '').trim();

            const headerEl = wrapper.querySelector('.ui-code-block-header');
            const language = headerEl?.getAttribute('data-language') || undefined;
            const filenameEl = wrapper.querySelector('.ui-edit-tool-call__filename')
              || wrapper.querySelector('.ui-code-block-filename');
            const filename = filenameEl ? (filenameEl.textContent || '').trim() : undefined;
            return { code, language, filename };
          }

          // Shell tool output
          const shellOutput = wrapper.querySelector('.composer-terminal-output') || wrapper.querySelector('.xterm-rows');
          if (shellOutput) {
            return { code: (shellOutput.textContent || '').trim(), language: 'bash', filename: undefined };
          }

          // Expanded content (generic)
          const preEl = wrapper.querySelector('pre');
          if (preEl) {
            return { code: (preEl.textContent || '').trim(), language: undefined, filename: undefined };
          }

          // Fallback to full text
          const text = (wrapper.textContent || '').trim();
          if (text.length > 0) return { code: text, language: undefined, filename: undefined };
          return null;
        }

        if (wasCollapsed) {
          return '__NEED_WAIT__';
        }
        return extract();
      })()
    `) as { code: string; language?: string; filename?: string } | '__NEED_WAIT__' | null;

    if (result === '__NEED_WAIT__') {
      await sleep(600);
      const expanded = await this.client.evaluate(`
        (() => {
          const tcId = ${JSON.stringify(toolCallId)};
          const wrapper = document.querySelector('[data-tool-call-id="' + tcId + '"]')
            || (() => {
              for (const el of document.querySelectorAll(${MSG_IDX})) {
                const inner = el.querySelector('[data-tool-call-id="' + tcId + '"]');
                if (inner) return el;
              }
              return null;
            })();
          if (!wrapper) return null;

          const codeContent = wrapper.querySelector('.ui-default-code__content');
          if (codeContent) {
            const lines = codeContent.querySelectorAll('.ui-default-code__line-content');
            const code = lines.length > 0
              ? Array.from(lines).map(l => l.textContent || '').join('\\n')
              : (codeContent.textContent || '').trim();
            const headerEl = wrapper.querySelector('.ui-code-block-header');
            const language = headerEl?.getAttribute('data-language') || undefined;
            const filenameEl = wrapper.querySelector('.ui-edit-tool-call__filename')
              || wrapper.querySelector('.ui-code-block-filename');
            const filename = filenameEl ? (filenameEl.textContent || '').trim() : undefined;
            return { code, language, filename };
          }

          const shellOutput = wrapper.querySelector('.composer-terminal-output') || wrapper.querySelector('.xterm-rows');
          if (shellOutput) {
            return { code: (shellOutput.textContent || '').trim(), language: 'bash', filename: undefined };
          }

          const preEl = wrapper.querySelector('pre');
          if (preEl) return { code: (preEl.textContent || '').trim(), language: undefined, filename: undefined };

          const text = (wrapper.textContent || '').trim();
          if (text.length > 0) return { code: text, language: undefined, filename: undefined };
          return null;
        })()
      `) as { code: string; language?: string; filename?: string } | null;

      // Collapse again
      await this.client.evaluate(`
        (() => {
          const tcId = ${JSON.stringify(toolCallId)};
          const wrapper = document.querySelector('[data-tool-call-id="' + tcId + '"]')
            || (() => {
              for (const el of document.querySelectorAll(${MSG_IDX})) {
                const inner = el.querySelector('[data-tool-call-id="' + tcId + '"]');
                if (inner) return el;
              }
              return null;
            })();
          if (!wrapper) return;
          const header = wrapper.querySelector('.ui-collapsible-header') || wrapper.querySelector('.composer-tool-former-message');
          if (header) header.click();
        })()
      `);

      return expanded;
    }

    return result;
  }

  async setModel(commandId: string, modelId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      await this.openModelMenu(client);

      // Find and click model via shared helper —
      // setModel, setPlanModel, web client and Telegram resolve the same way.
      const selected = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          ${MODEL_ITEM_HELPERS_JS}
          return pickModelById(findModelMenu(), ${JSON.stringify(modelId)});
        })()
      `) as boolean;
      if (!selected) throw new Error(`Model "${modelId}" not found in dropdown`);

      await sleep(200);

      // Step 4: verify dropdown closed (selection confirmed)
      const menuStillOpen = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          return findModelMenu() !== null;
        })()
      `) as boolean;
      if (menuStillOpen) {
        logWarn('COMMAND_WARN', 'Model dropdown still open — pressing Escape', commandCtx(commandId));
        await client.pressKey('Escape', 'Escape', 27);
        await sleep(100);
      }

      logCommandOk(`model=${modelId} menuClosed=${!menuStillOpen}`, commandCtx(commandId, { hint: modelId }));
    });
  }

  async getModelOptions(commandId: string): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      return await this.openModelMenuAndReadOptions(client);
    });
    if (!result.ok) return result;
    return { commandId, ok: true, data: result.data };
  }

  async getPlanModelOptions(commandId: string, selectorPath: string): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      return await this.openPlanModelMenuAndReadOptions(client, selectorPath);
    });
    if (!result.ok) return result;
    return { commandId, ok: true, data: result.data };
  }

  async setPlanModel(commandId: string, selectorPath: string, planModelId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      await this.openPlanModelMenu(client, selectorPath);
      const selected = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          ${MODEL_ITEM_HELPERS_JS}
          return pickModelById(findModelMenu(), ${JSON.stringify(planModelId)});
        })()
      `) as boolean;
      if (!selected) throw new Error(`Plan model "${planModelId}" not found`);

      await sleep(200);
      const menuStillOpen = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          return findModelMenu() !== null;
        })()
      `) as boolean;
      if (menuStillOpen) {
        await client.pressKey('Escape', 'Escape', 27);
        await sleep(100);
      }
      logCommandOk(`planModel=${planModelId}`, commandCtx(commandId, { hint: planModelId }));
    });
  }

  private async withRetryOnce(
    commandId: string,
    action: (client: CdpClient) => Promise<void>,
  ): Promise<CommandResult> {
    if (!this.client || !this.client.isConnected()) {
      return { commandId, ok: false, error: 'Not connected to Cursor' };
    }
    try {
      await action(this.client);
      return { commandId, ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError('COMMAND_FAIL', `Failed (no retry): ${msg}`, commandCtx(commandId));
      return { commandId, ok: false, error: msg };
    }
  }

  private async withRetry(
    commandId: string,
    action: (client: CdpClient) => Promise<void>
  ): Promise<CommandResult> {
    if (!this.client || !this.client.isConnected()) {
      return { commandId, ok: false, error: 'Not connected to Cursor' };
    }

    let lastError: string | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await action(this.client);
        return { commandId, ok: true };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logWarn(
          'COMMAND_WARN',
          `Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${lastError}`,
          commandCtx(commandId, { attempt: attempt + 1 }),
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    return { commandId, ok: false, error: lastError };
  }

  private async withRetryValue<T>(
    commandId: string,
    action: (client: CdpClient) => Promise<T>
  ): Promise<CommandResult & { data?: T }> {
    if (!this.client || !this.client.isConnected()) {
      return { commandId, ok: false, error: 'Not connected to Cursor' };
    }

    let lastError: string | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await action(this.client);
        return { commandId, ok: true, data };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logWarn(
          'COMMAND_WARN',
          `Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${lastError}`,
          commandCtx(commandId, { attempt: attempt + 1 }),
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    return { commandId, ok: false, error: lastError };
  }

  private async openModeMenu(client: CdpClient): Promise<void> {
    const strategies = this.selectors.modeDropdown?.strategies ?? [];
    const opened = await client.evaluate(`
      (() => {
        const strategies = ${JSON.stringify(strategies)};
        for (const sel of strategies) {
          try {
            const el = document.querySelector(sel);
            if (el) { el.click(); return true; }
          } catch {}
        }
        return false;
      })()
    `) as boolean;
    if (!opened) throw new Error('Mode dropdown not found');
    await sleep(300);
  }

  private async openModeMenuAndReadOptions(client: CdpClient): Promise<{ options: ModeOption[] }> {
    await this.openModeMenu(client);
    const options = await client.evaluate(`
      (() => {
        ${MODE_ITEM_HELPERS_JS}
        return collectModeItems();
      })()
    `) as ModeOption[];
    await client.pressKey('Escape', 'Escape', 27);
    await sleep(100);
    return { options };
  }

  private async closeModelMenuIfOpen(client: CdpClient): Promise<void> {
    const open = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        return findModelMenu() !== null;
      })()
    `) as boolean;
    if (open) {
      await client.pressKey('Escape', 'Escape', 27);
      await sleep(150);
    }
  }

  private async closeModelMenus(client: CdpClient): Promise<void> {
    for (let i = 0; i < 4; i++) {
      const open = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          ${MODEL_OPTIONS_HELPERS_JS}
          const menu = findModelMenu();
          const panel = findModelOptionsPanel(menu);
          return menu !== null || panel !== null;
        })()
      `) as boolean;
      if (!open) return;
      await client.pressKey('Escape', 'Escape', 27);
      await sleep(120);
    }
  }

  private async openModelMenu(client: CdpClient): Promise<void> {
    await this.closeModelMenuIfOpen(client);
    const strategies = this.selectors.modelDropdown?.strategies ?? [];
    const opened = await client.evaluate(`
      (() => {
        const strategies = ${JSON.stringify(strategies)};
        for (const sel of strategies) {
          try {
            const candidates = document.querySelectorAll(sel);
            for (const c of Array.from(candidates)) {
              const cId = c.getAttribute('id') || '';
              if (cId.startsWith('plan-exec-model')) continue;
              if (c.getAttribute('aria-expanded') === 'true') return true;
              c.scrollIntoView({ block: 'center', behavior: 'instant' });
              c.click();
              return true;
            }
          } catch {}
        }
        return false;
      })()
    `) as boolean;
    if (!opened) throw new Error('Model dropdown trigger not found');

    for (let i = 0; i < 10; i++) {
      await sleep(100);
      const menuVisible = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          return findModelMenu() !== null;
        })()
      `) as boolean;
      if (menuVisible) return;
    }
    throw new Error('Model picker did not open');
  }

  private async openPlanModelMenu(client: CdpClient, selectorPath: string): Promise<void> {
    const opened = await client.evaluate(`
      (() => {
        const selector = ${JSON.stringify(selectorPath)};
        const el = document.querySelector(selector);
        if (!el) return false;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.click();
        return true;
      })()
    `) as boolean;
    if (!opened) throw new Error('Plan model dropdown trigger not found');

    await sleep(300);
    const menuVisible = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        return findModelMenu() !== null;
      })()
    `) as boolean;
    if (!menuVisible) throw new Error('Plan model picker did not open');
  }

  private async openPlanModelMenuAndReadOptions(
    client: CdpClient,
    selectorPath: string
  ): Promise<{ options: PlanModelOption[] }> {
    await this.openPlanModelMenu(client, selectorPath);

    const options = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        ${MODEL_ITEM_HELPERS_JS}
        return collectModelItems(findModelMenu());
      })()
    `) as PlanModelOption[];

    await client.pressKey('Escape', 'Escape', 27);
    await sleep(100);
    return { options };
  }

  private async openModelMenuAndReadOptions(
    client: CdpClient
  ): Promise<ModelOptionsSnapshot> {
    await this.openModelMenu(client);

    const snapshot = await client.evaluate(`
      (() => {
        ${MODEL_SNAPSHOT_READ_JS}
        return readModelMenuSnapshot();
      })()
    `) as ModelOptionsSnapshot;

    await client.pressKey('Escape', 'Escape', 27);
    await sleep(100);
    return snapshot;
  }

  private async findFirstMatchingSelector(
    client: CdpClient,
    strategies: string[]
  ): Promise<string | null> {
    for (const selector of strategies) {
      try {
        if (await client.exists(selector)) return selector;
      } catch {
        // invalid selector — skip
      }
    }
    return null;
  }

  private async findApproveAllButton(client: CdpClient): Promise<string | null> {
    const found = await client.evaluate(`
      (() => {
        const keywords = ${JSON.stringify(this.selectors.approveButton.textMatch ?? [])};
        const strategies = ${JSON.stringify(this.selectors.approveButton.strategies)};
        const containerStrategies = ${JSON.stringify(this.selectors.chatContainer.strategies)};
        let root = null;
        for (const sel of containerStrategies) {
          try {
            root = document.querySelector(sel);
            if (root) break;
          } catch {}
        }
        if (!root) root = document.body;

        // Skip menu trigger (e.g. Cursor "Auto-Run in Sandbox") —
        // opens settings menu, not approval.
        const isMenuTrigger = (b) => {
          const p = b.getAttribute('aria-haspopup');
          return p === 'menu' || p === 'true' || p === 'listbox';
        };

        for (const selector of strategies) {
          try {
            const buttons = root.querySelectorAll(selector);
            for (const btn of Array.from(buttons)) {
              if (isMenuTrigger(btn)) continue;
              const text = (btn.textContent || '').trim().toLowerCase();
              if (text.includes('all')) {
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                return true;
              }
            }
          } catch {}
        }

        const allButtons = root.querySelectorAll('button');
        for (const btn of Array.from(allButtons)) {
          if (isMenuTrigger(btn)) continue;
          const text = (btn.textContent || '').trim().toLowerCase();
          for (const kw of keywords) {
            if (kw.toLowerCase().includes('all') && text.includes(kw.toLowerCase())) {
              btn.scrollIntoView({ block: 'center' });
              btn.click();
              return true;
            }
          }
        }

        return false;
      })()
    `) as boolean;

    if (!found) {
      throw new Error('"Accept All" button not found');
    }
    return '__clicked_inline__';
  }

  private async clickElementCenter(client: CdpClient, selector: string): Promise<void> {
    const rect = await client.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
      })()
    `) as { x: number; y: number; width: number; height: number } | null;

    if (!rect || rect.width === 0 || rect.height === 0) {
      throw new Error(`Element not clickable: ${selector}`);
    }

    await client.clickAtCoords(rect.x, rect.y);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
