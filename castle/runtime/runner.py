from __future__ import annotations

import copy
from dataclasses import dataclass, field

from .node import run_js
from .profiles import pick_profile, validate_profile

DEFAULT_WAIT_MS = 8000


class ScriptError(RuntimeError):
    pass


@dataclass
class ScriptResult:
    payload: str
    post_url: str
    profile: dict
    ms: int = 0
    warnings: list = field(default_factory=list)


def _languages(accept_language: str) -> list[str]:
    return [part.split(";")[0].strip() for part in accept_language.split(",") if part.strip()]


def prepare_profile(page_url: str, user_agent: str = "", accept_language: str = "", profile: dict | None = None) -> dict:
    if profile is None:
        profile = pick_profile(user_agent)
    else:
        validate_profile(profile)
    profile = copy.deepcopy(profile)
    profile.pop("_mtime", None)
    profile.pop("_path", None)
    profile["pageUrl"] = page_url
    profile["scriptUrl"] = page_url
    profile["cookie"] = ""
    languages = _languages(accept_language)
    if languages:
        profile["language"] = languages[0]
        profile["languages"] = languages
    return profile


def run_script(script: str, profile: dict, wait_ms: int = DEFAULT_WAIT_MS) -> ScriptResult:
    result = run_js("runner.js", {"script": script, "profile": profile, "waitMs": wait_ms})
    if not isinstance(result, dict):
        raise ScriptError(f"runner output unreadable: {str(result)[:200]}")
    if result.get("errors"):
        first = result["errors"][0]
        raise ScriptError(f"script error in {first.get('where')}: {str(first.get('error'))[:200]}")
    if not result.get("payload"):
        raise ScriptError("script produced no payload")

    warnings = []
    if result.get("misses"):
        warnings.append(f"{len(result['misses'])} fingerprint values not in profile, synthesized")
    if result.get("stale"):
        warnings.append(f"{len(result['stale'])} stale canvas values")

    return ScriptResult(
        payload=result["payload"],
        post_url=result.get("url") or "",
        profile=profile,
        ms=int(result.get("ms") or 0),
        warnings=warnings,
    )
