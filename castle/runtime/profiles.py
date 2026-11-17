from __future__ import annotations

import itertools
import json
import os
import re
import threading

PROFILE_DIR_ENV = "CASTLE_PROFILES"

_lock = threading.RLock()
_cache: dict[str, dict] = {}
_cycle = itertools.count()


class ProfileError(RuntimeError):
    pass


def profile_dir() -> str:
    override = str(os.environ.get(PROFILE_DIR_ENV) or "").strip()
    if override:
        return override
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles")


def profile_paths() -> list[str]:
    directory = profile_dir()
    if not os.path.isdir(directory):
        return []
    names = [n for n in os.listdir(directory) if n.lower().endswith(".json") and not n.startswith("_")]
    return [os.path.join(directory, n) for n in sorted(names)]


def chrome_major(user_agent: str) -> str:
    match = re.search(r"Chrome/(\d+)", str(user_agent or ""))
    return match.group(1) if match else ""


def load_profile(path: str) -> dict:
    with _lock:
        cached = _cache.get(path)
        stamp = os.path.getmtime(path)
        if cached and cached.get("_mtime") == stamp:
            return cached
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    validate_profile(data, path)
    data["_mtime"] = stamp
    data["_path"] = path
    with _lock:
        _cache[path] = data
    return data


def validate_profile(data: dict, path: str = "") -> None:
    where = os.path.basename(path) if path else "profile"
    if not isinstance(data, dict):
        raise ProfileError(f"{where}: not a JSON object")
    if data.get("webdriver"):
        raise ProfileError(f"{where}: collected under automation (navigator.webdriver true)")
    collected = data.get("collected") or {}
    for bucket in ("canvas", "text"):
        if not collected.get(bucket):
            raise ProfileError(f"{where}: missing collected.{bucket}")
    if not (data.get("webgl") or {}).get("params"):
        raise ProfileError(f"{where}: missing webgl.params")
    if not data.get("userAgent"):
        raise ProfileError(f"{where}: missing userAgent")


def available_profiles() -> list[dict]:
    out = []
    for path in profile_paths():
        try:
            data = load_profile(path)
        except Exception as exc:
            out.append({"path": path, "ok": False, "error": str(exc)})
            continue
        out.append(
            {
                "path": path,
                "ok": True,
                "userAgent": data.get("userAgent"),
                "chrome": chrome_major(str(data.get("userAgent") or "")),
                "renderer": (data.get("webgl") or {}).get("unmaskedRenderer"),
                "collectedAt": (data.get("meta") or {}).get("collectedAt"),
            }
        )
    return out


def pick_profile(user_agent: str = "") -> dict:
    paths = profile_paths()
    if not paths:
        raise ProfileError(f"no profiles in {profile_dir()} (build one with: python -m castle collector)")
    loaded = []
    failures = []
    for path in paths:
        try:
            loaded.append(load_profile(path))
        except Exception as exc:
            failures.append(str(exc))
    if not loaded:
        raise ProfileError("; ".join(failures))

    wanted = str(user_agent or "").strip()
    if wanted:
        exact = [p for p in loaded if p.get("userAgent") == wanted]
        if exact:
            return exact[next(_cycle) % len(exact)]
        major = chrome_major(wanted)
        same = [p for p in loaded if chrome_major(p.get("userAgent")) == major] if major else []
        if same:
            return same[next(_cycle) % len(same)]
        raise ProfileError(f"no profile matching Chrome {major or wanted}")
    return loaded[next(_cycle) % len(loaded)]


def client_hints(profile: dict) -> dict:
    hints = {}
    brands = profile.get("brands") or []
    if brands:
        hints["sec-ch-ua"] = ", ".join(f'"{b.get("brand")}";v="{b.get("version")}"' for b in brands)
    high = profile.get("highEntropy") or {}
    full_list = high.get("fullVersionList") or []
    if full_list:
        hints["sec-ch-ua-full-version-list"] = ", ".join(f'"{b.get("brand")}";v="{b.get("version")}"' for b in full_list)
    if high.get("uaFullVersion"):
        hints["sec-ch-ua-full-version"] = f'"{high["uaFullVersion"]}"'
    if high.get("platform"):
        hints["sec-ch-ua-platform"] = f'"{high["platform"]}"'
    if high.get("platformVersion") is not None:
        hints["sec-ch-ua-platform-version"] = f'"{high["platformVersion"]}"'
    if high.get("architecture"):
        hints["sec-ch-ua-arch"] = f'"{high["architecture"]}"'
    if high.get("bitness"):
        hints["sec-ch-ua-bitness"] = f'"{high["bitness"]}"'
    if high.get("model") is not None:
        hints["sec-ch-ua-model"] = f'"{high["model"]}"'
    hints["sec-ch-ua-mobile"] = "?1" if profile.get("mobile") else "?0"
    if profile.get("deviceMemory") is not None:
        hints["sec-ch-device-memory"] = str(profile["deviceMemory"])
    return hints
