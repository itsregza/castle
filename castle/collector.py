from __future__ import annotations

import json
import os

from .runtime.node import JS_DIR, NodeError, run_js
from .token import CastleError, sdk_script

PLACEHOLDER_PK = "pk_" + "0" * 32
PLACEHOLDER_URL = "https://example.com/"


def build_collector() -> str:
    with open(os.path.join(JS_DIR, "baseline.json"), encoding="utf-8") as f:
        baseline = json.load(f)
    baseline["pageUrl"] = baseline["scriptUrl"] = PLACEHOLDER_URL
    try:
        recipe = run_js("recipe.js", {"script": sdk_script(PLACEHOLDER_PK), "profile": baseline})
        if not isinstance(recipe, dict):
            raise CastleError("recipe output unreadable")
        if recipe.get("errors"):
            raise CastleError(f"recipe: {str(recipe['errors'][0].get('error'))[:200]}")
        if not recipe.get("captures"):
            raise CastleError("recipe: SDK produced no token")
        source = run_js("gen_collector.js", recipe)
    except NodeError as e:
        raise CastleError(str(e)) from e
    if not isinstance(source, str):
        raise CastleError("collector build produced no script")
    return source
