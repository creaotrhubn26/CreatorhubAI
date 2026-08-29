#!/usr/bin/env python3
"""Repository-native verification discovery and repair deduplication."""
from __future__ import annotations

import hashlib
import json
import re
import shlex
import tempfile
from pathlib import Path

SCRIPT_KINDS = {
    "typecheck": ("typecheck", "check:types", "types"),
    "lint": ("lint",),
    "unit": ("test:unit", "test"),
    "integration": ("test:integration", "test:e2e", "e2e"),
    "build": ("build",),
}
UI_EXTENSIONS = {".css", ".scss", ".sass", ".less", ".tsx", ".jsx", ".vue", ".svelte"}
FAILURE_PATH_RE = re.compile(r"(?m)^\s*([./]?[\w@+.-][\w@+./-]*\.[A-Za-z0-9]+):\d+(?::\d+)?")


def _candidate(candidate_id: str, label: str, command: str, package: str, kind: str,
               tier: str, reason: str, provenance: str = "manifest") -> dict:
    normalized_provenance = {
        "manifest": "package-script",
        "git": "fallback",
        "tree-sitter": "semantic-index",
        "changed-files": "fallback",
    }.get(provenance, provenance)
    return {
        "id": candidate_id,
        "label": label,
        "command": command,
        "package": package,
        "kind": kind,
        "tier": tier,
        "type": kind,
        "level": tier,
        "reason": reason,
        "provenance": normalized_provenance,
    }


def _npm_command(directory: str, script: str) -> str:
    return f"npm run {shlex.quote(script)}" if directory == "." else f"npm --prefix {shlex.quote(directory)} run {shlex.quote(script)}"


def discover_verification_catalog(workspace: Path, repo_map: dict | None = None) -> list[dict]:
    workspace = Path(workspace).expanduser().resolve()
    candidates = [
        _candidate("git-diff-check", "Git whitespace check", "git diff --check", ".", "lint",
                   "required", "Always validate the produced patch", "git"),
    ]
    packages = list((repo_map or {}).get("packages") or [])
    if not packages:
        for manifest in sorted(workspace.glob("**/package.json")):
            if any(part in {"node_modules", ".git", "dist", "build"} for part in manifest.parts):
                continue
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            directory = manifest.parent.relative_to(workspace).as_posix() or "."
            packages.append({"dir": directory, "name": data.get("name") or directory,
                             "scripts": data.get("scripts") or {}})

    for package in packages:
        directory = str(package.get("dir") or ".")
        package_name = str(package.get("name") or directory)
        scripts = package.get("scripts") if isinstance(package.get("scripts"), dict) else {}
        for kind, names in SCRIPT_KINDS.items():
            script = next((name for name in names if name in scripts), None)
            if not script:
                continue
            tier = "required" if kind in {"typecheck", "unit"} else "recommended"
            candidates.append(_candidate(
                f"npm:{directory}:{script}", f"{package_name}: {script}",
                _npm_command(directory, script), package_name, kind, tier,
                f"Discovered from {directory}/package.json", "manifest",
            ))

    for manifest in sorted(workspace.glob("**/Cargo.toml")):
        if any(part in {"target", ".git"} for part in manifest.parts):
            continue
        rel = manifest.relative_to(workspace).as_posix()
        package = manifest.parent.relative_to(workspace).as_posix() or "."
        candidates.extend([
            _candidate(f"cargo:{rel}:test", f"{package}: cargo test",
                       f"cargo test --manifest-path {shlex.quote(rel)}", package, "unit", "required",
                       f"Discovered from {rel}", "cargo"),
            _candidate(f"cargo:{rel}:clippy", f"{package}: cargo clippy",
                       f"cargo clippy --manifest-path {shlex.quote(rel)} --all-targets -- -D warnings",
                       package, "lint", "recommended", f"Discovered from {rel}", "cargo"),
        ])

    pyproject = workspace / "pyproject.toml"
    if pyproject.is_file():
        text = pyproject.read_text(encoding="utf-8", errors="replace")
        if "[tool.pytest" in text or "pytest" in text:
            candidates.append(_candidate("python:pytest", "Python tests", "python3 -m pytest", ".",
                                         "unit", "required", "Discovered from pyproject.toml", "python"))
        if "[tool.mypy" in text:
            candidates.append(_candidate("python:mypy", "Python typecheck", "python3 -m mypy .", ".",
                                         "typecheck", "recommended", "Discovered from pyproject.toml", "python"))
        if "[tool.ruff" in text:
            candidates.append(_candidate("python:ruff", "Python lint", "python3 -m ruff check .", ".",
                                         "lint", "recommended", "Discovered from pyproject.toml", "python"))

    makefile = workspace / "Makefile"
    if makefile.is_file():
        text = makefile.read_text(encoding="utf-8", errors="replace")
        for target, kind, tier in (("quality", "integration", "recommended"),
                                   ("test", "unit", "required"),
                                   ("selfcheck", "unit", "required")):
            if re.search(rf"(?m)^{re.escape(target)}\s*:", text):
                candidates.append(_candidate(f"make:{target}", f"Make {target}", f"make {target}", ".",
                                             kind, tier, "Discovered target in Makefile", "makefile"))
    unique = {}
    for candidate in candidates:
        unique.setdefault(candidate["command"], candidate)
    return list(unique.values())


def _affected_packages(paths: list[str], repo_map: dict | None) -> set[str]:
    affected = set()
    for path in paths:
        matches = []
        for package in (repo_map or {}).get("packages") or []:
            directory = str(package.get("dir") or ".").strip("/")
            if directory == "." or path == directory or path.startswith(directory + "/"):
                matches.append((len(directory), str(package.get("name") or directory)))
        if matches:
            affected.add(max(matches)[1])
    return affected


def select_verification_candidates(catalog: list[dict], paths: list[str], level: str,
                                   repo_map: dict | None = None, repo_index: dict | None = None) -> dict:
    affected = _affected_packages(paths, repo_map)
    selected = []
    related_tests = set()
    for item in (repo_index or {}).get("tests") or []:
        if item.get("source") in paths:
            related_tests.update(item.get("tests") or [])
    for candidate in catalog:
        if candidate["id"] == "git-diff-check" or not affected or candidate["package"] in affected or candidate["package"] == ".":
            selected.append(dict(candidate))
    if related_tests:
        for test_path in sorted(related_tests)[:20]:
            selected.append(_candidate(
                f"targeted:{test_path}", f"Targeted test: {test_path}",
                _targeted_test_command(test_path, repo_map), _package_name_for(test_path, repo_map),
                "unit", "required", "Related through repository index", "tree-sitter",
            ))
    if any(Path(path).suffix.lower() in UI_EXTENSIONS for path in paths):
        selected.append(_candidate(
            "visual:changed-ui", "Visual verification", "visual", "frontend", "visual",
            "required" if level in {"standard", "full"} else "recommended",
            "A user-interface source file is affected", "changed-files",
        ))
    allowed = {
        "minimal": {"required"},
        "standard": {"required", "recommended"},
        "full": {"required", "recommended"},
    }.get(level, {"required"})
    selected = [candidate for candidate in selected if candidate["tier"] in allowed]
    seen = set()
    deduped = []
    for candidate in selected:
        if candidate["command"] not in seen:
            seen.add(candidate["command"])
            deduped.append(candidate)
    return {
        "required": [candidate for candidate in deduped if candidate["tier"] == "required"],
        "recommended": [candidate for candidate in deduped if candidate["tier"] == "recommended"],
    }


def _package_name_for(path: str, repo_map: dict | None) -> str:
    affected = _affected_packages([path], repo_map)
    return sorted(affected)[0] if affected else "."


def _targeted_test_command(path: str, repo_map: dict | None) -> str:
    suffix = Path(path).suffix.lower()
    package = None
    for item in (repo_map or {}).get("packages") or []:
        directory = str(item.get("dir") or ".").strip("/")
        if directory == "." or path.startswith(directory + "/"):
            if package is None or len(directory) > len(str(package.get("dir") or "")):
                package = item
    if suffix in {".js", ".jsx", ".ts", ".tsx"} and package:
        scripts = package.get("scripts") or {}
        test_script = next((name for name in SCRIPT_KINDS["unit"] if name in scripts), None)
        if test_script:
            return _npm_command(str(package.get("dir") or "."), test_script) + " -- " + shlex.quote(path)
    if suffix == ".py":
        return "python3 -m pytest " + shlex.quote(path)
    if suffix == ".rs":
        return "cargo test"
    return "test " + shlex.quote(path)


def failure_signature(output: str, returncode: int) -> dict:
    normalized = re.sub(r"\b\d+(?:\.\d+)?s\b", "<time>", output or "")
    normalized = re.sub(r"0x[0-9a-fA-F]+", "<address>", normalized)
    normalized = re.sub(r"/private/[^\s:]+|/tmp/[^\s:]+", "<tmp-path>", normalized)
    lines = [line.strip() for line in normalized.splitlines() if line.strip()][-80:]
    canonical = "\n".join(lines)
    paths = []
    for match in FAILURE_PATH_RE.finditer(output or ""):
        if match.group(1) not in paths:
            paths.append(match.group(1))
    category = "INFRA_FAIL" if _looks_infrastructure_failure(output) else "CODE_FAIL"
    digest = hashlib.sha256(f"{returncode}\0{canonical}".encode("utf-8")).hexdigest()[:20]
    return {"category": category, "signature": digest, "likelyFiles": paths[:20]}


def _looks_infrastructure_failure(output: str) -> bool:
    lower = (output or "").lower()
    return any(marker in lower for marker in (
        "operation not permitted", "network is unreachable", "temporary failure in name resolution",
        "no space left on device", "could not resolve host", "command not found", "no such file or directory: 'ruff'",
    ))


def strategy_id(failure: dict, changed_paths: list[str], diff_text: str) -> str:
    payload = {
        "category": failure.get("category"),
        "signature": failure.get("signature"),
        "paths": sorted(set(changed_paths)),
        "diff": hashlib.sha256((diff_text or "").encode("utf-8")).hexdigest(),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()[:20]


def repeated_strategy(attempts: list[dict], failure: dict, strategy: str) -> bool:
    return any(
        attempt.get("failureSignature") == failure.get("signature") and
        attempt.get("strategyId") == strategy
        for attempt in attempts
    )


def _selfcheck() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "web").mkdir()
        (root / "web/package.json").write_text(json.dumps({
            "name": "web", "scripts": {"typecheck": "tsc --noEmit", "test": "vitest run", "build": "vite build"}
        }), encoding="utf-8")
        repo_map = {"packages": [{"dir": "web", "name": "web", "scripts": {
            "typecheck": "tsc --noEmit", "test": "vitest run", "build": "vite build"
        }}]}
        catalog = discover_verification_catalog(root, repo_map)
        assert any(candidate["command"] == "npm --prefix web run typecheck" for candidate in catalog)
        plan = select_verification_candidates(catalog, ["web/src/App.tsx"], "standard", repo_map)
        assert any(candidate["kind"] == "visual" for candidate in plan["required"])
        failure = failure_signature("web/src/App.tsx:12: error TS123\n", 1)
        strategy = strategy_id(failure, ["web/src/App.tsx"], "diff")
        assert repeated_strategy([{"failureSignature": failure["signature"], "strategyId": strategy}], failure, strategy)
        assert failure_signature("listen EPERM: operation not permitted", 1)["category"] == "INFRA_FAIL"
    print("verification catalog self-check: PASS")


if __name__ == "__main__":
    _selfcheck()
