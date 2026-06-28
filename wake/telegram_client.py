"""Telegram long-poll for CursorWake when Cursor is not healthy."""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

from config import Config, log_line
from health import cursor_process_running
import storage

# Keep in sync with src/telegram/commands/registry.ts (BOT_COMMANDS).
TELEGRAM_BOT_COMMANDS: list[dict[str, str]] = [
    {"command": "register", "description": "Register: /register <token>"},
    {"command": "bridge", "description": "Link active Cursor tabs to forum threads"},
    {"command": "bridge_all", "description": "Topics for all tabs and windows"},
    {"command": "unbridge", "description": "Disable bridge and remove topics"},
    {"command": "merge_threads", "description": "Merge duplicate forum threads"},
    {"command": "close_chat", "description": "Close Cursor chat tab"},
    {"command": "new_chat", "description": "New chat + new Telegram thread"},
    {"command": "flush", "description": "Delete all topics (full reset)"},
    {"command": "status", "description": "Connection and bridge status"},
    {"command": "set_mode", "description": "Agent mode (Plan / Agent)"},
    {"command": "pick_model", "description": "Pick model (buttons)"},
    {"command": "pause", "description": "Pause CursorWake"},
    {"command": "resume", "description": "Resume CursorWake"},
    {"command": "open_project", "description": "Open project by name"},
    {"command": "projects", "description": "List projects for /open_project"},
    {"command": "web_url", "description": "HTTPS link to web client"},
    {"command": "setup_tg_send", "description": "Enable photo/file relay in this project"},
    {"command": "thread_status", "description": "Thread status: poll, agent, queue"},
    {"command": "last_commit", "description": "Last git commit in workspace"},
    {"command": "whereami", "description": "Routing: window, composer, tab"},
    {"command": "thread_rename", "description": "Rename thread for this task"},
    {"command": "notify_mode", "description": "TG noise: full / quiet / final"},
]


class TelegramPoller:
    def __init__(
        self,
        cfg: Config,
        on_notify: Callable[[int | None, str], None],
    ) -> None:
        self.cfg = cfg
        self.on_notify = on_notify
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._launch_callback: Callable[[], None] | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def set_launch_callback(self, cb: Callable[[], None]) -> None:
        self._launch_callback = cb

    def start(self) -> None:
        if self.running or not self.cfg.bot_token:
            return
        self._stop.clear()
        self._register_commands()
        self._thread = threading.Thread(target=self._loop, name="cursor-wake-tg", daemon=True)
        self._thread.start()
        log_line(self.cfg, "[telegram] Long-poll started", code="WAKE_TG_POLL_START")

    def _register_commands(self) -> None:
        scopes: list[dict[str, Any]] = [
            {"type": "default"},
            {"type": "all_group_chats"},
        ]
        chat_id = storage.load_sync_chat_id(self.cfg)
        if chat_id is not None:
            scopes.append({"type": "chat", "chat_id": chat_id})
        for scope in scopes:
            body = self._api(
                "setMyCommands",
                {
                    "commands": json.dumps(TELEGRAM_BOT_COMMANDS, ensure_ascii=False),
                    "scope": json.dumps(scope),
                },
            )
            if body is not None:
                label = scope["type"]
                if scope["type"] == "chat":
                    label = f"chat {scope['chat_id']}"
                log_line(self.cfg, f"[telegram] Registered {len(TELEGRAM_BOT_COMMANDS)} commands ({label})", code="WAKE_TG_CMDS_REG")
        if chat_id is not None:
            self._setup_menu_button()

    def _setup_menu_button(self) -> None:
        self._api("setChatMenuButton", {
            "menu_button": json.dumps({"type": "commands"}),
        })
        log_line(self.cfg, "[telegram] Slash-command menu button set", code="WAKE_TG_MENU_BTN")

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None
        log_line(self.cfg, "[telegram] Long-poll stopped", code="WAKE_TG_POLL_STOP")

    def _api(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        base = f"https://api.telegram.org/bot{self.cfg.bot_token}/{method}"
        data = None
        url = base
        if params:
            data = urllib.parse.urlencode(params).encode("utf-8")
        try:
            req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
            with urllib.request.urlopen(req, timeout=self.cfg.telegram_poll_timeout_sec + 10) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                if not body.get("ok"):
                    log_line(self.cfg, f"[telegram] API {method} error: {body.get('description')}", code="WAKE_TG_API_ERR")
                    return None
                return body
        except urllib.error.HTTPError as err:
            if err.code == 409:
                log_line(self.cfg, "[telegram] 409 Conflict — CursorHandoff owns polling", code="WAKE_TG_POLL_CONFLICT")
            else:
                log_line(self.cfg, f"[telegram] HTTP {err.code} on {method}", code="WAKE_TG_HTTP_ERR")
            return None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
            log_line(self.cfg, f"[telegram] {method} failed: {err}", code="WAKE_TG_API_FAIL")
            return None

    def send_message(
        self,
        chat_id: int,
        text: str,
        thread_id: int | None = None,
        parse_mode: str | None = None,
        reply_markup: dict[str, Any] | None = None,
    ) -> None:
        params: dict[str, Any] = {"chat_id": chat_id, "text": text}
        if thread_id is not None:
            params["message_thread_id"] = thread_id
        if parse_mode:
            params["parse_mode"] = parse_mode
        if reply_markup is not None:
            params["reply_markup"] = json.dumps(reply_markup, ensure_ascii=False)
        self._api("sendMessage", params)

    def _loop(self) -> None:
        offset = storage.load_offset(self.cfg)
        topic_threads = storage.load_topic_thread_ids(self.cfg)
        sync_chat_id = storage.load_sync_chat_id(self.cfg)

        while not self._stop.is_set():
            params = {
                "timeout": self.cfg.telegram_poll_timeout_sec,
                "offset": offset,
                "allowed_updates": json.dumps(["message"]),
            }
            body = self._api("getUpdates", params)
            if body is None:
                if self._stop.wait(3):
                    break
                continue

            for update in body.get("result", []):
                update_id = update.get("update_id", 0)
                topic_threads = storage.load_topic_thread_ids(self.cfg)
                sync_chat_id = storage.load_sync_chat_id(self.cfg)
                self._handle_update(update, topic_threads, sync_chat_id)
                # Offset only after handling: crash between save and handle would lose the message.
                if update_id >= offset:
                    offset = update_id + 1
                    storage.save_offset(self.cfg, offset)

    def _handle_update(
        self,
        update: dict[str, Any],
        topic_threads: set[int],
        sync_chat_id: int | None,
    ) -> None:
        msg = update.get("message")
        if not msg or not isinstance(msg, dict):
            return

        user = msg.get("from") or {}
        user_id = user.get("id")
        if not isinstance(user_id, int):
            return
        # Empty allowlist (no env, no telegram-auth.json) = deny all — otherwise any group member queues prompts.
        if user_id not in self.cfg.allowed_users:
            return

        chat = msg.get("chat") or {}
        chat_id = chat.get("id")
        if not isinstance(chat_id, int):
            return

        text = msg.get("text") or msg.get("caption") or ""
        thread_id = msg.get("message_thread_id")
        message_id = msg.get("message_id")
        photos = msg.get("photo")
        document = msg.get("document")
        video = msg.get("video")
        voice = msg.get("voice")
        audio = msg.get("audio")
        animation = msg.get("animation")
        sticker = msg.get("sticker")
        attachments: list[dict[str, str]] | None = None

        if isinstance(photos, list) and photos:
            best = max(photos, key=lambda p: int(p.get("width", 0)) * int(p.get("height", 0)))
            fid = best.get("file_id")
            if isinstance(fid, str):
                attachments = [{"kind": "photo", "fileId": fid, "mime": "image/jpeg"}]
        elif isinstance(video, dict):
            fid = video.get("file_id")
            if isinstance(fid, str):
                mime = str(video.get("mime_type") or "video/mp4")
                attachments = [{"kind": "document", "fileId": fid, "mime": mime}]
        elif isinstance(voice, dict):
            fid = voice.get("file_id")
            if isinstance(fid, str):
                attachments = [{"kind": "document", "fileId": fid, "mime": str(voice.get("mime_type") or "audio/ogg")}]
        elif isinstance(audio, dict):
            fid = audio.get("file_id")
            if isinstance(fid, str):
                mime = str(audio.get("mime_type") or "audio/mpeg")
                attachments = [{"kind": "document", "fileId": fid, "mime": mime}]
        elif isinstance(animation, dict):
            fid = animation.get("file_id")
            if isinstance(fid, str):
                mime = str(animation.get("mime_type") or "video/mp4")
                attachments = [{"kind": "document", "fileId": fid, "mime": mime}]
        elif isinstance(sticker, dict):
            fid = sticker.get("file_id")
            if isinstance(fid, str):
                attachments = [{"kind": "document", "fileId": fid, "mime": "image/webp"}]
        elif isinstance(document, dict):
            fid = document.get("file_id")
            if isinstance(fid, str):
                mime = str(document.get("mime_type") or "application/octet-stream")
                attachments = [{"kind": "document", "fileId": fid, "mime": mime}]

        stripped = text.strip()

        if stripped.startswith("/"):
            cmd = stripped.split()[0].split("@")[0].lower()
            if cmd == "/pause":
                storage.write_raise_cursor(self.cfg, False, "telegram")
                self.send_message(
                    chat_id,
                    "⏸ CursorWake paused. /resume or check the tray.",
                    thread_id,
                )
                return
            if cmd == "/resume":
                storage.write_raise_cursor(self.cfg, True, "telegram")
                self.send_message(chat_id, "▶️ CursorWake resumed.", thread_id)
                return
            if cmd == "/status":
                pending = storage.count_pending(self.cfg)
                raised = storage.read_raise_cursor(self.cfg)
                self.send_message(
                    chat_id,
                    f"CursorWake: {'running' if raised else 'paused'}\nQueue: {pending} pending",
                    thread_id,
                )
                return
            return

        if thread_id is None:
            if stripped:
                self.send_message(
                    chat_id,
                    "ℹ️ # General — commands only. Agent tasks go in a project topic.",
                    thread_id,
                )
            return

        if thread_id not in topic_threads:
            return

        raise_cursor = storage.read_raise_cursor(self.cfg)
        if not isinstance(message_id, int):
            return

        if not stripped and not attachments:
            return

        added, pending = storage.append_queue_item(
            self.cfg,
            telegram_message_id=message_id,
            chat_id=chat_id,
            thread_id=int(thread_id),
            text=text,
            user_id=user_id,
            attachments=attachments,
            caption=msg.get("caption") if isinstance(msg.get("caption"), str) else None,
            media_group_id=msg.get("media_group_id") if isinstance(msg.get("media_group_id"), str) else None,
        )

        if raise_cursor:
            cursor_up = cursor_process_running()
            if added:
                if cursor_up:
                    self.send_message(
                        chat_id,
                        f"📋 Queued ({pending}) — waiting for CursorHandoff…",
                        int(thread_id),
                    )
                else:
                    self.send_message(
                        chat_id,
                        f"🚀 Starting Cursor… ({pending} queued)",
                        int(thread_id),
                    )
                    if self._launch_callback:
                        self._launch_callback()
            else:
                self.send_message(
                    chat_id,
                    f"📋 Added to queue ({pending})",
                    int(thread_id),
                )
        else:
            self.send_message(
                chat_id,
                f"⏸ CursorWake paused. Saved ({pending}). /resume to run.",
                int(thread_id),
            )
