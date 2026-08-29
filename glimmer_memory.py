#!/usr/bin/env python3
"""Bounded deterministic repository memory for Glimmer.

Only verified outcomes are accepted.  Free-form model prose, prompts, source
code and secrets are outside this module's schema and are discarded.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 2
MEMORY_CAP = 500
HALF_LIFE_DAYS = 90.0
MIN_OBSERVATIONS = 2
KINDS = {
    "cochange",
    "verification-success",
    "repair-success",
    "rejected-claim",
    "blocked-command",
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def git_common_dir(workspace: Path) -> Path:
    workspace = Path(workspace).expanduser().resolve()
    result = subprocess.run(
        ["git", "-C", str(workspace), "rev-parse", "--git-common-dir"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    raw = result.stdout.strip()
    if not raw:
        return workspace
    common = Path(raw)
    if not common.is_absolute():
        common = workspace / common
    return common.resolve()


def repo_identity(workspace: Path) -> str:
    common = git_common_dir(workspace)
    digest = hashlib.sha256(str(common).encode("utf-8")).hexdigest()[:16]
    name = common.parent.name if common.name == ".git" else common.name
    return f"{name}-{digest}"


def memory_path(workspace: Path, state_root: Path | None = None) -> Path:
    root = state_root or Path(os.environ.get("GLIMMER_STATE_ROOT") or (Path.home() / ".muse-glimmer"))
    return root / "memory" / repo_identity(workspace) / "memory-v2.json"


def _legacy_path(workspace: Path, state_root: Path | None = None) -> Path:
    root = state_root or Path(os.environ.get("GLIMMER_STATE_ROOT") or (Path.home() / ".muse-glimmer"))
    # Legacy used the resolved worktree path, so retain that exact key for migration.
    resolved = Path(workspace).expanduser().resolve()
    digest = hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()[:10]
    return root / "memory" / f"{resolved.name}-{digest}" / "blocked-commands.json"


def _clean_text(value: object, limit: int = 500) -> str:
    return str(value or "").strip()[:limit]


def _normalized_payload(kind: str, payload: dict) -> dict | None:
    if kind == "cochange":
        paths = sorted({_clean_text(item, 500) for item in payload.get("paths", []) if _clean_text(item, 500)})[:20]
        return {"paths": paths} if len(paths) >= 2 else None
    if kind == "verification-success":
        command = _clean_text(payload.get("command"), 1000)
        package = _clean_text(payload.get("package"), 200)
        return {"command": command, "package": package} if command else None
    if kind == "repair-success":
        signature = _clean_text(payload.get("failureSignature"), 200)
        strategy = _clean_text(payload.get("strategyId"), 120)
        files = sorted({_clean_text(item, 500) for item in payload.get("files", []) if _clean_text(item, 500)})[:20]
        return {"failureSignature": signature, "strategyId": strategy, "files": files} if signature and strategy else None
    if kind == "rejected-claim":
        claim_type = _clean_text(payload.get("claimType"), 40)
        category = _clean_text(payload.get("category"), 120)
        reason_code = _clean_text(payload.get("reasonCode"), 120)
        return {"claimType": claim_type, "category": category, "reasonCode": reason_code} if claim_type and reason_code else None
    if kind == "blocked-command":
        command = _clean_text(payload.get("command"), 1000)
        reason = _clean_text(payload.get("reason"), 500)
        return {"command": command, "reason": reason} if command else None
    return None


def _entry_key(kind: str, payload: dict) -> str:
    stable = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(f"{kind}\0{stable}".encode("utf-8")).hexdigest()[:24]


def _empty(workspace: Path) -> dict:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "repoIdentity": repo_identity(workspace),
        "updatedAt": _utc_now().isoformat(),
        "entries": [],
    }


def load_memory(workspace: Path, state_root: Path | None = None) -> dict:
    target = memory_path(workspace, state_root)
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
        if data.get("schemaVersion") == SCHEMA_VERSION and isinstance(data.get("entries"), list):
            data["entries"] = [entry for entry in data["entries"] if isinstance(entry, dict) and entry.get("kind") in KINDS]
            return data
    except (OSError, ValueError, TypeError, AttributeError):
        pass

    data = _empty(workspace)
    try:
        legacy = json.loads(_legacy_path(workspace, state_root).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        legacy = []
    if isinstance(legacy, list):
        now = _utc_now().isoformat()
        for item in legacy[:MEMORY_CAP]:
            if not isinstance(item, dict):
                continue
            payload = _normalized_payload("blocked-command", item)
            if not payload:
                continue
            data["entries"].append({
                "kind": "blocked-command",
                "key": _entry_key("blocked-command", payload),
                "count": max(1, int(item.get("count") or 1)),
                "firstSeen": item.get("lastSeen") or now,
                "lastSeen": item.get("lastSeen") or now,
                "payload": payload,
            })
    return data


def _atomic_write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def record_outcome(workspace: Path, kind: str, payload: dict, state_root: Path | None = None) -> bool:
    if kind not in KINDS or not isinstance(payload, dict):
        return False
    normalized = _normalized_payload(kind, payload)
    if normalized is None:
        return False
    try:
        data = load_memory(workspace, state_root)
        key = _entry_key(kind, normalized)
        now = _utc_now().isoformat()
        for entry in data["entries"]:
            if entry.get("key") == key:
                entry["count"] = max(1, int(entry.get("count") or 1)) + 1
                entry["lastSeen"] = now
                break
        else:
            data["entries"].append({
                "kind": kind, "key": key, "count": 1,
                "firstSeen": now, "lastSeen": now, "payload": normalized,
            })
        data["entries"].sort(key=lambda item: str(item.get("lastSeen") or ""), reverse=True)
        data["entries"] = data["entries"][:MEMORY_CAP]
        data["updatedAt"] = now
        _atomic_write(memory_path(workspace, state_root), data)
        return True
    except Exception:
        return False


def effective_entries(workspace: Path, kind: str | None = None, state_root: Path | None = None) -> list[dict]:
    now = _utc_now()
    result = []
    for entry in load_memory(workspace, state_root).get("entries", []):
        if kind and entry.get("kind") != kind:
            continue
        count = max(0, int(entry.get("count") or 0))
        if count < MIN_OBSERVATIONS:
            continue
        try:
            seen = datetime.fromisoformat(str(entry.get("lastSeen")).replace("Z", "+00:00"))
            age_days = max(0.0, (now - seen).total_seconds() / 86400.0)
        except (TypeError, ValueError):
            age_days = HALF_LIFE_DAYS * 10
        score = count * math.pow(0.5, age_days / HALF_LIFE_DAYS)
        result.append({**entry, "score": round(score, 4), "provenance": "verified-repository-memory"})
    return sorted(result, key=lambda item: (-item["score"], item["key"]))


def _selfcheck() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp) / "repo"
        state = Path(temp) / "state"
        root.mkdir()
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        assert record_outcome(root, "verification-success", {"command": "npm test", "package": "web"}, state)
        assert effective_entries(root, state_root=state) == []
        assert record_outcome(root, "verification-success", {"command": "npm test", "package": "web"}, state)
        active = effective_entries(root, "verification-success", state)
        assert len(active) == 1 and active[0]["count"] == 2
        assert not record_outcome(root, "repair-success", {"freeform": "model prose"}, state)
        assert memory_path(root, state).stat().st_mode & 0o777 == 0o600
    print("repository memory self-check: PASS")


if __name__ == "__main__":
    _selfcheck()
