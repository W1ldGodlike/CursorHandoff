---
name: cursor-handoff-redeploy
description: Rebuild and redeploy CursorHandoff after server/extension edits. Use when changing src/, extension/src, bundle, stale server, restart server, rebuild, redeploy, install extension, or before testing Telegram/Plan features that need fresh compatVersion=1 code.
---

# CursorHandoff redeploy

## Main rule

The agent **rebuilds and redeploys itself**. Do not ask the user for Reload / Restart / Stop Server.

## Command choice

```
Edited src/ or extension/src?
  → data/redeploy-requested + end iteration (stop-hook). Default always.

Compile check only, don't touch :3000?
  → npm run build

User in a live transport test session?
  → NOT redeploy:check. Flag at end of iteration only.

redeploy:check (rare: build+install, kills :3000, not Cursor)?
  → only if user is not in live TG and explicitly asks for install without Cursor restart

Already built, Cursor restart only?
  → npm run redeploy:restart
```

## Full redeploy — via flag (NOT direct)

Direct run kills Cursor mid-iteration — summary and diff get cut off. Instead:

```powershell
New-Item "data/redeploy-requested" -Force
```

Then: write the user a full summary and **end the iteration**. Stop-hook
(`.cursor/hooks/redeploy-on-stop.ps1`) sees the flag and runs
`scripts/redeploy/redeploy-restart-cursor.ps1`, which:
1. `taskkill` CursorWake + process on `:3000`
2. `npm run build` + `scripts/install/install-extension-local.ps1`
3. Sync `cursorHandoff.dataDir` → `data/`, clear locks
4. Detached: kill Cursor → start Wake + Cursor with debug port

Cursor closes after the iteration ends — expected. Mention in one line that redeploy starts after this message and Cursor will restart itself.

## Build without killing the server

```powershell
npm run build
```

`redeploy:check` is not “no kill”: it drops `:3000`, then `request-start` for the extension. Not during a TG session.

## Verify after the user returns

```powershell
Invoke-WebRequest http://127.0.0.1:3000/health -TimeoutSec 5 -UseBasicParsing
@(Get-Process CursorWake -EA SilentlyContinue).Count
```

OK: `connected=true`, `compatVersion=1`, Wake ≥ 1.

Extension log (latest `CursorHandoff.log` in `%APPDATA%\Cursor\logs\*\exthost\cursor-handoff.cursor-handoff\`):
- `BUILD OK epoch=1`
- `Starting server: ...dist/server/bundle.mjs`
- Wake already running — not stopped
- No fresh `Chat keyboard setup` (compatVersion=1)

## Anti-patterns

- Do not create verify/e2e/sync scripts
- Do not kill Wake because of “2 processes”
- Do not ask for manual reload/restart
