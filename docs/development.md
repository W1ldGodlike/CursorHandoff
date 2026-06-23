# Development

Manual verification and dev tooling for people shipping CursorHandoff.

**Users:** [Getting started guide](guide.md) · [Telegram bridge guide](telegram.md) · **Lookup:** [Settings reference](reference.md) · **Design:** [Architecture overview](architecture.md)

---

## Cursor compatibility

| | Version |
|---|---------|
| **Minimum** | Cursor **3.8** (`data-message-index`, thinking messages, unified composer) |
| **Last verified** | **3.8.22** (2026-06-23) |

DOM parsing (`src/ide/parse/tabs.ts`) and TG action clicks (`register-callbacks.ts`) are tuned to this build. After a Cursor upgrade: run `npm run discover`, re-check queue / plan Build / questionnaire / approve, then bump **Last verified** here.

---

## Pre-release smoke

Run after `npm test` is green and before tagging a release.

### Environment

- [ ] Install the packaged VSIX on a profile that is **not** the dev checkout
- [ ] Server log opens with `=== CursorHandoff v1.0.0 ===` (version matches the tag)
- [ ] `GET /health` → `build.version` matches the VSIX; `build.compatVersion: 1`
- [ ] With Telegram on: `telegramPoll: true` within ~30 s of start

### Web client

- [ ] Page loads without socket.io vendor console errors
- [ ] Favicon present; login survives reload
- [ ] Connection badge shows Connected with Cursor in foreground
- [ ] Agent status animates during work, Idle when finished
- [ ] Message kinds render (human, assistant, tool, thought) on Cursor 3.8+
- [ ] Run-command card — Skip/Run; buttons disappear after action
- [ ] Plan widget — View Plan modal, model picker, Build
- [ ] Code blocks and diffs readable
- [ ] Scroll-up history; F5 does not jump the feed to the top
- [ ] Feed filters: All / You / Agent / Tools
- [ ] `$prefix` force-sends; plain text queues under load
- [ ] File attachments from phone (images + documents)

### Telegram

- [ ] Live activity line shimmers; clears when work ends
- [ ] Run command — inline Skip/Run
- [ ] Plan block — todos, View Plan / Build
- [ ] Inbound text without `$` queues while agent busy
- [ ] Inbound `$text` force-submits
- [ ] After redeploy: single “start OK” in # General
- [ ] `/web_url` returns tunnel link in # General
- [ ] `/notify_mode quiet` cuts noise
- [ ] Inbound file (image + document) plus outbox file ([Telegram bridge guide](telegram.md))

### Chats and routing

- [ ] `/new_chat` — new Cursor tab and new TG thread
- [ ] `/close_chat` — tab closes
- [ ] Reply keyboard tile does **not** become an agent prompt
- [ ] After renaming a tab, replies stay in the same thread
- [ ] `/merge_threads` then `/merge_threads yes` on duplicates

### CursorWake (Windows)

- [ ] Message with Cursor off → queued → runs after start
- [ ] Handoff without 409; Wake stops when `connected: true` (do not wait for `telegramPoll` first)
- [ ] `/pause` / `/resume` match tray checkbox

### Cloudflare quick tunnel

- [ ] **Install cloudflared** from Handoff settings (winget on Windows; Homebrew or download on macOS/Linux)
- [ ] Autostart on server start (`cursorHandoff.webTunnel.enabled`) spawns tunnel
- [ ] `data/web-tunnel-url.json` contains `https://….trycloudflare.com`
- [ ] `/web_url` in Telegram # General returns the active link

### Edge cases

- [ ] Switch Cursor windows — state tracks the active one
- [ ] macOS background — stale status, no crash
- [ ] Rapid tab switching — no duplicate TG posts
- [ ] Multiple empty placeholder windows auto-close

---

## CursorWake acceptance

Target: `CursorWake.exe` installed with CursorHandoff **1.0.0+**.

### Baseline

- [ ] Cursor launched with `--remote-debugging-port=9222`
- [ ] Telegram bridge active (`/bridge` done)
- [ ] `install-handoff-wake.ps1` → Startup shortcut present
- [ ] Tray icon visible; **Raise Cursor** enabled
- [ ] `curl /health` → `telegramPoll: true` when Telegram enabled

### Scenarios

**Message while Cursor is closed**

- [ ] Close all Cursor windows; send a task in a mapped topic
- [ ] Bot replies “Starting Cursor… (N queued)”
- [ ] Cursor launches; queue drains; agent executes

**Burst while Cursor boots**

- [ ] Cursor closed; send 2–3 messages quickly
- [ ] All enqueued; FIFO processing after connect

**Autostart without Telegram traffic**

- [ ] Cursor closed; tray checkbox on; ~30 s later Cursor starts on its own

**Pause / resume**

- [ ] `/pause` or uncheck tray — messages queue, Cursor stays off
- [ ] `/resume` — queue runs when the server is healthy

**One hung window among several**

- [ ] Two projects open; hang one window
- [ ] Other window still works; hung target closed after failed polls

**Clean handoff (no 409)**

- [ ] Wake stops when `health.connected` is true (releases poll so Handoff can set `telegramPoll`)
- [ ] Server log free of repeating `409 Conflict`

### Where to read logs

- CursorWake: `data/cursor-wake.log`
- Server: **CursorHandoff: Show logs** or `temp/server.log`

---

## Tests and build

```bash
npm test          # full suite; pretest kills stale runners
npm run build     # compile only
npm run package   # VSIX → releases/
```

**Git vs GitHub Release assets**

| Artifact | In git? | Where users get it |
|----------|---------|-------------------|
| Source code | yes | clone |
| `extension/media/*/exe` | no (build staging) | inside Complete VSIX only |
| `releases/*.vsix` | no | attach to GitHub Release |
| `CursorWake-windows.exe` | no | GitHub Release — Standard Handoff settings download |
| cloudflared binary | no | [cloudflare/cloudflared](https://github.com/cloudflare/cloudflared/releases) (Handoff settings) |

`npm run package` writes all release files under `releases/` (gitignored).

### Release (after 1.0.0)

```bash
npm test
npm run release -- patch    # or minor | major — version, CHANGELOG, commit, tag
npm run package             # releases/*.vsix + CursorWake-windows.exe
npm run release:github      # gh release with all three assets
git push && git push --tags
```

First public tag (`v1.0.0`): skip `npm run release --`, use `package` + `release:github` on the existing tag.

After editing `src/` or `extension/src/`, touch `data/redeploy-requested` for a full redeploy (see `.cursor/skills/cursor-handoff-redeploy`).
