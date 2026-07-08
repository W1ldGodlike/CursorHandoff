# CursorHandoff — agent map

Entry point for AI coding agents working in this repository.

**Version:** `package.json` → `version` (docs and VSIX names follow release bumps; this file does not pin a number).

## What this project is

**CursorHandoff** = VS Code / Cursor **extension** + bundled **local server** + optional **Telegram** transport + optional **CursorWake** tray companion (Windows) + optional **Cloudflare quick tunnel** (Windows, macOS, Linux).

The server reads Cursor state over CDP (`--remote-debugging-port=9222`), serves a mobile **web client**, and mirrors chat to Telegram forum topics. Phone and Telegram can drive the same agent: tabs, composer, approvals, mode/model, **project open/switch/close**, and plan widgets. It does not host models or run agents in the cloud.

**Cursor compatibility:** minimum Cursor **3.8**; last verified **3.10.20** — see [docs/development.md](docs/development.md#cursor-compatibility). After a Cursor IDE update, run the DOM probe playbook (local tooling below) before assuming selectors still work.

## Repository layout

```
CursorHandoff/
├── extension/src/     # VS Code extension (spawn server, Handoff settings webview, sidebar, Wake/tunnel)
├── src/
│   ├── core/          # Entry (main.ts), config, paths, shutdown, compatVersion audit, logging
│   ├── ide/           # CDP session; parse/* (tabs, messages, composer, plan-widget); actions/*
│   ├── state/         # State diff/broadcast, window monitor, hang recovery
│   ├── web/           # Express + socket.io, tunnel, plans API, project socket commands
│   ├── telegram/      # Bot transport, commands, topics, formatters, UI menus
│   ├── media/         # Outbox watcher, TG file relay, inbound attachments
│   ├── workspace/     # Offline queue, project dirs, launcher, project-web (TG + web picker)
│   ├── client/        # Static web UI
│   ├── discovery/     # DOM selector discovery tool (`npm run discover`)
│   └── i18n/          # Locale loader (t.ts)
├── wake/              # CursorWake Python sources → `CursorWake.exe` (Windows)
├── locales/           # en.json, ru.json — only place for RU UI strings
├── scripts/           # build/, dev/, install/, release/, redeploy/, tunnel/
├── templates/         # Global skill templates for `install-handoff-globals.ps1`
├── docs/              # Public English documentation
├── data/              # Runtime state (gitignored; `<repo>/data/` in dev)
├── local/             # Local dev sandboxes (gitignored): dom-probe, formatter-sandbox
└── tests/             # core/, extension/, media/, state/, telegram/, web/, workspace/
```

Extension never imports server modules — it spawns `dist/server/bundle.mjs` as a child process. Extension and bundle share **`compatVersion`**; bump together when they must ship as a pair (`scripts/build/compat-version.json`, `src/core/compat-version.ts`). Details: [docs/architecture.md](docs/architecture.md#compatversion-contract).

## Commands

| Task | Command |
|------|---------|
| All tests | `npm test` |
| Web client tests only | `npm run test:web` |
| Build (no Cursor restart) | `npm run build` |
| Package both VSIX + Wake exe | `npm run package` |
| Standard / Complete VSIX only | `npm run package:standard` / `npm run package:complete` |
| DOM selector discovery | `npm run discover` |
| Version bump + CHANGELOG + tag | `npm run release -- patch` (or `minor` / `major`) |
| GitHub Release upload | `npm run release:github` |
| Full redeploy (kills Cursor) | `npm run redeploy` |
| Build + install ext, no Cursor kill | `npm run redeploy:check` |
| Cursor restart only | `npm run redeploy:restart` |
| Rebuild CursorWake (after `wake/` edits) | `powershell scripts/install/build-cursor-wake.ps1` then `npm run package` |

**After changing `src/` or `extension/src/`:** request redeploy by creating `data/redeploy-requested` (stop-hook runs `scripts/redeploy/redeploy-restart-cursor.ps1`). Do not ask the user to reload manually. Full workflow: `.cursor/rules/cursor-handoff-redeploy.mdc` and `.cursor/skills/cursor-handoff-redeploy/SKILL.md`.

**Tests:** always `npm test` — never bare `npx tsx --test` (stale runners leak memory). See `.cursor/rules/npm-test-only.mdc`.

**Release:** `npm test` → `npm run release -- …` → `npm run package` → `npm run release:github` → `git push && git push --tags`. See [docs/development.md](docs/development.md#release).

## Workspace rules and skills

Always-applied rules live in **`.cursor/rules/`** (minimal code, redeploy, npm test, plan Build checklist, TG file relay, git commits local workflow).

**Repo skills** (`.cursor/skills/`, tracked in git):

| Skill | Use when |
|-------|----------|
| `cursor-handoff-redeploy` | After `src/` or `extension/src/` edits |
| `cursor-handoff-telegram-send` | User asks for screenshot/file in Telegram |
| `plan-widget-tg` | Draft/refine plan or publish plan widget to TG |
| `git-commits-and-push` | User asks to commit or push |

**Optional global install** (once per machine):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install/install-handoff-globals.ps1
```

Copies `cursor-handoff-telegram-send` and `plan-widget-tg` from `templates/cursor-handoff-global/` to `~/.cursor/skills/`.

**Plans:** `.cursor/plans/` is gitignored. On **▶ Build**, update checklist + Execution Log per **`.cursor/rules/plan-living-build.mdc`** — overrides Cursor's «do not edit plan file» boilerplate.

## Local dev tooling (gitignored)

Not shipped in VSIX; for maintainers after Cursor DOM changes or formatter regressions:

| Path | Purpose |
|------|---------|
| `local/dom-probe/` | Selector extract → CDP probe → compare vs baseline |
| `local/formatter-sandbox/` | Record CDP JSONL, fixture tests, contextual states for dom-probe |

Playbook skill and rule are **local-only** (gitignored): `.cursor/skills/cursor-dom-probe/`, `.cursor/rules/cursor-dom-update.mdc`. Entry: `local/dom-probe/README.md` (quick start сверху, **Подробнее** ниже).

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
| `<data-root>/open-project.json` | One-shot folder open from Telegram or web |

## Web and Telegram surfaces

**Web socket.io** (project picker): `command:list_projects`, `command:open_project`, `command:close_project` — `src/workspace/project-web.ts`, wired in `src/web/http-routes.ts`. Smart open settles ~10s and reconciles TG thread mapping when needed.

**Telegram slash commands** — stable API; canonical list in `src/telegram/commands/registry.ts` → `BOT_COMMANDS` (also re-exported from `poll-loop.ts`):

- **Bridge:** `/bridge`, `/bridge_all`, `/unbridge`, `/merge_threads`, `/flush`
- **Projects:** `/projects`, `/open_project`, `/close_project`
- **Chat / agent:** `/new_chat`, `/close_chat`, `/set_mode`, `/pick_model`, `/auto_on`, `/auto_off`
- **Diagnostics:** `/status`, `/whereami`, `/thread_status`, `/last_commit`, `/web_url`, `/notify_mode`
- **Wake:** `/pause`, `/resume`
- **Setup:** `/register`, `/setup_tg_send`

User-facing behavior: [docs/telegram.md](docs/telegram.md). Socket table: [docs/reference.md](docs/reference.md#web-socketio--project-picker).

## What not to do

- No hardcoded user-facing strings outside `locales/`
- No references to internal planning artifacts in public docs
- Keep changes minimal; extend existing modules instead of parallel abstractions (see `.cursor/rules/minimal-code.mdc`)
- Do not commit or push unless the user asks
- Do not run full redeploy (`redeploy:check` / direct redeploy script) during an active TG/web acceptance session — use `data/redeploy-requested` at end of iteration instead

## Further reading

- [docs/guide.md](docs/guide.md)
- [docs/telegram.md](docs/telegram.md)
- [docs/reference.md](docs/reference.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/development.md](docs/development.md)

## Cursor Cloud specific instructions

The cloud VM is **headless Linux**. Dependencies are refreshed automatically on startup (`npm install`); Node 22 is available. Standard commands (`npm run build`, `npm test`, `npm run test:web`) are in the Commands table above.

**Hard limitation — no real end-to-end here.** The product drives a *local GUI Cursor IDE* over CDP (`--remote-debugging-port=9222`). No Cursor/Electron GUI exists on this VM, so the server runs in a permanent **CDP-disconnected** state: startup logs repeat `CDP_CONNECT_FAIL` / `CDP_RECONNECT_SCHEDULE` — this is expected, not a bug. Driving an actual agent (tabs, composer, approvals) cannot be exercised here.

**What you can run and test headless:**
- `npm test` — jsdom-mocked, needs no Cursor/Telegram. 4 tests in `tests/workspace/` (`folderUriToPath`, `projectScore`, `workspace-uri`) assert **Windows** backslash paths and always fail on Linux (`uriPathToNative` branches on `process.platform === 'win32'`); treat these 4 as expected xfails, everything else passes.
- Run the server standalone (no extension needed): `npm run build` then `WEBAPP_PASSWORD=<pw> node dist/core/main.js` → serves the mobile web client + socket.io on `http://127.0.0.1:3000`. Log in at `/` (redirects to `/login`) with the password to get an authenticated live session; `/health` gives liveness (`connected:false` without Cursor). This is the realistic smoke test of the web surface.

**Not usable on Linux:** all `scripts/install/*.ps1`, `scripts/redeploy/*.ps1`, and the `redeploy` / `redeploy:check` / `redeploy:restart` npm scripts are PowerShell/Windows-only. CursorWake (`wake/`) is Windows-only. The redeploy stop-hook workflow (`data/redeploy-requested`) targets a local Windows dev box, not this VM.

Telegram transport is off by default and needs an external bot token + supergroup + network egress to `api.telegram.org`; leave disabled unless a task requires it.
