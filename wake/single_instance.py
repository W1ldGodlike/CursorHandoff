"""Ensures only one CursorWake process runs at a time."""

from __future__ import annotations

import atexit
import os
import sys
from pathlib import Path

_LOCK_PATH: Path | None = None


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform != "win32":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    import ctypes

    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
    if handle:
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    return False


def _release_lock() -> None:
    global _LOCK_PATH
    if _LOCK_PATH is None:
        return
    try:
        if _LOCK_PATH.exists():
            raw = _LOCK_PATH.read_text(encoding="utf-8").strip()
            if raw.split()[0] == str(os.getpid()):
                _LOCK_PATH.unlink(missing_ok=True)
    except OSError:
        pass
    _LOCK_PATH = None


def acquire_single_instance(lock_path: Path) -> bool:
    """True if this process owns the instance lock file."""
    global _LOCK_PATH
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    if lock_path.exists():
        try:
            pid = int(lock_path.read_text(encoding="utf-8").strip().split()[0])
            if _pid_alive(pid):
                return False
        except (ValueError, OSError):
            pass
        try:
            lock_path.unlink(missing_ok=True)
        except OSError:
            return False

    try:
        fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, f"{os.getpid()}\n".encode("utf-8"))
        os.close(fd)
    except FileExistsError:
        return False
    except OSError:
        return False

    _LOCK_PATH = lock_path
    atexit.register(_release_lock)
    return True
