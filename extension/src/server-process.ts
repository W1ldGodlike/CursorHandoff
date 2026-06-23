import * as vscode from 'vscode';
import { ChildProcess, spawn, exec } from 'child_process';
import { join } from 'path';
import { mkdirSync, existsSync, writeFileSync, unlinkSync, readFileSync, watch, type FSWatcher } from 'fs';
import { EventEmitter } from 'events';
import { buildEnvFromConfig } from './config-bridge.js';
import { resolveDataDir } from './paths-settings.js';
import { killStaleBundleServers } from './spawn-hygiene.js';
import {
  claimServerOwner,
  clearServerStarting,
  isServerSpawnBlocked,
  markServerStarting,
  releaseServerOwner,
} from './owner-lock.js';
import { ensureCloudflaredQuickTunnel } from './tunnel-launcher.js';
import { appendLogLine, type UnifiedOutputChannel } from './output-channel.js';
import { updateStatusBar, type HealthData, type ServerState } from './status-bar.js';
import { loadLocaleStrings, normalizeLocale, tr } from './extension-locale.js';

const HEALTH_POLL_INTERVAL_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 3000;
const MAX_TAKEOVER_JITTER_MS = 3000;

export class ServerManager extends EventEmitter {
  private context: vscode.ExtensionContext;
  private outputChannel: UnifiedOutputChannel;
  private statusBarItem: vscode.StatusBarItem;
  private child: ChildProcess | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private lastHealth: HealthData | null = null;
  private _serverState: ServerState = 'stopped';
  private _isOwner = false;
  private _takingOver = false;
  private _reactingToFlag = false;
  private readonly windowName: string;
  private readonly manualStopPath: string;
  private readonly openProjectPath: string;
  private dirWatcher: FSWatcher | null = null;
  private handlingOpenProject = false;
  private shuttingDown = false;
  private errorRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

  get serverState(): ServerState {
    return this._serverState;
  }

  get health(): HealthData | null {
    return this.lastHealth;
  }

  private localeDict(): Record<string, string> {
    const config = vscode.workspace.getConfiguration('cursorHandoff');
    const locale = normalizeLocale(config.get<string>('locale', 'en'));
    const workspacePaths = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    return loadLocaleStrings(this.context.extensionPath, workspacePaths, locale);
  }

  get isOwner(): boolean {
    return this._isOwner;
  }

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: UnifiedOutputChannel,
    statusBarItem: vscode.StatusBarItem,
  ) {
    super();
    this.context = context;
    this.outputChannel = outputChannel;
    this.statusBarItem = statusBarItem;
    this.windowName = vscode.workspace.name
      ?? vscode.workspace.workspaceFolders?.[0]?.name
      ?? 'unknown';

    const dataDir = resolveDataDir(context);
    this.manualStopPath = join(dataDir, 'manual-stop');
    this.openProjectPath = join(dataDir, 'open-project.json');
  }

  private isManualStopped(): boolean {
    return existsSync(this.manualStopPath);
  }

  private setManualStop(stopped: boolean): void {
    try {
      if (stopped) {
        const dir = join(this.manualStopPath, '..');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(this.manualStopPath, String(Date.now()));
      } else {
        if (existsSync(this.manualStopPath)) unlinkSync(this.manualStopPath);
      }
    } catch (err) {
      this.outputChannel.warn(`[${this.windowName}] Flag file error: ${err instanceof Error ? err.message : err}`);
    }
  }

  startDirWatcher(): void {
    const dataDir = resolveDataDir(this.context);
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    try {
      this.dirWatcher = watch(dataDir, (eventType, filename) => {
        if (filename === 'manual-stop') {
          if (this._reactingToFlag) return;

          const flagExists = this.isManualStopped();
          if (flagExists && this._serverState !== 'stopped') {
            this.outputChannel.info(`[${this.windowName}] Manual-stop flag detected — stopping.`);
            this.stop().catch(err => {
              this.outputChannel.warn(`[${this.windowName}] Flag-triggered stop failed: ${err}`);
            });
          } else if (!flagExists && this._serverState === 'stopped') {
            this.outputChannel.info(`[${this.windowName}] Manual-stop flag removed — starting.`);
            this.start().catch(err => {
              this.outputChannel.warn(`[${this.windowName}] Flag-triggered start failed: ${err}`);
            });
          }
          return;
        }

        if (filename === 'open-project.json') {
          void this.handleOpenProjectRequest();
          return;
        }

        if (filename === 'request-start') {
          void this.handleRequestStart();
        }
      });
    } catch (err) {
      this.outputChannel.warn(`[${this.windowName}] Could not watch data dir: ${err instanceof Error ? err.message : err}`);
    }

    if (existsSync(this.openProjectPath)) {
      void this.handleOpenProjectRequest();
    }
  }

  private async handleRequestStart(): Promise<void> {
    const flag = join(resolveDataDir(this.context), 'request-start');
    try {
      if (existsSync(flag)) unlinkSync(flag);
    } catch { /* ignore */ }
    await this.start();
  }

  /** Server writes open-project.json when Telegram must open a closed project folder. */
  private async handleOpenProjectRequest(): Promise<void> {
    if (this.handlingOpenProject || !existsSync(this.openProjectPath)) return;
    this.handlingOpenProject = true;

    try {
      const raw = readFileSync(this.openProjectPath, 'utf-8');
      unlinkSync(this.openProjectPath);
      const parsed = JSON.parse(raw) as { path?: string };
      const projectPath = parsed.path?.trim();
      if (!projectPath || !existsSync(projectPath)) {
        this.outputChannel.warn(`[${this.windowName}] open-project: invalid path "${projectPath ?? ''}"`);
        return;
      }

      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(projectPath),
        { forceNewWindow: true }
      );
      this.outputChannel.info(`[${this.windowName}] Opened project in new window: ${projectPath}`);
    } catch (err) {
      this.outputChannel.warn(
        `[${this.windowName}] open-project failed: ${err instanceof Error ? err.message : err}`
      );
    } finally {
      this.handlingOpenProject = false;
    }
  }

  private getHealthUrl(): { port: string; host: string; url: string } {
    const config = vscode.workspace.getConfiguration('cursorHandoff');
    const port = String(config.get<number>('serverPort', 3000));
    const host = config.get<string>('serverHost', '127.0.0.1');
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    return { port, host, url: `http://${displayHost}:${port}/health` };
  }

  private async probeExistingServer(): Promise<boolean> {
    const { url } = this.getHealthUrl();
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        const data = await resp.json() as HealthData;
        this.lastHealth = data;
        return true;
      }
    } catch { /* not running */ }
    return false;
  }

  async start(): Promise<void> {
    this._reactingToFlag = true;
    this.setManualStop(false);
    this._reactingToFlag = false;

    if (this.child) {
      vscode.window.showInformationMessage(
        tr(this.localeDict(), 'ext.server.alreadyOwner', 'Server is already running (this window is the owner).'),
      );
      return;
    }

    const { port, host } = this.getHealthUrl();
    const env = buildEnvFromConfig(this.context);
    const dataDir = env.DATA_DIR;

    const alreadyRunning = await this.probeExistingServer();
    if (alreadyRunning) {
      this.outputChannel.info(`[${this.windowName}] Server already running — attaching as observer.`);
      this._isOwner = false;
      this.setState(this.lastHealth?.connected ? 'running' : 'disconnected');
      this.startHealthPolling(port, host);
      this.emit('started');
      return;
    }

    if (isServerSpawnBlocked(dataDir)) {
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await this.probeExistingServer()) {
          this.outputChannel.info(`[${this.windowName}] Server started by another window — observer.`);
          this._isOwner = false;
          this.setState(this.lastHealth?.connected ? 'running' : 'disconnected');
          this.startHealthPolling(port, host);
          this.emit('started');
          return;
        }
        if (!isServerSpawnBlocked(dataDir)) break;
      }
    }

    if (await this.probeExistingServer()) {
      this.outputChannel.info(`[${this.windowName}] Server already up before spawn — observer.`);
      this._isOwner = false;
      this.setState(this.lastHealth?.connected ? 'running' : 'disconnected');
      this.startHealthPolling(port, host);
      this.emit('started');
      return;
    }

    await killStaleBundleServers((msg) => this.outputChannel.info(`[${this.windowName}] ${msg}`));
    if (await this.probeExistingServer()) {
      this.outputChannel.info(`[${this.windowName}] Server up after stale cleanup — observer.`);
      this._isOwner = false;
      this.setState(this.lastHealth?.connected ? 'running' : 'disconnected');
      this.startHealthPolling(port, host);
      this.emit('started');
      return;
    }

    markServerStarting(dataDir, this.windowName);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const extRoot = this.context.extensionPath;
    const tempDir = join(extRoot, 'temp');
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    const serverScript = join(extRoot, 'dist', 'server', 'bundle.mjs');

    this.outputChannel.info(`[${this.windowName}] Starting server: ${serverScript}`);

    // process.execPath = Cursor.exe — without ELECTRON_RUN_AS_NODE the script exits code=0 immediately
    this.child = spawn(process.execPath, [serverScript], {
      cwd: extRoot,
      env: {
        ...process.env,
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_NO_WARNINGS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const ownerPid = this.child.pid;
    if (ownerPid) {
      claimServerOwner(dataDir, ownerPid, this.windowName);
    } else {
      clearServerStarting(dataDir);
    }

    this._isOwner = true;
    this.shuttingDown = false;

    this.child.stdout?.on('data', (data: Buffer) => {
      if (this.shuttingDown) return;
      try {
        const lines = data.toString().split('\n').filter(l => l.trim());
        for (const line of lines) {
          appendLogLine(this.outputChannel, line);
          this.detectStatusFromLog(line);
        }
      } catch {
        /* pipe may close on window reload */
      }
    });
    let stderrBuffer = '';
    this.child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderrBuffer += text;
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        if (line.includes('DEP0040') || (line.includes('punycode') && line.includes('deprecated'))) continue;
        appendLogLine(this.outputChannel, line);
      }
    });

    this.child.on('exit', (code, signal) => {
      this.outputChannel.info(`[${this.windowName}] Server exited (code=${code}, signal=${signal})`);
      if (ownerPid) releaseServerOwner(dataDir, ownerPid);
      clearServerStarting(dataDir);
      this.child = null;
      this._isOwner = false;
      this.stopHealthPolling();

      void (async () => {
        if (stderrBuffer.includes('EADDRINUSE')) {
          this.outputChannel.info(`[${this.windowName}] Port already in use — falling back to observer.`);
        }
        if (await this.fallbackToObserver()) return;

        if (code !== 0 && code !== null) {
          this.outputChannel.show(true);
          this.setState('error');
          this.scheduleErrorRecovery();
        } else {
          this.setState('stopped');
        }
        this.emit('stopped');
      })();
    });

    this.child.on('error', (err) => {
      this.outputChannel.error(`[${this.windowName}] Server spawn error: ${err.message}`);
      this.outputChannel.show(true);
      if (ownerPid) releaseServerOwner(dataDir, ownerPid);
      clearServerStarting(dataDir);
      this.child = null;
      this._isOwner = false;
      this.stopHealthPolling();
      void (async () => {
        if (await this.fallbackToObserver()) return;
        this.setState('error');
        this.scheduleErrorRecovery();
      })();
    });

    this.outputChannel.show(true);
    this.setState('disconnected');
    this.startHealthPolling(env.SERVER_PORT, env.SERVER_HOST);
    this.emit('started');
    ensureCloudflaredQuickTunnel(this.context, (msg) => {
      this.outputChannel.info(`[WebTunnel] ${msg}`);
    });
  }

  async stop(manual = false): Promise<void> {
    if (manual) {
      this._reactingToFlag = true;
      this.setManualStop(true);
      this._reactingToFlag = false;
    }

    this.stopHealthPolling();
    this.clearErrorRecovery();

    if (!this.child) {
      if (manual && this._serverState !== 'stopped') {
        this.outputChannel.info(`[${this.windowName}] Detaching from server (owned by another window).`);
        this.setState('stopped');
      }
      return;
    }

    if (!manual) {
      this.outputChannel.info(`[${this.windowName}] Detaching — server keeps running for other windows.`);
      this.child = null;
      this._isOwner = false;
      return;
    }

    this.outputChannel.info(`[${this.windowName}] Stopping server...`);

    const child = this.child;
    const ownerPid = child.pid;
    const dataDir = resolveDataDir(this.context);
    this.child = null;
    this._isOwner = false;
    this.shuttingDown = true;

    const detachStreams = (): void => {
      try { child.stdout?.pause(); } catch { /* ignore */ }
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      try { child.stdout?.destroy(); } catch { /* ignore */ }
      try { child.stderr?.destroy(); } catch { /* ignore */ }
    };

    detachStreams();

    return new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        this.shuttingDown = false;
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);

      child.once('exit', () => {
        clearTimeout(forceKill);
        if (ownerPid) releaseServerOwner(dataDir, ownerPid);
        clearServerStarting(dataDir);
        detachStreams();
        this.shuttingDown = false;
        resolve();
      });

      try { child.kill('SIGTERM'); } catch {
        this.shuttingDown = false;
        resolve();
      }
    });
  }

  async restart(): Promise<void> {
    await this.stop(true);
    await this.start();
  }

  async openWebClient(): Promise<void> {
    const config = vscode.workspace.getConfiguration('cursorHandoff');
    const port = config.get<number>('serverPort', 3000);
    const host = config.get<string>('serverHost', '127.0.0.1');
    const displayHost = host === '0.0.0.0' ? 'localhost' : host;
    const url = `http://${displayHost}:${port}`;
    this.outputChannel.info(`[${this.windowName}] Opening web client: ${url}`);

    if (process.platform === 'win32') {
      exec(`start "" "${url}"`);
    } else if (process.platform === 'darwin') {
      exec(`open "${url}"`);
    } else {
      exec(`xdg-open "${url}"`);
    }
  }

  private setState(state: ServerState): void {
    this._serverState = state;
    updateStatusBar(this.statusBarItem, this.context, state, this.lastHealth ?? undefined);
    this.emit('stateChanged', state);
  }

  private detectStatusFromLog(raw: string): void {
    try {
      const parsed = JSON.parse(raw);
      const msg: string = parsed.msg ?? '';
      if (msg.includes('[cdp-bridge] Connected to')) {
        this.setState('running');
      } else if (msg.includes('[cdp-bridge] Disconnected') || msg.includes('[cdp-bridge] Connection lost')) {
        this.setState('disconnected');
      } else if (msg.includes('[CRASH]')) {
        this.setState('error');
      } else if (msg.includes('[startup-audit] STALE OR INVALID BUILD')) {
        this.setState('error');
        void vscode.window.showWarningMessage(
          tr(this.localeDict(), 'ext.server.staleBundle', 'CursorHandoff: server started with STALE bundle — see Output / server.log'),
        );
      } else if (msg.includes('Chat keyboard init starting') || msg.includes('Posting chat keyboards to')) {
        this.outputChannel.error(
          `[${this.windowName}] ${tr(this.localeDict(), 'ext.server.staleKeyboards', 'Detected OLD code (auto-keyboards on connect) — rebuild bundle + Reload Window')}`,
        );
      }
    } catch {
      // non-JSON log line — skip
    }
  }

  private async fallbackToObserver(): Promise<boolean> {
    const { port, host } = this.getHealthUrl();
    const alive = await this.probeExistingServer();
    if (alive) {
      this._isOwner = false;
      this.setState(this.lastHealth?.connected ? 'running' : 'disconnected');
      this.startHealthPolling(port, host);
      this.emit('started');
      return true;
    }
    return false;
  }

  private scheduleErrorRecovery(): void {
    if (this.errorRecoveryTimer || this.isManualStopped()) return;
    this.errorRecoveryTimer = setTimeout(() => {
      this.errorRecoveryTimer = null;
      if (this.child || this._serverState !== 'error') return;
      this.outputChannel.info(`[${this.windowName}] Error recovery — re-attaching to server.`);
      void this.start().catch(() => { /* next health cycle */ });
    }, 4000);
  }

  private clearErrorRecovery(): void {
    if (this.errorRecoveryTimer) {
      clearTimeout(this.errorRecoveryTimer);
      this.errorRecoveryTimer = null;
    }
  }

  private async attemptTakeover(): Promise<void> {
    if (this._takingOver || this.child) return;

    if (this.isManualStopped()) {
      this.outputChannel.info(`[${this.windowName}] Manual stop active — not taking over.`);
      this.setState('stopped');
      return;
    }

    this._takingOver = true;

    const jitter = Math.floor(Math.random() * MAX_TAKEOVER_JITTER_MS);
    this.outputChannel.info(`[${this.windowName}] Owner window closed — will attempt takeover in ${jitter}ms.`);

    await new Promise(r => setTimeout(r, jitter));

    const stillDown = !(await this.probeExistingServer());
    if (stillDown) {
      if (isServerSpawnBlocked(resolveDataDir(this.context))) {
        this.outputChannel.info(`[${this.windowName}] Another window is starting server — observer.`);
        this._takingOver = false;
        const { port, host } = this.getHealthUrl();
        this._isOwner = false;
        this.setState('disconnected');
        this.startHealthPolling(port, host);
        return;
      }
      this.outputChannel.info(`[${this.windowName}] Server still down — taking over.`);
      this._takingOver = false;
      await this.start();
    } else {
      this.outputChannel.info(`[${this.windowName}] Another window took over — staying as observer.`);
      this._takingOver = false;
      const { port, host } = this.getHealthUrl();
      this._isOwner = false;
      this.setState(this.lastHealth?.connected ? 'running' : 'disconnected');
      this.startHealthPolling(port, host);
    }
  }

  private startHealthPolling(port: string, host: string): void {
    this.stopHealthPolling();
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    const url = `http://${displayHost}:${port}/health`;

    let failCount = 0;
    const poll = async () => {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          failCount = 0;
          const data = await resp.json() as HealthData;
          this.lastHealth = data;
          const state: ServerState = data.connected ? 'running' : 'disconnected';
          this.setState(state);
          this.emit('health', data);
        }
      } catch {
        failCount++;
        if (!this.child && failCount >= 3) {
          this.outputChannel.info(`[${this.windowName}] External server no longer reachable.`);
          this.stopHealthPolling();
          this.attemptTakeover().catch(() => {
            void this.fallbackToObserver().then((ok) => {
              if (!ok) this.setState('error');
            });
          });
        }
      }
    };

    this.healthTimer = setInterval(poll, HEALTH_POLL_INTERVAL_MS);
    setTimeout(poll, 2000);
  }

  private stopHealthPolling(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  dispose(): void {
    this.clearErrorRecovery();
    if (this.dirWatcher) {
      this.dirWatcher.close();
      this.dirWatcher = null;
    }
    this.stopHealthPolling();
  }
}
