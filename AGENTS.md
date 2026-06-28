# CursorHandoff — agent map

Entry point for AI coding agents working in this repository.

## What this project is

**CursorHandoff** = VS Code / Cursor **extension** + bundled **local server** + optional **Telegram** transport + optional **CursorWake** tray companion (Windows) + optional **Cloudflare quick tunnel** (Windows, macOS, Linux).

The server reads Cursor state over CDP (`--remote-debugging-port=9222`), serves a mobile **web client**, and mirrors chat to Telegram forum topics. It does not host models or run agents in the cloud.

## Repository layout

```
CursorHandoff/
├── extension/src/     # VS Code extension (spawn server, Handoff settings webview, sidebar)
├── src/
│   ├── core/          # Entry (main.ts), config, paths, shutdown, compatVersion audit
│   ├── ide/           # CDP session, DOM extraction, command executor
│   ├── state/         # State diff/broadcast, window monitor, hang recovery
│   ├── web/           # Express + socket.io, tunnel helpers
│   ├── telegram/      # Bot transport, commands, topics, formatters, UI menus
│   ├── media/         # Outbox watcher, TG file relay
│   ├── workspace/     # Offline queue, project dirs, launcher
│   ├── client/        # Static web UI
│   ├── discovery/     # DOM selector discovery tool
│   └── i18n/          # Locale loader (t.ts)
├── locales/           # en.json, ru.json — only place for RU UI strings
├── scripts/           # build/, dev/, install/, release/, redeploy/, tunnel/
├── docs/              # Public English documentation
├── data/              # Runtime state (gitignored)
└── tests/             # core/, extension/, media/, telegram/, web/, workspace/
```

Extension never imports server modules — it spawns `dist/server/bundle.mjs` as a child process.

## Commands

| Task | Command |
|------|---------|
| All tests | `npm test` |
| Web client tests only | `npm run test:web` |
| Build (no Cursor restart) | `npm run build` |
| Package VSIX | `npm run package` |
| DOM selector discovery | `npm run discover` |
| Full redeploy (kills Cursor) | `npm run redeploy` |

**After changing `src/` or `extension/src/`:** request redeploy by creating `data/redeploy-requested` (stop-hook runs `scripts/redeploy/redeploy-restart-cursor.ps1`). Do not ask the user to reload manually.

**Tests:** always `npm test` — never bare `npx tsx --test` (stale runners leak memory).

## Product skills (optional globals)

Run once from repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install/install-handoff-globals.ps1
```

Installs `cursor-handoff-telegram-send` and `plan-widget-tg` skills under `~/.cursor/skills/`.

**Plans:** `.cursor/plans/` is gitignored. On **▶ Build**, update checklist + Execution Log per **`.cursor/rules/plan-living-build.mdc`** — overrides Cursor's «do not edit plan file» boilerplate.

## i18n

- Public docs, README, comments in git: **English**
- Russian UI: **`locales/ru.json` only** (paired with `locales/en.json`)
- Walkthrough copy: `extension/media/walkthrough/*.md` (English)

## Key product paths

| Path | Purpose |
|------|---------|
| `<data-root>/` | Bot state, queue, sessions — [data root resolution](docs/reference.md#data-root-resolution) (`<repo>/data/` in dev; VSIX install folder `/data` when another workspace is open) |
| `<workspace>/.cursor-handoff/outbox/` | Files agent sends to Telegram (stale purge after 1 h) |
| `<workspace>/.cursor-handoff/file-relay/` | Inbound staging: `photo/inbound/` (images), `inbound/` (other files) |

## Telegram bridge commands

Slash names are stable API surface (1.0.0):

- `/bridge` — link active Cursor tabs to forum threads
- `/bridge_all` — topics for all tabs and windows
- `/unbridge`, `/merge_threads`, `/flush` — disable, merge duplicates, full reset

Full list: `src/telegram/transport/poll-loop.ts` → `BOT_COMMANDS`.

## What not to do

- No hardcoded user-facing strings outside `locales/`
- No references to internal planning artifacts in public docs
- Keep changes minimal; extend existing modules instead of parallel abstractions

## Further reading

- [docs/guide.md](docs/guide.md)
- [docs/telegram.md](docs/telegram.md)
- [docs/reference.md](docs/reference.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/development.md](docs/development.md)
