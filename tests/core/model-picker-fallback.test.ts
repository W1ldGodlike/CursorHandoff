import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'node:vm';
import { MODEL_MENU_LOOKUP_JS, MODEL_ITEM_COLLECTOR_JS, MODEL_SNAPSHOT_READ_JS } from '../../src/ide/actions/navigation.js';

// MODEL_MENU_LOOKUP_JS snippet is injected via evaluate() inside the Cursor
// renderer browser context. We do not launch a real browser here, but we can
// build a minimal mock `document` with `querySelector`, `querySelectorAll`, and
// `getElementById` and exercise each fallback branch.

interface MockElement {
  tagName?: string;
  attrs: Record<string, string>;
  id?: string;
  hidden?: boolean;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { width: number; height: number };
}

function makeEl(attrs: Record<string, string>, id?: string, opts: { hidden?: boolean; rect?: { w: number; h: number } } = {}): MockElement {
  return {
    attrs,
    id,
    hidden: opts.hidden,
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    },
    getBoundingClientRect() {
      return { width: opts.rect?.w ?? 200, height: opts.rect?.h ?? 100 };
    },
  };
}

interface MockDoc {
  byId: Map<string, MockElement>;
  bySelector: Map<string, MockElement[]>;
}

function makeDocument(doc: MockDoc) {
  return {
    querySelector(sel: string): MockElement | null {
      const matches = doc.bySelector.get(sel) ?? [];
      return matches[0] ?? null;
    },
    querySelectorAll(sel: string): MockElement[] {
      return doc.bySelector.get(sel) ?? [];
    },
    getElementById(id: string): MockElement | null {
      return doc.byId.get(id) ?? null;
    },
  };
}

function runLookup(doc: MockDoc): MockElement | null {
  // Wrap snippet in IIFE returning findModelMenu result.
  const code = `(() => { ${MODEL_MENU_LOOKUP_JS} return findModelMenu(); })()`;
  const sandbox = { document: makeDocument(doc), Array };
  return vm.runInNewContext(code, sandbox) as MockElement | null;
}

describe('MODEL_MENU_LOOKUP_JS', () => {
  it('prefers data-testid="model-picker-menu" when present (legacy Cursor)', () => {
    const legacyMenu = makeEl({}, 'legacy');
    const newMenu = makeEl({ 'data-state': 'open', role: 'menu' }, 'aria');
    const result = runLookup({
      byId: new Map([['aria', newMenu]]),
      bySelector: new Map<string, MockElement[]>([
        ['[data-testid="model-picker-menu"]', [legacyMenu]],
        ['[role="menu"][data-state="open"]', [newMenu]],
      ]),
    });
    assert.equal(result, legacyMenu);
  });

  it('falls back to aria-controls when testid is missing (new Cursor)', () => {
    const targetMenu = makeEl({ role: 'menu' }, 'menu-id-42');
    const openTrigger = makeEl({ 'aria-expanded': 'true', 'aria-controls': 'menu-id-42' });
    const result = runLookup({
      byId: new Map([['menu-id-42', targetMenu]]),
      bySelector: new Map<string, MockElement[]>([
        ['[data-testid="model-picker-menu"]', []],
        [
          '.ui-model-picker__trigger[aria-expanded="true"],.composer-unified-dropdown-model[aria-expanded="true"],.composer-unified-dropdown[aria-expanded="true"]',
          [openTrigger],
        ],
        ['[role="menu"][data-state="open"]', []],
        ['[role="menu"]:not([hidden])', []],
      ]),
    });
    assert.equal(result, targetMenu);
  });

  it('falls back to [role="menu"][data-state="open"] when no trigger is open', () => {
    const openMenu = makeEl({ role: 'menu', 'data-state': 'open' });
    const result = runLookup({
      byId: new Map(),
      bySelector: new Map<string, MockElement[]>([
        ['[data-testid="model-picker-menu"]', []],
        [
          '.ui-model-picker__trigger[aria-expanded="true"],.composer-unified-dropdown-model[aria-expanded="true"],.composer-unified-dropdown[aria-expanded="true"]',
          [],
        ],
        ['[role="menu"][data-state="open"]', [openMenu]],
      ]),
    });
    assert.equal(result, openMenu);
  });

  it('falls back to first visible [role="menu"] as last resort', () => {
    const visibleMenu = makeEl({ role: 'menu' });
    const result = runLookup({
      byId: new Map(),
      bySelector: new Map<string, MockElement[]>([
        ['[data-testid="model-picker-menu"]', []],
        [
          '.ui-model-picker__trigger[aria-expanded="true"],.composer-unified-dropdown-model[aria-expanded="true"],.composer-unified-dropdown[aria-expanded="true"]',
          [],
        ],
        ['[role="menu"][data-state="open"]', []],
        ['[role="menu"]:not([hidden])', [visibleMenu]],
      ]),
    });
    assert.equal(result, visibleMenu);
  });

  it('returns null when nothing matches', () => {
    const result = runLookup({
      byId: new Map(),
      bySelector: new Map(),
    });
    assert.equal(result, null);
  });
});

describe('MODEL_ITEM_COLLECTOR_JS', () => {
  // Helpers run in Cursor renderer. Here via minimal DOM shim without deps:
  // Edit-button row filter, React-useId fallback, and collectModelItems ↔
  // pickModelById round-trip match expected behavior.
  type El = {
    tagName: string;
    id: string;
    attrs: Record<string, string>;
    children: El[];
    parent: El | null;
    clicks: { count: number };
    cloneNode(deep: boolean): El;
    querySelector(sel: string): El | null;
    querySelectorAll(sel: string): El[];
    getAttribute(name: string): string | null;
    contains(other: El): boolean;
    remove(): void;
    click(): void;
    get textContent(): string;
    get className(): string;
  };
  const matches = (el: El, sel: string): boolean => {
    if (sel === 'button') return el.tagName === 'BUTTON';
    if (sel === '[id]') return !!el.id;
    if (sel === '[data-testid]') return el.attrs['data-testid'] !== undefined;
    const m = sel.match(/^\[([a-z-]+)="([^"]+)"\]$/);
    if (m) return el.attrs[m[1]] === m[2];
    const m2 = sel.match(/^\[role="([^"]+)"\]$/);
    if (m2) return el.attrs.role === m2[1];
    if (sel.startsWith('.')) return el.className.split(/\s+/).includes(sel.slice(1));
    return false;
  };
  const matchInTree = (root: El, sel: string): El[] => {
    const parts = sel.split(',').map(s => s.trim());
    const out: El[] = [];
    const walk = (el: El) => {
      for (const part of parts) {
        if (matches(el, part)) { out.push(el); break; }
      }
      for (const c of el.children) walk(c);
    };
    for (const c of root.children) walk(c);
    return out;
  };
  const makeEl = (tagName: string, opts: { id?: string; attrs?: Record<string, string>; text?: string; children?: El[] } = {}): El => {
    const clicks = { count: 0 };
    const el: El = {
      tagName: tagName.toUpperCase(),
      id: opts.id ?? '',
      attrs: opts.attrs ?? {},
      children: [],
      parent: null,
      clicks,
      cloneNode(deep: boolean) {
        const c = makeEl(this.tagName, { id: this.id, attrs: { ...this.attrs } });
        if (this.attrs.__text) c.attrs.__text = this.attrs.__text;
        if (deep) for (const ch of this.children) {
          const cc = ch.cloneNode(true);
          cc.parent = c;
          c.children.push(cc);
        }
        return c;
      },
      querySelector(sel: string) { return matchInTree(this, sel)[0] ?? null; },
      querySelectorAll(sel: string) { return matchInTree(this, sel); },
      getAttribute(name: string) { return this.attrs[name] ?? null; },
      contains(other: El) {
        let p: El | null = other.parent;
        while (p) { if (p === this) return true; p = p.parent; }
        return false;
      },
      remove() {
        if (!this.parent) return;
        this.parent.children = this.parent.children.filter(c => c !== this);
        this.parent = null;
      },
      click() { clicks.count++; },
      get textContent() {
        if (this.attrs.__text) return this.attrs.__text;
        return this.children.map(c => c.textContent).join('');
      },
      get className() { return this.attrs.class ?? ''; },
    };
    if (opts.text) el.attrs.__text = opts.text;
    for (const ch of opts.children ?? []) {
      ch.parent = el;
      el.children.push(ch);
    }
    return el;
  };
  const collectAll = (root: El): El[] => {
    const all: El[] = [];
    const walk = (el: El) => { all.push(el); for (const c of el.children) walk(c); };
    walk(root);
    return all;
  };
  const setupSandbox = (html: string) => {
    const root = parseHtml(html, makeEl);
    const allEls = collectAll(root);
    const fakeDoc = {
      querySelector: (sel: string) => {
        const found = matchInTree(root, sel);
        return found[0] ?? (sel === '[role="menu"]' && root.attrs.role === 'menu' ? root : null);
      },
      getElementById: (id: string) => allEls.find(e => e.id === id) ?? null,
    };
    return { root, fakeDoc, allEls };
  };
  const runCollect = (html: string): Array<{ id: string; label: string; selected: boolean }> => {
    const { fakeDoc } = setupSandbox(html);
    const code = `${MODEL_ITEM_COLLECTOR_JS}\ncollectModelItems(document.querySelector('[role="menu"]'));`;
    return vm.runInNewContext(code, { document: fakeDoc, Array }) as Array<{ id: string; label: string; selected: boolean }>;
  };
  const run = runCollect; // back-compat for tests below
  const runPick = (html: string, targetId: string): boolean => {
    const { fakeDoc } = setupSandbox(html);
    const code = `${MODEL_ITEM_COLLECTOR_JS}\npickModelById(document.querySelector('[role="menu"]'), ${JSON.stringify(targetId)});`;
    return vm.runInNewContext(code, { document: fakeDoc, Array }) as boolean;
  };

  function parseHtml(src: string, mk: typeof makeEl): El {
      // Minimal recursive-descent parser: tags from fixtures below only.
      // Otherwise throw — test catches a broken fixture.
      const compact = src.replace(/>\s+</g, '><').trim();
      let i = 0;
      const parseNode = (): El => {
        while (i < compact.length && /\s/.test(compact[i])) i++;
        if (compact[i] !== '<') throw new Error('expected < at ' + i + ' got ' + JSON.stringify(compact.slice(i, i + 20)));
        i++;
        let tag = '';
        while (i < compact.length && /[a-z0-9]/i.test(compact[i])) { tag += compact[i++]; }
        const attrs: Record<string, string> = {};
        while (compact[i] === ' ') {
          i++;
          let name = '';
          while (i < compact.length && /[a-z0-9-]/i.test(compact[i])) { name += compact[i++]; }
          if (compact[i] === '=') {
            i++;
            const q = compact[i++];
            let val = '';
            while (i < compact.length && compact[i] !== q) val += compact[i++];
            i++;
            attrs[name] = val;
          } else attrs[name] = '';
        }
        if (compact[i] === '>') i++; else throw new Error('expected >');
        const id = attrs.id ?? '';
        const el = mk(tag, { id, attrs });
        // children: parse until </tag>
        while (i < compact.length) {
          if (compact[i] === '<' && compact[i + 1] === '/') {
            i += 2;
            while (i < compact.length && compact[i] !== '>') i++;
            i++;
            break;
          }
          if (compact[i] === '<') {
            const child = parseNode();
            child.parent = el;
            el.children.push(child);
          } else {
            let txt = '';
            while (i < compact.length && compact[i] !== '<') txt += compact[i++];
            if (txt.trim()) {
              const t = mk('span', { text: txt });
              t.parent = el;
              el.children.push(t);
            }
          }
        }
        return el;
      };
      return parseNode();
    }

  it('skips Auto and MAX Mode control rows', () => {
    const opts = run(`
      <div role="menu">
        <div id="auto-row" role="menuitem">AutoBalanced quality and speed, recommended for most tasks</div>
        <div id="max-row" role="menuitem">MAX Mode</div>
        <div id="opus-row" role="menuitem"><span>Opus 4.7</span></div>
      </div>
    `);
    assert.equal(opts.length, 1);
    assert.equal(opts[0].label, 'Opus 4.7');
  });

  it('drops per-row Edit buttons and unstable React IDs', () => {
    const opts = run(`
      <div role="menu">
        <div id="opus-row" role="menuitem"><span>Opus 4.7 Extra High</span><button id="_r_ld_">Edit</button></div>
        <div id="gemini-row" role="menuitem"><span>Gemini 3.1 Pro</span><button id="_r_qm_">Edit</button></div>
      </div>
    `);
    // JSON round-trip normalizes array prototype from vm context.
    const labels = JSON.parse(JSON.stringify(opts.map(o => o.label).sort())) as string[];
    assert.deepEqual(labels, ['Gemini 3.1 Pro', 'Opus 4.7 Extra High']);
    assert.equal(opts.length, 2, 'Edit buttons should not appear as separate models');
    assert.ok(opts.every(o => !o.id.startsWith('_r_')), 'React useId IDs must not be returned');
    assert.ok(opts.every(o => o.hasEdit === true), 'rows with Edit button should set hasEdit');
  });

  it('uses a synthetic label:: id when the row has no stable id', () => {
    const opts = run(`
      <div role="menu">
        <div role="menuitem"><span>Sonnet 4.6</span></div>
      </div>
    `);
    assert.equal(opts.length, 1);
    assert.equal(opts[0].id, 'label::Sonnet 4.6');
    assert.equal(opts[0].label, 'Sonnet 4.6');
  });

  it('keeps stable non-React ids', () => {
    const opts = run(`
      <div role="menu">
        <div id="model-opus" role="menuitem"><span>Opus 4.7</span></div>
      </div>
    `);
    assert.equal(opts[0].id, 'model-opus');
  });

  // Round-trip: collector id must resolve to the same row in pickModelById.
  // Guards read side vs click side drift.
  it('id returned by collector resolves back to the same row via pickModelById', () => {
    const fixtureHtml = `
      <div role="menu">
        <div id="opus-row" role="menuitem"><span>Opus 4.7 Extra High</span><button id="_r_ld_">Edit</button></div>
        <div role="menuitem"><span>Sonnet 4.6</span><button id="_r_qm_">Edit</button></div>
        <div id="_r_xx_" role="menuitem"><span>GPT-5.5 High</span></div>
      </div>
    `;
    const opts = run(fixtureHtml);
    // Three extracted rows (Edit not counted as a model).
    assert.equal(opts.length, 3, 'expected exactly 3 model rows');
    for (const opt of opts) {
      const clicked = runPick(fixtureHtml, opt.id);
      assert.equal(clicked, true, `pickModelById should resolve "${opt.id}" → "${opt.label}"`);
    }
    // Sanity: unknown id must not resolve.
    assert.equal(runPick(fixtureHtml, 'label::Not A Model'), false);
  });
});

describe('MODEL_SNAPSHOT_READ_JS auto detection', () => {
  type El = {
    tagName: string;
    id: string;
    attrs: Record<string, string>;
    children: El[];
    parent: El | null;
    getAttribute(name: string): string | null;
    getBoundingClientRect(): { width: number; height: number };
    querySelector(sel: string): El | null;
    querySelectorAll(sel: string): El[];
    contains(other: El): boolean;
    get textContent(): string;
    get className(): string;
  };
  const matches = (el: El, sel: string): boolean => {
    if (sel === 'button') return el.tagName === 'BUTTON';
    if (sel === '[id]') return !!el.id;
    const m = sel.match(/^\[role="([^"]+)"\]$/);
    if (m) return el.attrs.role === m[1];
    return false;
  };
  const matchInTree = (root: El, sel: string): El[] => {
    const out: El[] = [];
    const walk = (el: El) => {
      if (matches(el, sel)) out.push(el);
      for (const c of el.children) walk(c);
    };
    for (const c of root.children) walk(c);
    if (matches(root, sel)) out.unshift(root);
    return out;
  };
  const makeEl = (tagName: string, opts: { id?: string; attrs?: Record<string, string>; text?: string; children?: El[] } = {}): El => {
    const el: El = {
      tagName: tagName.toUpperCase(),
      id: opts.id ?? '',
      attrs: opts.attrs ?? {},
      children: [],
      parent: null,
      getAttribute(name: string) { return this.attrs[name] ?? null; },
      getBoundingClientRect() { return { width: 200, height: 40 }; },
      querySelector(sel: string) { return matchInTree(this, sel)[0] ?? null; },
      querySelectorAll(sel: string) { return matchInTree(this, sel); },
      contains(other: El) {
        let p: El | null = other.parent;
        while (p) { if (p === this) return true; p = p.parent; }
        return false;
      },
      get textContent() {
        if (opts.text) return opts.text;
        return this.children.map(c => c.textContent).join('');
      },
      get className() { return this.attrs.class ?? ''; },
    };
    for (const ch of opts.children ?? []) {
      ch.parent = el;
      el.children.push(ch);
    }
    return el;
  };
  const runSnapshot = (html: string) => {
    const compact = html.replace(/>\s+</g, '><').trim();
    let i = 0;
    const parseNode = (): El => {
      i++;
      while (i < compact.length && compact[i] !== '<') i++;
      i++;
      let tag = '';
      while (i < compact.length && /[a-z0-9]/i.test(compact[i])) tag += compact[i++];
      const attrs: Record<string, string> = {};
      while (compact[i] === ' ') {
        i++;
        let name = '';
        while (i < compact.length && /[a-z0-9-]/i.test(compact[i])) name += compact[i++];
        if (compact[i] === '=') {
          i++;
          const q = compact[i++];
          let val = '';
          while (i < compact.length && compact[i] !== q) val += compact[i++];
          i++;
          attrs[name] = val;
        }
      }
      if (compact[i] === '>') i++;
      const el = makeEl(tag, { id: attrs.id ?? '', attrs });
      while (i < compact.length) {
        if (compact[i] === '<' && compact[i + 1] === '/') {
          i = compact.indexOf('>', i) + 1;
          break;
        }
        if (compact[i] === '<') {
          const child = parseNode();
          child.parent = el;
          el.children.push(child);
        } else {
          let txt = '';
          while (i < compact.length && compact[i] !== '<') txt += compact[i++];
          if (txt.trim()) {
            const t = makeEl('span', { text: txt });
            t.parent = el;
            el.children.push(t);
          }
        }
      }
      return el;
    };
    const root = parseNode();
    const fakeDoc = {
      querySelector: (sel: string) => matchInTree(root, sel)[0] ?? (root.attrs.role === 'menu' ? root : null),
      querySelectorAll: (sel: string) => matchInTree(root, sel),
      getElementById: (id: string) => {
        const all: El[] = [];
        const walk = (el: El) => { all.push(el); for (const c of el.children) walk(c); };
        walk(root);
        return all.find(e => e.id === id) ?? null;
      },
    };
    const code = `${MODEL_MENU_LOOKUP_JS}\n${MODEL_ITEM_COLLECTOR_JS}\n${MODEL_SNAPSHOT_READ_JS}\nreadModelMenuSnapshot();`;
    return vm.runInNewContext(code, { document: fakeDoc, Array }) as { autoOn: boolean; options: unknown[] };
  };

  it('treats hidden model list as Auto on when switch reads off', () => {
    const snap = runSnapshot(`
      <div role="menu" data-state="open">
        <div id="auto-row" role="menuitem">AutoBalanced quality and speed
          <button role="switch" aria-checked="false" data-state="unchecked"></button>
        </div>
      </div>
    `);
    assert.equal(snap.autoOn, true);
    assert.equal(snap.options.length, 0);
  });

  it('reads Auto on from switch aria-checked', () => {
    const snap = runSnapshot(`
      <div role="menu" data-state="open">
        <div id="auto-row" role="menuitem">Auto picks for you
          <button role="switch" aria-checked="true" data-state="checked"></button>
        </div>
      </div>
    `);
    assert.equal(snap.autoOn, true);
  });
});

describe('selectors.json modelDropdown', () => {
  it('lists both the new and the legacy trigger selectors', () => {
    const raw = readFileSync(resolve('selectors.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { modelDropdown?: { strategies?: string[] } };
    const strategies = parsed.modelDropdown?.strategies ?? [];
    assert.ok(strategies.includes('.ui-model-picker__trigger'), 'new selector missing');
    assert.ok(strategies.includes('.composer-unified-dropdown-model'), 'legacy fallback missing');
    assert.equal(strategies[0], '.ui-model-picker__trigger', 'new selector should be tried first');
  });
});
