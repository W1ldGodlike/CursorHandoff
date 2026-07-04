# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.0] - 2026-07-04

![CursorHandoff brand concept](https://github.com/W1ldGodlike/CursorHandoff/releases/download/v1.5.0/handoff-release-hero.png)


### Added

- **Generate image approval cards (web)** — When Cursor shows a **Generate image** tool card (Smart Mode or explicit approval), Handoff mirrors the prompt and **Run** / **Skip** on the mobile feed. CDP uses scoped paths `generate-image:{toolCallId}:run|skip` (`generate-image-selectors.ts`, `generate-image-merge.ts`, `navigation.ts`).
- **Generated image preview (web)** — After **Generated image** completes, a post-extract pass collects inline `img` / `canvas` from composer tool rows over CDP, saves PNG/WebP sidecars under `<data-root>/feed-images/`, attaches `images[]` refs on chat messages, and the web client renders `<img src="/api/feed-image/{id}">` below the tool line.
- **Feed image API** — Authenticated `GET /api/feed-image/:id` serves sidecar bytes with private cache headers (`src/media/feed-images.ts`, `src/web/http-routes.ts`).
- **Unified extract finalize** — `finalizeExtractedState()` runs feed-image enrich on every extraction path: home window via `DOMExtractor` postProcess from `main.ts`, and parallel window polls via `WindowMonitor.extractFromClient`.
- **Release hero automation** — `scripts/release/release-hero-image.ts` moves a random `local/brand/concepts/` image into tracked `media/handoff-release-hero.png`, embeds it in CHANGELOG, and `release:github` uploads it to GitHub Release assets.

### Changed

- **Generate image parser** — `extractGenerateImageFields` in `tabs.ts` matches only real Generate/Generating image headers so shell commands are not mislabeled as Generate image; approval suffixes stripped from command text.
- **State diff** — `elementsSignature` / `elementContentKey` include `images` so the web feed updates when previews arrive after the tool line.
- **Approval merge** — Generate image cards merge through a dedicated module; shell dedupe skips `description: Generate image` rows.

### Documentation

- **Web client** — `docs/guide.md`: Generate image approval + generated-image preview on web.
- **Reference** — `docs/reference.md`: `feed-images/`, `/api/feed-image/:id`, Generate image `selectorPath` patterns.
- **Architecture** — `docs/architecture.md`: feed-image extract pipeline and generate-image merge module.
- **Release** — `docs/development.md`: release flow notes brand hero image step.

### Notes

- **Telegram** — Generate image previews and `sendPhoto` on diff are not in this release (web only).

## [1.4.0] - 2026-07-03

![CursorHandoff brand concept](https://github.com/W1ldGodlike/CursorHandoff/releases/download/v1.4.0/handoff-release-hero.png)

### Added

- **Confirm search approval cards (web + Telegram)** — When Cursor asks before a web search, Handoff mirrors **Continue**, **Cancel**, and **Auto-search web** on the mobile feed and in Telegram inline keyboards. CDP uses coordinate clicks on empty-text `.cursor-button` rows; stable paths are scoped per `toolCallId` and query (`confirm-search:{id}:{query}:continue|cancel|auto-search-toggle`).
- **Delete file approval cards (web + Telegram)** — **Accept** / **Reject** for agent `Delete` tool calls, same `run_command` button row as shell Run/Skip. Paths: `delete-file:{toolCallId}:{filename}:accept|reject`. Parser promotes `Delete` tool bubbles when `pendingApprovals` is empty; filename parsing and CDP coordinate clicks for Reject/Accept.
- **Long shell command display (web + Telegram)** — Full command text in approval cards and notifications (no 80-char clip). Telegram soft-wraps long one-liners in `<pre>`. DOM parser accepts commands up to 32k chars for `pendingApprovals` and `isPlausibleShellCommand`.
- **Web shell syntax highlighting** — `code-highlight.js` colors `run_command` shell cards, markdown `<pre><code>`, and native code blocks (bash / PowerShell / `node -e` detection; token colors aligned with Telegram `language-bash` blocks). Delete file cards keep plain filename text (no `$` shell prompt).
- **README: Cursor mobile vs Handoff** — Feature comparison table (cloud agents, Remote Control, Telegram, approvals, plan widgets, localization).

### Changed

- **Approval merge pipelines** — Shell, confirm-search, and delete-file run in separate modules (`shell-approval-merge.ts`, `confirm-search-merge.ts`, `delete-file-merge.ts`); shell `pendingApprovals` merge skips `description: Delete` cards so filenames and `delete-file:` paths are not overwritten by shell commands.
- **Shell Run/Skip sync** — `pendingApprovals` keeps shell approval cards aligned on web and Telegram; stale duplicate `run_command` rows are deduped without stripping confirm-search or delete-file buttons.
- **Confirm search CDP clicks** — Multi-card support: action paths use the matched message `toolCallId`; CDP finds cards in two passes (id+query, then query only); buttons clear when the approval leaves `pendingApprovals`.
- **Extension locale switch** — Changing Handoff language stops and restarts the server owner (`spawn-hygiene`, owner lock) so `locales/` reload without a manual restart.

### Documentation

- **Web client** — `docs/guide.md` lists shell, Confirm search, and Delete file approval cards; shell command syntax highlighting on web.
- **Telegram** — `docs/telegram.md` documents tool approval inline buttons.
- **Architecture** — `docs/architecture.md` notes split approval merge modules under `src/ide/parse/`.
- **Reference** — `docs/reference.md` documents confirm-search and delete-file `selectorPath` patterns.

## [1.3.0] - 2026-06-30

### Removed

- **Telegram `/thread_rename`** — Use Telegram’s native “Edit topic” on the forum thread; the bot still renames topics when Cursor tab titles change (`syncForumTopicLabel`).

### Added

- **Smart open project (Cursor + TG)** — After launching a closed project, 10 s settle then reconcile: existing Cursor tabs + alive forum topic → no `newChat`; restored tab with dead TG mapping → new topic only; empty window → `newChat` + topic. Dead `telegram-topics.json` rows probed via `isTopicReachable` and removed. TG `/projects`, `/open_project`, and web project picker share `openProjectByPath`.
- **Web project picker** — Header project switcher (always visible) and **⋮ → Open project** open a sheet listing Cursor-known projects (same sources as TG `/projects`). Tap opens or switches via `open-project.json`; **Close** on open rows uses CDP `closeTarget` (mapping unchanged). Socket: `command:list_projects`, `command:open_project`, `command:close_project`.
- **Telegram `/close_project`** — From a **linked project thread** (not # General): close only that project's Cursor window via CDP `json/close`. Forum topic and `telegram-topics.json` mapping stay; write in the thread later to reopen via Wake/server routing.
- **Docs: who opens projects from Telegram** — [guide § opening-projects-from-telegram](docs/guide.md#opening-projects-from-telegram): Wake starts the IDE when Cursor is off; Handoff server + extension open the folder (`open-project.json`). Cheat sheet for Wake on/off and Cursor open/closed.
- **Web send progress on attachments** — While a message with photos or files is uploading and the server is pasting into Cursor, the Send button shows a spinner, disables Send and attach, and uses localized “Sending…” label until `command:result` returns.
- **Telegram `/auto_off` and `/auto_on`** — Toggle model **Auto** in Cursor from a project thread (same CDP path as the web Model sheet). When Auto is on, `/pick_model` hints to run `/auto_off` first, then `/pick_model` again for inline model buttons.

### Fixed

- **Web project list after close** — `close_project` drops the window-monitor snapshot, refreshes CDP window list, and treats already-closed projects as success. `findOpenWindowForPath` uses live CDP targets only (stale snapshots purged) so the picker no longer shows «open» after close or switch-opens the wrong window.
- **Telegram disconnect notice on `/close_project`** — Closing the active CDP target no longer posts `⚠️ Disconnected from Cursor IDE` to # General; `isClosingTarget` mirrors the existing `isSwitchingWindow` guard while the server reconnects to another window.
- **CDP model Auto toggle** — Detect Auto-on when the model list is hidden (empty menu + Auto row); retry toggle and longer settle so `/auto_off` / `/auto_on` from Telegram and web match Cursor 3.9.x.

## [1.2.0] - 2026-06-28

### Added

- **Web mode picker** — Header **Mode** pill opens a bottom sheet; options load from the live Cursor mode menu via CDP (`get_mode_options` / `set_mode`). Supports Agent, Plan, Debug, Multitask, and Ask on Cursor 3.9.x unified dropdown.
- **Web model picker** — Header **Model** pill mirrors the IDE model menu: Auto toggle, model list when Auto is off, per-row **Edit → Options** (Fast, Thinking, Context, Effort, and other controls read from DOM). No hardcoded model names; round-trip uses stable DOM ids or `label::<text>`.
- **CDP navigation helpers** — Shared in-browser model/menu lookup for Cursor ~3.5.17+ (`ui-model-picker__trigger`, portaled `[role="menu"]`, `composer-unified-dropdown-model`) and mode items (`[id*="composer-mode-"]`).

### Changed

- **Telegram `/set_mode` and `/pick_model`** — Use the same CDP option snapshots as the web client; Auto-on model pick shows a hint to turn Auto off in Cursor instead of a fake list.
- **Extract `mode.available`** — No longer hardcoded; empty in poll until a menu read (web/TG open the sheet or command path).

### Removed

- **Telegram reply keyboards** — `/menu` and on-demand reply-keyboard tiles in **# General** and project threads; use native slash commands only (`setMyCommands` and the bot menu button). CursorWake no longer posts reply keyboards on `/pause`, `/resume`, or `/status`.

### Documentation

- README and bridge docs no longer describe reply-keyboard tiles or `/menu`.
- **Cursor compatibility** — Last verified **Cursor 3.9.16** (2026-06-27); `testedCursorVersion` pinned at package build.
- **Web client** — `docs/guide.md` documents Mode and Model pills on the mobile header.

### Build

- Rebuild **CursorWake** (`scripts/install/build-cursor-wake.ps1`) before Complete VSIX or `CursorWake-windows.exe` release asset — Wake command list synced (no `/menu`).

## [1.1.0] - 2026-06-28

### Fixed

- **Window hang recovery** — Auto-close applies only to the home CDP target after repeated main extraction failures; parallel-polled aux windows (e.g. Cursor Agents) are no longer closed after null polls.
- **Parallel window poll** — Background CDP polls skip non-home targets with no workspace folder (e.g. Cursor Agents), eliminating repeated `STATE_WINDOW_POLL_NULL` log noise.
- **Telegram long-poll resilience** — Poll loops no longer stop on abort-like transient fetch errors after Telegram API failures; they now terminate only on explicit local stop abort.
- **Telegram command dedup** — `dispatchCommand` no longer throws at build time when logging duplicate inbound commands (`threadId` used before declaration).

### Added

- **compatVersion gate (extension)** — Before spawning `bundle.mjs`, verify `build-manifest.json`, `dist/compat-version.json`, and package version align; block spawn with one clear error on mismatch.
- **Cursor upgrade advisory** — Warns when running Cursor ≠ `testedCursorVersion` (pinned at `npm run package` via `scripts/build/pin-cursor-compat.mjs` / `resolve-cursor-version.mjs`). Extension writes `data/cursor-host.json` from `cursor.version` before spawn; `/health` exposes `cursorUpgradeAdvisory`, `cursorVersion`, `testedCursorVersion`, and `cursorUpgradeServerNotifyAt`. **Extension** — toast after CDP is healthy; **Telegram** — # General post (with retry after redeploy dedupe window); **web** — dismissible banner until the next notify wave. Dedup: `data/cursor-upgrade-server-notify.json` — one notify per channel per server `pid`, 120s blocks redeploy double-posts (same window as startup OK). Locales: `ext.cursorUpgrade.*`, `web.cursorUpgrade.*`, `tg.msg.cursorUpgrade`.
- **Handoff settings probes** — **Test CDP** and **Test Telegram bot** in sidebar (under Handoff log); `getMe` / CDP `/json` without starting the server.
- **Approve sound (web)** — Optional setting in ⚙ (default off): short tone when a pending approve appears.
- **`/thread_status` metrics** — Reply now includes composer queue length and pending approve count for the bound chat.
- **Restart server (sidebar)** — Owner gets one-click stop → start next to the power control.
- **Handoff settings add-on buttons** — Wake/Cloudflare actions use delegated clicks; settings panel no longer full-reloads every 5s on addon poll.
- **Tunnel stop (Handoff settings)** — Stop runs the script synchronously, clears `web-tunnel-url.json`, shows a toast, and refreshes status immediately.
- **Tunnel start (Handoff settings)** — Start waits for the script to finish (pid + URL), updates sidebar via `refreshAddons`, then shows success or failure toast.
- **Logging test coverage** — 3100+ unit tests assert stable `code=` tails, context helpers, and path matrices across server, Telegram, CDP, extension, and Wake zones.
- **Safe log strings (p.3)** — `sanitizeLogForUi` / `sanitizeErrorForUser` redact secrets and shorten home paths in extension Output, `handoff-server.log`, Telegram replies, and web errors. Structured JSON disk lines skip re-sanitization in `writeLog` so TG/HTML previews stay valid JSON.
- **Unified Handoff log (p.4)** — Server **visor** (`log-visor.ts`) tail-merges `handoff-server.log`, `handoff-ext.log`, and optional `cursor-wake.log` into `data/handoff.log` every 4 s. Each line: `[server]` / `[ext]` / `[wake]`, local `DD.MM.YYYY HH:mm:ss:SSS`, then JSON (`ts` unix ms inside). Extension mirrors extension-native lines to `handoff-ext.log`; server stdout uses a separate pipe (not ext disk). Sidebar **Handoff log** opens the merged file in the editor (scroll to end); Cursor reloads the tab as the visor appends.

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
- **Handoff log docs** — `docs/guide.md`, `docs/reference.md`, and `docs/development.md` describe merged `handoff.log`, visor sources, and the **Handoff log** sidebar command (replaces legacy “Show logs” / AppData extension log).

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

