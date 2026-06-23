"""Health checks for Cursor CDP and CursorHandoff server."""

from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from config import Config
from subprocess_util import check_output as hidden_check_output
from subprocess_util import run as hidden_run


@dataclass
class HealthResult:
    cursor_process: bool
    cdp_ok: bool
    server_connected: bool
    raw_health: dict[str, Any] | None


def cursor_process_running() -> bool:
    if os.name != "nt":
        try:
            out = subprocess.check_output(["pgrep", "-x", "Cursor"], stderr=subprocess.DEVNULL)
            return bool(out.strip())
        except (subprocess.CalledProcessError, FileNotFoundError):
            return False
    try:
        out = hidden_check_output(["tasklist", "/FI", "IMAGENAME eq Cursor.exe"])
        return "Cursor.exe" in out
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def fetch_json(url: str, timeout_sec: float) -> dict[str, Any] | None:
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return None


def check_health(cfg: Config) -> HealthResult:
    proc = cursor_process_running()
    cdp = fetch_json(f"{cfg.cdp_url.rstrip('/')}/json", cfg.health_timeout_sec)
    cdp_ok = isinstance(cdp, list) and len(cdp) > 0

    health = fetch_json(cfg.health_url, cfg.health_timeout_sec)
    connected = bool(health and health.get("connected") is True)

    return HealthResult(
        cursor_process=proc,
        cdp_ok=cdp_ok,
        server_connected=connected,
        raw_health=health if isinstance(health, dict) else None,
    )


def is_healthy(result: HealthResult) -> bool:
    return result.cdp_ok and result.server_connected


def is_server_listening(result: HealthResult) -> bool:
    """HTTP /health responds ok (may be zombie without connected)."""
    return bool(result.raw_health and result.raw_health.get("ok") is True)


def cursor_handoff_ready(result: HealthResult) -> bool:
    """CursorHandoff ready — CDP + connected; with TG enabled, live long-poll too."""
    if not is_healthy(result):
        return False
    health = result.raw_health or {}
    if health.get("telegramEnabled") is False:
        return True
    return health.get("telegramPoll") is True


def kill_process_on_port(port: int) -> None:
    if os.name != "nt":
        return
    try:
        out = hidden_check_output(["netstat", "-ano", "-p", "TCP"])
        needle = f":{port}"
        for line in out.splitlines():
            if needle not in line or "LISTENING" not in line:
                continue
            parts = line.split()
            pid = int(parts[-1])
            if pid <= 0:
                continue
            hidden_run(["taskkill", "/PID", str(pid), "/F"], check=False)
            return
    except (subprocess.CalledProcessError, ValueError, OSError):
        pass


def kill_all_cursor(cfg: Config | None = None) -> None:
    port = cfg.server_port if cfg else 3000
    kill_process_on_port(port)
    if os.name == "nt":
        hidden_run(["taskkill", "/IM", "Cursor.exe", "/F"], check=False)
    else:
        subprocess.run(["pkill", "-x", "Cursor"], check=False)
