---
name: cursor-handoff-telegram-send
description: >-
  Deliver screenshots, photos, and files to Telegram through CursorHandoff.
  Use when the user asks to send a screenshot, image, photo, or file to Telegram,
  or says "to tg", "here", "send to telegram", or wants visual results in the mobile chat.
---

# Send photos and files to Telegram (CursorHandoff)

## When to apply

The user asks for:
- screenshot / screen capture;
- photo / image / picture;
- a file — **and** send it to Telegram, “to tg”, “here”, “this chat”.

Normal layout, references, assets, GenerateImage for work — **without** a send-to-TG request → **do not** use outbox.

## First check whether the project is set up

Delivery works **only** in a configured project. Sign: `.cursor-handoff/outbox/` exists at the workspace root.

**Folder missing → project not configured.** Do not create it yourself or hunt workarounds. Reply:

> File delivery to Telegram is not configured in this project. Tap ⚙️ `/setup_tg_send` in the project’s Telegram thread and repeat the request.

## Where to put files (project configured)

Only: `.cursor-handoff/outbox/` at the **workspace root**.

- Existing file → **copy** into outbox (do not delete the original in the project). Stale outbox files are purged after **1 hour**.
- New screenshot/file for TG → create **directly** in outbox.

The bot delivers to the user’s Telegram thread.

## Filenames

Short **meaningful** names, Latin: `[a-z0-9-_.]`, ~40 chars max, unique per task.

- ✅ `settings-panel.png`, `error-dialog.png`, `before-after.png`
- ❌ `out1.png`, generic `screenshot.png`, non-Latin characters, spaces

## Workflow

1. Do the task (screenshot, merge, file copy).
2. Put result(s) in outbox with a meaningful name. May happen **before** the text reply — the bot waits for idle.
3. Write the **full** chat reply: explanation, comparison, “why” — same as a normal answer.
4. Do not rely on Telegram captions — explanation goes in a separate message after images.

Multiple files per task is fine. Photos and documents are sent as separate Telegram albums (≤10 each).

## Do not

- Put layout refs, mockups, temporary assets in outbox.
- Scan the whole project for images to send to TG.
- Wait for a special `!send` command — a plain-language request is enough.

## meta.json (optional)

Usually unnecessary. For one short album caption (rare):

`{name}.meta.json` next to the file: `{"caption": "Short caption"}`

Default explanation stays in the Cursor chat reply.
