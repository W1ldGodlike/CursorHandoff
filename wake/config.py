"""CursorWake configuration — paths, settings, logging."""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _repo_data_dir() -> Path | None:
    script_dir = Path(__file__).resolve().parent
    repo_root = script_dir.parent.parent
    pkg = repo_root / "package.json"
    if not pkg.is_file():
        return None
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
        if data.get("name") == "cursor-handoff":
            return repo_root / "data"
    except (OSError, json.JSONDecodeError, KeyError):
        return None
    return None


def _install_dir() -> Path:
    """Directory beside CursorWake.exe (frozen) or wake sources (dev)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _default_data_dir() -> Path:
    env_dir = os.environ.get("DATA_DIR", "").strip()
    if env_dir:
        return Path(env_dir)
    repo_data = _repo_data_dir()
    if repo_data is not None:
        return repo_data
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "Cursor" / "User" / "globalStorage" / "cursor-handoff.cursor-handoff"
    return Path.home() / ".cursor-handoff"


def _default_cursor_exe() -> str:
    local = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "cursor" / "Cursor.exe"
    if local.exists():
        return str(local)
    return ""


def _bundled_launch_cmd() -> Path:
    return _install_dir() / "CursorHandoff-Debug.cmd"


def _default_launch_cmd() -> str:
    exe = _default_cursor_exe()
    if exe:
        return exe
    bundled = _bundled_launch_cmd()
    if bundled.is_file():
        return str(bundled)
    desktop = Path.home() / "Desktop"
    for name in ("Cursor Remote Debug.cmd", "CursorHandoff Debug.cmd"):
        cmd = desktop / name
        if cmd.is_file():
            return str(cmd)
    return ""


def _load_json(path: Path) -> dict[str, Any]:
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        pass
    return {}


@dataclass
class Config:
    data_dir: Path
    cursor_launch_cmd: str
    poll_interval_sec: int
    poll_interval_fast_sec: int
    heartbeat_interval_sec: int
    autostart_interval_sec: int
    health_fail_threshold: int
    health_timeout_sec: int
    launch_timeout_sec: int
    telegram_poll_timeout_sec: int
    bot_token: str
    allowed_users: set[int]
    server_host: str
    server_port: int
    cdp_url: str
    log_path: Path

    @property
    def health_url(self) -> str:
        host = "127.0.0.1" if self.server_host in ("0.0.0.0", "") else self.server_host
        return f"http://{host}:{self.server_port}/health"

    @property
    def state_path(self) -> Path:
        return self.data_dir / "cursor-wake-state.json"

    @property
    def queue_path(self) -> Path:
        return self.data_dir / "pending-telegram-queue.json"

    @property
    def offset_path(self) -> Path:
        return self.data_dir / "cursor-wake-telegram-offset.json"

    @property
    def launch_lock_path(self) -> Path:
        return self.data_dir / "cursor-wake-launch.lock"

    @property
    def instance_lock_path(self) -> Path:
        return self.data_dir / "cursor-wake-instance.lock"

    @property
    def topics_path(self) -> Path:
        return self.data_dir / "telegram-topics.json"

    @property
    def sync_path(self) -> Path:
        return self.data_dir / "telegram-sync.json"

    @property
    def auth_path(self) -> Path:
        return self.data_dir / "telegram-auth.json"


def _setting(settings: dict[str, Any], flat_key: str, nested: list[str], default: Any = None) -> Any:
    """Read Cursor/VS Code settings — flat keys like cursorHandoff.telegram.botToken."""
    if flat_key in settings:
        return settings[flat_key]
    cur: Any = settings
    for part in nested:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(part)
    return cur if cur is not None else default


def _resolve_data_dir(cursor_settings: dict[str, Any], repo_config: dict[str, Any]) -> Path:
    """Same directory as CursorHandoff extension (cursorHandoff.dataDir / DATA_DIR)."""
    from_settings = str(
        _setting(cursor_settings, "cursorHandoff.dataDir", ["cursorHandoff", "dataDir"]) or ""
    ).strip()
    if from_settings:
        return Path(from_settings)
    from_repo_cfg = str(repo_config.get("dataDir") or "").strip()
    if from_repo_cfg:
        return Path(from_repo_cfg)
    return _default_data_dir()


def load_config() -> Config:
    install_dir = _install_dir()
    repo_config = _load_json(install_dir / "cursor-wake.config.json")

    cursor_settings = _load_cursor_settings()
    data_dir = _resolve_data_dir(cursor_settings, repo_config)
    data_dir.mkdir(parents=True, exist_ok=True)

    bot_token = str(
        _setting(cursor_settings, "cursorHandoff.telegram.botToken", ["cursorHandoff", "telegram", "botToken"])
        or os.environ.get("TELEGRAM_BOT_TOKEN")
        or ""
    )
    allowed_raw = str(
        _setting(cursor_settings, "cursorHandoff.telegram.allowedUsers", ["cursorHandoff", "telegram", "allowedUsers"])
        or os.environ.get("TELEGRAM_ALLOWED_USERS")
        or ""
    )
    allowed_users: set[int] = set()
    for part in allowed_raw.split(","):
        part = part.strip()
        if part.isdigit():
            allowed_users.add(int(part))

    auth = _load_json(data_dir / "telegram-auth.json")
    for user in auth.get("registeredUsers", []):
        if isinstance(user, dict) and isinstance(user.get("id"), int):
            allowed_users.add(user["id"])
        elif isinstance(user, int):
            allowed_users.add(user)

    return Config(
        data_dir=data_dir,
        cursor_launch_cmd=str(repo_config.get("cursorLaunchCmd") or _default_launch_cmd()),
        poll_interval_sec=int(repo_config.get("pollIntervalSec", 30)),
        poll_interval_fast_sec=int(repo_config.get("pollIntervalFastSec", 10)),
        heartbeat_interval_sec=int(repo_config.get("heartbeatIntervalSec", 300)),
        autostart_interval_sec=int(
            repo_config.get("autostartIntervalSec")
            or repo_config.get("autostartGraceSec")
            or 300
        ),
        health_fail_threshold=int(repo_config.get("healthFailThreshold", 3)),
        health_timeout_sec=int(repo_config.get("healthTimeoutSec", 5)),
        launch_timeout_sec=int(repo_config.get("launchTimeoutSec", 120)),
        telegram_poll_timeout_sec=int(repo_config.get("telegramPollTimeoutSec", 50)),
        bot_token=bot_token,
        allowed_users=allowed_users,
        server_host=str(
            _setting(cursor_settings, "cursorHandoff.serverHost", ["cursorHandoff", "serverHost"]) or "127.0.0.1"
        ),
        server_port=int(
            _setting(cursor_settings, "cursorHandoff.serverPort", ["cursorHandoff", "serverPort"]) or 3000
        ),
        cdp_url=str(
            _setting(cursor_settings, "cursorHandoff.cdpUrl", ["cursorHandoff", "cdpUrl"]) or "http://127.0.0.1:9222"
        ),
        log_path=data_dir / "cursor-wake.log",
    )


def _load_cursor_settings() -> dict[str, Any]:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return {}
    settings_path = Path(appdata) / "Cursor" / "User" / "settings.json"
    return _load_json(settings_path)


def log_line(cfg: Config, message: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    line = f"{ts} {message}"
    print(line, flush=True)
    try:
        with cfg.log_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def open_log(cfg: Config) -> None:
    if sys.platform == "win32":
        os.startfile(str(cfg.log_path))  # type: ignore[attr-defined]
    else:
        print(f"Log: {cfg.log_path}")
