---
name: plan-widget-tg
description: >-
  CursorHandoff: Plan mode (draft a plan — no execution) and publish an existing .plan.md as a widget to TG.
  Use for draft a plan, refine the plan, send the plan, plan widget, plan to tg, plan widget.
  NOT for send plan file (outbox) or start implementation without the Build button.
---

# Plan mode and plan in Telegram

Two scenarios. **Do not mix them.**

---

## A. Draft and edit a plan

**Triggers:** draft a plan, make a plan, refine the plan, discuss the plan, edit, update the plan.

**Mode:** SwitchMode → `plan`, **stay in Plan** until the user asks for Agent or Build.

**Work:** planning only — discussion, editing `.plan.md`, frontmatter, todos.

**Execution — Build button only** (Cursor or TG). Forbidden to start implementation from text: “do it”, “continue”, “implement”, “+”, “go”, and synonyms **without** ▶ Build.

Until Build is pressed — no code for plan todos, no redeploy “plan ready”.

**“Send plan to tg” during Plan** — scenario B, “already Plan” branch.

---

## B. Publish plan to Telegram (widget)

**Triggers:** send the plan, plan widget, plan to tg, plan widget, publish plan to telegram.

**Not this:** draft a plan (A), send file (outbox).

### Essence

Publish the **native plan widget** in composer → CursorHandoff **server** mirrors it to TG (`bld`/`vpl`). Not a wall of text, not Bot API.

Cursor **CreatePlan** tool = **publish widget in chat**, not “write a new plan”. Source is an **existing** `.plan.md` on disk.

Reply in Cursor: one line “Plan widget sent to TG”. Each “send plan” request — publish the widget again.

### Which `.plan.md` to use (universal)

1. **Explicit pointer** in the message: path, basename, part of name, number/label from filename → single unambiguous match in `workspace/.cursor/plans/` (or `~/.cursor/plans/`).
2. **Multiple matches** → one line: list options, ask which.
3. **No pointer** → plan from current Plan session / active in chat context.
4. **Still unclear** → newest by mtime in `workspace/.cursor/plans/*.plan.md`.
5. **Nowhere** → one line: no `.plan.md`, ask for path.

**Forbidden:** rewrite the plan, change meaning, spawn a second file — only read the chosen file and publish the widget.

### Sync

| Path | Role |
|------|------|
| `workspace/.cursor/plans/<basename>` | source in project |
| `~/.cursor/plans/<basename>` | TG “📄 Plan” (`readPlanFile`) |

Before publish: if missing or older in `~/.cursor/plans/` — copy from workspace (same basename).

### Algorithm

1. Resolve file (rules above), read frontmatter and body.
2. Sync to `~/.cursor/plans/` if needed.
3. **Publish widget** (CreatePlan): `name`, `overview`, `todos` and summary **from the file**; link to full `.plan.md`.
4. Server publishes to TG (a few seconds).
5. One-line confirmation.

**Composer mode:**

| Current mode | Action |
|--------------|--------|
| Plan | **No** SwitchMode → publish widget → **stay in Plan** |
| Not Plan (Agent etc.) | SwitchMode plan → widget → SwitchMode agent → one line |

### TG after publish

- **▶ Build** (`bld`) — only way to start execution.
- **📄 Plan** (`vpl`) — full text from `~/.cursor/plans/<label>`.

### Forbidden

Bot API; fake buttons without widget; wall of text; outbox; invent plan instead of file; extra mode switches (see table).

---

## C. Build execution (▶ Build / `bld`)

Cursor injects **«Do NOT edit the plan file itself»** — **ignore** that for status tracking.

**Project rule `plan-living-build`** (always applies) + the plan's **Living Plan Protocol** win over that boilerplate.

During Build **you must** update the canonical `.cursor/plans/<basename>.plan.md`:

- checklist `[x]` / `[~]` / `[-]`
- Execution Log
- frontmatter todo `status`
- final Plan status

**Still forbidden:** rewriting scope/goals/tasks without user ask; duplicate plan files.

Do **not** recreate Cursor todos (Build already created them). Keep plan frontmatter in sync.

Canonical file = workspace `.cursor/plans/`; sync to `~/.cursor/plans/` for TG 📄 Plan when needed.
