import express from 'express';
import { createServer } from 'http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import type { ServerConfig, CursorState, CommandPayload, CommandResult } from '../core/types.js';
import type { StateManager } from '../state/broadcast.js';
import { getServerBuildInfo } from '../core/build-meta.js';
import { getCursorUpgradeHealthPayload } from '../core/cursor-upgrade-advisory.js';
import { getDataDir } from '../core/paths.js';
import { readWebTunnelUrl } from './tunnel.js';
import type { CommandExecutor } from '../ide/actions/navigation.js';
import type { CDPBridge } from '../ide/cdp-session.js';
import type { WindowMonitor } from '../state/windows.js';
import { decodeWebUploadToPaths } from '../media/inbound-images.js';
import { markdownToWebHtml, readPlanFile } from './plans.js';
import {
  WEBAPP_SESSION_COOKIE,
  createWebappSessionStore,
  parseSessionCookie,
  type WebappSessionStore,
} from './sessions.js';
import { readWebSettingsRecord, writeWebSettingsRecord } from './settings-api.js';
import { isTelegramPollActive } from './poll-status.js';
import { getLocale, t } from '../i18n/t.js';
import { logError, logInfo, logWarn } from '../core/log-event.js';
import type { LogContext } from '../core/log-event.js';

function relayCtx(op: string, extra?: Omit<LogContext, 'scope'>): LogContext {
  return { scope: 'relay', op, ...extra };
}

function logRelayCmd(op: string, message: string, extra?: Omit<LogContext, 'scope'>): void {
  logInfo('RELAY_CMD_OK', message, relayCtx(op, extra));
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Fresh ?v= for app.js/css — manifest from disk, not process cache (mobile after build). */
function readClientAssetCacheBust(): string {
  try {
    const path = join(__dirname, 'build-manifest.json');
    if (!existsSync(path)) return Date.now().toString(36);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
      version?: string;
      builtAt?: string;
      bundleSha256?: string;
    };
    const ver = raw.version ?? '0';
    const builtAt = raw.builtAt ? Date.parse(raw.builtAt) : NaN;
    if (!Number.isNaN(builtAt)) return `${ver}-${builtAt.toString(36)}`;
    const sha = raw.bundleSha256?.slice(0, 10) ?? '';
    return sha ? `${ver}-${sha}` : ver;
  } catch {
    return Date.now().toString(36);
  }
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, interactive-widget=resizes-content">
  <meta name="theme-color" content="#000000">
  <title>Cursor Handoff — Sign in</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --login-bg: #000000;
      --login-teal: #269199;
      --login-teal-hover: #228389;
      --login-text: #ffffff;
      --login-muted: #888888;
      --login-input-bg: #121212;
      --login-input-border: #333333;
      --login-icon: #666666;
    }
    body {
      background: var(--login-bg);
      color: var(--login-text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
    }
    .login-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: max(24px, env(safe-area-inset-top)) max(32px, env(safe-area-inset-right))
        24px max(32px, env(safe-area-inset-left));
      width: 100%;
    }
    .login-stack {
      width: 100%;
      max-width: 320px;
    }
    .login-brand {
      text-align: center;
      margin-bottom: 28px;
    }
    .login-mark {
      display: block;
      width: 88px;
      height: 88px;
      margin: 0 auto 16px;
    }
    .login-logo {
      font-size: 28px;
      font-weight: 700;
      line-height: 1.2;
      text-align: center;
      letter-spacing: -0.02em;
    }
    .login-logo .logo-handoff { color: var(--login-teal); }
    .login-subtitle {
      font-size: 14px;
      color: var(--login-muted);
      text-align: center;
      margin-bottom: 28px;
    }
    .password-field {
      position: relative;
      display: flex;
      align-items: center;
    }
    .password-field .field-icon {
      position: absolute;
      left: 14px;
      color: var(--login-icon);
      pointer-events: none;
      display: flex;
    }
    .password-field input {
      width: 100%;
      height: 48px;
      padding: 0 44px;
      font-size: 15px;
      color: var(--login-text);
      background: var(--login-input-bg);
      border: 1px solid var(--login-input-border);
      border-radius: 8px;
      outline: none;
    }
    .password-field input::placeholder { color: #666666; }
    .password-field input:focus { border-color: #444444; }
    .password-toggle {
      position: absolute;
      right: 4px;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: transparent;
      color: var(--login-icon);
      cursor: pointer;
      padding: 0;
    }
    .password-toggle:hover { color: #888888; }
    .password-toggle svg { display: none; }
    .password-toggle svg.is-visible { display: block; }
    .btn-sign-in {
      width: 100%;
      height: 48px;
      margin-top: 16px;
      font-size: 16px;
      font-weight: 600;
      color: #ffffff;
      background: var(--login-teal);
      border: none;
      border-radius: 8px;
      cursor: pointer;
    }
    .btn-sign-in:hover { background: var(--login-teal-hover); }
    .btn-sign-in:disabled { opacity: 0.55; cursor: not-allowed; }
    .login-error {
      color: #e34671;
      font-size: 13px;
      margin-top: 14px;
      text-align: center;
      display: none;
    }
    .login-footer {
      text-align: center;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.32);
      padding: 20px 16px max(28px, env(safe-area-inset-bottom));
    }
  </style>
</head>
<body>
  <div class="login-main">
    <div class="login-stack">
      <div class="login-brand">
        <img class="login-mark" src="/login-icon.png" width="88" height="88" alt="">
        <h1 class="login-logo"><span class="logo-cursor">Cursor</span> <span class="logo-handoff">Handoff</span></h1>
      </div>
      <p class="login-subtitle">Enter web client password</p>
      <form id="form">
        <div class="password-field">
          <span class="field-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="5" y="11" width="14" height="10" rx="2"/>
              <path d="M8 11V8a4 4 0 0 1 8 0v3"/>
            </svg>
          </span>
          <input type="password" id="pw" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
          <button type="button" class="password-toggle" id="toggle-pw" aria-label="Show password">
            <svg id="icon-eye-off" class="is-visible" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
              <path d="M1 1l22 22"/>
              <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>
            </svg>
            <svg id="icon-eye-on" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
        <button type="submit" class="btn-sign-in" id="btn">Sign in</button>
        <p class="login-error" id="err"></p>
      </form>
    </div>
  </div>
  <p class="login-footer">Local access only</p>
  <script>
    const form = document.getElementById('form');
    const pw = document.getElementById('pw');
    const btn = document.getElementById('btn');
    const err = document.getElementById('err');
    const togglePw = document.getElementById('toggle-pw');
    const iconEyeOff = document.getElementById('icon-eye-off');
    const iconEyeOn = document.getElementById('icon-eye-on');
    togglePw.addEventListener('click', () => {
      const show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      iconEyeOff.classList.toggle('is-visible', !show);
      iconEyeOn.classList.toggle('is-visible', show);
      togglePw.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      err.style.display = 'none';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw.value }),
        });
        const data = await res.json();
        if (res.ok && data.token) {
          localStorage.setItem('cursor-handoff-token', data.token);
          window.location.href = '/';
        } else {
          err.textContent = data.error || 'Wrong password';
          err.style.display = 'block';
        }
      } catch {
        err.textContent = 'Network error';
        err.style.display = 'block';
      }
      btn.disabled = false;
    });
  </script>
</body>
</html>`;

export class Relay {
  private config: ServerConfig;
  private app: express.Application;
  private httpServer: ReturnType<typeof createServer>;
  private io: SocketServer;
  private stateManager: StateManager;
  private commandExecutor: CommandExecutor;
  private cdpBridge: CDPBridge;

  private sessionStore: WebappSessionStore;
  private loginAttempts = new Map<string, RateLimitEntry>();
  private shutdownHooks?: {
    extractNow: () => Promise<void>;
    flushTelegram: () => Promise<void>;
  };
  private telegramTopicLink?: () => string | null;
  private windowMonitor?: WindowMonitor;

  /** Max-Age for session cookie (30 days), typical "stay signed in". */
  private static readonly SESSION_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;

  private get authEnabled(): boolean {
    return this.config.webappPassword.length > 0;
  }

  setShutdownHooks(hooks: {
    extractNow: () => Promise<void>;
    flushTelegram: () => Promise<void>;
  }): void {
    this.shutdownHooks = hooks;
  }

  setTelegramTopicResolver(resolver: () => string | null): void {
    this.telegramTopicLink = resolver;
  }

  setWindowMonitor(monitor: WindowMonitor): void {
    this.windowMonitor = monitor;
  }

  private resolveActiveWorkspacePath(): string | undefined {
    const state = this.stateManager.getCurrentState();
    return this.windowMonitor?.getSnapshot(state.activeWindowId)?.workspacePath;
  }

  constructor(
    config: ServerConfig,
    stateManager: StateManager,
    commandExecutor: CommandExecutor,
    cdpBridge: CDPBridge
  ) {
    this.config = config;
    this.stateManager = stateManager;
    this.commandExecutor = commandExecutor;
    this.cdpBridge = cdpBridge;
    this.sessionStore = createWebappSessionStore(config.dataDir);

    this.app = express();
    this.httpServer = createServer(this.app);
    this.io = new SocketServer(this.httpServer, {
      serveClient: false,
      maxHttpBufferSize: 25e6,
      // Client is served from the same host:port — no cross-origin needed.
      cors: {
        origin: false,
        methods: ['GET', 'POST'],
        credentials: true,
      },
    });

    this.setupRoutes();
    this.setupSocketHandlers();
    this.setupStateForwarding();

    if (this.authEnabled) {
      logInfo('RELAY_AUTH_ENABLED', 'Web app password protection enabled', relayCtx('auth'));
    }
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.serverPort, this.config.serverHost, () => {
        logInfo(
          'RELAY_LISTEN',
          `http://${this.config.serverHost}:${this.config.serverPort}`,
          relayCtx('listen'),
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.io.close();
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  private getClientIp(req: express.Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress ?? 'unknown';
  }

  private checkRateLimit(ip: string): { allowed: boolean; retryAfter: number } {
    const now = Date.now();
    const entry = this.loginAttempts.get(ip);

    if (!entry || now >= entry.resetAt) {
      this.loginAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
      return { allowed: true, retryAfter: 0 };
    }

    if (entry.count >= 10) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      return { allowed: false, retryAfter };
    }

    entry.count++;
    return { allowed: true, retryAfter: 0 };
  }

  /** First matching credential from persisted session store. */
  private resolveHttpSession(req: express.Request): string | undefined {
    if (!this.authEnabled) return undefined;
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const t = authHeader.slice(7).trim();
      if (this.sessionStore.has(t)) return t;
    }
    const fromCookie = parseSessionCookie(req.headers.cookie, WEBAPP_SESSION_COOKIE);
    if (fromCookie && this.sessionStore.has(fromCookie)) return fromCookie;
    return undefined;
  }

  private resolveSocketSession(socket: Socket): string | undefined {
    if (!this.authEnabled) return undefined;
    const raw = socket.handshake.auth?.token;
    const bearer = typeof raw === 'string' ? raw.trim() : '';
    if (bearer && this.sessionStore.has(bearer)) return bearer;
    const cookieHeader = socket.handshake.headers.cookie;
    const fromCookie = parseSessionCookie(
      typeof cookieHeader === 'string' ? cookieHeader : undefined,
      WEBAPP_SESSION_COOKIE
    );
    if (fromCookie && this.sessionStore.has(fromCookie)) return fromCookie;
    return undefined;
  }

  private setupRoutes(): void {
    const clientDir = join(__dirname, '..', 'client');
    const localesDir = join(dirname(getDataDir()), 'locales');
    if (existsSync(localesDir)) {
      this.app.use('/locales', express.static(localesDir, { etag: true }));
    }

    this.app.use(express.json({ limit: '25mb' }));

    this.app.get('/login', (_req, res) => {
      if (!this.authEnabled) return res.redirect('/');
      res.type('html').send(LOGIN_PAGE_HTML);
    });

    this.app.get('/login-icon.png', (_req, res) => {
      res.sendFile(join(clientDir, 'login-icon.png'));
    });

    this.app.post('/api/login', (req, res) => {
      if (!this.authEnabled) return res.json({ token: 'no-auth' });

      const ip = this.getClientIp(req);
      const { allowed, retryAfter } = this.checkRateLimit(ip);
      if (!allowed) {
        logWarn('RELAY_AUTH_RATE_LIMIT', `Rate limited login from ${ip}`, relayCtx('login', { hint: ip }));
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: `Too many attempts. Retry in ${retryAfter} s.` });
      }

      const password = req.body?.password;
      if (typeof password !== 'string' || password.length === 0) {
        return res.status(400).json({ error: 'Password required' });
      }

      const expected = Buffer.from(this.config.webappPassword);
      const received = Buffer.from(password);
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
        logWarn('RELAY_AUTH_FAIL', `Failed login attempt from ${ip}`, relayCtx('login', { hint: ip }));
        return res.status(401).json({ error: 'Wrong password' });
      }

      const token = randomBytes(32).toString('hex');
      this.sessionStore.add(token);
      logInfo('RELAY_AUTH_OK', `login from ${ip}`, relayCtx('login', { hint: ip }));
      res.setHeader(
        'Set-Cookie',
        [
          `${WEBAPP_SESSION_COOKIE}=${token}`,
          'HttpOnly',
          'Path=/',
          'SameSite=Lax',
          `Max-Age=${Relay.SESSION_COOKIE_MAX_AGE_SEC}`,
        ].join('; ')
      );
      return res.json({ token });
    });

    this.app.post('/api/logout', (req, res) => {
      const token = this.resolveHttpSession(req);
      if (token) this.sessionStore.remove(token);
      res.setHeader(
        'Set-Cookie',
        [
          `${WEBAPP_SESSION_COOKIE}=`,
          'HttpOnly',
          'Path=/',
          'SameSite=Lax',
          'Max-Age=0',
        ].join('; ')
      );
      res.json({ ok: true });
    });

    this.app.post('/shutdown/flush', async (req, res) => {
      const ip = req.socket.remoteAddress ?? '';
      const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!local) {
        res.status(403).json({ error: 'localhost only' });
        return;
      }
      try {
        if (this.shutdownHooks) {
          await this.shutdownHooks.extractNow();
          await new Promise((r) => setTimeout(r, 600));
          await this.shutdownHooks.flushTelegram();
        }
        res.json({ ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError('RELAY_SHUTDOWN_FAIL', `Shutdown hook failed: ${msg}`, relayCtx('shutdown'));
        res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    this.app.get('/health', (req, res) => {
      const state = this.stateManager.getCurrentState();
      const sessionOk = !this.authEnabled || this.resolveHttpSession(req) !== undefined;
      const build = getServerBuildInfo();
      const cursorUpgrade = getCursorUpgradeHealthPayload(getDataDir(), build);
      // Without session — liveness only (CursorWake and redeploy check).
      // State details (windows, tabs, approvals) — valid session only.
      res.json({
        ok: true,
        build: build ?? undefined,
        ...cursorUpgrade,
        authRequired: this.authEnabled,
        sessionValid: sessionOk,
        webTunnelUrl: readWebTunnelUrl(getDataDir()),
        connected: state.connected,
        extractorStatus: state.extractorStatus,
        telegramEnabled: Boolean(this.config.telegram.enabled && this.config.telegram.botToken),
        telegramPoll: isTelegramPollActive(),
        uptime: process.uptime(),
        generation: this.stateManager.generation,
        locale: getLocale(),
        ...(sessionOk ? {
          lastExtractionAt: state.lastExtractionAt,
          consecutiveExtractionFailures: state.consecutiveExtractionFailures,
          lastExtractionError: state.lastExtractionError,
          agentStatus: state.agentStatus,
          clients: this.io.engine.clientsCount,
          windows: state.windows,
          activeWindowId: state.activeWindowId,
          mode: state.mode?.current ?? null,
          model: state.model?.current ?? null,
          chatTabCount: state.chatTabs?.length ?? 0,
          pendingApprovalCount: state.pendingApprovals?.length ?? 0,
          telegramTopicUrl: this.telegramTopicLink?.() ?? null,
        } : {}),
      });
    });

    this.app.get('/debug/state', (req, res) => {
      if (this.authEnabled && this.resolveHttpSession(req) === undefined) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const state = this.stateManager.getCurrentState();
      res.json({
        activeWindowId: state.activeWindowId,
        agentStatus: state.agentStatus,
        agentActivityText: state.agentActivityText,
        agentActivityLive: state.agentActivityLive,
        pendingApprovals: state.pendingApprovals,
        chatTabs: state.chatTabs.map((t) => ({
          isActive: t.isActive,
          title: t.title,
          composerId: t.composerId.substring(0, 16),
        })),
        windows: state.windows.map((w) => ({ id: w.id.substring(0, 8), title: w.title })),
        messageCount: state.messages.length,
        lastMessages: state.messages.slice(-3).map((m) => ({
          type: m.type,
          flatIndex: m.flatIndex,
          ...(m.type === 'tool' || m.type === 'run_command' ? {
            actions: 'actions' in m ? m.actions?.length ?? 0 : 0,
          } : {}),
        })),
        generation: this.stateManager.generation,
      });
    });

    this.app.get('/api/web-settings', (req, res) => {
      if (this.authEnabled && this.resolveHttpSession(req) === undefined) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const record = readWebSettingsRecord();
      res.json(record ?? { updatedAt: 0, settings: {} });
    });

    this.app.put('/api/web-settings', (req, res) => {
      if (this.authEnabled && this.resolveHttpSession(req) === undefined) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const settings = req.body?.settings;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        res.status(400).json({ error: 'settings object required' });
        return;
      }
      const saved = writeWebSettingsRecord(settings);
      res.json(saved);
    });

    // Auth middleware BEFORE index.html and static — otherwise client code is served without session.
    const authMiddleware: express.RequestHandler = (req, res, next) => {
      if (!this.authEnabled) return next();

      if (this.resolveHttpSession(req)) return next();

      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return res.redirect('/login');
    };
    this.app.use(authMiddleware);

    this.app.get('/', (_req, res) => {
      const cacheBust = readClientAssetCacheBust();
      const htmlPath = join(clientDir, 'index.html');
      try {
        let html = readFileSync(htmlPath, 'utf-8');
        html = html.replace(/(src|href)="([^"]+)\.(js|css)"/g, `$1="$2.$3?v=${cacheBust}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.type('html').send(html);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError('RELAY_CLIENT_FAIL', `Failed to serve index.html: ${msg}`, relayCtx('serve_client'));
        res.status(500).send('Client files not found');
      }
    });

    this.app.use(express.static(clientDir, {
      etag: true,
      lastModified: true,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      },
    }));
  }

  private setupSocketHandlers(): void {
    if (this.authEnabled) {
      this.io.use((socket, next) => {
        const resolved = this.resolveSocketSession(socket);
        if (resolved) return next();
        const raw = socket.handshake.auth?.token;
        const hint =
          typeof raw === 'string' && raw.length > 0
            ? raw.slice(0, 8) + '...'
            : parseSessionCookie(
                typeof socket.handshake.headers.cookie === 'string'
                  ? socket.handshake.headers.cookie
                  : undefined,
                WEBAPP_SESSION_COOKIE
              )
              ? 'cookie-present'
              : 'empty';
        logWarn('RELAY_AUTH_REJECT', `Socket.io auth rejected (${socket.id}) — ${hint}`, relayCtx('socket_auth', { hint }));
        next(new Error('Unauthorized'));
      });
    }

    this.io.on('connection', (socket) => {
      logInfo('RELAY_SOCKET_CONNECT', socket.id, relayCtx('socket', { hint: socket.id }));

      socket.emit('state:full', this.stateManager.getCurrentState());

      socket.on('command:send_message', async (payload: CommandPayload) => {
        const text = (payload.text ?? '').trim();
        const hasImages = Array.isArray(payload.images) && payload.images.length > 0;
        const hasFiles = Array.isArray(payload.files) && payload.files.length > 0;
        if (!payload.commandId || (!text && !hasImages && !hasFiles)) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or content',
          } satisfies CommandResult);
          return;
        }

        if (hasImages || hasFiles) {
          const decoded = decodeWebUploadToPaths(
            payload.images,
            payload.files,
            this.resolveActiveWorkspacePath(),
          );
          if ('error' in decoded) {
            socket.emit('command:result', {
              commandId: payload.commandId,
              ok: false,
              error: decoded.error,
            } satisfies CommandResult);
            return;
          }
          let msgText = text;
          if (decoded.filePaths.length) {
            const block = decoded.filePaths.map((p) => `📎 ${p}`).join('\n');
            const prefix = t('tg.msg.inbound.filesBlock', 'Attached files:\n{paths}', { paths: block });
            msgText = msgText.trim() ? `${prefix}\n\n${msgText}` : prefix;
          }
          const attachCount = decoded.imagePaths.length + decoded.filePaths.length;
          logRelayCmd(
            'send_message',
            `${attachCount} attachment(s)${payload.submit === 'ctrlEnter' ? ' force' : ''}`,
            { itemId: payload.commandId, hint: socket.id },
          );
          const result = decoded.imagePaths.length
            ? await this.commandExecutor.sendMessageWithImages(payload.commandId, {
              text: msgText,
              imagePaths: decoded.imagePaths,
              verifyStillOnTab: () => true,
              submit: payload.submit,
            })
            : await this.commandExecutor.sendMessage(payload.commandId, msgText, { submit: payload.submit });
          socket.emit('command:result', result);
          return;
        }

        logRelayCmd(
          'send_message',
          payload.submit === 'ctrlEnter' ? 'force' : 'enter',
          { itemId: payload.commandId, hint: socket.id },
        );
        const result = await this.commandExecutor.sendMessage(
          payload.commandId,
          text,
          { submit: payload.submit },
        );
        socket.emit('command:result', result);
      });

      socket.on('command:force_queue_item', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.queueItemId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or queueItemId',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('force_queue_item', payload.queueItemId ?? '', { itemId: payload.commandId, hint: socket.id });
        const result = await this.commandExecutor.forceQueueItem(
          payload.commandId,
          payload.queueItemId,
        );
        socket.emit('command:result', result);
      });

      socket.on('command:load_history', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('load_history', socket.id, { itemId: payload.commandId, hint: socket.id });
        const before = this.stateManager.getCurrentState().messages.length;
        const scrollResult = await this.commandExecutor.scrollChatUp(payload.commandId, 5);
        if (!scrollResult.ok) {
          socket.emit('command:result', scrollResult);
          return;
        }
        try {
          if (this.shutdownHooks) await this.shutdownHooks.extractNow();
          await new Promise((r) => setTimeout(r, 1500));
          if (this.shutdownHooks) await this.shutdownHooks.extractNow();
          const after = this.stateManager.getCurrentState().messages.length;
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: true,
            data: { added: Math.max(0, after - before), total: after },
          } satisfies CommandResult);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logError('RELAY_CMD_FAIL', `load_history failed: ${msg}`, relayCtx('load_history', { itemId: payload.commandId }));
          socket.emit('command:result', { commandId: payload.commandId, ok: false, error: msg });
        }
      });

      socket.on('command:approve', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('approve', socket.id, { itemId: payload.commandId, hint: socket.id });
        const result = await this.commandExecutor.clickApproval(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:approve_all', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('approve_all', socket.id, { itemId: payload.commandId, hint: socket.id });
        const result = await this.commandExecutor.approveAll(payload.commandId);
        socket.emit('command:result', result);
      });

      socket.on('command:reject', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('reject', socket.id, { itemId: payload.commandId, hint: socket.id });
        const result = await this.commandExecutor.reject(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:switch_tab', async (payload: CommandPayload) => {
        if (!payload.commandId || (!payload.tabTitle && !payload.selectorPath)) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId and tab target',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('switch_tab', payload.tabTitle ?? payload.selectorPath ?? '', {
          itemId: payload.commandId,
          hint: socket.id,
          composerId: payload.composerId,
        });
        const result = await this.commandExecutor.switchTab(
          payload.commandId,
          payload.tabTitle ?? '',
          payload.selectorPath,
          { composerId: payload.composerId },
        );
        socket.emit('command:result', result);
      });

      socket.on('command:new_chat', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('new_chat', socket.id, { itemId: payload.commandId, hint: socket.id });
        const result = await this.commandExecutor.newChat(payload.commandId);
        socket.emit('command:result', result);
      });

      socket.on('command:close_chat', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('close_chat', payload.tabTitle ?? payload.composerId ?? 'active', {
          itemId: payload.commandId,
          hint: socket.id,
          composerId: payload.composerId,
        });
        const result = await this.commandExecutor.closeChat(
          payload.commandId,
          payload.tabTitle,
          { composerId: payload.composerId },
        );
        socket.emit('command:result', result);
      });

      socket.on('command:set_mode', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.modeId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or modeId',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('set_mode', payload.modeId ?? '', { itemId: payload.commandId, hint: socket.id });
        const result = await this.commandExecutor.setMode(
          payload.commandId,
          payload.modeId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:set_model', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.modelId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or modelId',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('set_model', payload.modelId ?? '', { itemId: payload.commandId, hint: socket.id });
        const result = await this.commandExecutor.setModel(
          payload.commandId,
          payload.modelId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:get_model_options', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('get_model_options', socket.id, { itemId: payload.commandId, hint: socket.id });
        const result = await this.commandExecutor.getModelOptions(
          payload.commandId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:get_plan_full', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.planLabel) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or planLabel',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('get_plan_full', payload.planLabel ?? '', { itemId: payload.commandId, hint: socket.id });
        const planFile = readPlanFile(payload.planLabel);
        if (!planFile) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: 'Plan file not found',
          } satisfies CommandResult);
          return;
        }
        socket.emit('command:result', {
          commandId: payload.commandId,
          ok: true,
          data: {
            todos: planFile.todos,
            body: planFile.body,
            bodyHtml: markdownToWebHtml(planFile.body),
          },
        } satisfies CommandResult);
      });

      socket.on('command:get_plan_model_options', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('get_plan_model_options', socket.id, { itemId: payload.commandId, hint: socket.id });
        const result = await this.commandExecutor.getPlanModelOptions(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:set_plan_model', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath || !payload.planModelId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId, selectorPath, or planModelId',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('set_plan_model', payload.planModelId ?? '', { itemId: payload.commandId, hint: socket.id });
        const result = await this.commandExecutor.setPlanModel(
          payload.commandId,
          payload.selectorPath,
          payload.planModelId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:click_action', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('click_action', socket.id, { itemId: payload.commandId, hint: socket.id });
        const result = await this.commandExecutor.clickAction(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:questionnaire_click', async (payload: CommandPayload) => {
        if (!payload.commandId || (!payload.questionnaireTarget && !payload.selectorPath)) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId and questionnaire target',
          } satisfies CommandResult);
          return;
        }
        const t = payload.questionnaireTarget;
        const target =
          t === 'skip' || t === 'continue'
            ? t
            : (payload.selectorPath
              ? { selectorPath: payload.selectorPath }
              : { letter: t as string });
        const result = await this.commandExecutor.clickQuestionnaire(
          payload.commandId,
          target,
          { forceContinue: payload.questionnaireForceContinue === true },
        );
        socket.emit('command:result', result);
      });

      socket.on('command:questionnaire_freeform', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath || payload.text === undefined) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId, selectorPath, or text',
          } satisfies CommandResult);
          return;
        }
        const result = await this.commandExecutor.setQuestionnaireFreeform(
          payload.commandId,
          payload.selectorPath,
          payload.text,
        );
        socket.emit('command:result', result);
      });

      socket.on('command:switch_window', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.windowId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or windowId',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('switch_window', payload.windowId ?? '', {
          itemId: payload.commandId,
          hint: socket.id,
          windowId: payload.windowId,
        });
        try {
          await this.cdpBridge.switchWindow(payload.windowId);
          socket.emit('command:result', { commandId: payload.commandId, ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logError('RELAY_CMD_FAIL', `switch_window failed: ${msg}`, relayCtx('switch_window', {
            itemId: payload.commandId,
            windowId: payload.windowId,
          }));
          socket.emit('command:result', { commandId: payload.commandId, ok: false, error: msg });
        }
      });

      socket.on('command:refresh_state', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        logRelayCmd('refresh_state', socket.id, { itemId: payload.commandId, hint: socket.id });
        try {
          if (this.shutdownHooks) await this.shutdownHooks.extractNow();
          socket.emit('command:result', { commandId: payload.commandId, ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logError('RELAY_CMD_FAIL', `refresh_state failed: ${msg}`, relayCtx('refresh_state', { itemId: payload.commandId }));
          socket.emit('command:result', { commandId: payload.commandId, ok: false, error: msg });
        }
      });

      socket.on('disconnect', (reason) => {
        logInfo('RELAY_SOCKET_DISCONNECT', `${socket.id} (${reason})`, relayCtx('socket', { hint: reason }));
      });
    });
  }

  private setupStateForwarding(): void {
    this.stateManager.on('state:patch', (patch: Partial<CursorState>) => {
      this.io.emit('state:patch', patch);
    });

    this.stateManager.on('connection:changed', (connected: boolean) => {
      this.io.emit('connection:status', { connected });
    });
  }
}
