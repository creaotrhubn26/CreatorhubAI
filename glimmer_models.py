#!/usr/bin/env python3
"""Shared, secret-free model registry for Glimmer runtimes.

The control center owns ``models.json`` and separate key files. Runtime
processes read only routing metadata here; API-key contents are read at the
last possible moment by the transport and never returned by this module,
written to manifests, or copied into events.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from urllib import parse

MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
ROLES = ("engineer", "architect", "consult", "vision")
DEFAULT_PROVIDER_ID = "local"
DEFAULT_MODEL_ID = "muse-glimmer"
DEFAULT_API_KEY_FILE = Path.home() / "AI/muse-glimmer/config/api-key.txt"


def model_config_path() -> Path:
    explicit = os.environ.get("GLIMMER_MODEL_CONFIG")
    if explicit:
        return Path(explicit).expanduser()
    state_root = Path(os.environ.get("GLIMMER_STATE_ROOT") or (Path.home() / ".muse-glimmer"))
    return state_root / "models.json"


def _valid_base_url(value) -> bool:
    if not isinstance(value, str) or len(value) > 2048:
        return False
    parts = parse.urlsplit(value.strip())
    return (
        parts.scheme in ("http", "https") and bool(parts.netloc) and
        not parts.username and not parts.password and not parts.query and not parts.fragment
    )


def _default_registry(default_base_url: str) -> dict:
    model = {
        "id": DEFAULT_PROVIDER_ID,
        "label": "Local Glimmer",
        "baseUrl": default_base_url.rstrip("/"),
        "modelId": DEFAULT_MODEL_ID,
        "apiKeyFile": str(DEFAULT_API_KEY_FILE),
    }
    return {
        "version": 1,
        "models": {DEFAULT_PROVIDER_ID: model},
        "roles": {role: DEFAULT_PROVIDER_ID for role in ROLES},
        "routing": {
            "enabled": False,
            "highRisk": {},
            "criticProviderId": None,
            "requireIndependentCritic": False,
        },
        "source": "default",
    }


def load_model_registry(path: Path | None = None, default_base_url: str | None = None) -> dict:
    """Load and normalize the v1 registry, falling back as one unit.

    A partially malformed registry is not blended with defaults entry by
    entry: routing ambiguity is worse than using the known local provider.
    Key paths are retained as paths only; this function never reads them.
    """
    base_url = (default_base_url or os.environ.get("GLIMMER_URL") or "http://127.0.0.1:8080").rstrip("/")
    fallback = _default_registry(base_url)
    registry_path = Path(path) if path is not None else model_config_path()
    try:
        raw = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return fallback
    if not isinstance(raw, dict) or raw.get("version") != 1 or not isinstance(raw.get("models"), list):
        return fallback

    models = {}
    for entry in raw["models"]:
        if not isinstance(entry, dict):
            return fallback
        provider_id = entry.get("id")
        label = entry.get("label")
        entry_base_url = entry.get("baseUrl")
        model_id = entry.get("modelId")
        key_file = entry.get("apiKeyFile")
        if (
            not isinstance(provider_id, str) or not MODEL_ID_RE.fullmatch(provider_id) or provider_id in models or
            not isinstance(label, str) or not label.strip() or len(label.strip()) > 120 or
            not _valid_base_url(entry_base_url) or
            not isinstance(model_id, str) or not model_id.strip() or len(model_id.strip()) > 200 or
            (key_file is not None and (not isinstance(key_file, str) or not key_file.strip()))
        ):
            return fallback
        assert isinstance(entry_base_url, str)
        models[provider_id] = {
            "id": provider_id,
            "label": label.strip(),
            "baseUrl": entry_base_url.strip().rstrip("/"),
            "modelId": model_id.strip(),
            "apiKeyFile": str(Path(key_file).expanduser()) if key_file else None,
        }
    if not models:
        return fallback

    raw_roles = raw.get("roles")
    if not isinstance(raw_roles, dict):
        return fallback
    roles = {}
    for role in ROLES:
        provider_id = raw_roles.get(role)
        if not isinstance(provider_id, str) or provider_id not in models:
            return fallback
        roles[role] = provider_id
    raw_routing = raw.get("routing")
    routing = {
        "enabled": False,
        "highRisk": {},
        "criticProviderId": None,
        "requireIndependentCritic": False,
    }
    if raw_routing is not None:
        if not isinstance(raw_routing, dict):
            return fallback
        if "enabled" in raw_routing and not isinstance(raw_routing.get("enabled"), bool):
            return fallback
        if "requireIndependentCritic" in raw_routing and not isinstance(
            raw_routing.get("requireIndependentCritic"), bool
        ):
            return fallback
        high_risk = raw_routing.get("highRisk", {})
        if not isinstance(high_risk, dict):
            return fallback
        normalized_high_risk = {}
        for role, provider_id in high_risk.items():
            if role not in ROLES or not isinstance(provider_id, str) or provider_id not in models:
                return fallback
            normalized_high_risk[role] = provider_id
        critic_provider_id = raw_routing.get("criticProviderId")
        if critic_provider_id is not None and (
            not isinstance(critic_provider_id, str) or critic_provider_id not in models
        ):
            return fallback
        routing = {
            "enabled": raw_routing.get("enabled", False),
            "highRisk": normalized_high_risk,
            "criticProviderId": critic_provider_id,
            "requireIndependentCritic": raw_routing.get("requireIndependentCritic", False),
        }
    return {
        "version": 1,
        "models": models,
        "roles": roles,
        "routing": routing,
        "source": str(registry_path),
    }


def model_for_role(registry: dict, role: str, risk: str | None = None) -> dict:
    roles = registry["roles"]
    models = registry["models"]
    provider_id = roles.get(role) or roles["engineer"]
    routing = registry.get("routing") or {}
    if (
        routing.get("enabled", False)
        and str(risk or "").upper() in {"HIGH", "CRITICAL"}
        and isinstance(routing.get("highRisk"), dict)
    ):
        provider_id = routing["highRisk"].get(role) or provider_id
    return models[provider_id]


def critic_model(registry: dict) -> dict:
    routing = registry.get("routing") or {}
    provider_id = routing.get("criticProviderId") if routing.get("enabled", False) else None
    if not provider_id:
        provider_id = registry["roles"].get("consult") or registry["roles"]["engineer"]
    return registry["models"][provider_id]


def model_independence(primary: dict, critic: dict) -> str:
    if not primary or not critic:
        return "unavailable"
    if primary.get("id") != critic.get("id") and primary.get("modelId") != critic.get("modelId"):
        return "independent"
    return "same-model"


def routing_decision(registry: dict, role: str, risk: str | None = None) -> dict:
    selected = model_for_role(registry, role, risk)
    critic = critic_model(registry)
    base = registry["roles"].get(role) or registry["roles"]["engineer"]
    adaptive = selected.get("id") != base
    critic_host = (parse.urlsplit(str(critic.get("baseUrl") or "")).hostname or "").lower()
    critic_independence = (
        model_independence(selected, critic)
        if critic_host in {"localhost", "127.0.0.1", "::1"}
        else "unavailable"
    )
    return {
        "role": role,
        "risk": str(risk or "UNKNOWN").upper(),
        "providerId": selected.get("id"),
        "modelId": selected.get("modelId"),
        "reason": "high-risk-override" if adaptive else "configured-role",
        "criticIndependence": critic_independence,
    }


def _selfcheck() -> None:
    import tempfile

    fallback = load_model_registry(Path("/definitely/missing"), "http://local:8080")
    assert model_for_role(fallback, "architect")["baseUrl"] == "http://local:8080"

    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "models.json"
        key_path = Path(td) / "frontier.key"
        key_path.write_text("super-secret-token", encoding="utf-8")
        path.write_text(json.dumps({
            "version": 1,
            "models": [
                {"id": "private", "label": "Private", "baseUrl": "http://127.0.0.1:8080",
                 "modelId": "local-30b", "apiKeyFile": None},
                {"id": "frontier", "label": "Frontier", "baseUrl": "https://models.example/v1",
                 "modelId": "frontier-1", "apiKeyFile": str(key_path)},
            ],
            "roles": {"engineer": "private", "architect": "frontier", "consult": "frontier", "vision": "frontier"},
        }), encoding="utf-8")
        registry = load_model_registry(path)
        assert model_for_role(registry, "engineer")["modelId"] == "local-30b"
        assert model_for_role(registry, "architect")["baseUrl"] == "https://models.example/v1"
        assert "super-secret-token" not in json.dumps(registry), "registry must carry paths, never key contents"

        adaptive = json.loads(path.read_text(encoding="utf-8"))
        adaptive["routing"] = {
            "enabled": True,
            "highRisk": {"engineer": "frontier"},
            "criticProviderId": "private",
            "requireIndependentCritic": True,
        }
        path.write_text(json.dumps(adaptive), encoding="utf-8")
        routed = load_model_registry(path)
        assert model_for_role(routed, "engineer", "HIGH")["id"] == "frontier"
        assert model_for_role(routed, "engineer", "LOW")["id"] == "private"
        assert critic_model(routed)["id"] == "private"
        assert model_independence(model_for_role(routed, "engineer", "HIGH"), critic_model(routed)) == "independent"

        invalid = json.loads(path.read_text(encoding="utf-8"))
        invalid["models"][1]["baseUrl"] = "https://models.example/v1?key=must-not-live-in-url"
        path.write_text(json.dumps(invalid), encoding="utf-8")
        assert load_model_registry(path)["source"] == "default", "query-bearing provider URLs fail closed"

        path.write_text('{"version":1,"models":[],"roles":{}}', encoding="utf-8")
        assert load_model_registry(path)["source"] == "default"

    print("model registry self-check: PASS")


if __name__ == "__main__":
    _selfcheck()
