# Reference

Lookup for CursorHandoff **1.6.1**: extension commands, settings, security defaults, runtime files, and the health API.

User guides: [Getting started guide](guide.md), [Telegram bridge guide](telegram.md).

---

## Extension commands

| ID | Palette title |
|----|----------------|
| `cursorHandoff.start` | Start server |
| `cursorHandoff.stop` | Stop server |
| `cursorHandoff.restart` | Restart server |
| `cursorHandoff.restartWake` | Restart CursorWake |
| `cursorHandoff.openWebClient` | Open web client |
| `cursorHandoff.openHandoffSettings` | Open Handoff settings |
| `cursorHandoff.openDoc` | Open documentation (`docs/*.md` from the extension bundle) |
| `cursorHandoff.showLogs` | Handoff log (merged `<data-root>/handoff.log`) |
| `cursorHandoff.installWake` | Install CursorWake (Windows) |
| `cursorHandoff.installCloudflared` | Install cloudflared (Windows: winget; macOS/Linux: Homebrew or download) |
| `cursorHandoff.installAgentSkills` | Install agent skills |

---

## Settings (`cursorHandoff.*`)

Defaults match `package.json`. On spawn, the extension maps them to environment variables (`extension/src/config-bridge.ts`).

| Setting | Default | Env | Purpose |
|---------|---------|-----|---------|
| `autoStart` | `true` | — | Start server when Cursor opens |
| `cdpUrl` | `http://127.0.0.1:9222` | `CDP_URL` | Cursor CDP base URL |
| `serverPort` | `3000` | `SERVER_PORT` | HTTP + socket.io port |
| `serverHost` | `127.0.0.1` | `SERVER_HOST` | Bind address (`0.0.0.0` = LAN; use Tailscale IP for mesh) |
| `dataDir` | `""` | `DATA_DIR` | Runtime root; empty → see [Data root resolution](#data-root-resolution) |
| `locale` | `en` | — | `en` or `ru` for UI and bot strings |
| `pollIntervalMs` | `500` | `POLL_INTERVAL_MS` | DOM poll period |
| `debounceMs` | `300` | `DEBOUNCE_MS` | State broadcast debounce |
| `webappPassword` | *(generated on first activation)* | `WEBAPP_PASSWORD` | Web client login |
| `webTunnel.enabled` | `true` | — | Start Cloudflare quick tunnel with server (Windows, macOS, Linux) |
| `wake.startupEnabled` | `true` | — | CursorWake shortcut in Windows Startup |
| `windowTitleQualifier` | `true` | `WINDOW_TITLE_QUALIFIER` | WSL/SSH suffix in window titles |
| `telegram.enabled` | `false` | `TELEGRAM_ENABLED` | Telegram transport |
| `telegram.botToken` | `""` | `TELEGRAM_BOT_TOKEN` | @BotFather token |
| `telegram.allowedUsers` | `""` | `TELEGRAM_ALLOWED_USERS` | Comma-separated user IDs |
| `telegram.impl` | **`raw`** | `TELEGRAM_IMPL` | `raw` or `grammy` |

**`telegram.impl`:** `raw` is the shipped default — native `fetch` against the Bot API. Pick `grammy` only when you rely on Grammy-specific handlers; if startup stalls on `getMe`, fall back to `raw` ([Telegram guide](telegram.md#bot-wont-connect)).

The extension sets `LOG_FORMAT=json` on spawn so structured child logs include parseable `code=` tails.

<a id="data-root-resolution"></a>

### Data root resolution

When `cursorHandoff.dataDir` / `DATA_DIR` is empty, `extension/src/paths-settings.ts`:

1. Walks up from each **workspace folder**, then from **`extensionPath`**, for `package.json` with `"name": "cursor-handoff"`.
2. If found → `<that-directory>/data/` (Handoff settings label: **Project default (./data)** — used for git checkout **and** installed VSIX folder; not the same as global storage).
3. If not found → `context.globalStorageUri` (Handoff settings: **Extension user storage**).

| Scenario | Typical `<data-root>` |
|----------|-------------------------|
| Custom `cursorHandoff.dataDir` | Your path |
| Git checkout of this repo open in Cursor | `<repo>/data/` |
| VSIX installed, any other workspace | `<IDE-extensions>/cursor-handoff.cursor-handoff-<version>/data/` |
| Fallback | Global storage (below) |

**Installed VSIX (Windows, Cursor):** `%USERPROFILE%\.cursor\extensions\cursor-handoff.cursor-handoff-1.6.1\data\`

**Global storage fallback** (`cursor-handoff.cursor-handoff`):

| OS | Cursor |
|----|--------|
| Windows | `%APPDATA%\Cursor\User\globalStorage\cursor-handoff.cursor-handoff\` |
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/cursor-handoff.cursor-handoff/` |
| Linux | `~/.config/Cursor/User/globalStorage/cursor-handoff.cursor-handoff/` |

VS Code: use `.vscode/extensions/` and `Code` instead of `Cursor` where applicable.

**CursorWake standalone** (no `DATA_DIR` from Handoff): `wake/config.py` defaults to global storage on Windows when not running from a repo checkout.

User-facing summary: [README — Where data lives](../README.md#where-data-lives).

### Handoff settings ↔ Cursor Settings

| Panel control | Backing setting |
|---------------|-----------------|
| Language EN/RU | `locale` |
| Web access bind | `serverHost` (+ restart) |
| Web password field | `webappPassword` |
| Telegram token | `telegram.botToken` |
| Telegram user IDs | `telegram.allowedUsers` |
| Bot API transport | `telegram.impl` (+ restart) |
| Wake autostart | `wake.startupEnabled` |
| Cloudflare autostart | `webTunnel.enabled` |

The sidebar **Status** tree is read-mostly (server, CDP, agent, clients, windows). Start/stop and install actions live in the tree or Command Palette, not duplicated inside the Handoff settings webview.

---

## Security defaults

- `serverHost` starts on loopback — other devices cannot connect until you widen the bind.
- First activation generates a random `webappPassword`.
- `GET /health` returns liveness only until the browser holds a valid session (`sessionValid: true`).
- Binding off-loopback without a password forces fallback to `127.0.0.1`.
- Web login: 10 failed attempts per minute per IP.

---

<a id="storage"></a>

## Storage

### Repository layout

| Path | Role | In git |
|------|------|--------|
| `data/` | Bot state, queue, sessions | no |
| `dist/` | Built server and extension | no |
| `releases/` | Packaged VSIX | no |
| `temp/` | Dev server logs | no |
| `templates/cursor-handoff-global/` | Skill and rule templates | yes |

**Data root:** resolved as above. In a git checkout of this repo, runtime files default to `<repo>/data/`.

### Files under `<data-root>/`

| File | Contents |
|------|----------|
| `telegram-topics.json` | Forum topic ↔ window/tab/composerId |
| `telegram-messages.json` | DOM element id → Telegram `message_id` |
| `telegram-auth.json` | Registration token and users |
| `telegram-sync.json` | Bridge on/off, `groupId` |
| `telegram-activity.json` | Short-lived activity lines |
| `cursor-wake-telegram-offset.json` | Wake `getUpdates` offset for handoff |
| `pending-telegram-queue.json` | Messages queued while Cursor was off |
| `cursor-wake-state.json` | `raiseCursor` for `/pause` / `/resume` |
| `server-owner.lock` | PID owning `:3000` |
| `server-starting.lock` | Guard while spawn is in flight |
| `startup-notify.json` | Dedup “server started” in # General |
| `web-tunnel-url.json` | Active Cloudflare quick tunnel URL |
| `cloudflared-quick.pid` / `.log` | cloudflared process metadata |
| `webapp-sessions.json` | Web sessions (30-day TTL) |
| `web-settings.json` | Synced web UI preferences (`theme`, `compactFeed`, `toolDiffDisplay`: `compact` \| `preview`, …) |
| `open-project.json` | One-shot folder open from Telegram or web (`command:open_project`) |
| `file-relay/` | File relay bootstrap metadata |
| `cursor-wake.log` | CursorWake tray log (`code=WAKE_*` event tails) |
| `cursor-host.json` | Running Cursor version (`cursor.version`); extension writes before spawn |
| `cursor-upgrade-server-notify.json` | Per-channel dedup for upgrade advisory and startup notify waves |
| `handoff.log` | Merged log (server visor, 4 s) — each line: `[server]` / `[ext]` / `[wake]`, local `DD.MM.YYYY HH:mm:ss:SSS`, then JSON (`ts` unix ms inside) |
| `handoff-ext.log` | Extension-only lines for visor merge |
| `handoff-server.log` | Handoff server log (JSON or human lines with `code=` — `TG_*`, `CDP_*`, `QUEUE_*`, …) |
| `telegram-questionnaire-freeform/` | Short-lived pending state for TG **Other** + Reply (10 min TTL) |
| `redeploy-requested` | Dev flag: full redeploy on next stop-hook |
| `feed-images/` | Sidecar PNG/WebP for agent-generated feed images (`{messageId}-img-{index}.png`) |

### Per workspace

| Path | Role |
|------|------|
| `.cursor-handoff/outbox/` | Agent files for outbound Telegram (stale files purged after 1 h) |
| `.cursor-handoff/file-relay/photo/inbound/` | Inbound image staging (clipboard paste) |
| `.cursor-handoff/file-relay/inbound/` | Inbound non-image files (paths in message text) |

**File relay limits:** same on Telegram and web — up to **10** attachments per message, **20 MB** per file (Telegram Bot API). Details: [Telegram bridge § File relay](telegram.md#file-relay).

`ensureProjectDirs()` creates these; `/setup_tg_send` adds `.cursor-handoff/` to the workspace `.gitignore`.

### Web socket.io — project picker

| Event | Direction | Payload | Result |
|-------|-----------|---------|--------|
| `command:list_projects` | client → server | `{ commandId }` | ack `{ ok, projects?: [{ path, name, isOpen, isActive, windowId? }] }` |
| `command:open_project` | client → server | `{ commandId, projectPath }` | `command:result` — opens folder or switches if already open |
| `command:close_project` | client → server | `{ commandId, projectPath }` | `command:result` — CDP `closeTarget` for that window |

Implementation: `src/workspace/project-web.ts`, wired in `src/web/http-routes.ts`. Telegram `/projects` and `/open_project` use the same open path. After **close**, snapshots for that CDP target are removed and the live window list is refreshed so `isOpen` in the picker stays accurate.

### Web tool diff expand

When a web client shows an edit-tool row whose `diffBlock` looks partial (stats ≫ visible lines), tapping ▼ emits:

| Event | Direction | Payload | Result |
|-------|-----------|---------|--------|
| `command:expand_tool_diff` | client → server | `{ commandId, toolCallId?, flatIndex? }` | `command:result` then `state:patch` with full `diffBlock`; cached in broadcast state |

Parser: `src/ide/parse/ui-default-diff.ts`, `expand-tool-diff.ts` (one-shot scroll through Cursor’s virtualized diff viewport). Poll extraction does **not** scroll. Web UI: full-screen opens the hunk overlay from the tool header (`.tool-diff-fullscreen` in `.tool-file-info`); no `code-block-toolbar` on edit-tool rows. Telegram unchanged — stats line only. User-facing: [guide § Edit tool diffs](guide.md#edit-tool-diffs-web).

### Tool approval `selectorPath` (CDP)

Web **Run** / **Skip** and Telegram inline buttons send `click_action` with a `selectorPath`. Shell approvals use live DOM selectors from `pendingApprovals` (e.g. `button.ui-shell-tool-call__run-btn`). Confirm search and Delete file use stable magic paths built in `src/ide/parse/confirm-search-selectors.ts` and `delete-file-selectors.ts`; CDP resolves them in `navigation.ts` (`clickConfirmSearchAtCoords`, `clickDeleteFileAtCoords`).

| Card | Path pattern | Action |
|------|--------------|--------|
| Confirm search | `confirm-search:{toolCallId}:{urlEncodedQuery}:continue` | Approve web search |
| Confirm search | `confirm-search:{toolCallId}:{urlEncodedQuery}:cancel` | Reject web search |
| Confirm search | `confirm-search:{toolCallId}:{urlEncodedQuery}:auto-search-toggle` | Toggle Auto-search web |
| Delete file | `delete-file:{toolCallId}:{urlEncodedFilename}:accept` | Accept delete |
| Delete file | `delete-file:{toolCallId}:{urlEncodedFilename}:reject` | Reject delete |
| Generate image | `generate-image:{toolCallId}:run` | Approve image generation |
| Generate image | `generate-image:{toolCallId}:skip` | Skip image generation |

- **Query / filename segments** — `encodeURIComponent` of up to 120 chars (query) or the basename (filename). Omitted when empty: `confirm-search:{toolCallId}:continue`, `delete-file:{toolCallId}:accept`.
- **Scoped matching** — With several cards open, merge attaches paths from the matched message `toolCallId` and command/filename so the bottom card’s **Continue** does not click the top row.
- **Legacy (deprecated)** — Global `confirm-search:continue`, `confirm-search:cancel`, `confirm-search:auto-search-toggle` (no id/query); prefer scoped paths.

Sources: `confirm-search-merge.ts`, `delete-file-merge.ts`, `generate-image-merge.ts`, `shell-approval-merge.ts` (orchestrated by `approval-merge.ts`). User-facing behavior: [guide § Web client](guide.md), [Telegram § Tool approvals](telegram.md#tool-approvals-run--confirm-search--delete).

### Feed image HTTP

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /api/feed-image/:id` | Session cookie when `webappPassword` set | Serve sidecar image (`id` = `{messageId}-img-{index}`) |

Files live under `<data-root>/feed-images/`. Populated by `enrichStateWithFeedImages` after each CDP extraction when Cursor shows inline previews on **Generated image** tool rows.

**Telegram delivery:** `src/telegram/feed-image-outbound.ts` — on poll-loop diff, when a completed **Generated image** tool message has ready sidecars, sends `sendPhoto` / `sendDocument` / album to the mapped forum thread. Dedup keys: `feed-img:{composerId}:{sidecarId}`. Distinct from workspace [file relay](../telegram.md#file-relay) outbox (agent-initiated copies).

---

## Health endpoint

`GET http://127.0.0.1:3000/health` (port from `serverPort`):

| Field | Meaning |
|-------|---------|
| `connected` | CDP session up |
| `build.version` | Server semver (e.g. `1.1.0`) |
| `build.compatVersion` | Extension/server contract (`HANDOFF_COMPAT_VERSION`; currently `1`) |
| `build.testedCursorVersion` | Cursor version pinned at `npm run package` (`scripts/build/cursor-compat.json`) |
| `cursorUpgradeAdvisory` | `true` when running Cursor version ≠ `testedCursorVersion` |
| `cursorVersion` | Running Cursor version from `<data-root>/cursor-host.json` (extension writes `cursor.version`) |
| `cursorUpgradeServerNotifyAt` | Timestamp of the latest server-start notify wave (`<data-root>/cursor-upgrade-server-notify.json`); web dismiss compares against this |
| `handoffVersion` | Installed Handoff semver (same as `build.version`) |
| `testedCursorVersion` | Same as `build.testedCursorVersion` |
| `build.fingerprint` | Build stamp (includes `compatVersion`, e.g. `handoff-1.1.0-compatVersion-1`) |
| `telegramEnabled` | Telegram transport enabled |
| `telegramPoll` | At least one successful `getUpdates` |
| `webTunnelUrl` | Cloudflare URL when tunnel is running |
| `sessionValid` | Authenticated web client — full state exposed |

CursorWake releases the bot token when Handoff reports healthy CDP + `connected: true` (server takes over `getUpdates`; `telegramPoll` flips true after the first successful poll).

**Cursor upgrade notify** uses `<data-root>/cursor-upgrade-server-notify.json` (not the startup file). Web clients compare `cursorUpgradeServerNotifyAt` against `localStorage` dismiss state.

### Build artifacts (compatVersion)

Shipped inside the VSIX / extension `dist/`:

| File | Fields |
|------|--------|
| `dist/server/build-manifest.json` | `version`, `builtAt`, `compatVersion`, `testedCursorVersion`, `fingerprint`, `bundleSha256` |
| `dist/compat-version.json` | `version`, `compatVersion` |

Extension spawn checks both files against `package.json` before starting `bundle.mjs`. Server startup audit logs `BUILD OK compatVersion=<n>` or `compatVersion-mismatch` violations.

### CursorWake install config

`%LOCALAPPDATA%\CursorWake\cursor-wake.config.json` (written by `install-handoff-wake.ps1`):

| Key | Default | Meaning |
|------|---------|---------|
| `dataDir` | from `cursorHandoff.dataDir` | Queue, offset, Wake state |
| `cursorLaunchCmd` | `%LOCALAPPDATA%\Programs\cursor\Cursor.exe` | IDE launch path (`ShellExecuteW` on Windows) |
| `autostartIntervalSec` | `300` | While **Raise Cursor** is on, Cursor is down, and the queue is empty — retry launch every N seconds |
| `pollIntervalSec` | `30` | Health loop interval when Handoff is healthy |
| `pollIntervalFastSec` | `10` | Health loop interval when Cursor is down |
| `launchTimeoutSec` | `120` | Max wait for Cursor/CDP after spawn |
