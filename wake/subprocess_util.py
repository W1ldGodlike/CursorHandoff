"""Windows subprocess helpers — no flashing console windows."""

from __future__ import annotations

import subprocess
import sys
from typing import Any

CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200


def _startupinfo() -> subprocess.STARTUPINFO | None:
    if sys.platform != "win32":
        return None
    info = subprocess.STARTUPINFO()
    info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    info.wShowWindow = subprocess.SW_HIDE
    return info


def _hidden_kwargs() -> dict[str, Any]:
    if sys.platform != "win32":
        return {}
    return {
        "creationflags": CREATE_NO_WINDOW,
        "startupinfo": _startupinfo(),
    }


def check_output(args: list[str], **kwargs: Any) -> str:
    kwargs.setdefault("stderr", subprocess.DEVNULL)
    kwargs.update(_hidden_kwargs())
    raw = subprocess.check_output(args, **kwargs)
    if isinstance(raw, bytes):
        return raw.decode(kwargs.get("encoding") or "utf-8", errors="replace")
    return str(raw)


def run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[Any]:
    kwargs.setdefault("stdout", subprocess.DEVNULL)
    kwargs.setdefault("stderr", subprocess.DEVNULL)
    kwargs.update(_hidden_kwargs())
    return subprocess.run(args, **kwargs)


def popen(args: list[str], *, hide_window: bool = True, **kwargs: Any) -> subprocess.Popen[Any]:
    if hide_window and sys.platform == "win32":
        flags = kwargs.pop("creationflags", 0)
        kwargs["creationflags"] = flags | CREATE_NO_WINDOW
        kwargs.setdefault("startupinfo", _startupinfo())
    return subprocess.Popen(args, **kwargs)
