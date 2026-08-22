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

# V7 §22.18 deterministic visual requiredness: area words / extensions that
# mark a contract scope or changed-files set as UI-area work, same
# token/extension-match convention as select_skills (below) and O2's
# detect_documentation_impact -- plain deterministic keyword matching, no
# model judgment. Deliberately small and web-generic (not framework-
# specific); extend if a real UI area keeps missing this.
VISUAL_AREA_WORDS = {
    "frontend", "ui", "web", "client", "app", "mobile", "component",
    "components", "view", "views", "page", "pages", "screen", "screens",
}
VISUAL_AREA_EXTENSIONS = {
    ".tsx", ".jsx", ".css", ".scss", ".less", ".html", ".vue", ".svelte",
}
# V7 §22.10: cap on ArchitecturePlan.visualRequirements -- untrusted model
# output (same discipline run_architect_first already applies to
# plan.packages before it ever reaches an event/log/prompt).
MAX_VISUAL_REQUIREMENTS = 20
MAX_VISUAL_REQUIREMENT_CHARS = 300
# Mirrors glimmer-visual.py's own DEFAULT_CHECKS verbatim -- not imported,
# per that script's "stays standalone" module docstring (same mirrored-
# not-imported convention as _extract_json_object elsewhere in this
# codebase). glimmer-visual.py's own --check is a full override of its
# defaults when given at all (its DEFAULT_CHECKS comment: "used only when
# the caller doesn't pass --check at all") -- v2.py needs the literal
# check text here so an ArchitecturePlan's visualRequirements can join the
# basics as EXTRA checks (V7 §22.10: "part of the verification contract",
# not a replacement for it) without changing that override semantics.
VISUAL_DEFAULT_CHECKS = (
    "no clipped or cut-off elements",
    "no unexpected overlapping elements",
    "all visible text is readable",
    "no elements rendered outside the viewport",
    "no horizontal overflow",
)

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
    # Task 2.3 (V7 §5.10/§5.11): TECHNICALLY_VERIFIED but one or more
    # mandatory gates did not hold -- NEEDS_REWORK. Review round 1
    # (Important): three genuinely distinct causes share this one raw
    # status (scope-guard expansion, engineer rc!=0 after a passing diff,
    # a real consistency-review rejection); describe_blocked_gates builds
    # an honest, cause-naming detail from manifest["blockedGates"] instead
    # of one fixed string that was wrong for two of the three.
    if raw == "needs-architect-review-consistency-rejected":
        return {"class": "POLICY_BLOCK", "detail": describe_blocked_gates(manifest), "evidenceIds": []}
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
    # compatible groundwork only (no current call site produces this raw
    # status), exercised in _r6_selfcheck with a synthetic status.
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


# V7 §18: "standard" is required's own level; the tier immediately above it
# is what standard's *recommended* set borrows from. "full" has nothing
# above it, so its recommended set is always empty.
NEXT_VERIFICATION_LEVEL = {"minimal": "standard", "standard": "full", "full": None}


def visual_requiredness(level, visual_url, contract, files, plan):
    """V7 §22.18 deterministic rule table for where the visual check lands.
    Pure decision function (no side effects, no command-building) so the
    rule table is independently testable from verification_plan's
    command-assembly plumbing below.

    | --visual-url | level      | frontend-area match OR plan.visualRequirements | outcome     |
    |--------------|------------|--------------------------------------------------|--------------|
    | absent       | any        | any                                                | "absent"     |
    | present      | minimal    | any                                                | "recommended"|
    | present      | standard+  | no                                                 | "recommended"|
    | present      | standard+  | yes                                                | "required"   |

    "absent" preserves the existing honest convention verbatim: no
    --visual-url means no auto-added visual check at all (an explicit
    "visual" --verify/contract.verification entry still fails loud via
    validate_visual_url, unrelated to this function). "required" only at
    standard+ -- minimal level never auto-requires a visual check,
    regardless of scope/plan, though it can still be recommended.
    """
    if not visual_url:
        return "absent"
    visual_requirements = sanitize_visual_requirements(plan)
    frontend_match = visual_scope_matches_frontend(contract, files)
    if level in ("standard", "full") and (frontend_match or visual_requirements):
        return "required"
    return "recommended"


def verification_plan(m, files, level, verify_entries, session, visual_url,
                       model_readiness_url=READINESS_URL_DEFAULT, contract=None, plan=None):
    """V7 §18: split the verification plan into required (gates VERIFIED --
    exactly what verifier_commands+expand_verify_entries has always built
    for `level`, plus any explicit --verify/contract.verification entries)
    and recommended (deterministically the NEXT level's extra commands,
    e.g. minimal's recommended is standard's lint; standard's recommended is
    full's test+build). Recommended commands are run (see verify()'s `tier`
    param) but never gate VERIFIED -- see the main() call site's `if ok:`
    guard and gates_block_verified, neither of which ever reads them.

    V7 §22.18 (Task 3.3): on top of that existing split, deterministically
    place an AUTO visual check (i.e. one the caller didn't already spell
    out via --verify/contract.verification's literal "visual" token) into
    required or recommended per visual_requiredness's rule table above.
    `contract`/`plan` are optional (default None) so every pre-3.3 caller
    -- including --verification-plan-selfcheck's existing calls, which
    never pass them -- is unaffected: visual_scope_matches_frontend(None,
    files) and sanitize_visual_requirements(None) both degrade to no
    match/[], so with no contract/plan this reduces to "recommended
    whenever --visual-url is set, absent otherwise" -- and when
    --visual-url is also None (every existing self-check call), nothing
    changes at all.
    """
    required = verifier_commands(m, files, level)
    required = expand_verify_entries(required, verify_entries, session, visual_url, model_readiness_url,
                                      visual_requirements=sanitize_visual_requirements(plan))
    next_level = NEXT_VERIFICATION_LEVEL.get(level)
    recommended = []
    if next_level:
        required_keys = {tuple(c) for c in required}
        recommended = [c for c in verifier_commands(m, files, next_level) if tuple(c) not in required_keys]

    # An explicit "visual" --verify/contract.verification entry already
    # expanded into `required` above (expand_verify_entries) -- never
    # auto-add a second one on top of it.
    already_visual = any(is_visual_check_command(c) for c in required)
    outcome = visual_requiredness(level, visual_url, contract, files, plan)
    if outcome != "absent" and not already_visual:
        visual_cmd = build_visual_verify_command(
            session, visual_url, model_readiness_url,
            visual_requirements=sanitize_visual_requirements(plan),
        )
        if outcome == "required":
            required.append(visual_cmd)
        else:
            recommended.append(visual_cmd)

    return {"required": required, "recommended": recommended}


def _model_base_url(readiness_url):
    """Derive the bare http://host:port glimmer-visual.py's --model-url
    wants from v2's EXISTING model-readiness URL (same llama-server, just
    a different path -- READINESS_URL_DEFAULT/--model-readiness-url hits
    .../tools; glimmer-visual.py appends /v1/chat/completions itself).
    Not a new source of truth -- reuses the one v2 already has."""
    parts = urllib.parse.urlsplit(readiness_url)
    return f"{parts.scheme}://{parts.netloc}"


def sanitize_visual_requirements(plan):
    """V7 §22.10: ArchitecturePlan.visualRequirements is optional, untrusted
    model output -- v2 (the trusted layer) treats it exactly like
    run_architect_first already treats plan.packages before it reaches an
    event/prompt: tolerant of absence (no field, wrong type, `plan` itself
    None -- all -> []), and capped so a runaway/malicious value can't
    bloat the vision model's own contract text (MAX_VISUAL_REQUIREMENTS
    entries, MAX_VISUAL_REQUIREMENT_CHARS each). Non-string / blank
    entries are dropped rather than coerced -- same "don't fabricate
    substance" principle glimmer-visual.py's own _coerce_finding applies
    to the vision model's findings."""
    if not plan:
        return []
    raw = plan.get("visualRequirements")
    if not isinstance(raw, list):
        return []
    return [
        v.strip()[:MAX_VISUAL_REQUIREMENT_CHARS]
        for v in raw[:MAX_VISUAL_REQUIREMENTS]
        if isinstance(v, str) and v.strip()
    ]


def visual_scope_matches_frontend(contract, files):
    """V7 §22.18 deterministic requiredness: is this a UI-area session?
    Reuses select_skills' own two signals (scope area/paths token match,
    changed-file extension match) rather than inventing a third matching
    convention -- a contract scope of e.g. "frontend"/"ui"/"web client"
    tokenizes and hits VISUAL_AREA_WORDS the same way select_skills'
    area_hit does, and a changed .tsx/.css/... file hits VISUAL_AREA_
    EXTENSIONS the same way its filetype_hit does. Never raises: a
    missing/malformed contract or files list degrades to False (no
    match), never an exception."""
    try:
        scope_tokens = set(_segment_tokens(_skills_scope_text(contract)))
        if scope_tokens & VISUAL_AREA_WORDS:
            return True
        exts = {os.path.splitext(str(f))[1].lower() for f in (files or [])}
        return bool(exts & VISUAL_AREA_EXTENSIONS)
    except Exception:  # noqa: BLE001 -- a requiredness check must never crash the verification plan
        return False


def build_visual_verify_command(session, url, model_readiness_url=READINESS_URL_DEFAULT,
                                 visual_requirements=None):
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

    V7 §22.10: `visual_requirements` (already sanitize_visual_requirements-
    capped by the caller) become extra --check entries alongside
    glimmer-visual.py's own DEFAULT_CHECKS -- the Architect's UX
    constraints join the vision contract instead of replacing it.
    """
    out_dir = session / "visual"
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, str(GLIMMER_VISUAL), "--url", url, "--output-dir", str(out_dir)]
    for vp in VISUAL_DEFAULT_VIEWPORTS:
        cmd += ["--viewport", vp]
    cmd += ["--vision", "--model-url", _model_base_url(model_readiness_url)]
    if visual_requirements:
        # glimmer-visual.py's --check replaces its own defaults when given
        # at all -- send the basics explicitly alongside the extras so
        # visualRequirements genuinely ADD to the contract instead of
        # silently dropping the V7 §22.2 basics.
        for check in VISUAL_DEFAULT_CHECKS:
            cmd += ["--check", check]
        for req in visual_requirements:
            cmd += ["--check", req]
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
                           model_readiness_url=READINESS_URL_DEFAULT, visual_requirements=None):
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

    Fix round 3: `visual_requirements` (already sanitize_visual_requirements-
    capped by the caller) threads straight through to
    build_visual_verify_command, same as the auto-added visual check
    verification_plan builds a few lines below its own call to this
    function. Without this, an EXPLICIT "visual" --verify/contract.
    verification entry -- the most deliberate way a caller opts into
    vision review -- silently dropped the Architect's own
    visualRequirements, while the auto-added path kept them. Default
    None degrades to build_visual_verify_command's own no-requirements
    behavior, so every pre-existing caller is unaffected.
    """
    for raw in raw_entries:
        if raw.strip().lower() == VISUAL_VERIFY_TOKEN:
            cmd = build_visual_verify_command(session, visual_url, model_readiness_url,
                                               visual_requirements=visual_requirements)
        else:
            cmd = shlex.split(raw)
        if cmd and cmd not in commands:
            commands.append(cmd)
    return commands


def visual_state_count(session):
    """V7 §22.7/Task 3.3: best-effort, read-only peek at visual-manifest.
    json's "states" list for the visual_verification_started/completed
    events' `stateCount` field. Deterministic and side-effect-free: reads
    the same file classify_visual_check_result reads right after this,
    so both events derive stateCount from one snapshot. Never raises --
    missing/unreadable/malformed manifest (a genuine capture failure, or
    simply nothing written yet) returns None so the caller can omit the
    field rather than fabricate a count; every manifest glimmer-visual.py
    itself ever writes (pre- or post-3.3) always has a "states" list
    (default ["initial"]), so this is 1 for every single-state run."""
    try:
        manifest_doc = json.loads((Path(session) / "visual" / "visual-manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    states = manifest_doc.get("states")
    return len(states) if isinstance(states, list) else None


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
           events_path=None, session_id=None, tier="required", fail_fast=True):
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
                # V7 §22.7 (Task 3.3): one deterministic read of visual-
                # manifest.json's states, shared by both events below --
                # run_verifier_command (just above) already ran
                # glimmer-visual.py to completion, so the manifest it
                # wrote is on disk by now for either event to read.
                state_count = visual_state_count(session)
                if events_path is not None:
                    emit_event(events_path, "visual_verification_started", session_id,
                               command=label, stateCount=state_count)
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
                               status=result["status"], stateCount=state_count)

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

            # V7 §18: tier is a plain tag on the result, not a second
            # verify() code path -- "required"/"recommended" only changes
            # how the CALLER treats the aggregate (gating vs. reported-only)
            # and whether fail_fast stops at the first failure.
            result["tier"] = tier
            results.append(result)
            (session / f"verify-{iteration:02d}-{i:02d}.json").write_text(
                json.dumps(result, indent=2), encoding="utf-8"
            )
            if events_path is not None:
                emit_event(events_path, "verification_completed", session_id, check=label,
                           status=result["status"], baselineAware=bool(result.get("baseline")),
                           tier=tier)
            if result["status"] == "PASS":
                print("PASS")
            elif result["status"] == "PASS_BASELINE":
                print("PASS (baseline-aware: no new failures)")
            else:
                print(result["status"])

            if not result.get("ok"):
                if result.get("outputTail"):
                    print(result["outputTail"][-5000:])
                if fail_fast:
                    return False, results
        # fail_fast=True (default) only ever reaches here with every result
        # ok -- identical to the pre-§18 `return True, results`. fail_fast=
        # False (recommended tier) can reach here with a failure recorded
        # above without having stopped the loop, so the aggregate must be
        # computed for real rather than assumed true.
        return all(r.get("ok") for r in results), results
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


# V7 §21: heuristic used ONLY to decide whether a failing check's own output
# is worth mining for test-file paths -- SCRIPT_GROUPS["test"] names
# ("test", "test:ci", "vitest") are all substrings of the resulting
# `npm [--prefix <dir>] run <name>` / raw command text.
# ponytail: substring match, not a real "which SCRIPT_GROUPS bucket did this
# come from" lookup -- upgrade to threading the group name through
# verifier_commands if a script literally named e.g. "testlint" ever
# misfires this.
def is_test_check_command(command_label):
    low = (command_label or "").lower()
    return "test" in low or "vitest" in low


# Conservative: only matches paths that look like test files (a
# ".test."/".spec." JS/TS file), and build_repair_contract below additionally
# requires the path to exist in the workspace before trusting it.
TEST_FILE_PATH_RE = re.compile(r"[\w./-]+\.(?:test|spec)\.[jt]sx?")


def extract_existing_test_files(output_text, ws):
    found = []
    ws_resolved = Path(ws).resolve()
    for m in TEST_FILE_PATH_RE.finditer(output_text or ""):
        rel = m.group(0)
        # Containment guard: failure output is model/tool-adjacent text — a
        # match like "../secret.test.ts" must never leak path-existence
        # outside the workspace into allowedFiles/repair-NN.json.
        if ".." in rel.split("/"):
            continue
        candidate = (ws_resolved / rel)
        try:
            if not candidate.resolve().is_relative_to(ws_resolved):
                continue
        except OSError:
            continue
        if rel not in found and candidate.is_file():
            found.append(rel)
    return found


def build_repair_contract(attempt_number, results, files, ws):
    """V7 §21 structured repair contract, built once verify() returns
    ok=False for the REQUIRED tier (`results` is that tier's result list).

    failedCheck names the first failing result (fail_fast=True for the
    required tier means there is at most one). newFailures is that check's
    own newErrorSignatures, capped -- the same signal failure_text already
    surfaces in prose, just kept machine-shaped here.

    allowedFiles is deterministic GUIDANCE, not an enforced boundary: the
    changed-files set so far, plus -- only when the failing check is itself
    a test runner -- any test file path named in its output that actually
    exists in the workspace (conservative extraction: regex match AND an
    existing-file check, never a bare string guess)."""
    failing = next((r for r in results if not r.get("ok")), None)
    # C4 fix round 3: a failing visual check (V7 §22.5 CODE_FAIL) never has
    # newErrorSignatures -- verify() excludes the visual check from the
    # baseline-worktree comparison that populates that field (see verify()'s
    # `and not is_visual` guard) -- so without this, a required visual
    # failure handed the engineer an empty newFailures list: a blind repair
    # round. visualBlockingFindings (classify_visual_check_result) carries
    # the actual defect list instead.
    if failing and failing.get("visualBlockingFindings"):
        new_failures = [
            f"{f.get('severity')}: {f.get('category')} — {f.get('description')}"
            for f in failing["visualBlockingFindings"]
        ][:50]
    else:
        new_failures = (failing.get("newErrorSignatures") or [])[:50] if failing else []
    allowed = list(dict.fromkeys(files))  # de-dup, preserve order
    if failing and is_test_check_command(failing.get("command", "")):
        for f in extract_existing_test_files(failing.get("outputTail", ""), ws):
            if f not in allowed:
                allowed.append(f)
    return {
        "attempt": attempt_number,
        "failedCheck": failing.get("command") if failing else None,
        "newFailures": new_failures,
        "allowedFiles": allowed,
    }


def compute_repair_writes_outside_allowed(files, repair_contract):
    """V7 §21, advisory only: allowedFiles is a heuristic guidance signal
    (see build_repair_contract), not a hard scope like compute_scope_guard's
    contract-derived boundary -- a real fix legitimately touches a file this
    heuristic never named (e.g. the implementation file a stack trace never
    mentions). Never blocks; the caller only prints a WARN and records this
    list on the attempt, same advisory treatment as scope guard's own
    "unbounded" case."""
    if not repair_contract:
        return []
    allowed = set(repair_contract.get("allowedFiles") or [])
    return [f for f in files if f not in allowed]


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


def make_architect_prompt(contract, summary, ws=None):
    """C1 (glimmer-v7): the "task" text handed to `glimmer-engineer.py
    --mode architect` — NOT make_prompt's full engineering OPERATING
    CONTRACT (that prose is write-loop-specific: freeze rules, diff/
    validation instructions, none of which apply to a read-only planning
    run). Architect mode's own system prompt (glimmer-engineer.py's
    ARCHITECT_SYSTEM_PROMPT) already carries the permissions/output-shape
    instructions; this is just the objective + contract + repo map it
    needs to plan against.

    Task 7.3 (V7 "ADR consultation"): `ws` (optional, defaults to None so
    every pre-existing 2-arg call site is byte-for-byte unaffected) is
    passed straight to build_adr_prompt_section, which appends "" whenever
    there's nothing to add -- so this stays the exact same prompt for any
    repo with no docs/decisions/ or no matching ADR.
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
    """).strip() + build_adr_prompt_section(contract, ws)



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


# Task 5.3 (V7 §27): deterministic candidate-file ranking. Four signals,
# weights summing to 1.0 so a "perfect" candidate scores exactly 1.0:
#
#   scope match        0.4  -- path falls inside contract.scope's own
#                               boundary (_expected_prefixes(scope): the
#                               SAME paths/area/frontend-backend
#                               boundary-safe prefix match compute_scope_
#                               guard already uses -- reused, not
#                               reimplemented)
#   package match       0.2  -- import proximity: the file's containing
#                               repo-map package (best_package) is the
#                               same package named in
#                               contract.scope.package
#   recent change       0.2  -- `git log -1 --format=%ct` age bucket
#                               (<=7d full credit, <=30d partial, <=90d
#                               minimal, else 0); capped to the FIRST 20
#                               files (repo-wide git log calls are not
#                               free)
#   objective keyword   0.2  -- a >=4-char word from contract.objective
#                               (stopwords excluded) appears in the
#                               candidate's own filename
#
# No "symbol match"/"failing stack trace"/"ownership" signals (V7 §27's
# full example list) -- this repo has no symbol index or blame data to
# draw on yet; add those signals if/when a real consumer needs them
# (YAGNI).
_RANK_STOPWORDS = {
    "this", "that", "with", "from", "into", "when", "then", "than",
    "have", "has", "the", "and", "for", "are", "was", "were", "will",
    "should", "would", "could", "must", "make", "makes", "adds", "bug",
    "issue", "task", "please", "code", "file", "files", "function",
    "class", "using", "used", "user", "does",
}


def _rank_keywords(objective):
    words = re.findall(r"[a-zA-Z][a-zA-Z0-9_]{3,}", (objective or "").lower())
    return sorted({w for w in words if w not in _RANK_STOPWORDS})


def _rank_recent_change(ws, path, cache):
    """git log -1 --format=%ct for one path, memoized in the caller-owned
    `cache` dict (fresh per rank_candidates call -- never module-global,
    so results never leak between unrelated calls/repos)."""
    if path in cache:
        return cache[path]
    result = (0.0, None)
    try:
        out = git(ws, "log", "-1", "--format=%ct", "--", path, check=False)
        if out.strip():
            ts = int(out.strip())
            age_days = max(0.0, (time.time() - ts) / 86400.0)
            if age_days <= 7:
                result = (0.2, f"recent-change({int(age_days)}d)")
            elif age_days <= 30:
                result = (0.12, f"recent-change({int(age_days)}d)")
            elif age_days <= 90:
                result = (0.05, f"recent-change({int(age_days)}d)")
    except (ValueError, OSError):
        result = (0.0, None)
    cache[path] = result
    return result


def rank_candidates(files, signals):
    """Task 5.3 (V7 §27): deterministic candidate-file ranking -- see the
    weight table comment above. `files` is a list of candidate path
    strings (workspace-relative, as they appear in an ArchitecturePlan's
    candidateFiles / _collect_plan_evidence_targets); `signals` is a
    plain dict, every key optional:
        {"scope": contract["scope"], "ws": Path, "repo_map": dict,
         "objective": contract["objective"]}
    Any absent/None signal simply contributes 0 to every file (never
    raises, never excludes a file). Returns
    [{"path", "score", "reasons"}] sorted by score desc, then path asc --
    fully deterministic, stable even between equal-score files.
    """
    scope = signals.get("scope") or {}
    ws = signals.get("ws")
    repo_map = signals.get("repo_map")

    expected_prefixes = [p.rstrip("/") for p in _expected_prefixes(scope) if p]
    scope_package = scope.get("package")
    keywords = _rank_keywords(signals.get("objective"))
    git_cache = {}

    ranked = []
    for index, raw_path in enumerate(files or []):
        if not isinstance(raw_path, str) or not raw_path.strip():
            continue
        path = raw_path.strip()
        norm = path.strip("/")
        score = 0.0
        reasons = []

        if expected_prefixes and any(norm == p or norm.startswith(p + "/") for p in expected_prefixes):
            score += 0.4
            reasons.append("scope-path-match")

        # Fix round 1 (LOW): .get("packages", []) rather than trusting
        # repo_map to always carry a "packages" list -- best_package
        # indexes m["packages"] directly and would KeyError on a
        # malformed/partial repo_map dict otherwise.
        if repo_map and scope_package and repo_map.get("packages", []):
            pkg = best_package(repo_map, path)
            if pkg and scope_package in (pkg.get("name"), pkg.get("dir")):
                score += 0.2
                reasons.append(f"package-match:{pkg.get('dir')}")

        if ws is not None and index < 20:
            rc_score, rc_reason = _rank_recent_change(ws, path, git_cache)
            if rc_score:
                score += rc_score
                reasons.append(rc_reason)

        basename = Path(path).stem.lower()
        matched_kw = next((kw for kw in keywords if kw in basename), None)
        if matched_kw:
            score += 0.2
            reasons.append(f"keyword:{matched_kw}")

        ranked.append({"path": path, "score": round(score, 3), "reasons": reasons})

    ranked.sort(key=lambda c: (-c["score"], c["path"]))
    return ranked


# Task 5.3: how many of rank_candidates' top scorers get a candidate_
# selected event per plan (the event's docstring/V7 §24 "the model can
# reason over the top candidates rather than search blindly" -- this is
# the observability side of that, not a cap on how many candidates get
# ranked/reordered, which is unbounded).
CANDIDATE_SELECTED_TOP_N = 5


def _rerank_plan_candidates(architecture_plan, contract, repo_map, ws, events_path, sid):
    """Task 5.3 (V7 §27): reorder plan.candidateFiles by rank_candidates'
    deterministic score (highest first) and emit the previously-unfired
    candidate_selected event for the top CANDIDATE_SELECTED_TOP_N.
    In-place on architecture_plan's own list -- every existing consumer
    (the manifest snapshot, architecture-plan.json, check_post_
    verification_consistency, make_prompt's plan_fields) cares about SET
    membership, never list order, so reordering here is safe. Never
    raises: any failure leaves candidateFiles in the architect's original
    order and skips the event (same degrade-quietly discipline as the
    rest of the C1/C2 plan-handling code).

    Fix round 1 (LOW): returns the computed {path: score} dict (None on
    any early-return/failure) so the caller can thread it into
    read_candidate_evidence right after -- a SINGLE rank_candidates call
    per plan, not two independent ones over two different file-list
    windows (which could redundantly git-log the same path twice and,
    worse, score it differently depending on which list it landed in the
    first 20 of)."""
    try:
        if not architecture_plan:
            return None
        candidates = architecture_plan.get("candidateFiles")
        if not isinstance(candidates, list) or not candidates:
            return None
        paths = [c.get("path") for c in candidates if isinstance(c, dict) and isinstance(c.get("path"), str)]
        if not paths:
            return None

        signals = {
            "scope": contract.get("scope") or {},
            "ws": ws,
            "repo_map": repo_map,
            "objective": contract.get("objective"),
        }
        ranked = rank_candidates(paths, signals)
        rank_index = {r["path"]: i for i, r in enumerate(ranked)}
        candidates.sort(key=lambda c: rank_index.get(c.get("path"), len(ranked)))

        for r in ranked[:CANDIDATE_SELECTED_TOP_N]:
            emit_event(events_path, "candidate_selected", sid, file=r["path"], reasons=r["reasons"])

        return {r["path"]: r["score"] for r in ranked}
    except Exception as exc:  # noqa: BLE001 - ranking/event-emission must never break the run
        print(f"[V2] WARN: candidate ranking failed: {exc}")
        return None


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


def read_candidate_evidence(plan, ws, rank_by_path=None):
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

    Selection: `rank_by_path` (Task 5.3, a {path: score} dict) is an
    OPTIONAL pre-computed rank_candidates result -- when passed, its
    score becomes the PRIMARY sort key (highest first), with the
    original numeric-"confidence" ordering as the tie-break. Fix round 1
    (LOW): this function used to take `contract`/`repo_map` and run its
    own independent rank_candidates call -- since _rerank_plan_candidates
    (main()'s call site right before this one) already ranks the SAME
    plan's candidateFiles, that was a second, redundant computation that
    could score the same path differently (a second, different 20-file
    git-log recency window) purely from being invoked with a different
    file list/order. Callers now compute rank_candidates ONCE
    (_rerank_plan_candidates) and thread its score dict through here.
    Defaults to None, in which case behavior is byte-identical to before
    Task 5.3: entries with a numeric "confidence" (candidateFiles only)
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

    if rank_by_path:
        usable.sort(key=lambda c: (-rank_by_path.get(c["path"], 0.0), _confidence_key(c)))
    else:
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


def _first_focus_task(tasks, in_repair: bool = False):
    """Task 4.2 (V7 task list, "Task focus") + fix round 1 (IMPORTANT 4):
    the single active task Engineer should work on next.

    `in_repair` is True exactly when make_prompt was called with a
    repair_contract (a REPAIR N round, not the first attempt): focus the
    NEWEST kind=="repair" task (last in list order -- create_repair_task
    ids are allocated monotonically via _next_task_id, so the newest
    repair task is always last) instead of the first-pending-required
    rule below. A repair round exists to fix ONE specific failing check;
    pointing Engineer at whatever plan-derived task happens to be first-
    pending-required (likely already "complete" or unrelated to the
    failure that triggered this round) would be actively misleading.
    Falls through to the general rule if no repair task exists yet
    (shouldn't happen when in_repair is True, but never crash over it).

    Otherwise (iteration 0, no repair round): the FIRST priority==
    "required" task still status=="pending", in `tasks`' own list order.
    derive_tasks builds `tasks` as a strict sequential chain
    (implementation steps first, each depending on the previous;
    verification steps after, each depending on the last implementation
    step -- see its own docstring: "deliberately not a DAG/priority
    model"), so list order already IS dependency order here; no separate
    topological sort is needed.

    Returns None when there is no such task (nothing pending, nothing
    required, or tasks is None/empty) -- make_prompt then omits the FOCUS
    block entirely."""
    if not tasks:
        return None
    if in_repair:
        repair_tasks = [t for t in tasks if t.get("kind") == "repair"]
        if repair_tasks:
            return repair_tasks[-1]
    for t in tasks:
        if t.get("priority") == "required" and t.get("status") == "pending":
            return t
    return None


def make_prompt(contract, summary, iteration, failure=None, checkpoint_sha=None, plan=None, evidence=None,
                 repair_contract=None, tasks=None):
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
        # V7 §21: rendered on top of the freeform failure block above --
        # same underlying facts, machine-shaped, so the engineer doesn't
        # have to re-derive failedCheck/newFailures from prose. Only ever
        # added when the caller actually built a contract (every pre-§21
        # call site passes nothing here, so this stays byte-identical to
        # the old prompt for them). allowedFiles is explicitly labeled
        # GUIDANCE, not an enforced boundary -- see
        # compute_repair_writes_outside_allowed's advisory-only check.
        if repair_contract is not None:
            repair += f"""
STRUCTURED REPAIR CONTRACT (V7 §21):
{json.dumps(repair_contract, indent=2)}

allowedFiles above is GUIDANCE ONLY, derived from the changed-files set so
far plus (for a failing test check) existing test file paths named in its
own output -- not an enforced boundary. Prefer touching only those files;
a genuine fix may still require another file if the evidence supports it.
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
        # Task 2.2 (V7 §5.12): "Engineer should always know which
        # ArchitecturePlan version it is implementing." plan.get("version")
        # defaults to 1 -- every plan reaching here was already stamped by
        # run_architect_first/run_architect_replan, but this stays honest
        # if a caller ever passes a hand-built plan dict without one.
        plan_block = (
            f"\n\nARCHITECTURE PLAN v{plan.get('version', 1)} (from Architect "
            "mode; a hint from prior read-only exploration, not a "
            "substitute for your own verification — if evidence "
            "contradicts it, deviate and say why):\n"
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

    # Task 4.2 ("Task focus"): appended AFTER the existing template's
    # .strip() below, same additive convention plan_block/repair_contract
    # already follow -- absent `tasks` (every pre-4.2 call site, and any
    # session with no architect plan), output is byte-identical to the
    # pre-4.2 prompt. Only ever non-empty when a plan-derived task graph
    # exists AND at least one required task is still pending (see
    # _first_focus_task) -- a fully in-flight/complete task list omits
    # this block too, same as "no plan at all".
    focus_block = ""
    focus_task = _first_focus_task(tasks, in_repair=repair_contract is not None)
    if focus_task is not None:
        focus_block = (
            "\n\nFOCUS TASK (V7 task list — work on this task first; other "
            "tasks below are context, not your current assignment):\n"
            + json.dumps({
                "id": focus_task.get("id"),
                "description": focus_task.get("description"),
                "kind": focus_task.get("kind"),
                "affectedFiles": focus_task.get("affectedFiles") or [],
                "blockingReason": focus_task.get("blockingReason"),
            }, indent=2)
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
    """).strip() + plan_block + focus_block + build_skills_block(contract, plan)


def invoke_engineer(engineer, ws, prompt, auto_approve, max_turns, log_path, events_path, session_id, mode=None,
                     plan_candidate_count=0, review_request=None, architect_consult_enabled=False):
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
    # Task 2.4 (V7 §5.5 second half): only ever passed True alongside a
    # real engineer run (mode is None) that has a usable architecture
    # plan — every caller below gates this on `architecture_plan is not
    # None`, mirroring plan_candidate_count's own gating just above.
    # glimmer-engineer.py itself still requires a plan to exist at
    # startup before it offers consult_architect at all (see
    # _augment_tools_with_consult_architect), so this flag alone can
    # never enable the tool without one.
    if architect_consult_enabled:
        cmd.append("--architect-consult-enabled")
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
# "mode == refactor": review round 1 fix -- "refactor" is now a real
# --mode choice (and a real @glimmer/shared TaskContract.mode union
# member, control-center branch v7-r2-architect), so this signal is
# reachable end-to-end, not just forward-compatible dead code.
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
        architect_prompt = make_architect_prompt(contract, summary, ws)
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
        # Task 2.2 (V7 §5.12): the architect-first plan is always version 1
        # -- versioning is v2.py's (the trusted layer's) responsibility,
        # never the model's. Replans (run_architect_replan, below) stamp
        # version N+1 the same way.
        plan["version"] = 1
        print(f"[V2] Architect plan loaded: risk={plan.get('risk')!r}, packages={plan.get('packages')!r}")
        # NIT (fix round 1): packages is model-controlled (architect's own
        # JSON output) -- cap entry count and per-entry length so a
        # runaway/malicious value can't bloat events.jsonl.
        packages = plan.get("packages")
        if isinstance(packages, list):
            packages = [str(p)[:200] for p in packages[:20]]
        emit_event(events_path, "architect_plan_created", sid,
                   risk=plan.get("risk"), packages=packages, version=1)
    else:
        print("[V2] Architect produced no usable plan (missing/invalid/failed); proceeding without it.")

    return plan


# ============================================================
# Task 2.2 (glimmer-v7): re-planning loop + plan versions — V7 §5.12
# ============================================================
# Triggered only from inside the C2 review loop below, on a REPLAN_REQUIRED
# decision. Reuses run_architect_first's exact spawn/load machinery (same
# mode="architect" invocation, same never-raises contract, same load_
# architecture_plan uniform-None-on-any-failure reader) with an extended
# prompt instead of the plain v1 prompt. Versioning itself is v2.py's
# (the trusted layer's) responsibility, never the model's -- the plan
# dict is stamped with plan["version"] AFTER validation/load, same spirit
# as C1's read_candidate_evidence treating model output as untrusted.


def make_architect_replan_prompt(contract, summary, review, from_version, ws=None):
    """V7 §5.12: the re-planning prompt. Reuses make_architect_prompt's
    exact planning-mode text (objective + contract + repo map [+ any
    matching ADRs, Task 7.3], byte-identical prefix) and APPENDS the
    prior review's findings/requiredChanges as evidence of why plan
    v{from_version} was rejected, so the architect revises instead of
    re-deriving from scratch with no memory of what failed. `review` is
    whatever load_architect_review returned (already normalized:
    findings/requiredChanges default to [] when absent) -- never raises
    on an empty/None review, same tolerant-but-honest bar as
    architect_review_failure_text. `ws` (optional) is forwarded straight
    to make_architect_prompt; omitting it reproduces the exact pre-Task-
    7.3 prompt.
    """
    review = review or {}
    findings = review.get("findings") or []
    required_changes = review.get("requiredChanges") or []

    lines = [
        f"ArchitecturePlan v{from_version} was rejected by pre-verification "
        f"review (decision: {review.get('decision', 'REPLAN_REQUIRED')}). "
        f"Produce a REVISED ArchitecturePlan (same JSON shape as before) "
        f"that addresses this evidence of why v{from_version} failed:"
    ]
    if findings:
        lines.append("Findings:")
        lines.extend(f"  - {f}" for f in findings)
    if required_changes:
        lines.append("Required changes:")
        lines.extend(f"  - {c}" for c in required_changes)
    if not findings and not required_changes:
        lines.append("  (review produced no specific findings/requiredChanges)")

    return make_architect_prompt(contract, summary, ws) + "\n\n" + "\n".join(lines)


def run_architect_replan(engineer, ws, contract, summary, session, events_path, sid,
                          review, from_version, to_version):
    """V7 §5.12: re-invoke the architect after a REPLAN_REQUIRED decision.
    Must never raise (same contract as run_architect_first): any failure
    degrades to returning None, which the caller (main()'s review loop)
    treats as a fail-CLOSED replan -- never silently continuing on the
    just-rejected v{from_version} plan.
    """
    print("\n" + "=" * 72)
    print(f" [V2] Architecture re-plan v{from_version} -> v{to_version} (REPLAN_REQUIRED)")
    print("=" * 72)

    try:
        replan_prompt = make_architect_replan_prompt(contract, summary, review, from_version, ws)
        (session / f"architect-replan-{to_version}-prompt.txt").write_text(replan_prompt, encoding="utf-8")

        # Fix round 1 (HIGH): architecture-plan.json already holds
        # v{from_version} (record_architecture_plan_version wrote it there
        # as "latest" when that version was created) -- without removing
        # it first, a dead/failed replan subprocess that writes NOTHING
        # leaves the OLD plan sitting there, and load_architecture_plan
        # below would happily re-load it and get stamped as v{to_version}.
        # That is fail-OPEN (silently promoting the rejected plan under a
        # new version number), the exact opposite of this function's
        # documented fail-closed contract. Unlink so a failed subprocess
        # produces a genuinely missing file -> load_architecture_plan
        # returns None, same as run_architect_first's very first run.
        (Path(session) / "architecture-plan.json").unlink(missing_ok=True)

        rc = invoke_engineer(
            engineer, ws, replan_prompt,
            True,  # auto_approve forced regardless, same as run_architect_first
            None,  # architect mode's own smaller default turn budget applies
            session / f"architect-replan-{to_version}.log",
            events_path, sid, mode="architect",
        )
        print(f"[V2] Architect replan subprocess exited with code {rc}")
    except Exception as exc:  # noqa: BLE001 - replan failure must never block the run
        print(f"[V2] WARN: architect replan subprocess failed to run: {exc}")

    # Deliberately OUTSIDE the try above, same reasoning as run_architect_
    # first's identical comment: load_architecture_plan already degrades
    # to None internally on any read/parse/planningFailed case.
    plan = load_architecture_plan(session)

    if plan is not None:
        plan["version"] = to_version
        print(f"[V2] Architect replan v{to_version} loaded: risk={plan.get('risk')!r}")
        packages = plan.get("packages")
        if isinstance(packages, list):
            packages = [str(p)[:200] for p in packages[:20]]
        emit_event(events_path, "architect_plan_created", sid,
                   risk=plan.get("risk"), packages=packages, version=to_version)
    else:
        print(f"[V2] Architect replan v{to_version} produced no usable plan "
              "(missing/invalid/failed); failing closed (never continuing on the rejected plan).")
        # Fix round 2 (LOW): restore architecture-plan.json from the
        # already-on-disk v{from_version} snapshot (record_architecture_
        # plan_version wrote architecture-plan-v{from_version}.json when
        # that version was created) -- observability only, for whoever
        # inspects this now-terminal session's dir; the unlink above
        # already left architecture-plan.json missing, and the caller
        # still gets `plan is None` back and fails closed regardless of
        # whether this restore succeeds.
        restore_src = Path(session) / f"architecture-plan-v{from_version}.json"
        if restore_src.exists():
            shutil.copyfile(restore_src, Path(session) / "architecture-plan.json")

    return plan


def record_architecture_plan_version(session, manifest, plan):
    """V7 §5.12: persist one ArchitecturePlan version. Writes
    architecture-plan-vN.json (an additional, never-overwritten
    snapshot -- plan history) AND re-writes architecture-plan.json (the
    pre-existing "current plan" convention every gateway reader already
    uses) so both stay in sync with plan["version"]. Appends one
    {version, path, createdAt} entry to manifest["architectPlans"]
    (oldest first). `plan` must already carry a stamped "version" key --
    run_architect_first/run_architect_replan's job, not this function's;
    defaults to 1 defensively if somehow missing.
    """
    version = plan.get("version", 1)
    text = json.dumps(plan, indent=2)
    versioned_name = f"architecture-plan-v{version}.json"
    (Path(session) / versioned_name).write_text(text, encoding="utf-8")
    (Path(session) / "architecture-plan.json").write_text(text, encoding="utf-8")
    manifest.setdefault("architectPlans", []).append({
        "version": version,
        "path": versioned_name,
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    })


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


def make_review_request(plan, files, change_types, diff_text, iteration, review_round, task_list=None,
                         matched_adr_ids=None):
    """C2: the review-request payload v2 (trusted layer) writes to disk
    for the architect-review subprocess to read directly (glimmer-
    engineer.py's _load_review_request) — V7 §5.6's shape, scoped down
    per the C2 task entry to what a pre-verification review actually
    needs: the plan it's checking against, the real changed-files list,
    and the real diff (git_diff_text — same underlying git plumbing as
    diff_hash/file_change_types, not a new discovery pass).

    Task 4.3 ("Architect task-list review"): task_list is C3's derived
    tasks.json (glimmer-v2.py's own derive_tasks output), included ONLY on
    the very first review of a session (iteration==0, review_round==1 --
    see the call site in main()'s review loop). This is the simpler of
    two ways to satisfy V7's "architect should review the task list at
    important checkpoints" -- rather than spending a SECOND model call on
    a standalone task-list review, the task list rides along in the one
    review request that already exists, so the architect can flag a
    missing/superfluous/misordered task in the SAME turn it reviews the
    diff. Zero new model calls; None (the default) reproduces the exact
    payload shape from before this task, so every later review round
    (which has no fresh task list to add, and no reason to re-review one
    already approved) is unaffected.

    Task 7.3 (V7 "ADR consultation"): matched_adr_ids is select_matching_
    adr_ids(contract, ws)'s output -- additive, same "key present only
    when there's something to say" discipline as taskList: omitted
    (falsy/None) means either no docs/decisions/ dir or nothing matched,
    reproducing the exact pre-Task-7.3 payload shape. When present, it
    lets the architect note a deviation against a specific ADR without
    re-deriving the area match itself.
    """
    request = {
        "type": "architect_review_request",
        "iteration": iteration,
        "reviewRound": review_round,
        "architecturePlan": plan,
        "changedFiles": [
            {"path": f, "changeType": change_types.get(f, "modified")} for f in files
        ],
        "diff": diff_text,
    }
    if task_list is not None:
        request["taskList"] = task_list
    if matched_adr_ids:
        request["matchedAdrIds"] = matched_adr_ids
    return request


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
    by --architect-review-selfcheck without a live model or session.

    Task 2.2 (V7 §5.12): REPLAN_REQUIRED is no longer terminal-rejected --
    it routes to "replan" (re-invoke the architect for a new plan
    version, then continue with a delta prompt, same as "revise" but
    with a swapped-in plan) instead of stopping the run. Only
    HUMAN_REVIEW_REQUIRED (and any unrecognized decision) still maps to
    the terminal "rejected" outcome.
    """
    if decision in ("APPROVED", "APPROVED_WITH_CONDITIONS"):
        return "approved"
    if decision == "REVISE_IMPLEMENTATION":
        return "revise"
    if decision == "REPLAN_REQUIRED":
        return "replan"
    if decision == "HUMAN_REVIEW_REQUIRED":
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


def scope_guard_gate_value(scope_result):
    """Task 2.3 (V7 §5.11): maps compute_scope_guard's result to the
    True/False/None gate contract every other gates.* key already uses --
    inScope True -> True, a real expansion (expandedFiles non-empty) ->
    False, "unbounded" (scope claimed a concrete path but gave none, so
    compute_scope_guard could not tell) -> None (indeterminate, not a
    pass). None input (no scope_result computed yet) -> None."""
    if not scope_result:
        return None
    if scope_result.get("unbounded"):
        return None
    return True if scope_result.get("inScope") else False


def combine_gate_values(*values):
    """Task 2.3 (V7 §5.11): tri-state AND across gate values -- False
    dominates (any real failure blocks), else None dominates (any
    indeterminate input makes the combination indeterminate too -- "null
    wins over true"), else True only when every input is True. Used to
    fold gates.scopeApproved from two independent signals (the existing
    contract-scope guard + the new plan-candidateFiles consistency
    check) into one honest value."""
    if any(v is False for v in values):
        return False
    if any(v is None for v in values):
        return None
    return True


def gates_block_verified(gates: dict) -> bool:
    """V7 §5.11: the final-acceptance rule. VERIFIED requires
    implementationComplete and verificationPassed to be exactly True
    (both are always computable by the time this runs -- there is no
    honest "not applicable" for either), and architectureApproved/
    scopeApproved to each be anything OTHER than False (None =
    not-applicable/never-ran, still allowed; only an explicit False
    blocks). Pure/deterministic -- exercised directly by
    --gates-selfcheck without a live model or session.

    Task 7.1 (reverses the Round-2/review-round-1 deferral noted below):
    documentationCurrent now DOES block, on the same not-False-only
    contract as architectureApproved/scopeApproved/tasksResolved. That
    deferral held only while detect_documentation_impact (O2 phase 1) was
    the sole producer of this gate -- a ONE-WAY detector that can only
    ever emit False or None, never True, since it has no way to verify
    docs actually ARE current. Blocking on that alone would have made
    every routes/schema/api/config/auth-touching change permanently
    unable to reach VERIFIED. That is no longer the whole story: Task 7.1/
    7.2's graph-based verification (verify_doc_nodes + map_changed_files_
    to_doc_nodes + apply_doc_impact/check_doc_drift + compute_doc_gate,
    composed by run_doc_pass and called from main()'s `if ok:` branch --
    Review round 7, C1 -- strictly BEFORE this function is consulted, not
    from `finally` after the fact) CAN legitimately produce True -- when a
    repo has a docs/graph.json and every doc node impacted by this
    session's diff verifies CURRENT. Repos without a graph still get None
    (mechanism didn't run -- not applicable, never blocks), so this is
    additive, not a new way to fail for repos that never opted in.

    Task 4.2: gates.tasksResolved follows the exact same Round-2
    True/False/None contract as architectureApproved/scopeApproved above
    -- True/None never block, only an explicit False (required_tasks_
    resolved(tasks) returned False -- some required task is unresolved)
    blocks. None means no tasks.json (C3's task graph never ran for this
    session), same "mechanism didn't run -- not applicable" pass-through
    every other optional gate here already uses."""
    if gates.get("implementationComplete") is not True:
        return True
    if gates.get("verificationPassed") is not True:
        return True
    return any(gates.get(key) is False for key in
                ("architectureApproved", "scopeApproved", "tasksResolved",
                 "documentationCurrent"))


def blocked_gate_names(gates: dict) -> list:
    """Review round 1 (Important) + Task 4.2 + Task 7.1: which gate(s)
    actually caused gates_block_verified to return True, in the same
    checked order -- mirrors gates_block_verified exactly (same two
    hard-required keys, same not-False-only set, now including
    tasksResolved and documentationCurrent) so the two can never silently
    drift apart. Feeds describe_blocked_gates' honest, cause-naming
    failure detail."""
    blocked = []
    if gates.get("implementationComplete") is not True:
        blocked.append("implementationComplete")
    if gates.get("verificationPassed") is not True:
        blocked.append("verificationPassed")
    for key in ("architectureApproved", "scopeApproved", "tasksResolved", "documentationCurrent"):
        if gates.get(key) is False:
            blocked.append(key)
    return blocked


def describe_blocked_gates(manifest: dict) -> str:
    """Review round 1 (Important): an honest, cause-naming detail for a
    session that reached the VERIFIED gates check and got blocked.
    Three genuinely distinct causes can all land on the same raw status
    (needs-architect-review-consistency-rejected) -- a scope-guard
    expansion, an engineer that exited non-zero after a passing diff, and
    a real post-verification consistency-review rejection -- and they
    must not all read as "architecture review rejected" (wrong for two
    of the three). Reads manifest["blockedGates"] (set at the block
    site), the LAST attempt's scopeGuard, and the top-level consistency
    record for the actual file lists. Never raises on a
    missing/malformed manifest -- degrades to a generic detail.
    """
    blocked = manifest.get("blockedGates") or []
    attempts = manifest.get("attempts") or []
    last_attempt = attempts[-1] if attempts and isinstance(attempts[-1], dict) else {}
    scope_guard = last_attempt.get("scopeGuard") or {}
    consistency = manifest.get("consistency") or {}

    parts = []
    if "implementationComplete" in blocked:
        # Controller ruling: this exact phrase, never "architecture review
        # rejected" -- rc != 0 after a passing diff is an engineer-outcome
        # fact, unrelated to any architect review.
        parts.append("engineer exited non-zero after a passing diff")
    if "scopeApproved" in blocked:
        expanded = scope_guard.get("expandedFiles") or []
        outside = consistency.get("outsideFiles") or []
        if expanded and outside:
            parts.append(
                "scope guard expansion outside declared scope ("
                + ", ".join(expanded)
                + ") AND post-verification consistency review rejected files outside "
                "the architecture plan (" + ", ".join(outside) + ")"
            )
        elif expanded:
            parts.append("scope guard expansion outside declared scope: " + ", ".join(expanded))
        elif outside:
            parts.append(
                "post-verification consistency review rejected files outside the "
                "architecture plan: " + ", ".join(outside)
            )
        else:
            parts.append("post-verification consistency review rejected the implementation")
    if "architectureApproved" in blocked:
        parts.append("architecture review gate rejected")
    if "verificationPassed" in blocked:
        parts.append("verification did not pass")
    if not parts:
        return "one or more V7 §5.11 gates blocked promotion to verified"
    return "; ".join(parts)


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
                          iteration, review_round, task_list=None, matched_adr_ids=None):
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

    task_list (Task 4.3): forwarded straight into make_review_request --
    see that function's docstring for why this is the one review call
    that carries it (iteration==0, review_round==1 only; every other
    call site passes nothing, keeping their payload unchanged).

    matched_adr_ids (Task 7.3): also forwarded straight into make_review_
    request's additive matchedAdrIds field -- callers compute it once via
    select_matching_adr_ids(contract, ws).
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

        request = make_review_request(plan, files, change_types, diff_text, iteration, review_round,
                                       task_list=task_list, matched_adr_ids=matched_adr_ids)
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


def _normalize_plan_path(raw) -> str:
    """Cheap path normalization shared by check_post_verification_
    consistency's membership comparison -- not a security boundary (unlike
    _resolve_candidate_path's containment check above), just enough
    normalization that "./src/x.ts", "src/x.ts/", and "src//x.ts" all
    compare equal. Never raises on malformed input."""
    p = str(raw).strip().replace("\\", "/").strip("/")
    return os.path.normpath(p) if p else p


def check_post_verification_consistency(files: list, plan) -> dict:
    """V7 §5.10: post-verification architecture consistency check --
    cheap, deterministic, no model call by itself (main() decides whether
    to spend an architect review round on a flagged result). Compares the
    session's FINAL changed-files set against plan.candidateFiles (the
    set of files the architect expected to touch) and, when present,
    plan.expectedScope.maxFiles (the count the architect expected).

    candidateFiles[].path and expectedScope are MODEL OUTPUT (the
    architect wrote the plan) -- treated as advisory estimates, not a
    contract: a flag here never blocks VERIFIED by itself (see main()'s
    call site and gates_block_verified). Returns
    {"flagged": bool, "outsideFiles": [...], "reason": str | None}.

    No plan -> always {"flagged": False, "outsideFiles": [], "reason": None}
    -- a deliberate no-op (nothing to compare against), not an
    indeterminate result. Never raises: candidateFiles/expectedScope may be
    missing, malformed, or adversarial; every malformed entry is simply
    skipped rather than erroring.
    """
    if not plan:
        return {"flagged": False, "outsideFiles": [], "reason": None}

    candidate_paths = set()
    candidates = plan.get("candidateFiles")
    if isinstance(candidates, list):
        for c in candidates:
            if isinstance(c, dict) and isinstance(c.get("path"), str) and c["path"].strip():
                candidate_paths.add(_normalize_plan_path(c["path"]))

    # Review round 1 (minor): an architect that named NO usable candidate
    # files at all (empty/malformed candidateFiles) has given us nothing
    # to compare against -- that is honestly "can't tell", not "every
    # file is outside scope". Only flag on outsideFiles when there is at
    # least one real candidate path to compare against; maxFiles is an
    # independent, still-live signal either way.
    outside = [] if not candidate_paths else [
        f for f in files if _normalize_plan_path(f) not in candidate_paths
    ]

    max_files = None
    expected_scope = plan.get("expectedScope")
    if isinstance(expected_scope, dict):
        raw_max = expected_scope.get("maxFiles")
        if isinstance(raw_max, (int, float)) and not isinstance(raw_max, bool) and raw_max >= 0:
            max_files = raw_max
    over_budget = max_files is not None and len(files) > max_files

    if not outside and not over_budget:
        return {"flagged": False, "outsideFiles": [], "reason": None}

    reasons = []
    if outside:
        reasons.append(f"{len(outside)} changed file(s) outside plan.candidateFiles")
    if over_budget:
        reasons.append(f"{len(files)} changed files exceeds expectedScope.maxFiles={max_files}")
    return {"flagged": True, "outsideFiles": outside, "reason": "; ".join(reasons)}


# ============================================================
# C3 (glimmer-v7): Task Graph (tasks.json) — reconciliation doc C3 entry.
# ============================================================
# Active only when --architect-first produced a usable plan. Flat list,
# sequential dependsOn only (deliberately not a DAG/priority model — see
# evaluate_implementation_tasks for why implementation tasks transition
# as one group, not per-step).


def _task_timestamp() -> str:
    """Task 4.1: shared ISO-8601 UTC timestamp for createdAt/updatedAt --
    same format dt.datetime.now(dt.timezone.utc).isoformat() already
    produces for manifest["verifiedAt"] elsewhere in this file."""
    return dt.datetime.now(dt.timezone.utc).isoformat()


def derive_tasks(plan: dict) -> list:
    """C3 + Task 4.1: derive the flat task list from plan["implementationPlan"]
    + plan["verificationPlan"] (V7's structured-task-model fields). Sequential
    dependsOn chain within implementation tasks (t2 depends on t1, etc.);
    every verification task depends on the LAST implementation task (or has
    no dependency when there were no implementation steps at all). ids are
    simple/stable: t1, t2, ... in derivation order (implementation first,
    then verification).

    Task 4.1 full task model: every task additionally carries source
    ("architect_plan" -- both kinds here come from the architect's plan),
    priority, evidenceIds, affectedFiles, blockingReason, createdAt/
    updatedAt, and a completion contract consumed by the evaluators below
    instead of a hardcoded kind check:
      - implementation -> completion.type = "files_changed" (evidence:
        engineer return code + changed-files set -- see
        evaluate_implementation_tasks).
      - verification -> completion.type = "check_passed", completion.check
        = None (evidence: a real verify() result FUZZY-matched to this
        task's description via _match_verify_result -- no single command
        string is known yet at derivation time). priority starts
        "recommended" (fix round 1, CRITICAL: starting it "required"
        deadlocked required_tasks_resolved forever whenever a plan named a
        check verify() never actually ran under that exact wording -- an
        honestly-unmatched task then stayed priority="required"+status=
        "pending" for the rest of the session, permanently blocking
        gates.tasksResolved with no way to ever resolve). It is promoted
        to "required" ONLY once a real verify() result actually matches it
        AND that result's own tier is "required" (see
        evaluate_verification_tasks) -- i.e. required-ness is now
        confirmed by evidence, never assumed at plan time. Implementation
        and repair tasks are unaffected -- they stay "required" from
        creation (see create_repair_task); only plan-derived VERIFICATION
        tasks start optimistic-then-confirmed like this.
    Repair tasks (kind="repair", created by create_repair_task once a
    required-tier check actually fails) and documentation tasks (kind=
    "documentation", created by documentation_task) use this same
    completion-contract vocabulary -- see their own docstrings.

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
        now = _task_timestamp()
        tasks.append({
            "id": tid,
            "description": str(step),
            "kind": "implementation",
            "dependsOn": [prev_id] if prev_id else [],
            "status": "pending",
            "source": "architect_plan",
            "priority": "required",
            "evidenceIds": [],
            "affectedFiles": [],
            "blockingReason": None,
            "createdAt": now,
            "updatedAt": now,
            "completion": {"type": "files_changed"},
        })
        prev_id = tid

    last_impl_id = prev_id
    for step in verify_steps:
        tid = f"t{len(tasks) + 1}"
        now = _task_timestamp()
        tasks.append({
            "id": tid,
            "description": str(step),
            "kind": "verification",
            "dependsOn": [last_impl_id] if last_impl_id else [],
            "status": "pending",
            "source": "architect_plan",
            "priority": "recommended",
            "evidenceIds": [],
            "affectedFiles": [],
            "blockingReason": None,
            "createdAt": now,
            "updatedAt": now,
            "completion": {"type": "check_passed", "check": None},
        })
    return tasks


_TASK_ID_RE = re.compile(r"^t(\d+)$")


def _next_task_id(tasks) -> int:
    """Fix round 1 (IMPORTANT 3): monotonic id allocator -- parse every
    existing "tN" id in `tasks`, take the max N, return N+1 (1 when
    `tasks` is None/empty/has no parseable id). Used by every dynamic-task
    creator (create_repair_task, documentation_task) and by
    merge_replanned_tasks below, instead of the old `len(tasks) + 1`,
    which silently assumed ids stay contiguous with list length -- false
    the moment a dynamic task (repair/documentation) has ever been
    appended and a replan then re-derives a shorter or longer plan-task
    prefix, which could reuse an id already in use. Ignores any
    non-"tN"-shaped id rather than raising -- robust against hand-built
    fixtures in tests."""
    max_n = 0
    for t in (tasks or []):
        m = _TASK_ID_RE.match(str(t.get("id", "")))
        if m:
            max_n = max(max_n, int(m.group(1)))
    return max_n + 1


def merge_replanned_tasks(old_tasks, new_tasks):
    """Task 2.2 fix round 1 (MED) + Task 4.1 fix round 1 (IMPORTANT 3):
    re-deriving tasks from a NEW plan version (derive_tasks always assigns
    fresh t1..tN ids, with no stable identity across calls) must not
    silently discard status progress already recorded against work that
    DIDN'T actually change -- and must not silently DROP dynamic tasks
    (repair/documentation/system) a prior repair round or the doc-impact
    detector already created, which belong to the SESSION, not to any one
    plan version.

    Two rules, applied together:
      1. Carry-over: a new plan-derived task inherits status, priority,
         blockingReason, evidenceIds, and createdAt from an old task with
         an IDENTICAL (kind, description) pair (kind-scoped so an
         implementation step and a verification step sharing wording never
         cross-match) -- updatedAt is bumped to now on any such carry, an
         honest "this object's state changed at this moment" fact even
         though status itself may be unchanged. A new task with no
         identical match is genuinely new work introduced by the replan
         and starts exactly as derive_tasks built it (untouched here).
         `old_tasks` entries with no "source" key (pre-Task-4.1 test
         fixtures / a plan-derived task, since derive_tasks always sets
         source="architect_plan") default to "architect_plan" for rule 2.
      2. Preservation: every old task whose source is NOT "architect_plan"
         (a repair task, a documentation task, or any future "system"
         task) is carried forward WHOLESALE into the merged list -- fix
         round 1 (IMPORTANT 3): the old version of this function only
         ever returned `new_tasks`, so any repair/documentation task
         created before a replan was silently discarded the moment
         REPLAN_REQUIRED fired. Preserved tasks are re-numbered via
         _next_task_id (continuing from the new plan-derived tasks' own
         max id) so they can never collide with a new plan task's id, even
         when the new plan derives more/fewer steps than the old one did.

    Never raises: old_tasks may be None/empty (first-ever plan, nothing to
    carry over or preserve), in which case new_tasks is returned as-is.
    """
    if not old_tasks:
        return new_tasks
    carried = {}
    for t in old_tasks:
        key = (t.get("kind"), t.get("description"))
        carried.setdefault(key, t)
    now = _task_timestamp()
    for t in new_tasks:
        prior = carried.get((t.get("kind"), t.get("description")))
        if prior is None:
            continue
        for field in ("status", "priority", "blockingReason", "evidenceIds", "createdAt"):
            if field in prior:
                t[field] = prior[field]
        t["updatedAt"] = now

    preserved = [t for t in old_tasks if t.get("source", "architect_plan") != "architect_plan"]
    next_id = _next_task_id(new_tasks)
    for t in preserved:
        t["id"] = f"t{next_id}"
        next_id += 1
    return new_tasks + preserved


def save_tasks(session_dir, tasks) -> None:
    """C3 + Task 4.1: full-file rewrite at every transition point (spawn,
    engineer-return, post-verify) — tasks.json is small, so a full rewrite
    is simplest and cheapest. Task 4.1: tasks.json is now versioned --
    {"schemaVersion": 2, "tasks": [...]} -- so a reader can tell a Round-4
    task list (full model: source/priority/completion/etc.) apart from an
    archived pre-Round-4 session's flat array (v1, no wrapper). Readers
    (control-center's readSessionTasks) unwrap this at read time and must
    keep tolerating a bare v1 array from older sessions on disk. Never
    raises: same never-crash-the-session discipline as C1/C6 — a disk
    write failure here (permissions, full disk) must degrade to a log
    line, never take down an otherwise-successful engineering session."""
    try:
        (Path(session_dir) / "tasks.json").write_text(
            json.dumps({"schemaVersion": 2, "tasks": tasks}, indent=2), encoding="utf-8")
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


def set_implementation_tasks_status(tasks, status: str, blocking_reason: str | None = None) -> None:
    """C3 + Task 4.1: flip every task whose completion contract is
    completion.type=="files_changed" to `status`, in place -- dispatches
    on the completion CONTRACT now, not a hardcoded kind=="implementation"
    check (Task 4.1: "evaluators consume completion contracts instead of
    hardcoded rules"). Every plan-derived implementation task carries this
    completion type (see derive_tasks), so behavior is unchanged for them.
    Called at each engineer spawn (-> in_progress) — including the C2
    revise-round re-spawn, which re-invokes the engineer directly
    outside the outer repair loop: implementation tasks go back to
    in_progress for that re-spawn and are re-evaluated after it
    returns, exactly like the main spawn/return pair. `blocking_reason`
    is written verbatim onto every matched task (None on every non-
    terminal call, e.g. the in_progress spawn transition, honestly
    clearing any stale reason from a previous failed attempt). No-op
    when `tasks` is None (no plan, C3 inactive)."""
    if tasks is None:
        return
    now = _task_timestamp()
    for t in tasks:
        # Fix round 1 (MINOR 9): v1 fallback -- a task with NO completion
        # contract at all (an archived pre-Round-4 tasks.json loaded back
        # into a live `tasks` list; glimmer-v2.py itself never does this
        # today, but a defensive tolerance) falls back to the old
        # kind=="implementation" rule instead of silently never matching.
        if (t.get("completion") or {}).get("type") == "files_changed" or (
                not t.get("completion") and t.get("kind") == "implementation"):
            t["status"] = status
            t["blockingReason"] = blocking_reason
            t["updatedAt"] = now


def reset_verification_tasks_status(tasks) -> None:
    """Fix round 1 (Minor 6) + Task 4.1: flip every task whose completion
    contract is completion.type=="check_passed" back to `pending`, in
    place -- dispatches on the completion CONTRACT (Task 4.1), not a
    hardcoded kind=="verification" check, so this now also resets a
    repair task's status (repair tasks share the same check_passed
    contract -- see create_repair_task) exactly like a plan-derived
    verification task. Called at the C2 revise-round re-spawn (alongside
    set_implementation_tasks_status(tasks, "in_progress")) — a task
    marked "complete"/"failed" against the PRE-revise diff must not
    survive unchanged once the revise round produces a different diff;
    it is re-evaluated honestly by evaluate_verification_tasks after the
    next real verify() call. No-op when `tasks` is None."""
    if tasks is None:
        return
    now = _task_timestamp()
    for t in tasks:
        # Fix round 1 (MINOR 9): v1 fallback, same reasoning as
        # set_implementation_tasks_status above.
        if (t.get("completion") or {}).get("type") == "check_passed" or (
                not t.get("completion") and t.get("kind") == "verification"):
            t["status"] = "pending"
            t["updatedAt"] = now


def evaluate_implementation_tasks(tasks, files: list, engineer_rc) -> None:
    """C3 + Task 4.1: the ONLY evidence source for implementation task
    status — never a model claim. Per-step granularity is not honestly
    evidencable (one engineer run executes every implementationPlan
    step at once), so the whole implementation group is marked
    together, by the same evidence: complete iff the session's changed-
    files set is non-empty AND the engineer subprocess exited 0;
    failed otherwise (engineer errored, or ran and touched nothing) —
    blockingReason records which of those two it was. No-op when
    `tasks` is None."""
    if tasks is None:
        return
    if files and engineer_rc == 0:
        set_implementation_tasks_status(tasks, "complete")
    else:
        reason = ("engineer exited non-zero" if engineer_rc != 0
                   else "engineer made no file changes")
        set_implementation_tasks_status(tasks, "failed", blocking_reason=reason)


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
    """C3 + Task 4.1: map each task whose completion contract is
    completion.type=="check_passed" to a real verify() result. Task 4.1
    dispatches on the completion CONTRACT, not a hardcoded kind==
    "verification" check, and the contract's `check` field picks HOW to
    match:
      - completion.check is None (every plan-derived verification task --
        see derive_tasks): FUZZY token-overlap match of the task's prose
        `description` against `results` (see _match_verify_result) --
        unchanged from the original C3 behavior.
      - completion.check is a literal command string (every repair task
        -- see create_repair_task): EXACT match against a result's
        `command` field. A repair task already knows precisely which
        command it exists to fix (build_repair_contract's failedCheck),
        so no fuzzy guess is needed or wanted.
    Matched -> complete on PASS/PASS_BASELINE, failed on CODE_FAIL (with
    blockingReason recording the failing command). Unmatched entries (the
    plan/repair named a check verify() never ran this round) stay
    `pending` — HONEST, never fabricate completion. INFRA_BLOCKED/TIMEOUT
    matches also stay `pending` (the check never really ran to a pass/
    fail verdict). For a fuzzy-matched (plan-derived) task, a successful
    match also refines `priority` to "required"/"recommended" from the
    matched result's own tier — derive_tasks can't know this at plan time
    (verification_plan's required/recommended split isn't computed until
    main()'s per-iteration verify() call), so it starts "recommended" (fix
    round 1, CRITICAL) and is promoted to "required" here once real tier
    evidence exists. No-op when `tasks` is None."""
    if tasks is None:
        return
    now = _task_timestamp()
    for t in tasks:
        completion = t.get("completion") or {}
        # Fix round 1 (MINOR 9): v1 fallback -- a task with no completion
        # contract at all falls back to the old kind=="verification" rule
        # (same reasoning as set_implementation_tasks_status).
        if completion.get("type") != "check_passed" and not (
                not t.get("completion") and t.get("kind") == "verification"):
            continue
        check = completion.get("check")
        if check:
            # ponytail: exact string match against THIS round's results only
            # -- if a later repair round's verifier command set no longer
            # contains the literal failedCheck string (verification_level
            # changed, the plan/contract's verify list changed, the command
            # itself got reworded), this repair task can never match again
            # and is permanently stranded at "in_progress", blocking
            # gates.tasksResolved forever. Upgrade path if that's ever hit
            # in practice: fall back to _match_verify_result (fuzzy) when
            # the exact match misses, same as a plan-derived task.
            match = next((r for r in results if r.get("command") == check), None)
        else:
            match = _match_verify_result(t["description"], results)
        if match is None:
            continue  # plan/repair named a check that never ran -- stays pending
        if check is None:
            t["priority"] = "required" if match.get("tier", "required") == "required" else "recommended"
        status_name = match.get("status")
        if status_name in ("PASS", "PASS_BASELINE"):
            t["status"] = "complete"
            t["blockingReason"] = None
            t["updatedAt"] = now
        elif status_name == "CODE_FAIL":
            t["status"] = "failed"
            t["blockingReason"] = f"check failed: {match.get('command')}"
            t["updatedAt"] = now
        # INFRA_BLOCKED / TIMEOUT / anything else: leave pending -- the
        # check never really produced a pass/fail verdict.


# ============================================================
# O2 phase 1 (glimmer-v7 reconciliation): deterministic
# documentation-impact detector.
# ============================================================
# Scope was originally deliberately tiny (reconciliation doc, O2 entry):
# "deterministic change-impact detector (routes/schema/API/config/auth
# touched?) creating a REQUIRED doc task + gates.documentationCurrent.
# Graph, ADR store, drift detection and semantic doc verification: defer
# entirely." No repo-map lookup, no model call -- path/filename pattern
# matching only. Task 7.1/7.2 (further down this file) built the graph +
# deterministic drift detection the deferral above named; this detector
# stays as-is as the fallback for repos with no docs/graph.json.

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


def _categories_for_path(raw) -> set:
    """Per-file half of detect_documentation_impact's classification,
    factored out so Task 7.2's graph node-mapping (map_changed_files_to_
    doc_nodes) can reuse the exact same keyword table per changed file --
    detect_documentation_impact itself only ever needed the UNION across a
    whole changed-files list, this is that union's per-file term."""
    path = str(raw).replace("\\", "/")
    lower = path.lower()
    segments = [s for s in lower.split("/") if s]
    basename = segments[-1] if segments else lower

    categories = set()
    for category, words in _DOC_IMPACT_WORDS.items():
        camel_aware = category in _CAMEL_AWARE_CATEGORIES
        for word in words:
            if _word_hits(word, path, camel_aware):
                categories.add(category)
                break

    # Explicit filename/segment checks the word list can't express
    # as a clean standalone word.
    if basename.endswith(".sql"):
        categories.add("schema")
    if basename == "dockerfile" or basename.startswith("docker-compose"):
        categories.add("config")
    if basename == ".env.example":
        categories.add("config")
    if ".github" in segments and "workflows" in segments:
        categories.add("config")
    return categories


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
        impacts |= _categories_for_path(raw)
    return sorted(impacts)


def documentation_task(next_id: int, impacts: list, node_ids: "list | None" = None) -> dict:
    """O2 + Task 4.1: the documentation task appended to tasks.json when
    C3's task graph is active and detect_documentation_impact found
    something. kind="documentation" is an honest addition to C3's kind
    vocabulary (alongside "implementation"/"verification"/"repair" -- see
    @glimmer/shared's GlimmerTask.kind, extended to match) precisely
    because NOTHING in this codebase can auto-CLOSE this task yet:
    completion.type="docs" is never matched by set_implementation_tasks_
    status / evaluate_implementation_tasks / evaluate_verification_tasks /
    reset_verification_tasks_status (all of which dispatch on
    completion.type=="files_changed"/"check_passed" -- see their
    docstrings), so this task is created `pending` and stays `pending`
    forever. Only a human closing it out of band reflects reality.
    dependsOn is deliberately []: it doesn't block or get blocked by
    implementation/verification tasks, it just needs to exist and stay
    visible.

    Task 4.1: priority is "recommended", not "required" -- this task's own
    completion can never auto-resolve (see above), so making it "required"
    would make required_tasks_resolved permanently False for every
    doc-relevant change, forever. That is orthogonal to Task 7.1's
    documentationCurrent gate (which CAN legitimately become True now, via
    the graph -- see gates_block_verified) -- documentationCurrent gates
    VERIFIED directly; this task's priority only affects tasksResolved,
    and the two must not be conflated. createdBecause records the same
    impacted-areas list baked into the description, machine-shaped for
    display. Task 7.2: node_ids (when the target repo has a docs/graph.json
    and map_changed_files_to_doc_nodes found impacted doc nodes) is
    recorded as this task's "nodeIds" -- always present, [] when there was
    no graph or no impacted node."""
    now = _task_timestamp()
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
        "source": "documentation",
        "priority": "recommended",
        "evidenceIds": [],
        "affectedFiles": [],
        "nodeIds": list(node_ids or []),
        "blockingReason": None,
        "createdAt": now,
        "updatedAt": now,
        "completion": {"type": "docs"},
        "createdBecause": ", ".join(impacts),
    }


# ============================================================
# Task 7.1/7.2 (V7 "Machine-readable Documentation Graph" / "Documentation
# status model" / "Documentation provenance" / "Drift detection" /
# "Impact analysis through the graph" / "Documentation Gate"): a real,
# tri-state documentationCurrent gate on top of O2 phase 1's one-way
# detector above. The graph -- <workspace>/docs/graph.json -- lives IN THE
# TARGET REPO, not in glimmer's own session state: it's a project artifact
# a human (or a future bootstrap/curation step, Task 7.4) authors, and
# Glimmer only reads + deterministically verifies it. Every status
# transition below is a filesystem or git check -- nothing here calls a
# model. Most repos have no graph yet; that is an honest "not applicable"
# (None), never an error.
# ============================================================

DOC_STATUS_CURRENT = "CURRENT"
DOC_STATUS_STALE = "STALE"
DOC_STATUS_UNVERIFIED = "UNVERIFIED"
DOC_STATUS_MISSING = "MISSING"
DOC_STATUS_DEPRECATED = "DEPRECATED"
DOC_STATUS_GENERATED = "GENERATED"
DOC_STATUSES = {
    DOC_STATUS_CURRENT, DOC_STATUS_STALE, DOC_STATUS_UNVERIFIED,
    DOC_STATUS_MISSING, DOC_STATUS_DEPRECATED, DOC_STATUS_GENERATED,
}
# DEPRECATED/GENERATED are explicit human/bootstrap markers, not a
# freshness verdict -- verify_doc_nodes/apply_doc_impact/check_doc_drift
# all leave nodes in either state untouched rather than silently
# reclassifying them (a deprecated node's file going missing is expected,
# not a finding; a bootstrap-generated skeleton stays generated until a
# human curates it).
_DOC_STATUS_FROZEN = {DOC_STATUS_DEPRECATED, DOC_STATUS_GENERATED}

DOC_GRAPH_RELATIVE_PATH = "docs/graph.json"

# Task 7.2: which graph node `type` a changed file's O2-phase-1 category
# corresponds to, for the keyword-table half of map_changed_files_to_
# doc_nodes. Node types come from the graph.json schema (system/service/
# route/schema/config/doc) -- "api" and "auth" changes are heuristically
# attributed to a "service" node (there is no dedicated api/auth node
# type); this is a coarse heuristic, not a claim of precision.
_CATEGORY_TO_NODE_TYPE = {
    "routes": "route",
    "schema": "schema",
    "config": "config",
    "api": "service",
    "auth": "service",
}

# Backticked, dot-extensioned, repo-path-looking references inside a doc
# node's own markdown -- e.g. `backend/server/services/x.ts` or
# `README.md`. Deliberately loose (this is a drift *signal*, not a parser):
# anything that looks like a path reference and doesn't resolve under the
# workspace root is a finding. _looks_like_doc_path_ref below narrows the
# raw regex match down to things that are actually plausible paths
# (Review round 7, M2) -- the regex alone also matches ordinary prose
# like `Node.js`/`example.com`/`v1.2`, none of which are path references.
_DOC_PATH_REF_RE = re.compile(r"`([\w][\w./-]*\.[A-Za-z0-9]{1,10})`")

# Review round 7 (M2): extensions allowed to match WITHOUT a "/" in the
# reference -- root-level doc/config files that legitimately get named
# bare in prose (`README.md`, `package.json`, `.env`...). Source-code
# extensions are deliberately excluded here: a bare `Node.js`/`Express.js`
# is prose about a runtime/framework, not a path, and requiring a "/" for
# those (matching real code references like `src/api.ts`) is what keeps
# check_doc_drift from flagging ordinary text as a broken path.
_DOC_PATH_REF_NO_SLASH_EXTS = {
    "md", "mdx", "json", "yml", "yaml", "toml", "ini", "cfg", "env", "txt", "rst", "lock",
}


def _looks_like_doc_path_ref(ref: str) -> bool:
    """Review round 7 (M2): a backticked, dot-extensioned regex match is
    only treated as a repo path reference when it contains a path
    separator, or its extension is one of the root-level doc/config
    types above. Filters out `Node.js`, `example.com`, `v1.2`, `foo.bar`
    -- prose that matches the loose regex but was never a path -- while
    still catching real references like `src/api.ts` or `README.md`."""
    if "/" in ref:
        return True
    ext = ref.rsplit(".", 1)[-1].lower()
    return ext in _DOC_PATH_REF_NO_SLASH_EXTS


def load_doc_graph(ws) -> "dict | None":
    """Task 7.1: tolerant reader for <ws>/docs/graph.json. Absent file ->
    None (most repos have no graph yet -- not an error). Malformed JSON,
    or valid JSON that isn't the expected {"nodes": [...], "edges": [...]}
    shape -> None + a warning, never a raised exception -- a hand-edited or
    partially-written graph file must never crash a session."""
    path = Path(ws) / DOC_GRAPH_RELATIVE_PATH
    if not path.is_file():
        return None
    try:
        graph = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        print(f"[V2] WARN: malformed {DOC_GRAPH_RELATIVE_PATH}: {exc}")
        return None
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list):
        print(f"[V2] WARN: {DOC_GRAPH_RELATIVE_PATH} missing a nodes[] list, ignoring")
        return None
    graph.setdefault("edges", [])
    graph.setdefault("schemaVersion", 1)
    return graph


def _write_doc_graph(ws, graph: dict) -> None:
    """Atomic tmp+replace write of docs/graph.json back into the TARGET
    repo -- same never-crash-the-session discipline as save_tasks: a disk
    write failure here degrades to a log line, it must never take down an
    otherwise-successful session.

    Review round 7 (C2): skipped entirely when the serialized graph is
    byte-identical to what's already on disk -- a verified session that
    changed nothing in the graph must not touch docs/graph.json (a
    tracked, human-curated file in the TARGET repo) at all, or every
    such session would show up as "someone modified the workspace after
    verification" in the Control Center's own staleness check."""
    path = Path(ws) / DOC_GRAPH_RELATIVE_PATH
    serialized = json.dumps(graph, indent=2)
    try:
        if path.is_file() and path.read_text(encoding="utf-8") == serialized:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + f".tmp{os.getpid()}")
        tmp.write_text(serialized, encoding="utf-8")
        os.replace(tmp, path)
    except OSError as exc:
        print(f"[V2] WARN: failed to write {DOC_GRAPH_RELATIVE_PATH}: {exc}")


def _doc_git_sha(ws, path: str):
    """git log -1 --format=%H -- <path>: the sha of the last commit that
    touched `path`, or None when it has no commit history at all
    (untracked/new file). Deliberately ignores the working tree -- Glimmer
    sessions leave changes UNCOMMITTED for human review, so an in-session
    edit to `path` is invisible here by design; this only catches drift
    that happened across already-committed history."""
    return git(ws, "log", "-1", "--format=%H", "--", path, check=False) or None


def verify_doc_nodes(graph: dict, ws) -> list:
    """Task 7.1: the deterministic doc verification pass. For every node in
    graph["nodes"] (except frozen DEPRECATED/GENERATED nodes -- see
    _DOC_STATUS_FROZEN):

      1. node["path"] doesn't exist on disk -> MISSING.
      2. doc-type node with any provenance.evidence path that doesn't
         exist -> STALE (recorded as provenance.missingEvidence).
      3. no provenance.sha on record -> UNVERIFIED (never had a baseline).
      4. node["path"] has no committed history (_doc_git_sha -> None) ->
         UNVERIFIED (nothing to compare a baseline against).
      5. committed sha for node["path"] != provenance.sha -> STALE (the
         file changed since this node was last confirmed current).
      6. otherwise -> CURRENT.

    Mutates `graph` in place (status/confidence/provenance.updatedAt) and
    writes it back atomically. Returns [{"nodeId", "status"}] for every
    node actually (re)computed, in node order -- callers emit
    documentation_verified from this. Never model-driven: every branch
    above is a filesystem or git check, never a judgment call.

    Review round 7 (C2): provenance.updatedAt is only bumped for a node
    whose status/confidence/missingEvidence actually changed this pass --
    a repeat run against an unchanged repo must reproduce the exact same
    graph.json bytes (see _write_doc_graph's identical-content no-op),
    so a verified session that touched nothing doesn't get fingerprinted
    as "the workspace changed after verification" purely because this
    function stamped a fresh timestamp onto every node, every time."""
    now = _task_timestamp()
    results = []
    for node in graph.get("nodes") or []:
        if not isinstance(node, dict) or not node.get("id"):
            continue
        if node.get("status") in _DOC_STATUS_FROZEN:
            continue

        node_path = node.get("path") or ""
        old_provenance = dict(node.get("provenance") or {})
        provenance = dict(old_provenance)
        provenance.pop("missingEvidence", None)

        if not node_path or not (Path(ws) / node_path).exists():
            status = DOC_STATUS_MISSING
        else:
            missing_evidence = [
                str(ev) for ev in (provenance.get("evidence") or [])
                if node.get("type") == "doc" and not (Path(ws) / str(ev)).exists()
            ]
            if missing_evidence:
                status = DOC_STATUS_STALE
                provenance["missingEvidence"] = missing_evidence[:10]
            elif not provenance.get("sha"):
                status = DOC_STATUS_UNVERIFIED
            else:
                current_sha = _doc_git_sha(ws, node_path)
                if current_sha is None:
                    status = DOC_STATUS_UNVERIFIED
                elif current_sha != provenance["sha"]:
                    status = DOC_STATUS_STALE
                else:
                    status = DOC_STATUS_CURRENT

        confidence = {
            DOC_STATUS_CURRENT: "high",
            DOC_STATUS_STALE: "low",
            DOC_STATUS_MISSING: "low",
        }.get(status, "unknown")
        changed = (
            node.get("status") != status
            or node.get("confidence") != confidence
            or old_provenance.get("missingEvidence") != provenance.get("missingEvidence")
        )
        node["status"] = status
        node["confidence"] = confidence
        if changed:
            provenance["updatedAt"] = now
        else:
            provenance = old_provenance
        node["provenance"] = provenance
        results.append({"nodeId": node["id"], "status": status})

    _write_doc_graph(ws, graph)
    return results


def _paths_share_area(path: str, node_path: str) -> bool:
    """Review round 7 (M1): whether a changed file plausibly belongs to
    the same area of the repo as a graph node's own recorded path --
    identical, one nested under the other, or sharing an immediate
    parent directory. Scopes the O2 category heuristic in
    map_changed_files_to_doc_nodes down from "every node of this type,
    repo-wide" to "nodes actually near this changed file" -- without
    this, one changed route file marks every route doc in the repo
    impacted, regardless of which route it documents."""
    if not path or not node_path:
        return False
    if path == node_path:
        return True
    if path.startswith(node_path.rstrip("/") + "/") or node_path.startswith(path.rstrip("/") + "/"):
        return True
    path_dir = path.rsplit("/", 1)[0] if "/" in path else ""
    node_dir = node_path.rsplit("/", 1)[0] if "/" in node_path else ""
    return bool(path_dir) and path_dir == node_dir


def map_changed_files_to_doc_nodes(graph: dict, changed_files) -> list:
    """Task 7.2 ("Impact analysis through the graph"): which doc-type
    nodes does this diff's changed-file set touch? Two independent
    signals, unioned into a "touched" node set:

      1. path-prefix match -- a changed file IS a node's recorded path, or
         lives under it as a directory prefix.
      2. the existing O2 phase-1 keyword table (_categories_for_path) --
         a changed file's category (routes/schema/config/api/auth) maps
         to a node type via _CATEGORY_TO_NODE_TYPE -- narrowed (Review
         round 7, M1) to nodes of that type whose OWN path also shares an
         area with the changed file (_paths_share_area), not every node
         of that type in the graph. Without this, one route file change
         would mark every route doc in the repo impacted/STALE.

    A touched node that is itself type=="doc" is directly impacted. A
    touched node that is NOT a doc is impacted through any "documents"
    edge pointing at it (edge.kind=="documents", edge.to==touched node id
    -- edge.from is the doc node documenting it). Returns the sorted,
    deduped list of impacted doc node ids. Pure -- no I/O, no mutation."""
    nodes_by_id = {
        n["id"]: n for n in (graph.get("nodes") or [])
        if isinstance(n, dict) and n.get("id")
    }
    touched = set()
    for raw in (changed_files or []):
        path = str(raw).replace("\\", "/")
        for node in nodes_by_id.values():
            node_path = str(node.get("path") or "").replace("\\", "/")
            if node_path and (path == node_path or path.startswith(node_path.rstrip("/") + "/")):
                touched.add(node["id"])
        for category in _categories_for_path(path):
            wanted_type = _CATEGORY_TO_NODE_TYPE.get(category)
            if wanted_type is None:
                continue
            for node in nodes_by_id.values():
                if node.get("type") != wanted_type:
                    continue
                node_path = str(node.get("path") or "").replace("\\", "/")
                if _paths_share_area(path, node_path):
                    touched.add(node["id"])

    impacted = {nid for nid in touched if nodes_by_id[nid].get("type") == "doc"}
    for edge in graph.get("edges") or []:
        if not isinstance(edge, dict) or edge.get("kind") != "documents":
            continue
        if edge.get("to") not in touched:
            continue
        doc_node = nodes_by_id.get(edge.get("from"))
        if doc_node is not None and doc_node.get("type") == "doc":
            impacted.add(edge["from"])

    return sorted(impacted)


def apply_doc_impact(graph: dict, ws, changed_files, node_ids: list) -> list:
    """Task 7.2: flags each impacted doc node STALE, UNLESS that node's own
    path is itself among this diff's changed files -- the doc was edited
    in the same diff as the code it documents, so trust verify_doc_nodes'
    read of it rather than blanket-overriding it to STALE (this is what
    makes gates.documentationCurrent=True reachable: change code + its doc
    in the same diff and nothing else wrong -> impacted node stays
    whatever verify_doc_nodes computed, e.g. CURRENT). Frozen DEPRECATED/
    GENERATED nodes are left untouched. Writes the graph back atomically.
    Returns [{"nodeId", "reason"}] for the nodes actually flagged --
    callers emit documentation_stale_detected from this.

    Review round 7 (M3): the same-diff exemption is now a real edge back
    to CURRENT, not just "leave whatever verify_doc_nodes already
    computed alone" -- editing a doc alongside the code it documents is
    exactly the deterministic "this is confirmed accurate" signal
    provenance.sha otherwise has no way to ever receive (nothing else in
    this file writes it), so a node that drifted STALE once would
    otherwise stay STALE forever with no path back short of hand-editing
    graph.json. Stamps provenance.sha to the path's current committed
    git sha -- the same deterministic _doc_git_sha check verify_doc_nodes
    itself uses, never a guess.
    # ponytail: this stamps the PRE-commit sha (sessions leave the diff
    # uncommitted for human review), so once the human commits, one more
    # session's verify_doc_nodes pass will legitimately re-flag it STALE
    # against the new commit before self-healing again on the next
    # same-diff edit. Upgrade path: a `--docs-verify --accept` command
    # that re-baselines against HEAD after a human commits, if that one-
    # cycle lag ever matters in practice."""
    changed_set = {str(f).replace("\\", "/") for f in (changed_files or [])}
    nodes_by_id = {
        n["id"]: n for n in (graph.get("nodes") or [])
        if isinstance(n, dict) and n.get("id")
    }
    now = _task_timestamp()
    flagged = []
    for node_id in node_ids:
        node = nodes_by_id.get(node_id)
        if node is None or node.get("status") in _DOC_STATUS_FROZEN:
            continue
        node_path = str(node.get("path") or "").replace("\\", "/")
        if node_path and node_path in changed_set:
            # doc updated alongside the code it documents -- re-baseline,
            # don't just skip (Review round 7, M3).
            provenance = dict(node.get("provenance") or {})
            fresh_sha = _doc_git_sha(ws, node_path)
            if node.get("status") != DOC_STATUS_CURRENT or provenance.get("sha") != fresh_sha:
                node["status"] = DOC_STATUS_CURRENT
                node["confidence"] = "high"
                provenance["sha"] = fresh_sha
                provenance["updatedAt"] = now
                node["provenance"] = provenance
            continue
        node["status"] = DOC_STATUS_STALE
        node["confidence"] = "low"
        provenance = dict(node.get("provenance") or {})
        provenance["updatedAt"] = now
        node["provenance"] = provenance
        flagged.append({
            "nodeId": node_id,
            "reason": "impacted by changed files in this session's diff",
        })
    _write_doc_graph(ws, graph)
    return flagged


def check_doc_drift(graph: dict, ws) -> list:
    """Task 7.2 ("Drift detection"): deterministic drift check -- for each
    doc-type node (except frozen DEPRECATED/GENERATED), read its own file
    and regex-scan it for backticked, repo-path-looking references (see
    _DOC_PATH_REF_RE), narrowed to plausible paths by
    _looks_like_doc_path_ref (Review round 7, M2 -- the raw regex alone
    also matches prose like `Node.js`/`example.com`, which is never a
    path reference). Any reference that doesn't resolve to a real path
    under `ws` is a drift finding. Findings are capped at 10 per node,
    recorded at node.provenance.driftFindings, and any node with at least
    one finding is flagged STALE. Writes the graph back atomically.
    Returns [{"nodeId", "reason"}] for every node with new findings --
    callers emit documentation_stale_detected from this."""
    now = _task_timestamp()
    flagged = []
    for node in graph.get("nodes") or []:
        if not isinstance(node, dict) or node.get("type") != "doc":
            continue
        if node.get("status") in _DOC_STATUS_FROZEN:
            continue
        abs_path = Path(ws) / str(node.get("path") or "")
        if not abs_path.is_file():
            continue  # verify_doc_nodes already marks this MISSING
        try:
            text = abs_path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue

        findings = []
        for ref in _DOC_PATH_REF_RE.findall(text):
            if not _looks_like_doc_path_ref(ref):
                continue
            if (Path(ws) / ref).exists():
                continue
            findings.append(ref)
            if len(findings) >= 10:
                break
        if not findings:
            continue

        provenance = dict(node.get("provenance") or {})
        provenance["driftFindings"] = findings[:10]
        provenance["updatedAt"] = now
        node["provenance"] = provenance
        node["status"] = DOC_STATUS_STALE
        node["confidence"] = "low"
        flagged.append({
            "nodeId": node["id"],
            "reason": f"{len(findings)} documented path reference(s) not found",
        })
    _write_doc_graph(ws, graph)
    return flagged


def compute_doc_gate(doc_graph, doc_node_ids: list) -> "bool | None":
    """Task 7.1's tri-state gates["documentationCurrent"] derivation,
    extracted as a pure function (Review round 7, Minor 1 / the selfcheck
    gap C1 exposed): both main() and --doc-graph-selfcheck now call this
    SAME function, instead of the selfcheck asserting against a private
    re-implementation that could silently drift from what main() actually
    does -- which is exactly how C1 (the gate never actually blocking)
    went undetected.

    doc_graph is None: no docs/graph.json in this repo -- ALWAYS None
    (Review round 7, C3), regardless of what O2 phase 1's one-way
    detect_documentation_impact detector found. That detector can only
    ever emit False or None, never True (it has no way to verify docs
    actually ARE current), so once C1 made this gate's value actually
    reach gates_block_verified, letting a no-graph repo's False through
    here would permanently brick every repo that never opted into the
    graph the instant it touched a routes/schema/api/config/auth-shaped
    file, with no action the engineer could take to clear it -- exactly
    the Round-2 deadlock this gate was designed never to reintroduce.
    That detector's finding still drives its own REQUIRED documentation
    task (see run_doc_pass) -- it just never reaches the VERIFIED gate
    for a repo with no graph to verify against.
    doc_graph present but doc_node_ids is empty: None -- graph-based
    verification ran and found nothing this diff impacts, honestly "not
    applicable".
    doc_graph present and impacted: True only when EVERY impacted node
    verifies CURRENT; False when any is STALE/MISSING/otherwise
    unproven -- never a guessed True."""
    if doc_graph is None:
        return None
    if not doc_node_ids:
        return None
    doc_nodes_by_id = {n["id"]: n for n in doc_graph.get("nodes") or [] if n.get("id")}
    impacted_statuses = [doc_nodes_by_id[n]["status"] for n in doc_node_ids if n in doc_nodes_by_id]
    if any(s in (DOC_STATUS_STALE, DOC_STATUS_MISSING) for s in impacted_statuses):
        return False
    if impacted_statuses and all(s == DOC_STATUS_CURRENT for s in impacted_statuses):
        return True
    # UNVERIFIED/DEPRECATED/GENERATED among the impacted set: not proven
    # current, but also not an outright drift finding -- conservative
    # False, never a guessed True.
    return False


def run_doc_pass(ws, events_path, sid, manifest: dict, tasks, session) -> None:
    """Task 7.1/7.2, Review round 7 (C1): the full deterministic doc pass
    -- load the graph, verify nodes, map this session's FINAL changed-
    file set to impacted doc nodes, apply impact/drift, and derive
    gates["documentationCurrent"] via compute_doc_gate. Mutates
    `manifest` in place (gates, documentationImpact*, and -- when a task
    graph exists -- appends a documentation task via save_tasks).

    Called from exactly ONE place in main() per session (guarded by the
    `doc_pass_done` flag there), and it must be called BEFORE
    gates_block_verified is consulted -- this is the fix for C1, where
    the equivalent logic used to run only in `finally`, strictly AFTER
    VERIFIED had already been decided, making the gate purely decorative.
    Requires manifest["finalChangedFiles"] to already reflect the
    session's true final diff (i.e. collapse() has already run) -- see
    main()'s call site."""
    final_changed_files = manifest["finalChangedFiles"]
    doc_impacts = detect_documentation_impact(final_changed_files)
    doc_graph = load_doc_graph(ws)
    doc_node_ids = []
    if doc_graph is not None:
        for verified in verify_doc_nodes(doc_graph, ws):
            emit_event(events_path, "documentation_verified", sid,
                       nodeId=verified["nodeId"], status=verified["status"])

        doc_node_ids = map_changed_files_to_doc_nodes(doc_graph, final_changed_files)
        if doc_node_ids:
            emit_event(events_path, "documentation_impact_detected", sid,
                       files=final_changed_files, nodeIds=doc_node_ids)
            for stale in apply_doc_impact(doc_graph, ws, final_changed_files, doc_node_ids):
                emit_event(events_path, "documentation_stale_detected", sid,
                           nodeId=stale["nodeId"], reason=stale["reason"])
        for drifted in check_doc_drift(doc_graph, ws):
            emit_event(events_path, "documentation_stale_detected", sid,
                       nodeId=drifted["nodeId"], reason=drifted["reason"])

    # Same merge-not-clobber discipline as every other gates writer (e.g.
    # architectureApproved, set earlier in the same run) -- read whatever
    # is already there and add this key onto it.
    gates = dict(manifest.get("gates") or {})
    gates["documentationCurrent"] = compute_doc_gate(doc_graph, doc_node_ids)
    manifest["gates"] = gates

    if doc_impacts:
        manifest["documentationImpact"] = doc_impacts
        if doc_node_ids:
            manifest["documentationImpactNodeIds"] = doc_node_ids
        # C3's machinery: only append when a task graph actually exists
        # for this session (--architect-first produced a usable plan). No
        # tasks.json is ever created just for this -- same zero-behavior-
        # change-without-a-plan contract C3 itself uses.
        if tasks is not None:
            doc_task = documentation_task(_next_task_id(tasks), doc_impacts, doc_node_ids)
            tasks.append(doc_task)
            save_tasks(session, tasks)
            emit_event(events_path, "task_created", sid,
                       taskId=doc_task["id"], kind=doc_task["kind"],
                       description=doc_task["description"][:200],
                       source=doc_task["source"], priority=doc_task["priority"])


# ============================================================
# Task 7.3 (V7 "Architecture Decision Records" / "ADR consultation"): the
# ADR store lives at <workspace>/docs/decisions/ADR-NNNN.md, one file per
# decision, a simple frontmatter block (not a real YAML parser -- stdlib
# only, and the shape is deliberately this simple):
#
#   ---
#   id: ADR-0001
#   status: accepted
#   areas: [auth, backend]
#   title: Some decision title
#   ---
#   Context / Decision / Consequences prose...
#
# ADRs are HUMAN-authored. Nothing in this file (or anywhere in Glimmer)
# ever writes one -- load_adrs below is a READER ONLY. This is the
# hallucination guard V7's "ADR consultation" section calls for:
# Glimmer must never invent architectural history, only surface real,
# human-recorded decisions to the architect.
# ============================================================

ADR_DECISIONS_RELATIVE_DIR = "docs/decisions"
ADR_MAX_COUNT = 100
ADR_PROMPT_MAX_MATCHED = 5
ADR_PROMPT_BODY_CHARS = 500

_ADR_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)


def _parse_adr_frontmatter(text: str):
    """Tolerant parser for the `--- key: value ... ---` frontmatter block
    above -- plain `key: value` lines, `areas` additionally accepting an
    inline bracket list (`areas: [a, b]`). Returns (fields dict, body str),
    or None when the text has no recognizable frontmatter block at all
    (the caller treats None as "malformed, skip + warn" -- never raises)."""
    m = _ADR_FRONTMATTER_RE.match(text)
    if not m:
        return None
    fm_text, body = m.group(1), m.group(2)
    fields = {}
    for line in fm_text.splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip().lower()
        value = value.strip()
        if key == "areas" and value.startswith("[") and value.endswith("]"):
            value = [v.strip().strip("'\"") for v in value[1:-1].split(",") if v.strip()]
        fields[key] = value
    return fields, body.strip()


def load_adrs(ws) -> list:
    """Task 7.3: tolerant reader for <ws>/docs/decisions/ADR-*.md. Absent
    directory -> [] (most repos have no ADRs yet -- an honest "not
    applicable", not an error). A single malformed file (no frontmatter,
    or no id) is skipped with a warning -- it never aborts the whole read,
    same discipline as load_doc_graph. Capped to the first ADR_MAX_COUNT
    files in sorted (filename) order, so ADR-0001..ADR-0100 always win
    over anything past that -- deterministic, and a runaway ADR count
    can't blow up prompt-building."""
    decisions_dir = Path(ws) / ADR_DECISIONS_RELATIVE_DIR
    if not decisions_dir.is_dir():
        return []

    adrs = []
    for path in sorted(decisions_dir.glob("ADR-*.md"))[:ADR_MAX_COUNT]:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            print(f"[V2] WARN: unreadable ADR {path}: {exc}")
            continue
        parsed = _parse_adr_frontmatter(text)
        if parsed is None:
            print(f"[V2] WARN: malformed ADR (no frontmatter): {path}")
            continue
        fields, body = parsed
        adr_id = fields.get("id")
        if not adr_id:
            print(f"[V2] WARN: malformed ADR (no id): {path}")
            continue
        areas = fields.get("areas")
        if not isinstance(areas, list):
            areas = [a for a in re.split(r"[,\s]+", str(areas or "")) if a]
        adrs.append({
            "id": str(adr_id),
            "status": fields.get("status") or "proposed",
            "areas": [str(a).lower() for a in areas],
            "title": fields.get("title") or str(adr_id),
            "body": body,
            "path": str(path.relative_to(Path(ws))),
        })
    return adrs


def _adr_contract_tokens(contract) -> set:
    """The exact-token universe an ADR's areas[] are matched against:
    the contract's scope tokens (same _skills_scope_text/_segment_tokens
    pair select_skills uses for skill-area matching) UNIONED with the
    contract's objective tokens -- Task 7.3 explicitly calls for matching
    "the contract's area/objective tokens", and ADR areas are plain words
    like skill areas, so the identical tokenizer/boundary rules apply."""
    contract = contract or {}
    tokens = set(_segment_tokens(_skills_scope_text(contract)))
    tokens |= set(_segment_tokens(str(contract.get("objective") or "")))
    return tokens


def select_matching_adrs(contract, adrs) -> list:
    """Task 7.3 ("ADR consultation"): which ADRs match this contract --
    deterministic EXACT-token match against adr["areas"], same discipline
    as select_skills (a raw substring test would let a short area like
    "ui" match unrelated tokens that merely contain those letters) --
    NEVER a model judgment. Ordered by id ascending (stable, reproducible
    prompt) and capped to ADR_PROMPT_MAX_MATCHED.

    Review round 7 (M4): only status=="accepted" ADRs are eligible at
    all -- the spec's "ADR consultation" section scopes the architect's
    deference to an ACTIVE ADR ("if Engineer proposes something that
    conflicts with an active ADR"); a superseded/rejected/still-proposed
    one is explicitly not that, and the prompt's own instruction ("flag
    an ARCHITECTURAL DEVIATION instead of silently overriding it") would
    otherwise tell the architect to defend a decision that was already
    overturned, or one nobody accepted in the first place. Filtered
    before the cap, so an accepted ADR is never bumped out by older
    non-accepted ones."""
    tokens = _adr_contract_tokens(contract)
    if not tokens:
        return []
    matched = [
        adr for adr in (adrs or [])
        if adr.get("status") == "accepted"
        and any(area and area in tokens for area in adr.get("areas") or [])
    ]
    matched.sort(key=lambda a: a["id"])
    return matched[:ADR_PROMPT_MAX_MATCHED]


def select_matching_adr_ids(contract, ws) -> list:
    """Task 7.3: just the ids from select_matching_adrs(contract,
    load_adrs(ws)) -- the one call site both build_adr_prompt_section and
    make_review_request's additive matchedAdrIds field need. `ws` is None
    whenever there's no real workspace to read from (mirrors
    build_adr_prompt_section's own None-safety); never raises."""
    if not ws:
        return []
    try:
        return [a["id"] for a in select_matching_adrs(contract, load_adrs(ws))]
    except Exception:
        return []


def build_adr_prompt_section(contract, ws) -> str:
    """Task 7.3: the "ARCHITECTURE DECISION RECORDS" block make_architect_
    prompt appends -- "" (byte-for-byte no change) whenever ws is None,
    docs/decisions/ doesn't exist, or nothing matches this contract.
    Same never-raises-into-"" discipline as build_skills_block. Reminds
    the architect in-band that ADRs are human-authored and consumption-
    only -- the hallucination guard from V7's "ADR consultation" section
    lives here in the prompt text, not just in load_adrs never writing."""
    if not ws:
        return ""
    try:
        matched = select_matching_adrs(contract, load_adrs(ws))
    except Exception:
        return ""
    if not matched:
        return ""

    parts = []
    for adr in matched:
        body = adr["body"]
        if len(body) > ADR_PROMPT_BODY_CHARS:
            body = body[:ADR_PROMPT_BODY_CHARS] + "...[truncated]"
        parts.append(f"--- {adr['id']} ({adr['status']}): {adr['title']} ---\n{body}")
    block = "\n\n".join(parts)
    return (
        "\n\nARCHITECTURE DECISION RECORDS -- HUMAN-authored, matched "
        "deterministically by exact area/objective token (never a model "
        f"judgment), at most {ADR_PROMPT_MAX_MATCHED}. These record WHY "
        "past decisions were made. If your plan conflicts with one, flag "
        "an ARCHITECTURAL DEVIATION instead of silently overriding it -- "
        "an ADR may be superseded, but that must be an explicit decision. "
        "Glimmer never generates ADRs itself -- only a human authors "
        "them:\n" + block
    )


# ============================================================
# Task 7.4 (V7 "Bootstrapping an existing repository"): --docs-bootstrap
# builds the initial docs/graph.json skeleton (+ docs/decisions/ +
# docs/README.md) for a repo that has neither yet. One node per
# package/config/workflow from the existing repo map, all stamped
# status=GENERATED -- which is already a FROZEN status (_DOC_STATUS_
# FROZEN, Task 7.1): verify_doc_nodes/apply_doc_impact/check_doc_drift
# all leave GENERATED nodes untouched, so a bootstrapped skeleton stays
# honestly "unverified, machine-generated" until a human actually curates
# it -- exactly the "ratchet" the architecture doc's bootstrap section
# describes, with zero new status-machine code needed.
# ============================================================

DOCS_README_RELATIVE_PATH = "docs/README.md"

_DOCS_README_STUB = """# Documentation graph

This directory holds Glimmer's machine-readable documentation intelligence
for this repository:

- `graph.json` -- nodes (systems/services/routes/schemas/configs/docs) and
  the edges between them, each carrying a `status` (CURRENT/STALE/
  UNVERIFIED/MISSING/DEPRECATED/GENERATED) and a `provenance` record of
  the evidence/commit it was last verified against.
- `decisions/ADR-NNNN.md` -- human-authored Architecture Decision Records.
  Glimmer only ever *reads* these; it never writes or generates one.

## Honesty about GENERATED nodes

Every node created by `--docs-bootstrap` is stamped `status: GENERATED` --
a real, factual inventory entry (a package, a config file, a CI workflow
that exists on disk), NOT a verified description of what that thing does
or why. GENERATED nodes are left alone by verification/drift/impact
checks until a human curates them (fills in an honest title, sets a real
status, links them to actual documentation) -- at that point they become
ordinary CURRENT/STALE/UNVERIFIED nodes like any hand-authored one.

Every area Glimmer touches should end up at least as well documented as
before it started -- preferably better.
"""


def build_docs_bootstrap_graph(repo_map: dict) -> dict:
    """Task 7.4: pure function, repo_map (build_repo_map's shape) -> an
    initial graph.json skeleton. One node per package/config/workflow
    entry, type-mapped onto the graph's system|service|route|schema|
    config vocabulary (workflow -> config: there is no dedicated
    "workflow" node type, same coarse-heuristic spirit as Task 7.2's
    _CATEGORY_TO_NODE_TYPE mapping "api"/"auth" onto "service"). Every
    node: status=GENERATED, confidence="unknown", provenance={"evidence":
    [], "sha": None} -- an honest "this is a real, factual inventory
    entry, nothing more" per Bootstrap Phase 3 ("low-risk factual graph
    nodes"). No edges -- inferring a "documents" edge would be a claim
    this phase doesn't support."""
    nodes = []
    seen_ids = set()

    def _add(node_id, node_type, path, title):
        if node_id in seen_ids:
            return
        seen_ids.add(node_id)
        nodes.append({
            "id": node_id,
            "type": node_type,
            "path": path,
            "title": title,
            "status": DOC_STATUS_GENERATED,
            "confidence": "unknown",
            "provenance": {"evidence": [], "sha": None},
        })

    for pkg in repo_map.get("packages") or []:
        if not isinstance(pkg, dict):
            continue
        dir_ = pkg.get("dir") or "."
        node_id = "service:root" if dir_ == "." else f"service:{dir_}"
        _add(node_id, "service", dir_, pkg.get("name") or dir_)

    for cfg in repo_map.get("configs") or []:
        _add(f"config:{cfg}", "config", str(cfg), str(cfg))

    for wf in repo_map.get("workflows") or []:
        _add(f"config:{wf}", "config", str(wf), str(wf))

    return {"schemaVersion": 1, "nodes": nodes, "edges": []}


def _docs_bootstrap(workspace) -> int:
    """Task 7.4 CLI entry point (`--docs-bootstrap <workspace>`): builds
    docs/graph.json + docs/decisions/ + docs/README.md. NEVER overwrites
    an existing graph.json -- fails loud (a human, or a prior bootstrap,
    already owns that file; silently clobbering real curation would be
    the opposite of honest). Prints a summary. No model call anywhere in
    this path -- deterministic, same as the rest of Task 7.1/7.2/7.4."""
    ws = Path(workspace).expanduser().resolve()
    if not ws.is_dir():
        print(f"[V2] --docs-bootstrap: workspace not found: {ws}", file=sys.stderr)
        return 1

    graph_path = ws / DOC_GRAPH_RELATIVE_PATH
    if graph_path.exists():
        print(
            f"[V2] --docs-bootstrap: refusing to overwrite existing "
            f"{DOC_GRAPH_RELATIVE_PATH} -- delete it first if you really "
            "want to regenerate the skeleton.",
            file=sys.stderr,
        )
        return 1

    repo_map = build_repo_map(ws)
    graph = build_docs_bootstrap_graph(repo_map)

    graph_path.parent.mkdir(parents=True, exist_ok=True)
    graph_path.write_text(json.dumps(graph, indent=2), encoding="utf-8")

    (ws / ADR_DECISIONS_RELATIVE_DIR).mkdir(parents=True, exist_ok=True)

    readme_path = ws / DOCS_README_RELATIVE_PATH
    if not readme_path.exists():
        readme_path.write_text(_DOCS_README_STUB, encoding="utf-8")

    by_type = {}
    for n in graph["nodes"]:
        by_type[n["type"]] = by_type.get(n["type"], 0) + 1
    counts = ", ".join(f"{k}={v}" for k, v in sorted(by_type.items())) or "none"
    print(f"[V2] --docs-bootstrap: wrote {DOC_GRAPH_RELATIVE_PATH} "
          f"({len(graph['nodes'])} nodes: {counts})")
    print(f"[V2] --docs-bootstrap: {ADR_DECISIONS_RELATIVE_DIR}/ ready for human-authored ADRs")
    print(f"[V2] --docs-bootstrap: {DOCS_README_RELATIVE_PATH} written")
    print("[V2] --docs-bootstrap: every node is status=GENERATED (unverified until a human curates it)")
    return 0


# ============================================================
# Task 4.1 (V7 §21 x task list): repair tasks -- auto-created each time a
# required-tier verify() failure triggers an actual repair round (see
# main()'s build_repair_contract call site). Makes the repair loop visible
# and auditable in the same tasks.json the architect-plan-derived tasks
# already live in, instead of only existing as repair-NN.json files.
# ============================================================


def create_repair_task(next_id: int, repair_contract: dict) -> dict:
    """Task 4.1: one bounded repair task per repair round, created right
    after build_repair_contract (same call site, same "attempt_number"
    numbering). kind="repair"/source="repair"/priority="required" -- a
    repair round exists because something REQUIRED just failed, so the
    task created to track fixing it is required too.

    completion.type="check_passed" with completion.check set to the
    LITERAL failing command string (repair_contract["failedCheck"]) --
    deliberately NOT the fuzzy description-based match plan-derived
    verification tasks use (completion.check=None there): a repair task
    already knows exactly which command it exists to fix, so
    evaluate_verification_tasks exact-matches it against a later verify()
    result's `command` field instead of guessing via token overlap.
    Status starts "in_progress" (the repair round this task represents is
    about to run immediately) and flips to complete/failed the same way
    any check_passed task does, once verify() runs again.

    affectedFiles mirrors the repair contract's own (advisory) allowedFiles
    guidance. createdBecause records the same failedCheck the task exists
    to resolve -- read by required_tasks_resolved's supersede check (see
    _superseded_by_repair) to recognize that a stale fuzzy-matched
    plan-derived verification task and this repair task are about the same
    underlying failure."""
    now = _task_timestamp()
    failed_check = repair_contract.get("failedCheck")
    return {
        "id": f"t{next_id}",
        "description": (
            f"Repair failing check: {failed_check}" if failed_check
            else "Repair failing check"
        ),
        "kind": "repair",
        "dependsOn": [],
        "status": "in_progress",
        "source": "repair",
        "priority": "required",
        "evidenceIds": [],
        "affectedFiles": list(repair_contract.get("allowedFiles") or []),
        "blockingReason": failed_check,
        "createdAt": now,
        "updatedAt": now,
        "completion": {"type": "check_passed", "check": failed_check},
        "createdBecause": failed_check,
    }


_BLOCKING_REASON_CHECK_FAILED_PREFIX = "check failed: "


def _failed_check_command(task: dict) -> str | None:
    """Fix round 1 (IMPORTANT 2) helper: the exact command a check_passed
    task most recently failed on, extracted from the blockingReason
    evaluate_verification_tasks stamps on a CODE_FAIL match ("check
    failed: <command>" -- see that function). None for anything else
    (task never failed that way, or blockingReason is plain prose from a
    different kind of failure -- e.g. an implementation task's "engineer
    exited non-zero"/"engineer made no file changes")."""
    reason = task.get("blockingReason")
    if isinstance(reason, str) and reason.startswith(_BLOCKING_REASON_CHECK_FAILED_PREFIX):
        return reason[len(_BLOCKING_REASON_CHECK_FAILED_PREFIX):]
    return None


def _superseded_by_repair(task: dict, tasks: list) -> bool:
    """Task 4.2 helper, rewritten fix round 1 (IMPORTANT 2): is `task` (a
    required task currently sitting at status=="failed") honestly resolved
    because a repair task created for the SAME exact check already
    reached "complete"? Used only by required_tasks_resolved.

    Fix round 1: the original version compared the repair task's
    createdBecause command against `task`'s prose description via the
    FUZZY _match_verify_result -- reproduced fail-open against a real
    session fixture (an unrelated implementation task's prose token-
    overlapped a repair task's createdBecause purely on shared words,
    wrongly "superseding" a failure that was never actually fixed).
    Fuzzy matching has no place in a supersede decision, so this now
    compares EXACT command strings only: `task` must itself be a
    check_passed task that failed against a KNOWN command (blockingReason
    == "check failed: <command>", stamped by evaluate_verification_tasks
    -- see _failed_check_command). An implementation task's blockingReason
    is always plain prose ("engineer exited non-zero" / "engineer made no
    file changes"), never that shape, so it can never be superseded this
    way, by construction -- only a failed verification/repair task can be.
    A repair task supersedes `task` only when its OWN completion.check
    (not createdBecause, which is display-only) equals that exact command
    and its status is "complete"."""
    failed_command = _failed_check_command(task)
    if failed_command is None:
        return False
    for other in tasks:
        if other.get("kind") != "repair" or other.get("status") != "complete":
            continue
        if (other.get("completion") or {}).get("check") == failed_command:
            return True
    return False


def load_task_overrides(session_dir) -> dict:
    """Task 4.3: read task-overrides.json -- a GATEWAY/human-owned sidecar,
    exactly like human-acceptance.json (§14): written ONLY by the Control
    Center's POST /sessions/:id/tasks/:taskId/skip|approve routes
    (control-center/server/src/lib/sessions.ts writeTaskOverride).
    glimmer-v2.py NEVER writes this file, only reads it here, so a human's
    skip/approve decision and the orchestrator's own evidence-derived task
    state stay two genuinely separate facts -- the same trust model as
    the accepted/verified split. Shape: {taskId: {action, at}}.

    Returns {} on every degraded case (file missing, unreadable, not
    valid JSON, not an object) -- same uniform-degrade-to-empty contract
    as load_architecture_plan's uniform None, just {} here since every
    caller only ever does overrides.get(task_id) against it."""
    path = Path(session_dir) / "task-overrides.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _matching_task_override(task: dict, overrides: dict) -> dict | None:
    """Task 4.3 / review round 1 (Important 3): returns the override
    record for `task` from task-overrides.json ONLY when it still
    describes the SAME task, else None. Task ids are NOT stable across a
    replan (merge_replanned_tasks/_next_task_id can renumber), so an
    override recorded for an id that got reassigned to an unrelated task
    must not be silently applied to that new task. An override is
    trusted by id alone only when it carries no kind/description at all
    (a legacy record, written before this round existed); otherwise both
    must match the task's CURRENT kind/description exactly, or this
    returns None (a stale/recycled-id override -- ignored, same
    "id + facts must both check out" discipline control-center's
    applyTaskOverrides applies for display)."""
    override = overrides.get(task.get("id"))
    if not isinstance(override, dict) or override.get("action") not in ("skip", "approve"):
        return None
    if "kind" in override or "description" in override:
        if override.get("kind") != task.get("kind") or override.get("description") != task.get("description"):
            return None
    return override


def _tasks_resolved_by_override(tasks, overrides: dict | None = None) -> list:
    """Task 4.3 / review round 1 (Important 1): the (taskId, action) pairs
    -- in tasks order -- for every priority=="required" task whose
    resolution comes from a matching human override rather than
    orchestrator-derived evidence (complete / superseded-by-repair).
    Shares required_tasks_resolved's exact same per-task resolution
    order/logic (kept in lockstep deliberately: both walk "complete? ->
    superseded? -> matching override?" for the same reason) so the two
    can never silently disagree about which tasks are override-resolved.
    Used both to decide gates["tasksResolvedBy"] and to emit one
    task_override_applied event per such task, at gate-computation time
    -- see both call sites in main()."""
    if not tasks:
        return []
    overrides = overrides or {}
    out = []
    for t in tasks:
        if t.get("priority") != "required":
            continue
        status = t.get("status")
        if status == "complete" or (status == "failed" and _superseded_by_repair(t, tasks)):
            continue
        override = _matching_task_override(t, overrides)
        if override is not None:
            out.append((t.get("id"), override.get("action")))
    return out


def any_task_resolved_by_human_override(tasks, overrides: dict | None = None) -> bool:
    """Task 4.3 / review round 1 (Important 1): True iff at least one
    required task's resolution came from a human skip/approve override.
    Only meaningful when required_tasks_resolved(tasks, overrides) is
    ALREADY True for the same tasks/overrides -- see the gates.
    tasksResolvedBy call sites in main(), which only stamp "human" when
    it is. A human decision must read visibly differently from a plain
    evidence-derived ✓ (control-center's GatesRow)."""
    return bool(_tasks_resolved_by_override(tasks, overrides))


def required_tasks_resolved(tasks, overrides: dict | None = None) -> bool:
    """Task 4.2 (V7 session completion rule): deterministic gate --
    True iff every priority=="required" task has reached a resolved
    terminal state, defined precisely as:
      - status == "complete", OR
      - status == "failed" AND _superseded_by_repair(task, tasks) is True
        (an exact-matched repair task already proved the underlying check
        now passes -- see that function's docstring for why this is
        honest, not a loophole), OR
      - Task 4.3: a human recorded a matching skip or approve override for
        this task in task-overrides.json (see load_task_overrides and
        _matching_task_override -- "matching" means the id AND, when
        captured, the kind/description all still describe this same
        task) -- a human decision counts as resolved regardless of the
        task's own status. This is deliberately NOT orchestrator-derived
        evidence; it's the same "a human can accept/skip what the
        machine can't verify" trust model as §14's human-acceptance.json.
    Any other status ("pending", "in_progress", or a genuine unsuperseded,
    un-overridden "failed") makes this False -- fail-closed, matching
    every other gate in this file.

    tasks is None or [] (no architect plan ever ran -- C3's task graph is
    inactive, or a plan produced zero implementation/verification steps)
    is vacuously resolved (True): no required tasks were ever declared,
    so there is nothing to block session completion on. This mirrors
    gates.architectureApproved/scopeApproved's own None-passes contract
    when the mechanism producing them never ran."""
    if not tasks:
        return True
    overrides = overrides or {}
    for t in tasks:
        if t.get("priority") != "required":
            continue
        status = t.get("status")
        if status == "complete":
            continue
        if status == "failed" and _superseded_by_repair(t, tasks):
            continue
        if _matching_task_override(t, overrides) is not None:
            continue
        return False
    return True


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
    # "refactor" added review round 1 (Task 2.1 fix): makes compute_architect_risk's
    # mode_refactor signal reachable end-to-end -- previously no --mode value
    # could ever produce it.
    ap.add_argument("--mode", choices=("inspect", "plan", "implement", "debug", "test", "review", "refactor"),
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
    # V7 §21: the structured repair contract built from the PREVIOUS failed
    # attempt, consumed by make_prompt on the NEXT (repair) iteration and by
    # the outside-allowed advisory check right after that iteration's
    # engineer run. None on iteration 0 and on every non-repair path.
    repair_contract = None
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
    # Review round 7 (C1): whether run_doc_pass has already run this
    # session. Set True at the one call site inside the `if ok:` branch
    # below (the only place a real VERIFIED promotion can happen); the
    # `finally` block's fallback call is skipped when this is already
    # True, so the doc pass -- and its graph.json writes/events -- runs
    # exactly once per session regardless of which exit path is taken.
    doc_pass_done = False
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
            # Task 5.3 (V7 §27): reorder candidateFiles by deterministic
            # score before anything reads it, computed ONCE (Fix round 1,
            # LOW) and threaded into read_candidate_evidence rather than
            # re-ranked a second time there.
            rank_by_path = _rerank_plan_candidates(architecture_plan, contract, repo, ws, events_path, sid)
            candidate_evidence = read_candidate_evidence(architecture_plan, ws, rank_by_path=rank_by_path)
            # C2: gates/architectReviews are only ever added to the
            # manifest when a usable plan exists — with no plan there is
            # nothing to review against, so C2 never runs and these keys
            # would otherwise be pure clutter on a run_architect run that
            # didn't even get a usable plan (mirrors architectPlan's own
            # run_architect gating just above).
            if architecture_plan is not None:
                manifest["gates"] = {"architectureApproved": None}
                manifest["architectReviews"] = {"max": ARCHITECT_REVIEW_BUDGET, "used": 0}
                # Task 2.2 (V7 §5.12): persist v1 into the plan-history
                # array + write architecture-plan-v1.json alongside the
                # existing architecture-plan.json (gateway readers keep
                # working unchanged -- that file always holds the latest
                # version).
                record_architecture_plan_version(session, manifest, architecture_plan)
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
                               description=t["description"][:200],
                               source=t.get("source"), priority=t.get("priority"))
            save()

        for iteration in range(args.max_repairs + 1):
            if iteration > 0:
                emit_event(events_path, "repair_started", sid, iteration=iteration)
            prompt = make_prompt(contract, summary, iteration, failure, checkpoint_sha,
                                 plan=architecture_plan, evidence=candidate_evidence,
                                 repair_contract=repair_contract, tasks=tasks)
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
                                 plan_candidate_count=len(candidate_evidence),
                                 architect_consult_enabled=architecture_plan is not None)
            # Task 2.3 (V7 §5.11): gates.implementationComplete tracks the
            # MOST RECENT engineer invocation this iteration -- a revise
            # round below reassigns this to revise_rc, exactly mirroring
            # which rc evaluate_implementation_tasks was last called with.
            last_engineer_rc = rc
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

            # R4 Scope Guard: classify. Task 2.3 (V7 §5.11) graduates this
            # from advisory-only to a real VERIFIED-blocking signal — see
            # scope_guard_gate_value/gates_block_verified below, consulted
            # only after verify() ok (a real expansion here now surfaces as
            # gates.scopeApproved = false, not just a printed WARN).
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

            # V7 §21, advisory only: did THIS repair round's writes land
            # outside the allowedFiles guidance the previous failure built?
            # iteration 0 is never a repair round (repair_contract is None
            # there), and this is deliberately separate from the scope guard
            # above -- allowedFiles is a heuristic derived from one failing
            # check's output, not the task contract's declared scope, so it
            # gets its own (still advisory) signal rather than being folded
            # into scopeGuard.
            if iteration > 0 and repair_contract is not None:
                outside_allowed = compute_repair_writes_outside_allowed(files, repair_contract)
                attempt["repairWritesOutsideAllowed"] = outside_allowed
                if outside_allowed:
                    print(f"[V2] WARN: repair contract — {len(outside_allowed)} changed file(s) outside "
                          f"allowedFiles guidance {repair_contract.get('allowedFiles')}: {outside_allowed}")

            # Task 1.4 (V7 §6): budgets.maxChangedFiles -- distinct from the
            # scope guard above (which now blocks too, but only after
            # verify() ok, via gates.scopeApproved): this DOES block
            # immediately, exceeding it fails the session outright, before
            # verify() ever runs for this iteration.
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
                commands = expand_verify_entries(commands, args.verify, session, args.visual_url, args.model_readiness_url,
                                                  visual_requirements=sanitize_visual_requirements(architecture_plan))
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
                        # Review round 1 (minor): the checks genuinely ran
                        # and passed on this path too (just against an empty
                        # diff) -- record verificationPassed so GatesRow
                        # isn't blank on a verified session. Merge, don't
                        # clobber (same discipline as every other gates
                        # writer).
                        gates = dict(manifest.get("gates") or {})
                        gates["verificationPassed"] = True
                        # Fix round 1 (MODERATE 5): implementationComplete is
                        # null/not-applicable here, NOT False -- a no-change
                        # session is a legitimate "nothing needed doing"
                        # terminal (no engineer run produced this diff at
                        # all, so there is nothing honest to claim True OR
                        # False about it), same as architectureApproved/
                        # scopeApproved already read null when their own
                        # mechanism never ran. Because gates_block_verified's
                        # documented invariant is that implementationComplete
                        # is ALWAYS a real True/False by the time it's called
                        # (never an honest null), this path does NOT route
                        # the promotion decision through gates_block_verified
                        # itself -- only gates.tasksResolved actually applies
                        # to a no-change session, and is checked directly,
                        # below, the same True/False/None contract every
                        # other gate here follows.
                        gates["implementationComplete"] = None
                        # Task 4.3: a human skip/approve override (task-
                        # overrides.json, gateway-owned) can resolve a
                        # required task the orchestrator itself never saw
                        # complete -- see required_tasks_resolved.
                        task_overrides = load_task_overrides(session) if tasks is not None else None
                        gates["tasksResolved"] = (
                            required_tasks_resolved(tasks, task_overrides) if tasks is not None else None
                        )
                        # Review round 1 (Important 1): a human override
                        # (not orchestrator evidence) resolving a required
                        # task must read visibly differently -- stamp
                        # provenance and emit one task_override_applied
                        # event per such task, at this gate-computation
                        # moment (see _tasks_resolved_by_override).
                        if gates["tasksResolved"] and tasks is not None:
                            override_resolutions = _tasks_resolved_by_override(tasks, task_overrides)
                            if override_resolutions:
                                gates["tasksResolvedBy"] = "human"
                                for task_id, action in override_resolutions:
                                    emit_event(events_path, "task_override_applied", sid, taskId=task_id, action=action)
                        manifest["gates"] = gates

                        if gates["tasksResolved"] is False:
                            # Fix round 1 (MODERATE 5): "no bypass" -- a
                            # required task left unresolved (e.g. a prior
                            # repair round's task never actually completed)
                            # must block promotion here exactly like it
                            # blocks the real-diff VERIFIED path below.
                            blocked_gates = ["tasksResolved"]
                            attempt["blockedGates"] = blocked_gates
                            manifest["blockedGates"] = blocked_gates
                            attempt["status"] = "needs-architect-review-consistency-rejected"
                            manifest["attempts"].append(attempt)
                            manifest["status"] = "needs-architect-review-consistency-rejected"
                            manifest["state"] = canonical_session_state(manifest["status"])
                            emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
                            final_label = "NOT VERIFIED — GATE BLOCKED (tasksResolved)"
                            print("\n[V2] gates blocked promotion to verified: ['tasksResolved']")
                            save()
                            break

                        attempt["status"] = "no-change-verified"
                        manifest["attempts"].append(attempt)
                        manifest["status"] = "no-change-verified"
                        # V7 §20: verification freeze -- verifiedAt lets the
                        # gateway detect (read-time, not enforced by any
                        # daemon here) whether the workspace was written to
                        # again after this VERIFIED promotion. See the
                        # "verified" promotion below for the other site.
                        manifest["verifiedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
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
                        # Task 4.3 (Architect task-list review): only the
                        # very first review of the whole session carries
                        # the derived task list -- one budgeted pass, not
                        # a re-review on every repair round.
                        task_list=(tasks if iteration == 0 and review_round == 1 else None),
                        # Task 7.3 (ADR consultation): computed fresh per
                        # round (cheap -- capped file read) rather than
                        # threaded from outside the loop, so a human
                        # editing docs/decisions/ mid-session is picked up.
                        matched_adr_ids=select_matching_adr_ids(contract, ws),
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

                    # decision_outcome in ("revise", "replan"): both ARE the
                    # disagreement V7 §5.13 budgets -- Task 2.2 shares the
                    # SAME budget/counter across revise and replan rounds
                    # (no separate replan budget). Check budget before
                    # spending it -- a round that would exceed it never runs.
                    #
                    # RULING (round 2): reserve the LAST budget slot for the
                    # post-verify consistency review (V7 §5.10) -- pre-verify
                    # disagreement spending (this revise/replan gate) may
                    # spend at most BUDGET-1 of the shared budget, so a
                    # high-disagreement run can never starve the post-verify
                    # check of the one slot it needs to ever run.
                    if manifest["architectReviews"]["used"] >= ARCHITECT_REVIEW_BUDGET - 1:
                        architect_outcome = "budget_exhausted"
                        break
                    manifest["architectReviews"]["used"] += 1
                    save()

                    # Task 2.2 (V7 §5.12): REPLAN_REQUIRED re-invokes the
                    # architect for a NEW plan version (findings from this
                    # review appended as evidence of why the current
                    # version failed) BEFORE the delta-prompt re-invoke
                    # below -- which then reuses the exact same revise-
                    # style continuation, just with `architecture_plan`
                    # already swapped to the new version.
                    if decision_outcome == "replan":
                        from_version = architecture_plan.get("version", 1)
                        to_version = from_version + 1
                        emit_event(events_path, "architect_replan_started", sid,
                                   fromVersion=from_version, toVersion=to_version,
                                   reviewRound=review_round)
                        new_plan = run_architect_replan(
                            engineer, ws, contract, summary, session, events_path, sid,
                            review, from_version, to_version,
                        )
                        if new_plan is None:
                            # Fail-closed honesty: an invalid/failed replan
                            # must never silently continue implementing
                            # against the just-rejected v{from_version}
                            # plan. Budget is already consumed above --
                            # this is exactly the existing "rejected"
                            # terminal path (needs-architect-review-rejected),
                            # not a new manifest status.
                            print(f"[V2] Replan v{from_version} -> v{to_version} produced no usable "
                                  "plan; failing closed to architecture-review rejection.")
                            architect_outcome = "rejected"
                            break
                        architecture_plan = new_plan
                        record_architecture_plan_version(session, manifest, architecture_plan)
                        # Task 5.3: reorder the NEW plan's candidateFiles
                        # before anything reads it, same single-pass
                        # ranking (Fix round 1, LOW) as the v1 call site
                        # above.
                        rank_by_path = _rerank_plan_candidates(architecture_plan, contract, repo, ws, events_path, sid)
                        # Fix round 1 (MED): the delta prompt below embeds
                        # `candidate_evidence` alongside `plan=architecture_
                        # plan` -- without refreshing it here, it would
                        # still be v{from_version}'s pre-read candidateFiles
                        # evidence, now mislabeled as belonging to the new
                        # plan. read_candidate_evidence is deterministic/
                        # cheap (v2.py re-reading files off disk, no model
                        # call), same as the v1 call site above.
                        candidate_evidence = read_candidate_evidence(architecture_plan, ws, rank_by_path=rank_by_path)
                        # Fix round 1 (MED): risk snapshot must reflect the
                        # NEW plan, not the stale v{from_version} one.
                        manifest["architectPlan"] = architect_plan_manifest_record(architecture_plan)
                        # Fix round 1 (MED): re-derive tasks from the new
                        # plan's implementationPlan/verificationPlan (ids
                        # are NOT stable across derive_tasks calls) --
                        # merge_replanned_tasks carries over an old task's
                        # status onto a new task with an IDENTICAL
                        # (kind, description) pair; anything genuinely new
                        # starts pending. The set_implementation_tasks_
                        # status(in_progress)/reset_verification_tasks_
                        # status(pending) calls a few lines below still run
                        # unchanged right after this -- they reset state
                        # for the upcoming re-invoke exactly as a plain
                        # REVISE_IMPLEMENTATION round already does; this
                        # merge only makes the tasks.json/task_created
                        # events written IN BETWEEN honestly reflect carried-
                        # over progress instead of every task looking
                        # brand new.
                        if tasks is not None:
                            tasks = merge_replanned_tasks(tasks, derive_tasks(architecture_plan))
                            save_tasks(session, tasks)
                            for t in tasks:
                                emit_event(events_path, "task_created", sid,
                                           taskId=t["id"], kind=t["kind"],
                                           description=t["description"][:200],
                                           source=t.get("source"), priority=t.get("priority"))
                        save()

                    print(f"[V2] Architect review requested {review['decision']} "
                          f"(iteration={iteration}, round={review_round}); running one bounded "
                          f"{'replan+' if decision_outcome == 'replan' else ''}revise pass.")
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
                        tasks=tasks,
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
                        architect_consult_enabled=architecture_plan is not None,
                    )
                    last_engineer_rc = revise_rc
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

                # Review round 1 (minor): merge, don't clobber -- same
                # discipline as every other gates writer (finally block's
                # documentationCurrent merge, the post-verify consistency
                # block just below). A wholesale reassignment here would
                # silently wipe out any other gate key already recorded
                # earlier this run.
                gates = dict(manifest.get("gates") or {})
                gates["architectureApproved"] = architect_gates_value(architect_outcome)
                manifest["gates"] = gates
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

            # V7 §18: verification_plan splits required (gates VERIFIED,
            # identical commands verifier_commands+expand_verify_entries has
            # always built for this level) from recommended (the next tier
            # up's extra commands -- run but never gating). V7 §22.18/§22.10
            # (Task 3.3): contract + architecture_plan feed the deterministic
            # visual-requiredness rule table and visualRequirements passthrough
            # -- architecture_plan is None whenever --architect-first wasn't
            # used, which visual_requiredness/sanitize_visual_requirements
            # both already treat identically to "no plan at all".
            plan = verification_plan(repo, files, args.verification_level, args.verify,
                                      session, args.visual_url, args.model_readiness_url,
                                      contract=manifest.get("contract"), plan=architecture_plan)
            commands = plan["required"]
            attempt["verificationPlan"] = {
                "required": [shlex.join(c) for c in plan["required"]],
                "recommended": [shlex.join(c) for c in plan["recommended"]],
            }
            manifest["verificationPlan"] = attempt["verificationPlan"]
            attempt["verificationCommands"] = attempt["verificationPlan"]["required"]

            before = diff_hash(ws, baseline)
            ok, results = verify(ws, commands, args.timeout, session, iteration,
                                 repo, source_root, baseline, args.toolchain_mode,
                                 events_path, sid)
            # V7 §18: recommended checks only run once required already
            # passed -- no point spending time on non-gating extras when a
            # repair round is coming regardless. fail_fast=False so one
            # recommended failure doesn't hide the rest; the aggregate
            # result is deliberately discarded (`_`) -- recommended NEVER
            # feeds `ok`/gating, only its own per-check results, reported
            # below and via each check's own "recommended"-tagged event.
            recommended_results = []
            if ok and plan["recommended"]:
                _, recommended_results = verify(ws, plan["recommended"], args.timeout, session, iteration,
                                                 repo, source_root, baseline, args.toolchain_mode,
                                                 events_path, sid, tier="recommended", fail_fast=False)
            after = diff_hash(ws, baseline)
            attempt["verificationResults"] = results
            attempt["recommendedResults"] = recommended_results
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
                # Task 2.3 (V7 §5.10): post-verification consistency check --
                # cheap, deterministic, no model call by itself. Sits strictly
                # AFTER verify() returned ok=True and BEFORE the VERIFIED
                # promotion just below. plan.candidateFiles/expectedScope are
                # model ESTIMATES, not a contract (see check_post_verification_
                # consistency's docstring) -- a flag alone never blocks;
                # only a real architect rejection of the flagged diff does.
                consistency = check_post_verification_consistency(files, architecture_plan)
                attempt["consistencyCheck"] = consistency
                manifest["consistency"] = consistency
                consistency_gate = True
                architect_reviews = manifest.get("architectReviews")
                if consistency["flagged"]:
                    # Review round 1 (minor): once flagged, default to
                    # indeterminate (None), never True -- a flagged diff
                    # must not silently read as "clean" just because
                    # architecture_plan/architectReviews happened to be
                    # missing. Only an actual review decision below can
                    # promote this to True (approved) or demote it to
                    # False (rejected/unrecognized).
                    consistency_gate = None
                    if (architecture_plan is not None and architect_reviews is not None
                            and architect_reviews["used"] < ARCHITECT_REVIEW_BUDGET):
                        # Fix round 2 (MED): write through manifest["architectReviews"]
                        # directly, the same way the pre-verify site above
                        # does, instead of through the `architect_reviews`
                        # local alias. Both mutate the same dict object at
                        # runtime, but --architect-review-selfcheck /
                        # --architect-replan-selfcheck's structural guard
                        # counts literal occurrences of that increment
                        # expression to prove there are exactly the two
                        # legitimate increment sites (pre-verify revise/
                        # replan loop, this post-verify consistency review)
                        # and no others; an aliased write is invisible to
                        # that count and silently defeats the guard.
                        manifest["architectReviews"]["used"] += 1
                        save()
                        post_review = run_architect_review(
                            engineer, ws, architecture_plan, files, change_types, baseline,
                            session, events_path, sid, iteration, review_round + 1,
                            matched_adr_ids=select_matching_adr_ids(contract, ws),
                        )
                        attempt.setdefault("architectReviews", []).append(
                            {"round": review_round + 1, "review": post_review,
                             "trigger": "post_verification_consistency"}
                        )
                        if post_review is not None:
                            consistency_gate = (
                                classify_architect_review_decision(post_review["decision"]) == "approved"
                            )
                        # else: post_review is None (fail-open) -- consistency_gate
                        # stays the None set just above; never ran, can't tell.
                    # else: no budget left / no plan to review against --
                    # honesty, not a block (V7 §5.10's plan is an estimate,
                    # not a contract): record the flag, leave scopeApproved
                    # indeterminate (null), let VERIFIED proceed.

                # Review round 7 (C1): the doc pass (load graph, verify
                # nodes, map impact, apply impact, drift check, gate
                # derivation) must run -- and gates["documentationCurrent"]
                # must be set -- strictly BEFORE gates_block_verified is
                # consulted below, or the gate is decorative (this is
                # exactly what C1 found: it used to run only in `finally`,
                # after VERIFIED was already decided). It needs the
                # session's FINAL changed-file set, which needs collapse()
                # to have already run; ok=True always exits this loop
                # (break, either branch below), so this genuinely is the
                # last iteration and collapsing here is safe -- the
                # `finally` block's own collapse()/changed_files() calls
                # below are idempotent no-ops once this has already run.
                collapse(ws, baseline)
                manifest["finalHead"] = head(ws)
                manifest["finalChangedFiles"] = changed_files(ws, baseline)
                manifest["checkpointsCollapsed"] = head(ws) == baseline
                run_doc_pass(ws, events_path, sid, manifest, tasks, session)
                doc_pass_done = True

                gates = dict(manifest.get("gates") or {})
                gates["implementationComplete"] = bool(files) and last_engineer_rc == 0
                gates["verificationPassed"] = True
                gates["scopeApproved"] = combine_gate_values(
                    scope_guard_gate_value(scope_result), consistency_gate
                )
                # Task 4.2 (V7 session completion rule): None when C3's task
                # graph never ran for this session (no --architect-first
                # plan) -- same "mechanism didn't run" pass-through every
                # other optional gate above already follows. Task 4.3: a
                # human skip/approve override can also resolve a required
                # task -- see required_tasks_resolved.
                task_overrides = load_task_overrides(session) if tasks is not None else None
                gates["tasksResolved"] = (
                    required_tasks_resolved(tasks, task_overrides) if tasks is not None else None
                )
                # Review round 1 (Important 1): same provenance stamp +
                # event emission as the no-change-verified path above --
                # see that site's comment for why.
                if gates["tasksResolved"] and tasks is not None:
                    override_resolutions = _tasks_resolved_by_override(tasks, task_overrides)
                    if override_resolutions:
                        gates["tasksResolvedBy"] = "human"
                        for task_id, action in override_resolutions:
                            emit_event(events_path, "task_override_applied", sid, taskId=task_id, action=action)
                manifest["gates"] = gates

                if gates_block_verified(gates):
                    # V7 §5.10/§5.11: tests passed but one or more mandatory
                    # gates did not hold; must never be promoted to VERIFIED.
                    # Terminal, same as the pre-verify architect-review
                    # rejection path above (budget for any review round
                    # spent above is already consumed). Review round 1
                    # (Important): three genuinely distinct causes can land
                    # here (a scope-guard expansion, an engineer that
                    # exited non-zero after a passing diff, a real
                    # consistency-review rejection) -- record WHICH gate(s)
                    # actually blocked so classify_failure can build an
                    # honest, cause-naming detail instead of one fixed
                    # string that was wrong for two of the three causes.
                    blocked_gates = blocked_gate_names(gates)
                    attempt["blockedGates"] = blocked_gates
                    manifest["blockedGates"] = blocked_gates
                    attempt["status"] = "needs-architect-review-consistency-rejected"
                    manifest["attempts"].append(attempt)
                    manifest["status"] = "needs-architect-review-consistency-rejected"
                    manifest["state"] = canonical_session_state(manifest["status"])
                    emit_event(events_path, "agent_state_changed", sid, state=manifest["state"])
                    save()
                    final_label = "NOT VERIFIED — GATE BLOCKED (" + ", ".join(blocked_gates) + ")"
                    print(f"\n[V2] gates blocked promotion to verified: {blocked_gates}")
                    break

                attempt["status"] = "verified"
                manifest["attempts"].append(attempt)
                manifest["status"] = "verified"
                # V7 §20: verification freeze -- the orchestrator process
                # exits shortly after this, so there is no daemon left to
                # notice a later write. verifiedAt is the fact the gateway
                # needs to detect staleness itself, read-time, on its next
                # GET (see control-center/server/src/lib/sessions.ts
                # readSession's computeStale option): if the workspace picks
                # up uncommitted changes after this timestamp, the session
                # reads back as "stale" until a fresh run re-verifies it.
                manifest["verifiedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
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
            # V7 §21: structured repair contract for the repair round about
            # to start -- attempt number matches the "REPAIR N" label
            # make_prompt will use next iteration (iteration + 1). Built
            # only here (not on the INFRA_BLOCKED/TIMEOUT/budget-exhausted
            # break paths above), the same "only when a repair round
            # actually follows" discipline checkpoint_sha itself already
            # follows just above.
            repair_contract = build_repair_contract(iteration + 1, results, files, ws)
            manifest["attempts"][-1]["repairContract"] = repair_contract
            (session / f"repair-{iteration + 1:02d}.json").write_text(
                json.dumps({"repair": repair_contract}, indent=2), encoding="utf-8"
            )
            # Task 4.1: auto-create a repair task for this round, in the same
            # tasks.json the architect-plan-derived tasks live in -- only
            # when C3's task graph is active for this session (no plan, no
            # task graph, same zero-behavior-change-without-a-plan contract
            # every other C3 writer already follows). Its status flips via
            # the SAME evaluate_verification_tasks call that already runs
            # after every verify() this session -- no separate evaluator.
            if tasks is not None:
                repair_task = create_repair_task(_next_task_id(tasks), repair_contract)
                tasks.append(repair_task)
                save_tasks(session, tasks)
                emit_event(events_path, "task_created", sid,
                           taskId=repair_task["id"], kind=repair_task["kind"],
                           description=repair_task["description"][:200],
                           source=repair_task["source"], priority=repair_task["priority"])
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

        # Review round 7 (C1): the doc pass already ran above, inline in
        # the `if ok:` branch, on any path that reached a real VERIFIED-
        # or-blocked decision (doc_pass_done is True there). Every OTHER
        # exit path (verification never passed, INFRA_BLOCKED/TIMEOUT,
        # repair budget exhausted, SIGTERM/interrupt, or any exception
        # before that point) never got a chance to run it -- run it here,
        # exactly once, as the fallback. collapse()/changed_files() just
        # above are themselves idempotent no-ops when the `if ok:` branch
        # already ran them, so this is safe to always execute.
        if not doc_pass_done:
            run_doc_pass(ws, events_path, sid, manifest, tasks, session)

        # Review round 7 (C2): fingerprinted AFTER the doc pass (whichever
        # branch ran it) rather than before -- verify_doc_nodes/apply_doc_
        # impact/check_doc_drift only write docs/graph.json back when
        # something in it actually changed (see _write_doc_graph's no-op-
        # on-no-change guard), so a verified session that alters nothing
        # in the graph gets the SAME finalDiffHash on every run; one that
        # legitimately changes a node's status is fingerprinted with that
        # change already included, instead of going stale the instant the
        # doc pass writes back.
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
    # Task 2.2 (V7 §5.12): REPLAN_REQUIRED is no longer terminal-rejected --
    # see --architect-replan-selfcheck for the full re-planning-loop
    # coverage (version bump, budget sharing, invalid-replan fail-closed).
    assert classify_architect_review_decision("REPLAN_REQUIRED") == "replan"
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
    assert "taskList" not in request, "task_list omitted -> key absent, exact pre-Task-4.3 payload shape"

    # Task 4.3 (Architect task-list review): task_list, when given, rides
    # along as request["taskList"] -- the whole point being zero new model
    # calls (it's carried by the SAME review request, not a second one).
    tasks_for_review = [{"id": "t1", "kind": "implementation", "status": "pending", "dependsOn": []}]
    request_with_tasks = make_review_request(
        plan, ["a.ts"], {"a.ts": "modified"}, "diff", iteration=0, review_round=1,
        task_list=tasks_for_review,
    )
    assert request_with_tasks["taskList"] == tasks_for_review

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
    #     disagreement round (REVISE_IMPLEMENTATION OR, since Task 2.2,
    #     REPLAN_REQUIRED -- same shared counter, see --architect-replan-
    #     selfcheck) -- a plain APPROVED/APPROVED_WITH_CONDITIONS review,
    #     and a fail-open (no usable review output) round, must both be
    #     free. Otherwise repeated approvals across repair iterations
    #     pre-block later iterations (Important 1), and persistent
    #     review-machinery failure burns budget until fail-open degrades
    #     into fail-closed (Important 2). Structural proof via source
    #     ordering: the FIRST increment site (the one this proof checks)
    #     is only reachable after the review call AND after both the
    #     fail-open break and the approved/rejected break have already
    #     had their chance to fire -- i.e. only on the remaining cases,
    #     "revise"/"replan".
    #
    #     Fix round 2 (MED): exactly TWO increment sites are legitimate
    #     in the whole file -- (1) this pre-verify revise/replan loop,
    #     and (2) Task 2.3's post-verify consistency review (C2.3, a few
    #     hundred lines below) -- both now write through the identical
    #     literal expression (no more `architect_reviews` local alias at
    #     the second site) so this count actually proves what it claims;
    #     an aliased write would be invisible to a literal-string count.
    # ------------------------------------------------------------
    assert main_source.count('manifest["architectReviews"]["used"] += 1') == 2, (
        "budget must increment in exactly the two legitimate places: the "
        "pre-verify revise/replan loop and the post-verify consistency review"
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


def _architect_replan_selfcheck() -> None:
    """Task 2.2 (glimmer-v7, V7 §5.12): re-planning loop + plan versions.
    Covers decision routing (REPLAN_REQUIRED no longer terminal-rejected),
    the replan prompt builder, version-increment + plan-history
    persistence, run_architect_replan's invalid-plan fail-closed
    contract, and source-ordering proofs that replan shares the review
    loop's existing budget and that the architect_replan_started emit
    site actually lives inside that loop. No live model needed -- same
    fixture/monkeypatch style as --architect-review-selfcheck.
    Run with: python3 glimmer-v2.py --architect-replan-selfcheck
    """
    import inspect

    # ------------------------------------------------------------
    # 1. Decision routing: REPLAN_REQUIRED routes to a NEW "replan"
    #    outcome, not "rejected" -- it is no longer terminal.
    # ------------------------------------------------------------
    assert classify_architect_review_decision("REPLAN_REQUIRED") == "replan"
    assert classify_architect_review_decision("HUMAN_REVIEW_REQUIRED") == "rejected"
    assert classify_architect_review_decision("REVISE_IMPLEMENTATION") == "revise"

    # ------------------------------------------------------------
    # 2. make_architect_replan_prompt: reuses make_architect_prompt
    #    verbatim as a prefix, appends findings/requiredChanges as
    #    evidence of why v{from_version} failed; never raises on an
    #    empty/missing review.
    # ------------------------------------------------------------
    contract = {
        "objective": "restore a session after reload",
        "scope": {"package": "repository"},
        "mode": "implement",
        "constraints": {},
        "verification": [],
        "repairBudget": 0,
    }
    summary = "repo summary text"
    base_prompt = make_architect_prompt(contract, summary)

    review = {
        "decision": "REPLAN_REQUIRED",
        "findings": ["duplicate state introduced"],
        "requiredChanges": ["reuse existing store"],
    }
    replan_prompt = make_architect_replan_prompt(contract, summary, review, from_version=1)
    assert replan_prompt.startswith(base_prompt)
    assert "v1" in replan_prompt
    assert "duplicate state introduced" in replan_prompt
    assert "reuse existing store" in replan_prompt

    # Never raises / never empty on a missing or findings-less review.
    empty_prompt = make_architect_replan_prompt(contract, summary, {}, from_version=2)
    assert empty_prompt.startswith(base_prompt) and empty_prompt != base_prompt
    assert make_architect_replan_prompt(contract, summary, None, from_version=2) == empty_prompt

    # ------------------------------------------------------------
    # 3. record_architecture_plan_version: writes architecture-plan-vN.json
    #    (never overwritten by a later version -- real history) AND keeps
    #    architecture-plan.json pointed at the LATEST version (existing
    #    gateway-reader convention, unchanged file name/location).
    #    Appends exactly one manifest["architectPlans"] entry per call.
    # ------------------------------------------------------------
    with tempfile.TemporaryDirectory() as td:
        session_dir = Path(td)
        manifest = {}

        plan_v1 = {"objective": "x", "packages": [], "risk": "low", "version": 1}
        record_architecture_plan_version(session_dir, manifest, plan_v1)
        assert json.loads((session_dir / "architecture-plan-v1.json").read_text())["version"] == 1
        assert json.loads((session_dir / "architecture-plan.json").read_text())["version"] == 1
        assert manifest["architectPlans"] == [
            {"version": 1, "path": "architecture-plan-v1.json",
             "createdAt": manifest["architectPlans"][0]["createdAt"]}
        ]
        assert manifest["architectPlans"][0]["createdAt"]  # non-empty ISO timestamp

        plan_v2 = {"objective": "x", "packages": [], "risk": "low", "version": 2}
        record_architecture_plan_version(session_dir, manifest, plan_v2)
        assert json.loads((session_dir / "architecture-plan-v2.json").read_text())["version"] == 2
        # "latest" file now reflects v2 -- overwritten, not appended.
        assert json.loads((session_dir / "architecture-plan.json").read_text())["version"] == 2
        # v1's own versioned snapshot is untouched -- history, not overwritten.
        assert json.loads((session_dir / "architecture-plan-v1.json").read_text())["version"] == 1
        assert [e["version"] for e in manifest["architectPlans"]] == [1, 2]

    # ------------------------------------------------------------
    # 4. run_architect_replan: uniform-None-on-failure contract (same
    #    shape as run_architect_first/load_architecture_plan). Monkeypatch
    #    invoke_engineer (module-global swapped back in `finally`, same
    #    pattern as --repomap-cache-selfcheck's _build_repo_map_uncached
    #    swap) so no live model/subprocess is needed.
    # ------------------------------------------------------------
    real_invoke_engineer = globals()["invoke_engineer"]
    try:
        # 4a. Engineer subprocess "succeeds" but writes nothing usable
        #     (e.g. crashed mid-write, or never got session dir) ->
        #     load_architecture_plan degrades to None -> replan returns
        #     None. This IS the fail-closed contract: caller must never
        #     fall back to silently continuing on the rejected plan.
        #
        #     Fix round 1 (HIGH): PRE-SEED architecture-plan.json with the
        #     REJECTED v{from_version} plan first, exactly like the real
        #     session dir has it (record_architecture_plan_version already
        #     wrote it there as "latest" when v1 was created) -- without
        #     this seed, an empty temp dir would return None regardless of
        #     whether run_architect_replan unlinks it, giving this
        #     assertion no teeth. With the seed present, a dead subprocess
        #     that writes nothing must still yield None -- proving the
        #     unlink-before-invoke fix, not just an empty-dir coincidence.
        globals()["invoke_engineer"] = lambda *a, **k: 0
        with tempfile.TemporaryDirectory() as td:
            session_dir = Path(td)
            events_path = session_dir / "events.jsonl"
            (session_dir / "architecture-plan.json").write_text(
                json.dumps({
                    "objective": "restore a session after reload",
                    "packages": ["frontend"], "risk": "medium", "version": 1,
                }),
                encoding="utf-8",
            )
            result = run_architect_replan(
                Path("fake-engineer"), session_dir, contract, summary, session_dir,
                events_path, "sid-replan-fail", review, from_version=1, to_version=2,
            )
            assert result is None, (
                "a dead replan subprocess must never re-load and re-stamp "
                "the OLD (rejected) plan as the new version -- fail-closed, "
                "not fail-open"
            )
            assert not (session_dir / "architecture-plan.json").exists(), (
                "the stale v{from_version} file must be gone, not silently reused"
            )

        # 4a2. Fix round 2 (LOW): same dead-subprocess failure, but now
        #      the real session-dir shape -- record_architecture_plan_
        #      version's versioned snapshot (architecture-plan-v1.json)
        #      is ALSO on disk, not just the "latest" pointer. A failed
        #      replan must restore architecture-plan.json FROM that
        #      snapshot (observability for the now-terminal session dir)
        #      while still returning None (caller still fails closed --
        #      this restore is purely for whoever inspects the dir after).
        globals()["invoke_engineer"] = lambda *a, **k: 0
        with tempfile.TemporaryDirectory() as td:
            session_dir = Path(td)
            events_path = session_dir / "events.jsonl"
            v1_plan_text = json.dumps({
                "objective": "restore a session after reload",
                "packages": ["frontend"], "risk": "medium", "version": 1,
            })
            (session_dir / "architecture-plan.json").write_text(v1_plan_text, encoding="utf-8")
            (session_dir / "architecture-plan-v1.json").write_text(v1_plan_text, encoding="utf-8")
            result = run_architect_replan(
                Path("fake-engineer"), session_dir, contract, summary, session_dir,
                events_path, "sid-replan-fail-restore", review, from_version=1, to_version=2,
            )
            assert result is None, "a dead replan subprocess must still fail closed"
            assert (session_dir / "architecture-plan.json").exists(), (
                "architecture-plan.json must be restored from the v{from_version} "
                "snapshot after a failed replan, for observability"
            )
            assert json.loads((session_dir / "architecture-plan.json").read_text()) == json.loads(v1_plan_text)
            # The versioned snapshot itself is untouched (read from, not consumed).
            assert json.loads((session_dir / "architecture-plan-v1.json").read_text()) == json.loads(v1_plan_text)

        # 4b. Engineer subprocess writes a genuinely valid plan -> replan
        #     returns it, stamped with the NEW version (never the model's
        #     own claim, if any -- v2.py's stamp always wins).
        def _fake_invoke_writes_plan(engineer, ws, prompt, auto_approve, max_turns,
                                      log_path, events_path, sid, mode=None,
                                      plan_candidate_count=0, review_request=None):
            Path(ws).joinpath("architecture-plan.json").write_text(
                json.dumps({
                    "objective": "restore a session after reload",
                    "packages": ["frontend"],
                    "risk": "medium",
                    "version": 999,  # deliberately wrong -- must be overwritten
                }),
                encoding="utf-8",
            )
            return 0

        globals()["invoke_engineer"] = _fake_invoke_writes_plan
        with tempfile.TemporaryDirectory() as td:
            session_dir = Path(td)
            events_path = session_dir / "events.jsonl"
            new_plan = run_architect_replan(
                Path("fake-engineer"), session_dir, contract, summary, session_dir,
                events_path, "sid-replan-ok", review, from_version=1, to_version=2,
            )
            assert new_plan is not None
            assert new_plan["version"] == 2, "v2.py's stamp must win over any model-claimed version"
            assert new_plan["risk"] == "medium"
    finally:
        globals()["invoke_engineer"] = real_invoke_engineer

    # ------------------------------------------------------------
    # 5. Source-ordering proofs on main()'s review loop.
    # ------------------------------------------------------------
    main_source = inspect.getsource(main)

    # 5a. The architect_replan_started emit site must sit INSIDE the
    #     review loop (between its `while True:` opening and the
    #     post-loop gates assignment) -- not, say, buried unreachably
    #     inside run_architect_replan itself (a different function, so
    #     it would never appear in main_source at all if misplaced).
    loop_start_idx = main_source.index("while True:", main_source.index("review_round = 0"))
    # NOT the plan-creation-time `{"architectureApproved": None}` (an
    # earlier, unrelated occurrence of the same prefix) -- the specific
    # post-loop assignment that closes out the review sub-loop. Task 2.3
    # review round 1 changed this from a wholesale `manifest["gates"] = {...}`
    # to a merge-not-clobber assignment; anchor on the merge's own key
    # write instead of the old literal.
    gates_idx = main_source.index('gates["architectureApproved"] = architect_gates_value(architect_outcome)')
    replan_emit_idx = main_source.index('emit_event(events_path, "architect_replan_started"')
    assert loop_start_idx < replan_emit_idx < gates_idx, (
        "architect_replan_started must be emitted from inside the review loop"
    )

    # 5b. Replan is gated behind the SAME shared budget increment as
    #     revise -- no separate replan-only increment site. Fix round 2
    #     (MED): exactly TWO legitimate increment sites exist in the
    #     whole file (the pre-verify revise/replan loop this replan
    #     branch lives in, and Task 2.3's post-verify consistency
    #     review) -- `.index()` below finds the FIRST one (this loop's),
    #     which is what the replan branch must be reachable after.
    assert main_source.count('manifest["architectReviews"]["used"] += 1') == 2
    increment_idx = main_source.index('manifest["architectReviews"]["used"] += 1')
    replan_branch_idx = main_source.index('if decision_outcome == "replan":')
    assert increment_idx < replan_branch_idx, (
        "replan must be gated behind the SAME shared budget increment as revise, "
        "not a separate/unbudgeted path"
    )

    # 5c. Invalid-replan fail-closed: the "new_plan is None" branch sets
    #     architect_outcome = "rejected" (the EXISTING terminal path,
    #     never a new/silent-continue status), and that assignment is
    #     only reachable after the shared budget increment -- i.e. the
    #     budget is already spent by the time a replan can fail closed.
    fail_closed_idx = main_source.index("if new_plan is None:")
    rejected_after_replan_idx = main_source.index('architect_outcome = "rejected"', fail_closed_idx)
    assert increment_idx < fail_closed_idx < rejected_after_replan_idx, (
        "invalid-replan fail-closed must be reachable only after budget consumption"
    )

    # 5d. Fix round 1 (MED x2): after the plan swap, candidate_evidence,
    #     manifest["architectPlan"], and tasks must all be refreshed
    #     against the NEW plan -- not left stale from v{from_version}.
    #     Structural proof: all three refresh sites appear AFTER
    #     `architecture_plan = new_plan` (the swap itself).
    swap_idx = main_source.index("architecture_plan = new_plan")
    evidence_refresh_idx = main_source.index(
        "candidate_evidence = read_candidate_evidence(architecture_plan, ws, rank_by_path=rank_by_path)",
        swap_idx,
    )
    architect_plan_manifest_refresh_idx = main_source.index(
        'manifest["architectPlan"] = architect_plan_manifest_record(architecture_plan)', swap_idx
    )
    tasks_merge_idx = main_source.index(
        "tasks = merge_replanned_tasks(tasks, derive_tasks(architecture_plan))", swap_idx
    )
    assert swap_idx < evidence_refresh_idx, "candidate_evidence must be re-read against the NEW plan"
    assert swap_idx < architect_plan_manifest_refresh_idx, "architectPlan risk snapshot must reflect the NEW plan"
    assert swap_idx < tasks_merge_idx, "tasks must be re-derived from the NEW plan"

    # ------------------------------------------------------------
    # 6. merge_replanned_tasks: carries over status for an IDENTICAL
    #    (kind, description) pair; genuinely new tasks start pending;
    #    never raises on old_tasks=None/[] (first-ever plan).
    # ------------------------------------------------------------
    old_tasks = [
        {"id": "t1", "kind": "implementation", "description": "inspect hydration path", "status": "complete"},
        {"id": "t2", "kind": "implementation", "description": "add restoration hook", "status": "failed"},
        {"id": "t3", "kind": "verification", "description": "frontend_typecheck", "status": "complete"},
    ]
    new_tasks = [
        {"id": "t1", "kind": "implementation", "description": "inspect hydration path", "status": "pending"},
        {"id": "t2", "kind": "implementation", "description": "add a NEW retry layer", "status": "pending"},
        {"id": "t3", "kind": "verification", "description": "frontend_typecheck", "status": "pending"},
    ]
    merged = merge_replanned_tasks(old_tasks, new_tasks)
    assert merged[0]["status"] == "complete", "identical description -> status carried over"
    assert merged[1]["status"] == "pending", "genuinely new work -> starts pending, nothing to carry"
    assert merged[2]["status"] == "complete", "verification task carried over the same way"
    assert merge_replanned_tasks(None, new_tasks) == new_tasks, "no old tasks -> new_tasks returned as-is"
    assert merge_replanned_tasks([], new_tasks) == new_tasks

    # kind-scoped: an implementation and a verification task sharing the
    # exact same description text must NEVER cross-match.
    cross_kind_old = [{"id": "t1", "kind": "implementation", "description": "run lint", "status": "complete"}]
    cross_kind_new = [{"id": "t1", "kind": "verification", "description": "run lint", "status": "pending"}]
    assert merge_replanned_tasks(cross_kind_old, cross_kind_new)[0]["status"] == "pending", (
        "kind must be part of the match key -- an implementation task's status "
        "must never leak onto a same-worded verification task"
    )

    print("architect replan self-check: PASS")


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

    # ------------------------------------------------------------
    # 7. Task 4.1: full task model fields present on every derived task,
    #    and save_tasks now writes the versioned {schemaVersion, tasks}
    #    wrapper (readers -- control-center's readSessionTasks -- must
    #    tolerate BOTH this and a bare v1 array from an archived session;
    #    that tolerance is proven on the TypeScript side, not here).
    # ------------------------------------------------------------
    model_tasks = derive_tasks(plan)
    for t in model_tasks:
        for key in ("source", "priority", "evidenceIds", "affectedFiles",
                     "blockingReason", "createdAt", "updatedAt", "completion"):
            assert key in t, f"{key!r} missing from derived task {t['id']!r}"
        assert t["source"] == "architect_plan"
        # Fix round 1 (CRITICAL 1): implementation tasks start "required";
        # verification tasks start "recommended" and are only promoted to
        # "required" once real verify() evidence confirms a required-tier
        # match (see section 12 below) -- never assumed at derivation time.
        assert t["priority"] == ("required" if t["kind"] == "implementation" else "recommended")
        assert t["evidenceIds"] == [] and t["affectedFiles"] == []
        assert t["blockingReason"] is None
    impl_task, verify_task = model_tasks[0], model_tasks[2]
    assert impl_task["completion"] == {"type": "files_changed"}
    assert verify_task["completion"] == {"type": "check_passed", "check": None}

    with tempfile.TemporaryDirectory() as td:
        session_dir = Path(td)
        save_tasks(session_dir, model_tasks)
        on_disk = json.loads((session_dir / "tasks.json").read_text())
        assert on_disk["schemaVersion"] == 2
        assert on_disk["tasks"] == model_tasks

    # ------------------------------------------------------------
    # 8. Task 4.1: evaluators dispatch on completion.type, not a hardcoded
    #    kind check -- a task with no recognizable "kind" at all but the
    #    right completion contract must still transition (and one whose
    #    completion contract doesn't match must not).
    # ------------------------------------------------------------
    contractless = [
        {"id": "x1", "kind": "anything", "status": "pending",
         "completion": {"type": "files_changed"}},
        {"id": "x2", "kind": "anything", "status": "pending",
         "completion": {"type": "docs"}},
    ]
    evaluate_implementation_tasks(contractless, ["a.ts"], 0)
    assert contractless[0]["status"] == "complete", "dispatch is on completion.type, not kind"
    assert contractless[1]["status"] == "pending", "completion.type=='docs' must never auto-complete"

    # ------------------------------------------------------------
    # 9. Task 4.1: repair task lifecycle -- create_repair_task's shape,
    #    and evaluate_verification_tasks' EXACT (not fuzzy) match against
    #    its completion.check.
    # ------------------------------------------------------------
    rc = {"attempt": 1, "failedCheck": "npm run typecheck", "newFailures": [],
          "allowedFiles": ["src/a.ts", "src/b.ts"]}
    repair_task = create_repair_task(7, rc)
    assert repair_task["id"] == "t7"
    assert repair_task["kind"] == "repair" and repair_task["source"] == "repair"
    assert repair_task["priority"] == "required"
    assert repair_task["status"] == "in_progress"
    assert repair_task["affectedFiles"] == ["src/a.ts", "src/b.ts"]
    assert repair_task["blockingReason"] == "npm run typecheck"
    assert repair_task["createdBecause"] == "npm run typecheck"
    assert repair_task["completion"] == {"type": "check_passed", "check": "npm run typecheck"}

    repair_batch = [repair_task]
    # A result whose command merely OVERLAPS tokens with the failedCheck
    # string must NOT match -- only an exact command string does.
    evaluate_verification_tasks(repair_batch, [{"command": "npm run typecheck --watch", "status": "PASS"}])
    assert repair_batch[0]["status"] == "in_progress", "repair task match must be exact, not fuzzy"
    evaluate_verification_tasks(repair_batch, [{"command": "npm run typecheck", "status": "CODE_FAIL"}])
    assert repair_batch[0]["status"] == "failed"
    assert "npm run typecheck" in repair_batch[0]["blockingReason"]
    evaluate_verification_tasks(repair_batch, [{"command": "npm run typecheck", "status": "PASS"}])
    assert repair_batch[0]["status"] == "complete"
    assert repair_batch[0]["blockingReason"] is None

    # No failedCheck at all (degenerate repair_contract) -- never raises,
    # completion.check is None, description-only ("Repair failing check").
    degenerate = create_repair_task(1, {})
    assert degenerate["completion"] == {"type": "check_passed", "check": None}
    assert degenerate["description"] == "Repair failing check"

    # reset_verification_tasks_status now also resets a repair task (same
    # completion.type=="check_passed" contract as a plan-derived
    # verification task) -- not just kind=="verification".
    reset_verification_tasks_status(repair_batch)
    assert repair_batch[0]["status"] == "pending"

    # ------------------------------------------------------------
    # 10. Task 4.2: required_tasks_resolved matrix.
    # ------------------------------------------------------------
    assert required_tasks_resolved(None) is True, "no plan -> vacuously resolved"
    assert required_tasks_resolved([]) is True

    all_complete = [
        {"priority": "required", "status": "complete", "description": "a"},
        {"priority": "recommended", "status": "pending", "description": "b"},
    ]
    assert required_tasks_resolved(all_complete) is True, (
        "a pending RECOMMENDED task must never block -- only required tasks are checked"
    )

    still_pending = [{"priority": "required", "status": "pending", "description": "a"}]
    assert required_tasks_resolved(still_pending) is False

    still_in_progress = [{"priority": "required", "status": "in_progress", "description": "a"}]
    assert required_tasks_resolved(still_in_progress) is False

    genuinely_failed = [{"priority": "required", "status": "failed", "description": "run typecheck",
                          "blockingReason": "check failed: npm run typecheck"}]
    assert required_tasks_resolved(genuinely_failed) is False, (
        "a failed required task with no repair task to supersede it must block"
    )

    # Superseded case (fix round 1, IMPORTANT 2: EXACT evidence, not fuzzy
    # description matching): the original task's blockingReason names the
    # exact failing command, and a repair task whose completion.check is
    # that SAME exact command reached "complete" -- required_tasks_resolved
    # must trust that exact-matched evidence and treat the original as
    # resolved.
    superseded = [
        {"priority": "required", "status": "failed", "kind": "verification",
         "description": "Run the typecheck to confirm no type errors",
         "blockingReason": "check failed: npm run typecheck"},
        {"priority": "required", "status": "complete", "kind": "repair",
         "createdBecause": "npm run typecheck",
         "completion": {"type": "check_passed", "check": "npm run typecheck"}},
    ]
    assert required_tasks_resolved(superseded) is True

    # The repair task itself must actually be complete -- an in-progress
    # or failed repair task must never supersede anything.
    not_yet_superseded = [
        {"priority": "required", "status": "failed", "kind": "verification",
         "description": "Run the typecheck to confirm no type errors",
         "blockingReason": "check failed: npm run typecheck"},
        {"priority": "required", "status": "in_progress", "kind": "repair",
         "createdBecause": "npm run typecheck",
         "completion": {"type": "check_passed", "check": "npm run typecheck"}},
    ]
    assert required_tasks_resolved(not_yet_superseded) is False

    # A DIFFERENT command's repair task completing must NOT supersede --
    # exact match only, no partial/fuzzy credit.
    wrong_check_superseded = [
        {"priority": "required", "status": "failed", "kind": "verification",
         "description": "Run the typecheck to confirm no type errors",
         "blockingReason": "check failed: npm run typecheck"},
        {"priority": "required", "status": "complete", "kind": "repair",
         "createdBecause": "npm run lint",
         "completion": {"type": "check_passed", "check": "npm run lint"}},
    ]
    assert required_tasks_resolved(wrong_check_superseded) is False

    # ------------------------------------------------------------
    # 10b. Task 4.3: human skip/approve overrides (task-overrides.json,
    #      gateway-owned -- see load_task_overrides).
    # ------------------------------------------------------------
    still_pending_task = [{"id": "t1", "priority": "required", "status": "pending", "description": "a"}]
    assert required_tasks_resolved(still_pending_task) is False, "sanity: no override -> still blocks"
    assert required_tasks_resolved(still_pending_task, {"t1": {"action": "skip", "at": "x"}}) is True, (
        "a human skip override must resolve a required task the orchestrator never saw complete"
    )
    assert required_tasks_resolved(still_pending_task, {"t1": {"action": "approve", "at": "x"}}) is True, (
        "a human approve override must also resolve it -- chiefly for completion.type==manual tasks"
    )
    assert required_tasks_resolved(still_pending_task, {"t2": {"action": "skip", "at": "x"}}) is False, (
        "an override for a DIFFERENT task id must not resolve this one"
    )
    assert required_tasks_resolved(still_pending_task, {"t1": {"action": "bogus", "at": "x"}}) is False, (
        "an unrecognized override action must fail closed, not resolve the task"
    )
    assert required_tasks_resolved(still_pending_task, None) is False, "overrides=None must behave like {} (no override)"

    # load_task_overrides: uniform {} on every degraded case; real overrides
    # pass through on a genuinely valid file.
    with tempfile.TemporaryDirectory() as td:
        overrides_dir = Path(td)
        assert load_task_overrides(overrides_dir) == {}, "missing file -> {}"

        (overrides_dir / "task-overrides.json").write_text("not json{{{", encoding="utf-8")
        assert load_task_overrides(overrides_dir) == {}, "malformed JSON -> {}"

        (overrides_dir / "task-overrides.json").write_text(json.dumps(["not", "an", "object"]), encoding="utf-8")
        assert load_task_overrides(overrides_dir) == {}, "valid JSON but not an object -> {}"

        real_overrides = {"t1": {"action": "skip", "at": "2026-08-22T00:00:00Z"}}
        (overrides_dir / "task-overrides.json").write_text(json.dumps(real_overrides), encoding="utf-8")
        assert load_task_overrides(overrides_dir) == real_overrides

    # ------------------------------------------------------------
    # 10c. Review round 1 (Important 1 + 3): provenance (any_task_resolved_
    #      by_human_override / gates.tasksResolvedBy) and id-stability
    #      (kind+description must also match, not id alone -- ids get
    #      recycled across a replan).
    # ------------------------------------------------------------
    real_task = {"id": "t2", "priority": "required", "status": "pending",
                 "kind": "verification", "description": "Run the typecheck"}

    # A matching override (id + kind + description) resolves the task AND
    # is reported as human-resolved.
    matching_override = {"t2": {"action": "skip", "at": "x", "kind": "verification", "description": "Run the typecheck"}}
    assert required_tasks_resolved([real_task], matching_override) is True
    assert any_task_resolved_by_human_override([real_task], matching_override) is True
    assert _tasks_resolved_by_override([real_task], matching_override) == [("t2", "skip")]

    # A legacy override (no kind/description captured at all) is trusted by
    # id alone -- back-compat for a record written before this round.
    legacy_override = {"t2": {"action": "approve", "at": "x"}}
    assert required_tasks_resolved([real_task], legacy_override) is True
    assert any_task_resolved_by_human_override([real_task], legacy_override) is True

    # Replay: a replan renumbers the task list (merge_replanned_tasks can
    # do exactly this), so id "t2" now names a COMPLETELY different task --
    # the override recorded for the OLD t2 must NOT silently resolve it.
    new_t2_after_replan = {"id": "t2", "priority": "required", "status": "pending",
                            "kind": "implementation", "description": "Add telemetry for the new flow"}
    stale_override = {"t2": {"action": "skip", "at": "x", "kind": "verification", "description": "Run the typecheck"}}
    assert required_tasks_resolved([new_t2_after_replan], stale_override) is False, (
        "an override recorded for a DIFFERENT task that used to hold this id must not resolve the new one"
    )
    assert any_task_resolved_by_human_override([new_t2_after_replan], stale_override) is False
    assert _matching_task_override(new_t2_after_replan, stale_override) is None

    # A task with no priority=="required" entries at all reports no
    # override-resolution, even with overrides present (nothing to resolve).
    assert any_task_resolved_by_human_override(
        [{"id": "t1", "priority": "recommended", "status": "pending"}],
        {"t1": {"action": "skip", "at": "x"}},
    ) is False
    assert _tasks_resolved_by_override(None, {"t1": {"action": "skip", "at": "x"}}) == []

    # A task resolved on real evidence (complete), not an override, must
    # NOT be reported as human-resolved even when an (irrelevant, matching)
    # override also happens to exist for it.
    already_complete = {"id": "t3", "priority": "required", "status": "complete",
                         "kind": "implementation", "description": "x"}
    assert any_task_resolved_by_human_override(
        [already_complete], {"t3": {"action": "skip", "at": "x", "kind": "implementation", "description": "x"}},
    ) is False, "already resolved by real evidence -- override is irrelevant here, not the resolution source"

    # ------------------------------------------------------------
    # 11. Task 4.2: make_prompt's FOCUS block -- additive, byte-identical
    #     when tasks is None/absent; present (first pending required task,
    #     in list order) otherwise; absent again once nothing is pending.
    # ------------------------------------------------------------
    focus_contract = {
        "objective": "fix x", "scope": {"package": "repository"}, "mode": "implement",
        "constraints": {"minimalChange": True, "noCommit": True, "noPush": True,
                          "noDeploy": True, "noDependencyInstall": True},
    }
    base_prompt = make_prompt(focus_contract, "repo summary", 0)
    same_prompt = make_prompt(focus_contract, "repo summary", 0, tasks=None)
    assert base_prompt == same_prompt
    assert "FOCUS TASK" not in base_prompt

    focus_tasks = [
        {"id": "t1", "description": "add restoration hook", "kind": "implementation",
         "priority": "required", "status": "pending", "affectedFiles": ["a.ts"],
         "blockingReason": None},
        {"id": "t2", "description": "run typecheck", "kind": "verification",
         "priority": "required", "status": "pending", "affectedFiles": [],
         "blockingReason": None},
    ]
    with_focus = make_prompt(focus_contract, "repo summary", 0, tasks=focus_tasks)
    assert with_focus != base_prompt
    assert "FOCUS TASK" in with_focus
    assert '"id": "t1"' in with_focus and '"id": "t2"' not in with_focus, (
        "FOCUS must be the FIRST pending required task, not every pending task"
    )

    # Empty tasks list / no pending required task -- FOCUS omitted, same as absent.
    assert "FOCUS TASK" not in make_prompt(focus_contract, "repo summary", 0, tasks=[])
    no_pending = [dict(focus_tasks[0], status="complete"), dict(focus_tasks[1], status="complete")]
    assert "FOCUS TASK" not in make_prompt(focus_contract, "repo summary", 0, tasks=no_pending)

    # ------------------------------------------------------------
    # 12. Fix round 1 (CRITICAL 1): replay-style proof that the priority-
    #     inversion actually breaks the deadlock -- an honestly-unmatched
    #     plan-derived verification task must NEVER block
    #     required_tasks_resolved, but the SAME task, once real evidence
    #     matches it to a required-tier result, must actually count.
    # ------------------------------------------------------------
    replay_plan = {
        "implementationPlan": ["add the thing"],
        "verificationPlan": ["a check nothing ever runs"],
    }
    replay_tasks = derive_tasks(replay_plan)
    set_implementation_tasks_status(replay_tasks, "in_progress")
    evaluate_implementation_tasks(replay_tasks, ["a.ts"], 0)  # implementation: done
    evaluate_verification_tasks(replay_tasks, [{"command": "npm run something-else", "status": "PASS"}])
    verify_task = replay_tasks[1]
    assert verify_task["status"] == "pending" and verify_task["priority"] == "recommended", (
        "an honestly-unmatched verification task must stay recommended+pending, not required+pending"
    )
    assert required_tasks_resolved(replay_tasks) is True, (
        "CRITICAL fix: an unmatched prose verification task must NOT deadlock session completion"
    )

    # Now a real result actually matches it (required tier, by default) --
    # required_tasks_resolved must react to the NEWLY confirmed evidence.
    evaluate_verification_tasks(
        replay_tasks, [{"command": "npm run a-check-nothing-ever-runs", "status": "CODE_FAIL"}])
    assert verify_task["priority"] == "required" and verify_task["status"] == "failed"
    assert required_tasks_resolved(replay_tasks) is False, (
        "once matched to a required-tier result, a failing verification task must actually block"
    )
    evaluate_verification_tasks(
        replay_tasks, [{"command": "npm run a-check-nothing-ever-runs", "status": "PASS"}])
    assert verify_task["status"] == "complete"
    assert required_tasks_resolved(replay_tasks) is True

    # ------------------------------------------------------------
    # 13. Fix round 1 (IMPORTANT 2): _superseded_by_repair must use EXACT
    #     evidence, not fuzzy prose matching -- the reviewer's reproduced
    #     false-positive ("login modal" implementation task token-
    #     overlapping an unrelated "auth test" repair task's
    #     createdBecause) must NOT resolve.
    # ------------------------------------------------------------
    login_modal_failed = {
        "priority": "required", "status": "failed", "kind": "implementation",
        "description": "Fix the login modal auth test flow",
        "blockingReason": "engineer exited non-zero",
    }
    unrelated_repair = {
        "priority": "required", "status": "complete", "kind": "repair",
        "createdBecause": "npm run auth-test",
        "completion": {"type": "check_passed", "check": "npm run auth-test"},
    }
    false_positive_case = [login_modal_failed, unrelated_repair]
    assert _superseded_by_repair(login_modal_failed, false_positive_case) is False, (
        "an implementation task's plain-prose blockingReason must never be treated as a "
        "check command -- fuzzy token overlap with an unrelated repair task must not supersede it"
    )
    assert required_tasks_resolved(false_positive_case) is False, (
        "the false-positive case must NOT resolve -- login_modal_failed is still genuinely broken"
    )

    # The exact-match path DOES still work when the failed task really is
    # the same check_passed contract the repair task was created for.
    real_failure = {
        "priority": "required", "status": "failed", "kind": "verification",
        "blockingReason": "check failed: npm run auth-test",
        "completion": {"type": "check_passed", "check": "npm run auth-test"},
    }
    assert _superseded_by_repair(real_failure, [real_failure, unrelated_repair]) is True

    # ------------------------------------------------------------
    # 14. Fix round 1 (IMPORTANT 3): replan preserves dynamic (repair)
    #     tasks instead of silently dropping them, and never reuses an id.
    # ------------------------------------------------------------
    pre_replan = derive_tasks(plan)  # t1..t5 (2 implementation, 3 verification)
    pre_replan_repair = create_repair_task(_next_task_id(pre_replan), {"failedCheck": "npm run lint"})
    pre_replan.append(pre_replan_repair)
    assert pre_replan_repair["id"] == "t6"

    replanned = derive_tasks({
        "implementationPlan": ["inspect hydration path", "add restoration hook", "add a NEW retry layer"],
        "verificationPlan": ["frontend_typecheck", "lint", "nonexistent_check"],
    })  # now t1..t6 -- would collide with the repair task's OLD id "t6"
    merged = merge_replanned_tasks(pre_replan, replanned)
    repair_after_merge = [t for t in merged if t.get("kind") == "repair"]
    assert len(repair_after_merge) == 1, "replan must not drop the repair task"
    assert repair_after_merge[0]["createdBecause"] == "npm run lint"
    ids = [t["id"] for t in merged]
    assert len(ids) == len(set(ids)), f"merged task list has duplicate ids: {ids}"
    assert repair_after_merge[0]["id"] not in [t["id"] for t in replanned], (
        "the preserved repair task's id must not collide with any new plan-derived task's id"
    )

    # Carry-over now also carries priority/blockingReason/evidenceIds/
    # createdAt (fix round 1, MINOR 7), and bumps updatedAt.
    old_with_extras = [{
        "id": "t1", "kind": "implementation", "description": "inspect hydration path",
        "status": "failed", "priority": "required", "blockingReason": "engineer exited non-zero",
        "evidenceIds": ["ev-1"], "createdAt": "2020-01-01T00:00:00+00:00",
    }]
    new_from_replan = derive_tasks({"implementationPlan": ["inspect hydration path"]})
    merged_extras = merge_replanned_tasks(old_with_extras, new_from_replan)
    assert merged_extras[0]["status"] == "failed"
    assert merged_extras[0]["blockingReason"] == "engineer exited non-zero"
    assert merged_extras[0]["evidenceIds"] == ["ev-1"]
    assert merged_extras[0]["createdAt"] == "2020-01-01T00:00:00+00:00"
    assert merged_extras[0]["updatedAt"] != "2020-01-01T00:00:00+00:00", "updatedAt must be bumped on carry"

    # ------------------------------------------------------------
    # 15. Fix round 1 (IMPORTANT 4): during a repair round (repair_contract
    #     is not None), FOCUS must point at the NEWEST repair task, not
    #     the first pending required plan-derived task.
    # ------------------------------------------------------------
    repair_focus_tasks = derive_tasks({
        "implementationPlan": ["add the thing"],
        "verificationPlan": ["typecheck"],
    })
    repair_focus_tasks.append(
        create_repair_task(_next_task_id(repair_focus_tasks), {"failedCheck": "npm run typecheck"})
    )
    in_repair_prompt = make_prompt(
        focus_contract, "repo summary", 1, failure="boom", checkpoint_sha="deadbeef",
        repair_contract={"attempt": 1, "failedCheck": "npm run typecheck", "newFailures": [], "allowedFiles": []},
        tasks=repair_focus_tasks,
    )
    assert "FOCUS TASK" in in_repair_prompt
    assert '"kind": "repair"' in in_repair_prompt, "FOCUS during a repair round must be the repair task"
    assert '"kind": "implementation"' not in in_repair_prompt

    # Same tasks, but NOT a repair round (repair_contract=None) -- FOCUS
    # falls back to the ordinary first-pending-required rule.
    not_repair_prompt = make_prompt(focus_contract, "repo summary", 0, tasks=repair_focus_tasks)
    assert '"kind": "implementation"' in not_repair_prompt

    print("task graph (C3) self-check: PASS")


def _doc_graph_selfcheck() -> None:
    """Task 7.1/7.2 (V7 documentation intelligence): proves the doc-graph
    reader/verifier/impact/drift passes and the tri-state gate composition
    without a live session. Run with: python3 glimmer-v2.py --doc-graph-selfcheck
    """
    with tempfile.TemporaryDirectory() as td:
        ws = Path(td)

        # --- 1. load_doc_graph tolerance ---
        assert load_doc_graph(ws) is None, "absent graph must read as None"
        (ws / "docs").mkdir()
        (ws / "docs" / "graph.json").write_text("not json {{{")
        assert load_doc_graph(ws) is None, "malformed graph must read as None, not raise"
        (ws / "docs" / "graph.json").write_text(json.dumps({"edges": []}))
        assert load_doc_graph(ws) is None, "graph without nodes[] must read as None"
        (ws / "docs" / "graph.json").write_text(json.dumps({"nodes": []}))
        g = load_doc_graph(ws)
        assert g is not None and g["edges"] == [] and g["schemaVersion"] == 1, (
            "valid minimal graph must gain edges/schemaVersion defaults"
        )

        # --- 2. verify_doc_nodes status transitions (real git repo) ---
        run(["git", "init", "-q"], ws)
        (ws / "src").mkdir()
        (ws / "src" / "api.ts").write_text("export const x = 1;")
        (ws / "docs" / "api.md").write_text("Covers `src/api.ts`.")
        run(["git", "add", "-A"], ws)
        run(["git", "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "init"], ws)
        api_sha = _doc_git_sha(ws, "docs/api.md")
        assert api_sha, "committed file must have a git sha"

        graph = {
            "schemaVersion": 1,
            "nodes": [
                {"id": "doc-api", "type": "doc", "path": "docs/api.md",
                 "status": "UNVERIFIED",
                 "provenance": {"evidence": ["src/api.ts"], "sha": api_sha}},
                {"id": "doc-gone", "type": "doc", "path": "docs/nope.md",
                 "status": "UNVERIFIED", "provenance": {}},
                {"id": "doc-stale-ev", "type": "doc", "path": "docs/api.md",
                 "status": "UNVERIFIED",
                 "provenance": {"evidence": ["src/deleted.ts"], "sha": api_sha}},
                {"id": "doc-nosha", "type": "doc", "path": "docs/api.md",
                 "status": "UNVERIFIED", "provenance": {}},
                {"id": "svc-users", "type": "service", "path": "src/api.ts",
                 "status": "UNVERIFIED", "provenance": {"sha": _doc_git_sha(ws, "src/api.ts")}},
                {"id": "doc-frozen", "type": "doc", "path": "docs/nope.md",
                 "status": DOC_STATUS_DEPRECATED, "provenance": {}},
            ],
            "edges": [{"from": "doc-api", "to": "svc-users", "kind": "documents"}],
        }
        results = verify_doc_nodes(graph, ws)
        by_id = {r["nodeId"]: r["status"] for r in results}
        assert by_id["doc-api"] == DOC_STATUS_CURRENT, by_id
        assert by_id["doc-gone"] == DOC_STATUS_MISSING
        assert by_id["doc-stale-ev"] == DOC_STATUS_STALE
        assert by_id["doc-nosha"] == DOC_STATUS_UNVERIFIED
        assert "doc-frozen" not in by_id, "frozen DEPRECATED node must not be recomputed"
        # sha-mismatch -> STALE: rewrite + recommit the doc, keep the old sha on record.
        (ws / "docs" / "api.md").write_text("Covers `src/api.ts`. Updated.")
        run(["git", "add", "-A"], ws)
        run(["git", "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "edit"], ws)
        results2 = verify_doc_nodes(graph, ws)
        assert {r["nodeId"]: r["status"] for r in results2}["doc-api"] == DOC_STATUS_STALE, (
            "committed change since provenance.sha must flag STALE"
        )
        # Written back atomically: file on disk reflects the mutation, no tmp remains.
        on_disk = json.loads((ws / "docs" / "graph.json").read_text())
        assert {n["id"]: n["status"] for n in on_disk["nodes"]}["doc-gone"] == DOC_STATUS_MISSING
        assert not list((ws / "docs").glob("graph.json.tmp*")), "no tmp file may survive"

        # --- 3. map_changed_files_to_doc_nodes: prefix + category/edge ---
        impacted = map_changed_files_to_doc_nodes(graph, ["src/api.ts"])
        # src/api.ts prefix-touches svc-users AND category "api" -> type
        # "service" -> svc-users; the documents edge lifts it to doc-api.
        assert impacted == ["doc-api"], impacted
        assert map_changed_files_to_doc_nodes(graph, ["unrelated/z.txt"]) == []

        # --- 4. apply_doc_impact: stale-flag, same-diff doc exemption, frozen skip ---
        for n in graph["nodes"]:
            if n["id"] == "doc-api":
                n["status"] = DOC_STATUS_CURRENT
        flagged = apply_doc_impact(graph, ws, ["src/api.ts", "docs/api.md"], ["doc-api", "doc-frozen"])
        assert flagged == [], "doc edited in the same diff must stay CURRENT; frozen skipped"
        flagged2 = apply_doc_impact(graph, ws, ["src/api.ts"], ["doc-api"])
        assert [f["nodeId"] for f in flagged2] == ["doc-api"]
        assert {n["id"]: n["status"] for n in graph["nodes"]}["doc-api"] == DOC_STATUS_STALE

        # --- 5. check_doc_drift: backticked missing ref -> finding + STALE ---
        (ws / "docs" / "drifty.md").write_text("See `src/api.ts` and `src/removed.ts`.")
        graph["nodes"].append({"id": "doc-drifty", "type": "doc", "path": "docs/drifty.md",
                               "status": "UNVERIFIED", "provenance": {}})
        drifted = check_doc_drift(graph, ws)
        assert [d["nodeId"] for d in drifted] == ["doc-drifty"], drifted
        drifty = [n for n in graph["nodes"] if n["id"] == "doc-drifty"][0]
        assert drifty["provenance"]["driftFindings"] == ["src/removed.ts"]
        assert drifty["status"] == DOC_STATUS_STALE

        # --- 6. Gate tri-state composition: calls compute_doc_gate, the
        # SAME function main() calls via run_doc_pass (Review round 7,
        # Minor 1 -- this used to be a private re-implementation here
        # that could silently drift from what main() actually ran, which
        # is exactly how C1 went undetected). ---
        def _gate_graph(statuses):
            return {"nodes": [{"id": f"n{i}", "status": s} for i, s in enumerate(statuses)]}

        def _ids(n):
            return [f"n{i}" for i in range(n)]

        assert compute_doc_gate(_gate_graph([DOC_STATUS_CURRENT, DOC_STATUS_CURRENT]), _ids(2)) is True
        assert compute_doc_gate(_gate_graph([DOC_STATUS_CURRENT, DOC_STATUS_STALE]), _ids(2)) is False
        assert compute_doc_gate(_gate_graph([DOC_STATUS_UNVERIFIED]), _ids(1)) is False, (
            "unproven must never gate True"
        )
        assert compute_doc_gate(_gate_graph([DOC_STATUS_CURRENT]), []) is None, (
            "graph present, nothing impacted this diff -> not applicable"
        )
        # C3: no graph at all -- ALWAYS None, even when O2 phase 1's
        # one-way detector fired (that finding still drives its own
        # REQUIRED task via run_doc_pass -- it just never reaches this
        # gate for a repo with no graph to verify against). Getting this
        # wrong (a no-graph repo's False reaching gates_block_verified)
        # would permanently brick every non-graph repo the instant it
        # touched a routes/schema/api/config/auth-shaped file.
        assert compute_doc_gate(None, []) is None, "no graph -> never applicable, regardless of doc_impacts"

    print("doc-graph (Task 7.1/7.2) self-check: PASS")


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
            tasks.append(documentation_task(_next_task_id(tasks), doc_impacts))
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


def _gates_selfcheck() -> None:
    """Task 2.3 (glimmer-v7, V7 §5.10/§5.11): post-verification consistency
    check + the completed 5-key gates object. Covers
    check_post_verification_consistency's four required cases (clean,
    outside-files flagged, maxFiles exceeded, no plan -> no-op), the
    scope_guard_gate_value/combine_gate_values/gates_block_verified
    composition matrix (each False blocks VERIFIED, None does not), and a
    source-ordering proof that the consistency check runs strictly between
    the changed-files verify() call and the VERIFIED promotion. Run with:
    python3 glimmer-v2.py --gates-selfcheck
    """
    # ------------------------------------------------------------
    # 1. check_post_verification_consistency
    # ------------------------------------------------------------
    # No plan -> deterministic no-op, never an indeterminate result.
    assert check_post_verification_consistency(["a.ts"], None) == {
        "flagged": False, "outsideFiles": [], "reason": None,
    }
    assert check_post_verification_consistency([], {}) == {
        "flagged": False, "outsideFiles": [], "reason": None,
    }

    # Clean: every changed file is a candidate; normalization tolerates a
    # "./" prefix on either side.
    clean_plan = {"candidateFiles": [{"path": "./src/a.ts"}, {"path": "src/b.ts"}]}
    clean = check_post_verification_consistency(["src/a.ts", "src/b.ts"], clean_plan)
    assert clean == {"flagged": False, "outsideFiles": [], "reason": None}

    # Outside files: a changed file with no matching candidateFiles entry.
    outside_plan = {"candidateFiles": [{"path": "src/a.ts"}]}
    outside = check_post_verification_consistency(["src/a.ts", "src/unexpected.ts"], outside_plan)
    assert outside["flagged"] is True
    assert outside["outsideFiles"] == ["src/unexpected.ts"]
    assert "outside plan.candidateFiles" in outside["reason"]

    # maxFiles exceeded: every file IS a listed candidate, but the count
    # alone exceeds expectedScope.maxFiles -- outsideFiles stays empty,
    # flagged is still True, for a distinct reason.
    budget_plan = {
        "candidateFiles": [{"path": "a.ts"}, {"path": "b.ts"}, {"path": "c.ts"}],
        "expectedScope": {"maxFiles": 2},
    }
    over_budget = check_post_verification_consistency(["a.ts", "b.ts", "c.ts"], budget_plan)
    assert over_budget["flagged"] is True
    assert over_budget["outsideFiles"] == []
    assert "maxFiles=2" in over_budget["reason"]

    # Review round 1 (minor): empty/malformed candidateFiles (model
    # output, hostile input) never raises, and must NOT guarantee a flag
    # by itself -- an architect that named zero usable candidate files
    # has given us nothing to compare against, which is honestly "can't
    # tell", not "everything is outside scope". maxFiles stays a live,
    # independent signal regardless.
    malformed = check_post_verification_consistency(
        ["a.ts"], {"candidateFiles": "not-a-list", "expectedScope": "not-a-dict"}
    )
    assert malformed == {"flagged": False, "outsideFiles": [], "reason": None}
    no_usable_entries = check_post_verification_consistency(
        ["a.ts"], {"candidateFiles": [{"path": 123}, "not-a-dict", {"path": "  "}]}
    )
    assert no_usable_entries == {"flagged": False, "outsideFiles": [], "reason": None}

    # ...but maxFiles alone still flags even when candidateFiles is
    # entirely unusable -- the two checks are independent.
    malformed_over_budget = check_post_verification_consistency(
        ["a.ts", "b.ts", "c.ts"],
        {"candidateFiles": "not-a-list", "expectedScope": {"maxFiles": 1}},
    )
    assert malformed_over_budget["flagged"] is True
    assert malformed_over_budget["outsideFiles"] == []
    assert "maxFiles=1" in malformed_over_budget["reason"]

    # Path normalization (minor fix): leading/trailing slashes and
    # double slashes are tolerated, not just a bare "./" prefix.
    normalized_plan = {"candidateFiles": [{"path": "/src/a.ts/"}]}
    assert check_post_verification_consistency(["src//a.ts"], normalized_plan) == {
        "flagged": False, "outsideFiles": [], "reason": None,
    }

    # ------------------------------------------------------------
    # 2. scope_guard_gate_value
    # ------------------------------------------------------------
    assert scope_guard_gate_value(None) is None
    assert scope_guard_gate_value({"inScope": True, "expandedFiles": []}) is True
    assert scope_guard_gate_value({"inScope": False, "expandedFiles": ["x.ts"]}) is False
    assert scope_guard_gate_value({"inScope": False, "expandedFiles": [], "unbounded": True}) is None

    # ------------------------------------------------------------
    # 3. combine_gate_values -- False dominates, then None, else True.
    # ------------------------------------------------------------
    assert combine_gate_values(True, True) is True
    assert combine_gate_values(True, False) is False
    assert combine_gate_values(False, None) is False
    assert combine_gate_values(True, None) is None
    assert combine_gate_values(None, None) is None
    assert combine_gate_values() is True  # vacuous AND

    # ------------------------------------------------------------
    # 4. gates_block_verified: implementationComplete/verificationPassed
    #    must be exactly True; architectureApproved/scopeApproved/
    #    tasksResolved/documentationCurrent may be True OR None, only
    #    False blocks. documentationCurrent IS in the blocking set (Task
    #    7.1, reversing the Round-2 deferral) -- graph-based verification
    #    (verify_doc_nodes + map_changed_files_to_doc_nodes + apply_doc_
    #    impact/check_doc_drift, composed by run_doc_pass) can legitimately
    #    produce True, so False is a real block, not decorative. Review
    #    round 7 (C1): run_doc_pass now runs from main()'s `if ok:` branch
    #    -- BEFORE gates_block_verified is consulted below -- not from
    #    `finally` (see section 6's source-ordering proof).
    # ------------------------------------------------------------
    all_true = {
        "implementationComplete": True, "architectureApproved": True,
        "verificationPassed": True, "scopeApproved": True, "documentationCurrent": True,
        # Task 4.2: tasksResolved joins architectureApproved/scopeApproved's
        # True/False/None contract (see the shared loop just below).
        "tasksResolved": True,
    }
    assert gates_block_verified(all_true) is False, "V7 §5.11's own worked example must pass"

    # Absent optional gate keys (no plan, no doc impact, no task graph)
    # default to None via dict.get -- never-ran/not-applicable, must not
    # block.
    assert gates_block_verified({"implementationComplete": True, "verificationPassed": True}) is False

    for optional_key in ("architectureApproved", "scopeApproved", "tasksResolved",
                         "documentationCurrent"):
        blocked = dict(all_true, **{optional_key: False})
        assert gates_block_verified(blocked) is True, f"{optional_key}=False must block VERIFIED"
        nulled = dict(all_true, **{optional_key: None})
        assert gates_block_verified(nulled) is False, f"{optional_key}=None must NOT block VERIFIED"

    # Task 7.1 (reverses the Round-2 deferral): documentationCurrent is
    # now a real tri-state gate -- graph-based verification can produce
    # True, so False legitimately blocks (covered by the loop above);
    # True passes, and repos without a docs/graph.json stay None (never
    # block) -- see gates_block_verified's docstring.
    assert gates_block_verified(dict(all_true, documentationCurrent=True)) is False

    assert gates_block_verified(dict(all_true, implementationComplete=False)) is True
    assert gates_block_verified(dict(all_true, implementationComplete=None)) is True, (
        "implementationComplete has no honest null -- it is always computable once verify() ran"
    )
    assert gates_block_verified(dict(all_true, verificationPassed=False)) is True
    assert gates_block_verified(dict(all_true, verificationPassed=None)) is True

    # ------------------------------------------------------------
    # 4b. blocked_gate_names / describe_blocked_gates (review round 1,
    #     Important): honest, cause-naming detail per distinct cause.
    # ------------------------------------------------------------
    assert blocked_gate_names(all_true) == []
    assert blocked_gate_names(dict(all_true, implementationComplete=False)) == ["implementationComplete"]
    assert blocked_gate_names(dict(all_true, scopeApproved=False)) == ["scopeApproved"]
    assert blocked_gate_names(dict(all_true, architectureApproved=False, scopeApproved=False)) == [
        "architectureApproved", "scopeApproved",
    ]
    # Task 7.1: documentationCurrent=False is now a named blocked gate,
    # same contract as the other optional gates.
    assert blocked_gate_names(dict(all_true, documentationCurrent=False)) == ["documentationCurrent"]

    # Task 4.2: tasksResolved=False (some required task never resolved) is
    # named exactly like architectureApproved/scopeApproved, and combines
    # honestly with the other two when several block at once.
    assert blocked_gate_names(dict(all_true, tasksResolved=False)) == ["tasksResolved"]
    assert blocked_gate_names(dict(all_true, tasksResolved=None)) == [], (
        "no tasks.json (task graph never ran) must NOT block or appear as a named cause"
    )
    assert blocked_gate_names(
        dict(all_true, architectureApproved=False, scopeApproved=False, tasksResolved=False)
    ) == ["architectureApproved", "scopeApproved", "tasksResolved"]

    # Controller ruling: implementationComplete's detail must say exactly
    # this, never "architecture review rejected".
    impl_blocked = {"blockedGates": ["implementationComplete"], "attempts": [], "consistency": {}}
    assert describe_blocked_gates(impl_blocked) == "engineer exited non-zero after a passing diff"

    # scopeApproved blocked via a real scope-guard expansion (consistency
    # clean) -- names the actual expanded files, not "architecture review
    # rejected".
    scope_only = {
        "blockedGates": ["scopeApproved"],
        "attempts": [{"scopeGuard": {"expandedFiles": ["src/unexpected.ts"]}}],
        "consistency": {"outsideFiles": []},
    }
    scope_detail = describe_blocked_gates(scope_only)
    assert "scope guard expansion" in scope_detail and "src/unexpected.ts" in scope_detail
    assert "architecture review rejected" not in scope_detail

    # scopeApproved blocked via a real consistency-review rejection
    # (scope guard clean) -- names the actual outside files.
    consistency_only = {
        "blockedGates": ["scopeApproved"],
        "attempts": [{"scopeGuard": {"expandedFiles": []}}],
        "consistency": {"outsideFiles": ["src/extra.ts"]},
    }
    consistency_detail = describe_blocked_gates(consistency_only)
    assert "consistency review rejected" in consistency_detail and "src/extra.ts" in consistency_detail

    # Both causes at once -- both named, not collapsed into one.
    both = {
        "blockedGates": ["scopeApproved"],
        "attempts": [{"scopeGuard": {"expandedFiles": ["a.ts"]}}],
        "consistency": {"outsideFiles": ["b.ts"]},
    }
    both_detail = describe_blocked_gates(both)
    assert "a.ts" in both_detail and "b.ts" in both_detail

    # Never raises on a missing/malformed manifest.
    assert describe_blocked_gates({}) == "one or more V7 §5.11 gates blocked promotion to verified"

    # ------------------------------------------------------------
    # 5. Source-ordering proof: the consistency check must run strictly
    #    between the changed-files verify() call and the VERIFIED
    #    promotion, so a flagged/rejected diff can never slip past it.
    # ------------------------------------------------------------
    import inspect
    main_source = inspect.getsource(main)
    verify_call_idx = main_source.rindex(
        "ok, results = verify(ws, commands, args.timeout, session, iteration,"
    )
    consistency_call_idx = main_source.index("consistency = check_post_verification_consistency(files, architecture_plan)")
    gates_block_idx = main_source.index("if gates_block_verified(gates):")
    verified_label_idx = main_source.rindex('final_label = "VERIFIED"')
    assert verify_call_idx < consistency_call_idx, (
        "the consistency check must run AFTER verify() -- it inspects the FINAL changed-files set"
    )
    assert consistency_call_idx < gates_block_idx < verified_label_idx, (
        "gates_block_verified's decision must be made, and consulted, BEFORE the VERIFIED promotion"
    )

    # 5a. Review round 7 (C1): the doc pass (run_doc_pass, which sets
    #     gates["documentationCurrent"]) must run BEFORE gates_block_
    #     verified is consulted -- otherwise the gate is decorative. This
    #     is exactly the assertion the round-7 review found missing: C1
    #     shipped with the doc gate wired into gates_block_verified's
    #     blocking set, but computed only in `finally`, strictly AFTER
    #     the VERIFIED/blocked decision above had already been made.
    #     `.index` finds the FIRST occurrence -- the call inside the
    #     `if ok:` branch -- not the `finally` block's own fallback call.
    doc_pass_call_idx = main_source.index("run_doc_pass(ws, events_path, sid, manifest, tasks, session)")
    assert doc_pass_call_idx < gates_block_idx, (
        "run_doc_pass must execute before gates_block_verified is consulted, or "
        "documentationCurrent can never actually block a VERIFIED promotion"
    )

    # 5b. Review round 1 (minor): once flagged, consistency_gate's default
    #     must be None, never True -- a flagged diff with no plan/budget
    #     to review against must read as indeterminate, not clean. Proven
    #     structurally: the ONLY `consistency_gate = None` assignment that
    #     sits directly inside the `if consistency["flagged"]:` block
    #     (immediately after it, before any nested budget/plan check) is
    #     the real default -- there is no `consistency_gate = True`
    #     anywhere after that same `if` line.
    flagged_if_idx = main_source.index('if consistency["flagged"]:')
    default_none_idx = main_source.index("consistency_gate = None", flagged_if_idx)
    plan_check_idx = main_source.index("if (architecture_plan is not None and architect_reviews is not None", flagged_if_idx)
    assert flagged_if_idx < default_none_idx < plan_check_idx, (
        "consistency_gate must default to None immediately upon flagging, "
        "before checking whether a review can actually run"
    )
    assert "consistency_gate = True" not in main_source[flagged_if_idx:], (
        "once flagged, consistency_gate must never be reset to True except via an "
        "actual approved review decision"
    )

    # ------------------------------------------------------------
    # 6. Fix round 1 (MODERATE 5): the no-change-verified path (`if not
    #    files:` branch) must compute gates.tasksResolved (via
    #    required_tasks_resolved) and actually block promotion on it --
    #    "no bypass" -- while implementationComplete stays null/not-
    #    applicable there (a no-change session has nothing honest to claim
    #    True or False about it), not routed through gates_block_verified
    #    itself (whose documented invariant requires implementationComplete
    #    to always be a real True/False). Structural proof, since exercising
    #    this branch live needs a real session/subprocess.
    # ------------------------------------------------------------
    no_change_if_idx = main_source.index("if not files:")
    no_change_ok_idx = main_source.index("if ok:", no_change_if_idx)
    impl_null_idx = main_source.index('gates["implementationComplete"] = None', no_change_ok_idx)
    tasks_resolved_idx = main_source.index(
        'gates["tasksResolved"] = (', no_change_ok_idx,
    )
    tasks_resolved_check_idx = main_source.index('if gates["tasksResolved"] is False:', no_change_ok_idx)
    no_change_verified_label_idx = main_source.index('"no-change-verified"', tasks_resolved_check_idx)
    assert no_change_if_idx < no_change_ok_idx < impl_null_idx < tasks_resolved_idx < tasks_resolved_check_idx, (
        "the no-change path must compute implementationComplete=null and tasksResolved, "
        "in that order, before deciding whether tasksResolved blocks"
    )
    # Review round 1 (Minor 8a): the anchor above only pins the assignment's
    # `gates["tasksResolved"] = (` prefix (needed once the RHS became a
    # multi-line ternary) -- confirm the actual required_tasks_resolved(
    # call, not just that prefix, genuinely sits inside this same span, so
    # a future edit can't hollow out the assignment while leaving the
    # anchor text intact.
    assert "required_tasks_resolved(" in main_source[tasks_resolved_idx:tasks_resolved_check_idx], (
        "gates[\"tasksResolved\"] must actually be computed via required_tasks_resolved(...) in this span"
    )
    assert tasks_resolved_check_idx < no_change_verified_label_idx, (
        "the tasksResolved==False block must be checked BEFORE the no-change-verified success path -- no bypass"
    )
    # This path must NOT reuse gates_block_verified (which would wrongly
    # block on implementationComplete=null, a real property only THIS
    # path can have) -- confirm no such call exists between the two ok:
    # branches (this one and the real-diff VERIFIED one below it).
    real_diff_ok_idx = main_source.index("if ok:", no_change_verified_label_idx)
    assert "gates_block_verified(gates)" not in main_source[no_change_ok_idx:real_diff_ok_idx], (
        "the no-change path must check tasksResolved directly, not via gates_block_verified"
    )

    print("gates (Task 2.3, V7 §5.10/§5.11) self-check: PASS")


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

    # Fix round 3: visual_requirements threaded through expand_verify_entries
    # for an EXPLICIT "visual" --verify/contract.verification entry -- the
    # most deliberate opt-in path -- must reach the built command's --check
    # list exactly like the auto-added visual check already does.
    with tempfile.TemporaryDirectory() as td:
        session = Path(td)
        commands = expand_verify_entries(
            [["git", "diff", "--check"]], ["visual"], session, "http://x/route",
            visual_requirements=["primary action remains visible at laptop height"],
        )
        visual_cmd = commands[1]
        assert "primary action remains visible at laptop height" in visual_cmd
        for check in VISUAL_DEFAULT_CHECKS:
            assert check in visual_cmd, "requirements must ADD to the basics, not replace them"

        # No visual_requirements (default None) -> identical to the plain
        # "visual" expansion above, byte-for-byte.
        plain_commands = expand_verify_entries(
            [["git", "diff", "--check"]], ["visual"], session, "http://x/route",
        )
        assert plain_commands[1] == build_visual_verify_command(session, "http://x/route")

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

    # --- V7 §22.10: sanitize_visual_requirements -- tolerant absence,
    # cap count/length, drop non-string/blank entries. ---
    assert sanitize_visual_requirements(None) == []
    assert sanitize_visual_requirements({}) == []
    assert sanitize_visual_requirements({"visualRequirements": "not-a-list"}) == []
    assert sanitize_visual_requirements({"visualRequirements": [
        "reuse existing modal shell", 123, "", "   ", None,
    ]}) == ["reuse existing modal shell"]
    long_req = "x" * 500
    assert sanitize_visual_requirements({"visualRequirements": [long_req]}) == [
        long_req[:MAX_VISUAL_REQUIREMENT_CHARS]
    ]
    too_many_reqs = [f"req {i}" for i in range(30)]
    capped = sanitize_visual_requirements({"visualRequirements": too_many_reqs})
    assert capped == too_many_reqs[:MAX_VISUAL_REQUIREMENTS]

    # build_visual_verify_command: no visualRequirements -> byte-identical
    # to the pre-3.3 command (no --check at all, glimmer-visual.py's own
    # DEFAULT_CHECKS apply).
    with tempfile.TemporaryDirectory() as td:
        session = Path(td)
        plain_cmd = build_visual_verify_command(session, "http://x/route")
        assert "--check" not in plain_cmd

        # visualRequirements present -> the basics are sent explicitly
        # ALONGSIDE the extras (glimmer-visual.py's own --check would
        # otherwise silently replace its defaults).
        with_reqs = build_visual_verify_command(
            session, "http://x/route", visual_requirements=["primary action remains visible at laptop height"],
        )
        assert with_reqs.count("--check") == len(VISUAL_DEFAULT_CHECKS) + 1
        for check in VISUAL_DEFAULT_CHECKS:
            assert check in with_reqs
        assert "primary action remains visible at laptop height" in with_reqs

    # --- V7 §22.18: visual_requiredness rule table. ---
    frontend_contract = {"scope": {"package": "frontend"}}
    backend_contract = {"scope": {"package": "backend"}}
    plan_with_reqs = {"visualRequirements": ["reuse existing modal shell"]}

    # Absent URL -> "absent" no matter what, existing honest convention.
    assert visual_requiredness("standard", None, frontend_contract, ["a.tsx"], None) == "absent"
    assert visual_requiredness("full", None, frontend_contract, ["a.tsx"], plan_with_reqs) == "absent"

    # minimal level never auto-requires, even with a frontend match/plan.
    assert visual_requiredness("minimal", "http://x", frontend_contract, ["a.tsx"], plan_with_reqs) == "recommended"

    # standard+, no frontend match, no plan -> recommended (URL given, but
    # nothing marks this a UI-area session).
    assert visual_requiredness("standard", "http://x", backend_contract, ["a.py"], None) == "recommended"
    assert visual_requiredness("full", "http://x", backend_contract, ["a.py"], None) == "recommended"

    # standard+, frontend scope area match (no plan) -> required.
    assert visual_requiredness("standard", "http://x", frontend_contract, ["a.py"], None) == "required"

    # standard+, no area match but a .tsx changed file -> required (filetype match).
    assert visual_requiredness("standard", "http://x", backend_contract, ["src/App.tsx"], None) == "required"

    # standard+, no scope/filetype match but plan.visualRequirements present -> required.
    assert visual_requiredness("standard", "http://x", backend_contract, ["a.py"], plan_with_reqs) == "required"

    # Never raises on a malformed contract/files.
    assert visual_requiredness("standard", "http://x", "not-a-dict", None, None) == "recommended"

    # --- V7 §22.7: visual_state_count -- the value both visual_verification_
    # started/completed events carry as stateCount. ---
    with tempfile.TemporaryDirectory() as td:
        session = Path(td)
        assert visual_state_count(session) is None, "no manifest written yet -> None, not fabricated"

        vdir = session / "visual"
        vdir.mkdir(parents=True)
        (vdir / "visual-manifest.json").write_text(json.dumps({
            "route": "/x", "viewports": ["1440x900"], "states": ["initial"],
            "status": "pass", "captures": [], "findings": [],
        }), encoding="utf-8")
        assert visual_state_count(session) == 1

        (vdir / "visual-manifest.json").write_text(json.dumps({
            "route": "/x", "viewports": ["1440x900"],
            "states": ["initial", "dialog opened", "loading"],
            "status": "pass", "captures": [], "findings": [],
        }), encoding="utf-8")
        assert visual_state_count(session) == 3

        (vdir / "visual-manifest.json").write_text("not valid json", encoding="utf-8")
        assert visual_state_count(session) is None, "malformed manifest -> None, never raises"

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


def _repair_contract_selfcheck() -> None:
    """V7 §21. Run with: python3 glimmer-v2.py --repair-contract-selfcheck"""
    with tempfile.TemporaryDirectory() as td:
        ws = Path(td)

        # 1. Basic shape: failedCheck names the first failing result;
        #    newFailures is its capped newErrorSignatures; allowedFiles
        #    starts from the changed-files set.
        results = [
            {"command": "git diff --check", "ok": True, "status": "PASS"},
            {"command": "npm --prefix frontend run typecheck", "ok": False, "status": "CODE_FAIL",
             "newErrorSignatures": ["a.ts:<LOC> error TS2322: x"]},
        ]
        rc = build_repair_contract(1, results, ["frontend/a.ts"], ws)
        assert rc == {
            "attempt": 1,
            "failedCheck": "npm --prefix frontend run typecheck",
            "newFailures": ["a.ts:<LOC> error TS2322: x"],
            "allowedFiles": ["frontend/a.ts"],
        }

        # 2. newFailures capped at 50.
        many = [f"err {i}" for i in range(80)]
        rc2 = build_repair_contract(2, [{"command": "x", "ok": False, "newErrorSignatures": many}], [], ws)
        assert len(rc2["newFailures"]) == 50

        # 3. All-ok results never raises -- failedCheck/newFailures degrade
        #    to None/[] rather than crashing (shouldn't normally happen:
        #    build_repair_contract is only ever called after verify() ok=False).
        rc3 = build_repair_contract(1, [{"command": "x", "ok": True}], [], ws)
        assert rc3["failedCheck"] is None and rc3["newFailures"] == []

        # 4. allowedFiles test-file extraction: a failing TEST check names an
        #    existing test file in its own output -- extracted and appended.
        (ws / "src").mkdir()
        (ws / "src" / "Dialog.test.ts").write_text("x")
        test_results = [{
            "command": "npm run test", "ok": False, "status": "CODE_FAIL",
            "outputTail": "FAIL src/Dialog.test.ts\n  1 test failed",
        }]
        rc4 = build_repair_contract(1, test_results, ["src/Dialog.ts"], ws)
        assert rc4["allowedFiles"] == ["src/Dialog.ts", "src/Dialog.test.ts"]

        # 5. A path named in output that does NOT exist on disk is never
        #    added (existing-file check) -- conservative extraction.
        test_results_missing = [{
            "command": "npm run test", "ok": False, "status": "CODE_FAIL",
            "outputTail": "FAIL src/Missing.test.ts",
        }]
        rc5 = build_repair_contract(1, test_results_missing, ["src/Dialog.ts"], ws)
        assert rc5["allowedFiles"] == ["src/Dialog.ts"]

        # 6. A non-test check (e.g. typecheck) never triggers test-file
        #    extraction, even when its output happens to mention a
        #    *.test.ts path.
        (ws / "src" / "Other.test.ts").write_text("x")
        typecheck_mentioning_test = [{
            "command": "npm run typecheck", "ok": False, "status": "CODE_FAIL",
            "outputTail": "src/Other.test.ts:1:1 - error TS1234",
        }]
        rc6 = build_repair_contract(1, typecheck_mentioning_test, ["src/Dialog.ts"], ws)
        assert rc6["allowedFiles"] == ["src/Dialog.ts"]

        # 6b. Fix round 1 (MED): path-traversal containment — a failure
        #     output naming "../escape.test.ts" (which EXISTS one level
        #     above the workspace) must never land in allowedFiles.
        (ws.parent / "escape.test.ts").write_text("x")
        traversal_results = [{
            "command": "npm run test", "ok": False, "status": "CODE_FAIL",
            "outputTail": "FAIL ../escape.test.ts",
        }]
        rc6b = build_repair_contract(1, traversal_results, ["src/Dialog.ts"], ws)
        assert rc6b["allowedFiles"] == ["src/Dialog.ts"], rc6b["allowedFiles"]

        # 6c. C4 fix round 3: a failing visual check carries no
        #     newErrorSignatures (excluded from baseline compare) -- its
        #     visualBlockingFindings must populate newFailures instead of
        #     leaving the engineer a blind repair round.
        visual_results = [{
            "command": "glimmer-visual.py --check dialog", "ok": False, "status": "CODE_FAIL",
            "visualBlockingFindings": [
                {"severity": "critical", "category": "layout", "description": "dialog off-screen"},
                {"severity": "high", "category": "contrast", "description": "text unreadable"},
            ],
        }]
        rc6c = build_repair_contract(1, visual_results, [], ws)
        assert rc6c["newFailures"] == [
            "critical: layout — dialog off-screen",
            "high: contrast — text unreadable",
        ]

        # 6d. visualBlockingFindings capped at 50, same as newErrorSignatures.
        many_findings = [
            {"severity": "high", "category": "c", "description": str(i)} for i in range(80)
        ]
        rc6d = build_repair_contract(
            1, [{"command": "x", "ok": False, "visualBlockingFindings": many_findings}], [], ws
        )
        assert len(rc6d["newFailures"]) == 50

        # 7. compute_repair_writes_outside_allowed: advisory-only detection.
        contract = {"allowedFiles": ["src/Dialog.ts", "src/Dialog.test.ts"]}
        assert compute_repair_writes_outside_allowed(
            ["src/Dialog.ts", "src/Unexpected.ts"], contract
        ) == ["src/Unexpected.ts"]
        assert compute_repair_writes_outside_allowed(["src/Dialog.ts"], contract) == []
        assert compute_repair_writes_outside_allowed(["a.ts"], None) == []
        # An empty/falsy contract dict is treated the same as no contract
        # (nothing to compare against) -- never claims a file is "outside"
        # guidance that was never actually built.
        assert compute_repair_writes_outside_allowed(["a.ts"], {}) == []
        assert compute_repair_writes_outside_allowed(["a.ts"], {"allowedFiles": []}) == ["a.ts"]

    # 8. is_test_check_command heuristic.
    assert is_test_check_command("npm run test") is True
    assert is_test_check_command("npm --prefix frontend run vitest") is True
    assert is_test_check_command("npm run typecheck") is False
    assert is_test_check_command("") is False

    # 9. make_prompt renders the structured contract additively -- absent
    #    repair_contract, output is byte-identical to the pre-§21 prompt.
    contract_dict = {
        "objective": "fix x", "scope": {"package": "repository"}, "mode": "implement",
        "constraints": {"minimalChange": True, "noCommit": True, "noPush": True,
                          "noDeploy": True, "noDependencyInstall": True},
    }
    base = make_prompt(contract_dict, "repo summary", 1, failure="boom", checkpoint_sha="deadbeef")
    same = make_prompt(contract_dict, "repo summary", 1, failure="boom", checkpoint_sha="deadbeef",
                        repair_contract=None)
    assert base == same
    assert "STRUCTURED REPAIR CONTRACT" not in base
    with_rc = make_prompt(
        contract_dict, "repo summary", 1, failure="boom", checkpoint_sha="deadbeef",
        repair_contract={"attempt": 1, "failedCheck": "typecheck", "newFailures": [], "allowedFiles": ["a.ts"]},
    )
    assert with_rc != base
    assert "STRUCTURED REPAIR CONTRACT" in with_rc
    assert "GUIDANCE ONLY" in with_rc
    assert json.dumps(
        {"attempt": 1, "failedCheck": "typecheck", "newFailures": [], "allowedFiles": ["a.ts"]}, indent=2
    ) in with_rc

    print("repair contract (V7 §21) self-check: PASS")


def _verification_plan_selfcheck() -> None:
    """V7 §18. Run with: python3 glimmer-v2.py --verification-plan-selfcheck"""
    m = {"packages": [{"dir": ".", "path": "package.json",
                        "scripts": {"typecheck": "tsc", "lint": "eslint --fix",
                                    "test": "vitest run", "build": "vite build"}}]}
    files = ["a.ts"]
    fake_session = Path("/nonexistent-glimmer-selfcheck-session")

    def joined(plan_side):
        return [shlex.join(c) for c in plan_side]

    # minimal: required = git diff --check + typecheck only; recommended =
    # standard's one extra command (lint) minimal doesn't already require.
    p = verification_plan(m, files, "minimal", [], fake_session, None)
    assert joined(p["required"]) == ["git diff --check", "npm run typecheck"]
    assert joined(p["recommended"]) == ["npm run lint"]

    # standard: required adds lint; recommended is full's extra (test+build).
    p = verification_plan(m, files, "standard", [], fake_session, None)
    assert joined(p["required"]) == ["git diff --check", "npm run typecheck", "npm run lint"]
    assert joined(p["recommended"]) == ["npm run test", "npm run build"]

    # full: required has everything; nothing above it, so recommended is empty.
    p = verification_plan(m, files, "full", [], fake_session, None)
    assert joined(p["required"]) == [
        "git diff --check", "npm run typecheck", "npm run lint", "npm run test", "npm run build",
    ]
    assert p["recommended"] == []

    # Explicit --verify entries always land in required (the user asked for
    # them directly), regardless of level, and are never duplicated into
    # recommended.
    p = verification_plan(m, files, "minimal", ["./scripts/custom-check.sh"], fake_session, None)
    assert joined(p["required"]) == ["git diff --check", "npm run typecheck", "./scripts/custom-check.sh"]
    assert joined(p["recommended"]) == ["npm run lint"]

    # verify()'s tier threading + fail_fast: every result carries the tier
    # it was run under; fail_fast=True (the default, used for required)
    # stops at the first failure, fail_fast=False (recommended) runs every
    # command through to completion and the returned aggregate reflects
    # every result, not just the ones fail_fast would have reached.
    with tempfile.TemporaryDirectory() as td:
        ws = Path(td)
        run(["git", "init", "-q"], ws)
        run(["git", "-c", "user.name=x", "-c", "user.email=x@x", "commit", "--allow-empty", "-q", "-m", "init"], ws)
        baseline_sha = head(ws)
        session_dir = ws / "session"
        session_dir.mkdir()
        repo_map = {"packages": []}
        passing_cmd = [sys.executable, "-c", "pass"]
        # A genuinely missing binary classifies INFRA_BLOCKED (run()'s own
        # check=False path, see classify_raw_result) -- a real failure with
        # none of the baseline-worktree machinery a CODE_FAIL would trigger,
        # kept deliberately cheap for a self-check.
        missing_cmd = ["definitely-not-a-real-binary-glimmer-selfcheck"]

        ok, results = verify(ws, [passing_cmd], 30, session_dir, 0, repo_map, ws, baseline_sha, "none")
        assert ok is True and results[0]["tier"] == "required"

        ok, results = verify(ws, [passing_cmd], 30, session_dir, 0, repo_map, ws, baseline_sha, "none",
                              None, "sid", tier="recommended")
        assert ok is True and results[0]["tier"] == "recommended"

        ok, results = verify(ws, [missing_cmd, passing_cmd], 30, session_dir, 0, repo_map, ws, baseline_sha, "none")
        assert ok is False
        assert len(results) == 1  # fail_fast=True (default): stops after the first failure
        assert results[0]["tier"] == "required"

        ok, results = verify(ws, [missing_cmd, passing_cmd], 30, session_dir, 0, repo_map, ws, baseline_sha, "none",
                              None, "sid", tier="recommended", fail_fast=False)
        assert ok is False  # aggregate still reflects the failure
        assert len(results) == 2  # fail_fast=False: ran to completion despite the failure
        assert [r["tier"] for r in results] == ["recommended", "recommended"]

    # Recommended-never-gates, logic level: the promotion path's gating
    # functions never read recommendedResults, and the recommended verify()
    # call in main() only ever runs already inside an `if ok` guard --
    # required's own `ok` is what gates VERIFIED, never anything recommended
    # adds. Mirrors the existing "source-ordering proof" style
    # (--gates-selfcheck / --architect-review-selfcheck) rather than
    # spinning up a whole session run.
    import inspect
    assert "recommendedResults" not in inspect.getsource(gates_block_verified)
    assert "recommendedResults" not in inspect.getsource(blocked_gate_names)
    main_source = inspect.getsource(main)
    assert 'if ok and plan["recommended"]:' in main_source

    # --- V7 §22.18 (Task 3.3): visual requiredness composes with the
    # required[]/recommended[] split above. contract/plan default to None
    # (existing calls above never pass them) -- with visual_url also None
    # there, nothing changed; these new cases exercise contract/plan. A
    # real tempdir is needed here (unlike every call above): whenever
    # visual_url is actually set, build_visual_verify_command creates
    # session/"visual" for real -- fake_session is deliberately a
    # nonexistent path, fine for the visual_url=None calls above but not
    # once a visual command actually gets built.
    frontend_contract = {"scope": {"package": "frontend"}}
    backend_contract = {"scope": {"package": "backend"}}
    plan_with_reqs = {"visualRequirements": ["reuse existing modal shell"]}

    with tempfile.TemporaryDirectory() as td:
        real_session = Path(td)

        # No --visual-url at all -> unaffected, even at standard+ with a
        # frontend contract (the existing honest NOT_RUN convention).
        p = verification_plan(m, files, "standard", [], real_session, None, contract=frontend_contract)
        assert not any(is_visual_check_command(c) for c in p["required"] + p["recommended"])

        # --visual-url given, standard level, frontend-area contract ->
        # visual joins required[], appended after the language-level
        # checks already there (typecheck/lint), not replacing any of them.
        p = verification_plan(m, files, "standard", [], real_session, "http://x/route",
                               contract=frontend_contract)
        assert joined(p["required"])[:3] == ["git diff --check", "npm run typecheck", "npm run lint"]
        assert is_visual_check_command(p["required"][-1])
        assert not any(is_visual_check_command(c) for c in p["recommended"])

        # --visual-url given, standard level, NO frontend match, no plan ->
        # visual stays recommended, never required.
        p = verification_plan(m, files, "standard", [], real_session, "http://x/route",
                               contract=backend_contract)
        assert not any(is_visual_check_command(c) for c in p["required"])
        assert any(is_visual_check_command(c) for c in p["recommended"])

        # minimal level never auto-requires, even with a frontend contract
        # -- only ever recommended.
        p = verification_plan(m, files, "minimal", [], real_session, "http://x/route",
                               contract=frontend_contract)
        assert not any(is_visual_check_command(c) for c in p["required"])
        assert any(is_visual_check_command(c) for c in p["recommended"])

        # plan.visualRequirements alone (no frontend contract match) is
        # enough to promote to required[] at standard+, AND flows into the
        # built command as extra --check entries.
        p = verification_plan(m, files, "standard", [], real_session, "http://x/route",
                               contract=backend_contract, plan=plan_with_reqs)
        visual_cmd = next(c for c in p["required"] if is_visual_check_command(c))
        assert "reuse existing modal shell" in visual_cmd

        # Explicit "visual" in --verify already expands into required[] --
        # never auto-add a second visual command on top of it.
        p = verification_plan(m, files, "standard", ["visual"], real_session, "http://x/route",
                               contract=frontend_contract)
        assert sum(1 for c in p["required"] + p["recommended"] if is_visual_check_command(c)) == 1

    print("verification plan (V7 §18) self-check: PASS")


def _candidate_ranking_selfcheck() -> None:
    """Task 5.3 (V7 §27): weight-table cases (each signal in isolation,
    then combined), deterministic tie-break ordering, and the
    candidate_selected event emission site (_rerank_plan_candidates).
    Run with: python3 glimmer-v2.py --candidate-ranking-selfcheck
    """
    import tempfile as _tempfile

    # ------------------------------------------------------------
    # 1. Scope-path-match (0.4) and objective-keyword (0.2) in
    #    isolation -- no ws/repo_map, so package-match and recent-change
    #    contribute nothing.
    # ------------------------------------------------------------
    signals = {
        "scope": {"paths": ["frontend/dialog"]},
        "objective": "fix the dialog parser crash on empty input",
    }
    ranked = rank_candidates(
        ["frontend/dialog/DialogParser.ts", "frontend/dialog-old/Other.ts", "backend/unrelated.ts"],
        signals,
    )
    by_path = {r["path"]: r for r in ranked}
    assert by_path["frontend/dialog/DialogParser.ts"]["score"] == 0.6, (
        "scope-path-match (0.4) + keyword 'parser' (0.2) must both fire"
    )
    assert "scope-path-match" in by_path["frontend/dialog/DialogParser.ts"]["reasons"]
    assert any(r.startswith("keyword:") for r in by_path["frontend/dialog/DialogParser.ts"]["reasons"])
    # Sibling-path collision (frontend/dialog-old/...) must NOT count as a
    # scope match -- same boundary-safe rule compute_scope_guard uses.
    assert by_path["frontend/dialog-old/Other.ts"]["score"] == 0.0
    assert by_path["backend/unrelated.ts"]["score"] == 0.0

    # ------------------------------------------------------------
    # 2. Package-match (0.2) via a hand-built repo map -- no ws/objective.
    # ------------------------------------------------------------
    repo_map = {"packages": [
        {"dir": "frontend", "path": "frontend/package.json", "name": "@app/frontend"},
        {"dir": "backend", "path": "backend/package.json", "name": "@app/backend"},
    ]}
    ranked2 = rank_candidates(
        ["frontend/a.ts", "backend/b.ts"],
        {"scope": {"package": "@app/frontend"}, "repo_map": repo_map},
    )
    by_path2 = {r["path"]: r for r in ranked2}
    assert by_path2["frontend/a.ts"]["score"] == 0.2
    assert by_path2["frontend/a.ts"]["reasons"] == ["package-match:frontend"]
    assert by_path2["backend/b.ts"]["score"] == 0.0

    # Fix round 1 (LOW): a malformed repo_map missing "packages" entirely
    # must never KeyError -- rank_candidates guards with .get("packages", []).
    malformed_ranked = rank_candidates(["frontend/a.ts"], {"scope": {"package": "@app/frontend"}, "repo_map": {}})
    assert malformed_ranked[0]["score"] == 0.0

    # ------------------------------------------------------------
    # 3. Deterministic tie-break: equal (zero) scores sort by path asc,
    #    not input order.
    # ------------------------------------------------------------
    ranked3 = rank_candidates(["z.ts", "a.ts", "m.ts"], {})
    assert [r["path"] for r in ranked3] == ["a.ts", "m.ts", "z.ts"]
    assert all(r["score"] == 0.0 for r in ranked3)

    # Malformed/empty input never raises.
    assert rank_candidates([], {}) == []
    assert rank_candidates([123, None, "", "  ", "ok.ts"], {}) == [{"path": "ok.ts", "score": 0.0, "reasons": []}]

    # ------------------------------------------------------------
    # 4. Recent-change (0.2, decaying with age) in a real throwaway git
    #    repo -- an old.ts committed ~200 days ago must score lower than
    #    a fresh.ts committed just now, with everything else held equal.
    # ------------------------------------------------------------
    with _tempfile.TemporaryDirectory() as td:
        ws = Path(td)
        run(["git", "init", "-q"], ws)
        run(["git", "config", "user.email", "test@example.com"], ws)
        run(["git", "config", "user.name", "Test"], ws)

        old_date = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=200)).strftime("%Y-%m-%dT%H:%M:%S")
        (ws / "old.ts").write_text("old", encoding="utf-8")
        run(["git", "add", "old.ts"], ws)
        run(
            ["git", "commit", "-q", "-m", "old"], ws,
            env={"GIT_AUTHOR_DATE": old_date, "GIT_COMMITTER_DATE": old_date},
        )

        (ws / "fresh.ts").write_text("fresh", encoding="utf-8")
        run(["git", "add", "fresh.ts"], ws)
        run(["git", "commit", "-q", "-m", "fresh"], ws)

        ranked4 = rank_candidates(["old.ts", "fresh.ts"], {"ws": ws})
        by_path4 = {r["path"]: r for r in ranked4}
        assert by_path4["fresh.ts"]["score"] == 0.2, "committed seconds ago must get full recent-change credit"
        assert by_path4["old.ts"]["score"] == 0.0, "committed ~200 days ago must get zero recent-change credit"
        assert ranked4[0]["path"] == "fresh.ts", "higher score must sort first"

        # Cap: only the first 20 files (input order) get a git log call at
        # all -- the 21st+ file gets 0 credit for this signal regardless
        # of its real history.
        many = [f"f{i}.ts" for i in range(25)]
        ranked_many = rank_candidates(many + ["fresh.ts"], {"ws": ws})
        by_path_many = {r["path"]: r for r in ranked_many}
        assert by_path_many["fresh.ts"]["score"] == 0.0, (
            "fresh.ts placed at index 25 (past the 20-file cap) must get no recent-change credit"
        )

        # ------------------------------------------------------------
        # 5. _rerank_plan_candidates: in-place reorder + candidate_selected
        #    event emission (top CANDIDATE_SELECTED_TOP_N), never raises
        #    on a None plan.
        # ------------------------------------------------------------
        events_path = ws / "events.jsonl"
        events_path.write_text("")
        plan = {"candidateFiles": [
            {"path": "old.ts", "confidence": 0.9},
            {"path": "fresh.ts", "confidence": 0.1},
        ]}
        contract = {"scope": {}, "objective": "touch up fresh"}
        rank_by_path = _rerank_plan_candidates(plan, contract, None, ws, str(events_path), "sess-rank")

        assert [c["path"] for c in plan["candidateFiles"]] == ["fresh.ts", "old.ts"], (
            "candidateFiles must be reordered by rank score (fresh.ts scores higher), "
            "original per-entry fields (confidence) preserved"
        )
        assert plan["candidateFiles"][0]["confidence"] == 0.1, "reorder must not touch each entry's own fields"
        # Fix round 1 (LOW, single-pass ranking): the computed {path: score}
        # map is returned so the caller can thread it into
        # read_candidate_evidence instead of ranking a second time there.
        assert rank_by_path == {"fresh.ts": 0.4, "old.ts": 0.0}, (
            f"expected fresh.ts=0.4 (recency+keyword), old.ts=0.0, got {rank_by_path!r}"
        )

        events = [json.loads(line) for line in events_path.read_text().splitlines() if line.strip()]
        selected = [e for e in events if e["type"] == "candidate_selected"]
        assert len(selected) == 2, "one candidate_selected event per ranked candidate (both under CANDIDATE_SELECTED_TOP_N)"
        assert selected[0]["file"] == "fresh.ts" and isinstance(selected[0]["reasons"], list)

        # read_candidate_evidence honors the SAME pre-computed rank_by_path
        # -- no second rank_candidates call (and no second, possibly
        # different, 20-file git-log window) happens inside it.
        evidence = read_candidate_evidence(plan, ws, rank_by_path=rank_by_path)
        assert [e["path"] for e in evidence] == ["fresh.ts", "old.ts"], (
            "read_candidate_evidence must order by the threaded-through rank_by_path"
        )

        # Never raises on a plan with no usable candidateFiles -- returns None.
        assert _rerank_plan_candidates(None, contract, None, ws, str(events_path), "sess-rank") is None
        assert _rerank_plan_candidates({"candidateFiles": "not-a-list"}, contract, None, ws, str(events_path), "sess-rank") is None

    print("candidate ranking (V7 §27) self-check: PASS")


def _adr_selfcheck() -> None:
    """Task 7.3 (V7 "Architecture Decision Records" / "ADR consultation").
    Covers: frontmatter parsing (tolerant -- malformed/missing-id files
    skipped, never raise), load_adrs' absent-dir/cap behavior, exact-token
    area matching (no substring false-positive, mirroring select_skills),
    the ADR_PROMPT_MAX_MATCHED cap + id-ascending ordering, the prompt-
    section's shape/truncation/empty-when-nothing-matches, make_
    architect_prompt's byte-identical-with-no-ws contract, and make_
    review_request's additive matchedAdrIds field.
    Run with: python3 glimmer-v2.py --adr-selfcheck
    """
    with tempfile.TemporaryDirectory() as td:
        ws = Path(td)

        # ------------------------------------------------------------
        # 1. load_adrs: absent docs/decisions/ -> [], never an error.
        # ------------------------------------------------------------
        assert load_adrs(ws) == [], "no docs/decisions/ dir -> [] (not an error)"

        decisions = ws / "docs" / "decisions"
        decisions.mkdir(parents=True)

        # A well-formed ADR.
        (decisions / "ADR-0001.md").write_text(
            "---\n"
            "id: ADR-0001\n"
            "status: accepted\n"
            "areas: [auth, backend]\n"
            "title: Session ownership belongs to the backend\n"
            "---\n"
            "Context\nUsers need cross-device recovery.\n\n"
            "Decision\nBackend owns persistent session ownership.\n",
            encoding="utf-8",
        )
        # A second, non-matching ADR (different area).
        (decisions / "ADR-0002.md").write_text(
            "---\n"
            "id: ADR-0002\n"
            "status: accepted\n"
            "areas: [billing]\n"
            "title: Billing retries\n"
            "---\n"
            "Body text.\n",
            encoding="utf-8",
        )
        # Malformed: no frontmatter delimiters at all -- skipped, not raised.
        (decisions / "ADR-0003.md").write_text("just some prose, no frontmatter\n", encoding="utf-8")
        # Malformed: frontmatter present but no id -- skipped, not raised.
        (decisions / "ADR-0004.md").write_text(
            "---\nstatus: accepted\nareas: [auth]\ntitle: Missing id\n---\nBody.\n",
            encoding="utf-8",
        )
        # Not an ADR file at all (glob shouldn't pick it up).
        (decisions / "notes.md").write_text("---\nid: ADR-9999\n---\nignored\n", encoding="utf-8")

        adrs = load_adrs(ws)
        ids = sorted(a["id"] for a in adrs)
        assert ids == ["ADR-0001", "ADR-0002"], (
            f"malformed ADR-0003/0004 and non-matching-glob notes.md must be skipped, got {ids!r}"
        )
        by_id = {a["id"]: a for a in adrs}
        assert by_id["ADR-0001"]["areas"] == ["auth", "backend"]
        assert by_id["ADR-0001"]["status"] == "accepted"
        assert by_id["ADR-0001"]["title"] == "Session ownership belongs to the backend"
        assert "Backend owns persistent session ownership" in by_id["ADR-0001"]["body"]

        # ------------------------------------------------------------
        # 2. select_matching_adrs: EXACT-token match, not substring -- a
        #    contract scoped to "authorization" (contains "auth" as a
        #    substring but is a different whole token) must NOT match
        #    ADR-0001's "auth" area.
        # ------------------------------------------------------------
        contract_auth = {
            "objective": "fix the auth session bug",
            "scope": {"package": "backend"},
        }
        matched = select_matching_adrs(contract_auth, adrs)
        assert [a["id"] for a in matched] == ["ADR-0001"], matched

        contract_no_substring = {
            "objective": "improve authorization middleware",
            "scope": {"package": "frontend"},
        }
        # "authorization" tokenizes to one whole token "authorization",
        # which is NOT "auth" -- must not match via substring.
        assert select_matching_adrs(contract_no_substring, adrs) == [], (
            "exact-token match must not let 'authorization' match ADR area 'auth' as a substring"
        )

        # scope.package deliberately "frontend" here (not "backend") --
        # ADR-0001 also carries area "backend", so a "backend"-scoped
        # contract would legitimately match it too; this isolates the
        # objective-keyword ("billing") signal on its own.
        contract_billing = {"objective": "retry billing", "scope": {"package": "frontend"}}
        assert [a["id"] for a in select_matching_adrs(contract_billing, adrs)] == ["ADR-0002"]

        contract_none = {"objective": "unrelated task", "scope": {"package": "frontend"}}
        assert select_matching_adrs(contract_none, adrs) == []

        # ------------------------------------------------------------
        # 2b. Review round 7 (M4): superseded/proposed/rejected ADRs are
        #     never eligible, even when their areas would otherwise match
        #     -- only status=="accepted" is fed to the architect prompt.
        # ------------------------------------------------------------
        (decisions / "ADR-0010.md").write_text(
            "---\nid: ADR-0010\nstatus: superseded\nareas: [auth]\ntitle: Old auth decision\n---\nBody.\n",
            encoding="utf-8",
        )
        (decisions / "ADR-0011.md").write_text(
            "---\nid: ADR-0011\nstatus: proposed\nareas: [auth]\ntitle: New auth idea\n---\nBody.\n",
            encoding="utf-8",
        )
        (decisions / "ADR-0012.md").write_text(
            "---\nid: ADR-0012\nstatus: rejected\nareas: [auth]\ntitle: Rejected auth idea\n---\nBody.\n",
            encoding="utf-8",
        )
        adrs_with_inactive = load_adrs(ws)
        inactive_matched = select_matching_adrs(contract_auth, adrs_with_inactive)
        assert [a["id"] for a in inactive_matched] == ["ADR-0001"], (
            f"superseded/proposed/rejected ADRs must never match, got {inactive_matched}"
        )
        assert select_matching_adr_ids(contract_auth, ws) == ["ADR-0001"], (
            "select_matching_adr_ids must exclude non-accepted ADRs the same way"
        )

        # select_matching_adr_ids mirrors select_matching_adrs, just ids;
        # None/empty ws never raises.
        assert select_matching_adr_ids(contract_auth, ws) == ["ADR-0001"]
        assert select_matching_adr_ids(contract_auth, None) == []
        assert select_matching_adr_ids(contract_auth, "") == []

        # Cap: ADR_PROMPT_MAX_MATCHED matches, ordered by id ascending.
        for n in range(3, 3 + ADR_PROMPT_MAX_MATCHED + 2):
            (decisions / f"ADR-{n:04d}.md").write_text(
                f"---\nid: ADR-{n:04d}\nstatus: accepted\nareas: [auth]\ntitle: extra {n}\n---\nBody.\n",
                encoding="utf-8",
            )
        many_adrs = load_adrs(ws)
        many_matched = select_matching_adrs(contract_auth, many_adrs)
        assert len(many_matched) == ADR_PROMPT_MAX_MATCHED, (
            f"expected capped to {ADR_PROMPT_MAX_MATCHED}, got {len(many_matched)}"
        )
        assert [a["id"] for a in many_matched] == sorted(a["id"] for a in many_matched), (
            "matched ADRs must be ordered by id ascending"
        )

        # ------------------------------------------------------------
        # 3. build_adr_prompt_section: "" when ws is None or nothing
        #    matches; a real section (with truncation) when something does.
        # ------------------------------------------------------------
        assert build_adr_prompt_section(contract_auth, None) == ""
        assert build_adr_prompt_section(contract_none, ws) == ""

        section = build_adr_prompt_section(contract_auth, ws)
        assert "ARCHITECTURE DECISION RECORDS" in section
        assert "ADR-0001" in section
        assert "HUMAN-authored" in section

        long_body_adr = decisions / "ADR-0002.md"
        long_body_adr.write_text(
            "---\nid: ADR-0002\nstatus: accepted\nareas: [auth]\ntitle: Long\n---\n"
            + ("x" * (ADR_PROMPT_BODY_CHARS + 200)) + "\n",
            encoding="utf-8",
        )
        long_section = build_adr_prompt_section(contract_auth, ws)
        assert "[truncated]" in long_section, "a body over ADR_PROMPT_BODY_CHARS must be truncated"

        # ------------------------------------------------------------
        # 4. make_architect_prompt: ws=None (the default) reproduces the
        #    exact pre-Task-7.3 prompt; passing ws appends the ADR section
        #    only when something actually matches.
        # ------------------------------------------------------------
        contract_full = {
            "objective": "fix the auth session bug",
            "scope": {"package": "backend"},
            "mode": "implement",
            "constraints": {},
            "verification": [],
            "repairBudget": 0,
        }
        no_ws_prompt = make_architect_prompt(contract_full, "repo summary")
        assert no_ws_prompt == make_architect_prompt(contract_full, "repo summary", ws=None), (
            "ws defaulting to None must be identical to omitting it"
        )
        assert "ARCHITECTURE DECISION RECORDS" not in no_ws_prompt

        with_ws_prompt = make_architect_prompt(contract_full, "repo summary", ws)
        assert with_ws_prompt.startswith(no_ws_prompt), (
            "the ADR section must be a pure suffix -- the base prompt text must not change"
        )
        assert "ARCHITECTURE DECISION RECORDS" in with_ws_prompt

        empty_ws = Path(td) / "no-adrs-here"
        empty_ws.mkdir()
        assert make_architect_prompt(contract_full, "repo summary", empty_ws) == no_ws_prompt, (
            "a workspace with no docs/decisions/ must reproduce the exact no-ws prompt"
        )

    # ------------------------------------------------------------
    # 5. make_review_request: matchedAdrIds is additive -- absent when
    #    falsy/None (exact pre-Task-7.3 shape), present when given.
    # ------------------------------------------------------------
    plan = {"objective": "x", "packages": [], "risk": "low"}
    base_request = make_review_request(plan, ["a.ts"], {"a.ts": "modified"}, "diff", 0, 1)
    assert "matchedAdrIds" not in base_request

    request_with_ids = make_review_request(
        plan, ["a.ts"], {"a.ts": "modified"}, "diff", 0, 1, matched_adr_ids=["ADR-0001"],
    )
    assert request_with_ids["matchedAdrIds"] == ["ADR-0001"]

    request_with_empty = make_review_request(
        plan, ["a.ts"], {"a.ts": "modified"}, "diff", 0, 1, matched_adr_ids=[],
    )
    assert "matchedAdrIds" not in request_with_empty, "an empty match list must not add a noise key"

    print("ADR store + consultation (V7 §7.3) self-check: PASS")


def _docs_bootstrap_selfcheck() -> None:
    """Task 7.4 (V7 "Bootstrapping an existing repository"): the
    --docs-bootstrap skeleton builder. Covers build_docs_bootstrap_graph's
    type-mapping (package->service, config/workflow->config) against a
    fake repo map, every node's honest GENERATED/unknown/no-sha shape, and
    _docs_bootstrap's real-filesystem behavior: writes graph.json +
    docs/decisions/ + docs/README.md on a clean workspace, and REFUSES
    (never overwrites) when graph.json already exists.
    Run with: python3 glimmer-v2.py --docs-bootstrap-selfcheck
    """
    # ------------------------------------------------------------
    # 1. build_docs_bootstrap_graph: pure, from a fake repo map.
    # ------------------------------------------------------------
    fake_repo_map = {
        "packages": [
            {"path": "package.json", "dir": ".", "name": "root-pkg"},
            {"path": "frontend/package.json", "dir": "frontend", "name": "@app/frontend"},
        ],
        "configs": ["tsconfig.json", "frontend/tsconfig.json"],
        "workflows": [".github/workflows/ci.yml"],
    }
    graph = build_docs_bootstrap_graph(fake_repo_map)
    assert graph["schemaVersion"] == 1
    assert graph["edges"] == [], "Phase 3 (bootstrap) must never invent edges"

    by_id = {n["id"]: n for n in graph["nodes"]}
    assert by_id["service:root"]["type"] == "service"
    assert by_id["service:root"]["path"] == "."
    assert by_id["service:root"]["title"] == "root-pkg"
    assert by_id["service:frontend"]["type"] == "service"
    assert by_id["service:frontend"]["path"] == "frontend"
    assert by_id["config:tsconfig.json"]["type"] == "config"
    assert by_id["config:frontend/tsconfig.json"]["type"] == "config"
    assert by_id["config:.github/workflows/ci.yml"]["type"] == "config", (
        "workflow has no dedicated node type -- must fall back to config"
    )

    for node in graph["nodes"]:
        assert node["status"] == DOC_STATUS_GENERATED
        assert node["confidence"] == "unknown"
        assert node["provenance"] == {"evidence": [], "sha": None}

    # verify_doc_nodes must leave every bootstrapped node untouched --
    # GENERATED is a frozen status (Task 7.1's _DOC_STATUS_FROZEN), the
    # exact mechanism that makes bootstrap output honest ("unverified
    # until a human curates it") without any new status-machine code.
    assert DOC_STATUS_GENERATED in _DOC_STATUS_FROZEN

    # Duplicate dir across packages/configs must not double-add a node.
    dup_map = {"packages": [{"path": "a/package.json", "dir": "a", "name": "a"}],
               "configs": [], "workflows": []}
    dup_graph = build_docs_bootstrap_graph(dup_map)
    assert len(dup_graph["nodes"]) == 1

    # ------------------------------------------------------------
    # 2. _docs_bootstrap: real filesystem behavior.
    # ------------------------------------------------------------
    with tempfile.TemporaryDirectory() as td:
        ws = Path(td)
        (ws / "package.json").write_text(json.dumps({"name": "demo"}), encoding="utf-8")
        # build_repo_map (reused, unmodified, by _docs_bootstrap) shells
        # out to git -- a real (if empty) repo is needed for this fixture.
        subprocess.run(["git", "init", "-q"], cwd=ws, check=True)
        subprocess.run(["git", "config", "user.email", "test@test"], cwd=ws, check=True)
        subprocess.run(["git", "config", "user.name", "test"], cwd=ws, check=True)
        subprocess.run(["git", "add", "-A"], cwd=ws, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=ws, check=True)

        rc = _docs_bootstrap(str(ws))
        assert rc == 0, "bootstrap on a clean workspace must succeed"

        graph_path = ws / DOC_GRAPH_RELATIVE_PATH
        assert graph_path.is_file()
        written = json.loads(graph_path.read_text(encoding="utf-8"))
        assert any(n["id"] == "service:root" for n in written["nodes"])

        assert (ws / ADR_DECISIONS_RELATIVE_DIR).is_dir()
        assert (ws / DOCS_README_RELATIVE_PATH).is_file()
        assert "GENERATED" in (ws / DOCS_README_RELATIVE_PATH).read_text(encoding="utf-8")

        # NEVER overwrites an existing graph -- fails loud (non-zero rc),
        # and the on-disk file must be byte-identical to what a human (or
        # a prior bootstrap) already wrote there.
        graph_path.write_text('{"nodes": [], "edges": [], "curated": true}', encoding="utf-8")
        before = graph_path.read_text(encoding="utf-8")
        rc2 = _docs_bootstrap(str(ws))
        assert rc2 != 0, "bootstrap must refuse to overwrite an existing graph.json"
        assert graph_path.read_text(encoding="utf-8") == before, (
            "an existing graph.json must be left byte-for-byte untouched on refusal"
        )

        # A nonexistent workspace must also fail loud, not crash.
        assert _docs_bootstrap(str(ws / "does-not-exist")) != 0

    print("docs bootstrap (V7 §7.4) self-check: PASS")


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
    if sys.argv[1:] == ["--architect-replan-selfcheck"]:
        _architect_replan_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--tasks-selfcheck"]:
        _tasks_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--visual-selfcheck"]:
        _visual_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--doc-graph-selfcheck"]:
        _doc_graph_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--doc-impact-selfcheck"]:
        _doc_impact_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--gates-selfcheck"]:
        _gates_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--skills-selfcheck"]:
        _skills_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--repair-contract-selfcheck"]:
        _repair_contract_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--verification-plan-selfcheck"]:
        _verification_plan_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--candidate-ranking-selfcheck"]:
        _candidate_ranking_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--adr-selfcheck"]:
        _adr_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:] == ["--docs-bootstrap-selfcheck"]:
        _docs_bootstrap_selfcheck()
        raise SystemExit(0)
    if sys.argv[1:2] == ["--docs-bootstrap"]:
        # Task 7.4: a standalone CLI mode, not a task run -- takes a bare
        # workspace path instead of the usual `task ... --workspace ...`
        # shape, so it's dispatched here (same special-case-before-
        # argparse pattern as every --*-selfcheck above) rather than
        # forced through main()'s required-positional-task argparse.
        if len(sys.argv) != 3:
            print("Usage: glimmer-v2.py --docs-bootstrap <workspace>", file=sys.stderr)
            raise SystemExit(2)
        raise SystemExit(_docs_bootstrap(sys.argv[2]))
    signal.signal(signal.SIGTERM, _sigterm_handler)
    try:
        raise SystemExit(main())
    except (KeyboardInterrupt, V2Interrupted):
        print("\nStopped. Cleanup attempted.", file=sys.stderr)
        raise SystemExit(130)
    except V2Error as exc:
        print(f"\nGLIMMER V2.1 ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
