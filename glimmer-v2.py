#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import urllib.error
import urllib.request

from glimmer_events import emit as emit_event

ENGINEER_DEFAULT = Path.home() / "AI/muse-glimmer/glimmer-engineer.py"
STATE_ROOT = Path.home() / ".muse-glimmer/sessions"
# C7 (glimmer-v7): cross-session repo-map cache, keyed by HEAD SHA. Separate
# from STATE_ROOT's per-session repo-map.json (that per-session artifact is
# unchanged by this cache; it's just a copy of whatever build_repo_map returns).
REPO_MAP_CACHE_ROOT = Path.home() / ".muse-glimmer/repo-maps"
NODE_OPTIONS_DEFAULT = "--max-old-space-size=12288"
READINESS_URL_DEFAULT = os.environ.get("GLIMMER_TOOLS_URL", "http://127.0.0.1:8080/tools")
# C4 (glimmer-v7): Vision Verification plumbing. GLIMMER_VISUAL is the
# standalone capture script this module shells out to when the literal
# token "visual" appears in contract.verification / --verify -- it is just
# another verifier command, not a second pipeline (see expand_verify_entries
# / classify_visual_check_result below). VISUAL_DEFAULT_VIEWPORTS is V7
# §22.6's stated desktop+mobile minimum.
GLIMMER_VISUAL = Path(__file__).resolve().parent / "glimmer-visual.py"
VISUAL_VERIFY_TOKEN = "visual"
VISUAL_DEFAULT_VIEWPORTS = ("1440x900", "390x844")

IGNORE_DIRS = {
    ".git", "node_modules", ".next", ".turbo", ".cache", "coverage",
    "dist", "build", "out", ".output", ".venv", "venv", "__pycache__",
}

SCRIPT_GROUPS = {
    "typecheck": ("typecheck", "type-check", "check:types", "check-types", "tsc"),
    "lint": ("lint", "eslint"),
    "test": ("test:ci", "test", "vitest"),
    "build": ("build", "build:ci"),
}

FRAMEWORK_DEPS = {
    "react": "React", "vite": "Vite", "next": "Next.js",
    "express": "Express", "fastify": "Fastify", "@nestjs/core": "NestJS",
    "hono": "Hono", "drizzle-orm": "Drizzle ORM", "prisma": "Prisma",
    "@prisma/client": "Prisma", "pg": "PostgreSQL client",
    "postgres": "Postgres.js", "vitest": "Vitest", "jest": "Jest",
    "@playwright/test": "Playwright", "cypress": "Cypress",
    "typescript": "TypeScript",
}

CONFIG_NAMES = {
    "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "netlify.toml",
    "vercel.json", "render.yaml", "render.yml", "drizzle.config.ts",
    "drizzle.config.js", "vite.config.ts", "vite.config.js", "vitest.config.ts",
    "vitest.config.js", "playwright.config.ts", "playwright.config.js",
    "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "tsconfig.json",
    "turbo.json", "nx.json",
}

LOCKFILE_NAMES = {"package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"}

PASS_STATUSES = {"PASS", "PASS_BASELINE"}

# R3 (glimmer-v7): Python port of control-center's mapManifestStatus
# (control-center/server/src/lib/sessions.ts) — that TS function is the
# already-tested translation table FROM these raw manifest["status"] strings
# TO the canonical 14-value GlimmerSessionStatus vocabulary (shared/src/types.ts).
# Keep this in sync with mapManifestStatus if either side changes.
#
# manifest["status"] keeps writing the raw strings below unchanged (backward
# read-compatibility with the 24 archived sessions that predate this task).
# manifest["state"] is the new field carrying the canonical value, and is
# also what agent_state_changed events now emit as `state=`.
def canonical_session_state(raw_status: str) -> str:
    if raw_status == "initialized":
        return "preflight"
    if raw_status in ("verified", "no-change-verified"):
        return "verified"
    if raw_status == "no-change-unverified":
        return "needs_review"
    # C2 (glimmer-v7): terminal status when the architect review gate
    # rejects the implementation (REPLAN_REQUIRED/HUMAN_REVIEW_REQUIRED)
    # or the review budget is exhausted — V7 §5.10's rule: a session in
    # this state must never be promoted to "verified".
    if raw_status == "needs-architect-review":
        return "needs_review"
    if raw_status.startswith("blocked-"):
        return "blocked"
    if raw_status.startswith("failed-"):
        return "failed"
    # repo-map-only is TERMINAL (v2 writes it and exits immediately, no
    # engineering work attempted) — must not map to an in-flight state.
    if raw_status == "repo-map-only":
        return "cancelled"
    # R6: SIGTERM/Ctrl-C now write "cancelled-sigterm" (see _sigterm_handler's
    # call site in main()) instead of silently leaving whatever status was
    # last saved before the interrupt. Not yet mirrored in control-center's
    # mapManifestStatus (out of this task's file scope) — that function's own
    # unrecognized-status fallback ("needs_review", never in-flight) is a safe
    # degrade until it is.
    if raw_status.startswith("cancelled"):
        return "cancelled"
    # Unrecognized raw status: never default to in-flight — surface it for a
    # human to look at instead of misreporting a live session.
    return "needs_review"


def read_session_events(events_path: Path) -> list:
    """R6: read a session's own events.jsonl back at session end, so
    classify_failure has real event evidence (tool_blocked/scope_expanded/
    parser_recovery) to cite. Python-side equivalent of a
    readSessionEventsBatch-style reader: one process, one run, so the file is
    always small — a single full read is enough, no streaming/pagination
    needed. Tolerates a missing file (archived sessions predating Task 1's
    emitter have none) and malformed/partial lines (glimmer_events.emit's own
    docstring notes O_APPEND is only atomic up to PIPE_BUF; never raise on a
    torn last line)."""
    try:
        raw = events_path.read_text(encoding="utf-8")
    except OSError:
        return []
    out = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


PARSER_FAILURE_THRESHOLD = 2  # R6: one recovered parse is transient; repeated recoveries in one terminal session point at a structural parser problem


def classify_failure(manifest: dict, events: list) -> dict | None:
    """R6: classify a session's real terminal state into
    {class, detail, evidenceIds}, or None for genuine success.

    Reads manifest["status"] (the RAW string), not manifest["state"] — the
    canonical GlimmerSessionStatus value collapses blocked-infra_blocked/
    blocked-timeout (and any future blocked-*/failed-* variant) into one
    generic "blocked"/"failed" bucket via canonical_session_state's prefix
    match, which is exactly the distinction a failure taxonomy needs to keep.
    Archived sessions from before R3 (Task 6) never got a "state" field at
    all, so "status" is also the only field guaranteed to exist.

    Precedence: manifest["status"] is the orchestrator's own authoritative
    terminal signal and is checked first. Per-tool/per-file events
    (tool_blocked, scope_expanded, parser_recovery) are advisory during the
    run — e.g. a real archived "verified" session
    (20260817-183716-glimmer-smoke-test-r1) has 2 tool_blocked events from a
    denied command the engineer recovered from and still finished clean — so
    they are only consulted for terminal states this function doesn't
    otherwise recognize, never allowed to override a genuine success/no-op
    status.
    """
    raw = manifest.get("status") or ""

    if raw in ("verified", "no-change-verified"):
        return None
    if raw == "repo-map-only":
        return None  # deliberate --repo-map-only early exit, not a failure

    if raw == "blocked-infra_blocked":
        return {"class": "INFRA_BLOCKED", "detail": "verifier infrastructure failure (missing binary/module)", "evidenceIds": []}
    if raw == "blocked-timeout":
        return {"class": "TIMEOUT", "detail": "verifier or engineer step timed out", "evidenceIds": []}
    if raw == "failed-repair-budget-exhausted":
        return {"class": "CODE_FAIL", "detail": "repair budget exhausted with failing checks remaining", "evidenceIds": []}
    if raw == "failed-verifier-mutated-repo":
        return {"class": "POLICY_BLOCK", "detail": "verifier command mutated the repository", "evidenceIds": []}
    if raw == "needs-architect-review":
        return {"class": "POLICY_BLOCK", "detail": "architect review rejected the implementation or the review budget was exhausted (V7 §5.10/§5.13)", "evidenceIds": []}
    if raw == "failed-aborted":
        return {"class": "ORCHESTRATION_ABORTED",
                "detail": "orchestration raised an error before completing any attempt "
                           "(e.g. model server unreachable at readiness_probe, or another "
                           "run()/setup failure) — no repair loop iteration ever started",
                "evidenceIds": []}
    if raw.startswith("cancelled"):
        return {"class": "USER_CANCELLED", "detail": "session terminated by SIGTERM/interrupt before reaching a terminal state", "evidenceIds": []}

    blocked = [e for e in events if e.get("type") == "tool_blocked"]
    if blocked:
        return {"class": "POLICY_BLOCK", "detail": blocked[-1].get("reason") or "shell command blocked by policy",
                "evidenceIds": [e["id"] for e in blocked if "id" in e]}

    scope_events = [e for e in events if e.get("type") == "scope_expanded"]
    if scope_events:
        return {"class": "SCOPE_FAILURE", "detail": "changed files exceeded the task contract's declared scope",
                "evidenceIds": [e["id"] for e in scope_events if "id" in e]}

    parser_events = [e for e in events if e.get("type") == "parser_recovery"]
    if len(parser_events) >= PARSER_FAILURE_THRESHOLD:
        return {"class": "PARSER_FAILURE", "detail": f"model response parser recovered {len(parser_events)} times this session",
                "evidenceIds": [e["id"] for e in parser_events if "id" in e]}

    # Anything else reaching here is a real terminal status this function
    # doesn't specifically recognize — e.g. "no-change-unverified", or a
    # legacy "blocked-no-changes" string a pre-refactor orchestrator version
    # wrote (still present in archived sessions, no longer produced by
    # current code). Report it rather than guessing or raising.
    return {"class": "UNKNOWN", "detail": f"unclassified terminal state: status={raw!r}", "evidenceIds": []}


class V2Error(RuntimeError):
    pass


class V2Interrupted(RuntimeError):
    pass


def run(argv, cwd, *, check=True, timeout=None, env=None):
    merged = os.environ.copy()
    if env:
        merged.update(env)
    try:
        p = subprocess.run(argv, cwd=str(cwd), text=True, capture_output=True,
                           timeout=timeout, env=merged)
    except FileNotFoundError as exc:
        if check:
            raise V2Error(f"Executable not found: {argv[0]}") from exc
        return subprocess.CompletedProcess(argv, 127, "", f"{argv[0]}: command not found\n")
    if check and p.returncode != 0:
        out = (p.stdout or "") + (p.stderr or "")
        raise V2Error(f"Command failed ({p.returncode}): {shlex.join(argv)}\n{out[-8000:]}")
    return p


def git(ws, *args, check=True):
    return (run(["git", *args], ws, check=check).stdout or "").strip()


def lines(text):
    return [x for x in text.splitlines() if x.strip()]


def status(ws):
    return lines(git(ws, "status", "--porcelain=v1", "--untracked-files=all"))


def branch(ws):
    return git(ws, "branch", "--show-current")


def head(ws):
    return git(ws, "rev-parse", "HEAD")


def upstream(ws):
    p = run(["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], ws, check=False)
    return (p.stdout or "").strip() if p.returncode == 0 else None


def commit_subject(ws, rev="HEAD"):
    return git(ws, "show", "-s", "--format=%s", rev)


def changed_files(ws, baseline):
    tracked = lines(git(ws, "diff", "--name-only", baseline, "--"))
    untracked = lines(git(ws, "ls-files", "--others", "--exclude-standard"))
    return sorted(set(tracked + untracked))


def _expected_prefixes(scope: dict) -> list:
    """Python port of repoAnalysis.ts's expectedPrefixes(). glimmer-v2.py has
    no repoMap object at this call site (that's a control-center-only
    concept), so the frontend/backend -> repoMap.packages lookup is dropped;
    scope.package falls straight through to the bare-name fallback the TS
    itself uses when repoMap has no match for that package."""
    paths = scope.get("paths") or []
    if paths:
        return list(paths)
    if scope.get("area"):
        return [scope["area"]]
    package = scope.get("package")
    if package in ("frontend", "backend"):
        return [package]
    return []  # repository/directory/files with no explicit path: nothing meaningful to guard against


def compute_scope_guard(changed: list, contract: dict) -> dict:
    """Python port of control-center's computeScopeGuard/expectedPrefixes
    (control-center/server/src/lib/repoAnalysis.ts, read in full for this
    port).

    Follow-up fix (Fix 2, fix-followups-a-c): the original port faithfully
    copied a bug in the TS reference — a plain `p.startsWith(prefix)` match,
    which is not boundary-safe (`frontend/src/dialog` would wrongly match
    `frontend/src/dialog-old/file.ts`, a sibling-path collision rather than a
    real path-boundary match). A companion fix is landing the boundary-safe
    match in repoAnalysis.ts independently; this port now applies the
    equivalent fix directly rather than waiting on that diff — a path is in
    scope only if it equals a declared prefix exactly, or starts with
    `prefix + "/"` (after stripping any trailing slash from the prefix)."""
    scope = contract.get("scope") or {}
    expected = _expected_prefixes(scope)
    actual = list(changed)
    if not expected:
        # F5: "directory"/"files" scope CLAIMS to be bounded to a concrete
        # path, but nothing concrete was ever given — expectedPrefixes() then
        # has nothing to guard against. Reporting inScope: true here would be
        # indistinguishable from the honest, intentional "repository" scope
        # (no boundary by design) below. Report the state as unbounded
        # instead of silently passing every file as "in scope".
        if scope.get("package") in ("directory", "files"):
            return {"inScope": False, "expected": expected, "actual": actual,
                     "expandedFiles": [], "unbounded": True}
        return {"inScope": True, "expected": expected, "actual": actual, "expandedFiles": []}
    expanded = [f for f in actual if not any(
        f == p.rstrip("/") or f.startswith(p.rstrip("/") + "/")
        for p in expected
    )]
    return {"inScope": len(expanded) == 0, "expected": expected, "actual": actual, "expandedFiles": expanded}


def _scope_guard_selfcheck() -> None:
    """Fix 2 (fix-followups-a-c): boundary-safe prefix match for
    compute_scope_guard. Run with: python3 glimmer-v2.py --scope-guard-selfcheck
    """
    # Exact-prefix match still in scope.
    r = compute_scope_guard(["src/dialog/file.ts"], {"scope": {"paths": ["src/dialog"]}})
    assert r["inScope"] is True and r["expandedFiles"] == []

    # A file that IS the declared prefix path exactly is in scope.
    r = compute_scope_guard(["src/dialog"], {"scope": {"paths": ["src/dialog"]}})
    assert r["inScope"] is True and r["expandedFiles"] == []

    # Boundary fix: a sibling path that merely shares the prefix as a string
    # (src/dialog-old/...) must NOT be treated as in scope.
    r = compute_scope_guard(["src/dialog-old/file.ts"], {"scope": {"paths": ["src/dialog"]}})
    assert r["inScope"] is False and r["expandedFiles"] == ["src/dialog-old/file.ts"]

    # Trailing slash on the declared prefix is normalized the same way.
    r = compute_scope_guard(["src/dialog-old/file.ts"], {"scope": {"paths": ["src/dialog/"]}})
    assert r["inScope"] is False and r["expandedFiles"] == ["src/dialog-old/file.ts"]

    # Mixed set: in-scope file passes, sibling-collision file is flagged.
    r = compute_scope_guard(
        ["src/dialog/a.ts", "src/dialog-old/b.ts"],
        {"scope": {"paths": ["src/dialog"]}},
    )
    assert r["inScope"] is False and r["expandedFiles"] == ["src/dialog-old/b.ts"]

    print("scope guard boundary-match self-check: PASS")


def file_change_types(ws, baseline):
    """Map path -> 'added'|'modified'|'deleted', derived from real git status vs
    baseline (untracked files count as 'added'). Used only to populate file_changed
    event payloads with a real changeType instead of a hardcoded one."""
    out = {}
    for line in lines(git(ws, "diff", "--name-status", baseline, "--")):
        parts = line.split("\t")
        code, path = parts[0], parts[-1]
        out[path] = "deleted" if code.startswith("D") else "added" if code.startswith(("A", "R", "C")) else "modified"
    for rel in lines(git(ws, "ls-files", "--others", "--exclude-standard")):
        out[rel] = "added"
    return out


def diff_hash(ws, baseline):
    h = hashlib.sha256()
    h.update((run(["git", "diff", "--binary", baseline, "--"], ws).stdout or "").encode())
    for rel in lines(git(ws, "ls-files", "--others", "--exclude-standard")):
        h.update(rel.encode() + b"\0")
        p = ws / rel
        try:
            h.update(p.read_bytes())
        except OSError:
            pass
        h.update(b"\0")
    return h.hexdigest()


def git_diff_text(ws, baseline):
    """C2 (glimmer-v7): the actual (not just hashed) diff v2 hands to the
    architect review — same underlying git plumbing as diff_hash/
    file_change_types above (tracked diff via `git diff`, untracked files
    enumerated via `git ls-files --others`), just rendered as readable
    text instead of a hash, and not a new discovery pass over the
    workspace. Untracked files have no tracked diff to show, so each is
    represented as a synthetic "new file" block; unreadable/binary/non-
    utf8 content is noted and skipped, never raised.
    """
    parts = [run(["git", "diff", baseline, "--"], ws).stdout or ""]
    for rel in lines(git(ws, "ls-files", "--others", "--exclude-standard")):
        p = ws / rel
        try:
            content = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            parts.append(f"\n--- new file (untracked): {rel} (binary or unreadable; content omitted) ---\n")
            continue
        parts.append(f"\n--- new file (untracked): {rel} ---\n{content}")
    return "".join(parts)


def walk_files(ws, max_depth=5):
    base_depth = len(ws.parts)
    for current, dirs, files in os.walk(ws):
        cp = Path(current)
        depth = len(cp.parts) - base_depth
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        if depth >= max_depth:
            dirs[:] = []
        for name in files:
            yield cp / name


def safe_json(path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _build_repo_map_uncached(ws):
    """The real (expensive) repo-map walk. Renamed from build_repo_map so
    build_repo_map below can wrap it with the C7 cross-session cache without
    touching this function's shape or behavior at all."""
    packages, configs, workflows, locks = [], [], [], []
    for path in walk_files(ws):
        rel = path.relative_to(ws).as_posix()
        if path.name == "package.json":
            data = safe_json(path)
            if data:
                deps = set()
                for key in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
                    value = data.get(key)
                    if isinstance(value, dict):
                        deps.update(value.keys())
                scripts = data.get("scripts") if isinstance(data.get("scripts"), dict) else {}
                parent = Path(rel).parent.as_posix()
                packages.append({
                    "path": rel,
                    "dir": "." if parent == "." else parent,
                    "name": data.get("name"),
                    "scripts": scripts,
                    "frameworks": sorted({label for dep, label in FRAMEWORK_DEPS.items() if dep in deps}),
                    "engines": data.get("engines"),
                    "workspaces": data.get("workspaces"),
                })
        if path.name in CONFIG_NAMES:
            configs.append(rel)
        if rel.startswith(".github/workflows/") and path.suffix in {".yml", ".yaml"}:
            workflows.append(rel)
        if path.name in LOCKFILE_NAMES:
            locks.append(rel)
    return {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "workspace": str(ws), "branch": branch(ws), "head": head(ws),
        "upstream": upstream(ws),
        "packages": sorted(packages, key=lambda x: x["path"]),
        "configs": sorted(set(configs)),
        "workflows": sorted(set(workflows)),
        "lockfiles": sorted(set(locks)),
    }


def _lockfile_state(ws):
    """Cheap stand-in for the full repo-map walk: just enough to tell whether
    an uncommitted `npm install`/lockfile edit invalidated the cache, without
    parsing every package.json. rel path -> mtime (ns, so same-second edits
    still register), sorted-dict-stable via plain dict (insertion order from
    walk_files, which os.walk keeps deterministic-enough for equality checks
    since we only ever compare it back against itself)."""
    state = {}
    for path in walk_files(ws):
        if path.name in LOCKFILE_NAMES:
            rel = path.relative_to(ws).as_posix()
            try:
                state[rel] = path.stat().st_mtime_ns
            except OSError:
                pass
    return state


def build_repo_map(ws):
    """C7 (glimmer-v7): cross-session cache around _build_repo_map_uncached,
    keyed by the repo's current HEAD SHA and invalidated on either a HEAD
    change (new cache key) or a lockfile mtime change (dependencies/scripts
    can change without a new commit, e.g. an uncommitted `npm install`).
    Cache lives at ~/.muse-glimmer/repo-maps/<head>.json, separate from the
    per-session repo-map.json main() writes into the session dir (unchanged).

    Caching only — no new repo-map fields (scope note: C7 is deliberately
    narrowed to caching; tests-per-package / route-schema hints are deferred
    to whenever a real consumer exists, per doc §5's "add fields only when a
    consumer exists")."""
    sha = head(ws)
    lock_state = _lockfile_state(ws)
    cache_path = REPO_MAP_CACHE_ROOT / f"{sha}.json"
    cached = safe_json(cache_path) if sha and cache_path.exists() else None
    if (
        cached
        and isinstance(cached.get("repoMap"), dict)
        and cached.get("lockfileState") == lock_state
    ):
        return cached["repoMap"]

    repo_map = _build_repo_map_uncached(ws)
    if sha:
        try:
            REPO_MAP_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(
                json.dumps({"repoMap": repo_map, "lockfileState": lock_state}, indent=2),
                encoding="utf-8",
            )
        except OSError:
            pass  # cache write is an optimization, never fatal to the session
    return repo_map


def repo_summary(m):
    out = [f"branch={m['branch']}", f"head={m['head']}", f"upstream={m['upstream'] or 'none'}", "", "PACKAGES:"]
    for p in m["packages"]:
        useful = []
        scripts = p.get("scripts") or {}
        for group in SCRIPT_GROUPS.values():
            useful.extend(name for name in group if name in scripts)
        out.append(
            f"- {p['path']} name={p.get('name')} frameworks={','.join(p['frameworks']) or 'none'} "
            f"validation_scripts={','.join(dict.fromkeys(useful)) or 'none'}"
        )
    out += ["", "CONFIGS:"] + [f"- {x}" for x in m["configs"][:80]]
    out += ["", "WORKFLOWS:"] + [f"- {x}" for x in m["workflows"][:80]]
    out += ["", "LOCKFILES:"] + [f"- {x}" for x in m["lockfiles"][:40]]
    return "\n".join(out)[:12000]


def best_package(m, rel):
    best = None
    for pkg in m["packages"]:
        d = pkg["dir"]
        if d == "." or rel == d or rel.startswith(d.rstrip("/") + "/"):
            score = len(d)
            if best is None or score > best[0]:
                best = (score, pkg)
    return best[1] if best else None


def choose_script(pkg, group):
    scripts = pkg.get("scripts") or {}
    for name in SCRIPT_GROUPS[group]:
        if name in scripts:
            return name
    return None


def npm_cmd(pkg, script):
    return ["npm", "run", script] if pkg["dir"] == "." else ["npm", "--prefix", pkg["dir"], "run", script]


def verifier_commands(m, files, level):
    commands = [["git", "diff", "--check"]]
    affected = {}
    for f in files:
        pkg = best_package(m, f)
        if pkg:
            affected[pkg["path"]] = pkg
    for pkg in affected.values():
        tc = choose_script(pkg, "typecheck")
        lint = choose_script(pkg, "lint")
        test = choose_script(pkg, "test")
        build = choose_script(pkg, "build")
        if tc:
            commands.append(npm_cmd(pkg, tc))
        if level in {"standard", "full"} and lint:
            commands.append(npm_cmd(pkg, lint))
        if level == "full" and test:
            commands.append(npm_cmd(pkg, test))
        if level == "full" and build:
            commands.append(npm_cmd(pkg, build))
    result, seen = [], set()
    for c in commands:
        key = tuple(c)
        if key not in seen:
            seen.add(key)
            result.append(c)
    return result


def build_visual_verify_command(session, url):
    """C4 (glimmer-v7): real subprocess argv for the visual capture check,
    targeting sessions/<id>/visual/ (V7 §22.14 evidence store layout).
    Creates the output directory up front so glimmer-visual.py -- which is
    handed only --output-dir, never a workspace path -- has somewhere to
    write and never needs to reach outside it (V7 §22.19: Vision Verifier
    must be read-only)."""
    out_dir = session / "visual"
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, str(GLIMMER_VISUAL), "--url", url, "--output-dir", str(out_dir)]
    for vp in VISUAL_DEFAULT_VIEWPORTS:
        cmd += ["--viewport", vp]
    return cmd


def is_visual_check_command(cmd):
    return str(GLIMMER_VISUAL) in cmd


def validate_visual_url(raw_verify_entries, visual_url):
    """Fix round 1 (C4): --visual-url has no default. A guessable default
    like http://localhost:3000 is actively dangerous here -- if a caller
    forgets to pass a real URL and something else happens to be listening
    on that port, capture would silently "succeed" against the wrong app.
    Fail loudly (main()'s existing V2Error convention) instead, but only
    when "visual" is actually opted into -- every other verification plan
    is unaffected."""
    if any(r.strip().lower() == VISUAL_VERIFY_TOKEN for r in raw_verify_entries) and not visual_url:
        raise V2Error(
            "--visual-url is required when the visual check is enabled "
            '("visual" is in --verify / contract.verification)'
        )


def expand_verify_entries(commands, raw_entries, session, visual_url):
    """Expand contract.verification / --verify entries into real subprocess
    argv lists, appended onto `commands`. Mirrors the pre-C4
    shlex.split-and-append behavior exactly for every entry EXCEPT the
    literal token "visual" (case-insensitive): that one entry is C4's
    opt-in vision-verification check and expands to a glimmer-visual.py
    invocation instead of being shell-split (shlex.split("visual") would
    otherwise silently try to exec a nonexistent "visual" binary). A
    verification plan that never contains "visual" takes the identical
    path through this function as the old inline loop did -- zero behavior
    change for every existing invocation shape.
    """
    for raw in raw_entries:
        if raw.strip().lower() == VISUAL_VERIFY_TOKEN:
            cmd = build_visual_verify_command(session, visual_url)
        else:
            cmd = shlex.split(raw)
        if cmd and cmd not in commands:
            commands.append(cmd)
    return commands


def classify_visual_check_result(result, session):
    """C4 (glimmer-v7): apply the V7 §22.5 severity model on top of the
    generic subprocess classification run_verifier_command already computed.

    Any non-zero exit / timeout of glimmer-visual.py itself -- and any
    missing/unreadable/incomplete capture output -- is classified
    INFRA_BLOCKED, reusing the existing convention verbatim (reconciliation
    doc §12 risk 5: "Vision flakiness... treat capture failures as
    INFRA_BLOCKED -- the existing convention that does not consume repair
    budget"). This is deliberately NOT classify_raw_result's generic
    text-pattern guess: e.g. a Python traceback from a missing `playwright`
    import would otherwise be misclassified as CODE_FAIL (a real code
    defect) instead of an infra problem with the capture pipeline itself.

    Only a clean, fully-captured run (manifest status == "pass") is
    inspected for findings[]: any critical/high finding fails the check
    (CODE_FAIL -- a real, repair-worthy defect, consumes repair budget like
    any other verification failure); low/medium/no findings pass it (V7
    §22.13: "only required failures should block" -- this pass never
    populates findings[] with anything since no model call is wired up yet,
    so this path always yields PASS today, but the classification is real).

    Blocking is driven SOLELY by findings[] severities, never by
    findings_doc["status"] itself -- that field (PASS/FAIL/NOT_RUN/...) is
    informational metadata for humans/Control Center about whether semantic
    review ran at all (fix round 1: glimmer-visual.py now honestly writes
    "NOT_RUN" for a clean capture with no review, not "PASS" -- see its
    build_findings docstring), so this function deliberately never branches
    on it: NOT_RUN with an empty findings[] takes the exact same
    non-blocking PASS path below as any other empty-findings result.
    """
    if result.get("status") != "PASS":
        result["status"] = "INFRA_BLOCKED"
        result["ok"] = False
        result["visualInfraReason"] = "glimmer-visual.py exited non-zero or timed out"
        return result

    visual_dir = session / "visual"
    try:
        manifest_doc = json.loads((visual_dir / "visual-manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        result["status"] = "INFRA_BLOCKED"
        result["ok"] = False
        result["visualInfraReason"] = f"visual-manifest.json unreadable: {exc}"
        return result

    if manifest_doc.get("status") != "pass":
        result["status"] = "INFRA_BLOCKED"
        result["ok"] = False
        result["visualInfraReason"] = f"capture incomplete: manifest status={manifest_doc.get('status')!r}"
        result["visualManifest"] = manifest_doc
        return result

    try:
        findings_doc = json.loads((visual_dir / "findings.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        result["status"] = "INFRA_BLOCKED"
        result["ok"] = False
        result["visualInfraReason"] = f"findings.json unreadable: {exc}"
        return result

    findings = findings_doc.get("findings", [])
    blocking = [f for f in findings if str(f.get("severity", "")).lower() in ("critical", "high")]
    result["visualManifest"] = manifest_doc
    result["visualFindings"] = findings_doc
    if blocking:
        result["status"] = "CODE_FAIL"
        result["ok"] = False
        result["visualBlockingFindings"] = blocking
    else:
        result["status"] = "PASS"
        result["ok"] = True
    return result


def common_repo_root(ws):
    raw = git(ws, "rev-parse", "--git-common-dir")
    p = Path(raw)
    if not p.is_absolute():
        p = (ws / p).resolve()
    else:
        p = p.resolve()
    return p.parent if p.name == ".git" else p.parent


def is_ignored(ws, rel):
    p = run(["git", "check-ignore", "-q", "--", rel], ws, check=False)
    return p.returncode == 0


def prepare_toolchain_bridges(ws, repo_map):
    source_root = common_repo_root(ws)
    created = []
    if source_root.resolve() == ws.resolve():
        return source_root, created

    candidates = [(Path("node_modules"), source_root / "node_modules")]
    for pkg in repo_map.get("packages", []):
        d = pkg.get("dir")
        if d and d != ".":
            rel = Path(d) / "node_modules"
            candidates.append((rel, source_root / rel))

    for rel, src in candidates:
        dst = ws / rel
        if os.path.lexists(dst):
            continue
        if not src.is_dir():
            continue
        rel_text = rel.as_posix()
        if not is_ignored(ws, rel_text):
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(src, dst, target_is_directory=True)
        created.append({"path": str(dst), "source": str(src)})
    return source_root, created


def cleanup_toolchain_bridges(created):
    for item in reversed(created):
        p = Path(item["path"])
        try:
            if p.is_symlink() and str(p.resolve()) == str(Path(item["source"]).resolve()):
                p.unlink()
        except OSError:
            pass


def verifier_env(ws, repo_map, source_root, toolchain_mode="path"):
    env = {"NODE_OPTIONS": os.environ.get("NODE_OPTIONS", NODE_OPTIONS_DEFAULT)}
    bins = []
    modules = []
    roots = [ws]
    if toolchain_mode != "none" and source_root.resolve() != ws.resolve():
        roots.append(source_root)
    for root in roots:
        nm = root / "node_modules"
        if nm.is_dir():
            modules.append(str(nm))
            b = nm / ".bin"
            if b.is_dir():
                bins.append(str(b))
        for pkg in repo_map.get("packages", []):
            d = pkg.get("dir")
            if not d or d == ".":
                continue
            pnm = root / d / "node_modules"
            if pnm.is_dir():
                modules.append(str(pnm))
                b = pnm / ".bin"
                if b.is_dir():
                    bins.append(str(b))
    current_path = os.environ.get("PATH", "")
    if bins:
        env["PATH"] = os.pathsep.join(dict.fromkeys(bins)) + os.pathsep + current_path
    if modules:
        prior = os.environ.get("NODE_PATH", "")
        env["NODE_PATH"] = os.pathsep.join(dict.fromkeys(modules + ([prior] if prior else [])))
    return env


def readiness_probe(url, timeout_seconds):
    deadline = time.monotonic() + timeout_seconds
    last = None
    print(f"[V2 preflight] Model readiness: {url}")
    while True:
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=3) as resp:
                code = getattr(resp, "status", 200)
                if 200 <= code < 300:
                    print("[V2 preflight] Model: READY")
                    return {"status": "READY", "httpStatus": code}
                last = f"HTTP {code}"
        except urllib.error.HTTPError as exc:
            if exc.code in {401, 403}:
                print(f"[V2 preflight] Model endpoint reachable (HTTP {exc.code}); auth delegated to engineer")
                return {"status": "REACHABLE_AUTH", "httpStatus": exc.code}
            last = f"HTTP {exc.code}"
        except Exception as exc:
            last = f"{type(exc).__name__}: {exc}"
        if time.monotonic() >= deadline:
            raise V2Error(f"Model readiness failed after {timeout_seconds}s: {last}")
        time.sleep(2)


def classify_raw_result(returncode, output, timed_out=False):
    if timed_out:
        return "TIMEOUT"
    if returncode == 0:
        return "PASS"
    low = output.lower()
    infra_markers = (
        "command not found", "executable not found", "no such file or directory",
        "npm err! enoent", "could not determine executable to run",
    )
    if returncode == 127 or any(x in low for x in infra_markers):
        return "INFRA_BLOCKED"
    return "CODE_FAIL"


def normalize_output(text, workspace=None):
    text = text.replace("\r\n", "\n")
    if workspace:
        text = text.replace(str(workspace), "<WS>")
    text = re.sub(r"\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds)\b", "<TIME>", text, flags=re.I)
    text = re.sub(r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b", "<TIMESTAMP>", text)
    return "\n".join(line.rstrip() for line in text.splitlines() if line.strip())


def error_signatures(text, workspace=None):
    norm = normalize_output(text, workspace)
    sigs = set()
    for raw in norm.splitlines():
        line = raw.strip()
        low = line.lower()
        interesting = (
            "error ts" in low or re.search(r"\berror\b", low) or
            low.startswith("fail ") or low.startswith("failed ") or
            "assertionerror" in low or "typeerror" in low
        )
        if not interesting:
            continue
        line = re.sub(r":\d+:\d+", ":<LOC>", line)
        line = re.sub(r"\(\d+,\d+\)", "(<LOC>)", line)
        line = re.sub(r"\s+", " ", line)
        sigs.add(line)
    return sigs


def run_verifier_command(ws, cmd, timeout, env):
    label = shlex.join(cmd)
    started = time.monotonic()
    try:
        p = run(cmd, ws, check=False, timeout=timeout, env=env)
        output = ((p.stdout or "") + (p.stderr or ""))[-24000:]
        status_name = classify_raw_result(p.returncode, output)
        low = output.lower()
        if (status_name == "CODE_FAIL" and not (ws / "node_modules").exists() and
                ("cannot find module" in low or "error ts2307" in low or "module_not_found" in low)):
            status_name = "INFRA_BLOCKED"
        return {
            "command": label,
            "returncode": p.returncode,
            "status": status_name,
            "ok": status_name == "PASS",
            "elapsedSeconds": round(time.monotonic() - started, 2),
            "outputTail": output,
        }
    except subprocess.TimeoutExpired:
        return {
            "command": label, "returncode": None, "status": "TIMEOUT", "ok": False,
            "timeout": True, "elapsedSeconds": round(time.monotonic() - started, 2),
            "outputTail": "",
        }


def baseline_accepts(current, baseline, current_ws, baseline_ws):
    if current["status"] != "CODE_FAIL":
        return False, set(), set()
    if baseline["status"] in {"INFRA_BLOCKED", "TIMEOUT"}:
        return False, set(), set()
    if baseline["status"] == "PASS":
        return False, set(), set()
    cur_sigs = error_signatures(current.get("outputTail", ""), current_ws)
    base_sigs = error_signatures(baseline.get("outputTail", ""), baseline_ws)
    if cur_sigs and base_sigs and cur_sigs.issubset(base_sigs):
        return True, cur_sigs, base_sigs
    cur_norm = normalize_output(current.get("outputTail", ""), current_ws)
    base_norm = normalize_output(baseline.get("outputTail", ""), baseline_ws)
    if cur_norm and cur_norm == base_norm:
        return True, cur_sigs, base_sigs
    return False, cur_sigs, base_sigs


def add_baseline_worktree(ws, baseline, session):
    target = session / "baseline-worktree"
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    run(["git", "worktree", "add", "--detach", str(target), baseline], ws)
    return target


def remove_baseline_worktree(ws, target):
    if not target:
        return
    run(["git", "worktree", "remove", "--force", str(target)], ws, check=False)
    shutil.rmtree(target, ignore_errors=True)


def verify(ws, commands, timeout, session, iteration, repo_map, source_root, baseline, toolchain_mode="path",
           events_path=None, session_id=None):
    current_bridges = []
    if toolchain_mode == "linked":
        _, current_bridges = prepare_toolchain_bridges(ws, repo_map)
    env = verifier_env(ws, repo_map, source_root, toolchain_mode)
    results = []
    baseline_ws = None
    baseline_bridges = []
    baseline_env = None
    try:
        for i, cmd in enumerate(commands, 1):
            label = shlex.join(cmd)
            print(f"\n[V2 verify {iteration}.{i}] {label}")
            if events_path is not None:
                emit_event(events_path, "verification_started", session_id, command=label)
            result = run_verifier_command(ws, cmd, timeout, env)
            # C4: the visual check is classified by its own severity model
            # (V7 §22.5), not the generic text-pattern classifier, and is
            # deliberately excluded from the baseline-worktree comparison
            # below -- re-running a live browser capture against a detached
            # baseline commit doesn't observe anything meaningful (the
            # running app under test isn't rebuilt per git worktree).
            is_visual = is_visual_check_command(cmd)
            if is_visual:
                result = classify_visual_check_result(result, session)

            if result["status"] == "CODE_FAIL" and not is_visual:
                if baseline_ws is None:
                    baseline_ws = add_baseline_worktree(ws, baseline, session)
                    baseline_map = build_repo_map(baseline_ws)
                    baseline_source = common_repo_root(baseline_ws)
                    if toolchain_mode == "linked":
                        _, baseline_bridges = prepare_toolchain_bridges(baseline_ws, baseline_map)
                    baseline_env = verifier_env(baseline_ws, baseline_map, baseline_source, toolchain_mode)
                baseline_result = run_verifier_command(baseline_ws, cmd, timeout, baseline_env)
                accepted, cur_sigs, base_sigs = baseline_accepts(result, baseline_result, ws, baseline_ws)
                result["baseline"] = {
                    "returncode": baseline_result.get("returncode"),
                    "status": baseline_result.get("status"),
                    "outputTail": baseline_result.get("outputTail", "")[-16000:],
                }
                if accepted:
                    result["status"] = "PASS_BASELINE"
                    result["ok"] = True
                    result["baselineAccepted"] = True
                    result["currentErrorSignatures"] = sorted(cur_sigs)
                    result["baselineErrorSignatures"] = sorted(base_sigs)
                    result["newErrorSignatures"] = []
                else:
                    result["newErrorSignatures"] = sorted(cur_sigs - base_sigs) if cur_sigs else []

            results.append(result)
            (session / f"verify-{iteration:02d}-{i:02d}.json").write_text(
                json.dumps(result, indent=2), encoding="utf-8"
            )
            if events_path is not None:
                emit_event(events_path, "verification_completed", session_id, check=label,
                           status=result["status"], baselineAware=bool(result.get("baseline")))
            if result["status"] == "PASS":
                print("PASS")
            elif result["status"] == "PASS_BASELINE":
                print("PASS (baseline-aware: no new failures)")
            else:
                print(result["status"])

            if not result.get("ok"):
                if result.get("outputTail"):
                    print(result["outputTail"][-5000:])
                return False, results
        return True, results
    finally:
        cleanup_toolchain_bridges(current_bridges)
        cleanup_toolchain_bridges(baseline_bridges)
        remove_baseline_worktree(ws, baseline_ws)


def failure_text(results):
    for r in results:
        if not r.get("ok"):
            extra = ""
            if r.get("newErrorSignatures"):
                extra = "\nNew error signatures:\n" + "\n".join(r["newErrorSignatures"][:50])
            return (
                f"Command: {r['command']}\nStatus: {r.get('status')}\n"
                f"Return code: {r.get('returncode')}\nTimeout: {r.get('timeout', False)}\n"
                f"Output:\n{r.get('outputTail', '')[-12000:]}{extra}"
            )
    return "Unknown verification failure"


def checkpoint(ws, n):
    run(["git", "add", "-A"], ws)
    p = run([
        "git", "-c", "user.name=Muse Glimmer v2.1", "-c", "user.email=glimmer-v2@localhost",
        "commit", "--no-gpg-sign", "-m", f"glimmer-v2 checkpoint {n}"
    ], ws, check=False)
    if p.returncode != 0:
        raise V2Error(((p.stdout or "") + (p.stderr or ""))[-8000:])
    return head(ws)


def collapse(ws, baseline):
    if head(ws) != baseline:
        run(["git", "reset", "--mixed", baseline], ws)


def recover_interrupted_checkpoint(ws):
    if not commit_subject(ws).startswith("glimmer-v2 checkpoint "):
        return None
    if status(ws):
        raise V2Error("Interrupted Glimmer checkpoint detected, but worktree is dirty; refusing automatic recovery")
    checkpoint_head = head(ws)
    candidate = checkpoint_head
    depth = 0
    while commit_subject(ws, candidate).startswith("glimmer-v2 checkpoint "):
        parent = git(ws, "rev-parse", f"{candidate}^")
        candidate = parent
        depth += 1
        if depth > 10:
            raise V2Error("Checkpoint recovery exceeded 10 ancestors; refusing")
    run(["git", "reset", "--mixed", candidate], ws)
    return {
        "checkpointHead": checkpoint_head,
        "recoveredBaseline": candidate,
        "preservedChangedFiles": changed_files(ws, candidate),
    }


def _contract_scope_text(contract):
    """Shared by make_prompt and make_architect_prompt (C1) so the
    human-readable SCOPE line can't drift between the two prompts built
    from the same contract."""
    scope = contract["scope"]
    scope_bits = [f"package={scope['package']}"]
    if scope.get("area"):
        scope_bits.append(f"area={scope['area']}")
    if scope.get("paths"):
        scope_bits.append(f"paths={scope['paths']}")
    return ", ".join(scope_bits)


def make_architect_prompt(contract, summary):
    """C1 (glimmer-v7): the "task" text handed to `glimmer-engineer.py
    --mode architect` — NOT make_prompt's full engineering OPERATING
    CONTRACT (that prose is write-loop-specific: freeze rules, diff/
    validation instructions, none of which apply to a read-only planning
    run). Architect mode's own system prompt (glimmer-engineer.py's
    ARCHITECT_SYSTEM_PROMPT) already carries the permissions/output-shape
    instructions; this is just the objective + contract + repo map it
    needs to plan against.
    """
    return textwrap.dedent(f"""
    TASK CONTRACT (authoritative — sole source of scope/mode/constraints for this task):
    {json.dumps(contract)}

    USER TASK:
    {contract["objective"]}

    MODE: {contract['mode']}
    SCOPE: {_contract_scope_text(contract)}

    TRUSTED REPOSITORY MAP:
    {summary}
    """).strip()



# C1 handoff enforcement (Fix 1, V7 spec Section 5.4): "Engineer should
# receive... selected repository evidence." candidateFiles[].path is MODEL
# OUTPUT (the architect model wrote the plan) -- v2 (the trusted layer) is
# about to open() paths a model chose, so every one is treated as hostile.
# Caps bound how much of a possibly-adversarial plan gets embedded.
PLAN_EVIDENCE_MAX_FILES = 5
PLAN_EVIDENCE_MAX_FILE_CHARS = 16 * 1024
PLAN_EVIDENCE_MAX_TOTAL_CHARS = 48 * 1024


def _resolve_candidate_path(raw_path, ws_resolved):
    """Containment check for one candidateFiles[].path, reimplementing
    glimmer-engineer.py's resolve_workspace_path pattern (resolve, then
    require relative_to the workspace to succeed) -- reimplemented here
    rather than imported since v2.py and glimmer-engineer.py share no
    module. Returns the resolved Path only when it stays strictly inside
    ws_resolved AFTER resolution (symlink-safe: Path.resolve() follows
    symlinks, and the containment check runs on that post-resolve path,
    so a symlink pointing outside the workspace is caught here same as
    a literal ../ escape or an absolute path elsewhere). None on any
    rejection or malformed input -- never raises.
    """
    try:
        p = Path(raw_path).expanduser()
    except TypeError:
        return None
    if not p.is_absolute():
        p = ws_resolved / p
    try:
        resolved = p.resolve(strict=False)
    except (OSError, RuntimeError):
        return None
    try:
        resolved.relative_to(ws_resolved)
    except ValueError:
        return None
    return resolved


def _collect_plan_evidence_targets(plan):
    """Merge candidateFiles + existingPatterns[].evidence into ONE ordered
    list of {"path", "confidence", "kind"} dicts feeding the single
    evidence-reading pipeline in read_candidate_evidence -- candidateFiles
    first (they're the primary targets), then existingPatterns evidence in
    original order. Both fields are model output; every entry returned
    here is still unvalidated/untrusted input -- the real security/cap
    work happens in read_candidate_evidence's loop, not here.

    Follow-up (large-repo experiment): for create-new-file tasks the
    plan's only candidateFiles entry is often the NEW target path, which
    doesn't exist yet and can't be pre-read -- zero evidence embedded,
    budget never drops. existingPatterns[].evidence (V7 Section 5.3:
    [{"name": ..., "evidence": ["path/to/file.ts"]}]) usually points at
    real, existing convention files instead -- exactly what a create-task
    engineer needs, so it's folded into the same merged list, tagged
    "pattern" purely for prompt labeling (see make_prompt).
    """
    targets = []

    candidates = plan.get("candidateFiles")
    if isinstance(candidates, list):
        for c in candidates:
            if isinstance(c, dict) and isinstance(c.get("path"), str) and c["path"].strip():
                targets.append({"path": c["path"], "confidence": c.get("confidence"), "kind": "candidate"})

    patterns = plan.get("existingPatterns")
    if isinstance(patterns, list):
        for pat in patterns:
            if not isinstance(pat, dict):
                continue
            pat_evidence = pat.get("evidence")
            if not isinstance(pat_evidence, list):
                continue
            for path in pat_evidence:
                if isinstance(path, str) and path.strip():
                    targets.append({"path": path, "confidence": None, "kind": "pattern"})

    return targets


def read_candidate_evidence(plan, ws):
    """C1 handoff enforcement (Fix 1): pre-read the architect plan's
    candidateFiles AND existingPatterns[].evidence directly from disk --
    deterministic, zero model cost -- so the engineer doesn't have to
    re-discover them itself (see _collect_plan_evidence_targets for why
    both fields feed this). See PLAN_EVIDENCE_MAX_* and
    _resolve_candidate_path's docstrings for the security/cap contract.
    Every rejection (containment, non-file, unreadable, binary, non-utf8,
    duplicate) is skipped with a one-line printed note; this function
    itself never raises and never includes rejected content. Returns []
    uniformly whenever there's nothing usable to embed (no plan, no
    candidateFiles/existingPatterns, nothing resolves) -- callers never
    need to special-case "no evidence".

    Selection: entries with a numeric "confidence" (candidateFiles only)
    sort first (highest confidence first, per V7 Section 5.3's example
    shape); entries without one keep their original relative order after
    those (sorted() is stable) -- which naturally preserves "candidateFiles
    first, then existingPatterns evidence in order" for the common
    no-confidence case. At most PLAN_EVIDENCE_MAX_FILES are read, same
    caps and same pipeline regardless of which field a path came from.
    """
    if not plan:
        return []

    usable = _collect_plan_evidence_targets(plan)
    if not usable:
        return []

    def _confidence_key(c):
        conf = c.get("confidence")
        has_conf = isinstance(conf, (int, float)) and not isinstance(conf, bool)
        return (0 if has_conf else 1, -conf if has_conf else 0)

    usable.sort(key=_confidence_key)

    ws_resolved = Path(ws).resolve()
    evidence = []
    total_chars = 0
    seen = set()

    for entry in usable:
        if len(evidence) >= PLAN_EVIDENCE_MAX_FILES:
            break
        if total_chars >= PLAN_EVIDENCE_MAX_TOTAL_CHARS:
            break

        raw_path = entry["path"]
        resolved = _resolve_candidate_path(raw_path, ws_resolved)
        if resolved is None:
            print(f"[V2] evidence handoff: skipped candidate file outside workspace: {raw_path!r}")
            continue
        # Dedup on the resolved real path -- the same file listed under
        # multiple spellings (e.g. "src/greet.js" and "sub/../src/greet.js")
        # must not consume two of the five cap slots with duplicate content.
        if resolved in seen:
            print(f"[V2] evidence handoff: skipped duplicate candidate (already embedded): {raw_path!r}")
            continue
        if not resolved.is_file():
            print(f"[V2] evidence handoff: skipped non-file candidate: {raw_path!r}")
            continue

        try:
            raw_bytes = resolved.read_bytes()
        except OSError as exc:
            print(f"[V2] evidence handoff: skipped unreadable candidate {raw_path!r}: {exc}")
            continue

        if b"\x00" in raw_bytes:
            print(f"[V2] evidence handoff: skipped binary candidate: {raw_path!r}")
            continue
        try:
            text = raw_bytes.decode("utf-8")
        except UnicodeDecodeError:
            print(f"[V2] evidence handoff: skipped non-utf8 candidate: {raw_path!r}")
            continue

        truncated = False
        if len(text) > PLAN_EVIDENCE_MAX_FILE_CHARS:
            text = text[:PLAN_EVIDENCE_MAX_FILE_CHARS]
            truncated = True
        remaining_budget = PLAN_EVIDENCE_MAX_TOTAL_CHARS - total_chars
        if len(text) > remaining_budget:
            text = text[:max(remaining_budget, 0)]
            truncated = True
        if truncated:
            text += "\n\n[candidate file truncated by v2 evidence handoff]"

        rel_path = resolved.relative_to(ws_resolved).as_posix()
        evidence.append({"path": rel_path, "content": text, "kind": entry.get("kind", "candidate")})
        total_chars += len(text)
        seen.add(resolved)

    return evidence


def make_prompt(contract, summary, iteration, failure=None, checkpoint_sha=None, plan=None, evidence=None):
    # R2: the contract dict (same shape as manifest["contract"]) is the sole
    # source of truth for scope/mode/constraints — derive the human-readable
    # OPERATING CONTRACT lines below FROM it rather than maintaining separate
    # hardcoded prose that can drift out of sync with the CLI flags.
    #
    # C1 (glimmer-v7): `plan` is the ArchitecturePlan dict loaded from
    # architecture-plan.json (V7 §5.4 handoff, scoped down per the C1 task
    # entry to just these fields — no skills/allowed-tools/scope-constraint
    # systems, those don't exist here). Only ever non-None when the caller
    # passed --architect-first AND the architect run produced a usable
    # (non-planningFailed) plan; every other invocation shape is unaffected.
    task = contract["objective"]
    constraints = contract["constraints"]
    scope_text = _contract_scope_text(contract)

    constraint_lines = []
    if constraints.get("minimalChange"):
        constraint_lines.append("Make the smallest complete implementation; do not modify unrelated files.")
    banned = []
    if constraints.get("noCommit"):
        banned.append("commit")
    if constraints.get("noPush"):
        banned.append("push")
    if constraints.get("noDeploy"):
        banned.append("deploy")
    if constraints.get("noDependencyInstall"):
        banned.append("install packages")
    if banned:
        constraint_lines.append(f"Do not {', '.join(banned)}, change Git configuration.")
    constraint_text = "\n".join(f"    - {line}" for line in constraint_lines)

    repair = ""
    if iteration:
        repair = f"""
AUTHORITATIVE V2 VERIFICATION FAILURE:
{failure}

PREVIOUS LOCAL-ONLY CHECKPOINT:
{checkpoint_sha}

Repair only failures introduced by this task. Preserve correct prior work and pre-existing baseline failures.
"""

    # C1 (glimmer-v7): appended AFTER the existing template's .strip() below
    # (not interpolated into the dedent block) so that plan=None/{} produces
    # a prompt string that is byte-for-byte IDENTICAL to make_prompt's
    # pre-C1 output — no --architect-first, no observable change at all.
    # Only implementationPlan/constraints/candidateFiles/verificationPlan
    # are threaded through, per the C1 task's scoped-down §5.4 handoff
    # (not skills/allowed-tools/scope-constraints — those systems don't
    # exist here).
    plan_block = ""
    if plan:
        plan_fields = {
            key: plan.get(key, [])
            for key in (
                "implementationPlan",
                "constraints",
                "candidateFiles",
                "verificationPlan",
            )
        }
        plan_block = (
            "\n\nARCHITECTURE PLAN (from --architect-first Architect mode; "
            "a hint from prior read-only exploration, not a substitute for "
            "your own verification — if evidence contradicts it, deviate "
            "and say why):\n"
            + json.dumps(plan_fields, indent=2)
        )
        # C1 handoff enforcement (Fix 1, V7 spec Section 5.4; follow-up:
        # existingPatterns[].evidence): candidateFiles + existingPatterns
        # evidence pre-read directly from disk by v2 (the trusted layer),
        # zero model cost — appended as its own labeled block so the
        # engineer knows these are already read and does not need to spend
        # discovery calls re-reading them. Each entry is labeled by kind so
        # the model treats CANDIDATE FILE entries as likely edit targets and
        # PATTERN EVIDENCE entries as existing conventions to follow, not
        # files to modify. Only present when read_candidate_evidence
        # actually embedded something; plan_block above is otherwise
        # unaffected.
        if evidence:
            def _evidence_header(item):
                if item.get("kind") == "pattern":
                    return f"--- PATTERN EVIDENCE (existing convention to follow, not a file to modify): {item['path']} ---"
                return f"--- CANDIDATE FILE: {item['path']} ---"

            evidence_text = "\n\n".join(
                f"{_evidence_header(item)}\n{item['content']}" for item in evidence
            )
            plan_block += (
                "\n\nPRE-READ PLAN EVIDENCE (read directly from disk by the "
                "v2 orchestrator before this run started, per the "
                "ARCHITECTURE PLAN above — these files do NOT need to be "
                "re-read; treat their contents below as current and "
                "accurate):\n"
                + evidence_text
            )

    return textwrap.dedent(f"""
    MUSE GLIMMER ENGINEERING MODE V2.1 — {'IMPLEMENT' if iteration == 0 else f'REPAIR {iteration}'}

    TASK CONTRACT (authoritative — sole source of scope/mode/constraints for this task):
    {json.dumps(contract)}

    USER TASK:
    {task}

    MODE: {contract['mode']}
    SCOPE: {scope_text}

    TRUSTED REPOSITORY MAP:
    {summary}

    {repair}

    OPERATING CONTRACT:
    - Work only inside this isolated Glimmer worktree.
    - Inspect only files/symbols needed for this task.
    - Reuse existing architecture only when it is genuinely applicable.
{constraint_text}
    - Do NOT run broad/full typecheck, lint, full test suite, or full build.
      The trusted v2.1 wrapper runs authoritative post-edit verification.
    - Narrow diagnostic commands are allowed when needed.
    - Inspect the exact diff before finishing.
    - If the task cannot safely be completed, do not make speculative changes.
    """).strip() + plan_block


def invoke_engineer(engineer, ws, prompt, auto_approve, max_turns, log_path, events_path, session_id, mode=None,
                     plan_candidate_count=0, review_request=None):
    cmd = [str(engineer), "--workspace", str(ws)]
    if mode is not None:
        # C1 (glimmer-v7): mode="architect" is the only caller that ever
        # sets this — reuses this same spawn shape (same env plumbing,
        # same stdout/log tee) instead of a second subprocess helper.
        cmd += ["--mode", mode]
    if review_request is not None:
        # C2 (glimmer-v7): only ever set alongside mode="architect" —
        # switches that SAME read-only invocation from planning to
        # reviewing an implementation (glimmer-engineer.py's run_architect
        # branches on this flag's presence). No new mode string, so every
        # existing architect read-only guard still applies unchanged.
        cmd += ["--review-request", str(review_request)]
    if max_turns is not None:
        cmd += ["--max-turns", str(max_turns)]
    # Architect mode has no approval path (C1 scoping): it runs unattended
    # with no interactive stdin, so it must always get --yes regardless of
    # what the caller's own --auto-approve flag says.
    if auto_approve or mode == "architect":
        cmd.append("--yes")
    cmd.append(prompt)
    label = "glimmer-engineer.py" if mode is None else f"glimmer-engineer.py --mode {mode}"
    print(f"\n[V2] Launching existing {label}...")
    env = os.environ.copy()
    env["GLIMMER_EVENTS_PATH"] = str(events_path)
    env["GLIMMER_SESSION_ID"] = session_id
    # C1 handoff enforcement (Fix 2): same spawn-env plumbing as the two
    # lines above, signaling the engineer that a real (non-empty)
    # evidence handoff happened for this run so its discovery budget can
    # become plan-aware. Only ever set when plan_candidate_count > 0 —
    # the architect run itself (mode="architect") never passes this, so
    # its own budget/turns are untouched (C1 task scoping).
    if plan_candidate_count > 0:
        env["GLIMMER_PLAN_CANDIDATES"] = str(plan_candidate_count)
    with log_path.open("w", encoding="utf-8") as log:
        p = subprocess.Popen(cmd, cwd=str(ws), text=True, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, env=env, bufsize=1)
        assert p.stdout is not None
        for line in p.stdout:
            sys.stdout.write(line)
            log.write(line)
        return p.wait()


def load_architecture_plan(session_dir):
    """C1 (glimmer-v7): load architecture-plan.json from the session dir
    (same convention glimmer-engineer.py's _architecture_plan_file_path
    writes to — the parent of GLIMMER_EVENTS_PATH, which IS session_dir
    from this side). Returns the parsed dict when it's a usable plan, or
    None uniformly for every degraded case: file missing, unreadable,
    not valid JSON, not a JSON object, or explicitly marked
    planningFailed. Callers never need to distinguish these cases —
    None always means "proceed without a plan, exactly as if
    --architect-first had never been passed."
    """
    path = Path(session_dir) / "architecture-plan.json"

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

    if not isinstance(data, dict) or data.get("planningFailed"):
        return None

    return data


def architect_plan_manifest_record(plan):
    """C1 fix round 1 (Important finding): a small, real record of whether
    the architect step did anything useful for this session — the
    measurable signal the reconciliation doc's C1 entry requires before
    this could ever run automatically. `plan` is whatever run_
    architect_first returned (already None on any failure per load_
    architecture_plan's contract), so "used" is literally "was a plan
    actually threaded into make_prompt for this session."
    """
    return {
        "used": plan is not None,
        "risk": plan.get("risk") if plan else None,
    }


def run_architect_first(engineer, ws, contract, summary, session, events_path, sid):
    """C1 (glimmer-v7): opt-in-only pre-step, invoked from main() ONLY when
    --architect-first was explicitly passed. Spawns glimmer-engineer.py
    --mode architect BEFORE iteration 0, then reads back architecture-
    plan.json. Must never raise: an architect failure (crash, timeout,
    invalid output) degrades to "no plan" and the caller proceeds with
    the main run exactly as if this had never run — see load_
    architecture_plan's uniform None-on-any-failure contract above.

    Fix round 1 (Minor finding): everything that can raise now lives
    inside the try — this function's own docstring promises "must never
    raise," and the prompt file write was previously outside the try
    block, contradicting that.

    Fix round 1 (Minor finding, turn budget): no max_turns parameter —
    v2.py's own --max-turns is meant for the ENGINEERING run and is not
    threaded through to the architect subprocess at all, so architect
    mode always gets glimmer-engineer.py's own smaller mode-aware
    default (ARCHITECT_MAX_TURNS_DEFAULT, currently 12) regardless of
    what --max-turns the caller set for the real run. If a future need
    arises to independently tune architect's budget from v2.py, add a
    separate --architect-max-turns flag then.
    """
    print("\n" + "=" * 72)
    print(" [V2] --architect-first: running Architect mode before iteration 0")
    print("=" * 72)

    try:
        architect_prompt = make_architect_prompt(contract, summary)
        (session / "architect-prompt.txt").write_text(architect_prompt, encoding="utf-8")

        rc = invoke_engineer(
            engineer, ws, architect_prompt,
            True,  # auto_approve is forced regardless inside invoke_engineer for mode="architect"
            None,  # let glimmer-engineer.py's own architect-mode default apply, see docstring
            session / "architect.log",
            events_path, sid,
            mode="architect",
        )
        print(f"[V2] Architect subprocess exited with code {rc}")
    except Exception as exc:  # noqa: BLE001 - architect failure must never block the real run
        print(f"[V2] WARN: architect subprocess failed to run: {exc}")

    # Deliberately OUTSIDE the try above: load_architecture_plan already
    # degrades to None internally on any read/parse failure (see its own
    # docstring), so it's always safe to call regardless of whether the
    # subprocess spawn itself raised — including the edge case where the
    # architect subprocess completed and wrote a valid plan file but
    # invoke_engineer's own Python-side stdout streaming then raised.
    plan = load_architecture_plan(session)

    if plan is not None:
        print(f"[V2] Architect plan loaded: risk={plan.get('risk')!r}, packages={plan.get('packages')!r}")
    else:
        print("[V2] Architect produced no usable plan (missing/invalid/failed); proceeding without it.")

    return plan


# ============================================================
# C2 (glimmer-v7): Architect consultation + review budget — V7 §§5.6-5.13
# ============================================================
#
# Only ever active when --architect-first produced a usable plan
# (architecture_plan is not None in main() — that itself only happens
# when --architect-first was passed, see run_architect_first above): the
# review compares implementation against the plan, so with no plan there
# is nothing to review against and this entire feature is a no-op.
#
# Loop structure (documented once here, referenced from main()): the
# review sits BEFORE verify() inside each outer repair-loop iteration
# (V7 §5.9's "ENGINEER -> ARCHITECT REVIEW -> VERIFIER" ordering). A
# REVISE_IMPLEMENTATION decision triggers exactly ONE bounded revise
# round — a direct invoke_engineer() call, never routed through the
# outer `for iteration in range(args.max_repairs+1)` loop — so it can
# never advance `iteration`, create a checkpoint, or consume
# --max-repairs. The two budgets (ARCHITECT_REVIEW_BUDGET for review
# rounds, --max-repairs for verify()-driven repair rounds) are
# independent counters that never touch each other's state.

# V7 §5.13: "Architect reviews need a budget... do not let agents debate
# indefinitely." Shared across the WHOLE session (every outer iteration),
# not per-iteration — see manifest["architectReviews"].
ARCHITECT_REVIEW_BUDGET = 3

# Same order of magnitude as PLAN_EVIDENCE_MAX_TOTAL_CHARS above — bounds
# how much of a (potentially large) diff gets embedded in the review
# request/prompt, purely a token-budget cap (the diff text itself is
# v2-computed, not model output, so this isn't a security boundary like
# PLAN_EVIDENCE_MAX_* is).
ARCHITECT_REVIEW_DIFF_MAX_CHARS = 48 * 1024

# Mirrors glimmer-engineer.py's ARCHITECT_REVIEW_DECISIONS. v2 is the
# trusted layer and this decision string drives whether verify() runs at
# all, so it re-checks the enum itself rather than blindly trusting that
# glimmer-engineer.py's own validate_architect_review already did —
# defense in depth on a safety-relevant branch, same spirit as C1's
# read_candidate_evidence treating model output as untrusted.
ARCHITECT_REVIEW_DECISIONS = {
    "APPROVED",
    "APPROVED_WITH_CONDITIONS",
    "REVISE_IMPLEMENTATION",
    "REPLAN_REQUIRED",
    "HUMAN_REVIEW_REQUIRED",
}


def make_review_request(plan, files, change_types, diff_text, iteration, review_round):
    """C2: the review-request payload v2 (trusted layer) writes to disk
    for the architect-review subprocess to read directly (glimmer-
    engineer.py's _load_review_request) — V7 §5.6's shape, scoped down
    per the C2 task entry to what a pre-verification review actually
    needs: the plan it's checking against, the real changed-files list,
    and the real diff (git_diff_text — same underlying git plumbing as
    diff_hash/file_change_types, not a new discovery pass).
    """
    return {
        "type": "architect_review_request",
        "iteration": iteration,
        "reviewRound": review_round,
        "architecturePlan": plan,
        "changedFiles": [
            {"path": f, "changeType": change_types.get(f, "modified")} for f in files
        ],
        "diff": diff_text,
    }


def load_architect_review(session_dir, iteration, review_round):
    """C2: load architect-review-NN-MM.json, mirroring load_architecture_
    plan's uniform-None-on-any-degraded-case contract — file missing,
    unreadable, not valid JSON, not an object, explicitly marked
    reviewFailed, or carrying a decision outside the 5-value enum all
    return None uniformly. Callers never need to distinguish these
    cases: None always means "this review did not produce a usable
    result," which main()'s loop treats as fail-open (proceed exactly as
    if no review had run).
    """
    path = Path(session_dir) / f"architect-review-{iteration:02d}-{review_round:02d}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("reviewFailed"):
        return None
    if data.get("decision") not in ARCHITECT_REVIEW_DECISIONS:
        return None

    normalized = {"decision": data["decision"], "confidence": data.get("confidence")}
    for field in ("findings", "requiredChanges", "constraints", "verificationAdjustments"):
        value = data.get(field, [])
        normalized[field] = value if isinstance(value, list) else []
    return normalized


def classify_architect_review_decision(decision):
    """Maps one ArchitectReview decision (V7 §5.7) to what main()'s
    review sub-loop does next. Pure/deterministic — exercised directly
    by --architect-review-selfcheck without a live model or session."""
    if decision in ("APPROVED", "APPROVED_WITH_CONDITIONS"):
        return "approved"
    if decision == "REVISE_IMPLEMENTATION":
        return "revise"
    if decision in ("REPLAN_REQUIRED", "HUMAN_REVIEW_REQUIRED"):
        return "rejected"
    return "rejected"  # unrecognized decision must never silently proceed to verify()


def architect_gates_value(outcome):
    """Maps the review sub-loop's terminal outcome to gates.
    architectureApproved (True/False/None) per the C2 gates contract:
    True on approved, False on rejected/budget-exhausted, None when the
    review never ran or failed open."""
    if outcome == "approved":
        return True
    if outcome in ("rejected", "budget_exhausted"):
        return False
    return None  # outcome is None (never ran) or "fail_open"


def architect_review_failure_text(review):
    """C2: format an ArchitectReview's requiredChanges + findings into
    the SAME "failure text" shape make_prompt's repair branch already
    expects (failure_text(results), built for verify() failures) — a
    REVISE_IMPLEMENTATION round is a repair round driven by architect
    judgment instead of a failing verification command, so it reuses
    that exact prompt slot rather than inventing a second one."""
    out = []
    if review.get("requiredChanges"):
        out.append("Architect-required changes:")
        out.extend(f"  - {c}" for c in review["requiredChanges"])
    if review.get("findings"):
        out.append("Architect findings:")
        out.extend(f"  - {c}" for c in review["findings"])
    if not out:
        out.append("Architect review returned REVISE_IMPLEMENTATION with no specific findings/requiredChanges.")
    return "\n".join(out)


def run_architect_review(engineer, ws, plan, files, change_types, baseline, session, events_path, sid,
                          iteration, review_round):
    """C2 (glimmer-v7): pre-verification architect review (V7 §5.9),
    invoked from main()'s per-iteration loop only when a plan exists.
    Reuses invoke_engineer's SAME mode="architect" spawn path as C1's
    planning step (glimmer-engineer.py's read-only enforcement —
    ARCHITECT_TOOL_NAMES, the execute_tool hard-block, architect_shell_
    policy — all key off mode == "architect"; --review-request only
    changes what the architect subprocess DOES inside that same mode,
    never widens what it's allowed to touch — see
    _architect_review_selfcheck on the engineer side). Must never raise:
    any failure (spawn error, missing/invalid output) degrades to None,
    identical in meaning to "review never happened" — see load_
    architect_review's uniform degradation contract.
    """
    print("\n" + "=" * 72)
    print(f" [V2] Architect review (iteration={iteration}, round={review_round})")
    print("=" * 72)

    diff_text = git_diff_text(ws, baseline)
    if len(diff_text) > ARCHITECT_REVIEW_DIFF_MAX_CHARS:
        diff_text = diff_text[:ARCHITECT_REVIEW_DIFF_MAX_CHARS] + "\n\n[diff truncated by v2 review-request builder]"

    request = make_review_request(plan, files, change_types, diff_text, iteration, review_round)
    request_path = session / f"review-request-{iteration:02d}-{review_round:02d}.json"

    try:
        request_path.write_text(json.dumps(request, indent=2), encoding="utf-8")

        rc = invoke_engineer(
            engineer, ws,
            "Perform the pre-verification architect review described in --review-request.",
            True,  # auto_approve forced regardless, same as run_architect_first
            None,  # architect mode's own smaller default turn budget applies
            session / f"architect-review-{iteration:02d}-{review_round:02d}.log",
            events_path, sid, mode="architect", review_request=request_path,
        )
        print(f"[V2] Architect review subprocess exited with code {rc}")
    except Exception as exc:  # noqa: BLE001 - review failure must never block the run
        print(f"[V2] WARN: architect review subprocess failed to run: {exc}")

    return load_architect_review(session, iteration, review_round)


# ============================================================
# C3 (glimmer-v7): Task Graph (tasks.json) — "Task Planning & Live Task
# List" chapter; reconciliation doc C3 entry.
# ============================================================
#
# Only ever active when --architect-first produced a usable plan
# (architecture_plan is not None in main(), same gate as C2's gates/
# architectReviews just above) — with no plan there is nothing to
# derive tasks from, so tasks stays None and no tasks.json is ever
# written (zero behavior change, same opt-in discipline as C1/C2).
#
# Flat list, sequential dependsOn only — deliberately NOT the chapter's
# DAG/priority/source/evidenceIds/blockingReason model. The
# reconciliation doc's own critique (§15) names this the item most
# likely to be over-built and says to keep it flat-with-dependsOn
# "until a real session needs a diamond." This ships exactly that: one
# task per implementationPlan step (sequential chain) and one task per
# verificationPlan entry (each depending on the last implementation
# task), nothing else.
#
# Honest scale-downs (documented here, not just in the report):
#   - Per-step implementation granularity is not evidencable: ONE
#     engineer subprocess run executes the WHOLE implementationPlan in
#     one shot, so all implementation tasks transition together, by
#     the same evidence (changed-files set + engineer return code),
#     not one at a time.
#   - No per-task prompt injection: the C1 handoff already injects the
#     full implementationPlan into the engineer prompt, and there is no
#     per-task execution loop to point a single active task at. tasks
#     .json is a session ARTIFACT for humans/the control center to
#     observe later, not a prompt input, in this pass.
#   - No dynamic task creation, no discovery/architecture_review/
#     visual_verification/repair/approval/follow_up kinds, no
#     priority/required-vs-optional semantics, no session-completion
#     gate wired to task status. Those all stay out per the C3 scope.


def derive_tasks(plan: dict) -> list:
    """C3: derive the flat task list from plan["implementationPlan"] +
    plan["verificationPlan"] (V7's structured-task-model fields, scoped
    down to id/description/kind/dependsOn/status per the C3 task
    entry). Sequential dependsOn chain within implementation tasks
    (t2 depends on t1, etc.); every verification task depends on the
    LAST implementation task (or has no dependency when there were no
    implementation steps at all). ids are simple/stable: t1, t2, ... in
    derivation order (implementation first, then verification).
    Never raises: `plan` is already a validated dict by the time this
    is called (load_architecture_plan's contract guarantees that), and
    missing/non-list implementationPlan/verificationPlan fields degrade
    to [] rather than erroring."""
    tasks = []
    impl_steps = plan.get("implementationPlan")
    if not isinstance(impl_steps, list):
        impl_steps = []
    verify_steps = plan.get("verificationPlan")
    if not isinstance(verify_steps, list):
        verify_steps = []

    prev_id = None
    for step in impl_steps:
        tid = f"t{len(tasks) + 1}"
        tasks.append({
            "id": tid,
            "description": str(step),
            "kind": "implementation",
            "dependsOn": [prev_id] if prev_id else [],
            "status": "pending",
        })
        prev_id = tid

    last_impl_id = prev_id
    for step in verify_steps:
        tid = f"t{len(tasks) + 1}"
        tasks.append({
            "id": tid,
            "description": str(step),
            "kind": "verification",
            "dependsOn": [last_impl_id] if last_impl_id else [],
            "status": "pending",
        })
    return tasks


def save_tasks(session_dir, tasks) -> None:
    """C3: full-file rewrite at every transition point (spawn, engineer-
    return, post-verify) — tasks.json is small, so a full rewrite is
    simplest and cheapest. Never raises: same never-crash-the-session
    discipline as C1/C6 — a disk write failure here (permissions, full
    disk) must degrade to a log line, never take down an otherwise-
    successful engineering session."""
    try:
        (Path(session_dir) / "tasks.json").write_text(
            json.dumps(tasks, indent=2), encoding="utf-8")
    except OSError as exc:
        print(f"[V2] WARN: failed to write tasks.json: {exc}")


def set_implementation_tasks_status(tasks, status: str) -> None:
    """C3: flip every kind=='implementation' task to `status`, in place.
    Called at each engineer spawn (-> in_progress) — including the C2
    revise-round re-spawn, which re-invokes the engineer directly
    outside the outer repair loop: implementation tasks go back to
    in_progress for that re-spawn and are re-evaluated after it
    returns, exactly like the main spawn/return pair. No-op when
    `tasks` is None (no plan, C3 inactive)."""
    if tasks is None:
        return
    for t in tasks:
        if t.get("kind") == "implementation":
            t["status"] = status


def evaluate_implementation_tasks(tasks, files: list, engineer_rc) -> None:
    """C3: the ONLY evidence source for implementation task status —
    never a model claim. Per-step granularity is not honestly
    evidencable (one engineer run executes every implementationPlan
    step at once), so the whole implementation group is marked
    together, by the same evidence: complete iff the session's changed-
    files set is non-empty AND the engineer subprocess exited 0;
    failed otherwise (engineer errored, or ran and touched nothing).
    No-op when `tasks` is None."""
    if tasks is None:
        return
    outcome = "complete" if (files and engineer_rc == 0) else "failed"
    set_implementation_tasks_status(tasks, outcome)


# Tokens of 3+ alnum chars — long enough to skip noise, short enough to
# still match single-word plan entries like "lint".
_TASK_VERIFY_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _match_verify_result(description: str, results: list):
    """C3: substring match, case-insensitive, documented here per the
    task brief — a verificationPlan entry naming e.g. "typecheck" (or
    "frontend_typecheck") maps to a real verify() command containing
    "typecheck" (e.g. "npm --prefix frontend run typecheck"). Both
    sides are tokenized on non-alphanumeric characters (tokens >= 3
    chars, to skip stopword-length noise) and compared as whole-word
    tokens (set intersection), NOT raw substring-of-string containment
    — a naive `tok in cmd_string` check lets a short token like "check"
    (from e.g. "nonexistent_check") spuriously match inside the
    unrelated word "typecheck"; matching whole command tokens avoids
    that false positive while still satisfying "contains typecheck"
    for the real case, since "typecheck" is itself a whole token in
    both the plan entry and the npm command. Returns the first matching
    result dict, or None when nothing in `results` matches — callers
    must leave the task `pending` in that case, never fabricate
    completion."""
    tokens = {t for t in _TASK_VERIFY_TOKEN_RE.findall(description.lower()) if len(t) >= 3}
    if not tokens:
        return None
    for r in results:
        cmd = (r.get("command") or "").lower()
        cmd_tokens = set(_TASK_VERIFY_TOKEN_RE.findall(cmd))
        if tokens & cmd_tokens:
            return r
    return None


def evaluate_verification_tasks(tasks, results: list) -> None:
    """C3: map each verification task to a real verify() result where a
    deterministic mapping exists (see _match_verify_result). Matched ->
    complete on PASS/PASS_BASELINE, failed on CODE_FAIL. Unmatched
    entries (the plan named a check verify() never ran) stay `pending`
    — HONEST, never fabricate completion. INFRA_BLOCKED/TIMEOUT matches
    also stay `pending` (the check never really ran to a pass/fail
    verdict). No-op when `tasks` is None."""
    if tasks is None:
        return
    for t in tasks:
        if t.get("kind") != "verification":
            continue
        match = _match_verify_result(t["description"], results)
        if match is None:
            continue  # plan named a check that never ran -- stays pending
        status_name = match.get("status")
        if status_name in ("PASS", "PASS_BASELINE"):
            t["status"] = "complete"
        elif status_name == "CODE_FAIL":
            t["status"] = "failed"
        # INFRA_BLOCKED / TIMEOUT / anything else: leave pending -- the
        # check never really produced a pass/fail verdict.


def main():
    ap = argparse.ArgumentParser(description="Muse Glimmer Engineering Mode v2.1")
    ap.add_argument("task", nargs="+")
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--engineer", default=str(ENGINEER_DEFAULT))
    ap.add_argument("--max-repairs", type=int, default=2)
    ap.add_argument("--verification-level", choices=("minimal", "standard", "full"), default="standard")
    ap.add_argument("--verify", action="append", default=[])
    # C4 (glimmer-v7): only consulted when the literal token "visual" is
    # among --verify entries (see expand_verify_entries). No default (fix
    # round 1) -- validate_visual_url fails loudly below if "visual" is
    # opted into without an explicit URL, rather than silently guessing
    # http://localhost:3000 and possibly capturing the wrong app.
    ap.add_argument("--visual-url", default=None,
                    help="URL Playwright navigates to for the visual verification check. "
                         "Required when \"visual\" is one of the --verify entries; ignored otherwise.")
    ap.add_argument("--timeout", type=int, default=1200)
    ap.add_argument("--max-turns", type=int)
    # Task Contract fields (glimmer-v7 R2). Choices mirror @glimmer/shared's real
    # TaskContract union types (control-center/shared/src/types.ts) field-for-field
    # so the manifest["contract"] this CLI produces is interchangeable with the
    # contract the control-center composer builds via buildTaskContract.ts.
    ap.add_argument("--scope-package", choices=("repository", "frontend", "backend", "directory", "files"),
                    default="repository", help="Contract scope.package: what category of the repo this task is scoped to")
    ap.add_argument("--scope-area", default=None, help="Contract scope.area: sub-path within the package this task is scoped to")
    ap.add_argument("--scope-paths", action="append", default=None,
                    help="Contract scope.paths: explicit file path this task is scoped to (repeatable)")
    ap.add_argument("--mode", choices=("inspect", "plan", "implement", "debug", "test", "review"),
                    default="implement", help="Contract mode: the kind of work this task performs")
    ap.add_argument("--auto-approve", action="store_true")
    ap.add_argument("--repo-map-only", action="store_true")
    ap.add_argument("--allow-non-glimmer-branch", action="store_true")
    ap.add_argument("--allow-upstream", action="store_true")
    ap.add_argument("--skip-model-readiness", action="store_true")
    ap.add_argument("--model-readiness-url", default=READINESS_URL_DEFAULT)
    ap.add_argument("--readiness-timeout", type=int, default=180)
    ap.add_argument("--toolchain-mode", choices=("path", "linked", "none"), default="path",
                    help="path=reuse source tool binaries via env (safe default); linked=temporary ignored node_modules symlinks during trusted verification only; none=no source toolchain reuse")
    # C1 (glimmer-v7): opt-in only, default False. Never auto-triggered by
    # risk or anything else — TaskContract has no risk field today (risk is
    # computed post-run, client-side, in a separate TS project), so there is
    # nothing to gate an automatic invocation on. A human/caller must pass
    # this explicitly. Every existing invocation (this flag omitted) takes
    # the exact same code path as before this change.
    ap.add_argument("--architect-first", action="store_true",
                    help="Run glimmer-engineer.py --mode architect before iteration 0 and feed its "
                         "ArchitecturePlan into the engineering prompt. Off by default; never auto-triggered.")
    args = ap.parse_args()

    ws = Path(args.workspace).expanduser().resolve()
    engineer = Path(args.engineer).expanduser().resolve()
    task = " ".join(args.task).strip()

    if not ws.is_dir():
        raise V2Error(f"Workspace missing: {ws}")
    if git(ws, "rev-parse", "--is-inside-work-tree", check=False) != "true":
        raise V2Error(f"Not a Git worktree: {ws}")
    if not args.repo_map_only and not engineer.is_file():
        raise V2Error(f"Existing engineer missing: {engineer}")
    if args.max_repairs < 0 or args.max_repairs > 5:
        raise V2Error("--max-repairs must be 0..5")
    validate_visual_url(args.verify, args.visual_url)

    recovery = recover_interrupted_checkpoint(ws)
    if recovery:
        print("=" * 72)
        print(" GLIMMER V2.1: INTERRUPTED CHECKPOINT RECOVERED")
        print("=" * 72)
        print(f"Checkpoint HEAD:    {recovery['checkpointHead']}")
        print(f"Recovered baseline: {recovery['recoveredBaseline']}")
        print("Changes preserved as UNCOMMITTED diff for review.")
        for f in recovery["preservedChangedFiles"]:
            print(f"  - {f}")
        raise V2Error("Recovery completed safely. Review/reset the preserved diff, then rerun v2.1")

    b, baseline, up, dirty = branch(ws), head(ws), upstream(ws), status(ws)
    if dirty:
        raise V2Error("V2.1 requires clean start:\n" + "\n".join(dirty[:100]))
    if not args.allow_non_glimmer_branch and not b.startswith("glimmer/"):
        raise V2Error(f"Refusing non-glimmer branch: {b}")
    if up and not args.allow_upstream:
        raise V2Error(f"Refusing branch with upstream: {up}")

    STATE_ROOT.mkdir(parents=True, exist_ok=True)
    sid = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    session = STATE_ROOT / f"{sid}-{b.replace('/', '-')}"
    session.mkdir()
    events_path = session / "events.jsonl"

    repo = build_repo_map(ws)
    (session / "repo-map.json").write_text(json.dumps(repo, indent=2), encoding="utf-8")
    summary = repo_summary(repo)

    # Task Contract (glimmer-v7 R2): one source of truth for scope/mode/constraints,
    # shared verbatim (field-for-field with @glimmer/shared TaskContract) between
    # manifest.json and the prompt built below, instead of separately-maintained
    # prose. noCommit/noPush/noDeploy/noDependencyInstall are project-wide hard
    # constraints, never configurable via CLI flags.
    # scope.area/scope.paths/maxTurns are `?:` (optional), not nullable, in
    # @glimmer/shared's real TaskContract shape — omit the keys entirely
    # when unset instead of writing an explicit null, to stay assignable
    # under strictNullChecks.
    scope = {"package": args.scope_package}
    if args.scope_area is not None:
        scope["area"] = args.scope_area
    if args.scope_paths is not None:
        scope["paths"] = args.scope_paths

    contract = {
        "objective": task,
        "scope": scope,
        "mode": args.mode,
        "constraints": {
            "minimalChange": True,
            "noCommit": True,
            "noPush": True,
            "noDeploy": True,
            "noDependencyInstall": True,
        },
        "verification": args.verify,
        "repairBudget": args.max_repairs,
    }
    if args.max_turns is not None:
        contract["maxTurns"] = args.max_turns

    manifest = {
        "version": "2.1", "sessionId": sid, "workspace": str(ws), "branch": b,
        "baseline": baseline, "task": task, "maxRepairs": args.max_repairs,
        "verificationLevel": args.verification_level, "attempts": [], "status": "initialized",
        "state": canonical_session_state("initialized"),
        "eventsFile": "events.jsonl", "contract": contract,
    }
    manifest_path = session / "manifest.json"

    def save():
        manifest["updatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    save()
    # session_created isn't a real EVENT_TYPES variant; agent_state_changed is
    # the closest real type. state= is now the canonical GlimmerSessionStatus
    # value (R3) — manifest["state"] mirrors what "initialized" maps to.
    emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])

    print("=" * 72)
    print(" MUSE GLIMMER ENGINEERING MODE V2.1")
    print("=" * 72)
    print(f"Workspace:     {ws}")
    print(f"Branch:        {b}")
    print(f"Baseline:      {baseline}")
    print(f"Repair budget: {args.max_repairs}")
    print(f"Repo map:      {session / 'repo-map.json'}")
    print("Push:          BLOCKED BY DESIGN")
    print("Deploy:        BLOCKED BY DESIGN")

    if args.repo_map_only:
        print("\n" + summary)
        manifest["status"] = "repo-map-only"
        manifest["state"] = canonical_session_state(manifest["status"])
        emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
        save()
        return 0

    source_root = common_repo_root(ws)
    manifest["toolchain"] = {
        "sourceRepository": str(source_root),
        "mode": args.toolchain_mode,
        "note": "linked mode creates temporary ignored node_modules symlinks only while trusted verifier commands run" if args.toolchain_mode == "linked" else None,
    }
    print(f"[V2 preflight] Toolchain source: {source_root}")
    print(f"[V2 preflight] Toolchain mode:   {args.toolchain_mode}")
    save()

    success, failure, checkpoint_sha = False, None, None
    final_label = "NOT VERIFIED"
    try:
        if not args.skip_model_readiness:
            manifest["modelReadiness"] = readiness_probe(args.model_readiness_url, args.readiness_timeout)
            save()
        else:
            manifest["modelReadiness"] = {"status": "SKIPPED"}
            save()

        # C1 (glimmer-v7): opt-in only (--architect-first), runs once before
        # iteration 0. architecture_plan stays None (identical to never
        # having passed the flag) whenever it's skipped, or the architect
        # run fails/times out/produces invalid JSON — see
        # run_architect_first/load_architecture_plan's uniform-None
        # degradation contract. manifest["architectPlan"] is only ever
        # added when --architect-first was actually passed (fix round 1,
        # Important finding: without this, there's no way to measure
        # architect-mode activity/usefulness separately from the main
        # run — the reconciliation doc requires shipping C1 "behind a
        # measured gate" before it runs automatically).
        architecture_plan = None
        # C1 handoff enforcement (Fix 1): computed once, deterministically,
        # from disk — not re-read per repair iteration. [] whenever there's
        # nothing to embed (no plan, no candidateFiles, nothing resolves),
        # so plan_candidate_count below is 0 and the prompt/env are
        # unaffected in every degraded case.
        candidate_evidence = []
        # C3: tasks stays None (no tasks.json ever written) in every
        # degraded case, same uniform-None-on-no-plan contract as
        # architecture_plan/candidate_evidence just above.
        tasks = None
        if args.architect_first:
            architecture_plan = run_architect_first(
                engineer, ws, contract, summary, session, events_path, sid,
            )
            manifest["architectPlan"] = architect_plan_manifest_record(architecture_plan)
            candidate_evidence = read_candidate_evidence(architecture_plan, ws)
            # C2: gates/architectReviews are only ever added to the
            # manifest when a usable plan exists — with no plan there is
            # nothing to review against, so C2 never runs and these keys
            # would otherwise be pure clutter on a --architect-first run
            # that didn't even get a usable plan (mirrors architectPlan's
            # own architect_first-only gating just above).
            if architecture_plan is not None:
                manifest["gates"] = {"architectureApproved": None}
                manifest["architectReviews"] = {"max": ARCHITECT_REVIEW_BUDGET, "used": 0}
                # C3: same gate as the two lines above -- tasks derive from
                # the plan's implementationPlan/verificationPlan only when
                # a usable plan exists. manifest["tasksFile"] mirrors the
                # existing "eventsFile" precedent (a plain filename inside
                # the session dir, no schema change beyond that one key).
                tasks = derive_tasks(architecture_plan)
                manifest["tasksFile"] = "tasks.json"
                save_tasks(session, tasks)
            save()

        for iteration in range(args.max_repairs + 1):
            if iteration > 0:
                emit_event(events_path, "repair_started", sid, iteration=iteration)
            prompt = make_prompt(contract, summary, iteration, failure, checkpoint_sha,
                                 plan=architecture_plan, evidence=candidate_evidence)
            (session / f"prompt-{iteration:02d}.txt").write_text(prompt, encoding="utf-8")
            # C3: spawn -- deterministic evidence point 1/3. The engineer
            # subprocess is about to execute the whole implementationPlan
            # in one run (no per-task pointer, see the C3 module docstring
            # above), so every implementation task flips together.
            if tasks is not None:
                set_implementation_tasks_status(tasks, "in_progress")
                save_tasks(session, tasks)
            rc = invoke_engineer(engineer, ws, prompt, args.auto_approve, args.max_turns,
                                 session / f"engineer-{iteration:02d}.log", events_path, sid,
                                 plan_candidate_count=len(candidate_evidence))
            files = changed_files(ws, baseline)
            change_types = file_change_types(ws, baseline)
            for f in files:
                emit_event(events_path, "file_changed", sid, path=f,
                           changeType=change_types.get(f, "modified"))
            # C3: engineer-return -- deterministic evidence point 2/3.
            if tasks is not None:
                evaluate_implementation_tasks(tasks, files, rc)
                save_tasks(session, tasks)
            attempt = {"iteration": iteration, "engineerReturnCode": rc,
                       "changedFiles": files, "diffHashBeforeVerify": diff_hash(ws, baseline)}

            # R4 Scope Guard: classify (does not block yet — staged rollout,
            # see compute_scope_guard's docstring and task-6a-report.md).
            scope_result = compute_scope_guard(files, manifest.get("contract", {}))
            attempt["scopeGuard"] = scope_result
            if scope_result["expandedFiles"]:
                print(f"[V2] WARN: scope guard — {len(scope_result['expandedFiles'])} changed "
                      f"file(s) outside expected scope {scope_result['expected']}: {scope_result['expandedFiles']}")
                emit_event(events_path, "scope_expanded", sid,
                           expected=scope_result["expected"], actual=scope_result["actual"])
            elif scope_result.get("unbounded"):
                print("[V2] WARN: scope guard — scope.package="
                      f"{manifest['contract']['scope'].get('package')!r} claims a bounded scope but no "
                      "area/paths were given; cannot verify (unbounded)")

            if not files:
                commands = [["git", "diff", "--check"]]
                commands = expand_verify_entries(commands, args.verify, session, args.visual_url)
                if args.verify:
                    ok, results = verify(ws, commands, args.timeout, session, iteration,
                                         repo, source_root, baseline, args.toolchain_mode,
                                         events_path, sid)
                    attempt["verificationCommands"] = [shlex.join(c) for c in commands]
                    attempt["verificationResults"] = results
                    # C3: post-verify -- deterministic evidence point 3/3,
                    # applies here too so tasks.json stays honest even on
                    # the no-changed-files path.
                    if tasks is not None:
                        evaluate_verification_tasks(tasks, results)
                        save_tasks(session, tasks)
                    if ok:
                        attempt["status"] = "no-change-verified"
                        manifest["attempts"].append(attempt)
                        manifest["status"] = "no-change-verified"
                        manifest["state"] = canonical_session_state(manifest["status"])
                        emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
                        success = True
                        final_label = "NO CHANGE REQUIRED — VERIFIED"
                        save()
                        break
                attempt["status"] = "no-change-unverified"
                manifest["attempts"].append(attempt)
                manifest["status"] = "no-change-unverified"
                manifest["state"] = canonical_session_state(manifest["status"])
                emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
                save()
                break

            print("\n[V2] Changed files:")
            for f in files:
                print(f"  - {f}")

            # C2 (glimmer-v7): pre-verification architect review (V7 §5.9)
            # -- ONLY when --architect-first produced a usable plan
            # (architecture_plan is not None; see the C2 module-docstring
            # block above run_architect_review for the full loop-structure
            # rationale). Sits strictly BEFORE verify(). A REVISE_
            # IMPLEMENTATION round re-invokes the engineer directly, never
            # through the outer `for iteration` loop, so it can never
            # advance `iteration` or consume --max-repairs.
            if architecture_plan is not None:
                review_round = 0
                architect_outcome = None
                while True:
                    if manifest["architectReviews"]["used"] >= ARCHITECT_REVIEW_BUDGET:
                        architect_outcome = "budget_exhausted"
                        break
                    review_round += 1
                    manifest["architectReviews"]["used"] += 1
                    save()
                    emit_event(events_path, "agent_state_changed", sid, state="architect_review")
                    review = run_architect_review(
                        engineer, ws, architecture_plan, files, change_types, baseline,
                        session, events_path, sid, iteration, review_round,
                    )
                    attempt.setdefault("architectReviews", []).append(
                        {"round": review_round, "review": review}
                    )
                    if review is None:
                        print("[V2] Architect review produced no usable output; "
                              "failing open (proceeding as if no review had run).")
                        architect_outcome = "fail_open"
                        break

                    decision_outcome = classify_architect_review_decision(review["decision"])
                    if decision_outcome in ("approved", "rejected"):
                        architect_outcome = decision_outcome
                        break

                    # decision_outcome == "revise": ONE bounded revise round
                    # (repair-style prompt via make_prompt's existing repair
                    # branch, architect's requiredChanges/findings standing
                    # in for a verification failure), then loop back for
                    # another review — budget permitting.
                    if manifest["architectReviews"]["used"] >= ARCHITECT_REVIEW_BUDGET:
                        architect_outcome = "budget_exhausted"
                        break
                    print(f"[V2] Architect review requested REVISE_IMPLEMENTATION "
                          f"(iteration={iteration}, round={review_round}); running one bounded revise pass.")
                    revise_prompt = make_prompt(
                        contract, summary, review_round,
                        failure=architect_review_failure_text(review),
                        checkpoint_sha=None, plan=architecture_plan, evidence=candidate_evidence,
                    )
                    (session / f"architect-revise-{iteration:02d}-{review_round:02d}.txt").write_text(
                        revise_prompt, encoding="utf-8")
                    # C3: a REVISE_IMPLEMENTATION round re-invokes the
                    # engineer directly (outside the outer repair loop) --
                    # implementation tasks go back to in_progress for this
                    # re-spawn and are re-evaluated after it returns,
                    # exactly like the main spawn/return pair above.
                    if tasks is not None:
                        set_implementation_tasks_status(tasks, "in_progress")
                        save_tasks(session, tasks)
                    revise_rc = invoke_engineer(
                        engineer, ws, revise_prompt, args.auto_approve, args.max_turns,
                        session / f"architect-revise-{iteration:02d}-{review_round:02d}.log",
                        events_path, sid, plan_candidate_count=len(candidate_evidence),
                    )
                    files = changed_files(ws, baseline)
                    change_types = file_change_types(ws, baseline)
                    for f in files:
                        emit_event(events_path, "file_changed", sid, path=f,
                                   changeType=change_types.get(f, "modified"))
                    if tasks is not None:
                        evaluate_implementation_tasks(tasks, files, revise_rc)
                        save_tasks(session, tasks)
                    attempt["changedFiles"] = files
                    attempt["diffHashBeforeVerify"] = diff_hash(ws, baseline)
                    scope_result = compute_scope_guard(files, manifest.get("contract", {}))
                    attempt["scopeGuard"] = scope_result

                manifest["gates"] = {"architectureApproved": architect_gates_value(architect_outcome)}
                save()

                if architect_outcome in ("rejected", "budget_exhausted"):
                    # V7 §5.10: tests-pass + architect-rejects must never be
                    # promoted to "verified" -- stop the whole loop here,
                    # before verify() ever runs for this iteration.
                    attempt["status"] = "needs-architect-review"
                    manifest["attempts"].append(attempt)
                    manifest["status"] = "needs-architect-review"
                    manifest["state"] = canonical_session_state(manifest["status"])
                    emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
                    save()
                    final_label = "ARCHITECTURE REVIEW REQUIRED — NOT VERIFIED"
                    print(f"\n[V2] {architect_outcome}: architecture review gate blocks promotion to verified.")
                    break

            commands = verifier_commands(repo, files, args.verification_level)
            commands = expand_verify_entries(commands, args.verify, session, args.visual_url)
            attempt["verificationCommands"] = [shlex.join(c) for c in commands]

            before = diff_hash(ws, baseline)
            ok, results = verify(ws, commands, args.timeout, session, iteration,
                                 repo, source_root, baseline, args.toolchain_mode,
                                 events_path, sid)
            after = diff_hash(ws, baseline)
            attempt["verificationResults"] = results
            attempt["diffHashAfterVerify"] = after
            # C3: post-verify -- deterministic evidence point 3/3.
            if tasks is not None:
                evaluate_verification_tasks(tasks, results)
                save_tasks(session, tasks)
            if before != after:
                attempt["status"] = "verifier-mutated-repo"
                manifest["attempts"].append(attempt)
                manifest["status"] = "failed-verifier-mutated-repo"
                manifest["state"] = canonical_session_state(manifest["status"])
                emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
                save()
                raise V2Error("Verifier changed repository content; refusing to continue")

            if ok:
                attempt["status"] = "verified"
                manifest["attempts"].append(attempt)
                manifest["status"] = "verified"
                manifest["state"] = canonical_session_state(manifest["status"])
                emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
                save()
                success = True
                final_label = "VERIFIED"
                break

            attempt["status"] = "verification-failed"
            manifest["attempts"].append(attempt)
            failure = failure_text(results)
            save()

            failed_status = next((r.get("status") for r in results if not r.get("ok")), "CODE_FAIL")
            if failed_status in {"INFRA_BLOCKED", "TIMEOUT"}:
                manifest["status"] = f"blocked-{failed_status.lower()}"
                manifest["state"] = canonical_session_state(manifest["status"])
                emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
                save()
                print(f"\n[V2] {failed_status}: repair budget will NOT be consumed.")
                break

            if iteration >= args.max_repairs:
                manifest["status"] = "failed-repair-budget-exhausted"
                manifest["state"] = canonical_session_state(manifest["status"])
                emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
                save()
                break

            print("\n[V2] New code failure detected. Creating LOCAL-ONLY checkpoint...")
            checkpoint_sha = checkpoint(ws, iteration + 1)
            manifest["attempts"][-1]["checkpoint"] = checkpoint_sha
            save()
            print(f"[V2] checkpoint={checkpoint_sha}")
            print("[V2] No push. Starting controlled repair round.")
    except (V2Interrupted, KeyboardInterrupt):
        # R6: previously SIGTERM/Ctrl-C left manifest["status"] wherever the
        # last completed step set it (e.g. still "initialized" if killed
        # during the very first engineer invocation), silently misreporting a
        # cancelled session as an in-progress one forever — research for this
        # task confirmed no cancellation status was ever written. Record the
        # real terminal reason before `finally` collapses/saves, then
        # re-raise so __main__'s existing exit-130 handling is unchanged.
        manifest["status"] = "cancelled-sigterm"
        manifest["state"] = canonical_session_state(manifest["status"])
        emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
        raise
    finally:
        # I2: every exit path routes through this finally, including the
        # already-handled SIGTERM/KeyboardInterrupt path above (which sets a
        # real terminal status before falling through here) and the sibling
        # V2Error path — e.g. readiness_probe's `raise V2Error` when the
        # model server isn't reachable, or any other run()/orchestration
        # failure inside the try block above — which has no except clause of
        # its own and previously fell straight through with manifest["status"]
        # still stuck at its initial "initialized" value forever. If nothing
        # else set a real terminal status by the time we get here, record one
        # now, before state is recomputed/saved below.
        if manifest["status"] == "initialized":
            manifest["status"] = "failed-aborted"
            manifest["state"] = canonical_session_state(manifest["status"])
            emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
        collapse(ws, baseline)
        manifest["finalHead"] = head(ws)
        manifest["finalChangedFiles"] = changed_files(ws, baseline)
        manifest["checkpointsCollapsed"] = head(ws) == baseline
        manifest["finalDiffHash"] = diff_hash(ws, baseline)
        manifest["failure"] = classify_failure(manifest, read_session_events(events_path))
        save()
        # SessionCompletedEvent.status is typed GlimmerSessionStatus (R3): use
        # the canonical manifest["state"], not the raw manifest["status"].
        emit_event(events_path, "session_completed", sid, status=manifest["state"])

    print("\n" + "=" * 72)
    print(f" GLIMMER V2.1: {final_label}")
    print("=" * 72)
    print(f"HEAD restored to baseline: {head(ws) == baseline}")
    print(f"Manifest: {manifest_path}")
    print("Final changes are UNCOMMITTED for human review.")
    print("No push. No deploy.")
    final_check = run(["git", "diff", "--check"], ws, check=False)
    print(f"git diff --check: {'PASS' if final_check.returncode == 0 else 'FAIL'}")
    return 0 if success and final_check.returncode == 0 else 2


def _sigterm_handler(signum, frame):
    raise V2Interrupted(f"Received signal {signum}")


def _r6_selfcheck() -> None:
    """R6: exercises classify_failure branches the real archived sessions in
    ~/.muse-glimmer/sessions don't happen to hit on disk today (no
    TIMEOUT/CODE_FAIL/POLICY_BLOCK/SCOPE_FAILURE/PARSER_FAILURE/
    USER_CANCELLED terminal session exists there yet). Run with:
    python3 glimmer-v2.py --r6-selfcheck
    """
    assert classify_failure({"status": "verified"}, []) is None
    assert classify_failure({"status": "no-change-verified"}, []) is None
    assert classify_failure({"status": "repo-map-only"}, []) is None
    assert classify_failure({"status": "blocked-infra_blocked"}, [])["class"] == "INFRA_BLOCKED"
    assert classify_failure({"status": "blocked-timeout"}, [])["class"] == "TIMEOUT"
    assert classify_failure({"status": "failed-repair-budget-exhausted"}, [])["class"] == "CODE_FAIL"
    assert classify_failure({"status": "failed-verifier-mutated-repo"}, [])["class"] == "POLICY_BLOCK"
    assert classify_failure({"status": "cancelled-sigterm"}, [])["class"] == "USER_CANCELLED"
    # I2: the finally-block guard's terminal status for a V2Error (or any
    # other) exit that never got past "initialized" (e.g. readiness_probe
    # raising V2Error before any repair iteration) — must classify as
    # something more useful than UNKNOWN, and must NOT be swallowed by the
    # generic "failed-" prefix branches above it.
    assert classify_failure({"status": "failed-aborted"}, [])["class"] == "ORCHESTRATION_ABORTED"

    # A real, verified archived session can still carry tool_blocked events
    # (20260817-183716-glimmer-smoke-test-r1 has 2) — success must win
    # regardless of what advisory events fired along the way.
    blocked_evt = {"id": "e1", "type": "tool_blocked", "reason": "rm -rf blocked"}
    assert classify_failure({"status": "verified"}, [blocked_evt]) is None

    # A terminal status this function doesn't specifically recognize falls
    # through to event evidence when present...
    r = classify_failure({"status": "no-change-unverified"}, [blocked_evt])
    assert r == {"class": "POLICY_BLOCK", "detail": "rm -rf blocked", "evidenceIds": ["e1"]}

    scope_evt = {"id": "e2", "type": "scope_expanded", "expected": ["frontend"], "actual": ["backend/x.ts"]}
    r = classify_failure({"status": "no-change-unverified"}, [scope_evt])
    assert r["class"] == "SCOPE_FAILURE" and r["evidenceIds"] == ["e2"]

    parser_evts = [{"id": f"p{i}", "type": "parser_recovery", "attempt": i} for i in range(1, 3)]
    r = classify_failure({"status": "no-change-unverified"}, parser_evts)
    assert r["class"] == "PARSER_FAILURE" and r["evidenceIds"] == ["p1", "p2"]
    # ...but a single recovery is below threshold and stays UNKNOWN.
    assert classify_failure({"status": "no-change-unverified"}, parser_evts[:1])["class"] == "UNKNOWN"

    # Legacy raw status this function was never taught (real archived
    # "blocked-no-changes"), and no status at all — both degrade to
    # UNKNOWN, never raise.
    assert classify_failure({"status": "blocked-no-changes"}, [])["class"] == "UNKNOWN"
    assert classify_failure({}, [])["class"] == "UNKNOWN"

    # R6's new raw status maps to the same "cancelled" canonical bucket
    # repo-map-only already uses.
    assert canonical_session_state("cancelled-sigterm") == "cancelled"
    # I2: "failed-aborted" rides the existing generic "failed-" prefix match
    # in canonical_session_state (no new branch needed there).
    assert canonical_session_state("failed-aborted") == "failed"

    print("R6 classify_failure self-check: PASS")


def _repomap_cache_selfcheck() -> None:
    """C7: proves the cross-session repo-map cache actually short-circuits
    the real walk on a hit, and actually invalidates on both trigger
    conditions (new HEAD, changed lockfile). Uses a throwaway git repo plus a
    throwaway cache root (module-global swapped back in `finally`) so this
    never touches a real ~/.muse-glimmer/repo-maps. Run with:
    python3 glimmer-v2.py --repomap-cache-selfcheck
    """
    global REPO_MAP_CACHE_ROOT
    import tempfile as _tempfile

    real_root = REPO_MAP_CACHE_ROOT
    calls = {"n": 0}
    real_uncached = _build_repo_map_uncached

    def _counting_uncached(ws):
        calls["n"] += 1
        return real_uncached(ws)

    with _tempfile.TemporaryDirectory() as td, _tempfile.TemporaryDirectory() as cache_td:
        ws = Path(td)
        REPO_MAP_CACHE_ROOT = Path(cache_td) / "repo-maps"
        globals()["_build_repo_map_uncached"] = _counting_uncached
        try:
            run(["git", "init", "-q"], ws)
            run(["git", "config", "user.email", "test@example.com"], ws)
            run(["git", "config", "user.name", "Test"], ws)
            (ws / "package.json").write_text(json.dumps({"name": "x", "scripts": {"test": "vitest"}}), encoding="utf-8")
            (ws / "package-lock.json").write_text("{}", encoding="utf-8")
            run(["git", "add", "-A"], ws)
            run(["git", "commit", "-q", "-m", "init"], ws)
            sha1 = head(ws)

            # 1. Cache miss (nothing cached yet) -> real build runs, cache file written.
            m1 = build_repo_map(ws)
            assert calls["n"] == 1, "first call must hit the real walk"
            cache_file = REPO_MAP_CACHE_ROOT / f"{sha1}.json"
            assert cache_file.exists(), "cache miss must write the cache file"
            on_disk = json.loads(cache_file.read_text(encoding="utf-8"))
            assert on_disk["repoMap"] == m1
            assert "package-lock.json" in on_disk["lockfileState"]

            # 2. Cache hit (same HEAD, same lockfile mtimes) -> no re-walk.
            m2 = build_repo_map(ws)
            assert calls["n"] == 1, "cache hit must not re-run the real walk"
            assert m2 == m1

            # 3. Lockfile mtime change, same HEAD SHA -> invalidates, real walk reruns.
            lock_path = ws / "package-lock.json"
            old_mtime = lock_path.stat().st_mtime
            new_mtime = old_mtime + 5
            os.utime(lock_path, (new_mtime, new_mtime))
            assert head(ws) == sha1, "HEAD must be unchanged for this to test lockfile invalidation"
            m3 = build_repo_map(ws)
            assert calls["n"] == 2, "lockfile mtime change must force a real rebuild"
            # Same repo state -> same content, modulo the real walk's own
            # generatedAt timestamp (which legitimately differs per rebuild).
            assert {k: v for k, v in m3.items() if k != "generatedAt"} == \
                   {k: v for k, v in m1.items() if k != "generatedAt"}

            # 4. New HEAD -> new cache key, real walk reruns, old cache entry untouched.
            (ws / "README.md").write_text("x", encoding="utf-8")
            run(["git", "add", "-A"], ws)
            run(["git", "commit", "-q", "-m", "second"], ws)
            sha2 = head(ws)
            assert sha2 != sha1
            build_repo_map(ws)
            assert calls["n"] == 3, "new HEAD must force a real rebuild"
            assert (REPO_MAP_CACHE_ROOT / f"{sha2}.json").exists()
            assert cache_file.exists()  # sha1's entry is untouched, not deleted

            # 5. Corrupted cache file for current HEAD -> falls back to a real
            # rebuild instead of crashing.
            (REPO_MAP_CACHE_ROOT / f"{sha2}.json").write_text("not json{{{", encoding="utf-8")
            build_repo_map(ws)
            assert calls["n"] == 4, "corrupted cache must fall back to a real rebuild, not crash"
        finally:
            globals()["_build_repo_map_uncached"] = real_uncached
            REPO_MAP_CACHE_ROOT = real_root

    print("repo-map cache self-check: PASS")


def _architect_first_selfcheck() -> None:
    """C1 (glimmer-v7): proves (a) a valid architecture-plan.json's fields
    get threaded into make_prompt's output, and (b) a missing/invalid/
    planningFailed plan file produces make_prompt output BYTE-IDENTICAL to
    never having passed --architect-first at all (true no-op degradation).
    Run with: python3 glimmer-v2.py --architect-first-selfcheck
    """
    contract = {
        "objective": "restore a session after reload",
        "scope": {"package": "repository"},
        "mode": "implement",
        "constraints": {
            "minimalChange": True, "noCommit": True, "noPush": True,
            "noDeploy": True, "noDependencyInstall": True,
        },
        "verification": [],
        "repairBudget": 0,
    }
    summary = "repo summary text"

    baseline = make_prompt(contract, summary, 0)

    # plan=None (the default) and plan={} (falsy) must both be exactly the
    # pre-C1 output — no new line, no new whitespace, nothing.
    assert make_prompt(contract, summary, 0) == baseline
    assert make_prompt(contract, summary, 0, plan=None) == baseline
    assert make_prompt(contract, summary, 0, plan={}) == baseline

    with tempfile.TemporaryDirectory() as td:
        session_dir = Path(td)

        # Missing file entirely.
        assert load_architecture_plan(session_dir) is None
        assert make_prompt(contract, summary, 0, plan=load_architecture_plan(session_dir)) == baseline

        # Present but not valid JSON.
        plan_path = session_dir / "architecture-plan.json"
        plan_path.write_text("not json{{{", encoding="utf-8")
        assert load_architecture_plan(session_dir) is None

        # Present, valid JSON, but explicitly marked failed.
        plan_path.write_text(
            json.dumps({"planningFailed": True, "objective": "x", "packages": [], "risk": "medium"}),
            encoding="utf-8",
        )
        assert load_architecture_plan(session_dir) is None
        assert make_prompt(contract, summary, 0, plan=load_architecture_plan(session_dir)) == baseline

        # A genuinely valid plan.
        valid_plan = {
            "objective": "restore a session after reload",
            "packages": ["frontend"],
            "risk": "medium",
            "implementationPlan": ["inspect hydration path", "add restoration hook"],
            "constraints": ["reuse existing persistence mechanism"],
            "candidateFiles": [{"path": "a.ts", "reason": "owns init", "confidence": 0.9}],
            "verificationPlan": ["frontend_typecheck"],
        }
        plan_path.write_text(json.dumps(valid_plan), encoding="utf-8")

        loaded = load_architecture_plan(session_dir)
        assert loaded is not None
        assert loaded["risk"] == "medium"

        with_plan = make_prompt(contract, summary, 0, plan=loaded)
        assert with_plan != baseline
        # Plan block is strictly appended — the pre-C1 prefix is untouched.
        assert with_plan.startswith(baseline)
        assert "inspect hydration path" in with_plan
        assert "reuse existing persistence mechanism" in with_plan
        assert "a.ts" in with_plan
        assert "frontend_typecheck" in with_plan
        # Handoff is scoped down (per C1 task entry) to exactly these four
        # fields — no skills/allowed-tools/scope-constraint systems.
        assert '"objective"' not in with_plan[len(baseline):]

    # invoke_engineer's mode="architect" path always forces --yes,
    # regardless of the caller's own auto_approve — no interactive stdin
    # available to a subprocess spawned this way.
    import inspect
    assert inspect.signature(invoke_engineer).parameters["mode"].default is None

    # Fix round 1 (Minor finding): run_architect_first no longer accepts
    # a max_turns parameter at all — v2's own --max-turns (meant for the
    # ENGINEERING run) is never threaded through to the architect
    # subprocess, so it always gets glimmer-engineer.py's own smaller
    # architect-mode default regardless of what the real run's budget is.
    assert "max_turns" not in inspect.signature(run_architect_first).parameters

    # Fix round 1 (Important finding): the manifest record is a real,
    # small signal of whether the architect step did anything useful —
    # exactly the measured-gate signal the reconciliation doc requires.
    assert architect_plan_manifest_record(None) == {"used": False, "risk": None}
    assert architect_plan_manifest_record({"risk": "high", "objective": "x", "packages": []}) == {
        "used": True,
        "risk": "high",
    }

    # ------------------------------------------------------------
    # C1 handoff enforcement (Fix 1): evidence pre-read security/caps.
    # candidateFiles[].path is MODEL OUTPUT — treated as hostile.
    # ------------------------------------------------------------
    with tempfile.TemporaryDirectory() as td:
        ws_dir = Path(td) / "workspace"
        ws_dir.mkdir()
        outside_dir = Path(td) / "outside"
        outside_dir.mkdir()

        good_file = ws_dir / "src" / "greet.js"
        good_file.parent.mkdir(parents=True)
        good_file.write_text("function greet() {}\n", encoding="utf-8")

        secret_file = outside_dir / "secret.txt"
        secret_file.write_text("SHOULD NEVER BE EMBEDDED", encoding="utf-8")

        # A real symlink inside the workspace pointing outside it.
        escape_link = ws_dir / "escape_link.txt"
        escape_link.symlink_to(secret_file)

        # (a) Containment: traversal, absolute-outside, and symlink escape
        # are ALL skipped — never embedded, never crash.
        hostile_plan = {
            "candidateFiles": [
                {"path": "../../../etc/passwd", "confidence": 0.99},
                {"path": str(secret_file), "confidence": 0.98},
                {"path": "escape_link.txt", "confidence": 0.97},
                {"path": "src/greet.js", "confidence": 0.5},
            ]
        }
        evidence = read_candidate_evidence(hostile_plan, ws_dir)
        assert len(evidence) == 1
        assert evidence[0]["path"] == "src/greet.js"
        assert "SHOULD NEVER BE EMBEDDED" not in " ".join(e["content"] for e in evidence)

        # (b) Caps: >5 candidates -> only 5 read, highest-confidence first.
        many_dir = ws_dir / "many"
        many_dir.mkdir()
        for i in range(8):
            (many_dir / f"f{i}.txt").write_text(f"content {i}\n", encoding="utf-8")
        many_plan = {
            "candidateFiles": [
                {"path": f"many/f{i}.txt", "confidence": i / 10} for i in range(8)
            ]
        }
        many_evidence = read_candidate_evidence(many_plan, ws_dir)
        assert len(many_evidence) == PLAN_EVIDENCE_MAX_FILES == 5
        assert {e["path"] for e in many_evidence} == {
            "many/f7.txt", "many/f6.txt", "many/f5.txt", "many/f4.txt", "many/f3.txt",
        }

        # (b2) Dedup: same file under two spellings embeds it once and
        # leaves the freed slot for a genuinely distinct candidate.
        dedup_plan = {
            "candidateFiles": [
                {"path": "src/greet.js", "confidence": 0.9},
                {"path": "sub/../src/greet.js", "confidence": 0.8},
                {"path": "many/f0.txt", "confidence": 0.1},
            ]
        }
        dedup_evidence = read_candidate_evidence(dedup_plan, ws_dir)
        assert len(dedup_evidence) == 2
        assert sorted(e["path"] for e in dedup_evidence) == ["many/f0.txt", "src/greet.js"]

        # Oversized file -> truncated with an explicit marker.
        big_file = ws_dir / "big.txt"
        big_file.write_text("x" * (PLAN_EVIDENCE_MAX_FILE_CHARS * 2), encoding="utf-8")
        big_evidence = read_candidate_evidence({"candidateFiles": [{"path": "big.txt"}]}, ws_dir)
        assert len(big_evidence) == 1
        assert "[candidate file truncated by v2 evidence handoff]" in big_evidence[0]["content"]
        assert len(big_evidence[0]["content"]) <= PLAN_EVIDENCE_MAX_FILE_CHARS + len(
            "\n\n[candidate file truncated by v2 evidence handoff]"
        )

        # (c) Missing/binary files skipped without crash, never included.
        binary_file = ws_dir / "image.bin"
        binary_file.write_bytes(b"\x00\x01\x02not text")
        mixed_evidence = read_candidate_evidence({
            "candidateFiles": [
                {"path": "does/not/exist.txt"},
                {"path": "image.bin"},
                {"path": "src/greet.js"},
            ]
        }, ws_dir)
        assert len(mixed_evidence) == 1
        assert mixed_evidence[0]["path"] == "src/greet.js"

        # No candidateFiles / no plan at all -> [] uniformly.
        assert read_candidate_evidence({"risk": "low"}, ws_dir) == []
        assert read_candidate_evidence(None, ws_dir) == []
        assert read_candidate_evidence({}, ws_dir) == []

        # (d) make_prompt embeds real evidence in a clearly labeled block
        # appended after the plan block; evidence=[] adds nothing (the
        # "no plan" byte-identical contract extends to "plan present but
        # nothing embedded").
        real_plan = {
            "objective": "x", "packages": [], "risk": "low",
            "candidateFiles": [{"path": "src/greet.js", "confidence": 0.9}],
        }
        with_evidence = make_prompt(contract, summary, 0, plan=real_plan,
                                     evidence=read_candidate_evidence(real_plan, ws_dir))
        assert "PRE-READ PLAN EVIDENCE" in with_evidence
        assert "--- CANDIDATE FILE: src/greet.js ---" in with_evidence
        assert "function greet" in with_evidence
        no_evidence_prompt = make_prompt(contract, summary, 0, plan=real_plan, evidence=[])
        assert "PRE-READ PLAN EVIDENCE" not in no_evidence_prompt

        # ------------------------------------------------------------
        # Follow-up (large-repo experiment): existingPatterns[].evidence
        # feeds the SAME pipeline as candidateFiles -- create-task plans
        # whose only candidateFiles entry is a not-yet-existing target
        # still get real evidence embedded via existing convention files.
        # ------------------------------------------------------------
        pattern_file_a = ws_dir / "lib" / "lazyWithRetry.ts"
        pattern_file_a.parent.mkdir(parents=True)
        pattern_file_a.write_text("export function lazyWithRetry() {}\n", encoding="utf-8")
        pattern_file_b = ws_dir / "lib" / "errorMessages.ts"
        pattern_file_b.write_text("export const errorMessages = {};\n", encoding="utf-8")

        # Only candidateFiles entry is a target that doesn't exist yet;
        # existingPatterns evidence points at 2 real files -> both embedded.
        create_task_plan = {
            "candidateFiles": [{"path": "src/utils/shortDuration.ts", "confidence": 0.9}],
            "existingPatterns": [
                {"name": "lazy retry", "evidence": ["lib/lazyWithRetry.ts"]},
                {"name": "error messages", "evidence": ["lib/errorMessages.ts"]},
            ],
        }
        pattern_evidence = read_candidate_evidence(create_task_plan, ws_dir)
        assert len(pattern_evidence) == 2
        assert {e["path"] for e in pattern_evidence} == {"lib/lazyWithRetry.ts", "lib/errorMessages.ts"}
        assert all(e["kind"] == "pattern" for e in pattern_evidence)

        pattern_prompt = make_prompt(contract, summary, 0, plan=create_task_plan, evidence=pattern_evidence)
        assert "PATTERN EVIDENCE (existing convention to follow, not a file to modify): lib/lazyWithRetry.ts" in pattern_prompt
        assert "export function lazyWithRetry" in pattern_prompt

        # Hostile paths inside existingPatterns evidence are rejected the
        # same as candidateFiles' -- traversal and symlink escape here too.
        hostile_pattern_plan = {
            "candidateFiles": [],
            "existingPatterns": [
                {"name": "x", "evidence": ["../../../etc/passwd", "escape_link.txt", "lib/lazyWithRetry.ts"]},
            ],
        }
        hostile_pattern_evidence = read_candidate_evidence(hostile_pattern_plan, ws_dir)
        assert len(hostile_pattern_evidence) == 1
        assert hostile_pattern_evidence[0]["path"] == "lib/lazyWithRetry.ts"
        assert "SHOULD NEVER BE EMBEDDED" not in hostile_pattern_evidence[0]["content"]

        # Dedup across the merged list: same file named in both
        # candidateFiles and existingPatterns evidence -> embedded once.
        cross_dedup_plan = {
            "candidateFiles": [{"path": "lib/lazyWithRetry.ts", "confidence": 0.9}],
            "existingPatterns": [{"name": "x", "evidence": ["lib/lazyWithRetry.ts"]}],
        }
        cross_dedup_evidence = read_candidate_evidence(cross_dedup_plan, ws_dir)
        assert len(cross_dedup_evidence) == 1
        assert cross_dedup_evidence[0]["kind"] == "candidate", (
            "candidateFiles is merged first, so the surviving entry for a "
            "path listed in both must be the candidate copy, not the "
            "pattern-evidence duplicate"
        )

    # Fix 2's env-var plumbing signature: plan_candidate_count defaults to
    # 0 (no env var set) so every existing invoke_engineer call site that
    # never passes it — including run_architect_first's — is unaffected.
    assert "plan_candidate_count" in inspect.signature(invoke_engineer).parameters
    assert inspect.signature(invoke_engineer).parameters["plan_candidate_count"].default == 0

    print("architect-first self-check: PASS")


def _architect_review_selfcheck() -> None:
    """C2 (glimmer-v7): proves the pre-verification review's core
    invariants without a live model or a full main() run — decision
    routing, budget/gates mapping, fail-open on malformed/missing
    output, and the "no plan -> zero behavior change" contract.
    Run with: python3 glimmer-v2.py --architect-review-selfcheck
    """
    import inspect

    # ------------------------------------------------------------
    # 1. Decision routing (V7 §5.7) — pure, exercised without a session.
    # ------------------------------------------------------------
    assert classify_architect_review_decision("APPROVED") == "approved"
    assert classify_architect_review_decision("APPROVED_WITH_CONDITIONS") == "approved"
    assert classify_architect_review_decision("REVISE_IMPLEMENTATION") == "revise"
    assert classify_architect_review_decision("REPLAN_REQUIRED") == "rejected"
    assert classify_architect_review_decision("HUMAN_REVIEW_REQUIRED") == "rejected"
    assert classify_architect_review_decision("NOT_A_REAL_DECISION") == "rejected"  # never silently proceed

    # ------------------------------------------------------------
    # 2. gates.architectureApproved mapping (True/False/None).
    # ------------------------------------------------------------
    assert architect_gates_value("approved") is True
    assert architect_gates_value("rejected") is False
    assert architect_gates_value("budget_exhausted") is False
    assert architect_gates_value("fail_open") is None
    assert architect_gates_value(None) is None

    # ------------------------------------------------------------
    # 3. Terminal status maps to canonical "needs_review", session never
    #    promoted to "verified" (V7 §5.10).
    # ------------------------------------------------------------
    assert canonical_session_state("needs-architect-review") == "needs_review"
    failure = classify_failure({"status": "needs-architect-review"}, [])
    assert failure is not None and failure["class"] == "POLICY_BLOCK"

    # ------------------------------------------------------------
    # 4. make_review_request shape + architect_review_failure_text.
    # ------------------------------------------------------------
    plan = {"objective": "x", "packages": [], "risk": "low"}
    request = make_review_request(
        plan, ["a.ts", "b.ts"], {"a.ts": "modified", "b.ts": "added"},
        "diff text here", iteration=1, review_round=2,
    )
    assert request["type"] == "architect_review_request"
    assert request["iteration"] == 1 and request["reviewRound"] == 2
    assert request["architecturePlan"] == plan
    assert request["changedFiles"] == [
        {"path": "a.ts", "changeType": "modified"},
        {"path": "b.ts", "changeType": "added"},
    ]
    assert request["diff"] == "diff text here"

    revise_text = architect_review_failure_text({
        "requiredChanges": ["reuse existing store"],
        "findings": ["duplicate state introduced"],
    })
    assert "reuse existing store" in revise_text
    assert "duplicate state introduced" in revise_text
    assert architect_review_failure_text({}) != ""  # never empty, never raises

    # ------------------------------------------------------------
    # 5. load_architect_review: uniform None on every degraded case;
    #    real values pass through on a genuinely valid file.
    # ------------------------------------------------------------
    with tempfile.TemporaryDirectory() as td:
        session_dir = Path(td)

        # Missing file entirely.
        assert load_architect_review(session_dir, 0, 1) is None

        # Present but not valid JSON.
        bad_path = session_dir / "architect-review-00-01.json"
        bad_path.write_text("not json{{{", encoding="utf-8")
        assert load_architect_review(session_dir, 0, 1) is None

        # Present, valid JSON, but explicitly marked failed (fail-open).
        bad_path.write_text(
            json.dumps({"reviewFailed": True, "decision": "HUMAN_REVIEW_REQUIRED", "confidence": 0.0}),
            encoding="utf-8",
        )
        assert load_architect_review(session_dir, 0, 1) is None

        # Present, valid JSON, decision outside the 5-value enum (v2's
        # own defense-in-depth check, not just glimmer-engineer.py's).
        bad_decision_path = session_dir / "architect-review-00-02.json"
        bad_decision_path.write_text(
            json.dumps({"decision": "MAYBE", "confidence": 0.5}), encoding="utf-8",
        )
        assert load_architect_review(session_dir, 0, 2) is None

        # A genuinely valid review, correct NN-MM file naming.
        good_path = session_dir / "architect-review-01-02.json"
        good_path.write_text(
            json.dumps({
                "decision": "APPROVED_WITH_CONDITIONS",
                "confidence": 0.9,
                "constraints": ["do not move persistence into component state"],
            }),
            encoding="utf-8",
        )
        loaded = load_architect_review(session_dir, 1, 2)
        assert loaded is not None
        assert loaded["decision"] == "APPROVED_WITH_CONDITIONS"
        assert loaded["confidence"] == 0.9
        assert loaded["constraints"] == ["do not move persistence into component state"]
        assert loaded["findings"] == []  # arrays default empty

    # ------------------------------------------------------------
    # 6. git_diff_text: tracked modification AND untracked new file both
    #    show up (untracked files have no `git diff` entry by default —
    #    represented as a synthetic "new file" block instead).
    # ------------------------------------------------------------
    with tempfile.TemporaryDirectory() as td:
        ws = Path(td)
        run(["git", "init", "-q"], ws)
        run(["git", "config", "user.email", "test@example.com"], ws)
        run(["git", "config", "user.name", "Test"], ws)
        (ws / "a.txt").write_text("original\n", encoding="utf-8")
        run(["git", "add", "-A"], ws)
        run(["git", "commit", "-q", "-m", "init"], ws)
        baseline = head(ws)

        (ws / "a.txt").write_text("changed\n", encoding="utf-8")
        (ws / "b.txt").write_text("brand new file\n", encoding="utf-8")

        diff_text = git_diff_text(ws, baseline)
        assert "-original" in diff_text and "+changed" in diff_text
        assert "new file (untracked): b.txt" in diff_text
        assert "brand new file" in diff_text

    # ------------------------------------------------------------
    # 7. invoke_engineer's review_request plumbing: default None (every
    #    existing call site unaffected), and the flag is only appended
    #    to the spawned command when explicitly given.
    # ------------------------------------------------------------
    assert "review_request" in inspect.signature(invoke_engineer).parameters
    assert inspect.signature(invoke_engineer).parameters["review_request"].default is None
    invoke_source = inspect.getsource(invoke_engineer)
    assert '"--review-request"' in invoke_source
    assert "if review_request is not None:" in invoke_source

    # ------------------------------------------------------------
    # 8. "No plan -> zero behavior change": the review sub-loop and the
    #    gates/architectReviews manifest keys are both gated behind the
    #    same `architecture_plan is not None` condition C1 already uses
    #    for architectPlan/candidate_evidence — a run without
    #    --architect-first (architecture_plan always None) can never
    #    reach any of this code.
    # ------------------------------------------------------------
    main_source = inspect.getsource(main)
    assert main_source.count("if architecture_plan is not None:") >= 2, (
        "both the gates/architectReviews manifest init and the review "
        "sub-loop must be gated behind architecture_plan is not None"
    )

    # ------------------------------------------------------------
    # 9. Revise rounds must never touch the outer repair-loop's
    #    iteration variable or --max-repairs -- the revise invoke_
    #    engineer() call must not be inside a construct that reassigns
    #    `iteration` (it lives inside the `while True:` review loop,
    #    nested under the `for iteration in range(...)` loop, but never
    #    itself advances `iteration`).
    # ------------------------------------------------------------
    assert "iteration += 1" not in main_source
    assert "iteration = iteration" not in main_source

    print("architect review self-check: PASS")


def _tasks_selfcheck() -> None:
    """C3 (glimmer-v7): task graph self-check -- no live model needed.
    Covers derivation from a synthetic plan (ids/kinds/dependsOn chain),
    evidence-driven transitions (engineer success -> complete, engineer
    fail -> failed, matched verify PASS/PASS_BASELINE -> complete,
    matched CODE_FAIL -> failed, unmatched verificationPlan entry stays
    pending, INFRA_BLOCKED/TIMEOUT stay pending), never-raises on a
    write failure, and zero-behavior-change without a plan (no
    tasks.json file). Run with: python3 glimmer-v2.py --tasks-selfcheck
    """
    plan = {
        "implementationPlan": ["inspect hydration path", "add restoration hook"],
        "verificationPlan": ["frontend_typecheck", "lint", "nonexistent_check"],
    }

    # ------------------------------------------------------------
    # 1. Derivation: ids, kinds, sequential dependsOn chain.
    # ------------------------------------------------------------
    tasks = derive_tasks(plan)
    assert [t["id"] for t in tasks] == ["t1", "t2", "t3", "t4", "t5"]
    assert tasks[0]["kind"] == "implementation" and tasks[0]["dependsOn"] == []
    assert tasks[1]["kind"] == "implementation" and tasks[1]["dependsOn"] == ["t1"]
    assert tasks[2]["kind"] == "verification" and tasks[2]["dependsOn"] == ["t2"]
    assert tasks[3]["kind"] == "verification" and tasks[3]["dependsOn"] == ["t2"]
    assert tasks[4]["kind"] == "verification" and tasks[4]["dependsOn"] == ["t2"]
    assert all(t["status"] == "pending" for t in tasks)
    assert tasks[0]["description"] == "inspect hydration path"
    assert tasks[2]["description"] == "frontend_typecheck"

    # No implementation steps: verification tasks have no dependency.
    tasks_no_impl = derive_tasks({"verificationPlan": ["typecheck"]})
    assert tasks_no_impl[0]["id"] == "t1" and tasks_no_impl[0]["dependsOn"] == []

    # Malformed plan fields degrade to [] rather than raising.
    assert derive_tasks({}) == []
    assert derive_tasks({"implementationPlan": "not a list"}) == []

    # ------------------------------------------------------------
    # 2. Spawn -> in_progress (implementation only; verification untouched).
    # ------------------------------------------------------------
    tasks = derive_tasks(plan)
    set_implementation_tasks_status(tasks, "in_progress")
    assert tasks[0]["status"] == "in_progress" and tasks[1]["status"] == "in_progress"
    assert tasks[2]["status"] == "pending"

    # ------------------------------------------------------------
    # 3. Engineer-return: deterministic evidence only, never a model claim.
    # ------------------------------------------------------------
    evaluate_implementation_tasks(tasks, ["frontend/a.ts"], 0)  # changed files + rc==0
    assert tasks[0]["status"] == "complete" and tasks[1]["status"] == "complete"

    tasks_no_files = derive_tasks(plan)
    set_implementation_tasks_status(tasks_no_files, "in_progress")
    evaluate_implementation_tasks(tasks_no_files, [], 0)  # ran, touched nothing
    assert all(t["status"] == "failed" for t in tasks_no_files if t["kind"] == "implementation")

    tasks_engineer_err = derive_tasks(plan)
    evaluate_implementation_tasks(tasks_engineer_err, ["frontend/a.ts"], 1)  # non-zero rc
    assert all(t["status"] == "failed" for t in tasks_engineer_err if t["kind"] == "implementation")

    # ------------------------------------------------------------
    # 4. Verification: matched PASS/PASS_BASELINE/CODE_FAIL, unmatched
    #    stays pending, INFRA_BLOCKED/TIMEOUT stay pending.
    # ------------------------------------------------------------
    results = [
        {"command": "npm --prefix frontend run typecheck", "status": "PASS"},
        {"command": "npm --prefix frontend run lint", "status": "CODE_FAIL"},
    ]
    evaluate_verification_tasks(tasks, results)
    assert tasks[2]["status"] == "complete"   # "frontend_typecheck" matched, PASS
    assert tasks[3]["status"] == "failed"     # "lint" matched, CODE_FAIL
    assert tasks[4]["status"] == "pending"    # "nonexistent_check": no match -- honest

    tasks_pb = derive_tasks({"verificationPlan": ["typecheck"]})
    evaluate_verification_tasks(
        tasks_pb, [{"command": "npm run typecheck", "status": "PASS_BASELINE"}])
    assert tasks_pb[0]["status"] == "complete"

    tasks_infra = derive_tasks({"verificationPlan": ["typecheck"]})
    evaluate_verification_tasks(
        tasks_infra, [{"command": "npm run typecheck", "status": "INFRA_BLOCKED"}])
    assert tasks_infra[0]["status"] == "pending"  # check never really ran

    tasks_timeout = derive_tasks({"verificationPlan": ["typecheck"]})
    evaluate_verification_tasks(
        tasks_timeout, [{"command": "npm run typecheck", "status": "TIMEOUT"}])
    assert tasks_timeout[0]["status"] == "pending"

    # evaluate_*/set_* are no-ops on tasks=None (mirrors main()'s no-plan gate).
    set_implementation_tasks_status(None, "in_progress")
    evaluate_implementation_tasks(None, ["x"], 0)
    evaluate_verification_tasks(None, results)

    # ------------------------------------------------------------
    # 5. Never-raises: a tasks.json write failure must not propagate --
    #    same never-crash-the-session discipline as C1/C6.
    # ------------------------------------------------------------
    real_write_text = Path.write_text

    def _boom(self, *a, **kw):
        raise OSError("disk full (simulated)")

    Path.write_text = _boom
    try:
        with tempfile.TemporaryDirectory() as td:
            save_tasks(Path(td), tasks)  # must not raise
    finally:
        Path.write_text = real_write_text

    # ------------------------------------------------------------
    # 6. Zero behavior change without a plan: no tasks.json is ever
    #    written -- mirrors main()'s `tasks = None` / no-derive gate.
    # ------------------------------------------------------------
    architecture_plan = None
    tasks_none = derive_tasks(architecture_plan) if architecture_plan is not None else None
    assert tasks_none is None
    with tempfile.TemporaryDirectory() as td:
        session_dir = Path(td)
        if tasks_none is not None:
            save_tasks(session_dir, tasks_none)
        assert not (session_dir / "tasks.json").exists()

    print("task graph (C3) self-check: PASS")


def _visual_selfcheck() -> None:
    """C4 (glimmer-v7): proves the vision-verification plumbing without a
    live browser or a live model call.
    Run with: python3 glimmer-v2.py --visual-selfcheck
    """
    # --- opt-in guarantee: a verification plan without "visual" is
    # byte-identical to the pre-C4 inline shlex.split-and-append loop. ---
    with tempfile.TemporaryDirectory() as td:
        session = Path(td)
        raw = ["npm run typecheck", "npm run lint"]

        old_style = [["git", "diff", "--check"]]
        for r in raw:
            c = shlex.split(r)
            if c and c not in old_style:
                old_style.append(c)

        new_style = expand_verify_entries(
            [["git", "diff", "--check"]], raw, session, "http://localhost:3000",
        )
        assert new_style == old_style, "non-visual entries must expand identically to the pre-C4 loop"
        assert not (session / "visual").exists(), "no visual output dir when 'visual' never appears"

        # Empty --verify entirely: identical to today (empty list stays empty).
        assert expand_verify_entries([["git", "diff", "--check"]], [], session, "http://x") == [
            ["git", "diff", "--check"]
        ]

    # --- "visual" token expands to a real glimmer-visual.py invocation and
    # creates sessions/<id>/visual/. ---
    with tempfile.TemporaryDirectory() as td:
        session = Path(td)
        commands = expand_verify_entries([["git", "diff", "--check"]], ["VISUAL"], session, "http://x/route")
        assert len(commands) == 2
        visual_cmd = commands[1]
        assert is_visual_check_command(visual_cmd)
        assert not is_visual_check_command(["git", "diff", "--check"])
        assert visual_cmd[0] == sys.executable
        assert visual_cmd[1] == str(GLIMMER_VISUAL)
        assert "--url" in visual_cmd and "http://x/route" in visual_cmd
        assert visual_cmd.count("--viewport") == len(VISUAL_DEFAULT_VIEWPORTS)
        for vp in VISUAL_DEFAULT_VIEWPORTS:
            assert vp in visual_cmd
        assert str(session / "visual") in visual_cmd
        assert (session / "visual").is_dir(), "output dir must be created up front"

    # --- severity classification: synthetic/injected findings.json. ---
    def _write_capture(session, manifest_status, findings):
        vdir = session / "visual"
        vdir.mkdir(parents=True, exist_ok=True)
        (vdir / "visual-manifest.json").write_text(json.dumps({
            "route": "/x", "viewports": ["1440x900", "390x844"],
            "states": ["initial"], "status": manifest_status, "captures": [], "findings": [],
        }), encoding="utf-8")
        (vdir / "findings.json").write_text(json.dumps({
            # Fix round 1: matches glimmer-visual.py's real build_findings
            # output -- "NOT_RUN" (not "PASS") for a clean capture with no
            # semantic review, "FAIL" only when capture itself failed.
            "status": "NOT_RUN" if manifest_status == "pass" else "FAIL",
            "viewport": "multi", "viewports": ["1440x900", "390x844"], "findings": findings,
        }), encoding="utf-8")

    # Critical finding -> CODE_FAIL, which is NOT in the budget-skip set
    # main() uses at the "failed_status in {INFRA_BLOCKED, TIMEOUT}" branch
    # -- i.e. it DOES flow into the ordinary repair path, exactly like any
    # other real verification failure.
    with tempfile.TemporaryDirectory() as td:
        session = Path(td)
        _write_capture(session, "pass", [
            {"id": "visual_001", "severity": "critical", "category": "clipping",
             "element": "dialog", "description": "primary action inaccessible"},
        ])
        result = classify_visual_check_result({"status": "PASS", "ok": True}, session)
        assert result["status"] == "CODE_FAIL" and result["ok"] is False
        assert result["status"] not in {"INFRA_BLOCKED", "TIMEOUT"}, \
            "a real finding must consume repair budget, not be treated as infra"
        assert len(result["visualBlockingFindings"]) == 1

    # High finding -> same as critical.
    with tempfile.TemporaryDirectory() as td:
        session = Path(td)
        _write_capture(session, "pass", [
            {"id": "visual_002", "severity": "high", "category": "overlap",
             "element": "footer", "description": "footer clipped"},
        ])
        result = classify_visual_check_result({"status": "PASS", "ok": True}, session)
        assert result["status"] == "CODE_FAIL" and result["ok"] is False

    # Low/medium only -> does not block (V7 §22.13).
    with tempfile.TemporaryDirectory() as td:
        session = Path(td)
        _write_capture(session, "pass", [
            {"id": "visual_003", "severity": "medium", "category": "spacing",
             "element": "header", "description": "spacing inconsistent"},
            {"id": "visual_004", "severity": "low", "category": "style",
             "element": "icon", "description": "minor cosmetic nit"},
        ])
        result = classify_visual_check_result({"status": "PASS", "ok": True}, session)
        assert result["status"] == "PASS" and result["ok"] is True

    # Empty findings (this pass's real, honest output) -> does not block,
    # and findings.json's own status is genuinely "NOT_RUN" (fix round 1),
    # never "PASS" -- capture succeeding is not the same fact as "reviewed,
    # fine". NOT_RUN with empty findings takes the identical non-blocking
    # path as any other empty-findings result (classification never
    # branches on findings_doc["status"], only on findings[] severities).
    with tempfile.TemporaryDirectory() as td:
        session = Path(td)
        _write_capture(session, "pass", [])
        written = json.loads((session / "visual" / "findings.json").read_text(encoding="utf-8"))
        assert written["status"] == "NOT_RUN", "must not be 'PASS' -- no semantic review ran"
        result = classify_visual_check_result({"status": "PASS", "ok": True}, session)
        assert result["status"] == "PASS" and result["ok"] is True

    # --- INFRA_BLOCKED path: glimmer-visual.py fails to run (nonexistent
    # script path -> real nonzero subprocess exit), and does not consume
    # repair budget (same set main() checks at the failed_status branch). ---
    with tempfile.TemporaryDirectory() as td:
        session = Path(td)
        cmd = [sys.executable, "/definitely/does/not/exist/glimmer-visual.py"]
        raw_result = run_verifier_command(Path.cwd(), cmd, 30, {})
        assert raw_result["status"] != "PASS", "a nonexistent script must not report PASS"
        result = classify_visual_check_result(raw_result, session)
        assert result["status"] == "INFRA_BLOCKED"
        assert result["ok"] is False
        # This is exactly the set main() tests to skip repair-budget
        # consumption at `failed_status in {"INFRA_BLOCKED", "TIMEOUT"}`.
        assert result["status"] in {"INFRA_BLOCKED", "TIMEOUT"}

    # Capture ran (script exit 0) but manifest reports incomplete capture
    # (e.g. some/all viewports failed) -> also INFRA_BLOCKED, never a
    # fabricated PASS or a code-defect CODE_FAIL.
    for bad_status in ("partial", "failed"):
        with tempfile.TemporaryDirectory() as td:
            session = Path(td)
            _write_capture(session, bad_status, [])
            result = classify_visual_check_result({"status": "PASS", "ok": True}, session)
            assert result["status"] == "INFRA_BLOCKED", bad_status

    # Script exit 0 but findings.json missing entirely -> INFRA_BLOCKED, not
    # a crash and not a silent PASS.
    with tempfile.TemporaryDirectory() as td:
        session = Path(td)
        (session / "visual").mkdir(parents=True)
        (session / "visual" / "visual-manifest.json").write_text(
            json.dumps({"route": "/x", "viewports": [], "states": [], "status": "pass", "findings": []}),
            encoding="utf-8",
        )
        result = classify_visual_check_result({"status": "PASS", "ok": True}, session)
        assert result["status"] == "INFRA_BLOCKED"

    # --- fix round 1: --visual-url is required (fails loudly), not
    # silently defaulted, whenever "visual" is opted into. ---
    for missing in (None, ""):
        try:
            validate_visual_url(["visual"], missing)
            assert False, f"expected V2Error for visual_url={missing!r}"
        except V2Error as exc:
            assert "--visual-url is required" in str(exc)
    # Case-insensitive token match, same as expand_verify_entries.
    try:
        validate_visual_url(["VISUAL"], None)
        assert False, "expected V2Error"
    except V2Error:
        pass
    # A real URL provided -> no error.
    validate_visual_url(["visual"], "http://localhost:4000")
    # "visual" not requested at all -> no error even with no URL (opt-in
    # only; every session that doesn't ask for the visual check is
    # unaffected).
    validate_visual_url(["npm run typecheck"], None)
    validate_visual_url([], None)

    print("visual (C4) self-check: PASS")


if __name__ == "__main__":
    if sys.argv[1:] == ["--r6-selfcheck"]:
        _r6_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--scope-guard-selfcheck"]:
        _scope_guard_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--repomap-cache-selfcheck"]:
        _repomap_cache_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--architect-first-selfcheck"]:
        _architect_first_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--architect-review-selfcheck"]:
        _architect_review_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--tasks-selfcheck"]:
        _tasks_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--visual-selfcheck"]:
        _visual_selfcheck()
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, _sigterm_handler)
    try:
        raise SystemExit(main())
    except (KeyboardInterrupt, V2Interrupted):
        print("\nStopped. Cleanup attempted.", file=sys.stderr)
        raise SystemExit(130)
    except V2Error as exc:
        print(f"\nGLIMMER V2.1 ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
