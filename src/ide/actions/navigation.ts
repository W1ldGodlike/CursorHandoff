import type { CdpClient } from '../cdp-client.js';
import type { SelectorConfig, CommandResult, PlanModelOption } from '../../core/types.js';
import { setClipboardImage } from '../../media/clipboard-win.js';
import { MESSAGE_WRAPPER_SELECTOR } from '../message-index.js';

const MSG_IDX = JSON.stringify(MESSAGE_WRAPPER_SELECTOR);

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;
const FOCUS_DELAY_MS = 100;

// Finds open model picker menu across Cursor versions.
// Old builds: `[data-testid="model-picker-menu"]`; new (~3.5.17)
// dropped testid and render picker as generic `[role="menu"]` via
// `.ui-model-picker__trigger` — cascade of lookups.
// Stable across picker renders — React 19 useId (`_r_ld_`, `_r_qm_`, …)
// changes every mount, poor round-trip as model id. Treat matching pattern
// as no-id and fallback to synthetic `label::<text>`.
const REACT_USE_ID_RE = /^_r_[a-z0-9]+_$/;

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
      });
    }
    return out;
  };

  // Finds and clicks row by id (or synthetic label::id).
  // Target: real DOM id ("model-opus"), "label::<text>" (no stable id),
  // unstable React useId ("_r_ld_") or bare label. true on success.
  const pickModelById = (menu, targetId) => {
    if (!menu || !targetId) return false;
    const isLabelId = targetId.startsWith('label::');
    const isUnstable = REACT_USE_ID_RE.test(targetId);
    const labelTarget = (isLabelId ? targetId.slice(7) : '').trim().toLowerCase();
    const targetLc = targetId.toLowerCase();
    const fuzzy = (isLabelId || isUnstable) ? '' : targetLc.replace(/[-_]/g, ' ');

    if (!isLabelId && !isUnstable) {
      const byId = document.getElementById(targetId);
      if (byId && (byId === menu || menu.contains(byId))) {
        clickModelRow(byId);
        return true;
      }
    }

    const rows = modelRowsIn(menu);
    // Pass 1: exact match (preferred — "GPT-5" ≠ "GPT-5.5").
    for (const item of rows) {
      const label = labelOf(item);
      if (!label) continue;
      const labelLc = label.toLowerCase();
      const stableId = stableIdOf(item);
      if (isLabelId || isUnstable) {
        if (labelLc === labelTarget || labelLc === targetLc) {
          clickModelRow(item);
          return true;
        }
      } else {
        if (stableId === targetId || ('label::' + label) === targetId) {
          clickModelRow(item);
          return true;
        }
      }
    }
    // Pass 2: fuzzy/substring for label::-targets when live row has extra
    // text (badge "Premium", subtitle) beyond collectModelItems.
    // Length limit — "GPT-5" must not match "GPT-5.5".
    for (const item of rows) {
      const label = labelOf(item);
      if (!label) continue;
      const labelLc = label.toLowerCase();
      if (isLabelId || isUnstable) {
        if (labelTarget.length >= 4 && labelLc.includes(labelTarget)) {
          clickModelRow(item);
          return true;
        }
      } else if (fuzzy && labelLc.includes(fuzzy)) {
        clickModelRow(item);
        return true;
      }
    }
    return false;
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
    return null;
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

      console.log(`[command-executor] Focused: ${result.info}`);
      await sleep(FOCUS_DELAY_MS);

      // Step 2: clear text Ctrl+A, then Delete (CDP Input domain)
      await client.pressKey('a', 'KeyA', 65, 2); // 2 = Ctrl modifier
      await sleep(50);
      await client.pressKey('Backspace', 'Backspace', 8);
      await sleep(50);

      // Step 3: paste via CDP Input.insertText (native Chromium input pipeline)
      await client.typeText(text);
      console.log(`[command-executor] Text inserted via Input.insertText (${text.length} chars)`);
      await sleep(150);

      await this.pressSubmit(client, submit);
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
      console.log(`[command-executor] Force queue item: ${queueItemId.slice(0, 32)}`);
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
      await this.pressSubmit(client, submit);
    });
  }

  private async pressSubmit(client: CdpClient, submit: 'enter' | 'ctrlEnter'): Promise<void> {
    if (submit === 'ctrlEnter') {
      await client.pressKey('Enter', 'Enter', 13, 2);
      console.log('[command-executor] Ctrl+Enter pressed via CDP Input.dispatchKeyEvent');
    } else {
      await client.pressKey('Enter', 'Enter', 13);
      console.log('[command-executor] Enter pressed via CDP Input.dispatchKeyEvent');
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
      await client.click(selectorPath);
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
      console.log(`[command-executor] Scrolled chat up ${times} times`);
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
      console.log('[command-executor] Scrolled chat to bottom');
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
          console.log(`[command-executor] Tab active confirmed: ${tabTitle}`);
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
      console.log(`[command-executor] Questionnaire click: ${label}`);
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
      console.log(`[command-executor] Questionnaire freeform (${text.length} chars)`);
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
      console.log(`[command-executor] New chat: 1 click (${result.sel ?? '?'})`);
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
      console.log(`[command-executor] Closed chat tab: ${tabTitle ?? '(active)'}`);
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
      const strategies = this.selectors.modeDropdown?.strategies ?? [];

      // Click trigger dropdown to open menu
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

      await sleep(250);

      // Click mode item whose ID ends with modeId
      const selected = await client.evaluate(`
        (() => {
          const modeId = ${JSON.stringify(modeId)};
          const items = document.querySelectorAll('[id*="composer-mode-"][id$="-' + modeId + '"]');
          for (const item of Array.from(items)) {
            const clickable = item.querySelector('.composer-unified-context-menu-item') || item;
            clickable.click();
            return true;
          }
          return false;
        })()
      `) as boolean;
      if (!selected) throw new Error(`Mode "${modeId}" not found in dropdown`);
      console.log(`[command-executor] Mode set to: ${modeId}`);
    });
  }

  async clickAction(commandId: string, selectorPath: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      await client.click(selectorPath);
      console.log(`[command-executor] Clicked action: ${selectorPath.substring(0, 60)}`);
    });
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
      const strategies = this.selectors.modelDropdown?.strategies ?? [];

      // Step 1: open dropdown via JS .click() (like setMode).
      // Skip trigger with id `plan-exec-model*` (plan-execution picker,
      // not composer model picker) — same filter as openModelMenuAndReadOptions.
      const opened = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          for (const sel of strategies) {
            try {
              const candidates = document.querySelectorAll(sel);
              for (const c of Array.from(candidates)) {
                const cId = c.getAttribute('id') || '';
                if (cId.startsWith('plan-exec-model')) continue;
                c.click();
                return true;
              }
            } catch {}
          }
          return false;
        })()
      `) as boolean;
      if (!opened) throw new Error('Model dropdown trigger not found');

      await sleep(300);

      // Step 2: verify menu opened
      const menuVisible = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          return findModelMenu() !== null;
        })()
      `) as boolean;
      if (!menuVisible) throw new Error('Model picker did not open');

      // Step 3: find and click model via shared helper —
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
        console.warn(`[command-executor] Model dropdown still open — pressing Escape`);
        await client.pressKey('Escape', 'Escape', 27);
        await sleep(100);
      }

      console.log(`[command-executor] Model set to: ${modelId} (menu closed: ${!menuStillOpen})`);
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
      console.log(`[command-executor] Plan model set to: ${planModelId}`);
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
      console.warn(`[command-executor] Failed (no retry): ${msg}`);
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
        console.warn(
          `[command-executor] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${lastError}`
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
        console.warn(
          `[command-executor] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${lastError}`
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    return { commandId, ok: false, error: lastError };
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
  ): Promise<{ options: PlanModelOption[] }> {
    const strategies = this.selectors.modelDropdown?.strategies ?? [];

    const opened = await client.evaluate(`
      (() => {
        const strategies = ${JSON.stringify(strategies)};
        for (const sel of strategies) {
          try {
            const candidates = document.querySelectorAll(sel);
            for (const c of Array.from(candidates)) {
              const cId = c.getAttribute('id') || '';
              if (!cId.startsWith('plan-exec-model')) {
                c.click();
                return true;
              }
            }
          } catch {}
        }
        return false;
      })()
    `) as boolean;
    if (!opened) throw new Error('Model dropdown trigger not found');

    await sleep(300);

    const menuVisible = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        return findModelMenu() !== null;
      })()
    `) as boolean;
    if (!menuVisible) throw new Error('Model picker did not open');

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
