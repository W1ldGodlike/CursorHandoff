import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatExtensionLogLine,
  formatServerChildLogLine,
  maskSecrets,
  sanitizeLogForUi,
  sanitizePathForUi,
} from '../../extension/src/log-event.js';

describe('extension log-event', () => {
  it('sanitizePathForUi replaces home prefix with ~', () => {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? 'C:\\Users\\test';
    const raw = `${home}\\Projects\\foo`;
    assert.equal(sanitizePathForUi(raw), '~/Projects/foo');
  });

  it('maskSecrets shortens bot-token-like strings', () => {
    const masked = maskSecrets('token=12345678:ABCDEFghijklmnopqrstuvwxyz123456');
    assert.ok(!masked.includes('ABCDEFghijklmnopqrstuvwxyz123456'));
  });

  it('sanitizeLogForUi shortens paths and redacts secrets', () => {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? 'C:\\Users\\test';
    const raw = `Starting ${home}\\Projects\\x token=12345678:ABCDEFghijklmnopqrstuvwxyz123456`;
    const out = sanitizeLogForUi(raw);
    assert.ok(out.includes('~/Projects/x'));
    assert.ok(!out.includes(home));
    assert.ok(!out.includes('ABCDEFghijklmnopqrstuvwxyz123456'));
  });

  it('formatServerChildLogLine sanitizes JSON msg and hint', () => {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? 'C:\\Users\\test';
    const raw = JSON.stringify({
      level: 'info',
      code: 'QUEUE_LOAD_FAIL',
      msg: `Failed to load ${home}/Projects/foo/data/queue.json`,
      hint: `${home}\\Projects\\foo\\data\\queue.json`,
    });
    const out = formatServerChildLogLine(raw);
    assert.ok(out.line.includes('~/Projects/foo'));
    assert.ok(!out.line.includes(home));
    assert.match(out.line, /code=QUEUE_LOAD_FAIL/);
  });

  it('sanitizePathForUi handles lowercase drive letter on Windows', () => {
    if (process.platform !== 'win32') return;
    const home = process.env.USERPROFILE ?? '';
    if (!home) return;
    const lower = home.replace(/^([A-Z]):/, (_, d) => `${d.toLowerCase()}:`);
    assert.equal(sanitizePathForUi(`${lower}\\Projects\\foo`), '~/Projects/foo');
  });

  it('sanitizeLogForUi handles lowercase home prefix', () => {
    if (process.platform !== 'win32') return;
    const home = process.env.USERPROFILE ?? '';
    if (!home) return;
    const lower = home.replace(/^([A-Z]):/, (_, d) => `${d.toLowerCase()}:`);
    const out = sanitizeLogForUi(`Starting server: ${lower}\\.cursor\\extensions\\x`);
    assert.ok(out.includes('~/.cursor/extensions/x'));
    assert.ok(!out.toLowerCase().includes(lower.toLowerCase()));
  });

  it('formatServerChildLogLine unwraps legacy double-encoded msg', () => {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? 'C:\\Users\\test';
    const inner = JSON.stringify({
      level: 'info',
      code: 'STARTUP_OK',
      msg: 'Handoff server starting',
      hint: `${home}\\Projects\\foo\\data`,
    });
    const outer = JSON.stringify({ ts: Date.now(), level: 'info', msg: inner });
    const out = formatServerChildLogLine(outer);
    assert.match(out.line, /Handoff server starting/);
    assert.match(out.line, /code=STARTUP_OK/);
    assert.match(out.line, /hint=~\/Projects\/foo/);
    assert.ok(!out.line.includes('{"ts"'));
    assert.ok(!out.line.includes(home));
  });

  it('formatExtensionLogLine sanitizes message paths', () => {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? 'C:\\Users\\test';
    const line = formatExtensionLogLine('info', `Starting server: ${home}\\.cursor\\extensions\\x`, {
      scope: 'extension',
      code: 'EXT_SPAWN',
    });
    assert.ok(line.includes('~/.cursor/extensions/x'));
    assert.ok(!line.includes(home));
  });
});
