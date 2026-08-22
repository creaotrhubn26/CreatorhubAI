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
import urllib.parse
import urllib.request

from glimmer_events import emit as emit_event

ENGINEER_DEFAULT = Path.home() / "AI/muse-glimmer/glimmer-engineer.py"
STATE_ROOT = Path.home() / ".muse-glimmer/sessions"
# O1 (glimmer-v7 reconciliation doc, OPTIONAL tier -- "a directory of
# markdown selected by area is enough; don't build a registry service").
# User-space, NOT this repo: install a starter skill by copying one of
# this repo's skills-examples/*.md files here. See build_skills_block
# below for the full selection/cap contract.
SKILLS_ROOT = Path.home() / ".muse-glimmer/skills"
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
    # this state must never be promoted to "verified". Prefix match: Task
    # 1.3 splits the legacy "needs-architect-review" string into
    # "-rejected"/"-budget-exhausted" variants (see classify_failure
    # below); both must hit this explicit branch rather than fall through
    # to the generic unknown-status fallback at the bottom of this
    # function (same resulting value today, but only by coincidence).
    if raw_status.startswith("needs-architect-review"):
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

    Task 1.3 (V7 §40) note on USER_DENIED: glimmer-engineer.py's tool-result
    envelope (Task 1.1) can carry error.code == "USER_DENIED" when a human
    declines a write/shell tool call via the interactive approve() prompt.
    That envelope is deliberately NEVER routed into a tool_blocked event (no
    _emit("tool_blocked", ...) call exists at that denial site) and so can
    never spuriously match the tool_blocked branch below and be classified as
    POLICY_BLOCK — a controller ruling from Task 1.1: a human saying no is
    not an automated policy block, it is closer to USER_CANCELLED (someone
    with authority stopped the run) or, in the gateway flow, simply doesn't
    happen at all (--auto-approve is always passed for UI-launched runs, see
    runner.ts). If a session terminates as a direct result of a denial, its
    real terminal status is whatever raw status classification set (or
    "cancelled-sigterm" if the human then aborts the run) — this function
    intentionally adds no separate USER_DENIED-keyed branch.
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
    # Task 1.3: the architect-review gate (C2, V7 §5.10/§5.13) has two
    # distinct terminal causes that main() now writes as distinct raw
    # statuses (previously both collapsed into the single "needs-architect-
    # review" string, below, kept for backward compatibility with archived
    # sessions predating this task).
    if raw == "needs-architect-review-rejected":
        return {"class": "POLICY_BLOCK", "detail": "architect review rejected the implementation (V7 §5.10)", "evidenceIds": []}
    if raw == "needs-architect-review-budget-exhausted":
        return {"class": "BUDGET_EXHAUSTED", "detail": "architect review budget exhausted (V7 §5.13)", "evidenceIds": []}
    if raw == "needs-architect-review":
        return {"class": "POLICY_BLOCK", "detail": "architect review rejected the implementation or the review budget was exhausted (V7 §5.10/§5.13)", "evidenceIds": []}
    # Task 1.3: readiness_probe (main()'s preflight) now records this exact
    # status when the model server never becomes reachable, instead of
    # falling through to the generic "initialized" -> "failed-aborted"
    # catch-all in main()'s finally block.
    if raw == "failed-model-unavailable":
        return {"class": "MODEL_UNAVAILABLE", "detail": "model server was not reachable at readiness_probe (V7 §16)", "evidenceIds": []}
    # Task 1.3: verify() genuinely ran (args.verify was set) and returned
    # ok=False on the no-changed-files path -- a real verification failure,
    # distinct from "no-change-unverified" (verification was never
    # requested at all, see the sibling branch main() still writes).
    if raw == "failed-verification":
        return {"class": "VERIFICATION_FAILURE", "detail": "verify() returned a failing result", "evidenceIds": []}
    # Task 1.4 (V7 §6): TaskContract budgets.maxChangedFiles, enforced
    # deterministically post-diff in main()'s repair loop.
    if raw == "failed-changed-files-budget-exceeded":
        return {"class": "SCOPE_FAILURE", "detail": "changed files exceeded the task contract's budgets.maxChangedFiles", "evidenceIds": []}
    if raw == "failed-aborted":
        return {"class": "ORCHESTRATION_ABORTED",
                "detail": "orchestration raised an error before completing any attempt "
                           "(e.g. model server unreachable at readiness_probe, or another "
                           "run()/setup failure) — no repair loop iteration ever started",
                "evidenceIds": []}
    if raw.startswith("cancelled"):
        return {"class": "USER_CANCELLED", "detail": "session terminated by SIGTERM/interrupt before reaching a terminal state", "evidenceIds": []}
    # Task 1.3: TOOL_EXECUTION_FAILURE covers a tool-result envelope (Task
    # 1.1) with ok=False and a non-policy, non-denial error.code -- e.g. an
    # exception during tool dispatch rather than a policy/approval decision.
    # No current glimmer-engineer.py call site ever produces such an
    # envelope (execute_tool's only ok=False codes today are POLICY_BLOCK
    # and USER_DENIED, both handled elsewhere), and envelope error codes are
    # not yet plumbed from evidence-NN.jsonl into events.jsonl/manifest
    # status for this function to observe live. This branch is forward-
    # compatible groundwork only (same "no emit site yet" precedent as
    # glimmer_events.EVENT_TYPES's "architect_replan_started"), exercised in
    # _r6_selfcheck with a synthetic status.
    if raw == "failed-tool-execution":
        return {"class": "TOOL_EXECUTION_FAILURE", "detail": "a tool call returned a non-policy execution error", "evidenceIds": []}

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


def changed_files_budget_exceeded(files: list, max_changed_files) -> bool:
    """Task 1.4 (V7 §6): TaskContract budgets.maxChangedFiles, enforced
    deterministically post-diff. max_changed_files is None (unbounded) when
    --max-changed-files was never passed -- always False in that case, same
    "omitted = orchestrator default" contract every other optional budget
    field already follows."""
    return max_changed_files is not None and len(files) > max_changed_files


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

    # Task 1.4 (V7 §6): budgets.maxChangedFiles enforcement -- simulate a
    # changed-file list over/at/under the budget.
    assert changed_files_budget_exceeded(["a", "b", "c"], 2) is True
    assert changed_files_budget_exceeded(["a", "b"], 2) is False
    assert changed_files_budget_exceeded(["a", "b", "c"], 3) is False  # at budget, not exceeded
    assert changed_files_budget_exceeded([], 1) is False
    # None (--max-changed-files never passed) is always unbounded.
    assert changed_files_budget_exceeded(["a", "b", "c", "d", "e"], None) is False
    r = classify_failure({"status": "failed-changed-files-budget-exceeded"}, [])
    assert r["class"] == "SCOPE_FAILURE"

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


def _model_base_url(readiness_url):
    """Derive the bare http://host:port glimmer-visual.py's --model-url
    wants from v2's EXISTING model-readiness URL (same llama-server, just
    a different path -- READINESS_URL_DEFAULT/--model-readiness-url hits
    .../tools; glimmer-visual.py appends /v1/chat/completions itself).
    Not a new source of truth -- reuses the one v2 already has."""
    parts = urllib.parse.urlsplit(readiness_url)
    return f"{parts.scheme}://{parts.netloc}"


def build_visual_verify_command(session, url, model_readiness_url=READINESS_URL_DEFAULT):
    """C4 (glimmer-v7): real subprocess argv for the visual capture check,
    targeting sessions/<id>/visual/ (V7 §22.14 evidence store layout).
    Creates the output directory up front so glimmer-visual.py -- which is
    handed only --output-dir, never a workspace path -- has somewhere to
    write and never needs to reach outside it (V7 §22.19: Vision Verifier
    must be read-only).

    Fix round 2 (live vision wiring): "visual" in the verification plan
    now means the real thing -- full visual verification, not
    capture-only. Without --vision here, findings.json would stay
    NOT_RUN forever; every caller through this orchestrator would never
    get a real review, only the direct (non-orchestrated) invocations
    used for live checkpointing did. --model-url reuses
    model_readiness_url (v2's existing, single source of the
    llama-server's address) via _model_base_url -- not hardcoded again.
    --api-key-file is deliberately NOT passed: glimmer-visual.py's own
    default already resolves to the identical
    Path.home()/"AI/muse-glimmer/config/api-key.txt" convention
    glimmer-engineer.py uses, so there is nothing a v2-supplied value
    here could improve on. No opt-out flag -- "visual" in the plan is
    already the opt-in; capture-only mode stays available by running
    glimmer-visual.py directly without --vision.
    """
    out_dir = session / "visual"
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, str(GLIMMER_VISUAL), "--url", url, "--output-dir", str(out_dir)]
    for vp in VISUAL_DEFAULT_VIEWPORTS:
        cmd += ["--viewport", vp]
    cmd += ["--vision", "--model-url", _model_base_url(model_readiness_url)]
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


def expand_verify_entries(commands, raw_entries, session, visual_url,
                           model_readiness_url=READINESS_URL_DEFAULT):
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
            cmd = build_visual_verify_command(session, visual_url, model_readiness_url)
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

    Blocking is driven mainly by findings[] severities, not by
    findings_doc["status"] itself -- that field (PASS/FAIL/NOT_RUN/...) is
    mostly informational metadata for humans/Control Center about whether
    semantic review ran at all (fix round 1: glimmer-visual.py now honestly
    writes "NOT_RUN" for a clean capture with no review, not "PASS" -- see
    its build_findings docstring): NOT_RUN with an empty findings[] takes
    the exact same non-blocking PASS path below as any other
    empty-findings result.

    C4 (live vision wiring) adds exactly one narrow exception:
    findings_doc["status"] == "BLOCKED" means glimmer-visual.py's
    run_vision_model itself failed/produced an unparseable reply for at
    least one captured viewport (its own docstring: it never fabricates
    findings on a failed call). An empty/non-blocking findings[] in that
    case does NOT mean "reviewed, fine" -- some viewport was never
    actually reviewed. Taking the plain PASS path below would silently
    turn a real infra gap into a green check, so this one status value IS
    read here, ahead of the findings[]-only PASS path.
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
    elif findings_doc.get("status") == "BLOCKED":
        result["status"] = "INFRA_BLOCKED"
        result["ok"] = False
        result["visualInfraReason"] = (
            "vision model call failed/unparseable for at least one viewport"
        )
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
                if events_path is not None:
                    emit_event(events_path, "visual_verification_started", session_id, command=label)
                result = classify_visual_check_result(result, session)
                if events_path is not None:
                    for finding in result.get("visualBlockingFindings", []):
                        # NIT (fix round 1): category is model-controlled
                        # (visual model's own JSON output) -- cap it like
                        # description just below, so a runaway/malicious
                        # value can't bloat events.jsonl.
                        category = finding.get("category")
                        if category is not None:
                            category = str(category)[:100]
                        emit_event(events_path, "visual_finding_detected", session_id,
                                   severity=finding.get("severity"),
                                   category=category,
                                   description=str(finding.get("description", ""))[:300])
                    emit_event(events_path, "visual_verification_completed", session_id,
                               status=result["status"])

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


# O1 (glimmer-v7 reconciliation doc, last OPTIONAL-tier item; V7 spec
# Section 10 / Skills chapter): "a directory of markdown selected by area
# is enough; don't build a registry service" -- "only worth it once >=3
# real skills exist" (this repo ships exactly 3, see skills-examples/).
#
# Mechanism: SKILLS_ROOT (~/.muse-glimmer/skills/*.md, user-space, NOT
# this repo -- install a skill by copying one of skills-examples/*.md
# there). Each file is one skill: YAML-ish frontmatter between "---"
# lines (name:/areas:/filetypes:, comma-separated lists) parsed by the
# tiny hand-rolled parser below (no new dependency -- this is 3 flat
# key: value lines, not nested structure, a real YAML lib would be
# overkill), followed by a markdown body.
#
# Selection is 100% deterministic, per V7: by repo area + changed file
# types -- never the model. A skill matches when ANY of its areas is a
# case-insensitive segment match against the contract's scope
# (package/area/paths) OR any of its filetypes matches an extension
# found in the plan's candidateFiles / the scope's own paths.
#
# Injection is hard-capped (reconciliation doc Section 12, risk 6: prompt
# space is contested by the contract/plan/evidence blocks already built
# above) -- at most MAX_SKILLS_INJECTED skills (most-specific first: a
# filetype match is more specific than an area-only match, ties break on
# filename), each body capped at MAX_SKILL_BODY_BYTES, the whole block
# capped at MAX_SKILLS_TOTAL_BYTES. A missing dir, no matches, or
# malformed frontmatter all degrade to "" -- zero change to make_prompt's
# output in every one of those cases, same never-raises discipline as
# the rest of this module.
MAX_SKILLS_INJECTED = 3
MAX_SKILL_BODY_BYTES = 1536       # ~1.5KB per skill body
MAX_SKILLS_TOTAL_BYTES = 4096     # ~4KB for the whole injected block


def _parse_skill_file(path: Path):
    """Lenient hand-rolled frontmatter parser. Returns None (skip this
    file) on any malformed shape: missing opening/closing '---' fence, no
    body left after the fence, or an unreadable/non-utf8 file. Unknown
    frontmatter keys are ignored; name:/areas:/filetypes: are matched
    case-insensitively on the key only."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None

    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None

    meta = {}
    body_start = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            body_start = i + 1
            break
        if ":" in lines[i]:
            key, _, val = lines[i].partition(":")
            meta[key.strip().lower()] = val.strip()
    if body_start is None:
        return None

    body = "\n".join(lines[body_start:]).strip()
    if not body:
        return None

    def _split_list(raw):
        return [x.strip().lower() for x in raw.split(",") if x.strip()]

    filetypes = [
        ft if ft.startswith(".") else f".{ft}"
        for ft in _split_list(meta.get("filetypes", ""))
    ]

    return {
        "name": meta.get("name") or path.stem,
        "areas": _split_list(meta.get("areas", "")),
        "filetypes": filetypes,
        "body": body,
        "filename": path.name,
    }


def load_skills(skills_dir=None, events_path=None, session_id=None) -> list:
    """Load every *.md skill file from skills_dir (default SKILLS_ROOT),
    sorted by filename for a stable base ordering (specificity sorting
    happens later, in select_skills). Never raises: a missing/unreadable
    dir, or any single unreadable/malformed file, is skipped -- worst
    case this returns [].

    Task 1.2: events_path/session_id are optional and default to None so
    every existing call site (select_skills/build_skills_block/make_prompt,
    and every test that calls this directly) is byte-for-byte unaffected.
    Only main()'s one dedicated session-start call passes them, emitting
    one skill_loaded event per skill actually found on disk -- distinct
    from (and unrelated to) the per-iteration area/filetype *selection*
    select_skills does later against the contract/plan."""
    d = Path(skills_dir) if skills_dir is not None else SKILLS_ROOT
    try:
        if not d.is_dir():
            return []
        files = sorted(d.glob("*.md"))
    except OSError:
        return []

    skills = []
    for f in files:
        try:
            parsed = _parse_skill_file(f)
        except Exception:
            parsed = None
        if parsed:
            skills.append(parsed)
            if events_path is not None and session_id is not None:
                emit_event(events_path, "skill_loaded", session_id,
                           name=parsed["name"], path=str(f))
    return skills


def _skills_scope_text(contract) -> str:
    """package/area/paths from the contract, flattened into one string
    for area matching. Built defensively (never indexes contract["scope"]
    directly) so a partial/malformed contract can't raise here."""
    scope = (contract or {}).get("scope") or {}
    bits = [str(scope.get("package", ""))]
    if scope.get("area"):
        bits.append(str(scope["area"]))
    for p in scope.get("paths") or []:
        bits.append(str(p))
    return " ".join(bits)


def _segment_tokens(text: str) -> list:
    """Split on any run of non-alphanumeric characters so path separators
    and punctuation act as segment boundaries -- same boundary idea O2's
    detect_documentation_impact uses, minus its camelCase-edge handling
    (area keywords here are plain words like "frontend"/"typescript", not
    compound identifiers that need case-transition awareness)."""
    return [t for t in re.split(r"[^a-z0-9]+", text.lower()) if t]


def _candidate_extensions(contract, plan) -> set:
    """Extensions to match skill filetypes against: the plan's
    candidateFiles paths (when a plan exists) unioned with the contract
    scope's own paths -- either can carry a real file extension."""
    paths = []
    if plan and plan.get("candidateFiles"):
        paths.extend(
            c.get("path", "") for c in plan["candidateFiles"] if isinstance(c, dict)
        )
    scope = (contract or {}).get("scope") or {}
    paths.extend(str(p) for p in (scope.get("paths") or []))

    exts = set()
    for p in paths:
        ext = os.path.splitext(str(p))[1].lower()
        if ext:
            exts.add(ext)
    return exts


def select_skills(contract, plan, skills=None, skills_dir=None) -> list:
    """Deterministic skill selection -- no model involvement. A skill
    matches when ANY of its areas is an exact, case-insensitive match
    against one whole segment/token of the contract's scope
    (package/area/paths, split on non-alphanumeric boundaries -- e.g.
    "frontend/ui/App.tsx" tokenizes to {"frontend", "ui", "app", "tsx"})
    OR any of its filetypes matches an extension found in the plan's
    candidateFiles / the scope paths. Deliberately exact-token, not
    raw substring -- a raw substring test would let a short area like
    "ui" match unrelated tokens that merely contain those letters (e.g.
    "build"), which isn't what a scope keyword match should mean.
    Matched skills are ordered most-specific-first (filetype match beats
    area-only match; ties break on filename) and hard-capped to
    MAX_SKILLS_INJECTED."""
    if skills is None:
        skills = load_skills(skills_dir)
    if not skills:
        return []

    scope_tokens = set(_segment_tokens(_skills_scope_text(contract)))
    exts = _candidate_extensions(contract, plan)

    matched = []
    for sk in skills:
        filetype_hit = any(ft in exts for ft in sk["filetypes"])
        area_hit = any(area and area in scope_tokens for area in sk["areas"])
        if filetype_hit or area_hit:
            matched.append((sk, filetype_hit))

    matched.sort(key=lambda pair: (0 if pair[1] else 1, pair[0]["filename"]))
    return [sk for sk, _ in matched[:MAX_SKILLS_INJECTED]]


def _truncate_bytes(text: str, limit: int, marker: str) -> str:
    if len(text.encode("utf-8")) <= limit:
        return text
    cut = max(limit - len(marker.encode("utf-8")), 0)
    # Cut on encoded bytes (not str indices) so the result can't exceed
    # `limit` because of a multi-byte character; errors="ignore" simply
    # drops a character split in half by the cut.
    return text.encode("utf-8")[:cut].decode("utf-8", errors="ignore") + marker


def build_skills_block(contract, plan, skills=None, skills_dir=None) -> str:
    """The "REPOSITORY SKILLS" block make_prompt appends -- "" (byte-for-
    byte no change to the prompt) whenever nothing matches, the skills
    dir doesn't exist, or anything at all goes wrong. Never raises."""
    try:
        matched = select_skills(contract, plan, skills=skills, skills_dir=skills_dir)
    except Exception:
        return ""
    if not matched:
        return ""

    parts = []
    for sk in matched:
        body = _truncate_bytes(sk["body"], MAX_SKILL_BODY_BYTES, "\n...[truncated]")
        parts.append(f"--- SKILL: {sk['name']} ---\n{body}")
    block = "\n\n".join(parts)
    block = _truncate_bytes(
        block, MAX_SKILLS_TOTAL_BYTES, "\n...[SKILLS BLOCK TRUNCATED -- total cap reached]"
    )
    return (
        "\n\nREPOSITORY SKILLS — conventions for this codebase (selected "
        "deterministically by area/filetype match, not model judgment; at "
        "most 3, most-specific first -- a hint, not a substitute for "
        "reading the actual code):\n" + block
    )


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

    # Fix round 1 (Minor 5): gate on `failure is not None`, not `iteration`
    # truthiness — a C2 architect-revise round always has failure text but
    # can legitimately happen at outer iteration 0 (before any verify()-
    # driven repair), and the two calls used to coincide only because the
    # pre-C2 repair loop never called this with iteration==0 and a real
    # failure at the same time. This keeps every pre-existing call site
    # byte-identical (there, iteration>0 <=> failure is not None already).
    repair = ""
    if failure is not None:
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
    """).strip() + plan_block + build_skills_block(contract, plan)


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


# ============================================================
# Task 2.1 (V7 §5.5 first half): risk-triggered architect mode
# ============================================================
# Deterministic score, no model involvement. Fixed points per signal,
# each independent (any subset can fire and stacks):
#
#   signal                                                     points
#   --------------------------------------------------------------
#   contract.mode == "refactor"                                     3
#   multi-package scope (contract.scope.package == "repository")    2
#   candidate_count > ARCHITECT_RISK_CANDIDATE_THRESHOLD             2
#   protected-area keyword in contract.objective                    3
#   verification_level == "full"                                    2
#
# score >= ARCHITECT_RISK_THRESHOLD auto-triggers architect-first
# (unless --no-architect was passed); see main()'s architect_trigger_mode.
#
# "mode == refactor": @glimmer/shared's TaskContract.mode union (and
# --mode's own choices) has no "refactor" value today -- this signal is
# honored anyway, forward-compatible with a future TaskContract value,
# and simply never fires under the CLI's current --mode choices.
ARCHITECT_RISK_CANDIDATE_THRESHOLD = 5
ARCHITECT_RISK_THRESHOLD = 5

# Same plain-word, exact-token style as detect_documentation_impact's
# _DOC_IMPACT_WORDS/_word_hits, applied to the objective text via the
# existing _segment_tokens tokenizer (skills section, above) instead of
# a fresh regex -- exact-token match is enough here (no camelCase
# identifiers expected in a free-text objective sentence).
_PROTECTED_AREA_WORDS = frozenset({
    "auth", "authentication", "payment", "payments",
    "migration", "migrations", "schema", "security",
})


def validate_architect_flags(architect_first, no_architect) -> None:
    """Task 2.1: --architect-first (manual force-on) and --no-architect
    (explicit opt-out) are a direct contradiction of intent when both are
    passed -- raise rather than silently picking a side. Pure/standalone
    so it's testable without spawning main()'s full argparse/workspace
    setup, same pattern as validate_visual_url."""
    if architect_first and no_architect:
        raise V2Error("--architect-first and --no-architect are mutually exclusive")


def compute_architect_risk(contract_like, candidate_count, verification_level) -> dict:
    """Pure, deterministic V7 §5.5 risk score for auto-triggering
    architect-first mode. No model call, no I/O, no randomness --
    same inputs always produce the same {"score": int, "signals": [str]}.

    `contract_like` is treated defensively (never indexed directly) so a
    partial/malformed dict can't raise. `candidate_count` is a plain int
    supplied by the caller (main() passes len(scope.paths) -- the only
    pre-architect proxy for "how many files this touches," since no
    ArchitecturePlan.candidateFiles exists yet at trigger-decision time).
    `signals` lists which rows of the table above fired, in table order.
    """
    contract_like = contract_like or {}
    scope = contract_like.get("scope") or {}
    score = 0
    signals = []

    if contract_like.get("mode") == "refactor":
        score += 3
        signals.append("mode_refactor")

    if scope.get("package") == "repository":
        score += 2
        signals.append("multi_package_scope")

    if isinstance(candidate_count, int) and candidate_count > ARCHITECT_RISK_CANDIDATE_THRESHOLD:
        score += 2
        signals.append("candidate_count_high")

    objective_tokens = _segment_tokens(str(contract_like.get("objective") or ""))
    if _PROTECTED_AREA_WORDS.intersection(objective_tokens):
        score += 3
        signals.append("protected_area_keyword")

    if verification_level == "full":
        score += 2
        signals.append("verification_full")

    return {"score": score, "signals": signals}


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
    emit_event(events_path, "architect_planning_started", sid)

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
        # NIT (fix round 1): packages is model-controlled (architect's own
        # JSON output) -- cap entry count and per-entry length so a
        # runaway/malicious value can't bloat events.jsonl.
        packages = plan.get("packages")
        if isinstance(packages, list):
            packages = [str(p)[:200] for p in packages[:20]]
        emit_event(events_path, "architect_plan_created", sid,
                   risk=plan.get("risk"), packages=packages)
    else:
        print("[V2] Architect produced no usable plan (missing/invalid/failed); proceeding without it.")

    return plan


# ============================================================
# C2 (glimmer-v7): Architect consultation + review budget — V7 §§5.6-5.13
# ============================================================
# Active only when --architect-first produced a usable plan; the review
# sits BEFORE verify() each iteration; REVISE_IMPLEMENTATION runs one
# bounded revise pass outside the outer repair loop (never touches
# --max-repairs). Full loop structure documented at the call site in main().

# V7 §5.13: budgets Architect<->Engineer disagreement (REVISE_IMPLEMENTATION
# rounds), not plain reviews — see the main() call site and Important 1/2
# of the round-1 review. Shared across the whole session.
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
    emit_event(events_path, "architect_review_requested", sid,
               iteration=iteration, reviewRound=review_round)

    request_path = session / f"review-request-{iteration:02d}-{review_round:02d}.json"

    try:
        # Fix round 1 (Minor 4): git_diff_text used to run OUTSIDE this
        # try, contradicting this function's own never-raises contract —
        # a git failure (e.g. baseline no longer resolvable) would have
        # propagated straight to main() instead of degrading to None.
        diff_text = git_diff_text(ws, baseline)
        if len(diff_text) > ARCHITECT_REVIEW_DIFF_MAX_CHARS:
            diff_text = diff_text[:ARCHITECT_REVIEW_DIFF_MAX_CHARS] + "\n\n[diff truncated by v2 review-request builder]"

        request = make_review_request(plan, files, change_types, diff_text, iteration, review_round)
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

    review = load_architect_review(session, iteration, review_round)
    if review is not None:
        emit_event(events_path, "architect_review_completed", sid,
                   iteration=iteration, reviewRound=review_round,
                   decision=review["decision"])
    return review


# ============================================================
# C3 (glimmer-v7): Task Graph (tasks.json) — reconciliation doc C3 entry.
# ============================================================
# Active only when --architect-first produced a usable plan. Flat list,
# sequential dependsOn only (deliberately not a DAG/priority model — see
# evaluate_implementation_tasks for why implementation tasks transition
# as one group, not per-step).


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


def snapshot_task_statuses(tasks) -> dict:
    """Task 1.2: id -> status snapshot taken immediately before a call to
    evaluate_implementation_tasks/evaluate_verification_tasks that may
    mutate `tasks` in place -- feed the result to emit_task_transitions
    right after that call to get an honest before/after diff. {} when
    `tasks` is None (no plan, C3 inactive)."""
    return {t["id"]: t["status"] for t in tasks} if tasks else {}


def emit_task_transitions(events_path, sid, tasks, before: dict,
                           list_completed_flag=None) -> None:
    """Task 1.2 (§ task events): diff `before` (from snapshot_task_
    statuses, taken just before an evaluate_*_tasks() call) against the
    current statuses and emit task_status_changed for each id that
    actually moved -- never for one that stayed pending/unmatched, same
    honesty discipline as the evaluators themselves. Emits
    task_list_completed once every task is non-pending; `list_completed_
    flag` (a caller-owned single-element list, e.g. [False]) suppresses
    repeat emissions across the several evaluate_*_tasks call sites in
    one session once that has already fired. No-op when `tasks` is None.
    """
    if tasks is None:
        return
    for t in tasks:
        prev = before.get(t["id"])
        if prev is not None and prev != t["status"]:
            emit_event(events_path, "task_status_changed", sid,
                       taskId=t["id"], status=t["status"], previousStatus=prev)
    already = list_completed_flag is not None and list_completed_flag[0]
    if tasks and not already and all(t["status"] != "pending" for t in tasks):
        emit_event(events_path, "task_list_completed", sid, taskCount=len(tasks))
        if list_completed_flag is not None:
            list_completed_flag[0] = True


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


def reset_verification_tasks_status(tasks) -> None:
    """Fix round 1 (Minor 6): flip every kind=='verification' task back to
    `pending`, in place. Called at the C2 revise-round re-spawn (alongside
    set_implementation_tasks_status(tasks, "in_progress")) — a verification
    task marked "complete" against the PRE-revise diff must not survive
    unchanged once the revise round produces a different diff; it is
    re-evaluated honestly by evaluate_verification_tasks after the next
    real verify() call. No-op when `tasks` is None."""
    if tasks is None:
        return
    for t in tasks:
        if t.get("kind") == "verification":
            t["status"] = "pending"


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

# Fix round 1 (Important 3): runner/stopword tokens that appear in nearly
# every npm command AND nearly every prose verificationPlan sentence —
# left in, a first-match-on-any-shared-token scheme treats "run"/"npm"
# (present in every `npm run X` command) as if they were meaningful
# signal, so prose like "Run the typecheck..." could match ANY npm
# command, not the one it names.
_TASK_VERIFY_STOPWORDS = {"run", "npm", "yarn", "pnpm", "exec", "npx", "the", "and", "all", "for", "to", "no"}


def _match_verify_result(description: str, results: list):
    """C3: token-set argmax match, case-insensitive — a verificationPlan
    entry (which may be a single word like "typecheck" OR a full prose
    sentence like "Run the typecheck to confirm no type errors") maps to
    the real verify() command whose command string shares the MOST
    tokens with it, after stripping runner names and stopwords
    (_TASK_VERIFY_STOPWORDS) from both sides — not the first result that
    shares ANY token. Fix round 1 (Important 3): the prior first-match
    scheme let a shared stopword-ish token (e.g. "run", present in every
    `npm run X` command) match the wrong command; reproduced live with
    "Run the typecheck to confirm no type errors" matching `npm run
    lint` before `npm run typecheck` even existed in the token
    intersection. Tokens are compared whole-word (set intersection), not
    raw substring-of-string containment — a naive `tok in cmd_string`
    check would let a short token like "check" spuriously match inside
    the unrelated word "typecheck".

    Returns the single result whose (post-stopword) token overlap with
    `description` is strictly larger than every other result's; returns
    None — leaving the task `pending`, never fabricating completion —
    when no token survives stopword-stripping, no result shares any
    token, or two or more results tie for the best (nonzero) overlap
    (ambiguous is honest, not a guess)."""
    tokens = {t for t in _TASK_VERIFY_TOKEN_RE.findall(description.lower()) if len(t) >= 3}
    tokens -= _TASK_VERIFY_STOPWORDS
    if not tokens:
        return None

    scored = []
    for r in results:
        cmd = (r.get("command") or "").lower()
        cmd_tokens = {t for t in _TASK_VERIFY_TOKEN_RE.findall(cmd) if len(t) >= 3} - _TASK_VERIFY_STOPWORDS
        score = len(tokens & cmd_tokens)
        if score > 0:
            scored.append((score, r))

    if not scored:
        return None
    best_score = max(score for score, _ in scored)
    winners = [r for score, r in scored if score == best_score]
    if len(winners) != 1:
        return None  # tie -- ambiguous, stays pending
    return winners[0]


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


# ============================================================
# O2 phase 1 (glimmer-v7 reconciliation): deterministic
# documentation-impact detector.
# ============================================================
# Scope is deliberately tiny (reconciliation doc, O2 entry): "deterministic
# change-impact detector (routes/schema/API/config/auth touched?) creating a
# REQUIRED doc task + gates.documentationCurrent. Graph, ADR store, drift
# detection and semantic doc verification: defer entirely." No repo-map
# lookup, no model call -- path/filename pattern matching only.

# Category -> standalone words checked with boundary-safe matching (see
# detect_documentation_impact). "routes"/"router" both catch the plain-
# word and plural-directory forms ("routes/user.ts", "router.ts",
# "user.routes.ts") without a separate glob branch. "authentication" is
# listed explicitly (not derived from "auth") because it's a real distinct
# word, separator-bounded on its own in filenames like
# "authentication.ts" -- no camel-boundary logic needed for it.
_DOC_IMPACT_WORDS = {
    "routes": ("routes", "router"),
    "schema": ("schema", "schemas", "migration", "migrations", "prisma"),
    "api": ("api", "openapi", "swagger"),
    "config": ("config",),
    "auth": ("auth", "authentication", "session", "sessions", "permission",
              "permissions", "token", "tokens"),
}

# Review round 1: idiomatic TS/JS identifiers -- AuthService.ts,
# authMiddleware.ts, SessionManager.ts -- are a real practical miss under
# plain non-alnum-only boundaries, since camelCase/PascalCase segments
# aren't separated by any non-alnum character at all. Scoped to
# auth/session/token only (not routes/schema/api/config): routes in
# particular has an explicit existing self-check requiring "userRouter.ts"
# to keep NOT matching "router", so the stricter non-alnum-only boundary
# stays the default everywhere except here.
_CAMEL_AWARE_CATEGORIES = {"auth"}


def _word_hits(word: str, path: str, camel_aware: bool) -> bool:
    """Case-insensitive search for `word` in `path` (original case, NOT
    lowercased -- camel-awareness needs the real casing) with a boundary
    on both sides. Boundary = start/end of string or a non-alnum
    separator. When camel_aware, ALSO accepts a camelCase/PascalCase
    segment edge: the character immediately after the match is uppercase
    (e.g. "auth" in "authMiddleware"), or the character immediately
    before the match is lowercase while the match itself starts uppercase
    (e.g. "Auth" in a hypothetical "userAuthService" -- a lower-to-upper
    transition marks a new segment; "AuthService" itself is already
    covered by start-of-string). This still rejects "author"/
    "possession": both are a plain lowercase continuation with no
    separator and no case transition, so neither boundary rule fires."""
    for m in re.finditer(re.escape(word), path, re.IGNORECASE):
        start, end = m.start(), m.end()
        before_ok = start == 0 or not path[start - 1].isalnum()
        after_ok = end == len(path) or not path[end].isalnum()
        if camel_aware:
            if not before_ok and path[start - 1].islower() and path[start].isupper():
                before_ok = True
            if not after_ok and path[end].isupper():
                after_ok = True
        if before_ok and after_ok:
            return True
    return False


def detect_documentation_impact(changed_files) -> list:
    """O2 phase 1: pure, deterministic classifier -- no model, no repo-map.
    Classifies each changed path into zero or more of
    {routes, schema, api, config, auth} by filename/path pattern only, and
    returns the SORTED list of categories hit across all changed files
    (empty list == no documentation impact).

    Boundary-sane by construction (see _word_hits): a compound identifier
    does NOT false-positive just because it contains a keyword as a
    substring -- e.g. "author.ts" does NOT match "auth" (no separator and
    no case transition between "auth" and the following "or"), and
    "userRouter.ts" does NOT match "router" (routes/schema/api/config use
    the stricter non-alnum-only boundary). Path/extension separators
    ("/", ".", "-", "_") all count as boundaries, so "routes/user.ts",
    "user_auth.py" and "webpack.config.js" DO match. The auth/session/
    token words additionally accept a camelCase/PascalCase segment edge,
    so "AuthService.ts", "authMiddleware.ts" and "SessionManager.ts" DO
    match while "Authors.tsx"/"possession.ts" still do NOT (plain
    lowercase continuation, no case transition). Case-insensitive
    throughout.

    Never raises: any non-string entry is coerced with str(); an empty/
    None input returns [] immediately.
    """
    impacts = set()
    for raw in (changed_files or []):
        path = str(raw).replace("\\", "/")
        lower = path.lower()
        segments = [s for s in lower.split("/") if s]
        basename = segments[-1] if segments else lower

        for category, words in _DOC_IMPACT_WORDS.items():
            camel_aware = category in _CAMEL_AWARE_CATEGORIES
            for word in words:
                if _word_hits(word, path, camel_aware):
                    impacts.add(category)
                    break

        # Explicit filename/segment checks the word list can't express
        # as a clean standalone word.
        if basename.endswith(".sql"):
            impacts.add("schema")
        if basename == "dockerfile" or basename.startswith("docker-compose"):
            impacts.add("config")
        if basename == ".env.example":
            impacts.add("config")
        if ".github" in segments and "workflows" in segments:
            impacts.add("config")

    return sorted(impacts)


def documentation_task(next_id: int, impacts: list) -> dict:
    """O2: the REQUIRED documentation task appended to tasks.json when
    C3's task graph is active and detect_documentation_impact found
    something. kind="documentation" is an honest new addition to C3's
    kind vocabulary (alongside "implementation"/"verification" -- see
    @glimmer/shared's GlimmerTask.kind, extended to match) precisely
    because NOTHING in this codebase can verify documentation currency
    yet (phase 1 is detection only): the task is created `pending` and
    stays `pending` forever -- none of C3's writers
    (set_implementation_tasks_status / evaluate_implementation_tasks /
    evaluate_verification_tasks / reset_verification_tasks_status) match
    on kind=="documentation", so it is never auto-completed. Only a human
    closing it out of band reflects reality. dependsOn is deliberately []:
    it doesn't block or get blocked by implementation/verification tasks,
    it just needs to exist and stay visible."""
    return {
        "id": f"t{next_id}",
        "description": (
            "Update documentation for this change (impacted areas: "
            + ", ".join(impacts) + "). Docs currency cannot be verified "
            "automatically yet -- a human must close this task."
        ),
        "kind": "documentation",
        "dependsOn": [],
        "status": "pending",
    }


def main():
    ap = argparse.ArgumentParser(description="Muse Glimmer Engineering Mode v2.1")
    ap.add_argument("task", nargs="+")
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--engineer", default=str(ENGINEER_DEFAULT))
    ap.add_argument("--max-repairs", type=int, default=2)
    # Task 1.4 (V7 §6): TaskContract.budgets.maxChangedFiles. None (the
    # default) means unbounded, same "omitted = orchestrator default"
    # contract every other optional contract field already follows.
    ap.add_argument("--max-changed-files", type=int, default=None,
                    help="Contract budgets.maxChangedFiles: fail the session (SCOPE_FAILURE) if more than "
                         "this many files change. 1..500. Omitted = unbounded.")
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
    # C1 (glimmer-v7): manual force-on, default False. Independent of the
    # Task 2.1 risk-based auto-trigger below (§5.5) -- passing this always
    # runs architect mode regardless of score.
    ap.add_argument("--architect-first", action="store_true",
                    help="Run glimmer-engineer.py --mode architect before iteration 0 and feed its "
                         "ArchitecturePlan into the engineering prompt. Manual force-on, independent "
                         "of the risk-based auto-trigger (see --no-architect).")
    # Task 2.1 (V7 §5.5): explicit opt-out of the risk-based auto-trigger
    # (compute_architect_risk). Wins over auto-trigger (score >= threshold
    # with this passed still runs with NO architect) but not over an
    # explicit --architect-first -- passing both is a direct contradiction
    # of intent and is rejected below rather than silently picking a side.
    ap.add_argument("--no-architect", action="store_true",
                    help="Explicitly opt out of the risk-based architect auto-trigger (V7 §5.5). "
                         "Errors if combined with --architect-first.")
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
    if args.max_changed_files is not None and not (1 <= args.max_changed_files <= 500):
        raise V2Error("--max-changed-files must be 1..500")
    validate_architect_flags(args.architect_first, args.no_architect)
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
    emit_event(events_path, "session_created", sid,
               taskSummary=_truncate_bytes(task, 500, "..."), workspace=str(ws))

    repo = build_repo_map(ws)
    (session / "repo-map.json").write_text(json.dumps(repo, indent=2), encoding="utf-8")
    summary = repo_summary(repo)

    # Task 1.2: skill_loaded events, once per session -- separate from (and
    # ahead of) build_skills_block's own per-iteration load_skills() calls
    # inside make_prompt, which pass no events_path/session_id and so never
    # re-emit these. The returned list is intentionally unused here; this
    # call exists purely to log what's on disk at session start.
    load_skills(events_path=events_path, session_id=sid)

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
    # Task 1.4 (V7 §6): TaskContract.budgets.maxChangedFiles -- optional,
    # omitted entirely when not passed (mirrors maxTurns's own omit-when-
    # unset contract just above).
    if args.max_changed_files is not None:
        contract["budgets"] = {"maxChangedFiles": args.max_changed_files}

    # Task 2.1 (V7 §5.5): risk score always computed (even on a run that
    # passes neither --architect-first nor --no-architect) so
    # manifest["architectTrigger"] records the decision for every session,
    # not just auto-triggered ones. candidate_count is the only
    # pre-architect proxy available at this point -- see compute_
    # architect_risk's docstring.
    architect_candidate_count = len(scope.get("paths") or [])
    architect_risk = compute_architect_risk(contract, architect_candidate_count, args.verification_level)
    if args.architect_first:
        architect_trigger_mode = "manual"
    elif architect_risk["score"] >= ARCHITECT_RISK_THRESHOLD and not args.no_architect:
        architect_trigger_mode = "auto"
    else:
        architect_trigger_mode = "off"
    run_architect = architect_trigger_mode in ("manual", "auto")
    if architect_trigger_mode == "auto":
        emit_event(events_path, "architect_autotriggered", sid,
                   score=architect_risk["score"], threshold=ARCHITECT_RISK_THRESHOLD,
                   signals=architect_risk["signals"])

    manifest = {
        "version": "2.1", "sessionId": sid, "workspace": str(ws), "branch": b,
        "baseline": baseline, "task": task, "maxRepairs": args.max_repairs,
        "verificationLevel": args.verification_level, "attempts": [], "status": "initialized",
        "state": canonical_session_state("initialized"),
        "eventsFile": "events.jsonl", "contract": contract,
        # Task 2.1 (V7 §5.5): always present, regardless of trigger mode --
        # the deterministic decision itself is worth recording even on an
        # "off" run (score/signals still computed, just below threshold or
        # explicitly opted out).
        "architectTrigger": {
            "mode": architect_trigger_mode,
            "score": architect_risk["score"],
            "signals": architect_risk["signals"],
        },
        # Task 1.4 (V7 §38): manifest completion -- additive fields only,
        # every existing reader (control-center/server/src/lib/sessions.ts)
        # tolerates unknown JSON keys already (plain JSON.parse, no schema
        # validation).
        "model": {"endpoint": args.model_readiness_url},
        # Mirrors contract["constraints"] verbatim minus "minimalChange"
        # (that one isn't a permission, it's a style constraint) -- these
        # are project-wide hard constants, never configurable via CLI
        # flags, so there is exactly one source of truth for both keys.
        "permissions": {k: v for k, v in contract["constraints"].items() if k != "minimalChange"},
        "budgets": {
            "maxTurns": args.max_turns,
            "maxRepairs": args.max_repairs,
            # The review-disagreement ceiling (V7 §5.13), always recorded
            # here regardless of --architect-first -- distinct from the
            # separate manifest["architectReviews"] = {"max", "used"} usage
            # counter added later, only when architecture_plan is actually
            # used.
            "architectReviews": ARCHITECT_REVIEW_BUDGET,
            # Fix round 1 (LOW): budgets.maxChangedFiles (V7 §6) was
            # recorded in contract["budgets"] (above, omit-when-unset) but
            # never mirrored into this top-level manifest["budgets"]
            # summary alongside the other three -- always present here,
            # null when --max-changed-files wasn't passed.
            "maxChangedFiles": args.max_changed_files,
        },
    }
    manifest_path = session / "manifest.json"

    def save():
        manifest["updatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    save()
    # Task 1.2: session_created (emitted right after session.mkdir() above)
    # is the real V7 event for this moment; agent_state_changed here still
    # marks the "initialized" state transition (R3) — the two are distinct
    # events, not a substitute for one another. state= is the canonical
    # GlimmerSessionStatus value that manifest["state"] mirrors.
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
    # O2: initialized here (before the try), not just at its usual C3 spot
    # inside the try below -- the finally block now reads `tasks` on EVERY
    # exit path, including a V2Error raised before that inner assignment
    # ever runs (e.g. readiness_probe failing below), which would otherwise
    # be a NameError in finally.
    tasks = None
    # Task 1.2: shared across every evaluate_*_tasks call site below so
    # task_list_completed fires at most once per session (see
    # emit_task_transitions's docstring).
    task_list_completed_flag = [False]
    try:
        if not args.skip_model_readiness:
            # Task 1.3 (V7 §40): readiness_probe raises V2Error on a hard
            # failure (model server never became reachable within the
            # timeout) -- record that as its own honest terminal status
            # here, before re-raising, instead of letting it fall through
            # unclassified to the generic "initialized" -> "failed-aborted"
            # catch-all in the `finally` block below (which still exists
            # for every OTHER pre-loop setup failure).
            try:
                manifest["modelReadiness"] = readiness_probe(args.model_readiness_url, args.readiness_timeout)
            except V2Error:
                manifest["status"] = "failed-model-unavailable"
                manifest["state"] = canonical_session_state(manifest["status"])
                emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
                save()
                raise
            save()
        else:
            manifest["modelReadiness"] = {"status": "SKIPPED"}
            save()

        # C1 (glimmer-v7) + Task 2.1 (V7 §5.5): runs once before iteration 0
        # whenever run_architect is True -- manual force-on (--architect-
        # first) or risk-based auto-trigger (architect_trigger_mode ==
        # "auto", computed above). architecture_plan stays None (identical
        # to run_architect being False) whenever it's skipped, or the
        # architect run fails/times out/produces invalid JSON — see
        # run_architect_first/load_architecture_plan's uniform-None
        # degradation contract. manifest["architectPlan"] is only ever
        # added when run_architect was actually True (fix round 1,
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
        # C3: tasks (initialized above the try, before O2 needed it in
        # `finally` too -- see that comment) stays None in every degraded
        # case, same uniform-None-on-no-plan contract as
        # architecture_plan/candidate_evidence just above.
        if run_architect:
            architecture_plan = run_architect_first(
                engineer, ws, contract, summary, session, events_path, sid,
            )
            manifest["architectPlan"] = architect_plan_manifest_record(architecture_plan)
            candidate_evidence = read_candidate_evidence(architecture_plan, ws)
            # C2: gates/architectReviews are only ever added to the
            # manifest when a usable plan exists — with no plan there is
            # nothing to review against, so C2 never runs and these keys
            # would otherwise be pure clutter on a run_architect run that
            # didn't even get a usable plan (mirrors architectPlan's own
            # run_architect gating just above).
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
                for t in tasks:
                    emit_event(events_path, "task_created", sid,
                               taskId=t["id"], kind=t["kind"],
                               description=t["description"][:200])
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
                task_snapshot = snapshot_task_statuses(tasks)
                evaluate_implementation_tasks(tasks, files, rc)
                save_tasks(session, tasks)
                emit_task_transitions(events_path, sid, tasks, task_snapshot, task_list_completed_flag)
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

            # Task 1.4 (V7 §6): budgets.maxChangedFiles -- unlike the scope
            # guard above (classify-only, staged rollout), this DOES block:
            # exceeding it fails the session outright, before verify() ever
            # runs for this iteration.
            if changed_files_budget_exceeded(files, args.max_changed_files):
                print(f"[V2] BUDGET EXCEEDED: {len(files)} changed files > "
                      f"--max-changed-files {args.max_changed_files}")
                attempt["status"] = "changed-files-budget-exceeded"
                manifest["attempts"].append(attempt)
                manifest["status"] = "failed-changed-files-budget-exceeded"
                manifest["state"] = canonical_session_state(manifest["status"])
                emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
                final_label = "CHANGED-FILES BUDGET EXCEEDED — NOT VERIFIED"
                save()
                break

            if not files:
                commands = [["git", "diff", "--check"]]
                commands = expand_verify_entries(commands, args.verify, session, args.visual_url, args.model_readiness_url)
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
                        task_snapshot = snapshot_task_statuses(tasks)
                        evaluate_verification_tasks(tasks, results)
                        save_tasks(session, tasks)
                        emit_task_transitions(events_path, sid, tasks, task_snapshot, task_list_completed_flag)
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
                    # Task 1.3 (V7 §40): verify() genuinely ran here and
                    # returned ok=False -- a real VERIFICATION_FAILURE, kept
                    # distinct from the "verification was never requested"
                    # case below (same raw status previously covered both).
                    attempt["status"] = "no-change-verification-failed"
                    manifest["attempts"].append(attempt)
                    manifest["status"] = "failed-verification"
                    manifest["state"] = canonical_session_state(manifest["status"])
                    emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
                    final_label = "VERIFICATION FAILED — NOT VERIFIED"
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
            # -- ONLY when --architect-first produced a usable plan. Sits
            # strictly BEFORE verify(). A REVISE_IMPLEMENTATION round
            # re-invokes the engineer directly, never through the outer
            # `for iteration` loop, so it never advances `iteration` or
            # consumes --max-repairs.
            #
            # Fix round 1 (Important 1+2): the budget (§5.13) bounds
            # Architect<->Engineer DISAGREEMENT, not review count. A plain
            # review call -- whether it comes back APPROVED/
            # APPROVED_WITH_CONDITIONS or fails open (no usable output) --
            # never increments `used`; it is free every time. `used` only
            # increments when a REVISE_IMPLEMENTATION decision is about to
            # trigger another revise+re-review round, and the budget check
            # runs BEFORE that increment, so the Nth allowed revise still
            # gets its follow-up review. This also fixes fail-open (never
            # counted) degrading into fail-closed (never blocks) under
            # sustained review-machinery failure.
            if architecture_plan is not None:
                review_round = 0
                architect_outcome = None
                while True:
                    review_round += 1
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

                    # decision_outcome == "revise": this IS the disagreement
                    # V7 §5.13 budgets. Check budget before spending it -- a
                    # revise round that would exceed it never runs.
                    if manifest["architectReviews"]["used"] >= ARCHITECT_REVIEW_BUDGET:
                        architect_outcome = "budget_exhausted"
                        break
                    manifest["architectReviews"]["used"] += 1
                    save()
                    print(f"[V2] Architect review requested REVISE_IMPLEMENTATION "
                          f"(iteration={iteration}, round={review_round}); running one bounded revise pass.")
                    # Fix round 1 (Minor 5): the real outer `iteration` and
                    # the real `checkpoint_sha` (whatever the repair loop
                    # last set, possibly still None on iteration 0) --
                    # previously `review_round` was passed as `iteration`
                    # (wrong REPAIR N label once the outer loop had already
                    # advanced) and checkpoint_sha was hardcoded None
                    # (dropping real checkpoint context on later
                    # iterations). make_prompt's repair block now gates on
                    # `failure is not None`, not `iteration` truthiness, so
                    # this stays correct even when iteration == 0.
                    revise_prompt = make_prompt(
                        contract, summary, iteration,
                        failure=architect_review_failure_text(review),
                        checkpoint_sha=checkpoint_sha, plan=architecture_plan, evidence=candidate_evidence,
                    )
                    (session / f"architect-revise-{iteration:02d}-{review_round:02d}.txt").write_text(
                        revise_prompt, encoding="utf-8")
                    # C3: a REVISE_IMPLEMENTATION round re-invokes the
                    # engineer directly (outside the outer repair loop) --
                    # implementation tasks go back to in_progress for this
                    # re-spawn and are re-evaluated after it returns,
                    # exactly like the main spawn/return pair above.
                    # Fix round 1 (Minor 6): verification tasks reset to
                    # pending too -- a stale "complete" from a PRE-revise
                    # verify() result must not survive against a changed
                    # diff; it is re-evaluated after the NEXT real verify().
                    if tasks is not None:
                        set_implementation_tasks_status(tasks, "in_progress")
                        reset_verification_tasks_status(tasks)
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
                        task_snapshot = snapshot_task_statuses(tasks)
                        evaluate_implementation_tasks(tasks, files, revise_rc)
                        save_tasks(session, tasks)
                        emit_task_transitions(events_path, sid, tasks, task_snapshot, task_list_completed_flag)
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
                    # Task 1.3 (V7 §40): distinct raw status per outcome, so
                    # classify_failure can tell an architect rejection
                    # (POLICY_BLOCK) apart from the review budget itself
                    # being exhausted (BUDGET_EXHAUSTED) -- these used to
                    # share one "needs-architect-review" string.
                    architect_raw_status = (
                        "needs-architect-review-budget-exhausted"
                        if architect_outcome == "budget_exhausted"
                        else "needs-architect-review-rejected"
                    )
                    attempt["status"] = architect_raw_status
                    manifest["attempts"].append(attempt)
                    manifest["status"] = architect_raw_status
                    manifest["state"] = canonical_session_state(manifest["status"])
                    emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
                    save()
                    final_label = "ARCHITECTURE REVIEW REQUIRED — NOT VERIFIED"
                    print(f"\n[V2] {architect_outcome}: architecture review gate blocks promotion to verified.")
                    break

            # Fix round 1 (HIGH): budgets.maxChangedFiles is bypassable via
            # the architect-review revise loop above -- that loop
            # recomputes `files` against a NEW post-revise diff, but the
            # budget check earlier in this iteration (the cheap exit,
            # still kept for the common no-review / no-growth case) only
            # ran against the PRE-revise diff. Re-check the current
            # `files` here, immediately before verify() runs, so a
            # post-revise diff that blows the budget can never reach
            # VERIFIED unchecked. See --architect-review-selfcheck's
            # source-ordering assertion for the structural proof that this
            # check is unreachable from the revise loop skipping it.
            if changed_files_budget_exceeded(files, args.max_changed_files):
                print(f"[V2] BUDGET EXCEEDED (post-revise): {len(files)} changed files > "
                      f"--max-changed-files {args.max_changed_files}")
                attempt["status"] = "changed-files-budget-exceeded"
                manifest["attempts"].append(attempt)
                manifest["status"] = "failed-changed-files-budget-exceeded"
                manifest["state"] = canonical_session_state(manifest["status"])
                emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
                final_label = "CHANGED-FILES BUDGET EXCEEDED — NOT VERIFIED"
                save()
                break

            commands = verifier_commands(repo, files, args.verification_level)
            commands = expand_verify_entries(commands, args.verify, session, args.visual_url, args.model_readiness_url)
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
                task_snapshot = snapshot_task_statuses(tasks)
                evaluate_verification_tasks(tasks, results)
                save_tasks(session, tasks)
                emit_task_transitions(events_path, sid, tasks, task_snapshot, task_list_completed_flag)
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

        # O2 phase 1: deterministic doc-impact detection runs once here,
        # against the session's FINAL changed-files set (this is the point
        # after which changed_files can no longer change -- collapse() just
        # ran and no further engineer/repair round follows). Same
        # merge-not-clobber discipline as every other gates writer (C2 sets
        # gates["architectureApproved"] earlier in this same run) -- read
        # whatever's already there (possibly nothing at all, on a run
        # without --architect-first) and add this key onto it. Honest gate
        # semantics: False when impact is detected (phase 1 has no way to
        # verify docs ARE current, so it can never claim True), None when
        # the change touched nothing doc-relevant (zero behavior change).
        doc_impacts = detect_documentation_impact(manifest["finalChangedFiles"])
        gates = dict(manifest.get("gates") or {})
        gates["documentationCurrent"] = False if doc_impacts else None
        manifest["gates"] = gates
        if doc_impacts:
            manifest["documentationImpact"] = doc_impacts
            # C3's machinery: only append when a task graph actually exists
            # for this session (--architect-first produced a usable plan).
            # No tasks.json is ever created just for this -- same
            # zero-behavior-change-without-a-plan contract C3 itself uses.
            if tasks is not None:
                tasks.append(documentation_task(len(tasks) + 1, doc_impacts))
                save_tasks(session, tasks)

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

    # Task 1.3 (V7 §40): the 4 new deterministic classes, plus the two new
    # architect-review-gate raw statuses main() now writes instead of the
    # single legacy "needs-architect-review" string (kept below for
    # backward compat with archived sessions predating this task).
    assert classify_failure({"status": "needs-architect-review-rejected"}, [])["class"] == "POLICY_BLOCK"
    assert classify_failure({"status": "needs-architect-review-budget-exhausted"}, [])["class"] == "BUDGET_EXHAUSTED"
    assert classify_failure({"status": "needs-architect-review"}, [])["class"] == "POLICY_BLOCK"
    assert classify_failure({"status": "failed-model-unavailable"}, [])["class"] == "MODEL_UNAVAILABLE"
    assert classify_failure({"status": "failed-verification"}, [])["class"] == "VERIFICATION_FAILURE"
    assert classify_failure({"status": "failed-tool-execution"}, [])["class"] == "TOOL_EXECUTION_FAILURE"
    # Task 1.4 (V7 §6): budgets.maxChangedFiles enforcement also classifies
    # as SCOPE_FAILURE (same class as the pre-existing scope_expanded event
    # branch below, different raw-status producer).
    assert classify_failure({"status": "failed-changed-files-budget-exceeded"}, [])["class"] == "SCOPE_FAILURE"

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


def _architect_risk_selfcheck() -> None:
    """Task 2.1 (V7 §5.5): proves compute_architect_risk's scoring table
    signal-by-signal, a combination that crosses ARCHITECT_RISK_THRESHOLD,
    a case that stays below it, and the --architect-first/--no-architect
    flag-interaction rules (validate_architect_flags). No model, no
    session, no subprocess. Run with:
    python3 glimmer-v2.py --architect-risk-selfcheck
    """
    base_contract = {
        "objective": "add a dashboard widget",
        "scope": {"package": "frontend"},
        "mode": "implement",
    }

    # 1. Zero signals -> score 0, no signals, well below threshold.
    zero = compute_architect_risk(base_contract, 0, "minimal")
    assert zero == {"score": 0, "signals": []}
    assert zero["score"] < ARCHITECT_RISK_THRESHOLD

    # 2. Each signal individually.
    refactor = compute_architect_risk({**base_contract, "mode": "refactor"}, 0, "minimal")
    assert refactor == {"score": 3, "signals": ["mode_refactor"]}

    multi_pkg = compute_architect_risk(
        {**base_contract, "scope": {"package": "repository"}}, 0, "minimal")
    assert multi_pkg == {"score": 2, "signals": ["multi_package_scope"]}

    high_candidates = compute_architect_risk(
        base_contract, ARCHITECT_RISK_CANDIDATE_THRESHOLD + 1, "minimal")
    assert high_candidates == {"score": 2, "signals": ["candidate_count_high"]}
    # Exactly-at-threshold does NOT fire (strictly greater-than).
    at_candidate_threshold = compute_architect_risk(
        base_contract, ARCHITECT_RISK_CANDIDATE_THRESHOLD, "minimal")
    assert at_candidate_threshold == {"score": 0, "signals": []}

    protected = compute_architect_risk(
        {**base_contract, "objective": "migrate the auth schema"}, 0, "minimal")
    assert protected == {"score": 3, "signals": ["protected_area_keyword"]}
    # Substring, not whole-token, must NOT false-positive (e.g. "author").
    no_false_positive = compute_architect_risk(
        {**base_contract, "objective": "credit the author of this module"}, 0, "minimal")
    assert no_false_positive == {"score": 0, "signals": []}

    full_verify = compute_architect_risk(base_contract, 0, "full")
    assert full_verify == {"score": 2, "signals": ["verification_full"]}
    # "standard" is not "full" -- no signal.
    assert compute_architect_risk(base_contract, 0, "standard") == {"score": 0, "signals": []}

    # 3. Combination crossing the threshold: mode_refactor (3) +
    # multi_package_scope (2) == 5 == ARCHITECT_RISK_THRESHOLD. Order of
    # signals in the output follows table order regardless of which
    # fields were set on the input.
    combo = compute_architect_risk(
        {"objective": "x", "scope": {"package": "repository"}, "mode": "refactor"}, 0, "minimal")
    assert combo["score"] == 5 == ARCHITECT_RISK_THRESHOLD
    assert combo["signals"] == ["mode_refactor", "multi_package_scope"]

    # 4. Below threshold: any single signal alone (max single signal is 3)
    # never reaches the threshold on its own.
    assert refactor["score"] < ARCHITECT_RISK_THRESHOLD
    assert protected["score"] < ARCHITECT_RISK_THRESHOLD

    # 5. All five signals stack additively, in table order.
    everything = compute_architect_risk(
        {
            "objective": "migrate the payment schema",
            "scope": {"package": "repository"},
            "mode": "refactor",
        },
        ARCHITECT_RISK_CANDIDATE_THRESHOLD + 5,
        "full",
    )
    assert everything == {
        "score": 12,
        "signals": [
            "mode_refactor", "multi_package_scope", "candidate_count_high",
            "protected_area_keyword", "verification_full",
        ],
    }

    # 6. Defensive against malformed/partial input -- never raises.
    assert compute_architect_risk(None, 0, None) == {"score": 0, "signals": []}
    assert compute_architect_risk({}, "not-an-int", "full") == {"score": 2, "signals": ["verification_full"]}

    # 7. Flag-interaction rules (validate_architect_flags): --no-architect
    # wins over the auto-trigger (a separate, main()-side score check --
    # not this function's concern), but --architect-first + --no-architect
    # together is an explicit contradiction and must raise.
    validate_architect_flags(False, False)  # no-op, no error
    validate_architect_flags(True, False)   # --architect-first alone, fine
    validate_architect_flags(False, True)   # --no-architect alone, fine
    try:
        validate_architect_flags(True, True)
        assert False, "expected V2Error for --architect-first + --no-architect"
    except V2Error as exc:
        assert "mutually exclusive" in str(exc)

    print("architect-risk self-check: PASS")


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

    # Fix round 1 (LOW): the two suffixed statuses main() actually writes
    # (Task 1.3) must hit canonical_session_state's explicit prefix-match
    # branch, not fall through to its generic unrecognized-status fallback
    # (both currently return "needs_review", so a plain equality check
    # can't tell them apart -- assert the branch itself is a prefix match).
    assert canonical_session_state("needs-architect-review-rejected") == "needs_review"
    assert canonical_session_state("needs-architect-review-budget-exhausted") == "needs_review"
    canonical_source = inspect.getsource(canonical_session_state)
    assert 'raw_status.startswith("needs-architect-review")' in canonical_source, (
        "must be a prefix match, not an exact match, so the suffixed "
        "statuses hit this branch instead of the generic fallback"
    )

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

    # ------------------------------------------------------------
    # 10. Fix round 1 (Important 1+2): budget increments ONLY on a
    #     REVISE_IMPLEMENTATION disagreement round -- a plain APPROVED/
    #     APPROVED_WITH_CONDITIONS review, and a fail-open (no usable
    #     review output) round, must both be free. Otherwise repeated
    #     approvals across repair iterations pre-block later iterations
    #     (Important 1), and persistent review-machinery failure burns
    #     budget until fail-open degrades into fail-closed (Important 2).
    #     Structural proof via source ordering: the ONE increment site
    #     is only reachable after the review call AND after both the
    #     fail-open break and the approved/rejected break have already
    #     had their chance to fire -- i.e. only on the remaining case,
    #     "revise".
    # ------------------------------------------------------------
    assert main_source.count('manifest["architectReviews"]["used"] += 1') == 1, (
        "budget must increment in exactly one place"
    )
    increment_idx = main_source.index('manifest["architectReviews"]["used"] += 1')
    review_call_idx = main_source.index("review = run_architect_review(")
    fail_open_idx = main_source.index('architect_outcome = "fail_open"')
    approved_rejected_idx = main_source.index("architect_outcome = decision_outcome")
    assert review_call_idx < increment_idx, "increment must happen after the review actually runs"
    assert fail_open_idx < increment_idx, "increment must be unreachable from the fail-open branch"
    assert approved_rejected_idx < increment_idx, "increment must be unreachable from the approved/rejected branch"

    # ------------------------------------------------------------
    # 11. Fix round 1 (HIGH): budgets.maxChangedFiles must be re-checked
    #     AFTER the revise loop's `files = changed_files(...)` recompute,
    #     not just once against the pre-revise diff -- otherwise a
    #     post-revise diff that blows the budget reaches verify() (and
    #     potentially VERIFIED) unchecked. Structural proof via source
    #     ordering: the LAST `changed_files_budget_exceeded(...)` call
    #     site (the one guarding `verifier_commands(...)`) must appear
    #     AFTER the LAST `files = changed_files(ws, baseline)` reassignment
    #     (the one inside the revise loop's `while True:`), so it always
    #     re-checks the post-revise diff before verify() runs.
    # ------------------------------------------------------------
    revise_loop_files_idx = main_source.rindex("files = changed_files(ws, baseline)")
    post_revise_budget_idx = main_source.rindex(
        "changed_files_budget_exceeded(files, args.max_changed_files)"
    )
    assert post_revise_budget_idx > revise_loop_files_idx, (
        "the post-revise budget re-check must come after the revise loop's "
        "`files = changed_files(...)` recompute, so it covers the post-revise diff"
    )

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

    # ------------------------------------------------------------
    # 4b. Fix round 1 (Important 3): reviewer's exact reproduction --
    #     "run"/"npm" are tokens of EVERY npm command, so the old
    #     first-match-on-any-shared-token scheme matched a prose plan
    #     entry to the wrong command whenever the wrong one came first
    #     in `results`. The fix (stopword-stripped token-set argmax)
    #     must pick "npm run typecheck", never "npm run lint", and must
    #     do so regardless of result order.
    # ------------------------------------------------------------
    prose_description = "Run the typecheck to confirm no type errors"
    lint_first = [
        {"command": "npm run lint", "status": "CODE_FAIL"},
        {"command": "npm run typecheck", "status": "PASS"},
    ]
    match = _match_verify_result(prose_description, lint_first)
    assert match is not None and match["command"] == "npm run typecheck", (
        f"prose entry must match the typecheck command, got: {match!r}"
    )
    # Order must not matter -- same result either way.
    typecheck_first = list(reversed(lint_first))
    match2 = _match_verify_result(prose_description, typecheck_first)
    assert match2 is not None and match2["command"] == "npm run typecheck"

    # Reproduce the OLD (first-match-on-any-token) bug directly, so this
    # regression test fails if anyone reverts to that scheme: the naive
    # any-shared-token check (no stopword stripping, first hit wins)
    # picks "npm run lint" first purely because "run" is shared.
    def _old_first_match(description, results):
        old_tokens = {t for t in _TASK_VERIFY_TOKEN_RE.findall(description.lower()) if len(t) >= 3}
        for r in results:
            cmd_tokens = set(_TASK_VERIFY_TOKEN_RE.findall((r.get("command") or "").lower()))
            if old_tokens & cmd_tokens:
                return r
        return None
    assert _old_first_match(prose_description, lint_first)["command"] == "npm run lint", (
        "sanity check: the OLD matcher must reproduce the reviewer's bug on this input"
    )

    # Tie (two results with equal, nonzero overlap) -> unmatched, honest.
    tie_results = [
        {"command": "npm run build", "status": "PASS"},
        {"command": "npm run app", "status": "CODE_FAIL"},
    ]
    assert _match_verify_result("build the app", tie_results) is None, (
        "a genuine tie in token overlap must stay unmatched, never guess"
    )

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


def _doc_impact_selfcheck() -> None:
    """O2 phase 1 (glimmer-v7 reconciliation): proves the deterministic
    change-impact classifier's category boundaries, the honest gate
    semantics (False/None, never True), the REQUIRED task-append wiring,
    and that merging documentationCurrent onto manifest["gates"] never
    clobbers a gate C2 already wrote (architectureApproved). Run with:
    python3 glimmer-v2.py --doc-impact-selfcheck
    """
    # ------------------------------------------------------------
    # 1. Category classification, including the two explicit boundary
    #    cases from the reconciliation doc's O2 entry.
    # ------------------------------------------------------------
    assert detect_documentation_impact(["src/author.ts"]) == [], (
        "author.ts must NOT match auth -- no boundary between 'auth' and 'or'"
    )
    assert detect_documentation_impact(["src/routes/user.ts"]) == ["routes"]
    assert detect_documentation_impact(["src/userRouter.ts"]) == [], (
        "camelCase compound must not match 'router' -- no separator"
    )
    assert detect_documentation_impact(["prisma/schema.prisma"]) == ["schema"]
    assert detect_documentation_impact(["db/migrations/0001_init.sql"]) == ["schema"]
    assert detect_documentation_impact(["src/api/users.ts"]) == ["api"]
    assert detect_documentation_impact(["openapi.yaml"]) == ["api"]
    assert detect_documentation_impact(["webpack.config.js"]) == ["config"]
    assert detect_documentation_impact([".env.example"]) == ["config"]
    assert detect_documentation_impact(["Dockerfile"]) == ["config"]
    assert detect_documentation_impact(["docker-compose.yml"]) == ["config"]
    assert detect_documentation_impact([".github/workflows/ci.yml"]) == ["config"]
    assert detect_documentation_impact(["src/user_auth.py"]) == ["auth"]
    assert detect_documentation_impact(["src/session.ts"]) == ["auth"]
    assert detect_documentation_impact(["src/permissions/check.ts"]) == ["auth"]
    assert detect_documentation_impact(["src/token.ts"]) == ["auth"]

    # Review round 1: camelCase/PascalCase auth/session/token identifiers
    # -- a real practical miss under plain non-alnum-only boundaries,
    # since these compound names have no separator at all between
    # segments.
    assert detect_documentation_impact(["src/AuthService.ts"]) == ["auth"]
    assert detect_documentation_impact(["src/authMiddleware.ts"]) == ["auth"]
    assert detect_documentation_impact(["src/authentication.ts"]) == ["auth"]
    assert detect_documentation_impact(["src/SessionManager.ts"]) == ["auth"]
    # ...but still not author/possession -- plain lowercase continuation,
    # no separator and no case transition either.
    assert detect_documentation_impact(["src/author.ts"]) == []
    assert detect_documentation_impact(["src/Authors.tsx"]) == []
    assert detect_documentation_impact(["src/possession.ts"]) == []

    # Multiple files, multiple categories, deduped + sorted.
    assert detect_documentation_impact(
        ["src/routes/user.ts", "src/api/users.ts", "src/routes/other.ts"]
    ) == ["api", "routes"]
    # Clean change: no category hit anywhere.
    assert detect_documentation_impact(["src/components/Button.tsx", "README.md"]) == []
    # Never raises on None/empty input.
    assert detect_documentation_impact(None) == []
    assert detect_documentation_impact([]) == []

    # ------------------------------------------------------------
    # 2. documentation_task shape: honest kind, pending, no auto-complete.
    # ------------------------------------------------------------
    task = documentation_task(3, ["routes", "auth"])
    assert task["id"] == "t3"
    assert task["kind"] == "documentation"
    assert task["status"] == "pending"
    assert task["dependsOn"] == []
    # C3's existing writers must not touch a documentation-kind task --
    # confirms "it stays pending, nothing auto-completes it, a human
    # closes it".
    tasks = [task]
    set_implementation_tasks_status(tasks, "in_progress")
    assert tasks[0]["status"] == "pending"
    evaluate_implementation_tasks(tasks, ["src/routes/user.ts"], 0)
    assert tasks[0]["status"] == "pending"
    evaluate_verification_tasks(tasks, [{"command": "npm run typecheck", "status": "PASS"}])
    assert tasks[0]["status"] == "pending"
    reset_verification_tasks_status(tasks)
    assert tasks[0]["status"] == "pending"

    # ------------------------------------------------------------
    # 3. The exact gates-merge/task-append logic used in main()'s finally
    #    block, replicated here (main() itself needs a live session to
    #    run end to end) -- on impact: task appended (only when a task
    #    graph exists) + gate False; merge preserves a pre-existing
    #    architectureApproved key. On a clean change: gate None, never
    #    True, no task appended even when a task graph exists.
    # ------------------------------------------------------------
    def _apply(manifest, tasks, changed_files):
        doc_impacts = detect_documentation_impact(changed_files)
        gates = dict(manifest.get("gates") or {})
        gates["documentationCurrent"] = False if doc_impacts else None
        manifest["gates"] = gates
        if doc_impacts and tasks is not None:
            tasks.append(documentation_task(len(tasks) + 1, doc_impacts))
        return doc_impacts

    manifest = {"gates": {"architectureApproved": True}}
    tasks = [{"id": "t1", "kind": "implementation", "status": "complete", "dependsOn": []}]
    impacts = _apply(manifest, tasks, ["src/routes/user.ts"])
    assert impacts == ["routes"]
    assert manifest["gates"]["documentationCurrent"] is False
    assert manifest["gates"]["architectureApproved"] is True, "must not clobber C2's gate"
    assert len(tasks) == 2 and tasks[1]["kind"] == "documentation"

    # Impact but no task graph (no --architect-first plan): gate False,
    # no task appended (nothing to append to -- C3's own zero-behavior-
    # change-without-a-plan contract).
    manifest_no_tasks = {}
    impacts2 = _apply(manifest_no_tasks, None, ["auth/login.ts"])
    assert impacts2 == ["auth"]
    assert manifest_no_tasks["gates"]["documentationCurrent"] is False

    manifest_clean = {"gates": {"architectureApproved": None}}
    tasks_clean = [{"id": "t1", "kind": "implementation", "status": "complete", "dependsOn": []}]
    impacts3 = _apply(manifest_clean, tasks_clean, ["src/components/Button.tsx"])
    assert impacts3 == []
    assert manifest_clean["gates"]["documentationCurrent"] is None
    assert manifest_clean["gates"]["architectureApproved"] is None
    assert len(tasks_clean) == 1, "no doc task on a clean change"

    print("doc-impact (O2 phase 1) self-check: PASS")


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
        commands = expand_verify_entries(
            [["git", "diff", "--check"]], ["VISUAL"], session, "http://x/route",
            "http://127.0.0.1:9999/tools",
        )
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

        # Fix round 2: "visual" now means the real thing -- --vision must
        # be present (a plan that says "visual" but never gets --vision
        # can never leave findings.json at NOT_RUN forever, which was the
        # Major finding), and --model-url must reuse v2's OWN
        # model-readiness URL (not a hardcoded, possibly-wrong default).
        assert "--vision" in visual_cmd
        assert "--model-url" in visual_cmd
        assert "http://127.0.0.1:9999" in visual_cmd, "must derive from model_readiness_url, not hardcode"

        # Default model_readiness_url (no override) resolves through
        # READINESS_URL_DEFAULT, same as every other model-readiness use.
        default_cmd = build_visual_verify_command(session, "http://x/route")
        assert _model_base_url(READINESS_URL_DEFAULT) in default_cmd

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


def _skills_selfcheck() -> None:
    """O1 (glimmer-v7 reconciliation doc): proves frontmatter parsing
    (good/malformed/missing dir), deterministic area+filetype selection,
    specificity ordering, all three hard caps (3 skills / 1.5KB per body
    / 4KB total), zero-injection when nothing matches, and that nothing
    here ever raises -- including on an unreadable file. Run with:
    python3 glimmer-v2.py --skills-selfcheck
    """
    # --- missing dir -> [] ---
    assert load_skills(skills_dir="/no/such/glimmer/skills/dir") == []

    # --- frontmatter parsing: good, malformed variants all skipped ---
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        (d / "a-frontend.md").write_text(
            "---\nname: a-frontend\nareas: frontend, ui\nfiletypes: .tsx\n---\n"
            "# Frontend convention\nUse the shared Button component.\n",
            encoding="utf-8",
        )
        (d / "b-no-close.md").write_text("---\nname: broken\nno closing fence\n", encoding="utf-8")
        (d / "c-no-open.md").write_text("just a markdown file, no frontmatter\n", encoding="utf-8")
        (d / "d-empty-body.md").write_text("---\nname: empty\nareas: frontend\n---\n\n", encoding="utf-8")
        # "Unreadable" file -- a directory named *.md; read_text() raises
        # IsADirectoryError (an OSError subclass). Must be skipped, not raise.
        (d / "e-unreadable.md").mkdir()

        skills = load_skills(skills_dir=d)
        assert [s["name"] for s in skills] == ["a-frontend"], skills

        parsed = skills[0]
        assert parsed["areas"] == ["frontend", "ui"]
        assert parsed["filetypes"] == [".tsx"]
        assert "Button component" in parsed["body"]

    # --- selection matrix: area match / filetype match / no match ---
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        (d / "area-only.md").write_text(
            "---\nname: area-only\nareas: frontend\nfiletypes:\n---\nArea-matched body.\n",
            encoding="utf-8",
        )
        (d / "filetype-only.md").write_text(
            "---\nname: filetype-only\nareas: nomatch\nfiletypes: .ts\n---\nFiletype body.\n",
            encoding="utf-8",
        )
        (d / "no-match.md").write_text(
            "---\nname: no-match\nareas: backend\nfiletypes: .go\n---\nUnrelated body.\n",
            encoding="utf-8",
        )
        skills = load_skills(skills_dir=d)
        assert len(skills) == 3

        contract = {"scope": {"package": "frontend", "paths": ["frontend/client/src/App.ts"]}}
        selected = select_skills(contract, plan=None, skills=skills)
        assert {s["name"] for s in selected} == {"area-only", "filetype-only"}

        # No overlap at all -- unrelated scope, no plan -> no match.
        no_match_contract = {"scope": {"package": "unrelated-service"}}
        assert select_skills(no_match_contract, plan=None, skills=skills) == []

        # Filetype match sourced from plan.candidateFiles when a plan exists.
        plan = {"candidateFiles": [{"path": "src/thing.ts"}]}
        neutral_contract = {"scope": {"package": "zzz"}}
        selected2 = select_skills(neutral_contract, plan=plan, skills=skills)
        assert {s["name"] for s in selected2} == {"filetype-only"}

        # --- specificity ordering: filetype match ranks before area-only ---
        both_contract = {"scope": {"package": "frontend"}}
        both_plan = {"candidateFiles": [{"path": "x.ts"}]}
        ordered = select_skills(both_contract, plan=both_plan, skills=skills)
        assert [s["name"] for s in ordered] == ["filetype-only", "area-only"], ordered

    # --- area match is exact-segment, not raw substring: "ui" must NOT
    #     match a token that merely contains those letters ("build"), but
    #     MUST match when "ui" is its own path segment ("frontend/ui/..."). ---
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        (d / "ui-skill.md").write_text(
            "---\nname: ui-skill\nareas: ui\nfiletypes:\n---\nUI body.\n", encoding="utf-8",
        )
        skills = load_skills(skills_dir=d)
        no_hit_contract = {"scope": {"package": "build"}}
        assert select_skills(no_hit_contract, plan=None, skills=skills) == [], (
            "\"ui\" must not substring-match the unrelated token \"build\""
        )
        hit_contract = {"scope": {"package": "app", "paths": ["frontend/ui/Button.tsx"]}}
        assert [s["name"] for s in select_skills(hit_contract, plan=None, skills=skills)] == ["ui-skill"], (
            "\"ui\" must match its own path segment"
        )

    # --- cap: 4 matching skills -> only 3 injected, filename order among ties ---
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        for n in ("s1", "s2", "s3", "s4"):
            (d / f"{n}.md").write_text(
                f"---\nname: {n}\nareas: frontend\nfiletypes:\n---\nBody for {n}.\n",
                encoding="utf-8",
            )
        skills = load_skills(skills_dir=d)
        assert len(skills) == 4
        selected = select_skills({"scope": {"package": "frontend"}}, plan=None, skills=skills)
        assert len(selected) == MAX_SKILLS_INJECTED == 3
        assert [s["name"] for s in selected] == ["s1", "s2", "s3"]

    # --- cap: oversized single body truncated with its own marker ---
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        big_body = "X" * (MAX_SKILL_BODY_BYTES * 2)
        (d / "big.md").write_text(
            f"---\nname: big\nareas: frontend\nfiletypes:\n---\n{big_body}\n", encoding="utf-8",
        )
        skills = load_skills(skills_dir=d)
        assert len(skills[0]["body"].encode("utf-8")) == MAX_SKILL_BODY_BYTES * 2
        block = build_skills_block({"scope": {"package": "frontend"}}, plan=None, skills=skills)
        assert "[truncated]" in block
        assert len(block.encode("utf-8")) <= MAX_SKILLS_TOTAL_BYTES + 512  # header prose isn't capped, body is

    # --- cap: several under-body-cap skills still trip the total cap ---
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        body = "Y" * 1400  # under MAX_SKILL_BODY_BYTES -- no per-body truncation
        for n in ("t1", "t2", "t3"):
            (d / f"{n}.md").write_text(
                f"---\nname: {n}\nareas: frontend\nfiletypes:\n---\n{body}\n", encoding="utf-8",
            )
        skills = load_skills(skills_dir=d)
        for sk in skills:
            assert len(sk["body"].encode("utf-8")) < MAX_SKILL_BODY_BYTES
        block = build_skills_block({"scope": {"package": "frontend"}}, plan=None, skills=skills)
        assert "[truncated]" not in block, "no single body should hit the per-body cap here"
        assert "[SKILLS BLOCK TRUNCATED" in block

    # --- zero injection when nothing matches: "" exactly, make_prompt unaffected ---
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        (d / "unrelated.md").write_text(
            "---\nname: unrelated\nareas: backend\nfiletypes: .go\n---\nBody.\n", encoding="utf-8",
        )
        contract = {
            "objective": "do the thing", "mode": "code", "constraints": {},
            "scope": {"package": "frontend"},
        }
        assert build_skills_block(contract, plan=None, skills_dir=d) == ""

    # make_prompt byte-identical whether SKILLS_ROOT is empty or has zero
    # matches for this contract -- proves zero behavior change end to end,
    # not just at build_skills_block. Module-global swapped back in `finally`
    # (same pattern as _repomap_cache_selfcheck's REPO_MAP_CACHE_ROOT swap).
    global SKILLS_ROOT
    real_skills_root = SKILLS_ROOT
    contract = {
        "objective": "do the thing", "mode": "code", "constraints": {},
        "scope": {"package": "frontend"},
    }
    try:
        with tempfile.TemporaryDirectory() as empty_td:
            SKILLS_ROOT = Path(empty_td)
            baseline = make_prompt(contract, "repo summary", 0)
        with tempfile.TemporaryDirectory() as unrelated_td:
            (Path(unrelated_td) / "unrelated.md").write_text(
                "---\nname: unrelated\nareas: backend\nfiletypes: .go\n---\nBody.\n",
                encoding="utf-8",
            )
            SKILLS_ROOT = Path(unrelated_td)
            unaffected = make_prompt(contract, "repo summary", 0)
        assert unaffected == baseline
    finally:
        SKILLS_ROOT = real_skills_root

    # --- never raises: missing dir passed straight through the whole pipeline ---
    assert build_skills_block({"scope": {}}, None, skills_dir="/no/such/dir/at/all") == ""

    print("skills (O1) self-check: PASS")


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
    if sys.argv[1:] == ["--architect-risk-selfcheck"]:
        _architect_risk_selfcheck()
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
    if sys.argv[1:] == ["--doc-impact-selfcheck"]:
        _doc_impact_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--skills-selfcheck"]:
        _skills_selfcheck()
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
