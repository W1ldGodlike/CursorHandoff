import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { readFileSync } from 'fs';
import { WebSocket, WebSocketServer } from 'ws';
import { CdpClient } from '../../src/ide/cdp-client.js';

const CDP_CLIENT_LOG_CODES = ['CDP_CONNECT_FAIL', 'CDP_WS_ERROR', 'CDP_TIMEOUT'] as const;

type CdpReq = { id?: number; method?: string; params?: Record<string, unknown> };

type WsHandler = (ws: WebSocket, msg: CdpReq) => void;

async function captureAll(run: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const push = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  console.log = push;
  console.warn = push;
  console.error = push;
  try {
    await run();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return lines;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

function assertCdpClientLog(
  lines: string[],
  code: string,
  need: {
    op?: string;
    text?: string;
    durationMs?: number;
  } = {},
): void {
  const line = lines.find((l) => {
    if (!l.includes(`code=${code}`)) return false;
    if (need.text && !l.includes(need.text)) return false;
    if (need.op && !l.includes(`op=${need.op}`)) return false;
    if (need.durationMs !== undefined && !l.includes(`durationMs=${need.durationMs}`)) return false;
    return true;
  });
  const desc = [
    `code=${code}`,
    need.text ? `text "${need.text}"` : '',
    need.op ? `op=${need.op}` : '',
    need.durationMs !== undefined ? `durationMs=${need.durationMs}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  assert.ok(line, `missing cdp-client log: ${desc}`);
  assert.ok(line!.includes('scope=cdp'), `${code} missing scope=cdp`);
}

function assertNoCdpClientLogs(lines: string[]): void {
  const hit = lines.find((l) => CDP_CLIENT_LOG_CODES.some((code) => l.includes(`code=${code}`)));
  assert.ok(!hit, `unexpected cdp-client log: ${hit}`);
}

function cdpClientOnly(lines: string[]): string[] {
  return lines.filter((l) => CDP_CLIENT_LOG_CODES.some((code) => l.includes(`code=${code}`)));
}

function cdpClientZoneSrc(): string {
  const src = readFileSync(new URL('../../src/ide/cdp-client.ts', import.meta.url), 'utf-8');
  return src.slice(src.indexOf('function cdpCtx'), src.indexOf('function sleep'));
}

function clientWs(client: CdpClient): WebSocket {
  return (client as unknown as { ws: WebSocket }).ws;
}

function replyOk(ws: WebSocket, id: number, result: Record<string, unknown> = {}): void {
  ws.send(JSON.stringify({ id, result }));
}

function replyEvaluateValue(ws: WebSocket, id: number, value: unknown): void {
  replyOk(ws, id, { result: { value } });
}

function noopWs(ws: WebSocket): void {
  ws.on('error', () => {});
}

async function withWss(
  onConnection: (ws: WebSocket) => void,
  run: (wsUrl: string) => Promise<void>,
): Promise<void> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const addr = wss.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const wsUrl = `ws://127.0.0.1:${port}/devtools/page/test`;
  wss.on('connection', onConnection);
  try {
    await run(wsUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function wireHandler(ws: WebSocket, handler: WsHandler): void {
  ws.on('message', (raw) => {
    let msg: CdpReq;
    try {
      msg = JSON.parse(raw.toString()) as CdpReq;
    } catch {
      return;
    }
    handler(ws, msg);
  });
}

async function withConnectedClient(
  handler: WsHandler,
  run: (client: CdpClient) => Promise<void>,
): Promise<void> {
  await withWss((ws) => wireHandler(ws, handler), async (wsUrl) => {
    const client = new CdpClient();
    await client.connect(wsUrl);
    await settle();
    try {
      await run(client);
    } finally {
      client.disconnect();
    }
  });
}

const CDP_CLIENT_PATH_MATRIX = [
  { kind: 'log' as const, code: 'CDP_CONNECT_FAIL', marker: 'pre-connect ECONNREFUSED logs CDP_CONNECT_FAIL with connect op and error message' },
  { kind: 'log' as const, code: 'CDP_CONNECT_FAIL', marker: 'pre-connect failure rejects connect promise and leaves client disconnected' },
  { kind: 'log' as const, code: 'CDP_WS_ERROR', marker: 'post-connect WebSocket error logs CDP_WS_ERROR with ws op and prefixed message' },
  { kind: 'log' as const, code: 'CDP_WS_ERROR', marker: 'post-connect error does not emit CDP_CONNECT_FAIL' },
  { kind: 'log' as const, code: 'CDP_TIMEOUT', marker: 'send timeout logs CDP_TIMEOUT with method op and default durationMs 10000' },
  { kind: 'log' as const, code: 'CDP_TIMEOUT', marker: 'send with custom timeoutMs logs CDP_TIMEOUT with matching durationMs' },
  { kind: 'log' as const, code: 'CDP_TIMEOUT', marker: 'evaluate timeout logs CDP_TIMEOUT for Runtime.evaluate op' },
  { kind: 'log' as const, code: 'CDP_TIMEOUT', marker: 'Input.insertText timeout logs CDP_TIMEOUT with Input.insertText op' },
  { kind: 'log' as const, code: 'CDP_TIMEOUT', marker: 'callFunctionWithTimeout uses custom durationMs in CDP_TIMEOUT context' },
  { kind: 'silent' as const, marker: 'successful connect stays silent on all cdp-client log codes' },
  { kind: 'silent' as const, marker: 'pre-connect failure stays silent on CDP_WS_ERROR and CDP_TIMEOUT' },
  { kind: 'silent' as const, marker: 'post-connect error keeps isConnected true without CONNECT_FAIL' },
  { kind: 'silent' as const, marker: 'intentional disconnect stays silent on cdp-client log codes' },
  { kind: 'silent' as const, marker: 'server close after connect emits disconnected without cdp-client logs' },
  { kind: 'silent' as const, marker: 'send success resolves without CDP_TIMEOUT' },
  { kind: 'silent' as const, marker: 'send when not connected throws without CDP_TIMEOUT' },
  { kind: 'silent' as const, marker: 'evaluate success returns value without cdp-client logs' },
  { kind: 'silent' as const, marker: 'evaluate page exception throws without cdp-client logs' },
  { kind: 'silent' as const, marker: 'CDP protocol error response rejects send without cdp-client logs' },
  { kind: 'silent' as const, marker: 'invalid JSON message from server stays silent on cdp-client logs' },
  { kind: 'silent' as const, marker: 'unmatched response id stays silent on cdp-client logs' },
  { kind: 'silent' as const, marker: 'server event method emits event without cdp-client logs' },
  { kind: 'silent' as const, marker: 'click missing element throws without cdp-client logs' },
  { kind: 'silent' as const, marker: 'focus missing element throws without cdp-client logs' },
  { kind: 'silent' as const, marker: 'exists returns boolean without cdp-client logs' },
  { kind: 'silent' as const, marker: 'callFunction success stays silent on cdp-client logs' },
  { kind: 'silent' as const, marker: 'pressKey dispatches keyDown and keyUp without cdp-client logs' },
  { kind: 'silent' as const, marker: 'typeText send stays silent on cdp-client logs' },
  { kind: 'silent' as const, marker: 'clickAtCoords mouse events stay silent on cdp-client logs' },
  { kind: 'silent' as const, marker: 'dispatchKeyEvent send stays silent on cdp-client logs' },
  { kind: 'silent' as const, marker: 'disconnect rejects pending send without CDP_TIMEOUT' },
  { kind: 'silent' as const, marker: 'server close rejects pending send without CDP_TIMEOUT' },
  { kind: 'silent' as const, marker: 'two pending sends only timed-out id emits single CDP_TIMEOUT' },
  { kind: 'silent' as const, marker: 'evaluate undefined remote value returns undefined without logs' },
  { kind: 'silent' as const, marker: 'send empty result object resolves without cdp-client logs' },
  { kind: 'log' as const, code: 'CDP_WS_ERROR', marker: 'second post-connect WS error emits another CDP_WS_ERROR log' },
  { kind: 'silent' as const, marker: 'connect resolves before open handler logs stay absent' },
  { kind: 'log' as const, code: 'CDP_TIMEOUT', marker: 'timeout reject error message includes method and timeoutMs text' },
  { kind: 'silent' as const, marker: 'click success stays silent on cdp-client logs' },
  { kind: 'silent' as const, marker: 'focus success stays silent on cdp-client logs' },
  { kind: 'silent' as const, marker: 'exists false returns without cdp-client logs' },
  { kind: 'silent' as const, marker: 'evaluate exception uses exceptionDetails.text when description absent' },
  { kind: 'silent' as const, marker: 'evaluate exception falls back to Evaluation failed when details empty' },
  { kind: 'silent' as const, marker: 'intentional disconnect does not emit disconnected event' },
  { kind: 'silent' as const, marker: 'pre-connect failure does not emit disconnected event' },
  { kind: 'silent' as const, marker: 'post-connect WS error does not reject connect promise' },
  { kind: 'silent' as const, marker: 'server close sets isConnected false without cdp-client logs' },
  { kind: 'silent' as const, marker: 'send after disconnect throws without cdp-client logs' },
  { kind: 'silent' as const, marker: 'callFunction with args serializes arguments without cdp-client logs' },
  { kind: 'silent' as const, marker: 'pressKey with modifiers passes modifiers on keyDown without logs' },
  { kind: 'silent' as const, marker: 'dispatchKeyEvent char type stays silent on cdp-client logs' },
  { kind: 'silent' as const, marker: 'server event emits params as second listener argument without logs' },
  { kind: 'silent' as const, marker: 'combined id response and method event resolves and emits silently' },
  { kind: 'silent' as const, marker: 'evaluate when not connected throws without cdp-client logs' },
  { kind: 'silent' as const, marker: 'matched response prevents CDP_TIMEOUT on later timer tick' },
  { kind: 'log' as const, code: 'CDP_TIMEOUT', marker: 'dispatchKeyEvent timeout logs CDP_TIMEOUT with Input.dispatchKeyEvent op' },
  { kind: 'silent' as const, marker: 'double disconnect stays silent on cdp-client log codes' },
  { kind: 'silent' as const, marker: 'clickAtCoords sends captured x y coordinates without cdp-client logs' },
  { kind: 'silent' as const, marker: 'click when not connected throws without cdp-client logs' },
  { kind: 'silent' as const, marker: 'focus when not connected throws without cdp-client logs' },
  { kind: 'silent' as const, marker: 'exists when not connected throws without cdp-client logs' },
  { kind: 'silent' as const, marker: 'callFunction when not connected throws without cdp-client logs' },
  { kind: 'silent' as const, marker: 'typeText when not connected throws without cdp-client logs' },
  { kind: 'silent' as const, marker: 'evaluate prefers exception description over text when both present' },
  { kind: 'silent' as const, marker: 'send wire payload includes id method and params without cdp-client logs' },
  { kind: 'log' as const, code: 'CDP_TIMEOUT', marker: 'clickAtCoords mousePressed timeout logs CDP_TIMEOUT with Input.dispatchMouseEvent op' },
  { kind: 'silent' as const, marker: 'pre-connect failure logs exactly one CDP_CONNECT_FAIL line' },
  { kind: 'silent' as const, marker: 'connect success sets isConnected true without cdp-client logs' },
] as const;

const SILENT_PATH_MARKERS = CDP_CLIENT_PATH_MATRIX.filter((r) => r.kind === 'silent').map((r) => r.marker);

describe('cdp-client logging', () => {
  afterEach(() => {
    mock.timers.reset();
  });

  it('pre-connect ECONNREFUSED logs CDP_CONNECT_FAIL with connect op and error message', async () => {
    const client = new CdpClient();
    const lines = await captureAll(async () => {
      await assert.rejects(() => client.connect('ws://127.0.0.1:1/devtools/page/dead'), /ECONNREFUSED|connect/);
    });
    assertCdpClientLog(lines, 'CDP_CONNECT_FAIL', { op: 'connect' });
    assert.ok(lines.some((l) => l.includes('code=CDP_CONNECT_FAIL') && l.includes('ECONNREFUSED')));
  });

  it('pre-connect failure rejects connect promise and leaves client disconnected', async () => {
    const client = new CdpClient();
    await assert.rejects(() => client.connect('ws://127.0.0.1:1/devtools/page/dead'));
    assert.equal(client.isConnected(), false);
  });

  it('post-connect WebSocket error logs CDP_WS_ERROR with ws op and prefixed message', async () => {
    const client = new CdpClient();
    await withWss(noopWs, async (wsUrl) => {
      await client.connect(wsUrl);
      await settle();
      try {
        const lines = await captureAll(async () => {
          clientWs(client).emit('error', new Error('socket torn'));
          await settle();
        });
        assertCdpClientLog(lines, 'CDP_WS_ERROR', { op: 'ws', text: 'WebSocket error: socket torn' });
      } finally {
        client.disconnect();
      }
    });
  });

  it('post-connect error does not emit CDP_CONNECT_FAIL', async () => {
    const client = new CdpClient();
    await withWss(noopWs, async (wsUrl) => {
      await client.connect(wsUrl);
      await settle();
      try {
        const lines = await captureAll(async () => {
          clientWs(client).emit('error', new Error('socket torn'));
          await settle();
        });
        assert.ok(!lines.some((l) => l.includes('code=CDP_CONNECT_FAIL')));
      } finally {
        client.disconnect();
      }
    });
  });

  it('send timeout logs CDP_TIMEOUT with method op and default durationMs 10000', async () => {
    await withWss((ws) => wireHandler(ws, () => {}), async (wsUrl) => {
      const client = new CdpClient();
      await client.connect(wsUrl);
      await settle();
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const lines = await captureAll(async () => {
          const pending = client.send('Page.navigate');
          const rejectWatcher = assert.rejects(pending, /CDP timeout for Page\.navigate \(10000ms\)/);
          mock.timers.tick(10_000);
          await settle();
          await rejectWatcher;
        });
        assertCdpClientLog(lines, 'CDP_TIMEOUT', { op: 'Page.navigate', durationMs: 10_000 });
      } finally {
        client.disconnect();
      }
    });
  });

  it('send with custom timeoutMs logs CDP_TIMEOUT with matching durationMs', async () => {
    await withWss((ws) => wireHandler(ws, () => {}), async (wsUrl) => {
      const client = new CdpClient();
      await client.connect(wsUrl);
      await settle();
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const lines = await captureAll(async () => {
          const pending = client.send('DOM.getDocument', {}, 2500);
          const rejectWatcher = assert.rejects(pending, /2500ms/);
          mock.timers.tick(2500);
          await settle();
          await rejectWatcher;
        });
        assertCdpClientLog(lines, 'CDP_TIMEOUT', { op: 'DOM.getDocument', durationMs: 2500 });
      } finally {
        client.disconnect();
      }
    });
  });

  it('evaluate timeout logs CDP_TIMEOUT for Runtime.evaluate op', async () => {
    await withWss((ws) => wireHandler(ws, () => {}), async (wsUrl) => {
      const client = new CdpClient();
      await client.connect(wsUrl);
      await settle();
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const lines = await captureAll(async () => {
          const pending = client.evaluate('1+1', 800);
          const rejectWatcher = assert.rejects(pending, /Runtime\.evaluate/);
          mock.timers.tick(800);
          await settle();
          await rejectWatcher;
        });
        assertCdpClientLog(lines, 'CDP_TIMEOUT', { op: 'Runtime.evaluate', durationMs: 800 });
      } finally {
        client.disconnect();
      }
    });
  });

  it('Input.insertText timeout logs CDP_TIMEOUT with Input.insertText op', async () => {
    await withWss((ws) => wireHandler(ws, () => {}), async (wsUrl) => {
      const client = new CdpClient();
      await client.connect(wsUrl);
      await settle();
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const lines = await captureAll(async () => {
          const pending = client.typeText('hello', 0);
          const rejectWatcher = assert.rejects(pending, /Input\.insertText/);
          mock.timers.tick(10_000);
          await settle();
          await rejectWatcher;
        });
        assertCdpClientLog(lines, 'CDP_TIMEOUT', { op: 'Input.insertText', durationMs: 10_000 });
      } finally {
        client.disconnect();
      }
    });
  });

  it('callFunctionWithTimeout uses custom durationMs in CDP_TIMEOUT context', async () => {
    await withWss((ws) => wireHandler(ws, () => {}), async (wsUrl) => {
      const client = new CdpClient();
      await client.connect(wsUrl);
      await settle();
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const lines = await captureAll(async () => {
          const pending = client.callFunctionWithTimeout(() => 1, [], 1200);
          const rejectWatcher = assert.rejects(pending, /1200ms/);
          mock.timers.tick(1200);
          await settle();
          await rejectWatcher;
        });
        assertCdpClientLog(lines, 'CDP_TIMEOUT', { op: 'Runtime.evaluate', durationMs: 1200 });
      } finally {
        client.disconnect();
      }
    });
  });

  it('successful connect stays silent on all cdp-client log codes', async () => {
    const lines = await captureAll(async () => {
      await withConnectedClient((ws, msg) => {
        if (msg.id !== undefined) replyEvaluateValue(ws, msg.id, true);
      }, async (client) => {
        assert.equal(client.isConnected(), true);
      });
    });
    assertNoCdpClientLogs(lines);
  });

  it('pre-connect failure stays silent on CDP_WS_ERROR and CDP_TIMEOUT', async () => {
    const client = new CdpClient();
    const lines = await captureAll(async () => {
      await assert.rejects(() => client.connect('ws://127.0.0.1:1/devtools/page/dead'));
    });
    assert.equal(cdpClientOnly(lines).length, 1);
    assertCdpClientLog(lines, 'CDP_CONNECT_FAIL', { op: 'connect' });
  });

  it('post-connect error keeps isConnected true without CONNECT_FAIL', async () => {
    const client = new CdpClient();
    await withWss(noopWs, async (wsUrl) => {
      await client.connect(wsUrl);
      await settle();
      try {
        const lines = await captureAll(async () => {
          clientWs(client).emit('error', new Error('still up'));
          await settle();
        });
        assert.equal(client.isConnected(), true);
        assertCdpClientLog(lines, 'CDP_WS_ERROR', { op: 'ws' });
      } finally {
        client.disconnect();
      }
    });
  });

  it('intentional disconnect stays silent on cdp-client log codes', async () => {
    await withConnectedClient(() => {}, async (client) => {
      const lines = await captureAll(() => {
        client.disconnect();
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('server close after connect emits disconnected without cdp-client logs', async () => {
    const client = new CdpClient();
    let disconnected = false;
    client.on('disconnected', () => {
      disconnected = true;
    });
    await withWss((ws) => {
      ws.on('close', () => {});
      setImmediate(() => ws.close());
    }, async (wsUrl) => {
      await client.connect(wsUrl);
      await settle();
      const lines = await captureAll(async () => {
        clientWs(client).close();
        await settle();
      });
      assert.equal(disconnected, true);
      assertNoCdpClientLogs(lines);
    });
  });

  it('send success resolves without CDP_TIMEOUT', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) replyOk(ws, msg.id, { frameId: 'f1' });
    }, async (client) => {
      const lines = await captureAll(async () => {
        const result = await client.send('Page.getFrameTree');
        assert.deepEqual(result, { frameId: 'f1' });
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('send when not connected throws without CDP_TIMEOUT', async () => {
    const client = new CdpClient();
    const lines = await captureAll(async () => {
      await assert.rejects(() => client.send('Page.navigate'), /not connected/);
    });
    assertNoCdpClientLogs(lines);
  });

  it('evaluate success returns value without cdp-client logs', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) replyEvaluateValue(ws, msg.id, 42);
    }, async (client) => {
      const lines = await captureAll(async () => {
        assert.equal(await client.evaluate('40+2'), 42);
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('evaluate page exception throws without cdp-client logs', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) {
        replyOk(ws, msg.id, {
          exceptionDetails: { exception: { description: 'ReferenceError: x is not defined' } },
        });
      }
    }, async (client) => {
      const lines = await captureAll(async () => {
        await assert.rejects(() => client.evaluate('x'), /ReferenceError/);
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('CDP protocol error response rejects send without cdp-client logs', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) {
        ws.send(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'Method not found' } }));
      }
    }, async (client) => {
      const lines = await captureAll(async () => {
        await assert.rejects(() => client.send('Missing.method'), /Method not found/);
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('invalid JSON message from server stays silent on cdp-client logs', async () => {
    await withWss((ws) => {
      wireHandler(ws, () => {});
      ws.send('{not-json');
    }, async (wsUrl) => {
      const client = new CdpClient();
      await client.connect(wsUrl);
      await settle();
      const lines = await captureAll(async () => {
        await settle();
      });
      assertNoCdpClientLogs(lines);
      client.disconnect();
    });
  });

  it('unmatched response id stays silent on cdp-client logs', async () => {
    await withWss((ws) => {
      wireHandler(ws, () => {});
      ws.send(JSON.stringify({ id: 9999, result: {} }));
    }, async (wsUrl) => {
      const client = new CdpClient();
      await client.connect(wsUrl);
      await settle();
      const lines = await captureAll(async () => {
        await settle();
      });
      assertNoCdpClientLogs(lines);
      client.disconnect();
    });
  });

  it('server event method emits event without cdp-client logs', async () => {
    await withWss((ws) => {
      wireHandler(ws, () => {});
      ws.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log' } }));
    }, async (wsUrl) => {
      const client = new CdpClient();
      let seen = '';
      client.on('event', (method) => {
        seen = String(method);
      });
      await client.connect(wsUrl);
      await settle();
      const lines = await captureAll(async () => {
        await settle();
      });
      assert.equal(seen, 'Runtime.consoleAPICalled');
      assertNoCdpClientLogs(lines);
      client.disconnect();
    });
  });

  it('click missing element throws without cdp-client logs', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) replyEvaluateValue(ws, msg.id, false);
    }, async (client) => {
      const lines = await captureAll(async () => {
        await assert.rejects(() => client.click('#missing'), /Element not found/);
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('focus missing element throws without cdp-client logs', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) replyEvaluateValue(ws, msg.id, false);
    }, async (client) => {
      const lines = await captureAll(async () => {
        await assert.rejects(() => client.focus('#missing'), /Element not found for focus/);
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('exists returns boolean without cdp-client logs', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) replyEvaluateValue(ws, msg.id, true);
    }, async (client) => {
      const lines = await captureAll(async () => {
        assert.equal(await client.exists('#btn'), true);
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('callFunction success stays silent on cdp-client logs', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) replyEvaluateValue(ws, msg.id, 'ok');
    }, async (client) => {
      const lines = await captureAll(async () => {
        assert.equal(await client.callFunction(() => 'ok'), 'ok');
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('pressKey dispatches keyDown and keyUp without cdp-client logs', async () => {
    const sent: string[] = [];
    await withConnectedClient((ws, msg) => {
      if (msg.method) sent.push(msg.method);
      if (msg.id !== undefined) replyOk(ws, msg.id);
    }, async (client) => {
      const lines = await captureAll(async () => {
        await client.pressKey('Enter', 'Enter', 13);
      });
      assert.deepEqual(sent, ['Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
      assertNoCdpClientLogs(lines);
    });
  });

  it('typeText send stays silent on cdp-client logs', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) replyOk(ws, msg.id);
    }, async (client) => {
      const lines = await captureAll(async () => {
        await client.typeText('hello');
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('clickAtCoords mouse events stay silent on cdp-client logs', async () => {
    const methods: string[] = [];
    await withConnectedClient((ws, msg) => {
      if (msg.method) methods.push(msg.method);
      if (msg.id !== undefined) replyOk(ws, msg.id);
    }, async (client) => {
      const lines = await captureAll(async () => {
        await client.clickAtCoords(10, 20);
      });
      assert.deepEqual(methods, ['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent']);
      assertNoCdpClientLogs(lines);
    });
  });

  it('dispatchKeyEvent send stays silent on cdp-client logs', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) replyOk(ws, msg.id);
    }, async (client) => {
      const lines = await captureAll(async () => {
        await client.dispatchKeyEvent('keyDown', { key: 'a' });
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('disconnect rejects pending send without CDP_TIMEOUT', async () => {
    await withWss((ws) => wireHandler(ws, () => {}), async (wsUrl) => {
      const client = new CdpClient();
      await client.connect(wsUrl);
      await settle();
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const pending = client.send('Page.navigate');
        const rejectWatcher = assert.rejects(pending, /Intentional disconnect/);
        const lines = await captureAll(() => {
          client.disconnect();
        });
        await rejectWatcher;
        assertNoCdpClientLogs(lines);
      } finally {
        mock.timers.reset();
      }
    });
  });

  it('server close rejects pending send without CDP_TIMEOUT', async () => {
    await withWss(noopWs, async (wsUrl) => {
      const client = new CdpClient();
      await client.connect(wsUrl);
      await settle();
      const pending = client.send('Page.navigate');
      const rejectWatcher = assert.rejects(pending, /WebSocket closed/);
      const lines = await captureAll(async () => {
        clientWs(client).close();
        await settle();
      });
      await rejectWatcher;
      assertNoCdpClientLogs(lines);
    });
  });

  it('two pending sends only timed-out id emits single CDP_TIMEOUT', async () => {
    await withWss((ws) => {
      wireHandler(ws, (sock, msg) => {
        if (msg.id === 1) replyOk(sock, msg.id);
      });
    }, async (wsUrl) => {
      const client = new CdpClient();
      await client.connect(wsUrl);
      await settle();
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const lines = await captureAll(async () => {
          const ok = client.send('Page.bringToFront');
          const slow = client.send('Page.navigate');
          await settle();
          const slowReject = assert.rejects(slow, /timeout/);
          mock.timers.tick(10_000);
          await settle();
          await ok;
          await slowReject;
        });
        assert.equal(cdpClientOnly(lines).length, 1);
        assertCdpClientLog(lines, 'CDP_TIMEOUT', { op: 'Page.navigate' });
      } finally {
        client.disconnect();
      }
    });
  });

  it('evaluate undefined remote value returns undefined without logs', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) replyOk(ws, msg.id, { result: {} });
    }, async (client) => {
      const lines = await captureAll(async () => {
        assert.equal(await client.evaluate('void 0'), undefined);
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('send empty result object resolves without cdp-client logs', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) replyOk(ws, msg.id, {});
    }, async (client) => {
      const lines = await captureAll(async () => {
        assert.deepEqual(await client.send('Runtime.enable'), {});
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('second post-connect WS error emits another CDP_WS_ERROR log', async () => {
    const client = new CdpClient();
    await withWss(noopWs, async (wsUrl) => {
      await client.connect(wsUrl);
      await settle();
      try {
        const lines = await captureAll(async () => {
          clientWs(client).emit('error', new Error('one'));
          clientWs(client).emit('error', new Error('two'));
          await settle();
        });
        assert.equal(cdpClientOnly(lines).filter((l) => l.includes('CDP_WS_ERROR')).length, 2);
      } finally {
        client.disconnect();
      }
    });
  });

  it('connect resolves before open handler logs stay absent', async () => {
    const client = new CdpClient();
    const lines = await captureAll(async () => {
      await withWss(noopWs, async (wsUrl) => {
        await client.connect(wsUrl);
        client.disconnect();
      });
    });
    assertNoCdpClientLogs(lines);
  });

  it('timeout reject error message includes method and timeoutMs text', async () => {
    await withWss((ws) => wireHandler(ws, () => {}), async (wsUrl) => {
      const client = new CdpClient();
      await client.connect(wsUrl);
      await settle();
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        await captureAll(async () => {
          const pending = client.send('Network.enable', {}, 333);
          const rejectWatcher = assert.rejects(pending, /CDP timeout for Network\.enable \(333ms\)/);
          mock.timers.tick(333);
          await settle();
          await rejectWatcher;
        });
      } finally {
        client.disconnect();
      }
    });
  });

  it('click success stays silent on cdp-client logs', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) replyEvaluateValue(ws, msg.id, true);
    }, async (client) => {
      const lines = await captureAll(async () => {
        await client.click('#submit');
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('focus success stays silent on cdp-client logs', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) replyEvaluateValue(ws, msg.id, true);
    }, async (client) => {
      const lines = await captureAll(async () => {
        await client.focus('#input');
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('exists false returns without cdp-client logs', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) replyEvaluateValue(ws, msg.id, false);
    }, async (client) => {
      const lines = await captureAll(async () => {
        assert.equal(await client.exists('#gone'), false);
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('evaluate exception uses exceptionDetails.text when description absent', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) {
        replyOk(ws, msg.id, { exceptionDetails: { text: 'SyntaxError: Unexpected token' } });
      }
    }, async (client) => {
      const lines = await captureAll(async () => {
        await assert.rejects(() => client.evaluate('{{'), /SyntaxError: Unexpected token/);
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('evaluate exception falls back to Evaluation failed when details empty', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) {
        replyOk(ws, msg.id, { exceptionDetails: {} });
      }
    }, async (client) => {
      const lines = await captureAll(async () => {
        await assert.rejects(() => client.evaluate('bad()'), /Evaluation failed/);
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('intentional disconnect does not emit disconnected event', async () => {
    let disconnected = 0;
    await withConnectedClient(() => {}, async (client) => {
      client.on('disconnected', () => {
        disconnected += 1;
      });
      client.disconnect();
      await settle();
      assert.equal(disconnected, 0);
    });
  });

  it('pre-connect failure does not emit disconnected event', async () => {
    const client = new CdpClient();
    let disconnected = 0;
    client.on('disconnected', () => {
      disconnected += 1;
    });
    await assert.rejects(() => client.connect('ws://127.0.0.1:1/devtools/page/dead'));
    assert.equal(disconnected, 0);
  });

  it('post-connect WS error does not reject connect promise', async () => {
    const client = new CdpClient();
    await withWss(noopWs, async (wsUrl) => {
      await client.connect(wsUrl);
      await settle();
      try {
        clientWs(client).emit('error', new Error('late glitch'));
        await settle();
        assert.equal(client.isConnected(), true);
      } finally {
        client.disconnect();
      }
    });
  });

  it('server close sets isConnected false without cdp-client logs', async () => {
    const client = new CdpClient();
    await withWss(noopWs, async (wsUrl) => {
      await client.connect(wsUrl);
      await settle();
      const lines = await captureAll(async () => {
        clientWs(client).close();
        await settle();
      });
      assert.equal(client.isConnected(), false);
      assertNoCdpClientLogs(lines);
    });
  });

  it('send after disconnect throws without cdp-client logs', async () => {
    await withConnectedClient(() => {}, async (client) => {
      client.disconnect();
      const lines = await captureAll(async () => {
        await assert.rejects(() => client.send('Page.navigate'), /not connected/);
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('callFunction with args serializes arguments without cdp-client logs', async () => {
    let seenExpression = '';
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) {
        const params = msg.params as { expression?: string } | undefined;
        seenExpression = params?.expression ?? '';
        replyEvaluateValue(ws, msg.id, 5);
      }
    }, async (client) => {
      const lines = await captureAll(async () => {
        assert.equal(await client.callFunction((a: number, b: number) => a + b, 2, 3), 5);
      });
      assert.match(seenExpression, /\(2,\s*3\)/);
      assertNoCdpClientLogs(lines);
    });
  });

  it('pressKey with modifiers passes modifiers on keyDown without logs', async () => {
    const payloads: Record<string, unknown>[] = [];
    await withConnectedClient((ws, msg) => {
      if (msg.params) payloads.push(msg.params);
      if (msg.id !== undefined) replyOk(ws, msg.id);
    }, async (client) => {
      const lines = await captureAll(async () => {
        await client.pressKey('A', 'KeyA', 65, 2);
      });
      assert.equal(payloads[0]?.modifiers, 2);
      assert.equal(payloads[0]?.type, 'keyDown');
      assertNoCdpClientLogs(lines);
    });
  });

  it('dispatchKeyEvent char type stays silent on cdp-client logs', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) replyOk(ws, msg.id);
    }, async (client) => {
      const lines = await captureAll(async () => {
        await client.dispatchKeyEvent('char', { text: 'x', unmodifiedText: 'x' });
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('server event emits params as second listener argument without logs', async () => {
    await withWss((ws) => {
      wireHandler(ws, () => {});
      ws.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [1] } }));
    }, async (wsUrl) => {
      const client = new CdpClient();
      let params: unknown;
      client.on('event', (_method, eventParams) => {
        params = eventParams;
      });
      await client.connect(wsUrl);
      await settle();
      const lines = await captureAll(async () => {
        await settle();
      });
      assert.deepEqual(params, { type: 'log', args: [1] });
      assertNoCdpClientLogs(lines);
      client.disconnect();
    });
  });

  it('combined id response and method event resolves and emits silently', async () => {
    await withWss((ws) => {
      wireHandler(ws, (sock, msg) => {
        if (msg.id !== undefined) {
          sock.send(JSON.stringify({
            id: msg.id,
            result: { ok: true },
            method: 'Runtime.executionContextCreated',
            params: { id: 7 },
          }));
        }
      });
    }, async (wsUrl) => {
      const client = new CdpClient();
      let eventMethod = '';
      client.on('event', (method) => {
        eventMethod = String(method);
      });
      await client.connect(wsUrl);
      await settle();
      const lines = await captureAll(async () => {
        const result = await client.send('Runtime.enable');
        assert.deepEqual(result, { ok: true });
        await settle();
      });
      assert.equal(eventMethod, 'Runtime.executionContextCreated');
      assertNoCdpClientLogs(lines);
      client.disconnect();
    });
  });

  it('evaluate when not connected throws without cdp-client logs', async () => {
    const client = new CdpClient();
    const lines = await captureAll(async () => {
      await assert.rejects(() => client.evaluate('1+1'), /not connected/);
    });
    assertNoCdpClientLogs(lines);
  });

  it('matched response prevents CDP_TIMEOUT on later timer tick', async () => {
    await withWss((ws) => wireHandler(ws, (sock, msg) => {
      if (msg.id !== undefined) replyOk(sock, msg.id, { ok: true });
    }), async (wsUrl) => {
      const client = new CdpClient();
      await client.connect(wsUrl);
      await settle();
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const lines = await captureAll(async () => {
          await client.send('Runtime.enable');
          mock.timers.tick(10_000);
          await settle();
        });
        assertNoCdpClientLogs(lines);
      } finally {
        client.disconnect();
      }
    });
  });

  it('dispatchKeyEvent timeout logs CDP_TIMEOUT with Input.dispatchKeyEvent op', async () => {
    await withWss((ws) => wireHandler(ws, () => {}), async (wsUrl) => {
      const client = new CdpClient();
      await client.connect(wsUrl);
      await settle();
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const lines = await captureAll(async () => {
          const pending = client.dispatchKeyEvent('keyDown', { key: 'Enter' });
          const rejectWatcher = assert.rejects(pending, /Input\.dispatchKeyEvent/);
          mock.timers.tick(10_000);
          await settle();
          await rejectWatcher;
        });
        assertCdpClientLog(lines, 'CDP_TIMEOUT', { op: 'Input.dispatchKeyEvent', durationMs: 10_000 });
      } finally {
        client.disconnect();
      }
    });
  });

  it('double disconnect stays silent on cdp-client log codes', async () => {
    await withConnectedClient(() => {}, async (client) => {
      const lines = await captureAll(() => {
        client.disconnect();
        client.disconnect();
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('clickAtCoords sends captured x y coordinates without cdp-client logs', async () => {
    const coords: Array<{ x?: number; y?: number; type?: string }> = [];
    await withConnectedClient((ws, msg) => {
      if (msg.params) coords.push(msg.params as { x?: number; y?: number; type?: string });
      if (msg.id !== undefined) replyOk(ws, msg.id);
    }, async (client) => {
      const lines = await captureAll(async () => {
        await client.clickAtCoords(15, 25);
      });
      assert.deepEqual(
        coords.map((c) => ({ x: c.x, y: c.y, type: c.type })),
        [
          { x: 15, y: 25, type: 'mousePressed' },
          { x: 15, y: 25, type: 'mouseReleased' },
        ],
      );
      assertNoCdpClientLogs(lines);
    });
  });

  it('click when not connected throws without cdp-client logs', async () => {
    const client = new CdpClient();
    const lines = await captureAll(async () => {
      await assert.rejects(() => client.click('#btn'), /not connected/);
    });
    assertNoCdpClientLogs(lines);
  });

  it('focus when not connected throws without cdp-client logs', async () => {
    const client = new CdpClient();
    const lines = await captureAll(async () => {
      await assert.rejects(() => client.focus('#input'), /not connected/);
    });
    assertNoCdpClientLogs(lines);
  });

  it('exists when not connected throws without cdp-client logs', async () => {
    const client = new CdpClient();
    const lines = await captureAll(async () => {
      await assert.rejects(() => client.exists('#btn'), /not connected/);
    });
    assertNoCdpClientLogs(lines);
  });

  it('callFunction when not connected throws without cdp-client logs', async () => {
    const client = new CdpClient();
    const lines = await captureAll(async () => {
      await assert.rejects(() => client.callFunction(() => 1), /not connected/);
    });
    assertNoCdpClientLogs(lines);
  });

  it('typeText when not connected throws without cdp-client logs', async () => {
    const client = new CdpClient();
    const lines = await captureAll(async () => {
      await assert.rejects(() => client.typeText('hi'), /not connected/);
    });
    assertNoCdpClientLogs(lines);
  });

  it('evaluate prefers exception description over text when both present', async () => {
    await withConnectedClient((ws, msg) => {
      if (msg.id !== undefined) {
        replyOk(ws, msg.id, {
          exceptionDetails: {
            text: 'fallback text',
            exception: { description: 'TypeError: boom' },
          },
        });
      }
    }, async (client) => {
      const lines = await captureAll(async () => {
        await assert.rejects(() => client.evaluate('bad'), /TypeError: boom/);
      });
      assertNoCdpClientLogs(lines);
    });
  });

  it('send wire payload includes id method and params without cdp-client logs', async () => {
    const payloads: CdpReq[] = [];
    await withConnectedClient((ws, msg) => {
      payloads.push(msg);
      if (msg.id !== undefined) replyOk(ws, msg.id);
    }, async (client) => {
      const lines = await captureAll(async () => {
        await client.send('Page.navigate', { url: 'https://example.com' });
      });
      assert.equal(payloads.length, 1);
      assert.equal(payloads[0]?.id, 1);
      assert.equal(payloads[0]?.method, 'Page.navigate');
      assert.deepEqual(payloads[0]?.params, { url: 'https://example.com' });
      assertNoCdpClientLogs(lines);
    });
  });

  it('clickAtCoords mousePressed timeout logs CDP_TIMEOUT with Input.dispatchMouseEvent op', async () => {
    await withWss((ws) => wireHandler(ws, () => {}), async (wsUrl) => {
      const client = new CdpClient();
      await client.connect(wsUrl);
      await settle();
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const lines = await captureAll(async () => {
          const pending = client.clickAtCoords(9, 9);
          const rejectWatcher = assert.rejects(pending, /Input\.dispatchMouseEvent/);
          mock.timers.tick(10_000);
          await settle();
          await rejectWatcher;
        });
        assertCdpClientLog(lines, 'CDP_TIMEOUT', { op: 'Input.dispatchMouseEvent', durationMs: 10_000 });
      } finally {
        client.disconnect();
      }
    });
  });

  it('pre-connect failure logs exactly one CDP_CONNECT_FAIL line', async () => {
    const client = new CdpClient();
    const lines = await captureAll(async () => {
      await assert.rejects(() => client.connect('ws://127.0.0.1:1/devtools/page/dead'));
    });
    assert.equal(cdpClientOnly(lines).length, 1);
    assertCdpClientLog(lines, 'CDP_CONNECT_FAIL', { op: 'connect' });
  });

  it('connect success sets isConnected true without cdp-client logs', async () => {
    await withWss(noopWs, async (wsUrl) => {
      const client = new CdpClient();
      const lines = await captureAll(async () => {
        await client.connect(wsUrl);
      });
      assert.equal(client.isConnected(), true);
      assertNoCdpClientLogs(lines);
      client.disconnect();
    });
  });
});

describe('cdp-client logging coverage', () => {
  it('path matrix rows map to behavioral test titles', () => {
    const src = readFileSync(new URL('./cdp-client-logging.test.ts', import.meta.url), 'utf-8');
    for (const row of CDP_CLIENT_PATH_MATRIX) {
      assert.ok(src.includes(row.marker), `matrix row missing test: ${row.marker}`);
    }
    assert.equal(CDP_CLIENT_PATH_MATRIX.length, 68);
  });

  it('silent path markers appear in behavioral it() titles', () => {
    const src = readFileSync(new URL('./cdp-client-logging.test.ts', import.meta.url), 'utf-8');
    for (const marker of SILENT_PATH_MARKERS) {
      assert.ok(src.includes(marker), `missing silent marker: ${marker}`);
    }
  });

  it('every covered code has assertCdpClientLog in behavioral tests', () => {
    const src = readFileSync(new URL('./cdp-client-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of CDP_CLIENT_LOG_CODES) {
      assert.ok(src.includes(`assertCdpClientLog(lines, '${code}'`), `behavioral missing ${code}`);
    }
  });

  it('automated matrix log codes have behavioral assertCdpClientLog', () => {
    const codes = CDP_CLIENT_PATH_MATRIX.filter((r) => r.kind !== 'silent').map((r) =>
      'code' in r ? r.code : '',
    );
    const unique = [...new Set(codes.filter(Boolean))];
    const src = readFileSync(new URL('./cdp-client-logging.test.ts', import.meta.url), 'utf-8');
    for (const code of unique) {
      assert.ok(src.includes(`assertCdpClientLog(lines, '${code}'`), `matrix code missing assert: ${code}`);
    }
    assert.equal(unique.length, 3);
  });

  it('cdpCtx returns scope cdp in source', () => {
    const zone = cdpClientZoneSrc();
    assert.match(zone, /function cdpCtx\(op: string/);
    assert.match(zone, /return \{ scope: 'cdp', op, \.\.\.extra \}/);
  });

  it('logging zone has exactly three log emission sites in source', () => {
    const zone = cdpClientZoneSrc();
    assert.match(zone, /logError\('CDP_CONNECT_FAIL'/);
    assert.match(zone, /logError\('CDP_WS_ERROR'/);
    assert.match(zone, /logWarn\('CDP_TIMEOUT'/);
    assert.equal((zone.match(/log(Error|Warn|Info)\(/g) ?? []).length, 3);
  });

  it('logging zone has zero console.log calls in source', () => {
    const zone = cdpClientZoneSrc();
    assert.ok(!zone.includes('console.log'));
    assert.ok(!zone.includes('console.warn'));
    assert.ok(!zone.includes('console.error'));
  });

  it('CONNECT_FAIL guarded by not connected branch in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async connect'), zone.indexOf('disconnect():'));
    assert.match(body, /if \(!this\._connected\) \{[\s\S]*?logError\('CDP_CONNECT_FAIL'/);
    assert.match(body, /logError\('CDP_WS_ERROR'/);
  });

  it('DEFAULT_TIMEOUT_MS is 10000 in source', () => {
    const src = readFileSync(new URL('../../src/ide/cdp-client.ts', import.meta.url), 'utf-8');
    assert.match(src, /const DEFAULT_TIMEOUT_MS = 10000/);
  });

  it('CDP_TIMEOUT passes method as op and durationMs in cdpCtx in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async send'), zone.indexOf('async evaluate'));
    assert.match(body, /cdpCtx\(method, \{ durationMs: timeoutMs \}\)/);
    assert.match(body, /CDP timeout for \$\{method\} \(\$\{timeoutMs\}ms\)/);
  });

  it('rejectAllPending invoked from disconnect and close handlers in source', () => {
    const zone = cdpClientZoneSrc();
    assert.match(zone, /this\.rejectAllPending\('Intentional disconnect'\)/);
    assert.match(zone, /this\.rejectAllPending\('WebSocket closed'\)/);
  });

  it('handleMessage ignores invalid JSON silently in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('private handleMessage'));
    assert.match(body, /catch \{[\s\S]*?return;/);
  });

  it('callFunction injects __name shim before fn.toString in source', () => {
    const zone = cdpClientZoneSrc();
    assert.match(zone, /var __name = function\(fn, _n\)\{ return fn; \};/);
    assert.match(zone, /\(\$\{fn\.toString\(\)\}\)/);
  });

  it('every log site passes cdpCtx helper in source', () => {
    const zone = cdpClientZoneSrc();
    const sites = zone.match(/log(Error|Warn)\([\s\S]*?\);/g) ?? [];
    assert.equal(sites.length, 3);
    for (const site of sites) {
      assert.match(site, /cdpCtx\(/);
    }
  });

  it('connect open handler sets _connected before resolve in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async connect'), zone.indexOf('disconnect():'));
    assert.match(body, /this\._connected = true[\s\S]*?resolve\(\)/);
  });

  it('close handler emits disconnected only when wasConnected in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async connect'), zone.indexOf('disconnect():'));
    assert.match(body, /const wasConnected = this\._connected/);
    assert.match(body, /if \(wasConnected\) \{[\s\S]*?this\.emit\('disconnected'\)/);
  });

  it('send throws before scheduling timeout when not connected in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async send'), zone.indexOf('async evaluate'));
    assert.match(body, /if \(!this\.ws \|\| !this\._connected\) \{[\s\S]*?throw new Error\('CDP client not connected'\)/);
    const throwIdx = body.indexOf("throw new Error('CDP client not connected')");
    const timeoutIdx = body.indexOf('setTimeout');
    assert.ok(throwIdx >= 0 && throwIdx < timeoutIdx);
  });

  it('evaluate exceptionDetails prefers exception description in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async evaluate'), zone.indexOf('async callFunction'));
    assert.match(body, /exceptionDetails\.exception\?\.description/);
    assert.match(body, /exceptionDetails\.text/);
  });

  it('WebSocket imported from ws package in source', () => {
    const src = readFileSync(new URL('../../src/ide/cdp-client.ts', import.meta.url), 'utf-8');
    assert.match(src, /import \{ WebSocket \} from 'ws'/);
  });

  it('pending timer cleared when matching response arrives in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('private handleMessage'));
    assert.match(body, /clearTimeout\(pending\.timer\)/);
  });

  it('evaluate Runtime.evaluate params include returnByValue and awaitPromise in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async evaluate'), zone.indexOf('async callFunction'));
    assert.match(body, /returnByValue: true/);
    assert.match(body, /awaitPromise: true/);
  });

  it('CONNECT_FAIL logs err.message directly without WebSocket prefix in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async connect'), zone.indexOf('disconnect():'));
    assert.match(body, /logError\('CDP_CONNECT_FAIL', err\.message/);
    assert.match(body, /logError\('CDP_WS_ERROR', `WebSocket error: \$\{err\.message\}`/);
  });

  it('timeout handler deletes pending before logWarn CDP_TIMEOUT in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async send'), zone.indexOf('async evaluate'));
    const timeoutBody = body.slice(body.indexOf('setTimeout'));
    assert.match(timeoutBody, /this\.pending\.delete\(id\)/);
    assert.ok(timeoutBody.indexOf('this.pending.delete(id)') < timeoutBody.indexOf("logWarn('CDP_TIMEOUT'"));
  });

  it('callFunctionWithTimeout duplicates __name shim expression path in source', () => {
    const zone = cdpClientZoneSrc();
    const fnBody = zone.slice(zone.indexOf('async callFunction('), zone.indexOf('async click('));
    assert.match(fnBody, /async callFunctionWithTimeout/);
    assert.equal((fnBody.match(/var __name = function\(fn, _n\)\{ return fn; \};/g) ?? []).length, 2);
  });

  it('disconnect nulls ws after close in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('disconnect():'), zone.indexOf('isConnected():'));
    assert.match(body, /this\.ws\.close\(\)/);
    assert.match(body, /this\.ws = null/);
  });

  it('send increments nextId per outbound message in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async send'), zone.indexOf('async evaluate'));
    assert.match(body, /const id = this\.nextId\+\+/);
  });

  it('handleMessage emits event for method even when id response handled in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('private handleMessage'));
    const resolveIdx = body.indexOf('pending.resolve');
    const emitIdx = body.indexOf("this.emit('event'");
    assert.ok(resolveIdx >= 0 && emitIdx > resolveIdx);
  });

  it('sleep helper lives outside logging zone in source', () => {
    const src = readFileSync(new URL('../../src/ide/cdp-client.ts', import.meta.url), 'utf-8');
    assert.ok(src.indexOf('function sleep') > src.indexOf('function cdpCtx'));
    assert.ok(!cdpClientZoneSrc().includes('function sleep'));
  });

  it('logging zone imports logError and logWarn only not logInfo in source', () => {
    const src = readFileSync(new URL('../../src/ide/cdp-client.ts', import.meta.url), 'utf-8');
    const zone = cdpClientZoneSrc();
    assert.match(src, /import \{ logError, logWarn \}/);
    assert.ok(!zone.includes('logInfo'));
  });

  it('typeText sends Input.insertText without await delay in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async typeText'), zone.indexOf('async pressKey'));
    assert.match(body, /async typeText\(text: string, _delayMs = 0\)/);
    assert.match(body, /await this\.send\('Input\.insertText', \{ text \}\)/);
    assert.ok(!body.includes('setTimeout'));
    assert.ok(!body.includes('sleep('));
  });

  it('CdpClient extends EventEmitter in source', () => {
    const zone = cdpClientZoneSrc();
    assert.match(zone, /export class CdpClient extends EventEmitter/);
  });

  it('connect message handler parses data.toString before handleMessage in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async connect'), zone.indexOf('disconnect():'));
    assert.match(body, /this\.handleMessage\(data\.toString\(\)\)/);
  });

  it('close handler sets _connected false before rejectAllPending in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async connect'), zone.indexOf('disconnect():'));
    const closeBody = body.slice(body.indexOf("this.ws.on('close'"));
    assert.match(closeBody, /this\._connected = false[\s\S]*?this\.rejectAllPending\('WebSocket closed'\)/);
  });

  it('rejectAllPending clears timer before reject in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('private rejectAllPending'));
    assert.match(body, /clearTimeout\(pending\.timer\)[\s\S]*?pending\.reject/);
  });

  it('handleMessage resolves pending with empty object when result missing in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('private handleMessage'));
    assert.match(body, /pending\.resolve\(msg\.result \?\? \{\}\)/);
  });

  it('pressKey dispatches keyDown before keyUp in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async pressKey'), zone.indexOf('async clickAtCoords'));
    const downIdx = body.indexOf("dispatchKeyEvent('keyDown'");
    const upIdx = body.indexOf("dispatchKeyEvent('keyUp'");
    assert.ok(downIdx >= 0 && upIdx > downIdx);
  });

  it('clickAtCoords sends mousePressed before mouseReleased in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async clickAtCoords'), zone.indexOf('async exists'));
    const downIdx = body.indexOf("'mousePressed'");
    const upIdx = body.indexOf("'mouseReleased'");
    assert.ok(downIdx >= 0 && upIdx > downIdx);
  });

  it('click embeds selector via JSON.stringify in evaluate expression in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async click('), zone.indexOf('async focus('));
    assert.match(body, /document\.querySelector\(\$\{JSON\.stringify\(selector\)\}\)/);
  });

  it('dispatchKeyEvent spreads options into send params in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async dispatchKeyEvent'), zone.indexOf('async typeText'));
    assert.match(body, /await this\.send\('Input\.dispatchKeyEvent', \{ type, \.\.\.options \}\)/);
  });

  it('evaluate prefers exception description before text via nullish coalesce in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async evaluate'), zone.indexOf('async callFunction'));
    const descIdx = body.indexOf('exceptionDetails.exception?.description');
    const textIdx = body.indexOf('exceptionDetails.text');
    assert.ok(descIdx >= 0 && textIdx > descIdx);
    assert.match(body, /\?\? exceptionDetails\.text/);
  });

  it('focus embeds selector via JSON.stringify in evaluate expression in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async focus('), zone.indexOf('async dispatchKeyEvent'));
    assert.match(body, /document\.querySelector\(\$\{JSON\.stringify\(selector\)\}\)/);
  });

  it('exists uses evaluate with querySelector JSON.stringify in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async exists'), zone.indexOf('private handleMessage'));
    assert.match(body, /document\.querySelector\(\$\{JSON\.stringify\(selector\)\}\)/);
  });

  it('send serializes outbound payload via JSON.stringify in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async send'), zone.indexOf('async evaluate'));
    assert.match(body, /this\.ws!\.send\(JSON\.stringify\(\{ id, method, params \}\)\)/);
  });

  it('connect registers open error message and close handlers on ws in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async connect'), zone.indexOf('disconnect():'));
    assert.match(body, /this\.ws\.on\('open'/);
    assert.match(body, /this\.ws\.on\('error'/);
    assert.match(body, /this\.ws\.on\('message'/);
    assert.match(body, /this\.ws\.on\('close'/);
  });

  it('disconnect sets _connected false before rejectAllPending in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('disconnect():'), zone.indexOf('isConnected():'));
    assert.match(body, /this\._connected = false[\s\S]*?this\.rejectAllPending\('Intentional disconnect'\)/);
  });

  it('handleMessage uses pending.has guard before pending.get in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('private handleMessage'));
    assert.match(body, /if \(msg\.id !== undefined && this\.pending\.has\(msg\.id\)\)/);
    assert.match(body, /this\.pending\.get\(msg\.id\)!/);
  });

  it('LogContext type imported from log-event in source', () => {
    const src = readFileSync(new URL('../../src/ide/cdp-client.ts', import.meta.url), 'utf-8');
    assert.match(src, /import type \{ LogContext \} from '\.\.\/core\/log-event\.js'/);
  });

  it('nextId initializes to 1 in source', () => {
    const zone = cdpClientZoneSrc();
    assert.match(zone, /private nextId = 1/);
  });

  it('click scrollIntoView uses behavior instant in source', () => {
    const zone = cdpClientZoneSrc();
    const body = zone.slice(zone.indexOf('async click('), zone.indexOf('async focus('));
    assert.match(body, /scrollIntoView\(\{ block: 'center', behavior: 'instant' \}\)/);
  });

  it('logging zone has no rid or newRid in log sites in source', () => {
    const zone = cdpClientZoneSrc();
    assert.ok(!zone.includes('newRid'));
    assert.ok(!zone.includes('rid='));
  });
});
