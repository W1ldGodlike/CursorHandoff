# Development

Build, logs, and release notes for maintaining CursorHandoff.

**Users:** [Getting started guide](guide.md) · [Telegram bridge](telegram.md) · **Lookup:** [Settings reference](reference.md) · **Design:** [Architecture overview](architecture.md)

---

## Cursor compatibility {#cursor-compatibility}

| | Version |
|---|---------|
| **Minimum** | Cursor **3.8** (`data-message-index`, thinking messages, unified composer) |
| **Last verified** | **3.9.16** (2026-06-27) |

DOM parsing (`src/ide/parse/tabs.ts`) and TG action clicks (`register-callbacks.ts`) are tuned to this build. **`npm run package`** pins `testedCursorVersion` from the Cursor install on the build machine (`scripts/build/pin-cursor-compat.mjs`). Bump **Last verified** here after you smoke a newer Cursor build.

<a id="upgrade-advisory"></a>

### Upgrade advisory (version mismatch)

When `cursor.version` (from `<data-root>/cursor-host.json`) ≠ `testedCursorVersion` in the VSIX manifest:

| Channel | When | Dedup |
|---------|------|-------|
| Extension | Toast after CDP healthy | Once per server process (`extension` channel in `cursor-upgrade-server-notify.json`) |
| Telegram | # General after CDP healthy | Same file (`telegram` channel); retries after 120s redeploy window |
| Web | Banner while mismatch | Dismiss stored per wave (`cursorUpgradeServerNotifyAt` in `/health`) |

Redeploy within 120s does not double-post (same rule as startup OK). See [Architecture — Cursor upgrade](architecture.md#cursor-upgrade).

---

## Logs

| Log | Path |
|-----|------|
| Merged (sidebar **Handoff log**) | `<data-root>/handoff.log` — `[server\|ext\|wake]` + local time + JSON |
| Server only | `<data-root>/handoff-server.log` |
| Extension | `<data-root>/handoff-ext.log` |
| CursorWake | `<data-root>/cursor-wake.log` (`code=WAKE_*`) |

**Grep by event code** (paths relative to data root; dev checkout uses `<repo>/data/`):

```bash
rg "code=TG_POLL_(ERROR|CONFLICT)" handoff-server.log
rg "code=STARTUP_AUDIT" handoff-server.log
rg "compatVersion-mismatch" handoff-server.log
rg "code=CDP_RECONNECT_LOST" handoff-server.log
rg "code=WAKE_" cursor-wake.log
rg "code=QUEUE_" handoff-server.log
```

Set `LOG_FORMAT=json` for machine-readable lines with the same `code` and context fields.

---

## Tests and build

```bash
npm test          # full suite; pretest kills stale runners
npm run build     # compile only
npm run package   # Standard + Complete VSIX → releases/ (+ CursorWake-windows.exe when wake/dist exists)
```

**CursorWake rebuild** (after `wake/*.py` changes; Complete VSIX embeds the exe):

```powershell
.\scripts\install\build-cursor-wake.ps1
```

Then `npm run package` so `extension/media/wake/CursorWake.exe` and `releases/CursorWake-windows.exe` match sources.

| Artifact | In git? | Where users get it |
|----------|---------|-------------------|
| Source | yes | clone |
| `releases/*.vsix` | no | GitHub Release |
| `CursorWake-windows.exe` | no | GitHub Release or Complete VSIX |
| cloudflared | no | [cloudflare/cloudflared](https://github.com/cloudflare/cloudflared/releases) or Handoff settings |

---

## Release

```bash
npm test
npm run release -- patch    # or minor | major — version, CHANGELOG, move random local/brand/concepts → media/handoff-release-hero.png, commit, tag
npm run package             # releases/*.vsix + CursorWake-windows.exe
npm run release:github      # gh release with VSIX + handoff-release-hero.png + notes from CHANGELOG
git push && git push --tags
```

First public tag (`v1.0.0`): skip `npm run release --`, use `package` + `release:github` on the existing tag.

After editing `src/` or `extension/src/`, touch `data/redeploy-requested` for a full redeploy (stop-hook runs `scripts/redeploy/redeploy-restart-cursor.ps1`).
