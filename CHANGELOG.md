# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Window hang recovery** — Auto-close applies only to the home CDP target after repeated main extraction failures; parallel-polled aux windows (e.g. Cursor Agents) are no longer closed after null polls.
- **Parallel window poll** — Background CDP polls skip non-home targets with no workspace folder (e.g. Cursor Agents), eliminating repeated `STATE_WINDOW_POLL_NULL` log noise.
- **Telegram long-poll resilience** — Poll loops no longer stop on abort-like transient fetch errors after Telegram API failures; they now terminate only on explicit local stop abort.
- **Telegram command dedup** — `dispatchCommand` no longer throws at build time when logging duplicate inbound commands (`threadId` used before declaration).

### Added

- **compatVersion gate (extension)** — Before spawning `bundle.mjs`, verify `build-manifest.json`, `dist/compat-version.json`, and package version align; block spawn with one clear error on mismatch.
- **Cursor upgrade advisory** — Warns when running Cursor ≠ `testedCursorVersion` (pinned at `npm run package` via `scripts/build/pin-cursor-compat.mjs` / `resolve-cursor-version.mjs`). Extension writes `data/cursor-host.json` from `cursor.version` before spawn; `/health` exposes `cursorUpgradeAdvisory`, `cursorVersion`, `testedCursorVersion`, and `cursorUpgradeServerNotifyAt`. **Extension** — toast after CDP is healthy; **Telegram** — # General post (with retry after redeploy dedupe window); **web** — dismissible banner until the next notify wave. Dedup: `data/cursor-upgrade-server-notify.json` — one notify per channel per server `pid`, 120s blocks redeploy double-posts (same window as startup OK). Locales: `ext.cursorUpgrade.*`, `web.cursorUpgrade.*`, `tg.msg.cursorUpgrade`.
- **Handoff settings probes** — **Test CDP** and **Test Telegram bot** in sidebar (under Show logs); `getMe` / CDP `/json` without starting the server.
- **Approve sound (web)** — Optional setting in ⚙ (default off): short tone when a pending approve appears.
- **`/thread_status` metrics** — Reply now includes composer queue length and pending approve count for the bound chat.
- **Restart server (sidebar)** — Owner gets one-click stop → start next to the power control.
- **Handoff settings add-on buttons** — Wake/Cloudflare actions use delegated clicks; settings panel no longer full-reloads every 5s on addon poll.
- **Tunnel stop (Handoff settings)** — Stop runs the script synchronously, clears `web-tunnel-url.json`, shows a toast, and refreshes status immediately.
- **Tunnel start (Handoff settings)** — Start waits for the script to finish (pid + URL), updates sidebar via `refreshAddons`, then shows success or failure toast.
- **Logging test coverage** — 3100+ unit tests assert stable `code=` tails, context helpers, and path matrices across server, Telegram, CDP, extension, and Wake zones.

### Changed

- **Cloudflare access chip (web)** — No longer shows ✓ from a stale tunnel URL when the server connection is down.
- **Tunnel start notification** — Progress dismisses once pid and URL are on disk, not after the full PowerShell log poll (up to 90s).
- **DATA_DIR write check** — Server and extension verify the runtime data folder is writable before startup; failures surface as a single clear error instead of silent runtime breakage.
- **Structured server logging** — `log-event.ts` adds stable `code=` tails (`TG_*`, `CDP_*`, `QUEUE_*`, `RELAY_*`, `TUNNEL_*`) with `threadId`/`windowId`/`op` context, secret masking, optional JSON mode (`LOG_FORMAT=json`), and dedupe for noisy repeats. Extension Output parses `code=` from child logs; deduped error toasts for DATA_DIR and stale keyboard markers.
- **CursorWake structured logging** — `wake/config.py` `log_line()` appends `code=WAKE_*` on launch, health, poll, and tray events in `data/cursor-wake.log`. Rebuild with `scripts/install/build-cursor-wake.ps1` (or install from a fresh Complete VSIX) after pulling these changes.

### Removed

- **Sidebar port diagnostics** — Removed manual port-owner check/kill UI; stale `bundle.mjs` cleanup before spawn (`spawn-hygiene`) remains automatic on Windows.

### Documentation

- **Log grep guide** — `docs/development.md` documents real event codes (`TG_POLL_ERROR`/`CONFLICT`, `CDP_*`, `QUEUE_*`, `WAKE_*`) instead of stale examples.
- **CursorWake logs** — `docs/guide.md` and `docs/reference.md` note `code=WAKE_*` tails in `cursor-wake.log`.

### Build

- Rebuild CursorWake (`wake/dist/CursorWake.exe`) before Complete VSIX or GitHub `CursorWake-windows.exe` asset; `npm run package` builds Standard and Complete VSIX into `releases/`.

## [1.0.1] - 2026-06-24

### Fixed

- **Web queue force-send** — `forceQueueItem` clicks `.anysphere-icon-button` around `.codicon-arrow-up-two` on Cursor 3.8.22; queue row actions are no longer `<button>` elements, so the previous selector returned "Send button not found".
- **Telegram inline buttons (Build, approvals)** — CursorWake yields long-poll when Handoff is healthy (`connected` + CDP), not after `telegramPoll` (that caused a 409 fight where neither side polled). Raw transport retries `409 Conflict` instead of exiting.
- **CursorWake cold start** — Launch `Cursor.exe` and `.cmd` via `ShellExecuteW` (desktop-shortcut path) instead of `Popen` from frozen tray; while **Raise Cursor** is on and Cursor is down, retry launch every **5 min** (`autostartIntervalSec`, default 300); TG queue messages still launch immediately.
- **Wake launch config** — Prefer `%LOCALAPPDATA%\Programs\cursor\Cursor.exe` over `CursorHandoff-Debug.cmd`; extension stops force-killing Wake on every redeploy when the process is already healthy.
- **Telegram questionnaires** — Option/skip/continue use native CDP `clickAtCoords` on the full option row (not the letter span). **Other** (`qff:`) opens a ForceReply hint in the topic; your **reply** to that message fills the survey textarea via `setQuestionnaireFreeform` (not the main composer). Plain text without Reply gets a nudge. Multi-step surveys auto-advance to the next question after freeform (Enter + stepper click); benign advance skips are quiet in logs.
- **Server logging** — Handoff server appends to `data/handoff-server.log` (under `DATA_DIR`), not the extension working directory.
- **Web questionnaires** — Mobile `questionnaire-bar` shows all AskQuestion steps at once; per-question **Other** textarea syncs via `selectorPath` and `command:questionnaire_freeform`; **Continue** enables when every question is answered locally (`questionnaireForceContinue`); session-scoped drafts prevent stale Other text after a new survey; 43 web client tests.

### Changed

- **Extension UI** — Handoff brand palette (teal `#269199`, login-matched) in settings webview and sidebar; centered logo header; status labels white / values teal.

### Documentation

- **Telegram questionnaires** — `docs/telegram.md` documents AskQuestion mirroring, **Other** + ForceReply freeform, and multi-step advance behavior.
- **Server logs** — `docs/development.md`, `docs/guide.md`, and `docs/reference.md` point to `data/handoff-server.log`.
- **Cursor compatibility** — `docs/development.md` records minimum Cursor 3.8 and last verified **3.8.22** (2026-06-23).
- **CursorWake** — `docs/guide.md`, `docs/telegram.md`, `docs/architecture.md`, `docs/reference.md`, and `docs/development.md` describe handoff, 409 retry, `autostartIntervalSec`, and message-triggered launch.

## [1.0.0] - 2026-06-23

First public release.

### Added

- **Extension & local server** — Cursor / VS Code extension that spawns a bundled Node server; reads Cursor over CDP (`--remote-debugging-port=9222`); no cloud agent runtime.
- **Mobile web client** — Live chat feed at `http://<host>:3000`; tool approval cards; plan widgets (View Plan / Build); code and diff blocks; scroll-up history; queue and `$` force-send.
- **Web access** — Bind modes Localhost / LAN / Custom; web password; Access header chip (Local / LAN / Tailscale / Cloudflare / Direct).
- **Telegram bridge** — Forum topic per chat tab; slash commands and reply keyboard; `raw` Bot API transport (default) with optional `grammy`; bridge commands `/bridge`, `/bridge_all`, `/unbridge`, `/merge_threads`, `/flush` and related thread controls.
- **File relay (inbound)** — Telegram and web accept images, video, voice, GIF, and documents (up to 10 per message, 20 MB Bot API cap). Images paste into the composer; other files save under `.cursor-handoff/file-relay/inbound/` with paths in the message. Unsupported types (contact, location, poll, etc.) get an EN/RU reply.
- **File relay (outbound)** — Agent drops files in `.cursor-handoff/outbox/`; server relays to Telegram. Mixed photos and documents split into separate albums (≤10 each). Stale outbox files auto-purge after 1 hour.
- **Handoff settings** — Single webview panel: Language, Web access, Telegram (five-step setup), Add-ons; English and Russian UI (`locales/en.json`, `locales/ru.json`).
- **CursorWake** (Windows) — Tray companion: Telegram long-poll while Cursor is closed, offline queue, optional Cursor launch, `/pause` and `/resume`; offline queue accepts the same attachment types as the live server.
- **Cloudflare quick tunnel** — Optional `*.trycloudflare.com` HTTPS link on Windows, macOS, and Linux; install and autostart from Handoff settings.
- **Add-ons** — CursorWake and cloudflared install from Handoff settings; **Standard** VSIX downloads from GitHub Releases; **Complete** VSIX ships those binaries inside the package (`CursorWake-windows.exe`, `cloudflared.exe`) — no separate download at install time.
- **Distribution** — Two release packages: `cursor-handoff-{version}.vsix` (Standard) and `cursor-handoff-{version}-complete.vsix` (Complete); shared extension ID `cursor-handoff.cursor-handoff`.
- **Multi-window** — One server owner per PC; other Cursor windows observe; generation-based handoff when the owner stops.
- **Agent skills** — On activation: installs `cursor-handoff-telegram-send` and `plan-widget-tg` global skills and patches User Rules.
- **compatVersion contract** — `compatVersion: 1` in `/health`, `dist/compat-version.json`, and extension pre-spawn gate; bump `scripts/build/compat-version.json` when extension and bundle must ship together.
- **Documentation** — `docs/guide.md`, `docs/telegram.md`, `docs/reference.md`, `docs/architecture.md`, `docs/development.md`; in-editor walkthrough.

### Security

- Web password required for LAN, Custom, Tailscale, and Cloudflare tunnel access; Localhost bind does not require a password.

