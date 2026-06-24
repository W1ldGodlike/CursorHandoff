"""File queue, state, offset, and launch lock for CursorWake."""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import Config, log_line

_lock = threading.Lock()


def _read_json(path: Path, default: Any) -> Any:
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        pass
    return default


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def read_raise_cursor(cfg: Config) -> bool:
    with _lock:
        raw = _read_json(cfg.state_path, {})
        if isinstance(raw, dict) and isinstance(raw.get("raiseCursor"), bool):
            return raw["raiseCursor"]
    return True


def write_raise_cursor(cfg: Config, raise_cursor: bool, updated_by: str = "tray") -> None:
    with _lock:
        _write_json(
            cfg.state_path,
            {
                "raiseCursor": raise_cursor,
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "updatedBy": updated_by,
            },
        )


def load_offset(cfg: Config) -> int:
    with _lock:
        raw = _read_json(cfg.offset_path, {"offset": 0})
        return int(raw.get("offset", 0))


def save_offset(cfg: Config, offset: int) -> None:
    with _lock:
        _write_json(cfg.offset_path, {"offset": offset})


def load_sync_chat_id(cfg: Config) -> int | None:
    raw = _read_json(cfg.sync_path, {})
    chat_id = raw.get("chatId")
    return int(chat_id) if chat_id is not None else None


def load_topic_thread_ids(cfg: Config) -> set[int]:
    raw = _read_json(cfg.topics_path, {"mappings": []})
    threads: set[int] = set()
    for item in raw.get("mappings", []):
        if isinstance(item, dict) and isinstance(item.get("threadId"), int):
            threads.add(item["threadId"])
    return threads


def resolve_thread_mapping(cfg: Config, thread_id: int) -> dict[str, Any] | None:
    raw = _read_json(cfg.topics_path, {"mappings": []})
    for item in raw.get("mappings", []):
        if isinstance(item, dict) and item.get("threadId") == thread_id:
            return item
    return None


def count_pending(cfg: Config) -> int:
    with _lock:
        raw = _read_json(cfg.queue_path, {"version": 2, "items": []})
        return sum(1 for i in raw.get("items", []) if i.get("status") == "pending")


def append_queue_item(
    cfg: Config,
    *,
    telegram_message_id: int,
    chat_id: int,
    thread_id: int,
    text: str,
    user_id: int,
    attachments: list[dict[str, str]] | None = None,
    caption: str | None = None,
    media_group_id: str | None = None,
) -> tuple[bool, int]:
    """Returns (added, pending_count)."""
    with _lock:
        raw = _read_json(cfg.queue_path, {"version": 2, "items": []})
        raw["version"] = 2
        items = raw.setdefault("items", [])
        for item in items:
            if (
                item.get("telegramMessageId") == telegram_message_id
                and item.get("chatId") == chat_id
            ):
                pending = sum(1 for i in items if i.get("status") == "pending")
                return False, pending

        item: dict[str, Any] = {
            "id": str(uuid.uuid4()),
            "telegramMessageId": telegram_message_id,
            "chatId": chat_id,
            "threadId": thread_id,
            "text": text,
            "userId": user_id,
            "enqueuedAt": int(datetime.now(timezone.utc).timestamp() * 1000),
            "enqueuedBy": "cursor-wake",
            "status": "pending",
            "attempts": 0,
            "lastError": None,
        }
        if attachments:
            item["attachments"] = attachments
        if caption:
            item["caption"] = caption
        if media_group_id:
            item["mediaGroupId"] = media_group_id
        items.append(item)
        _write_json(cfg.queue_path, raw)
        pending = sum(1 for i in items if i.get("status") == "pending")
        return True, pending


def acquire_launch_lock(cfg: Config) -> bool:
    with _lock:
        lock_path = cfg.launch_lock_path
        if lock_path.exists():
            try:
                raw = _read_json(lock_path, {})
                started = raw.get("startedAt")
                if isinstance(started, str):
                    started_dt = datetime.fromisoformat(started)
                    age_sec = (datetime.now(timezone.utc) - started_dt).total_seconds()
                    if age_sec < cfg.launch_timeout_sec:
                        return False
            except (ValueError, OSError, TypeError):
                pass
            try:
                lock_path.unlink(missing_ok=True)
            except OSError:
                return False

        try:
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps({"startedAt": datetime.now(timezone.utc).isoformat()})
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, payload.encode("utf-8"))
            os.close(fd)
            return True
        except FileExistsError:
            return False
        except OSError:
            return False


def release_launch_lock(cfg: Config) -> None:
    with _lock:
        try:
            cfg.launch_lock_path.unlink(missing_ok=True)
        except OSError:
            pass


def write_handoff(cfg: Config, pending_count: int) -> None:
    _write_json(
        cfg.data_dir / "cursor-wake-handoff.json",
        {
            "readyAt": datetime.now(timezone.utc).isoformat(),
            "pendingCount": pending_count,
        },
    )
