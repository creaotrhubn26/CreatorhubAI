#!/usr/bin/env python3
"""Fail closed until llama.cpp health, context, and engineering tools agree."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib import error, request

REQUIRED_TOOLS = {
    "read_file",
    "file_glob_search",
    "grep_search",
    "exec_shell_command",
    "write_file",
    "edit_file",
}


def get_json(path: str, api_key: str):
    headers = {"Accept": "application/json", "Authorization": f"Bearer {api_key}"}
    with request.urlopen(request.Request(f"http://127.0.0.1:8080{path}", headers=headers), timeout=3) as response:
        if response.status != 200:
            raise RuntimeError(f"{path} returned HTTP {response.status}")
        return json.load(response)


def tool_names(value) -> set[str]:
    items = value if isinstance(value, list) else value.get("tools", []) if isinstance(value, dict) else []
    names = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        definition = item.get("definition") if isinstance(item.get("definition"), dict) else item
        function = definition.get("function") if isinstance(definition, dict) else None
        name = function.get("name") if isinstance(function, dict) else item.get("name")
        if isinstance(name, str):
            names.add(name)
    return names


def main() -> int:
    key_file = Path(os.environ["GLIMMER_API_KEY_FILE"])
    api_key = key_file.read_text(encoding="utf-8").strip()
    expected_context = int(os.environ["GLIMMER_CONTEXT_TOKENS"])
    get_json("/health", api_key)
    props = get_json("/props", api_key)
    actual_context = (props.get("default_generation_settings") or {}).get("n_ctx")
    if actual_context != expected_context:
        raise RuntimeError(f"llama.cpp context mismatch: expected {expected_context}, got {actual_context}")
    missing = REQUIRED_TOOLS - tool_names(get_json("/tools", api_key))
    if missing:
        raise RuntimeError("llama.cpp engineering tools are incomplete")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, error.URLError, json.JSONDecodeError) as exc:
        print(f"worker readiness failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
