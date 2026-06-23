import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

const DEFAULT_TIMEOUT_MS = 10000;

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: string };
}

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Lightweight CDP client connecting directly to page target WebSocket endpoint.
 * Bypasses browser-level Target.getBrowserContexts which blocks Electron/Cursor.
 */
export class CdpClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private _connected = false;

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this._connected = true;
        resolve();
      });

      this.ws.on('error', (err) => {
        if (!this._connected) {
          reject(err);
        } else {
          console.error('[cdp-client] WebSocket error:', err.message);
        }
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', () => {
        const wasConnected = this._connected;
        this._connected = false;
        this.rejectAllPending('WebSocket closed');
        if (wasConnected) {
          this.emit('disconnected');
        }
      });
    });
  }

  disconnect(): void {
    this._connected = false;
    this.rejectAllPending('Intentional disconnect');
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this._connected;
  }

  /**
   * Sends raw CDP command and waits for response.
   */
  async send(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<Record<string, unknown>> {
    if (!this.ws || !this._connected) {
      throw new Error('CDP client not connected');
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout for ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluates JavaScript expression in page context.
   * Returns deserialized value.
   */
  async evaluate(expression: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs);

    const exceptionDetails = result.exceptionDetails as
      | { text?: string; exception?: { description?: string } }
      | undefined;
    if (exceptionDetails) {
      const msg = exceptionDetails.exception?.description
        ?? exceptionDetails.text
        ?? 'Evaluation failed';
      throw new Error(msg);
    }

    const remoteObj = result.result as { value?: unknown } | undefined;
    return remoteObj?.value;
  }

  /**
   * Serializes function and args, then evaluate in page context.
   * Function must be self-contained (no closures over Node.js variables).
   *
   * Injects __name shim because tsx/esbuild wraps named functions with
   * __name() calls missing in the target page context.
   */
  async callFunction(
    fn: (...args: never[]) => unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    const argStr = args.map(a => JSON.stringify(a)).join(', ');
    const shim = 'var __name = function(fn, _n){ return fn; };';
    const expression = `${shim}(${fn.toString()})(${argStr})`;
    return this.evaluate(expression);
  }

  async callFunctionWithTimeout(
    fn: (...args: never[]) => unknown,
    args: unknown[],
    timeoutMs: number
  ): Promise<unknown> {
    const argStr = args.map(a => JSON.stringify(a)).join(', ');
    const shim = 'var __name = function(fn, _n){ return fn; };';
    const expression = `${shim}(${fn.toString()})(${argStr})`;
    return this.evaluate(expression, timeoutMs);
  }

  /**
   * Click element by CSS selector.
   * Via evaluate scrolls into view and dispatches click.
   */
  async click(selector: string): Promise<void> {
    const clicked = await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.click();
        return true;
      })()
    `);
    if (!clicked) {
      throw new Error(`Element not found: ${selector}`);
    }
  }

  /**
   * Focus element by CSS selector.
   */
  async focus(selector: string): Promise<void> {
    const focused = await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        return true;
      })()
    `);
    if (!focused) {
      throw new Error(`Element not found for focus: ${selector}`);
    }
  }

  /**
   * Dispatch key event (keyDown, keyUp, char) via Input domain.
   */
  async dispatchKeyEvent(
    type: 'keyDown' | 'keyUp' | 'char',
    options: {
      key?: string;
      code?: string;
      text?: string;
      unmodifiedText?: string;
      windowsVirtualKeyCode?: number;
      nativeVirtualKeyCode?: number;
      modifiers?: number;
    } = {}
  ): Promise<void> {
    await this.send('Input.dispatchKeyEvent', { type, ...options });
  }

  /**
   * Inserts text via Input.insertText — one CDP call, no double characters.
   */
  async typeText(text: string, _delayMs = 0): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  /**
   * Press special key (Enter, Backspace, etc.).
   */
  async pressKey(
    key: string,
    code: string,
    keyCode: number,
    modifiers = 0
  ): Promise<void> {
    await this.dispatchKeyEvent('keyDown', {
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
    await this.dispatchKeyEvent('keyUp', {
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
  }

  /**
   * Click viewport coordinates via native CDP mouse events.
   */
  async clickAtCoords(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  /**
   * Checks element presence on page.
   */
  async exists(selector: string): Promise<boolean> {
    return (await this.evaluate(
      `document.querySelector(${JSON.stringify(selector)}) !== null`
    )) as boolean;
  }

  private handleMessage(raw: string): void {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }

    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);

      if (msg.error) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result ?? {});
      }
    }

    if (msg.method) {
      this.emit('event', msg.method, msg.params);
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
