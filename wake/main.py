"""CursorWake — tray companion that launches Cursor and queues Telegram messages."""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from config import Config, load_config, log_line
from health import (
    HealthResult,
    check_health,
    cursor_process_running,
    cursor_handoff_ready,
    is_healthy,
    is_server_listening,
    kill_all_cursor,
    kill_process_on_port,
)
from storage import (
    acquire_launch_lock,
    count_pending,
    read_raise_cursor,
    release_launch_lock,
    write_handoff,
    write_raise_cursor,
)
from subprocess_util import CREATE_NEW_PROCESS_GROUP, popen as hidden_popen, shell_open_windows
from telegram_client import TelegramPoller
from single_instance import acquire_single_instance
from tray import TrayApp


class CursorWakeApp:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self._stop = threading.Event()
        self._health_fails = 0
        self._poller = TelegramPoller(cfg, self._notify)
        self._poller.set_launch_callback(self._launch_cursor)
        self._launch_started_at: float | None = None
        self._autostart_notified = False
        self._last_autostart_at = time.time()

    def _notify(self, thread_id: int | None, text: str) -> None:
        chat_id = self._sync_chat_id()
        if chat_id is None:
            return
        self._poller.send_message(chat_id, text, thread_id, parse_mode="HTML")

    def _sync_chat_id(self) -> int | None:
        from storage import load_sync_chat_id

        return load_sync_chat_id(self.cfg)

    def _launch_cursor(self, reason: str = "message") -> None:
        if not read_raise_cursor(self.cfg):
            return
        if cursor_process_running():
            log_line(self.cfg, f"[launch] Cursor already running — skip spawn ({reason})")
            return
        if not self.cfg.cursor_launch_cmd:
            log_line(self.cfg, "[launch] No cursorLaunchCmd configured")
            return
        if not acquire_launch_lock(self.cfg):
            log_line(self.cfg, "[launch] Already starting")
            return

        cmd_path = Path(self.cfg.cursor_launch_cmd)
        if not cmd_path.exists():
            log_line(self.cfg, f"[launch] Missing: {cmd_path}")
            release_launch_lock(self.cfg)
            return

        log_line(self.cfg, f"[launch] Starting Cursor ({reason}): {cmd_path}")
        self._launch_started_at = time.time()
        try:
            if os.name == "nt" and cmd_path.suffix.lower() == ".exe":
                shell_open_windows(
                    str(cmd_path),
                    str(cmd_path.parent),
                    "--remote-debugging-port=9222",
                )
            elif os.name == "nt" and cmd_path.suffix.lower() in (".cmd", ".bat"):
                shell_open_windows(str(cmd_path), str(cmd_path.parent))
            else:
                hidden_popen(
                    ["cmd.exe", "/c", str(cmd_path)],
                    cwd=str(cmd_path.parent),
                    hide_window=True,
                    creationflags=CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
        except OSError as err:
            log_line(self.cfg, f"[launch] Failed: {err}")
            release_launch_lock(self.cfg)
            self._launch_started_at = None

    def _wait_launch_result(self) -> None:
        if self._launch_started_at is None:
            return
        elapsed = time.time() - self._launch_started_at
        if elapsed < self.cfg.launch_timeout_sec:
            return

        result = check_health(self.cfg)
        chat_id = self._sync_chat_id()
        if result.cursor_process and result.cdp_ok:
            log_line(self.cfg, "[launch] Cursor is up (CursorHandoff may still be starting)")
            release_launch_lock(self.cfg)
            self._launch_started_at = None
            return

        if chat_id:
            self._poller.send_message(chat_id, "⚠️ Failed to start Cursor")
        log_line(self.cfg, "[launch] Timeout waiting for health")
        release_launch_lock(self.cfg)
        self._launch_started_at = None

    def _handoff_to_relay(self) -> None:
        if self._poller.running:
            pending = count_pending(self.cfg)
            write_handoff(self.cfg, pending)
            self._poller.stop()
        self._health_fails = 0
        release_launch_lock(self.cfg)
        self._launch_started_at = None
        self._autostart_notified = False

    def _ensure_poller(self) -> None:
        if not self._poller.running and self.cfg.bot_token:
            self._poller.start()

    def _on_health(self, result: HealthResult) -> None:
        # Fully healthy — Telegram owned by CursorHandoff (otherwise 409).
        if cursor_handoff_ready(result):
            self._handoff_to_relay()
            return

        # /health ok but connected=false — zombie port; Wake takes Telegram.
        if is_server_listening(result) and not result.server_connected:
            log_line(self.cfg, "[health] Server ok but not connected — killing port, Wake takes Telegram")
            kill_process_on_port(self.cfg.server_port)

        if not read_raise_cursor(self.cfg):
            self._ensure_poller()
            return

        proc = result.cursor_process
        cdp = result.cdp_ok
        launching = self.cfg.launch_lock_path.exists() or self._launch_started_at is not None

        if proc and (not cdp or not result.server_connected):
            if launching:
                log_line(self.cfg, "[health] Cursor starting — waiting (no GlobalDead kill)")
                self._ensure_poller()
                self._wait_launch_result()
                return

            # CDP ok but CursorHandoff not ready — do not kill a running Cursor.
            if cdp:
                self._health_fails = 0
                self._ensure_poller()
                self._wait_launch_result()
                return

            self._health_fails += 1
            if self._health_fails >= self.cfg.health_fail_threshold:
                chat_id = self._sync_chat_id()
                if chat_id:
                    self._poller.send_message(
                        chat_id,
                        "⚠️ CursorWake: Cursor unresponsive, restarting…",
                    )
                log_line(self.cfg, "[health] GlobalDead — killing Cursor")
                kill_all_cursor(self.cfg)
                self._health_fails = 0
                time.sleep(2)
                self._launch_cursor(reason="global-dead")
        elif not proc:
            self._health_fails = 0
            self._ensure_poller()
            pending = count_pending(self.cfg)
            if pending > 0 and not launching:
                self._launch_cursor(reason="queue")
            elif (
                pending == 0
                and not launching
                and (time.time() - self._last_autostart_at) >= self.cfg.autostart_interval_sec
            ):
                self._last_autostart_at = time.time()
                before = self._launch_started_at
                self._launch_cursor(reason="autostart")
                if self._launch_started_at is not None and self._launch_started_at != before:
                    if not self._autostart_notified:
                        chat_id = self._sync_chat_id()
                        if chat_id:
                            self._poller.send_message(chat_id, "🟢 CursorWake: started Cursor")
                        self._autostart_notified = True
        else:
            self._health_fails = 0
            if is_healthy(result):
                if self._poller.running:
                    self._poller.stop()
            else:
                self._ensure_poller()

        self._wait_launch_result()

    def run_loop(self) -> None:
        log_line(self.cfg, "CursorWake started")
        if not self.cfg.bot_token:
            log_line(self.cfg, "Warning: no bot token — Telegram disabled")

        if not self.cfg.state_path.exists():
            write_raise_cursor(self.cfg, True, "tray")

        last_heartbeat = time.time()

        while not self._stop.is_set():
            try:
                result = check_health(self.cfg)
                healthy = is_healthy(result)
                self._on_health(result)

                now = time.time()
                if now - last_heartbeat >= self.cfg.heartbeat_interval_sec:
                    log_line(
                        self.cfg,
                        "[health] heartbeat "
                        f"poller={'on' if self._poller.running else 'off'} "
                        f"fails={self._health_fails} "
                        f"proc={result.cursor_process} cdp={result.cdp_ok} conn={result.server_connected}",
                    )
                    last_heartbeat = now

                wait_sec = (
                    self.cfg.poll_interval_sec if healthy else self.cfg.poll_interval_fast_sec
                )
                self._stop.wait(wait_sec)
            except Exception as err:
                log_line(self.cfg, f"[health] loop error: {err!r}")
                self._stop.wait(self.cfg.poll_interval_fast_sec)

        self._poller.stop()
        log_line(self.cfg, "CursorWake stopped")

    def stop(self) -> None:
        self._stop.set()


def main() -> None:
    cfg = load_config()
    log_line(cfg, f"DATA_DIR={cfg.data_dir}")
    if not acquire_single_instance(cfg.instance_lock_path):
        log_line(cfg, "Another CursorWake instance already running — exit")
        return

    app = CursorWakeApp(cfg)
    loop_holder: list[threading.Thread] = []

    def start_loop() -> None:
        t = threading.Thread(target=app.run_loop, name="cursor-wake-loop", daemon=True)
        loop_holder.clear()
        loop_holder.append(t)
        t.start()

    def on_exit() -> None:
        app.stop()

    def loop_watchdog() -> None:
        while not app._stop.is_set():
            app._stop.wait(5)
            if app._stop.is_set():
                break
            t = loop_holder[0] if loop_holder else None
            if t and not t.is_alive():
                log_line(cfg, "[health] loop thread died — restarting")
                start_loop()

    tray = TrayApp(cfg, lambda _v: None, on_exit)
    tray.start_state_watcher()

    # Health/Telegram in background; pystray on Windows needs the message loop on the main thread.
    start_loop()
    threading.Thread(target=loop_watchdog, name="cursor-wake-watchdog", daemon=True).start()

    try:
        tray.run()
    except KeyboardInterrupt:
        app.stop()
    finally:
        app.stop()
        tray.stop()


if __name__ == "__main__":
    main()
