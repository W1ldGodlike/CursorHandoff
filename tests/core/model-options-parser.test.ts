import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { MODEL_ITEM_HELPERS_JS, MODEL_OPTIONS_HELPERS_JS } from '../../src/ide/actions/navigation.js';

const PARSER_JS = `${MODEL_ITEM_HELPERS_JS}\n${MODEL_OPTIONS_HELPERS_JS}`;

type El = {
  tagName: string;
  id: string;
  attrs: Record<string, string>;
  children: El[];
  parent: El | null;
  getAttribute(name: string): string | null;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): El[];
  contains(other: El): boolean;
  cloneNode(deep: boolean): El;
  get textContent(): string;
  get className(): string;
};

const matches = (el: El, sel: string): boolean => {
  if (sel === '#options-panel') return el.id === 'options-panel';
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel === '[aria-checked="true"]') return el.attrs['aria-checked'] === 'true';
  if (sel === '[aria-checked]') return el.attrs['aria-checked'] !== undefined;
  if (sel === '[role="switch"]') return el.attrs.role === 'switch';
  const m = sel.match(/^\[role="([^"]+)"\]$/);
  if (m) return el.attrs.role === m[1];
  return false;
};

const matchInTree = (root: El, sel: string): El[] => {
  const parts = sel.split(',').map((s) => s.trim());
  const out: El[] = [];
  const walk = (el: El) => {
    for (const part of parts) {
      if (matches(el, part)) {
        out.push(el);
        break;
      }
    }
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
};

function makeEl(
  tagName: string,
  opts: { id?: string; attrs?: Record<string, string>; text?: string; children?: El[] } = {},
): El {
  const el: El = {
    tagName: tagName.toUpperCase(),
    id: opts.id ?? '',
    attrs: opts.attrs ?? {},
    children: [],
    parent: null,
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    },
    querySelector(sel: string) {
      return matchInTree(this, sel)[0] ?? null;
    },
    querySelectorAll(sel: string) {
      return matchInTree(this, sel);
    },
    contains(other: El) {
      let p: El | null = other.parent;
      while (p) {
        if (p === this) return true;
        p = p.parent;
      }
      return false;
    },
    cloneNode(deep: boolean) {
      const c = makeEl(this.tagName, { id: this.id, attrs: { ...this.attrs } });
      if (this.attrs.__text) c.attrs.__text = this.attrs.__text;
      if (deep) {
        for (const ch of this.children) {
          const cc = ch.cloneNode(true);
          cc.parent = c;
          c.children.push(cc);
        }
      }
      return c;
    },
    get textContent() {
      if (this.attrs.__text) return this.attrs.__text;
      return this.children.map((c) => c.textContent).join('');
    },
    get className() {
      return this.attrs.class ?? '';
    },
  };
  if (opts.text) el.attrs.__text = opts.text;
  for (const ch of opts.children ?? []) {
    ch.parent = el;
    el.children.push(ch);
  }
  return el;
}

function parseHtml(src: string): El {
  const compact = src.replace(/>\s+</g, '><').trim();
  let i = 0;
  const parseNode = (): El => {
    while (i < compact.length && /\s/.test(compact[i])) i++;
    if (compact[i] !== '<') throw new Error('expected <');
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
      } else if (name) attrs[name] = '';
    }
    if (compact[i] === '>') i++;
    const el = makeEl(tag, { id: attrs.id ?? '', attrs });
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
          const t = makeEl('span', { text: txt });
          t.parent = el;
          el.children.push(t);
        }
      }
    }
    return el;
  };
  return parseNode();
}

function runParse(html: string, panelId = 'options-panel') {
  const root = parseHtml(html);
  const fakeDoc = {
    querySelector(sel: string) {
      if (sel === `#${panelId}`) return root.id === panelId ? root : matchInTree(root, sel)[0];
      return matchInTree(root, sel)[0] ?? null;
    },
    querySelectorAll(sel: string) {
      return matchInTree(root, sel);
    },
    getElementById(id: string) {
      return matchInTree(root, `#${id}`)[0] ?? null;
    },
  };
  const code = `${PARSER_JS}\nparseModelOptionsPanel(document.querySelector('#${panelId}'));`;
  return vm.runInNewContext(code, { document: fakeDoc, Array }) as Array<{
    kind: string;
    id: string;
    label: string;
    on?: boolean;
    value?: string;
    options?: string[];
  }>;
}

describe('parseModelOptionsPanel', () => {
  it('parses Composer Fast toggle', () => {
    const controls = runParse(`
      <div id="options-panel" role="menu">
        <div>Options</div>
        <div role="menuitem"><span>Fast</span><span role="switch" aria-checked="true"></span></div>
      </div>
    `);
    assert.equal(controls.length, 1);
    assert.equal(controls[0].kind, 'toggle');
    assert.equal(controls[0].label, 'Fast');
    assert.equal(controls[0].on, true);
    assert.equal(controls[0].id, 'toggle::Fast');
  });

  it('parses Sonnet Thinking toggle and grouped choices', () => {
    const controls = runParse(`
      <div id="options-panel" role="menu">
        <div>Options</div>
        <div role="menuitem"><span>Thinking</span><span role="switch" aria-checked="true"></span></div>
        <div role="menuitem">Context</div>
        <div role="menuitem" aria-checked="true">200K</div>
        <div role="menuitem">1M</div>
        <div role="menuitem">Effort</div>
        <div role="menuitem">Low</div>
        <div role="menuitem" aria-checked="true">Medium</div>
        <div role="menuitem">High</div>
        <div role="menuitem">Max</div>
      </div>
    `);
    assert.equal(controls.length, 3);
    assert.equal(controls[0].kind, 'toggle');
    assert.equal(controls[0].label, 'Thinking');
    assert.equal(controls[1].kind, 'choice');
    assert.equal(controls[1].label, 'Context');
    assert.deepEqual(JSON.parse(JSON.stringify(controls[1].options)), ['200K', '1M']);
    assert.equal(controls[1].value, '200K');
    assert.equal(controls[2].label, 'Effort');
    assert.deepEqual(JSON.parse(JSON.stringify(controls[2].options)), ['Low', 'Medium', 'High', 'Max']);
    assert.equal(controls[2].value, 'Medium');
  });
});
