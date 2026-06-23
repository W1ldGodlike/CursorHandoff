"""System tray UI for CursorWake."""

from __future__ import annotations

import threading
from typing import Callable

from PIL import Image, ImageDraw
import pystray

from config import Config, log_line, open_log
import storage


def _make_icon() -> Image.Image:
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse((4, 4, size - 4, size - 4), fill=(46, 125, 50, 255))
    draw.text((18, 18), "W", fill=(255, 255, 255, 255))
    return img


class TrayApp:
    def __init__(
        self,
        cfg: Config,
        on_raise_changed: Callable[[bool], None],
        on_exit: Callable[[], None],
    ) -> None:
        self.cfg = cfg
        self.on_raise_changed = on_raise_changed
        self.on_exit = on_exit
        self._icon: pystray.Icon | None = None
        self._raise_item: pystray.MenuItem | None = None
        self._stop_watcher = threading.Event()

    def _status_text(self, *_args) -> str:
        raised = storage.read_raise_cursor(self.cfg)
        status = "running" if raised else "paused"
        return f"CursorWake: {status}"

    def _build_menu(self) -> pystray.Menu:
        def toggle_raise(icon: pystray.Icon, item: pystray.MenuItem) -> None:
            new_val = not storage.read_raise_cursor(self.cfg)
            storage.write_raise_cursor(self.cfg, new_val, "tray")
            self.on_raise_changed(new_val)
            icon.update_menu()

        def open_log_item(icon: pystray.Icon, item: pystray.MenuItem) -> None:
            open_log(self.cfg)

        def exit_item(icon: pystray.Icon, item: pystray.MenuItem) -> None:
            icon.stop()
            self.on_exit()

        self._raise_item = pystray.MenuItem(
            "Raise Cursor",
            toggle_raise,
            checked=lambda _: storage.read_raise_cursor(self.cfg),
        )

        return pystray.Menu(
            pystray.MenuItem(self._status_text, lambda *_: None, enabled=False),
            self._raise_item,
            pystray.MenuItem("Open log", open_log_item),
            pystray.MenuItem("Exit", exit_item),
        )

    def run(self) -> None:
        try:
            self._icon = pystray.Icon(
                "CursorWake",
                _make_icon(),
                "CursorWake",
                self._build_menu(),
            )
            log_line(self.cfg, "[tray] Starting (main thread)")
            self._icon.run()
            log_line(self.cfg, "[tray] Stopped")
        except Exception as err:
            log_line(self.cfg, f"[tray] Error: {err}")
            raise

    def refresh_menu(self) -> None:
        if self._icon:
            try:
                self._icon.update_menu()
            except Exception:
                pass

    def start_state_watcher(self, interval_sec: float = 1.0) -> threading.Thread:
        """Refresh tray checkbox when /pause or /resume runs from Telegram."""
        def loop() -> None:
            last_mtime = 0.0
            while not self._stop_watcher.is_set():
                try:
                    path = self.cfg.state_path
                    if path.exists():
                        mtime = path.stat().st_mtime
                        if mtime != last_mtime:
                            last_mtime = mtime
                            self.refresh_menu()
                except OSError:
                    pass
                self._stop_watcher.wait(interval_sec)

        t = threading.Thread(target=loop, name="cursor-wake-state-watch", daemon=True)
        t.start()
        return t

    def stop(self) -> None:
        self._stop_watcher.set()
        if self._icon:
            self._icon.stop()

    def run_in_thread(self) -> threading.Thread:
        """Deprecated: on Windows the tray does not display outside the main thread."""
        t = threading.Thread(target=self.run, name="cursor-wake-tray", daemon=False)
        t.start()
        return t
