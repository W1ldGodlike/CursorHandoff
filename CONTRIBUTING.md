# Contributing

Thank you for your interest in CursorHandoff.

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Cursor](https://cursor.com/) with CDP enabled (`--remote-debugging-port=9222`)
- Clone the repo, then `npm install` and `npm test`

Developer setup: [docs/guide.md](docs/guide.md) (appendix Standalone) and [docs/development.md](docs/development.md).

## How to contribute

1. **Open an Issue** for bugs, ideas, or larger changes — especially before a big pull request.
2. **Fork** the repository on GitHub.
3. Create a **branch** from `main`.
4. Make your changes; keep the diff focused.
5. Run **`npm test`** (do not run `npx tsx --test` directly — use the npm script so stale runners are cleaned up).
6. Open a **Pull Request** against `main` with a clear description. Link related issues (`Fixes #12`).

## Commit messages

**English only** for subject and body.

Format: `type(scope): subject` — imperative mood (`add`, `fix`, `remove`), no trailing period. Name what changed; avoid `misc fixes` or `update files`.

For non-trivial changes, add a body: **what** changed, **why** (problem or user impact), and **how** only if not obvious. Skip the body for typos or single obvious edits. No filler.

| Type | Use for |
|------|---------|
| `feat` | New user-visible behavior |
| `fix` | Bug fix |
| `docs` | README, `docs/`, public doc comments |
| `chore` | Tooling, deps, gitignore — no runtime behavior change |
| `refactor` | Internal restructure, same behavior |
| `test` | Tests only |
| `build` | Build, VSIX, bundle, Wake exe |
| `ci` | CI / automation |

Scope (optional, lowercase): `telegram`, `wake`, `extension`, `web`, `i18n`, `scripts`, `core`.

Do not commit secrets (`.env`, tokens, `data/telegram-auth.json`, etc.). Stage only files that belong to the commit.

Pull requests: title in the same style as the commit subject; description states what changed and why, plus how you tested (e.g. `npm test`). Link issues with `Fixes #N` when applicable.

## Internationalization

User-facing UI strings live in `locales/en.json` and `locales/ru.json`. Add or update both files; do not hardcode UI text in source.

Public documentation in the repository is **English only**.

## License

By contributing, you agree that your contributions are licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
