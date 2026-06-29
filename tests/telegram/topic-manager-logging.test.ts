import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ChatTab, CursorWindow } from '../../src/core/types.js';
import { TopicManager } from '../../src/telegram/topics/manager.js';
import type { TelegramApiClient } from '../../src/telegram/types.js';

function topicsPath(dataDir: string): string {
  return join(dataDir, 'telegram-topics.json');
}

async function capture(
  level: 'log' | 'warn' | 'error',
  run: () => void | Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const push = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  if (level === 'log') console.log = push;
  else if (level === 'warn') console.warn = push;
  else console.error = push;
  try {
    await run();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return lines;
}

function seedMapping(dataDir: string, threadId = 7): TopicManager {
  return seedMappings(dataDir, [
    {
      threadId,
      windowId: 'win-1',
      windowTitle: 'Demo',
      tabTitle: 'Chat',
      lastActive: Date.now(),
    },
  ]);
}

function seedMappings(
  dataDir: string,
  mappings: Array<{
    threadId: number;
    windowId: string;
    windowTitle: string;
    tabTitle: string;
    lastActive: number;
    composerId?: string;
  }>,
): TopicManager {
  const hwm = Math.max(...mappings.map((m) => m.threadId));
  writeFileSync(
    topicsPath(dataDir),
    JSON.stringify({ mappings, highWaterMark: hwm }),
    'utf-8',
  );
  return new TopicManager();
}

describe('topic-manager logging', () => {
  let dataDir: string;
  let origDataDir: string | undefined;

  beforeEach(() => {
    origDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'handoff-topic-log-'));
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = origDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('logs TG_TOPIC_LOAD_SKIP when persist file is missing', async () => {
    const lines = await capture('log', () => {
      new TopicManager();
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TOPIC_LOAD_SKIP')));
    assert.ok(lines.some((line) => line.includes('scope=telegram') && line.includes('op=load_persist')));
  });

  it('logs TG_TOPIC_LOAD_OK when mappings load', async () => {
    writeFileSync(
      topicsPath(dataDir),
      JSON.stringify({
        mappings: [{ threadId: 3, windowId: 'w', windowTitle: 'P', tabTitle: 'T', lastActive: 1 }],
        highWaterMark: 3,
      }),
      'utf-8',
    );
    const lines = await capture('log', () => {
      new TopicManager();
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TOPIC_LOAD_OK')));
    assert.ok(lines.some((line) => line.includes('Loaded 1 topic mappings')));
  });

  it('logs TG_TOPIC_LOAD_FAIL on corrupt json and keeps empty store', async () => {
    writeFileSync(topicsPath(dataDir), '{ corrupt', 'utf-8');
    let tm!: TopicManager;
    const lines = await capture('error', () => {
      tm = new TopicManager();
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TOPIC_LOAD_FAIL')));
    assert.ok(lines.some((line) => line.includes('op=load_persist')));
    assert.ok(lines.some((line) => line.includes('JSON') || line.includes('SyntaxError')));
    assert.ok(lines.some((line) => line.includes('telegram-topics.json')));
    assert.equal(tm.getAllMappings().length, 0);
  });

  it('logs TG_TOPIC_SAVE_FAIL with errno when persist file is read-only', async () => {
    const tm = seedMapping(dataDir);
    const path = topicsPath(dataDir);
    if (process.platform === 'win32') {
      execSync(`attrib +R "${path}"`, { stdio: 'ignore' });
    } else {
      chmodSync(path, 0o444);
    }
    const lines = await capture('error', () => {
      tm.registerMapping({
        threadId: 8,
        windowId: 'win-2',
        windowTitle: 'Other',
        tabTitle: 'Tab',
        lastActive: Date.now(),
      });
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TOPIC_SAVE_FAIL')));
    assert.ok(lines.some((line) => line.includes('scope=telegram') && line.includes('op=persist')));
    assert.ok(lines.some((line) => line.includes('errno=')));
    assert.ok(lines.some((line) => line.includes('telegram-topics.json')));
    if (process.platform === 'win32') {
      execSync(`attrib -R "${path}"`, { stdio: 'ignore' });
    } else {
      chmodSync(path, 0o644);
    }
  });

  it('logs TG_TOPIC_REGISTER with threadId and window ctx', async () => {
    const tm = new TopicManager();
    const lines = await capture('log', () => {
      tm.registerMapping({
        threadId: 11,
        windowId: 'win-a',
        windowTitle: 'Repo',
        tabTitle: 'Agent',
        lastActive: Date.now(),
      });
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TOPIC_REGISTER')));
    assert.ok(lines.some((line) => line.includes('threadId=11')));
    assert.ok(lines.some((line) => line.includes('windowId=win-a')));
  });

  it('logs TG_TOPIC_CREATE_FAIL with errno when API throws', async () => {
    const tm = new TopicManager();
    const windows: CursorWindow[] = [{ id: 'w1', title: 'Proj', url: 'file:///p' }];
    const tabs: ChatTab[] = [
      { title: 'Agent', composerId: '', isActive: true, status: '', selectorPath: '' },
    ];
    const api: TelegramApiClient = {
      createForumTopic: async () => {
        throw Object.assign(new Error('403 forbidden'), { code: 'ETELEGRAM' });
      },
    } as unknown as TelegramApiClient;
    const lines = await capture('error', async () => {
      await tm.createTopics(api, -100123, windows, tabs, 'w1');
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TOPIC_CREATE_FAIL')));
    assert.ok(lines.some((line) => line.includes('errno=ETELEGRAM')));
    assert.ok(lines.some((line) => line.includes('chatId=-100123')));
    assert.ok(lines.some((line) => line.includes('403 forbidden')));
  });

  it('logs TG_TOPIC_CREATE_OK when API succeeds', async () => {
    const tm = new TopicManager();
    const windows: CursorWindow[] = [{ id: 'w1', title: 'Proj', url: 'file:///p' }];
    const tabs: ChatTab[] = [
      { title: 'Agent', composerId: '', isActive: true, status: '', selectorPath: '' },
    ];
    const api: TelegramApiClient = {
      createForumTopic: async () => ({ message_thread_id: 99 }),
    } as unknown as TelegramApiClient;
    const lines = await capture('log', async () => {
      await tm.createTopics(api, -100123, windows, tabs, 'w1');
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TOPIC_CREATE_OK')));
    assert.ok(lines.some((line) => line.includes('threadId=99')));
  });

  it('logs TG_TOPIC_TOUCH_MISS for unknown thread', async () => {
    const tm = seedMapping(dataDir);
    const lines = await capture('warn', () => {
      tm.touchAfterInbound(404);
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TOPIC_TOUCH_MISS')));
    assert.ok(lines.some((line) => line.includes('threadId=404')));
  });

  it('logs TG_TOPIC_REMOVE_MISS and TG_TOPIC_REMOVED', async () => {
    const tm = seedMapping(dataDir, 5);
    const miss = await capture('warn', () => {
      assert.equal(tm.removeMapping(999), false);
    });
    assert.ok(miss.some((line) => line.includes('code=TG_TOPIC_REMOVE_MISS')));

    const removed = await capture('log', () => {
      assert.equal(tm.removeMapping(5), true);
    });
    assert.ok(removed.some((line) => line.includes('code=TG_TOPIC_REMOVED')));
    assert.ok(removed.some((line) => line.includes('threadId=5')));
  });

  it('logs TG_TOPIC_UPDATE_MISS for unknown thread', async () => {
    const tm = seedMapping(dataDir);
    const lines = await capture('warn', () => {
      tm.updateMappingTarget(404, 'w', 'Win', 'Tab');
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TOPIC_UPDATE_MISS')));
  });

  it('logs TG_TOPIC_BACKFILL_MISS and TG_TOPIC_BACKFILL_OK', async () => {
    const tm = seedMapping(dataDir, 12);
    const miss = await capture('warn', () => {
      assert.equal(tm.backfillComposerId(404, 'composer-stable-id'), false);
    });
    assert.ok(miss.some((line) => line.includes('code=TG_TOPIC_BACKFILL_MISS')));

    const ok = await capture('log', () => {
      assert.equal(tm.backfillComposerId(12, 'composer-stable-id'), true);
    });
    assert.ok(ok.some((line) => line.includes('code=TG_TOPIC_BACKFILL_OK')));
    assert.ok(ok.some((line) => line.includes('threadId=12')));
  });

  it('logs TG_TOPIC_MODE_MISS and TG_TOPIC_MODE_REJECT', async () => {
    const tm = seedMapping(dataDir);
    const miss = await capture('warn', () => {
      tm.setTopicMode(404, 'agent');
    });
    assert.ok(miss.some((line) => line.includes('code=TG_TOPIC_MODE_MISS')));

    const reject = await capture('warn', () => {
      tm.setTopicMode(7, 'not-a-mode');
    });
    assert.ok(reject.some((line) => line.includes('code=TG_TOPIC_MODE_REJECT')));
  });

  it('logs TG_TOPIC_NOTIFY_MISS and TG_TOPIC_NOTIFY_REJECT', async () => {
    const tm = seedMapping(dataDir);
    const miss = await capture('warn', () => {
      tm.setNotifyMode(404, 'full');
    });
    assert.ok(miss.some((line) => line.includes('code=TG_TOPIC_NOTIFY_MISS')));

    const reject = await capture('warn', () => {
      tm.setNotifyMode(7, 'loud');
    });
    assert.ok(reject.some((line) => line.includes('code=TG_TOPIC_NOTIFY_REJECT')));
  });

  it('logs TG_TOPIC_UPDATE_OK on successful remap', async () => {
    const tm = seedMapping(dataDir, 15);
    const lines = await capture('log', () => {
      tm.updateMappingTarget(15, 'win-new', 'NewWin', 'NewTab');
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TOPIC_UPDATE_OK')));
    assert.ok(lines.some((line) => line.includes('threadId=15')));
  });

  it('logs TG_TOPIC_WINDOW_REBIND when title fallback picks stale windowId', async () => {
    writeFileSync(
      topicsPath(dataDir),
      JSON.stringify({
        mappings: [
          {
            threadId: 20,
            windowId: 'old-win',
            windowTitle: 'Demo',
            tabTitle: 'Chat',
            lastActive: Date.now(),
          },
        ],
        highWaterMark: 20,
      }),
      'utf-8',
    );
    const tm = new TopicManager();
    const lines = await capture('log', () => {
      tm.getThreadForSnapshot('new-win', 'Demo', 'Chat');
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TOPIC_WINDOW_REBIND')));
    assert.ok(lines.some((line) => line.includes('threadId=20') && line.includes('windowId=new-win')));
  });

  it('logs TG_TOPIC_COMPOSER_CONFLICT when composer owned on another thread', async () => {
    const tm = seedMappings(dataDir, [
      { threadId: 7, windowId: 'win-1', windowTitle: 'Demo', tabTitle: 'Chat', lastActive: Date.now() },
      {
        threadId: 8,
        windowId: 'win-2',
        windowTitle: 'Demo',
        tabTitle: 'Other',
        lastActive: Date.now(),
        composerId: 'abcdefgh',
      },
    ]);
    const lines = await capture('warn', () => {
      tm.touchAfterInbound(7, 'abcdefgh', 'Chat', 'win-1', 'Demo');
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TOPIC_COMPOSER_CONFLICT')));
    assert.ok(lines.some((line) => line.includes('threadId=7') && line.includes('composerId=abcdefgh')));
  });

  it('logs TG_TOPIC_COMPOSER_KEEP when mapping already has different stable composer', async () => {
    const tm = seedMappings(dataDir, [
      {
        threadId: 7,
        windowId: 'win-1',
        windowTitle: 'Demo',
        tabTitle: 'Chat',
        lastActive: Date.now(),
        composerId: 'abcdefgh',
      },
    ]);
    const lines = await capture('warn', () => {
      tm.touchAfterInbound(7, 'ijklmnop', 'Chat', 'win-1', 'Demo');
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TOPIC_COMPOSER_KEEP')));
    assert.ok(lines.some((line) => line.includes('threadId=7')));
  });

  it('logs TG_TOPIC_TAB_MISMATCH when stable composer but active tab differs', async () => {
    const tm = seedMapping(dataDir);
    const lines = await capture('warn', () => {
      tm.touchAfterInbound(7, 'abcdefgh', 'OtherTabXYZ', 'win-1', 'Demo');
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TOPIC_TAB_MISMATCH')));
    assert.ok(lines.some((line) => line.includes('threadId=7')));
  });

  it('logs TG_TOPIC_TITLE_KEEP when tab rename is not allowed', async () => {
    const tm = seedMapping(dataDir);
    const lines = await capture('warn', () => {
      tm.touchAfterInbound(7, undefined, 'QuantumPhysics', 'win-1', 'Demo');
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TOPIC_TITLE_KEEP')));
    assert.ok(lines.some((line) => line.includes('threadId=7')));
  });

  it('logs TG_TOPIC_RUNTIME_KEY_TAKEN when remap collides with another thread key', async () => {
    const tm = seedMappings(dataDir, [
      { threadId: 15, windowId: 'win-1', windowTitle: 'Demo', tabTitle: 'Alpha', lastActive: Date.now() },
      { threadId: 16, windowId: 'win-1', windowTitle: 'Demo', tabTitle: 'Beta', lastActive: Date.now() },
    ]);
    const lines = await capture('warn', () => {
      tm.updateMappingTarget(15, 'win-1', 'Demo', 'Beta');
    });
    assert.ok(lines.some((line) => line.includes('code=TG_TOPIC_RUNTIME_KEY_TAKEN')));
    assert.ok(lines.some((line) => line.includes('threadId=15')));
  });

  it('logs TG_TOPIC_CLEAR_ALL and TG_TOPIC_HWM_RESET', async () => {
    const tm = seedMapping(dataDir);
    const cleared = await capture('log', () => {
      tm.clearAll();
    });
    assert.ok(cleared.some((line) => line.includes('code=TG_TOPIC_CLEAR_ALL')));

    tm.registerMapping({
      threadId: 2,
      windowId: 'w',
      windowTitle: 'P',
      tabTitle: 'T',
      lastActive: Date.now(),
    });
    const reset = await capture('log', () => {
      tm.resetHighWaterMark();
    });
    assert.ok(reset.some((line) => line.includes('code=TG_TOPIC_HWM_RESET')));
  });

  it('repairs corrupt json load silently then persists on register', async () => {
    writeFileSync(topicsPath(dataDir), '{ bad', 'utf-8');
    const tm = new TopicManager();
    assert.equal(tm.getAllMappings().length, 0);
    tm.registerMapping({
      threadId: 1,
      windowId: 'w',
      windowTitle: 'P',
      tabTitle: 'T',
      lastActive: Date.now(),
    });
    const raw = JSON.parse(readFileSync(topicsPath(dataDir), 'utf-8')) as { mappings: unknown[] };
    assert.equal(raw.mappings.length, 1);
  });
});

/** Stable codes in manager.ts — meta guard against untested TG_TOPIC_* regressions. */
const MANAGER_TG_TOPIC_CODES = [
  'TG_TOPIC_WINDOW_REBIND',
  'TG_TOPIC_CREATE_OK',
  'TG_TOPIC_CREATE_FAIL',
  'TG_TOPIC_REGISTER',
  'TG_TOPIC_TOUCH_MISS',
  'TG_TOPIC_COMPOSER_CONFLICT',
  'TG_TOPIC_COMPOSER_KEEP',
  'TG_TOPIC_TAB_MISMATCH',
  'TG_TOPIC_TITLE_KEEP',
  'TG_TOPIC_BACKFILL_MISS',
  'TG_TOPIC_BACKFILL_OK',
  'TG_TOPIC_UPDATE_MISS',
  'TG_TOPIC_RUNTIME_KEY_TAKEN',
  'TG_TOPIC_UPDATE_OK',
  'TG_TOPIC_MODE_MISS',
  'TG_TOPIC_MODE_REJECT',
  'TG_TOPIC_NOTIFY_MISS',
  'TG_TOPIC_NOTIFY_REJECT',
  'TG_TOPIC_REMOVE_MISS',
  'TG_TOPIC_REMOVED',
  'TG_TOPIC_CLEAR_ALL',
  'TG_TOPIC_HWM_RESET',
  'TG_TOPIC_LOAD_SKIP',
  'TG_TOPIC_LOAD_OK',
  'TG_TOPIC_LOAD_FAIL',
  'TG_TOPIC_SAVE_FAIL',
] as const;

describe('topic-manager logging coverage', () => {
  it('asserts every manager TG_TOPIC code in this test file', () => {
    const src = readFileSync(new URL('./topic-manager-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of MANAGER_TG_TOPIC_CODES) {
      assert.ok(
        src.includes(`code=${code}`),
        `topic-manager-logging.test.ts missing assertion for ${code}`,
      );
    }
    assert.equal(MANAGER_TG_TOPIC_CODES.length, 26);
  });

  it('manager.ts declares exactly the covered TG_TOPIC codes', () => {
    const mgr = readFileSync(
      new URL('../../src/telegram/topics/manager.ts', import.meta.url),
      'utf-8',
    );
    const found = new Set<string>();
    for (const m of mgr.matchAll(/'((?:TG_TOPIC_[A-Z_]+))'/g)) {
      found.add(m[1]);
    }
    for (const code of MANAGER_TG_TOPIC_CODES) {
      assert.ok(found.has(code), `manager.ts missing ${code}`);
    }
    assert.equal(found.size, MANAGER_TG_TOPIC_CODES.length);
  });

  it('each TG_TOPIC code is referenced in a behavioral it() title', () => {
    const src = readFileSync(new URL('./topic-manager-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of MANAGER_TG_TOPIC_CODES) {
      assert.ok(
        src.includes(`logs ${code}`) || src.includes(`and ${code}`),
        `no behavioral it() title references ${code}`,
      );
    }
  });
});
