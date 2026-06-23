import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getGeneralMenuItems, resolveGeneralButtonCommand, getChatMenuItems, resolveChatButtonCommand } from '../../src/telegram/ui/menus.js';
import { BOT_COMMANDS } from '../../src/telegram/transport/poll-loop.js';
import { setLocale } from '../../src/i18n/t.js';

describe('telegram menus', () => {
  setLocale('en');

  it('general menu uses renamed slash names, not legacy sync/*', () => {
    const commands = getGeneralMenuItems().map((i) => i.command);
    assert.deepEqual(commands, [
      'status', 'pause', 'resume',
      'bridge', 'bridge_all', 'unbridge', 'merge_threads',
      'set_mode', 'pick_model',
    ]);
    for (const cut of ['sync', 'sync_all', 'unsync', 'dedupe', 'cleanup', 'history', 'mode', 'model']) {
      assert.ok(!commands.includes(cut), `CUT/legacy ${cut} must not be in general menu`);
    }
  });

  it('chat menu drops CUT resync/history; mode/model renamed', () => {
    const commands = getChatMenuItems().map((i) => i.command);
    assert.deepEqual(commands, [
      'close_chat', 'new_chat', 'setup_tg_send', 'thread_status', 'set_mode', 'pick_model',
    ]);
    for (const cut of ['resync', 'history', 'mode', 'model']) {
      assert.ok(!commands.includes(cut), `${cut} must not be in chat menu`);
    }
  });

  it('reply keyboard buttons resolve to dispatch command names', () => {
    const bridgeItem = getGeneralMenuItems().find((i) => i.command === 'bridge')!;
    const label = `🔄 /bridge — ${bridgeItem.description}`;
    assert.equal(resolveGeneralButtonCommand(label), 'bridge');

    const modeItem = getChatMenuItems().find((i) => i.command === 'set_mode')!;
    const chatLabel = `🎛 /set_mode — ${modeItem.description}`;
    assert.equal(resolveChatButtonCommand(chatLabel), 'set_mode');
  });

  it('BOT_COMMANDS omits CUT slash commands', () => {
    const names = BOT_COMMANDS.map((c) => c.command);
    for (const cut of ['history', 'plan', 'agent', 'summary', 'resync', 'cleanup', 'cleanup_preview']) {
      assert.ok(!names.includes(cut), `/${cut} must not be registered`);
    }
  });
});
