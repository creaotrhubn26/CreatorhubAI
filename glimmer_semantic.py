#!/usr/bin/env python3
"""Deterministic, provenance-aware repository semantic index.

Tree-sitter is optional at development time so the source checkout remains
usable before the packaged runtime is prepared.  Missing grammars never become
silent semantic coverage: every file records its parser/provenance and the
coverage object reports unsupported and failed languages explicitly.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1
MAX_FILES = 20_000
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_SECONDS = 15.0
SUPPORTED_EXTENSIONS = {
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".py": "python",
    ".rs": "rust",
}
LEXICAL_EXTENSIONS = {
    ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cs": "csharp",
    ".go": "go", ".java": "java", ".kt": "kotlin", ".php": "php",
    ".rb": "ruby", ".scala": "scala", ".swift": "swift",
    ".svelte": "svelte", ".vue": "vue",
}
INDEXED_EXTENSIONS = set(SUPPORTED_EXTENSIONS) | set(LEXICAL_EXTENSIONS)
TEST_PATH_RE = re.compile(r"(^|/)(tests?|__tests__)(/|$)|(?:^|[._-])(test|spec)\.", re.I)
EXPRESS_ROUTE_RE = re.compile(
    r"\b(?:app|router)\.(get|post|put|patch|delete|options|head|use)\s*\(\s*['\"]([^'\"]+)['\"]"
)
REACT_ROUTE_RE = re.compile(r"<Route\b[^>]*\bpath\s*=\s*['\"]([^'\"]+)['\"]", re.I)
IMPORT_TARGET_RE = re.compile(
    r"(?:from\s+|require\s*\(\s*|import\s*\(\s*|use\s+)(?:['\"])?([@A-Za-z0-9_./:-]+)"
)
LEXICAL_SYMBOL_RE = re.compile(
    r"^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function|func|interface|type|struct|enum|trait|fn)\s+([A-Za-z_$][\w$]*)",
    re.MULTILINE,
)


def _run_git(workspace: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(workspace), *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    return result.stdout.decode("utf-8", "replace")


def _git_files(workspace: Path) -> list[str]:
    raw = subprocess.run(
        ["git", "-C", str(workspace), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    ).stdout
    return sorted({item.decode("utf-8", "surrogateescape") for item in raw.split(b"\0") if item})


def _dirty_paths(workspace: Path) -> list[str]:
    names = set()
    for args in (("diff", "--name-only", "-z"), ("diff", "--cached", "--name-only", "-z"),
                 ("ls-files", "-z", "--others", "--exclude-standard")):
        raw = subprocess.run(
            ["git", "-C", str(workspace), *args], check=False,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        ).stdout
        names.update(item.decode("utf-8", "surrogateescape") for item in raw.split(b"\0") if item)
    return sorted(names)


def _content_hash(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
    except OSError:
        return "missing"
    return digest.hexdigest()


def repository_cache_key(workspace: Path, parser_versions: dict[str, str]) -> tuple[str, str, str]:
    head = _run_git(workspace, "rev-parse", "HEAD").strip()
    dirty = {
        rel: _content_hash(workspace / rel)
        for rel in _dirty_paths(workspace)
        if Path(rel).suffix.lower() in INDEXED_EXTENSIONS
    }
    dirty_hash = hashlib.sha256(json.dumps(dirty, sort_keys=True).encode("utf-8")).hexdigest()
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "head": head,
        "dirtyHash": dirty_hash,
        "parserVersions": parser_versions,
    }
    key = hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()
    return key, head, dirty_hash


def _load_parsers() -> tuple[dict[str, object], dict[str, str], list[str]]:
    parsers: dict[str, object] = {}
    versions: dict[str, str] = {}
    diagnostics: list[str] = []
    try:
        import importlib.metadata as metadata

        from tree_sitter import Language, Parser

        versions["tree-sitter"] = metadata.version("tree-sitter")
        modules = {
            "python": ("tree_sitter_python", "tree-sitter-python", None),
            "javascript": ("tree_sitter_javascript", "tree-sitter-javascript", None),
            "typescript": ("tree_sitter_typescript", "tree-sitter-typescript", "language_typescript"),
            "tsx": ("tree_sitter_typescript", "tree-sitter-typescript", "language_tsx"),
            "rust": ("tree_sitter_rust", "tree-sitter-rust", None),
        }
        for language, (module_name, distribution, factory_name) in modules.items():
            try:
                module = __import__(module_name)
                factory = getattr(module, factory_name or "language")
                parser = Parser(Language(factory()))
                parsers[language] = parser
                versions[language] = metadata.version(distribution)
            except Exception as exc:  # optional grammar, reported as uncovered
                diagnostics.append(f"parser unavailable for {language}: {type(exc).__name__}: {exc}")
    except Exception as exc:
        diagnostics.append(f"tree-sitter unavailable: {type(exc).__name__}: {exc}")
    return parsers, versions, diagnostics


def _node_text(source: bytes, node: object) -> str:
    return source[getattr(node, "start_byte"):getattr(node, "end_byte")].decode("utf-8", "replace")


def _walk_tree(root: object):
    stack = [root]
    while stack:
        node = stack.pop()
        yield node
        stack.extend(reversed(getattr(node, "children", ())))


def _symbol_from_node(source: bytes, node: object) -> tuple[str, str] | None:
    kind = getattr(node, "type", "")
    definition_types = {
        "function_declaration", "function_definition", "class_declaration", "class_definition",
        "method_definition", "interface_declaration", "type_alias_declaration", "struct_item",
        "enum_item", "trait_item", "function_item", "const_item", "static_item",
    }
    if kind not in definition_types:
        return None
    name_node = getattr(node, "child_by_field_name")("name")
    if name_node is None:
        return None
    name = _node_text(source, name_node).strip()
    return (name, kind) if name else None


def _parse_semantics(path: str, source: bytes, parser: object | None, language: str) -> dict:
    symbols = []
    identifiers = []
    provenance = "tree-sitter" if parser is not None else "lexical"
    parse_status = "parsed" if parser is not None else "fallback"
    if parser is not None:
        try:
            tree = getattr(parser, "parse")(source)
            root = tree.root_node
            parse_status = "parsed-with-errors" if root.has_error else "parsed"
            for node in _walk_tree(root):
                symbol = _symbol_from_node(source, node)
                if symbol:
                    name, kind = symbol
                    symbols.append({
                        "id": f"symbol:{path}:{node.start_point.row + 1}:{name}",
                        "name": name,
                        "kind": kind,
                        "path": path,
                        "line": node.start_point.row + 1,
                        "provenance": "tree-sitter",
                    })
                if getattr(node, "type", "") in {"identifier", "type_identifier"}:
                    name = _node_text(source, node).strip()
                    if name:
                        identifiers.append((name, node.start_point.row + 1))
        except Exception as exc:
            provenance = "lexical"
            parse_status = f"parser-error:{type(exc).__name__}"

    text = source.decode("utf-8", "replace")
    if provenance == "lexical":
        for match in LEXICAL_SYMBOL_RE.finditer(text):
            name = match.group(1)
            symbols.append({
                "id": f"symbol:{path}:{text.count(chr(10), 0, match.start()) + 1}:{name}",
                "name": name,
                "kind": "lexical-definition",
                "path": path,
                "line": text.count("\n", 0, match.start()) + 1,
                "provenance": "lexical",
            })

    imports = []
    for match in IMPORT_TARGET_RE.finditer(text):
        imports.append({"target": match.group(1), "line": text.count("\n", 0, match.start()) + 1})
    routes = [
        {"method": m.group(1).upper(), "route": m.group(2), "path": path,
         "line": text.count("\n", 0, m.start()) + 1, "framework": "express",
         "provenance": "lexical"}
        for m in EXPRESS_ROUTE_RE.finditer(text)
    ]
    routes.extend(
        {"method": "VIEW", "route": m.group(1), "path": path,
         "line": text.count("\n", 0, m.start()) + 1, "framework": "react-router",
         "provenance": "lexical"}
        for m in REACT_ROUTE_RE.finditer(text)
    )
    return {
        "symbols": symbols,
        "identifiers": identifiers,
        "imports": imports,
        "routes": routes,
        "provenance": provenance,
        "parseStatus": parse_status,
        "language": language,
    }


def _package_for(path: str, repo_map: dict | None) -> str | None:
    packages = (repo_map or {}).get("packages") or []
    matches = []
    for package in packages:
        directory = str(package.get("dir") or ".").strip("/")
        if directory == "." or path == directory or path.startswith(directory + "/"):
            matches.append((len(directory), package.get("name") or directory))
    return max(matches)[1] if matches else None


def _codeowners(workspace: Path) -> list[tuple[str, list[str]]]:
    for rel in ("CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"):
        target = workspace / rel
        if not target.is_file():
            continue
        rows = []
        try:
            for line in target.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                parts = stripped.split()
                if len(parts) >= 2:
                    rows.append((parts[0], parts[1:20]))
        except OSError:
            return []
        return rows[:500]
    return []


def _owner_for(path: str, rules: list[tuple[str, list[str]]]) -> list[str]:
    # Conservative subset of CODEOWNERS matching. Complex patterns remain
    # uncovered rather than being guessed.
    owner = []
    for pattern, candidates in rules:
        normalized = pattern.lstrip("/")
        if "*" not in normalized and (path == normalized or path.startswith(normalized.rstrip("/") + "/")):
            owner = candidates
    return owner


def _resolve_import_target(importer: str, target: str, known_files: set[str]) -> str | None:
    """Resolve conservative relative/module imports to an indexed file."""
    importer_dir = Path(importer).parent
    candidates: list[Path] = []
    if target.startswith("."):
        candidates.append(importer_dir / target)
    elif target.startswith("crate::"):
        candidates.append(Path("src") / target.removeprefix("crate::").replace("::", "/"))
    elif Path(importer).suffix == ".py":
        candidates.append(Path(target.replace(".", "/")))
    for base in candidates:
        normalized = Path(os.path.normpath(str(base))).as_posix().lstrip("./")
        probes = [normalized]
        probes.extend(normalized + ext for ext in INDEXED_EXTENSIONS)
        probes.extend(f"{normalized}/index{ext}" for ext in INDEXED_EXTENSIONS)
        probes.extend(f"{normalized}/mod{ext}" for ext in INDEXED_EXTENSIONS)
        for probe in probes:
            if probe in known_files:
                return probe
    return None


def build_repo_index(
    workspace: Path,
    repo_map: dict | None = None,
    output_path: Path | None = None,
    max_files: int = MAX_FILES,
    max_file_bytes: int = MAX_FILE_BYTES,
    max_seconds: float = MAX_SECONDS,
    cache_root: Path | None = None,
) -> dict:
    workspace = Path(workspace).expanduser().resolve()
    parsers, parser_versions, diagnostics = _load_parsers()
    cache_key, head, dirty_hash = repository_cache_key(workspace, parser_versions)
    cache_path = Path(cache_root) / f"{cache_key}.json" if cache_root is not None else None
    if cache_path is not None:
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if (
                cached.get("schemaVersion") == SCHEMA_VERSION
                and cached.get("workspace") == str(workspace)
                and cached.get("head") == head
                and cached.get("dirtyHash") == dirty_hash
                and cached.get("parserVersions") == parser_versions
            ):
                if output_path is not None:
                    atomic_write_json(Path(output_path), cached)
                return cached
        except (OSError, ValueError, AttributeError):
            pass
    started = time.monotonic()
    all_files = _git_files(workspace)
    records = []
    symbols = []
    imports = []
    routes = []
    identifiers_by_file = {}
    unsupported = set()
    skipped_large = 0
    truncated = False
    owner_rules = _codeowners(workspace)

    indexed_candidates = [rel for rel in all_files if Path(rel).suffix.lower() in INDEXED_EXTENSIONS]
    for rel in indexed_candidates:
        if len(records) >= max_files or time.monotonic() - started >= max_seconds:
            truncated = True
            break
        target = (workspace / rel).resolve()
        try:
            target.relative_to(workspace)
        except ValueError:
            diagnostics.append(f"symlink escape skipped: {rel}")
            continue
        try:
            size = target.stat().st_size
        except OSError as exc:
            diagnostics.append(f"unreadable file {rel}: {type(exc).__name__}")
            continue
        if size > max_file_bytes:
            skipped_large += 1
            continue
        try:
            source = target.read_bytes()
        except OSError as exc:
            diagnostics.append(f"unreadable file {rel}: {type(exc).__name__}")
            continue
        extension = Path(rel).suffix.lower()
        language = SUPPORTED_EXTENSIONS.get(extension) or LEXICAL_EXTENSIONS[extension]
        parser = parsers.get(language) if extension in SUPPORTED_EXTENSIONS else None
        parsed = _parse_semantics(rel, source, parser, language)
        if extension not in SUPPORTED_EXTENSIONS:
            parsed["parseStatus"] = "lexical-only-language"
        if parsed["provenance"] != "tree-sitter":
            unsupported.add(language)
        records.append({
            "path": rel,
            "language": language,
            "bytes": size,
            "sha256": hashlib.sha256(source).hexdigest(),
            "parser": parsed["provenance"],
            "parseStatus": parsed["parseStatus"],
            "package": _package_for(rel, repo_map),
            "owners": _owner_for(rel, owner_rules),
            "isTest": bool(TEST_PATH_RE.search(rel)),
        })
        symbols.extend(parsed["symbols"])
        routes.extend(parsed["routes"])
        identifiers_by_file[rel] = parsed["identifiers"]
        imports.extend({"from": rel, **item} for item in parsed["imports"])

    symbols_by_name = {}
    for symbol in symbols:
        symbols_by_name.setdefault(symbol["name"], []).append(symbol)
    edges = []
    known_files = {record["path"] for record in records}
    for item in imports:
        resolved_target = _resolve_import_target(item["from"], item["target"], known_files)
        edges.append({
            "from": f"file:{item['from']}",
            "to": f"file:{resolved_target}" if resolved_target else f"import:{item['target']}",
            "kind": "imports",
            "line": item["line"],
            "provenance": "lexical",
        })
    for rel, identifiers in identifiers_by_file.items():
        for name, line in identifiers:
            targets = symbols_by_name.get(name) or []
            for target in targets[:3]:
                if target["path"] == rel and target["line"] == line:
                    continue
                edges.append({
                    "from": f"file:{rel}", "to": target["id"], "kind": "references",
                    "line": line, "provenance": "tree-sitter",
                })
                if len(edges) >= 200_000:
                    diagnostics.append("edge cap reached")
                    break
            if len(edges) >= 200_000:
                break

    test_paths = [record["path"] for record in records if record["isTest"]]
    tests = []
    for record in records:
        if record["isTest"]:
            continue
        stem = Path(record["path"]).stem.lower()
        related = [candidate for candidate in test_paths if stem and stem in Path(candidate).stem.lower()][:20]
        if related:
            tests.append({"source": record["path"], "tests": related, "provenance": "lexical"})
            edges.extend({"from": f"file:{record['path']}", "to": f"file:{test}",
                          "kind": "tested-by", "provenance": "lexical"} for test in related)

    supported_seen = len(records)
    total_candidates = len(indexed_candidates)
    coverage = {
        "supportedFiles": supported_seen,
        "candidateFiles": total_candidates,
        "treeSitterFiles": sum(1 for record in records if record["parser"] == "tree-sitter"),
        "lexicalFallbackFiles": sum(1 for record in records if record["parser"] == "lexical"),
        "skippedLargeFiles": skipped_large,
        "unsupportedLanguages": sorted(unsupported),
        "unsupportedOrLexicalLanguages": sorted(unsupported),
        "partial": truncated or supported_seen + skipped_large < total_candidates,
        "ratio": round(supported_seen / total_candidates, 4) if total_candidates else 1.0,
        "limits": {"maxFiles": max_files, "maxFileBytes": max_file_bytes, "maxSeconds": max_seconds},
    }
    index = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "workspace": str(workspace),
        "head": head,
        "dirtyHash": dirty_hash,
        "cacheKey": cache_key,
        "parserVersions": parser_versions,
        "coverage": coverage,
        "files": records,
        "symbols": symbols[:100_000],
        "edges": edges[:200_000],
        "routes": routes[:20_000],
        "tests": tests[:20_000],
        "diagnostics": diagnostics[:200],
    }
    if output_path is not None:
        atomic_write_json(Path(output_path), index)
    if cache_path is not None:
        try:
            atomic_write_json(cache_path, index)
        except OSError:
            pass
    return index


def atomic_write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def query_symbols(index: dict, query: str, limit: int = 50) -> list[dict]:
    needle = query.casefold()
    return [item for item in index.get("symbols", []) if needle in str(item.get("name", "")).casefold()][:limit]


def query_references(index: dict, symbol_id: str, limit: int = 100) -> list[dict]:
    return [edge for edge in index.get("edges", []) if edge.get("kind") == "references" and edge.get("to") == symbol_id][:limit]


def related_tests(index: dict, path: str) -> list[str]:
    for item in index.get("tests", []):
        if item.get("source") == path:
            return list(item.get("tests") or [])
    return []


def impact_paths(index: dict, path: str, limit: int = 100) -> list[str]:
    node = f"file:{path}"
    found = set(related_tests(index, path))
    for edge in index.get("edges", []):
        if edge.get("from") == node and isinstance(edge.get("to"), str) and edge["to"].startswith("file:"):
            found.add(edge["to"][5:])
        if edge.get("to") == node and isinstance(edge.get("from"), str) and edge["from"].startswith("file:"):
            found.add(edge["from"][5:])
    return sorted(found)[:limit]


def _selfcheck() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        (root / "src").mkdir()
        (root / "tests").mkdir()
        (root / "python").mkdir()
        (root / "rust").mkdir()
        (root / "src/api.ts").write_text(
            "import { Router } from 'express';\nexport function greet(name: string) { return name; }\nrouter.get('/hello', greet);\n",
            encoding="utf-8",
        )
        (root / "src/view.tsx").write_text(
            "export function View() { return <Route path='/items' element={<div />} />; }\n",
            encoding="utf-8",
        )
        (root / "src/legacy.jsx").write_text(
            "export function Legacy() { return <span>legacy</span>; }\n",
            encoding="utf-8",
        )
        (root / "src/plain.js").write_text("export function plain() { return 1; }\n", encoding="utf-8")
        (root / "python/service.py").write_text("def serve():\n    return True\n", encoding="utf-8")
        (root / "rust/lib.rs").write_text("pub fn ready() -> bool { true }\n", encoding="utf-8")
        (root / "worker.go").write_text("package fixture\nfunc Work() {}\n", encoding="utf-8")
        (root / "tests/api.test.ts").write_text("import { greet } from '../src/api';\ngreet('x');\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(root), "add", "."], check=True)
        index = build_repo_index(root, max_seconds=5)
        assert index["schemaVersion"] == 1
        assert index["coverage"]["candidateFiles"] == 8
        assert {item["language"] for item in index["files"]} >= {
            "javascript", "typescript", "tsx", "python", "rust", "go",
        }
        assert any(route["route"] == "/hello" for route in index["routes"])
        assert any(route["route"] == "/items" for route in index["routes"])
        assert query_symbols(index, "greet")
        assert related_tests(index, "src/api.ts") == ["tests/api.test.ts"]
        assert "tests/api.test.ts" in impact_paths(index, "src/api.ts")
        assert "go" in index["coverage"]["unsupportedOrLexicalLanguages"]
        partial = build_repo_index(root, max_files=1, max_seconds=5)
        assert partial["coverage"]["partial"] is True
        first_key = index["cacheKey"]
        (root / "src/api.ts").write_text("export function greet() { return 'changed'; }\n", encoding="utf-8")
        changed = build_repo_index(root, max_seconds=5)
        assert changed["cacheKey"] != first_key, "dirty content must invalidate the index cache"
        target = root / "repo-index.json"
        atomic_write_json(target, changed)
        assert json.loads(target.read_text(encoding="utf-8"))["cacheKey"] == changed["cacheKey"]
    print("semantic repository index self-check: PASS")


if __name__ == "__main__":
    _selfcheck()
