from __future__ import annotations

import json
import os
import shutil
import subprocess

JS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "js")


class NodeError(RuntimeError):
    pass


def node_executable() -> str:
    override = os.environ.get("CASTLE_NODE", "").strip()
    if override:
        if not os.path.isfile(override):
            raise NodeError(f"CASTLE_NODE points to a missing file: {override}")
        return override
    found = shutil.which("node")
    if not found:
        raise NodeError("Node.js not found on PATH (install it or set CASTLE_NODE)")
    return found


def run_js(script: str, payload: dict | None = None) -> dict | str:
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.run(
            [node_executable(), os.path.join(JS_DIR, script)],
            input=json.dumps(payload) if payload is not None else "",
            capture_output=True,
            text=True,
            encoding="utf-8",
            **kwargs,
        )
    except OSError as exc:
        raise NodeError(f"failed to start node: {exc}") from exc
    if proc.returncode != 0:
        raise NodeError(f"{script} exited {proc.returncode}: {proc.stderr.strip()[:300]}")
    try:
        return json.loads(proc.stdout)
    except ValueError:
        return proc.stdout
