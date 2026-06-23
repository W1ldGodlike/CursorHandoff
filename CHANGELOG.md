# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Web queue force-send** — `forceQueueItem` clicks `.anysphere-icon-button` around `.codicon-arrow-up-two` on Cursor 3.8.22; queue row actions are no longer `<button>` elements, so the previous selector returned "Send button not found".
- **Telegram inline buttons (Build, approvals)** — CursorWake releases the bot long-poll when Handoff reports `connected: true`, instead of waiting for `telegramPoll` first (deadlock: Wake polled `message` only, so `callback_query` never reached the server).

### Documentation

- **Cursor compatibility** — `docs/development.md` records minimum Cursor 3.8 and last verified **3.8.22** (2026-06-23).

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

