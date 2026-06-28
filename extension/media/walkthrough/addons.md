# Optional add-ons

**CursorHandoff: Open Handoff settings** — **Add-ons** section.

## CursorWake (Windows)

Tray companion — receives Telegram while Cursor is closed, can launch Cursor on inbound messages.

- **Install** / **Remove** / **Restart** / **Pause** / **Resume**
- ☑ **Start on Windows login** (`cursorHandoff.wake.startupEnabled`)

The sidebar shows Wake status only — actions stay in the panel or Command Palette.

## Cloudflare quick tunnel

Temporary public HTTPS link (`*.trycloudflare.com`) — phone needs no VPN. Requires a web password.

- **Install cloudflared** / **Remove cloudflared** (palette command or Handoff settings)
- Windows: `winget`; macOS / Linux: `brew` or download to `~/.local/bin` (Complete VSIX bundles `cloudflared.exe` on **Windows only**)
- ☑ **Start tunnel when server starts** (`cursorHandoff.webTunnel.enabled`)

Details: [Cloudflare guide](command:cursorHandoff.openDoc?%22docs%2Fguide.md%23cloudflare%22). After install, the tunnel URL is posted via **`/web_url`** in Telegram # General.

## Agent skills

Command Palette → **CursorHandoff: Install agent skills** (global skills and User Rules).
