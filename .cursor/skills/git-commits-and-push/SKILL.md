---
name: git-commits-and-push
description: Draft and create local git commits and pushes for this workspace using Conventional Commits in English. Use when the user asks to commit, push, amend, write a commit message, or open a PR. Local agent workflow only — not CONTRIBUTING or public repo policy.
---

# Git commits and pushes (local only)

**Scope:** This workspace only. Not imposed on forks, contributors, or upstream. Do not reference this skill in public docs.

## When to use

- User explicitly asks to **commit**, **push**, **amend**, or **create a PR**
- User asks for a **commit message** for staged or recent changes

**Do not** commit or push without an explicit user request.

## Language

**English only** for subject, body, and PR text.

## Commit message format

```
<type>(<scope>): <subject>

<body — required when change is not trivial>

<footer — optional: Fixes #123, BREAKING CHANGE: …>
```

### Subject

- Imperative mood: `add`, `fix`, `remove` — not `added` / `fixes`
- No trailing period
- Names **what** changed, not `misc fixes` or `update files`

### Body (non-trivial changes)

| Question | Content |
|----------|---------|
| **What** | Concrete behavior or area changed |
| **Why** | Problem, user impact, or constraint |
| **How** | Only if not obvious from the diff |

Skip body for typos or single obvious edits. No filler (`improved quality`, `various updates`).

### Types and scopes

| Type | Use for |
|------|---------|
| `feat` | New user-visible behavior |
| `fix` | Bug fix |
| `docs` | README, `docs/`, public doc comments |
| `chore` | Tooling, deps, gitignore — no runtime change |
| `refactor` | Internal restructure, same behavior |
| `test` | Tests only |
| `build` | Build, VSIX, bundle, packaged binaries |
| `ci` | CI / automation |

**Scope** (optional, lowercase): area of the repo (`telegram`, `extension`, `web`, `scripts`, `core`, …).

## Commit workflow

```
- [ ] git status — know untracked vs modified
- [ ] git diff (+ git diff --staged) — message matches actual change
- [ ] git log -5 — match repo tone and type(scope) style
- [ ] Stage only files that belong to this commit
- [ ] Reject secrets (.env, tokens, runtime auth files under data/, …)
- [ ] Draft message (what / why / how)
- [ ] git commit
- [ ] git status — verify clean or expected remainder
```

### PowerShell (Windows)

Bash HEREDOC is unavailable. Use a here-string:

```powershell
$msg = @"
fix(core): close child processes on server shutdown

The server exited without tearing down spawned workers.
Register shutdown hooks and stop dependents before exit.
"@
git commit -m $msg
```

**Amend** only when the user asked **and** the commit was not pushed (or they accept force-push).

## Push workflow

Only when the user explicitly asks.

```
- [ ] git status — branch ahead/behind remote
- [ ] Confirm branch name is intentional
- [ ] git push (-u origin HEAD if new branch)
- [ ] Never force-push main/master unless user explicitly requests it
```

### Pull request (`gh pr create`)

| Field | Rule |
|-------|------|
| **Title** | Same style as commit subject |
| **Body** | **Summary** (what + why) + **Test plan** |
| **Issues** | `Fixes #N` when applicable |

Run `git status`, `git diff`, and `git log` against the base branch before creating the PR.

## Examples

### Good — feature

```
feat(web): show outbound queue state while the agent is busy

Users had no feedback when a message was waiting.
Expose queue position in the client so the wait is visible.
```

### Good — bug fix

```
fix(extension): skip addon download when install target already exists

Repeat installs replaced a binary that was already in use.
Detect an existing install path and copy bundled files only when missing.
```

### Good — chore / tooling

```
chore: ignore build staging paths in git

Release binaries belong on GitHub Release assets, not in the source tree.
```

### Good — build

```
build: exclude runtime data directories from the VSIX package

The extension package must not ship workspace state folders.
```

### Good — trivial (no body)

```
docs: fix typo in install section
```

### Bad

```
fix: fixed stuff
chore: updates and improvements to various files
feat: WIP
```

Vague subject, no what/why, or unrelated changes bundled together.

### PR body

```markdown
## Summary

- <what changed and why — one bullet per logical change>

## Test plan

- [ ] `npm test`
- [ ] <manual check when user-visible behavior changed>
```
