from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field

from .runtime.node import NodeError
from .runtime.profiles import ProfileError, client_hints
from .runtime.runner import ScriptError, prepare_profile, run_script

SDK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "castle.js")
SINK = "https://castle.invalid/token"

_sdk = ""


class CastleError(Exception):
    pass


@dataclass
class CastleToken:
    token: str
    user_agent: str
    ms: int = 0
    client_hints: dict = field(default_factory=dict)
    warnings: list = field(default_factory=list)

    @property
    def headers(self) -> dict:
        return {"user-agent": self.user_agent, **self.client_hints}

    def to_dict(self) -> dict:
        return {"token": self.token, "user_agent": self.user_agent, "ms": self.ms}

    def to_json(self) -> str:
        return json.dumps(self.to_dict())

    def __str__(self) -> str:
        return self.token


def sdk_source() -> str:
    global _sdk
    if not _sdk:
        with open(SDK_PATH, encoding="utf-8") as f:
            _sdk = f.read()
    return _sdk


def sdk_script(pk: str) -> str:
    return (
        sdk_source()
        + "\nvar castleExports=requireCastle();"
        + f"castleExports.configure({{pk:{json.dumps(pk)}}});"
        + "castleExports.createRequestToken().then(function(t){"
        + f"var x=new XMLHttpRequest();x.open('POST',{json.dumps(SINK)});x.send(String(t));"
        + "});\n"
    )


def generate_token(
    pk: str,
    page_url: str,
    user_agent: str = "",
    accept_language: str = "",
    profile: dict | None = None,
) -> CastleToken:
    if not pk:
        raise CastleError("pk is required")
    if not page_url:
        raise CastleError("page_url is required")
    started = time.perf_counter()
    try:
        prepared = prepare_profile(page_url, user_agent, accept_language, profile)
        result = run_script(sdk_script(pk), prepared)
    except (ProfileError, ScriptError, NodeError) as e:
        raise CastleError(str(e)) from e
    if result.post_url != SINK:
        raise CastleError("SDK did not produce a token")
    return CastleToken(
        token=result.payload,
        user_agent=prepared.get("userAgent", ""),
        ms=int((time.perf_counter() - started) * 1000),
        client_hints=client_hints(prepared),
        warnings=result.warnings,
    )


def request_token(pk: str, page_url: str, user_agent: str = "", accept_language: str = "", profile: dict | None = None) -> str:
    return generate_token(pk, page_url, user_agent, accept_language, profile).token
