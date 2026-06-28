# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.1.x (latest release) | Yes |
| 1.0.x | Best effort |
| Older / dev checkout | Best effort |

## Reporting a vulnerability

**Do not** open public GitHub Issues for security bugs.

Use one of these private channels:

1. **GitHub Private vulnerability reporting** — [Report a vulnerability](https://github.com/W1ldGodlike/CursorHandoff/security/advisories/new) on the repository (preferred when enabled).
2. **Email** — [Wild.Godlike@gmail.com](mailto:Wild.Godlike@gmail.com)

Include:

- CursorHandoff version (VSIX or `GET /health` → `build.version`)
- Steps to reproduce
- Impact (data exposure, remote code execution, auth bypass, etc.)

## Response

This is a solo-maintained project. Reports are handled on a **best-effort** basis without a corporate SLA. You will receive acknowledgment when possible and a fix or mitigation in a future release.

## Operational security reminders

- Keep `cursorHandoff.webappPassword` set when binding beyond localhost.
- Restrict Telegram with `/register` tokens or `cursorHandoff.telegram.allowedUsers`.
- Treat quick tunnel URLs as temporary secrets.
