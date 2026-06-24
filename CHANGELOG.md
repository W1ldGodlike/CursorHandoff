# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **Build fingerprint** — `compatVersion: 1` in `/health` for extension/server compatibility checks.
- **Documentation** — `docs/guide.md`, `docs/telegram.md`, `docs/reference.md`, `docs/architecture.md`, `docs/development.md`; in-editor walkthrough.

### Security

- Web password required for LAN, Custom, Tailscale, and Cloudflare tunnel access; Localhost bind does not require a password.

