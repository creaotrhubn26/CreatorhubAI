#!/usr/bin/env python3

import argparse
import functools
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib import request, error

from glimmer_events import emit as emit_event

GLIMMER_EVENTS_PATH = os.environ.get("GLIMMER_EVENTS_PATH")
GLIMMER_SESSION_ID = os.environ.get("GLIMMER_SESSION_ID")
# C1 handoff enforcement (Fix 2): set by glimmer-v2.py (same spawn-env code
# path as the two vars above) to the count of architect-plan candidateFiles
# it successfully pre-read and embedded in this run's prompt — only when
# that count is > 0. See _plan_aware_discovery_budget below.
GLIMMER_PLAN_CANDIDATES = os.environ.get("GLIMMER_PLAN_CANDIDATES")

# Task 2.4 (V7 §5.5 second half): the normalized ArchitecturePlan dict
# loaded once at run_engineer startup (None when no plan exists), read by
# execute_tool's consult_architect interception. Module-level (same
# pattern as GLIMMER_PLAN_CANDIDATES above) so execute_tool -- called with
# its existing, unchanged signature from ~8 call sites -- doesn't need a
# new parameter threaded through every one of them just for this one tool.
_loaded_architecture_plan = None

# Review round 1 (MED): whether run_engineer was actually invoked with
# --architect-consult-enabled. execute_tool must gate on this too (not
# just on a plan existing) -- offering the tool at all is conditioned on
# BOTH per _augment_tools_with_consult_architect, and a model can still
# emit a tool_call naming an unoffered tool (same "structurally
# incapable, not merely un-offered" reasoning as the architect-mode
# WRITE_TOOLS guard above). Set once at run_engineer startup, alongside
# _loaded_architecture_plan.
_architect_consult_enabled = False


def _emit(event_type: str, **fields) -> None:
    # No-op when the events file isn't configured (e.g. direct standalone
    # invocation per new-glimmer-task.sh) so this never gates normal operation.
    if not GLIMMER_EVENTS_PATH or not GLIMMER_SESSION_ID:
        return
    emit_event(GLIMMER_EVENTS_PATH, event_type, GLIMMER_SESSION_ID, **fields)


# R3/I1 (glimmer-v7): engineer_phase is a local, engineer-loop-scoped concept
# (see the R3 comment near its first assignment below) and its raw values
# (discovering / narrowed_to_read_edit / narrowed_to_edit_only / writing) are
# NOT members of @glimmer/shared's GlimmerSessionStatus union. Emitting them
# verbatim as agent_state_changed.state would render as unrecognized strings
# on the dashboard, and worse, any name that happened to collide with a real
# union member (e.g. "verified") would be misread as an authoritative session
# status. Map each local phase to the closest real GlimmerSessionStatus member
# before emitting, so observability into the loop's internal phase never
# masquerades as (or collides with) a real session-level status.
ENGINEER_PHASE_TO_SESSION_STATUS = {
    "discovering": "discovery",
    "narrowed_to_read_edit": "candidate_selection",
    "narrowed_to_edit_only": "candidate_selection",
    "writing": "implementing",
}


def _emit_engineer_phase(phase: str) -> None:
    _emit(
        "agent_state_changed",
        state=ENGINEER_PHASE_TO_SESSION_STATUS[phase],
    )


# C1 fix round 1 (Important finding): a lifecycle marker for run_architect,
# distinguishing its activity from the main engineer run's in the same
# events.jsonl stream. Deliberately reuses the real "agent_state_changed"
# EVENT_TYPES member (this project never emits an event type outside
# @glimmer/shared's 12-variant EVENT_TYPES set) rather than the pattern
# just above (mapping to the closest real GlimmerSessionStatus member):
# unlike engineer_phase's sub-states, which occur INSIDE a normal
# in-progress session and could plausibly be confused with one of the 14
# real statuses if left unmapped, architect mode is a distinct pre-session
# step that doesn't correspond to any of them — there is no "closest real
# member" to map to, so a distinct, unambiguous marker is used instead. No
# matching "end" marker is emitted: the next real agent_state_changed
# event (the main run's own state transitions, or v2.py's own
# "initialized") already marks the boundary, so a downstream consumer can
# segment "everything between this event and the next agent_state_changed
# event is architect activity" without a second marker.
def _emit_architect_started() -> None:
    _emit(
        "agent_state_changed",
        state="architect_planning",
    )


# C2 (glimmer-v7): distinct lifecycle marker for the pre-verification
# architect REVIEW step (V7 SS5.9), as opposed to the pre-iteration-0
# PLANNING step marked by _emit_architect_started above. Same real
# "agent_state_changed" EVENT_TYPES member (no new event types, per
# project rule) with its own distinct state value so review activity is
# segmentable from planning activity in events.jsonl.
def _emit_architect_review_started() -> None:
    _emit(
        "agent_state_changed",
        state="architect_review",
    )


API_BASE = os.environ.get(
    "GLIMMER_URL",
    "http://127.0.0.1:8080",
)

API_KEY_FILE = (
    Path.home()
    / "AI/muse-glimmer/config/api-key.txt"
)

MAX_TOOL_RESULT = 28000
MAX_EVIDENCE_RESULT = 7000
MAX_EVIDENCE_TOTAL = 50000

# Matches Task 3's existing tool_completed.resultSummary cap (1800, inline
# below at its own reviewed call site — left untouched). tool_started.args
# and tool_blocked.command carry unbounded model-controlled strings with no
# cap at all; reuse the same limit for consistency across event fields.
MAX_EVENT_FIELD = 1800

# Task 5.1 (V7 §7 "Context budget"): char-based tier budget for the
# engineer's live conversation. Picked from the same scale as the
# truncation constants above (a 65,536-token llama.cpp context window —
# see MAX_BLOCKED_MEMORY_CHARS's comment — at a conservative ~3
# chars/token, leaving headroom for generation and KV-cache growth beyond
# this static count). Only Tier0 (system + task, permanent) and Tier1
# (active tool-result history live in `messages`) occupy characters in
# the prompt at all: Tier2 (evidence retrievable by id via get_evidence)
# and Tier3 (cold: on-disk, named not loaded) are represented by
# references only, never preloaded content, so they carry no char budget
# of their own — see _tier1_chars/_compact_tier1_to_tier2 below.
CONTEXT_BUDGET_CHARS = 200_000
TIER0_BUDGET_PCT = 0.15
TIER1_BUDGET_PCT = 0.60
TIER3_COLD_NOTE = (
    "cold: full evidence-*.jsonl history, unrelated repository areas, and "
    "old session events -- named, not loaded"
)


# ============================================================
# O3 (glimmer-v7 reconciliation): failure memory.
# ============================================================
# The reconciliation doc's O3 entry is "repository memory keyed by repo
# identity; failure memory from tool_blocked events." Repo memory already
# EXISTS as C7's repo-map cache (glimmer-v2.py, ~/.muse-glimmer/repo-maps/
# <head-sha>.json) — that half is deliberately SKIPPED here, not
# reimplemented: it is keyed by HEAD SHA (invalidated on every commit/
# lockfile change) because a repo map describes code structure, which
# really does go stale on every commit. Failure memory is the opposite
# shape — "this shell command is blocked by policy in this repo" is true
# across commits and branches, so it needs a key that survives them,
# hence a separate identity function below rather than reusing
# REPO_MAP_CACHE_ROOT's SHA keying.
MUSE_GLIMMER_HOME = Path.home() / ".muse-glimmer"


def _repo_identity(workspace) -> str:
    """O3: stable identity for a repo, used to key
    ~/.muse-glimmer/memory/<repo-id>/. Cheapest deterministic choice that
    actually survives commits/branches (unlike C7's SHA keying, see the
    module comment above): basename(git root) + a short hash of the
    ABSOLUTE git root path. Not the remote URL — new-glimmer-task.sh's own
    preflight already permits/produces worktrees with no upstream at all,
    so "no remote" can't be the common case this depends on. Two
    differently-located repos that happen to share a basename still get
    distinct ids because the hash covers the full path; the same repo
    always resolves to the same id regardless of cwd."""
    root = Path(workspace).resolve()
    digest = hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:10]
    return f"{root.name}-{digest}"


def _blocked_commands_path(workspace) -> Path:
    return MUSE_GLIMMER_HOME / "memory" / _repo_identity(workspace) / "blocked-commands.json"


# LRU cap (reconciliation doc: "~50 entries LRU") -- keeps the file (and the
# eventual prompt injection) bounded even for a repo that accumulates many
# distinct blocked patterns over a long history of sessions.
BLOCKED_COMMANDS_CAP = 50


def record_blocked_command(workspace, command, reason) -> None:
    """O3: append/dedupe one tool_blocked occurrence into this repo's
    failure memory. Same never-raises discipline as every other
    best-effort disk write in this codebase (C1/C3/C6's tasks.json /
    architecture-plan.json writers): a memory-directory failure
    (permissions, full disk, read-only $HOME) must never take down an
    otherwise-healthy engineering session. This is pure best-effort
    learning, not enforcement -- shell_policy/architect's write-gate
    already enforce the actual block synchronously, regardless of
    whether this write succeeds. LRU-capped at BLOCKED_COMMANDS_CAP: the
    least-recently-seen entries beyond the cap are dropped on every
    write."""
    try:
        path = _blocked_commands_path(workspace)
        entries = []
        if path.exists():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, list):
                    entries = loaded
            except (OSError, ValueError):
                entries = []

        now = datetime.now(timezone.utc).isoformat()
        for entry in entries:
            if isinstance(entry, dict) and entry.get("command") == command:
                entry["count"] = int(entry.get("count") or 1) + 1
                entry["reason"] = reason
                entry["lastSeen"] = now
                break
        else:
            entries.append({
                "command": command,
                "reason": reason,
                "count": 1,
                "lastSeen": now,
            })

        entries.sort(key=lambda e: e.get("lastSeen") or "")
        entries = entries[-BLOCKED_COMMANDS_CAP:]

        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(entries, indent=2), encoding="utf-8")
    except Exception as exc:  # never-raises: best-effort memory only.
        print(f"[ENGINEER] WARN: failed to record blocked command in memory: {exc}")


# Hard budget caps for the prompt-injection side (reconciliation doc: "hard
# cap the injected text (~1KB)" / "~10 most-frequent"). This shares the same
# 65,536-token context window as the repo map, architecture plan, tasks and
# everything else in the prompt.
MAX_BLOCKED_MEMORY_ITEMS = 10
MAX_BLOCKED_MEMORY_CHARS = 1024


def failure_memory_addendum(workspace) -> str:
    """O3: compact system-prompt addendum surfacing this repo's previously
    blocked command patterns, sorted most-frequent first and capped to
    MAX_BLOCKED_MEMORY_ITEMS. Returns "" (inject nothing) whenever the
    memory file doesn't exist, is empty, or is unreadable -- zero behavior
    change for the overwhelmingly common case of a repo that has never
    tripped shell_policy/the architect write-gate. Hard-capped to
    MAX_BLOCKED_MEMORY_CHARS regardless of how many entries exist. Never
    raises."""
    try:
        path = _blocked_commands_path(workspace)
        if not path.exists():
            return ""
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(loaded, list) or not loaded:
            return ""
        entries = sorted(
            (e for e in loaded if isinstance(e, dict) and e.get("command")),
            key=lambda e: e.get("count") or 0,
            reverse=True,
        )[:MAX_BLOCKED_MEMORY_ITEMS]
        if not entries:
            return ""
        lines = [
            f"- {e['command']!r} ({e.get('reason') or 'blocked by policy'})"
            for e in entries
        ]
        text = (
            "\n\nThese command patterns were previously blocked by policy "
            "in this repository -- do not attempt them:\n" + "\n".join(lines)
        )
        return text[:MAX_BLOCKED_MEMORY_CHARS]
    except Exception:  # never-raises: absence of memory must never break a run.
        return ""


# ============================================================
# TOOL GROUPS
# ============================================================

READ_TOOLS = {
    "read_file",
    "file_glob_search",
    "grep_search",
    "get_datetime",
    "get_info",
}

WRITE_TOOLS = {
    "write_file",
    "edit_file",
}

# O4 (glimmer-v7 reconciliation doc, §3.11): find_symbol / find_references /
# find_related_tests — served CLIENT-SIDE in this Python process, never a
# llama.cpp/C++ change (the doc's explicit rationale: the 1200s exec_shell_
# command timeout patch is already one maintenance burden against upstream;
# a second C++ tool doubles it). get_tools() below appends their schemas to
# whatever the live /tools endpoint returns; execute_tool() intercepts these
# three names and runs them in-process, BEFORE the point where a real tool
# call would otherwise reach http_json's POST /tools — everything downstream
# of that (caching, evidence, events, compact_tool_result_for_model) is
# unmodified and applies identically to a real HTTP tool result. All three
# are read-only, lexical/regex-based (not a real language server/AST/LSP) —
# see their definitions' descriptions and docstrings below.
SEMANTIC_TOOL_NAMES = {
    "find_symbol",
    "find_references",
    "find_related_tests",
    # Task 5.1 (V7 §7 Tier2 "retrievable"): get_evidence(id) reads one
    # already-persisted evidence-*.jsonl entry back into the conversation
    # by id -- same client-side interception path as the other three (see
    # _execute_semantic_tool below), reusing every piece of existing
    # plumbing keyed off this set (the ledger-eligible tool list, the
    # generic read-tool result cache, discovery/post-gate budget
    # counting, and architect-mode availability).
    "get_evidence",
}

PATH_TOOLS = {
    "read_file",
    "file_glob_search",
    "grep_search",
    "write_file",
    "edit_file",
    # find_related_tests takes a "path" arg and must be contained inside the
    # workspace exactly like read_file/write_file/edit_file — reusing
    # secure_tool_arguments/resolve_workspace_path here is the ONLY path-
    # containment scheme O4 uses; no second scheme was introduced.
    "find_related_tests",
}

REQUIRED_ENGINEERING_TOOLS = {
    "read_file",
    "file_glob_search",
    "grep_search",
    "write_file",
    "edit_file",
    "exec_shell_command",
}

# C1 (glimmer-v7): Architect mode's entire tool set (V7 §5.2 "recommended
# tools", scoped down to what this repo's tool server actually exposes).
# READ_TOOLS already excludes write_file/edit_file by construction — this
# is the ONLY tool set ever offered to the model in architect mode, and
# execute_tool() below additionally hard-blocks WRITE_TOOLS by tool name
# (not merely by omission) whenever mode == "architect", so a model that
# calls an unoffered write tool anyway still cannot execute it.
#
# O4: the semantic tools are read-only discovery aids exactly like
# READ_TOOLS, so Architect mode (which is itself entirely read-only) gets
# them too — deliberate, not an oversight (see reconciliation doc O4 /
# §3.11's "available in architect mode" requirement).
ARCHITECT_TOOL_NAMES = READ_TOOLS | {"exec_shell_command"} | SEMANTIC_TOOL_NAMES

# C1 fix round 1 (Minor finding): engineer mode's existing default,
# preserved exactly (was a bare literal `default=32` in main()'s argparse
# block, now named so it can be referenced from both main() and here).
ENGINEER_MAX_TURNS_DEFAULT = 32

# Architect mode gets its OWN, smaller default: unbounded/oversized turn
# budgets are exactly the latency risk the reconciliation doc's C1 entry
# names for an unmeasured Architect ("An Architect that only adds latency
# is worse than no Architect"). Read-only exploration + one final JSON
# turn should converge well inside run_engineer's own 8-call discovery
# budget for a write-capable loop; 12 leaves headroom for a couple of
# re-prompts if the model's first final answer isn't valid JSON (see
# run_architect's re-prompt-on-invalid-JSON path) without approaching
# engineer mode's 32. Still overridable via --max-turns for either mode.
ARCHITECT_MAX_TURNS_DEFAULT = 12


# ============================================================
# FILESYSTEM PROTECTION
# ============================================================

PROTECTED_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "playwright-report",
    "test-results",
    ".vercel",
}

PROTECTED_FILES = {
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
}


# ============================================================
# HTTP
# ============================================================

def api_key():
    return API_KEY_FILE.read_text().strip()


def http_json(
    method,
    endpoint,
    payload=None,
    extra_headers=None,
):
    headers = {
        "Authorization": f"Bearer {api_key()}",
        "Content-Type": "application/json",
    }

    if extra_headers:
        headers.update(extra_headers)

    data = None

    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    req = request.Request(
        f"{API_BASE}{endpoint}",
        data=data,
        headers=headers,
        method=method,
    )

    try:
        with request.urlopen(
            req,
            timeout=3600,
        ) as response:

            raw = response.read().decode(
                "utf-8",
                errors="replace",
            )

            return json.loads(raw)

    except error.HTTPError as exc:
        body = exc.read().decode(
            "utf-8",
            errors="replace",
        )

        raise RuntimeError(
            f"HTTP {exc.code} {endpoint}\n{body}"
        ) from exc


# ============================================================
# LOCAL SAFE GIT HELPERS
# ============================================================

def git_local(workspace, *args):
    result = subprocess.run(
        ["git", *args],
        cwd=workspace,
        text=True,
        capture_output=True,
    )

    if result.returncode != 0:
        raise RuntimeError(
            result.stderr.strip()
            or f"git {' '.join(args)} failed"
        )

    return result.stdout.rstrip()


# ============================================================
# PATH SECURITY
# ============================================================

def resolve_workspace_path(
    value,
    workspace,
):
    path = Path(value).expanduser()

    if not path.is_absolute():
        path = workspace / path

    resolved = path.resolve(strict=False)

    try:
        resolved.relative_to(workspace)
    except ValueError:
        raise PermissionError(
            f"Path escapes repository: {value}"
        )

    return resolved


def check_write_path(
    path,
    workspace,
):
    relative = path.relative_to(workspace)

    for part in relative.parts:
        if part in PROTECTED_DIRS:
            raise PermissionError(
                "Writing to protected directory "
                f"is blocked: {relative}"
            )

    if path.name.startswith(".env"):
        raise PermissionError(
            "Writing environment/secret files "
            f"is blocked: {relative}"
        )

    if path.name in PROTECTED_FILES:
        raise PermissionError(
            "Lockfile writes are blocked in "
            f"Engineering Mode v1: {relative}"
        )

    if path.suffix == ".lock":
        raise PermissionError(
            f"Lockfile writes are blocked: {relative}"
        )


def secure_tool_arguments(
    tool_name,
    arguments,
    workspace,
):
    arguments = dict(arguments)

    if tool_name not in PATH_TOOLS:
        return arguments

    value = arguments.get("path", ".")

    resolved = resolve_workspace_path(
        value,
        workspace,
    )

    if (
        tool_name == "read_file"
        and resolved.is_dir()
    ):
        raise PermissionError(
            f"{resolved} is a directory. "
            "Use file_glob_search instead."
        )

    if tool_name in WRITE_TOOLS:
        check_write_path(
            resolved,
            workspace,
        )

    if tool_name == "write_file":
        if resolved.exists():
            raise PermissionError(
                "write_file is only allowed for "
                "new files in Engineering Mode v1. "
                f"Existing file: {resolved}"
            )

    if tool_name == "edit_file":
        if not resolved.is_file():
            raise PermissionError(
                "edit_file requires an existing "
                f"regular file: {resolved}"
            )

    arguments["path"] = str(resolved)

    return arguments


# ============================================================
# SHELL SECURITY
# ============================================================

def load_validation_script_allowlist():
    """
    Derive the npm validation allowlist from the real script names in the
    session's repo-map.json (written by glimmer-v2.py, R3, to the same
    session directory as GLIMMER_EVENTS_PATH).

    Returns a set of exact, real script names matching the validation
    shape (typecheck/test:unit/test:e2e, generalized across packages), or
    None when no repo map is available (standalone invocation per
    new-glimmer-task.sh, or the file is missing/unreadable) — callers
    fall back to the old shape-only pattern match in that case. The
    derived set is always a subset of what the shape-only match would
    allow, so this can only narrow the allowlist, never widen it.
    """
    if not GLIMMER_EVENTS_PATH:
        return None

    repo_map_path = (
        Path(GLIMMER_EVENTS_PATH).parent
        / "repo-map.json"
    )

    try:
        data = json.loads(
            repo_map_path.read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return None

    names = set()

    for package in data.get("packages") or []:
        scripts = package.get("scripts")

        if not isinstance(scripts, dict):
            continue

        for name in scripts:
            if (
                name == "typecheck"
                or name.startswith("typecheck:")
                or name == "test:unit"
                or name.startswith("test:unit:")
                or name == "test:e2e"
                or name.startswith("test:e2e:")
            ):
                names.add(name)

    # A repo map that read/parsed successfully but has zero matching
    # scripts must return an empty set here, NOT None — None is reserved
    # for "no repo map available at all" (the two early returns above),
    # where callers fall back to the shape-only match. Falling back to
    # `names or None` would collapse "repo map says nothing matches" into
    # that same fallback, which is wider than an empty allowlist and
    # violates ADR-0002's "always a subset, narrows, never widens".
    return names


# Shared with _is_idempotent_validation_command below (Fix 1 follow-up,
# fix-followups-a-c round 2) so the repeat-command cache's notion of
# "read-only git" / "typecheck-shaped npm script" can never drift from
# what shell_policy itself actually allows.
SAFE_READONLY_GIT_SUBCOMMANDS = {
    "status",
    "diff",
    "show",
    "log",
    "rev-parse",
}


def _is_typecheck_script(script):
    return script == "typecheck" or script.startswith("typecheck:")


def shell_policy(
    command,
    workspace,
    validation_allowlist=None,
):
    if not isinstance(command, str):
        return False, "Command must be a string"

    command = command.strip()

    if not command:
        return False, "Empty command"

    # No shell composition / pipes / redirects / substitutions.
    if re.search(
        r"[;&|><\n\r`]",
        command,
    ):
        return False, (
            "Shell composition, pipes and redirects "
            "are blocked"
        )

    if "$(" in command:
        return False, (
            "Command substitution is blocked"
        )

    try:
        tokens = shlex.split(command)
    except ValueError as exc:
        return False, (
            f"Invalid shell quoting: {exc}"
        )

    if not tokens:
        return False, "Empty command"

    executable = tokens[0]


    # --------------------------------------------------------
    # READ-ONLY GIT
    # --------------------------------------------------------

    if executable == "git":
        if len(tokens) < 2:
            return False, "Incomplete git command"

        subcommand = tokens[1]

        if subcommand in SAFE_READONLY_GIT_SUBCOMMANDS:
            if "--no-index" in tokens:
                return False, (
                    "git diff --no-index blocked"
                )

            # Fix round 1 (Critical finding root cause): `in tokens` only
            # matched the space-separated form (`--output X`) and missed
            # the `=`-joined form (`--output=X`), letting `git diff
            # --output=path` clobber an arbitrary file in both engineer
            # and architect mode. Catch both forms.
            if any(
                token == "--output" or token.startswith("--output=")
                for token in tokens
            ):
                return False, (
                    "git output-to-file blocked"
                )

            return True, "safe read-only git"

        if (
            subcommand == "branch"
            and tokens[2:] == ["--show-current"]
        ):
            return True, "safe read-only git"

        return False, (
            f"git {subcommand} is blocked. "
            "No add/commit/push/reset/clean/"
            "checkout/switch/stash/merge/rebase."
        )


    # --------------------------------------------------------
    # NPM VALIDATION
    # --------------------------------------------------------

    if executable == "npm":
        lowered = [
            value.lower()
            for value in tokens
        ]

        forbidden = {
            "install",
            "i",
            "ci",
            "publish",
            "uninstall",
            "update",
            "exec",
        }

        if any(
            item in forbidden
            for item in lowered[1:]
        ):
            return False, (
                "npm dependency/package operations "
                "are blocked"
            )

        if "--prefix" in tokens:
            index = tokens.index("--prefix")

            if index + 1 >= len(tokens):
                return False, (
                    "--prefix requires a path"
                )

            resolve_workspace_path(
                tokens[index + 1],
                workspace,
            )

        if "run" not in tokens:
            return False, (
                "Only npm run validation scripts "
                "are allowed"
            )

        index = tokens.index("run")

        if index + 1 >= len(tokens):
            return False, (
                "npm run missing script"
            )

        script = tokens[index + 1]
        script_lower = script.lower()

        dangerous_fragments = {
            "deploy",
            "publish",
            "release",
            "production",
            ":prod",
            ":live",
            "migrate",
            "seed",
        }

        if any(
            fragment in script_lower
            for fragment in dangerous_fragments
        ):
            return False, (
                "External/destructive npm script "
                f"blocked: {script}"
            )

        # R5 (glimmer-v7): when a repo map is available (this process was
        # launched by glimmer-v2.py, R3), the allowlist is exactly the real
        # script names it derived — never wider than the shape-only check
        # below, since every derived name must ALSO match that shape (see
        # load_validation_script_allowlist). Only without a repo map
        # (standalone invocation with no session, or an unreadable/missing
        # repo-map.json) does this fall back to the old shape-only match,
        # unchanged from before this task — fail closed, not loosened.
        if validation_allowlist is not None:
            safe_validation = script in validation_allowlist
        else:
            safe_validation = (
                _is_typecheck_script(script)
                or script == "test:unit"
                or script.startswith("test:unit:")
                or script == "test:e2e"
                or script.startswith("test:e2e:")
            )

        if not safe_validation:
            return False, (
                f"npm script '{script}' is not "
                "in the validation allowlist"
            )

        return True, (
            f"safe npm validation: {script}"
        )


    # --------------------------------------------------------
    # PYTHON SYNTAX CHECK
    # --------------------------------------------------------

    if (
        executable in {"python", "python3"}
        and len(tokens) >= 4
        and tokens[1:3]
        == ["-m", "py_compile"]
    ):
        for filename in tokens[3:]:
            resolve_workspace_path(
                filename,
                workspace,
            )

        return True, "safe Python syntax check"


    # --------------------------------------------------------
    # RUST CHECK / TEST
    # --------------------------------------------------------

    if executable == "cargo":
        if len(tokens) < 2:
            return False, (
                "Incomplete cargo command"
            )

        if tokens[1] not in {
            "check",
            "test",
        }:
            return False, (
                "Only cargo check/test allowed"
            )

        if "--manifest-path" in tokens:
            index = tokens.index(
                "--manifest-path"
            )

            if index + 1 >= len(tokens):
                return False, (
                    "--manifest-path requires value"
                )

            resolve_workspace_path(
                tokens[index + 1],
                workspace,
            )

        return True, (
            f"safe cargo {tokens[1]}"
        )


    return False, (
        "Command executable is outside "
        f"the allowlist: {executable}"
    )


def architect_shell_policy(command, workspace):
    """C1 (glimmer-v7): exec_shell_command policy for architect mode.

    Fix round 1 (Critical finding): this MUST be a strict subset of
    shell_policy BY CONSTRUCTION — by delegating to it — not by
    re-implementing shell_policy's own preamble. A prior version
    re-implemented the composition/pipe/quoting checks and, in doing so,
    silently dropped shell_policy's git-specific `--no-index` and
    `--output` guards, making architect mode MORE permissive than engineer
    mode on both writes (`git diff --output CLOBBER.txt`) and path
    containment (`git diff --no-index /etc/passwd /etc/hosts`) — the exact
    inversion this mode exists to prevent. Delegating means this can never
    be more permissive than shell_policy for any command shape, now or
    after any future change to shell_policy, without anyone having to
    remember to mirror that change here too.

    Additionally requires `git <subcommand>` where subcommand is in the
    SAME module-level SAFE_READONLY_GIT_SUBCOMMANDS set shell_policy's own
    git branch and the repeat-command guard already share (per ADR-0002's
    "one allowlist" rule) — architect mode has no legitimate use for
    npm/cargo/py_compile validation commands or `git branch
    --show-current` (shell_policy allows all of those; architect mode is
    narrower still).
    """
    allowed, reason = shell_policy(command, workspace)

    if not allowed:
        return False, reason

    # shell_policy already proved this parses (allowed == True), so this
    # can't raise — re-split just to inspect the executable/subcommand.
    tokens = shlex.split(command.strip())

    if tokens[0] != "git" or len(tokens) < 2 or tokens[1] not in SAFE_READONLY_GIT_SUBCOMMANDS:
        return False, (
            "Architect mode allows only read-only git commands: "
            "git {" + ", ".join(sorted(SAFE_READONLY_GIT_SUBCOMMANDS)) + "}"
        )

    return True, f"safe read-only git {tokens[1]} (architect mode)"


def _is_idempotent_validation_command(command):
    """Fix 1 follow-up (fix-followups-a-c round 2): classify an
    ALREADY shell_policy-allowed command as safe to short-circuit from
    the repeat-command cache (execute_tool). shell_policy allows more
    than this — it also allows npm run test:unit/test:e2e and
    cargo test, since those are legitimate validation commands to
    *run* — but their output is not provably stable run-to-run (flaky
    tests, network calls inside tests, timing-dependent assertions,
    coverage/snapshot writes). Only the genuinely side-effect-free,
    deterministic subset — read-only git, typecheck-shaped npm
    scripts, python -m py_compile, cargo check — is cache-eligible.
    Mirrors shell_policy's own branch structure and reuses its shared
    SAFE_READONLY_GIT_SUBCOMMANDS / _is_typecheck_script so this can
    never silently drift from what shell_policy actually allows."""
    try:
        tokens = shlex.split(command.strip())
    except ValueError:
        return False

    if not tokens:
        return False

    executable = tokens[0]

    if executable == "git":
        return len(tokens) >= 2 and (
            tokens[1] in SAFE_READONLY_GIT_SUBCOMMANDS
            or (
                tokens[1] == "branch"
                and tokens[2:] == ["--show-current"]
            )
        )

    if executable == "npm" and "run" in tokens:
        index = tokens.index("run")

        return (
            index + 1 < len(tokens)
            and _is_typecheck_script(tokens[index + 1])
        )

    if (
        executable in {"python", "python3"}
        and len(tokens) >= 4
        and tokens[1:3] == ["-m", "py_compile"]
    ):
        return True

    if executable == "cargo":
        return len(tokens) >= 2 and tokens[1] == "check"

    return False


# ============================================================
# TOOL DISCOVERY
# ============================================================

def get_tools():
    raw = http_json(
        "GET",
        "/tools",
    )

    metadata = {}
    definitions = []

    for item in raw:
        name = item.get("tool")
        definition = item.get("definition")

        if not name or not definition:
            continue

        metadata[name] = item
        definitions.append(definition)

    missing = (
        REQUIRED_ENGINEERING_TOOLS
        - set(metadata)
    )

    if missing:
        raise RuntimeError(
            "Engineering tools missing: "
            + ", ".join(sorted(missing))
            + "\nStart llama-server with "
            "GLIMMER_AGENT_MODE=write."
        )

    # --------------------------------------------------------
    # Runtime exec_shell timeout preflight
    # --------------------------------------------------------
    #
    # The engineering client must verify the LIVE llama-server,
    # not merely the source tree or binary on disk.
    #
    # A manually started or stale llama-server could otherwise
    # expose exec_shell_command with the old 60-second maximum.
    #
    # Fail closed if the runtime schema cannot prove a shell
    # timeout of at least 1200 seconds.
    # --------------------------------------------------------

    shell_meta = metadata.get(
        "exec_shell_command",
        {},
    )

    permissions = (
        shell_meta.get("permissions")
        or {}
    )

    if permissions.get("write") is not True:
        raise RuntimeError(
            "Engineering runtime preflight failed: "
            "exec_shell_command does not advertise "
            "write permission."
        )

    definition = (
        shell_meta.get("definition")
        or {}
    )

    function = (
        definition.get("function")
        or {}
    )

    parameters = (
        function.get("parameters")
        or {}
    )

    properties = (
        parameters.get("properties")
        or {}
    )

    timeout_schema = (
        properties.get("timeout")
        or {}
    )

    timeout_description = str(
        timeout_schema.get(
            "description",
            "",
        )
    )

    runtime_max_timeout = None
    timeout_marker = "max "

    if timeout_marker in timeout_description:
        tail = timeout_description.rsplit(
            timeout_marker,
            1,
        )[1]

        digits = []

        for character in tail:
            if character.isdigit():
                digits.append(character)
            else:
                break

        if digits:
            runtime_max_timeout = int(
                "".join(digits)
            )

    required_timeout = 1200

    if runtime_max_timeout is None:
        raise RuntimeError(
            "Engineering runtime preflight failed: "
            "unable to prove exec_shell_command's "
            "maximum timeout from the live /tools schema.\n"
            f"Runtime description: "
            f"{timeout_description!r}"
        )

    if runtime_max_timeout < required_timeout:
        raise RuntimeError(
            "Engineering runtime preflight failed: "
            "the live llama-server shell timeout is too low.\n"
            f"Runtime maximum: {runtime_max_timeout}s\n"
            f"Required minimum: {required_timeout}s\n"
            "Start the patched Glimmer Agent server before "
            "running an engineering session."
        )

    print(
        "Runtime shell timeout: "
        f"{runtime_max_timeout}s (PASS)"
    )

    # O4: append the client-side semantic tool schemas — identical shape to
    # what the loop above just built from the live /tools response
    # (metadata[name] = the raw item, definitions += the OpenAI-function
    # "definition" block) so every downstream consumer of get_tools()'s
    # return value (the `tools` list sent to the model, the `tool_name not
    # in metadata` unknown-tool check) treats these exactly like real
    # server tools. See SEMANTIC_TOOL_DEFINITIONS and execute_tool's
    # SEMANTIC_TOOL_NAMES dispatch branch below for the actual
    # implementations.
    for item in SEMANTIC_TOOL_DEFINITIONS:
        metadata[item["tool"]] = item
        definitions.append(item["definition"])

    return metadata, definitions


# ============================================================
# TOOL RESULTS / EVIDENCE
# ============================================================

def result_text(result):
    if "plain_text_response" in result:
        text = str(
            result["plain_text_response"]
        )
    else:
        text = json.dumps(
            result,
            ensure_ascii=False,
            indent=2,
        )

    if len(text) > MAX_TOOL_RESULT:
        text = (
            text[:MAX_TOOL_RESULT]
            + "\n\n[tool output truncated]"
        )

    return text


def _capped_display_args(args, limit=MAX_EVENT_FIELD):
    """Cap each top-level string value in an args dict before it's emitted
    as tool_started.args. Must run on top of (i.e. AFTER) the caller's
    WRITE_TOOLS redaction into display_args — this only bounds length of
    already-safe values, it must never be used in place of that redaction
    or run on raw, unredacted arguments."""
    if not isinstance(args, dict):
        return args
    out = {}
    for key, value in args.items():
        if isinstance(value, str) and len(value) > limit:
            out[key] = value[:limit] + "...(truncated)"
        else:
            out[key] = value
    return out


@functools.lru_cache(maxsize=None)
def _evidence_file_path():
    """C5 (glimmer-v7): evidence-NN.jsonl path in the session directory
    (parent of GLIMMER_EVENTS_PATH, same convention load_validation_
    script_allowlist above already uses), or None when it can't be
    determined (e.g. standalone invocation per new-glimmer-task.sh) — same
    no-op guarantee as _emit() above.

    NN mirrors the iteration numbering verify-NN-MM.json and prompt-NN.txt
    already use (see verify()/the main loop in glimmer-v2.py). v2.py writes
    prompt-{iteration:02d}.txt to the session dir *before* spawning this
    subprocess (invoke_engineer in glimmer-v2.py), so the highest-numbered
    prompt-NN.txt already present at process startup is this process's own
    iteration — no new env var or v2.py change needed to learn it.

    Cached (lru_cache on a zero-arg function) because this process only
    ever runs one iteration; computed once, reused for every add_evidence
    call.
    """
    if not GLIMMER_EVENTS_PATH or not GLIMMER_SESSION_ID:
        return None

    session_dir = Path(GLIMMER_EVENTS_PATH).parent
    numbers = [
        int(m.group(1))
        for p in session_dir.glob("prompt-*.txt")
        for m in [re.match(r"prompt-(\d+)\.txt$", p.name)]
        if m
    ]
    iteration = max(numbers) if numbers else 0
    return session_dir / f"evidence-{iteration:02d}.jsonl"


_evidence_seq = 0


def _head_tail_cap(text, max_chars, marker):
    """Shared head+tail cap: keep the first ~72% and last ~28% of `text`
    (matching compact_tool_result_for_model's existing split), with a
    marker line noting how much was omitted in between -- instead of a
    plain head-only truncation.

    Fix round 1 (HIGH): before this, _persist_evidence capped head-only
    while compact_tool_result_for_model kept head+tail, so swapping a
    Tier1 message for a Tier2 "retrievable via get_evidence" stub could
    silently lose the tail content the model had already seen this turn
    (get_evidence would resolve to a strictly smaller excerpt than what
    it replaced). Both call sites -- and get_evidence's own read-back --
    now share this one shape, so a Tier1->Tier2 swap never loses tail
    context, only the middle the compaction marker already discloses."""
    if len(text) <= max_chars:
        return text
    head_size = int(max_chars * 0.72)
    tail_size = max_chars - head_size
    omitted = len(text) - max_chars
    return (
        text[:head_size]
        + "\n\n"
        + f"<<< {marker}; {omitted} CHARACTERS OMITTED >>>"
        + "\n\n"
        + text[-tail_size:]
    )


def _persist_evidence(tool_name, arguments, content):
    """Append one evidence-NN.jsonl line with a stable, citable id.

    Unlike glimmer_events.emit() (glimmer_events.py), this file is only
    ever written by this single process — glimmer-v2.py never writes to
    it — so there's no cross-process race to defend against and no need
    for emit()'s uuid-based id scheme. A plain in-process incrementing
    counter gives stable, unique-within-session ids more simply.

    Returns the assigned evidence id (or None when there's no session
    dir to persist to — see _evidence_file_path). Task 1.1 (V7 §12):
    execute_tool's ToolEnvelope carries this id in its `evidence` list,
    so callers need it back rather than only using this for its
    side effect.
    """
    path = _evidence_file_path()
    if path is None:
        return None

    global _evidence_seq
    _evidence_seq += 1

    evidence_id = f"{GLIMMER_SESSION_ID}-ev-{_evidence_seq}"
    record = {
        "id": evidence_id,
        "sessionId": GLIMMER_SESSION_ID,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "tool": tool_name,
        "arguments": arguments,
        # Fix round 1 (HIGH): head+tail cap (see _head_tail_cap), not a
        # head-only slice -- see that helper's docstring for why.
        "content": _head_tail_cap(content, MAX_EVIDENCE_RESULT, "EVIDENCE COMPACTED"),
    }
    try:
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as exc:  # noqa: BLE001 - evidence persistence must never break the session
        print(f"[glimmer-engineer] failed to persist evidence: {exc}", flush=True)

    return evidence_id


def _evidence_index_file_path():
    """Task 5.2 (V7 §26/§46): evidence-index.json path in the session dir
    -- NOT iteration-numbered (unlike evidence-NN.jsonl): one shared,
    incrementally-extended graph-lite file per session, since evidence
    ids from earlier iterations are still valid citations for a later
    iteration's delivery review or get_evidence lookup. Same no-session-
    dir-available contract as _evidence_file_path (returns None)."""
    if not GLIMMER_EVENTS_PATH:
        return None
    return Path(GLIMMER_EVENTS_PATH).parent / "evidence-index.json"


# Task 5.2: semantic "kind" per producing tool, for the index node's
# `kind` field -- separate from `toolCall` (which just records the tool
# name verbatim) so a consumer can group by "file"/"search"/etc. without
# inventing its own tool-name taxonomy. exec_shell_command is
# reclassified to "failure" per-entry (see _index_evidence_entry) when its
# output looks like a failing command; every other tool keeps this static
# mapping.
_EVIDENCE_KIND_BY_TOOL = {
    "read_file": "file",
    "write_file": "file",
    "edit_file": "file",
    "file_glob_search": "search",
    "grep_search": "search",
    "exec_shell_command": "shell",
    "find_symbol": "symbol",
    "find_references": "symbol",
    "find_related_tests": "test-search",
    "get_evidence": "retrieval",
}

# ponytail: a regex heuristic over shell-command output, not the real
# signature/AST parser glimmer-v2.py's verify() baseline-diffing uses (see
# error_signatures() there) -- upgrade to share that logic if this proves
# too noisy in practice.
_FAILURE_PATH_RE = re.compile(r"^\s*([./]?[\w][\w./-]*\.\w+):\d+", re.MULTILINE)

# Fix round 1 (LOW): gate failure classification on the tool's OWN
# structured exit-status marker, not prose-sniffing for words like
# "error"/"fail" (which false-positives on a clean "0 failures" pass and
# false-negatives on a real crash with no such word). exec_shell_command's
# real implementation (llama.cpp/tools/server/server-tools.cpp) always
# appends exactly "\n[exit code: N]" (optionally "... [exit due to timed
# out]") to its plain_text_response -- deterministic and always present,
# so this is real exit status, not a heuristic over output text.
_SHELL_EXIT_CODE_RE = re.compile(r"\[exit code: (-?\d+)\](?:\s*\[exit due to timed out\])?\s*$")


def _shell_exit_code(text):
    """Parse exec_shell_command's trailing "[exit code: N]" marker.
    Returns the int exit code, or None if the marker is missing/
    malformed (e.g. text from a different tool, or a hand-built test
    fixture) -- never raises."""
    if not text:
        return None
    m = _SHELL_EXIT_CODE_RE.search(text.strip())
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def _extract_test_paths_from_related_tests_result(text):
    """Deterministic parse of find_related_tests' own output shape (see
    find_related_tests() above: 'Found N likely test file(s) for X:\\n'
    followed by one path per line) into a plain list of path strings --
    the file->test relatesTo edge. Returns [] for the "no matches" prose
    (which doesn't start with "Found ") or any malformed input."""
    lines = (text or "").splitlines()
    if not lines or not lines[0].startswith("Found "):
        return []
    return [ln.strip() for ln in lines[1:] if ln.strip()]


def _extract_failure_file_paths(text):
    """Deterministic, best-effort scan for '<path>:<line>' occurrences in
    shell-command output (the same shape compiler/test error signatures
    take) -- the failure->file relatesTo edge. Callers only invoke this
    once _shell_exit_code has already confirmed a real nonzero exit (see
    _index_evidence_entry) -- this function itself does no prose-based
    gating, just path extraction, capped at 20 distinct paths."""
    paths = []
    seen = set()
    for m in _FAILURE_PATH_RE.finditer(text or ""):
        p = m.group(1)
        if p not in seen:
            seen.add(p)
            paths.append(p)
        if len(paths) >= 20:
            break
    return paths


def _append_evidence_index_entry(evidence_id, kind, tool_name, path_value, relates_to=None):
    """Task 5.2 (V7 §26/§46): append one node to evidence-index.json in
    the session dir -- a flat incremental graph-lite list of
    {id, kind, path?, toolCall, relatesTo[]?} entries, read-modify-
    written on every persisted evidence entry. Never raises: any failure
    (no session dir, unreadable/corrupt existing file, unwritable disk)
    is swallowed exactly like _persist_evidence/_persist_tool_envelope's
    own discipline -- the evidence-NN.jsonl stream (and the session
    itself) must never depend on this index existing."""
    idx_path = _evidence_index_file_path()
    if idx_path is None or evidence_id is None:
        return
    try:
        try:
            existing = json.loads(idx_path.read_text(encoding="utf-8"))
            if not isinstance(existing, list):
                existing = []
        except (OSError, json.JSONDecodeError):
            existing = []

        entry = {"id": evidence_id, "kind": kind, "toolCall": tool_name}
        if path_value:
            entry["path"] = path_value
        if relates_to:
            entry["relatesTo"] = relates_to
        existing.append(entry)

        # Fix round 1 (LOW): write-to-temp-then-replace, not a direct
        # write_text -- a crash/kill mid-write must never leave a torn
        # evidence-index.json for the next append (or the CC gateway) to
        # read back as corrupt/empty. os.replace is atomic on both POSIX
        # and Windows (same discipline control-center's task-overrides.json
        # write already uses).
        tmp_path = idx_path.with_name(f"{idx_path.name}.tmp-{os.getpid()}")
        tmp_path.write_text(
            json.dumps(existing, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(tmp_path, idx_path)
    except Exception as exc:  # noqa: BLE001 - index is best-effort only
        print(f"[glimmer-engineer] failed to update evidence index: {exc}")


def _index_evidence_entry(evidence_id, tool_name, arguments, content):
    """Task 5.2: derive kind/path/relatesTo for one just-persisted
    evidence entry and append it to evidence-index.json. Never raises
    (caller wraps this too, but every lookup here is itself defensive)."""
    kind = _EVIDENCE_KIND_BY_TOOL.get(tool_name, tool_name)
    path_value = arguments.get("path") if isinstance(arguments, dict) else None

    relates_to = []
    if tool_name == "find_related_tests":
        for test_path in _extract_test_paths_from_related_tests_result(content):
            relates_to.append({"path": test_path, "kind": "test"})
    elif tool_name == "exec_shell_command":
        # Fix round 1 (LOW): gate on the tool's own real exit status, not
        # output prose -- see _shell_exit_code's docstring.
        exit_code = _shell_exit_code(content)
        if exit_code is not None and exit_code != 0:
            kind = "failure"
            for p in _extract_failure_file_paths(content):
                relates_to.append({"path": p, "kind": "file"})

    _append_evidence_index_entry(evidence_id, kind, tool_name, path_value, relates_to or None)


def add_evidence(
    ledger,
    tool_name,
    arguments,
    content,
):
    # Fix round 1 (MED): get_evidence is a pure Tier2 READ of an already-
    # persisted entry -- recording its own result as NEW evidence (and
    # indexing it into evidence-index.json) would self-amplify the store
    # with a duplicate node/record for every retrieval, never a genuinely
    # new observation. Checked before the `interesting` set below (which
    # still includes it via SEMANTIC_TOOL_NAMES, unchanged, for every
    # OTHER purpose -- caching, budget-set membership for tools it IS
    # exempted from at the increment sites in run_engineer).
    if tool_name == "get_evidence":
        return None

    interesting = {
        "read_file",
        "file_glob_search",
        "grep_search",
        "exec_shell_command",
        "write_file",
        "edit_file",
    } | SEMANTIC_TOOL_NAMES  # O4: discovery calls, evidence-worthy like grep/read

    if tool_name not in interesting:
        return None

    ledger.append(
        "TOOL: "
        + tool_name
        + "\nARGS: "
        + json.dumps(
            arguments,
            ensure_ascii=False,
        )
        + "\nRESULT:\n"
        + content[:MAX_EVIDENCE_RESULT]
    )

    evidence_id = _persist_evidence(tool_name, arguments, content)

    # Task 5.2 (V7 §26/§46): evidence-index.json graph-lite entry. Must
    # never break evidence recording itself -- add_evidence's return
    # value (the evidence id) is used by callers regardless of whether
    # indexing succeeds.
    try:
        _index_evidence_entry(evidence_id, tool_name, arguments, content)
    except Exception as exc:  # noqa: BLE001 - indexing is best-effort only
        print(f"[glimmer-engineer] failed to index evidence entry: {exc}")

    return evidence_id


def compact_evidence(ledger):
    output = []
    total = 0

    # Prefer recent evidence.
    for item in reversed(ledger):
        if (
            total + len(item)
            > MAX_EVIDENCE_TOTAL
        ):
            break

        output.append(item)
        total += len(item)

    output.reverse()

    return "\n\n---\n\n".join(output)


# ============================================================
# APPROVAL
# ============================================================

def approval_description(
    tool_name,
    arguments,
    workspace,
):
    if tool_name in WRITE_TOOLS:
        path = Path(
            arguments["path"]
        ).relative_to(workspace)

        return f"{tool_name}: {path}"

    if tool_name == "exec_shell_command":
        return (
            "shell: "
            + arguments.get(
                "command",
                "",
            )
        )

    return tool_name


def approve(
    tool_name,
    arguments,
    workspace,
    state,
):
    if state["approve_all"]:
        return True

    print()
    print("┌─ APPROVAL REQUIRED")
    print(
        "│ "
        + approval_description(
            tool_name,
            arguments,
            workspace,
        )
    )
    print("└─")

    answer = input(
        "Allow? "
        "[y]es / [n]o / "
        "[a]ll safe actions this run: "
    ).strip().lower()

    if answer == "a":
        state["approve_all"] = True
        return True

    return answer in {
        "y",
        "yes",
    }


# ============================================================
# VERIFICATION OWNERSHIP (R5, glimmer-v7 — see ADR-0002)
# ============================================================
#
# v2 (glimmer-v2.py, R3) owns authoritative verification and writes the
# canonical GlimmerSessionStatus vocabulary to manifest["state"] — but it
# always runs that verification AFTER this process exits (invoke_engineer
# is a blocking subprocess call; verify() only runs once it returns), so
# manifest["state"] can never actually reach "verified" while THIS process
# is still executing. Reading it here would be dead code, exactly like the
# CreatorHub-frontend-specific mechanism this replaces.
#
# What this process CAN own is the in-process equivalent for its own tool
# loop, using the same vocabulary and the same rule for any repository:
# once a validation command has been attempted after a successful write,
# that write is presumed load-bearing evidence and repository writes
# freeze. There is no CreatorHub-specific command detection and no
# diagnostic/verification two-phase split — one rule, repo-agnostic.


def repository_write_guard_decision(
    tool_name,
    engineer_state,
):
    """
    Freeze repository writes once the local verification state has
    reached "verified" — the same vocabulary Task 6 (R3) uses for
    manifest["state"], applied in-process instead of cross-process.

    Any post-write validation command (npm run <script>, cargo
    check/test, python -m py_compile — see is_post_write_validation_
    command) that has actually been attempted is terminal verification
    evidence, regardless of whether it passed, failed, or timed out.
    Once that evidence exists, later repository edits would invalidate
    the verified snapshot and therefore must be blocked.
    """
    return bool(
        engineer_state == "verified"
        and tool_name in WRITE_TOOLS
    )


def is_post_write_validation_command(command):
    """
    Generic (repo-agnostic) recognizer for a validation command: any
    npm script invocation, cargo check/test, or a Python syntax check.
    Replaces the old CreatorHub-frontend-specific --prefix/typecheck
    detection — shell_policy already restricts which npm scripts are
    actually runnable, so this only needs to recognize the command
    shape to drive the write-freeze state.
    """
    return (
        command.startswith("npm ")
        or command.startswith("python3 -m py_compile")
        or command.startswith("python -m py_compile")
        or command.startswith("cargo check")
        or command.startswith("cargo test")
    )


# ============================================================
# SEMANTIC CODE TOOLS (O4, glimmer-v7 reconciliation §3.11)
# ============================================================
#
# find_symbol / find_references / find_related_tests, served client-side
# (see the SEMANTIC_TOOL_NAMES comment above for the rationale). All three
# are deterministic, lexical/regex-based scans over workspace files — NOT
# a real language server, parser, or AST — and say so in their own
# `description` field (SEMANTIC_TOOL_DEFINITIONS below) so the model
# doesn't over-trust the results.
#
# Ignore-directory discipline: glimmer-v2.py already has this exact
# convention (IGNORE_DIRS / walk_files, glimmer-v2.py line ~43). The two
# Python files are kept independent by existing project convention
# (glimmer-engineer.py never imports glimmer-v2.py or vice versa — only
# the shared glimmer_events.py module crosses that boundary), so this is a
# deliberate, documented duplication of the same ignore set rather than a
# new import — keep the two lists in sync if either changes.
_SEMANTIC_IGNORE_DIRS = {
    ".git", "node_modules", ".next", ".turbo", ".cache", "coverage",
    "dist", "build", "out", ".output", ".venv", "venv", "__pycache__",
}

_SEMANTIC_MAX_NAME_LEN = 200
_SEMANTIC_MAX_MATCHES = 50
_SEMANTIC_MAX_FILE_BYTES = 1024 * 1024  # 1MB per-file read cap — skip huge files


def _semantic_walk_files(workspace, max_depth=5):
    """Yield every non-ignored file under workspace. Dirs are pruned
    in-place during os.walk (same technique as glimmer-v2.py's walk_files)
    so an ignored subtree (node_modules, .git, dist, ...) is never
    descended into at all, not merely filtered out after listing.
    Same max_depth convention/default as glimmer-v2.py's walk_files — an
    unbounded walk over a huge/deeply-nested repo is the same cost that
    function already caps."""
    base_depth = len(Path(workspace).parts)
    for current, dirs, files in os.walk(workspace):
        cp = Path(current)
        depth = len(cp.parts) - base_depth
        dirs[:] = [d for d in dirs if d not in _SEMANTIC_IGNORE_DIRS]
        if depth >= max_depth:
            dirs[:] = []
        for name in files:
            yield cp / name


def _semantic_read_text(path):
    """Read a file for lexical scanning. Never raises — skips (returns
    None for) anything too large, unreadable, or non-UTF-8 (binary), so
    one bad/binary file can never abort a whole-workspace scan, matching
    the fail-soft convention glimmer-v2.py's safe_json/changed_files_text
    already use (see glimmer-v2.py's `except (OSError, UnicodeDecodeError)`
    around untracked-file reads). Deliberately no errors="ignore": that
    would silently decode binary files instead of skipping them."""
    try:
        if path.stat().st_size > _SEMANTIC_MAX_FILE_BYTES:
            return None
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _validate_semantic_name(name):
    """Shared input guard for find_symbol/find_references: a hostile name
    (regex metacharacters, pathologically long strings) must never reach
    re.compile as raw regex source. Every use below builds patterns with
    re.escape(name), so this only needs to bound length/emptiness — the
    escaping itself is what defeats a ReDoS/wildcard attempt like
    name=".*" or name="(?:a+)+"."""
    if not isinstance(name, str) or not name.strip():
        raise ValueError("name must be a non-empty string")
    name = name.strip()
    if len(name) > _SEMANTIC_MAX_NAME_LEN:
        raise ValueError(
            f"name too long ({len(name)} chars, max {_SEMANTIC_MAX_NAME_LEN})"
        )
    return name


_JS_TS_EXTS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
_PY_EXTS = {".py"}


def _symbol_patterns(escaped_name):
    """One compiled pattern per definition "kind". `escaped_name` must
    already be re.escape()'d by the caller. Deliberately lexical: matches
    the keyword + name shape regardless of an `export`/`export default`
    prefix (e.g. `export function X` still matches `\\bfunction\\s+X\\b`),
    but will miss more exotic declaration syntax — that is the documented
    honesty trade-off (grep-shaped, not a parser)."""
    return {
        "function": re.compile(r"\bfunction\s+" + escaped_name + r"\b"),
        "const": re.compile(r"\bconst\s+" + escaped_name + r"\b\s*="),
        "class": re.compile(r"\bclass\s+" + escaped_name + r"\b"),
        "interface": re.compile(r"\binterface\s+" + escaped_name + r"\b"),
        "type": re.compile(r"\btype\s+" + escaped_name + r"\b\s*="),
        "def": re.compile(r"\bdef\s+" + escaped_name + r"\b"),
    }


def find_symbol(name, kind, workspace):
    """Locate definition(s) of `name` across the workspace. TS/JS:
    function/const/class/interface/type declarations. Python: def/class.
    `kind` optionally narrows to one of those (kind="function" also
    matches Python `def`, since callers rarely distinguish the two).
    Capped at _SEMANTIC_MAX_MATCHES; returns "file:line: <matched line>"
    per hit."""
    name = _validate_semantic_name(name)
    patterns = _symbol_patterns(re.escape(name))

    if kind:
        kind = str(kind).strip().lower()
        wanted = {"function", "def"} if kind == "function" else {kind}
        patterns = {k: v for k, v in patterns.items() if k in wanted}

    matches = []
    for path in _semantic_walk_files(workspace):
        ext = path.suffix
        if ext in _JS_TS_EXTS:
            active = {k: v for k, v in patterns.items() if k != "def"}
        elif ext in _PY_EXTS:
            active = {k: v for k, v in patterns.items() if k in ("def", "class")}
        else:
            continue
        if not active:
            continue

        text = _semantic_read_text(path)
        if text is None:
            continue

        rel = path.relative_to(workspace).as_posix()
        for lineno, line in enumerate(text.splitlines(), start=1):
            if any(pat.search(line) for pat in active.values()):
                matches.append(f"{rel}:{lineno}: {line.strip()}")
                if len(matches) >= _SEMANTIC_MAX_MATCHES:
                    break
        if len(matches) >= _SEMANTIC_MAX_MATCHES:
            break

    if not matches:
        return (
            f"No definitions of '{name}' found (lexical regex scan for "
            "function/const/class/interface/type in TS/JS and def/class "
            "in Python — this is NOT a real language server; unusual "
            "declaration syntax may be missed)."
        )

    suffix = " [match limit reached, results truncated]" if len(matches) >= _SEMANTIC_MAX_MATCHES else ""
    header = f"Found {len(matches)} definition-shaped match(es) for '{name}'{suffix}:\n"
    return header + "\n".join(matches)


def find_references(name, workspace):
    """All usages of `name` across the workspace, word-boundary matched
    (so searching "foo" will never match inside "foobar") and grouped by
    file. Definition lines are NOT excluded from the results — they
    contain the bare word too, so they will appear here as well as in
    find_symbol's output. This is a deliberate honesty-over-cleverness
    choice: distinguishing "this line defines X" from "this line merely
    mentions X" would require real parsing, which this lexical tool does
    not do. Capped at _SEMANTIC_MAX_MATCHES total matches."""
    name = _validate_semantic_name(name)
    pattern = re.compile(r"\b" + re.escape(name) + r"\b")

    by_file = {}
    total = 0
    for path in _semantic_walk_files(workspace):
        text = _semantic_read_text(path)
        if text is None:
            continue

        file_matches = []
        for lineno, line in enumerate(text.splitlines(), start=1):
            if pattern.search(line):
                file_matches.append(f"{lineno}: {line.strip()}")
                total += 1
                if total >= _SEMANTIC_MAX_MATCHES:
                    break

        if file_matches:
            by_file[path.relative_to(workspace).as_posix()] = file_matches
        if total >= _SEMANTIC_MAX_MATCHES:
            break

    if not by_file:
        return (
            f"No references to '{name}' found (word-boundary lexical "
            "search across the workspace)."
        )

    lines = [
        f"Found {total} reference(s) to '{name}' across {len(by_file)} "
        "file(s) (word-boundary match; definition lines are included, "
        "not excluded — see find_symbol to specifically locate "
        "definitions):"
    ]
    for rel, file_matches in by_file.items():
        lines.append(f"\n{rel}:")
        lines.extend(f"  {m}" for m in file_matches)
    return "\n".join(lines)


def _semantic_test_core_name(filename):
    """If `filename` matches one of the four same-basename test patterns
    (X.test.*, X.spec.*, test_X.*, X_test.*), return the "X" it names a
    test for. Otherwise None. Used both to detect "is this a test file at
    all" (via _semantic_is_test_filename) and to check "is it a test file
    FOR this specific basename"."""
    stem = Path(filename).stem
    if not Path(filename).suffix:
        return None
    if stem.endswith(".test") or stem.endswith(".spec"):
        return stem.rsplit(".", 1)[0]
    if filename.startswith("test_") and stem.startswith("test_"):
        return stem[len("test_"):]
    if stem.endswith("_test"):
        return stem[: -len("_test")]
    return None


def _semantic_is_test_filename(filename):
    return _semantic_test_core_name(filename) is not None


def find_related_tests(path, workspace):
    """Given a source file path, find its likely test file(s):
    same-basename patterns (X.test.*, X.spec.*, test_X.*, X_test.*)
    anywhere in the workspace, PLUS any test-shaped file whose content
    imports/requires this file's basename (catches e.g. a test file named
    after the feature it exercises, not the module under test).

    `path` has already been resolved and workspace-contained by
    secure_tool_arguments (find_related_tests is in PATH_TOOLS, so it goes
    through the exact same resolve_workspace_path containment check as
    read_file/write_file/edit_file — no second scheme)."""
    source = Path(path)
    base = source.stem

    # A test file that imports/requires this basename rather than being
    # named after it — deliberately simple substring-in-quotes-near-an-
    # import-keyword check, not a real import-graph analysis.
    import_pattern = re.compile(
        r"""(?:from|require|import)\b[^\n'"]*['"][^'"]*\b"""
        + re.escape(base)
        + r"""\b[^'"]*['"]"""
    )

    matches = []
    for candidate in _semantic_walk_files(workspace):
        try:
            if candidate.resolve() == source.resolve():
                continue
        except OSError:
            pass

        name = candidate.name
        core = _semantic_test_core_name(name)
        rel = candidate.relative_to(workspace).as_posix()

        if core == base:
            matches.append(rel)
        elif _semantic_is_test_filename(name):
            text = _semantic_read_text(candidate)
            if text and import_pattern.search(text):
                matches.append(rel)

        if len(matches) >= _SEMANTIC_MAX_MATCHES:
            break

    if not matches:
        return (
            f"No related test files found for '{source.name}' (checked "
            "same-basename patterns X.test.*/X.spec.*/test_X.*/X_test.* "
            "plus test-shaped files importing/requiring this basename)."
        )

    return (
        f"Found {len(matches)} likely test file(s) for '{source.name}':\n"
        + "\n".join(matches)
    )


def _find_evidence_by_id(evidence_id):
    """Task 5.1 (V7 §7 Tier2 "retrievable"): scan every evidence-*.jsonl
    file in this session's directory (not just this process's own
    iteration -- see _evidence_file_path's docstring on per-iteration
    numbering) for a line whose "id" matches, returning its persisted
    content capped to MAX_EVIDENCE_RESULT. Only _persist_evidence's own
    entries carry a top-level "id" (tool_envelope entries from
    _persist_tool_envelope do not), so this can never resolve to the
    wrong kind of record. Never raises: any failure (no session dir,
    unreadable directory, corrupt line, unknown id) degrades to a plain
    "not found" string, exactly like a real tool returning a miss rather
    than an exception."""
    if not GLIMMER_EVENTS_PATH:
        return "EVIDENCE_NOT_FOUND: no session evidence store available in this run."
    try:
        session_dir = Path(GLIMMER_EVENTS_PATH).parent
        for path in sorted(session_dir.glob("evidence-*.jsonl")):
            try:
                with path.open("r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            record = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if record.get("id") == evidence_id:
                            # Already capped head+tail at persist time
                            # (_persist_evidence uses _head_tail_cap too)
                            # -- returned verbatim, not re-capped here.
                            # Re-applying _head_tail_cap on top of its own
                            # output would compound (the capped output can
                            # itself exceed max_chars by the marker's own
                            # overhead, so a second pass would slice
                            # through the marker/content a second time).
                            return str(record.get("content") or "")
            except OSError:
                continue
    except Exception:  # noqa: BLE001 - a retrieval miss must never crash the session
        pass
    return f"EVIDENCE_NOT_FOUND: no evidence entry with id {evidence_id!r} in this session."


def _execute_semantic_tool(tool_name, arguments, workspace):
    """Single dispatch point execute_tool() calls for SEMANTIC_TOOL_NAMES.
    Shaped as {"plain_text_response": ...} — the SAME shape a real /tools
    HTTP response uses — so the caller's existing result_text() (28000-char
    cap) needs no special-casing for these tools."""
    if tool_name == "find_symbol":
        text = find_symbol(
            arguments.get("name", ""),
            arguments.get("kind"),
            workspace,
        )
    elif tool_name == "find_references":
        text = find_references(arguments.get("name", ""), workspace)
    elif tool_name == "find_related_tests":
        text = find_related_tests(arguments.get("path", ""), workspace)
    elif tool_name == "get_evidence":
        text = _find_evidence_by_id(str(arguments.get("id", "")))
    else:
        raise ValueError(f"unknown semantic tool: {tool_name}")
    return {"plain_text_response": text}


# OpenAI-function-shaped definitions, matching exactly what the live
# /tools endpoint returns per item (server_tool::to_json() in
# llama.cpp/tools/server/server-tools.cpp: display_name/tool/type/
# permissions/uses_cwd/definition) — see get_tools() above, which appends
# these to the real server's list. permissions.write is always False:
# every one of these is read-only by construction (see
# _execute_semantic_tool above, which never touches the filesystem beyond
# reading).
SEMANTIC_TOOL_DEFINITIONS = [
    {
        "display_name": "Find symbol",
        "tool": "find_symbol",
        "type": "function",
        "permissions": {"write": False},
        "uses_cwd": True,
        "definition": {
            "type": "function",
            "function": {
                "name": "find_symbol",
                "description": (
                    "Locate where a symbol (function, class, const, "
                    "interface, or type) is DEFINED across the workspace. "
                    "Prefer this over grep_search when you know a "
                    "symbol's name and want its definition site(s), not "
                    "every mention — use find_references for that. "
                    "Lexical/regex-based (function X / const X = / "
                    "class X / interface X / type X = in TS/JS; def X / "
                    "class X in Python) — not a real language server; "
                    "unusual declaration syntax may be missed."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Exact symbol name to find definitions of.",
                        },
                        "kind": {
                            "type": "string",
                            "description": (
                                "Optional filter: function, const, class, "
                                "interface, or type. Omit to search all kinds."
                            ),
                        },
                    },
                    "required": ["name"],
                },
            },
        },
    },
    {
        "display_name": "Find references",
        "tool": "find_references",
        "type": "function",
        "permissions": {"write": False},
        "uses_cwd": True,
        "definition": {
            "type": "function",
            "function": {
                "name": "find_references",
                "description": (
                    "Find all usages of an identifier across the "
                    "workspace (word-boundary match, grouped by file). "
                    "Prefer this over grep_search for 'where is X used' "
                    "questions — unlike a plain grep, it will not match "
                    "the name as a substring of a longer identifier (e.g. "
                    "searching 'foo' will not match 'foobar'). Lexical, "
                    "not a real language server: the definition line(s) "
                    "are NOT excluded from the results (they contain the "
                    "bare word too), so this tool's output may overlap "
                    "with find_symbol's."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Exact identifier to search for (word-boundary match).",
                        },
                    },
                    "required": ["name"],
                },
            },
        },
    },
    {
        "display_name": "Find related tests",
        "tool": "find_related_tests",
        "type": "function",
        "permissions": {"write": False},
        "uses_cwd": True,
        "definition": {
            "type": "function",
            "function": {
                "name": "find_related_tests",
                "description": (
                    "Given a source file path, find its likely test "
                    "file(s): same-basename patterns (X.test.*, X.spec.*, "
                    "test_X.*, X_test.*) anywhere in the workspace, plus "
                    "test-shaped files that import/require this file's "
                    "basename. Prefer this over grep_search once you've "
                    "changed a file and need to find what to run/update "
                    "to verify it."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Workspace-relative or absolute path to the source file.",
                        },
                    },
                    "required": ["path"],
                },
            },
        },
    },
    {
        "display_name": "Get evidence",
        "tool": "get_evidence",
        "type": "function",
        "permissions": {"write": False},
        "uses_cwd": True,
        "definition": {
            "type": "function",
            "function": {
                "name": "get_evidence",
                "description": (
                    "Retrieve a previously recorded tool result by its "
                    "evidence id (the '[evidence <id> ...]' ids you see "
                    "in your own conversation). Returns a head+tail "
                    "excerpt capped to a few thousand characters, not "
                    "necessarily the complete original result. Use this "
                    "instead of re-running read_file/grep_search/etc. "
                    "when you already know the exact evidence id you need."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "Exact evidence id to retrieve.",
                        },
                    },
                    "required": ["id"],
                },
            },
        },
    },
]


# ============================================================
# TOOL EXECUTION
# ============================================================

# Task 1.1 (glimmer-v7, V7 §12 "Tool result contract"): execute_tool below
# builds one ToolEnvelope per call — success, cache hit, policy block, or
# denial — from which the model-facing message is rendered by the ONE
# function below (_render_tool_envelope_message), and which is itself
# persisted to evidence-NN.jsonl (alongside, not instead of, the existing
# per-tool add_evidence entries) by _persist_tool_envelope. execute_tool's
# own return type is UNCHANGED — still (message: str, changed: bool) — so
# none of its ~8 existing call sites (run_engineer's loop, run_architect's
# loop, every selfcheck that calls execute_tool directly) need to change.
# `changed` is carried as a top-level extra field on the envelope beyond
# the spec's {ok,tool,durationMs,data,evidence,warnings,error} shape, since
# it's this codebase's existing write-detection signal and every envelope
# should fully describe its call.
def _build_tool_envelope(
    *,
    ok,
    tool,
    duration_ms,
    data=None,
    evidence=None,
    warnings=None,
    error=None,
    changed=False,
):
    return {
        "ok": ok,
        "tool": tool,
        "durationMs": duration_ms,
        "data": data,
        "evidence": evidence or [],
        "warnings": warnings or [],
        "error": error,
        "changed": changed,
    }


def _render_tool_envelope_message(envelope):
    """The single function that renders the model-facing message from a
    ToolEnvelope. Byte-compatible with every pre-envelope message: an
    error envelope's message is exactly the blocked/denied message text
    (unchanged from before this task); a success (or cache-hit) envelope's
    message is exactly the tool's result content, carried verbatim in
    envelope["data"]."""
    if envelope["error"] is not None:
        return envelope["error"]["message"]
    return envelope["data"]


_LAST_TOOL_ENVELOPE_EVIDENCE_IDS = []


def _persist_tool_envelope(envelope):
    """Append the envelope itself to the same evidence-NN.jsonl stream
    add_evidence/_persist_evidence already write to, tagged with
    kind="tool_envelope" so it's distinguishable from the existing
    per-tool entries in that file. Data is capped (reusing the same
    MAX_EVIDENCE_RESULT bound _persist_evidence already applies) so a
    huge tool result doesn't double the file's size. Same no-op-with-no-
    session-dir and never-raises discipline as _persist_evidence.

    Task 5.1 (V7 §7): also stashes this envelope's own evidence id list
    into a module-global scratch variable, unconditionally (even when
    there's no session dir to persist to, in which case it's simply []).
    execute_tool() has no return-value slot for this (every existing
    caller unpacks its 2-tuple return), so the caller in run_engineer's
    main loop reads this global immediately after each execute_tool()
    call -- safe because this process is single-threaded/synchronous and
    _persist_tool_envelope is the ONE place every execute_tool() return
    path passes through right before returning."""
    global _LAST_TOOL_ENVELOPE_EVIDENCE_IDS
    _LAST_TOOL_ENVELOPE_EVIDENCE_IDS = list(envelope.get("evidence") or [])

    path = _evidence_file_path()
    if path is None:
        return

    record = dict(envelope)
    data = record.get("data")
    if isinstance(data, str) and len(data) > MAX_EVIDENCE_RESULT:
        record["data"] = data[:MAX_EVIDENCE_RESULT] + "\n\n[envelope data truncated]"
    # error.message can embed a model-controlled token verbatim (e.g. the
    # blocked executable name from shlex) — cap it too, on a copied dict so
    # the envelope returned to the caller is untouched.
    error = record.get("error")
    if isinstance(error, dict) and isinstance(error.get("message"), str) and len(error["message"]) > MAX_EVIDENCE_RESULT:
        record["error"] = dict(error)
        record["error"]["message"] = error["message"][:MAX_EVIDENCE_RESULT] + "\n\n[envelope error truncated]"
    record["kind"] = "tool_envelope"
    record["sessionId"] = GLIMMER_SESSION_ID
    record["timestamp"] = datetime.now(timezone.utc).isoformat()

    try:
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as exc:  # noqa: BLE001 - evidence persistence must never break the session
        print(f"[glimmer-engineer] failed to persist tool envelope: {exc}", flush=True)


def execute_tool(
    tool_name,
    arguments,
    workspace,
    approval_state,
    cache,
    ledger,
    validation_allowlist=None,
    mode="engineer",
):
    _envelope_start = time.monotonic()

    def _duration_ms():
        return int((time.monotonic() - _envelope_start) * 1000)

    # C1 (glimmer-v7): architect mode must be STRUCTURALLY incapable of
    # writing, not merely un-offered the tool. run_architect() never puts
    # write_file/edit_file in the tool schema sent to the model, but a
    # model can still emit a tool_call naming an unoffered tool (some
    # local function-calling backends don't hard-enforce the offered
    # `tools` list) — so this is the single authoritative gate: even if
    # such a call arrives, it is rejected here, before argument
    # sanitization or any dispatch, regardless of caller. This must stay
    # the ONLY place execute_tool short-circuits on tool identity so the
    # guarantee can't be bypassed by adding a new call path later.
    if mode == "architect" and tool_name in WRITE_TOOLS:
        message = (
            "ENGINEERING SECURITY BLOCK: architect mode is read-only; "
            "write_file/edit_file are never executed in this mode."
        )

        print()
        print(f"✗ BLOCKED: {tool_name} (architect mode is read-only)")

        _emit(
            "tool_blocked",
            command=tool_name,
            reason="architect mode is read-only",
        )
        record_blocked_command(workspace, tool_name, "architect mode is read-only")

        envelope = _build_tool_envelope(
            ok=False,
            tool=tool_name,
            duration_ms=_duration_ms(),
            error={"code": "POLICY_BLOCK", "message": message},
        )
        _persist_tool_envelope(envelope)

        return _render_tool_envelope_message(envelope), False

    # Task 2.4 (V7 §5.5 second half): consult_architect is intercepted
    # client-side exactly like the O4 semantic tools above (SEMANTIC_
    # TOOL_NAMES) -- it never reaches http_json. It gets its own early-
    # return block (like the architect-mode guard just above, and the
    # shell-policy/approval blocks further down) rather than folding into
    # the generic post-dispatch flow later in this function, because a
    # budget-exhausted call must produce an ok:false envelope with a real
    # error code -- every tool that reaches the generic flow is assumed to
    # have already succeeded. No path argument, so this runs before
    # secure_tool_arguments/PATH_TOOLS on purpose (a no-op for this tool
    # name anyway) and needs no cache key (each call consumes budget, so
    # caching identical questions would silently under-count it).
    if tool_name == "consult_architect":
        global _consult_architect_used

        # Review round 1 (MED): the SAME structural gate
        # _augment_tools_with_consult_architect used to decide whether to
        # offer this tool at all -- re-checked here so a model that calls
        # it anyway (unoffered, or offered under a stale plan/flag state)
        # is still structurally denied, not merely un-offered. No budget
        # burn and no network call for this path -- it isn't a real
        # consultation attempt, just an invalid call.
        if not _architect_consult_enabled or _loaded_architecture_plan is None:
            message = (
                "CONSULT_NOT_OFFERED: consult_architect is not available "
                "in this session (no architecture plan, or "
                "--architect-consult-enabled was not passed)."
            )

            print()
            print(f"✗ BLOCKED: consult_architect ({message})")

            envelope = _build_tool_envelope(
                ok=False,
                tool=tool_name,
                duration_ms=_duration_ms(),
                error={"code": "CONSULT_NOT_OFFERED", "message": message},
            )
            _persist_tool_envelope(envelope)

            return _render_tool_envelope_message(envelope), False

        if _consult_architect_used >= CONSULT_ARCHITECT_BUDGET:
            message = (
                "CONSULT_BUDGET_EXHAUSTED: architect consultation budget "
                f"({CONSULT_ARCHITECT_BUDGET}/session) is used up. "
                "Proceed with your own best engineering judgment."
            )

            print()
            print(f"✗ BLOCKED: consult_architect ({message})")

            envelope = _build_tool_envelope(
                ok=False,
                tool=tool_name,
                duration_ms=_duration_ms(),
                error={"code": "CONSULT_BUDGET_EXHAUSTED", "message": message},
            )
            _persist_tool_envelope(envelope)

            return _render_tool_envelope_message(envelope), False

        _consult_architect_used += 1

        print()
        print(f"→ TOOL: {tool_name}")

        answer, question_chars = _run_consult_architect(
            _loaded_architecture_plan,
            arguments.get("question", ""),
        )
        content = result_text({"plain_text_response": answer})

        print("← RESULT:")
        print(content[:1800])

        _emit(
            "architect_consulted",
            questionChars=question_chars,
            answerChars=len(answer),
        )

        evidence_id = add_evidence(ledger, tool_name, arguments, content)

        envelope = _build_tool_envelope(
            ok=True,
            tool=tool_name,
            duration_ms=_duration_ms(),
            data=content,
            evidence=[evidence_id] if evidence_id else [],
        )
        _persist_tool_envelope(envelope)

        return _render_tool_envelope_message(envelope), False

    arguments = secure_tool_arguments(
        tool_name,
        arguments,
        workspace,
    )

    cache_key = None

    # O4: the three semantic tools are idempotent/read-only exactly like
    # read_file/file_glob_search/grep_search, so they share the same
    # (tool, args)-keyed cache — including its existing invalidation
    # (cache.clear() on every successful write in run_engineer's loop).
    if tool_name in {
        "read_file",
        "file_glob_search",
        "grep_search",
    } | SEMANTIC_TOOL_NAMES:
        cache_key = json.dumps(
            [
                tool_name,
                arguments,
            ],
            ensure_ascii=False,
            sort_keys=True,
        )

        if cache_key in cache:
            print(
                f"\n↻ CACHE: {tool_name}"
            )

            envelope = _build_tool_envelope(
                ok=True,
                tool=tool_name,
                duration_ms=_duration_ms(),
                data=cache[cache_key],
            )
            _persist_tool_envelope(envelope)

            return (
                _render_tool_envelope_message(envelope),
                False,
            )


    # --------------------------------------------------------
    # SHELL POLICY
    # --------------------------------------------------------

    if tool_name == "exec_shell_command":
        command = arguments.get(
            "command",
            "",
        )

        # Large monorepo validation commands can legitimately
        # take several minutes.
        if command.startswith(("npm ", "cargo ")):
            minimum_timeout = 300
        else:
            minimum_timeout = None

        if minimum_timeout is not None:
            try:
                arguments["timeout"] = max(
                    int(arguments.get("timeout", minimum_timeout)),
                    minimum_timeout,
                )
            except (TypeError, ValueError):
                arguments["timeout"] = minimum_timeout

        if mode == "architect":
            # Stricter than shell_policy: read-only git only. See
            # architect_shell_policy's docstring.
            allowed, reason = architect_shell_policy(command, workspace)
        else:
            allowed, reason = shell_policy(
                command,
                workspace,
                validation_allowlist,
            )

        if not allowed:
            message = (
                "ENGINEERING SECURITY BLOCK: "
                + reason
            )

            print()
            print(
                f"✗ BLOCKED: {command}"
            )
            print(
                f"  {reason}"
            )

            _emit(
                "tool_blocked",
                command=command[:MAX_EVENT_FIELD],
                reason=reason,
            )
            record_blocked_command(workspace, command[:MAX_EVENT_FIELD], reason)

            envelope = _build_tool_envelope(
                ok=False,
                tool=tool_name,
                duration_ms=_duration_ms(),
                error={"code": "POLICY_BLOCK", "message": message},
            )
            _persist_tool_envelope(envelope)

            return _render_tool_envelope_message(envelope), False

        # ----------------------------------------------------
        # REPEAT-COMMAND GUARD (Fix 1, fix-followups-a-c)
        # ----------------------------------------------------
        #
        # Every command that reaches here already passed shell_policy's
        # allowlist — but that allowlist is broader than "safe to cache":
        # it also allows npm run test:unit/test:e2e and cargo test, whose
        # output isn't provably stable run-to-run (flaky tests, network
        # calls, timing, coverage/snapshot writes). Only the genuinely
        # idempotent subset (read-only git, typecheck-shaped npm scripts,
        # py_compile, cargo check — see _is_idempotent_validation_command)
        # is eligible to short-circuit from the same generic tool-result
        # cache read_file/glob/grep already use above. That cache is
        # already cleared on every write (see cache.clear() in
        # run_engineer), which is exactly the invalidation this guard
        # needs too. Test-shaped commands always fall through and
        # re-execute — no caching, no cache_key at all.
        if _is_idempotent_validation_command(command):
            cache_key = json.dumps(
                [
                    "exec_shell_command",
                    command,
                ],
                ensure_ascii=False,
                sort_keys=True,
            )

            if cache_key in cache:
                print(
                    f"\n↻ CACHE: exec_shell_command "
                    "(already ran this exact command — reusing prior result)"
                )

                envelope = _build_tool_envelope(
                    ok=True,
                    tool=tool_name,
                    duration_ms=_duration_ms(),
                    data=cache[cache_key],
                )
                _persist_tool_envelope(envelope)

                return (
                    _render_tool_envelope_message(envelope),
                    False,
                )


    # --------------------------------------------------------
    # HUMAN APPROVAL
    # --------------------------------------------------------

    if (
        tool_name in WRITE_TOOLS
        or tool_name
        == "exec_shell_command"
    ):
        if not approve(
            tool_name,
            arguments,
            workspace,
            approval_state,
        ):
            print(
                f"\n✗ DENIED: {tool_name}"
            )

            envelope = _build_tool_envelope(
                ok=False,
                tool=tool_name,
                duration_ms=_duration_ms(),
                error={
                    "code": "USER_DENIED",
                    "message": "User denied this tool execution.",
                },
            )
            _persist_tool_envelope(envelope)

            return (
                _render_tool_envelope_message(envelope),
                False,
            )


    print()
    print(f"→ TOOL: {tool_name}")

    if tool_name in WRITE_TOOLS:
        # Redacted: write-tool arguments can carry full file content, so only
        # the path and key names are ever printed/emitted, never the values.
        display_args = {
            "path":
                arguments.get("path"),
            "keys":
                list(arguments.keys()),
        }
    else:
        display_args = arguments

    print(
        json.dumps(
            display_args,
            indent=2,
            ensure_ascii=False,
        )
    )

    _emit(
        "tool_started",
        tool=tool_name,
        # Redaction (display_args, above) happens first; this only caps
        # length on top of it (Minor finding: tool_started.args was
        # previously unbounded).
        args=_capped_display_args(display_args),
    )

    # O4: the semantic tools never reach llama-server at all — they are
    # computed entirely in this process. This is the ONE interception
    # point; everything below (result_text/MAX_TOOL_RESULT truncation,
    # tool_completed event, cache write, add_evidence, `changed` verdict)
    # is unmodified and runs identically for both branches, so a semantic-
    # tool result is handled exactly like a real HTTP tool result from
    # here on.
    if tool_name in SEMANTIC_TOOL_NAMES:
        result = _execute_semantic_tool(
            tool_name,
            arguments,
            workspace,
        )
    else:
        result = http_json(
            "POST",
            "/tools",
            {
                "tool": tool_name,
                "params": arguments,
            },
            {
                "x-tool-cwd":
                    str(workspace),
            },
        )

    content = result_text(result)

    result_summary = content[:1800]

    print("← RESULT:")
    print(result_summary)

    if len(content) > 1800:
        print("...")

    _emit(
        "tool_completed",
        tool=tool_name,
        resultSummary=result_summary,
    )

    if cache_key is not None:
        cache[cache_key] = content

    # C1 (glimmer-v7): architect mode does NOT persist to evidence-NN.jsonl
    # (C5's engineer-iteration ledger). GLIMMER_EVENTS_PATH is the same
    # session dir the real engineer subprocess for iteration 0 will use
    # moments later, and C5's iteration-numbering (derived from the
    # highest prompt-NN.txt present at process startup) defaults to "00"
    # both when no prompt files exist yet (this architect run, spawned
    # before v2.py writes prompt-00.txt) and when prompt-00.txt exists
    # (the real iteration-0 engineer run right after it) — so persisting
    # here would collide filenames with a DIFFERENT process's independent
    # _evidence_seq counter, producing duplicate evidence ids in one file.
    # Architect exploration evidence is not part of C5's scope; only the
    # architecture-plan.json artifact (a separate, non-numbered file) is.
    evidence_id = None
    if mode != "architect":
        evidence_id = add_evidence(
            ledger,
            tool_name,
            arguments,
            content,
        )

    changed = (
        tool_name in WRITE_TOOLS
    )

    envelope = _build_tool_envelope(
        ok=True,
        tool=tool_name,
        duration_ms=_duration_ms(),
        data=content,
        evidence=[evidence_id] if evidence_id else [],
        changed=changed,
    )
    _persist_tool_envelope(envelope)

    return _render_tool_envelope_message(envelope), changed


def _repeat_guard_selfcheck() -> None:
    """Fix 1 (fix-followups-a-c): repeat-validation-command guard on
    exec_shell_command in execute_tool, reusing the same generic
    tool-result cache read_file/glob/grep already use (cleared on every
    write). Monkeypatches http_json so no live llama-server/tool endpoint
    is needed. Run with:
    python3 glimmer-engineer.py --repeat-guard-selfcheck
    """
    global http_json

    calls = []

    def fake_http_json(method, endpoint, payload=None, extra_headers=None):
        calls.append(payload["params"]["command"])
        return {"plain_text_response": f"result #{len(calls)}"}

    real_http_json = http_json
    http_json = fake_http_json

    try:
        cache = {}
        ledger = []
        approval_state = {"approve_all": True}
        workspace = Path(".")

        # First run of a validation-shaped command: actually executes.
        result1, changed1 = execute_tool(
            "exec_shell_command",
            {"command": "git status"},
            workspace,
            approval_state,
            cache,
            ledger,
        )
        assert changed1 is False
        assert len(calls) == 1, "first run must actually execute"

        # Same command again, no intervening write: short-circuited from
        # the cache — no second execution, same result returned.
        result2, changed2 = execute_tool(
            "exec_shell_command",
            {"command": "git status"},
            workspace,
            approval_state,
            cache,
            ledger,
        )
        assert result2 == result1
        assert changed2 is False
        assert len(calls) == 1, (
            "repeat command without an intervening write must be "
            "short-circuited from cache, not re-executed"
        )

        # A write invalidates prior validation results — same mechanism
        # run_engineer's loop already applies (cache.clear() on any
        # WRITE_TOOLS success). Simulate that here.
        cache.clear()

        # Same command again, AFTER a write: guard must NOT block it —
        # cache correctly invalidated, so it actually re-executes.
        result3, changed3 = execute_tool(
            "exec_shell_command",
            {"command": "git status"},
            workspace,
            approval_state,
            cache,
            ledger,
        )
        assert changed3 is False
        assert len(calls) == 2, (
            "repeat command AFTER a write must re-execute, not be "
            "blocked by a stale cache entry"
        )
        assert result3 != result1

        # Test-shaped commands (round 2 follow-up fix): shell_policy allows
        # npm run test:unit/test:e2e — legitimate to *run* — but their
        # output isn't provably stable run-to-run (flaky tests, network
        # calls, timing). These must NEVER be served from cache, even with
        # no intervening write: both calls must genuinely re-execute.
        test_cache = {}
        calls.clear()

        result_t1, changed_t1 = execute_tool(
            "exec_shell_command",
            {"command": "npm run test:unit"},
            workspace,
            approval_state,
            test_cache,
            ledger,
        )
        assert changed_t1 is False
        assert len(calls) == 1, "first test run must actually execute"

        result_t2, changed_t2 = execute_tool(
            "exec_shell_command",
            {"command": "npm run test:unit"},
            workspace,
            approval_state,
            test_cache,
            ledger,
        )
        assert changed_t2 is False
        assert len(calls) == 2, (
            "test-shaped command must always re-execute, never be "
            "short-circuited from cache, even with no intervening write "
            "(its output isn't provably stable run-to-run)"
        )
        assert result_t2 != result_t1
        assert test_cache == {}, (
            "test-shaped command must never populate the cache at all"
        )

    finally:
        http_json = real_http_json

    print("repeat-validation-command guard self-check: PASS")


def _evidence_persistence_selfcheck() -> None:
    """C5 (glimmer-v7): evidence-NN.jsonl persistence. Run with:
    python3 glimmer-engineer.py --evidence-selfcheck
    """
    import tempfile

    global GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID, _evidence_seq

    real_events_path = GLIMMER_EVENTS_PATH
    real_session_id = GLIMMER_SESSION_ID

    try:
        with tempfile.TemporaryDirectory() as td:
            session_dir = Path(td)
            (session_dir / "events.jsonl").write_text("")
            # v2.py writes prompt-NN.txt for every iteration before it
            # spawns this process, including earlier iterations' — the
            # highest NN present at startup is this process's iteration.
            (session_dir / "prompt-00.txt").write_text("first attempt")
            (session_dir / "prompt-01.txt").write_text("repair 1")

            GLIMMER_EVENTS_PATH = str(session_dir / "events.jsonl")
            GLIMMER_SESSION_ID = "sess-abc"
            _evidence_file_path.cache_clear()
            _evidence_seq = 0

            ledger = []
            add_evidence(ledger, "read_file", {"path": "a.py"}, "contents of a.py")
            add_evidence(ledger, "grep_search", {"pattern": "foo"}, "a.py:1:foo")
            # Not in the "interesting" set: must not append to the ledger
            # or the persisted file.
            add_evidence(ledger, "some_other_tool", {}, "irrelevant")

            assert len(ledger) == 2, "uninteresting tool must not reach the ledger"

            evidence_path = session_dir / "evidence-01.jsonl"
            assert evidence_path.exists(), (
                "evidence must persist to evidence-<iteration>.jsonl, "
                "iteration derived from the highest prompt-NN.txt present"
            )
            lines = evidence_path.read_text().splitlines()
            assert len(lines) == 2, f"expected 2 persisted entries, got {len(lines)}"

            records = [json.loads(line) for line in lines]
            ids = [r["id"] for r in records]
            assert len(set(ids)) == len(ids), "evidence ids must be unique within a session"
            assert all(i.startswith("sess-abc-ev-") for i in ids), "ids must be stable/traceable to the session"
            assert records[0]["tool"] == "read_file"
            assert records[1]["tool"] == "grep_search"
            assert records[0]["content"] == "contents of a.py"

            # No-op path: session dir can't be determined (unset env) must
            # not crash, and must not write a file.
            GLIMMER_EVENTS_PATH = None
            GLIMMER_SESSION_ID = None
            _evidence_file_path.cache_clear()
            ledger2 = []
            add_evidence(ledger2, "read_file", {"path": "b.py"}, "contents of b.py")
            assert len(ledger2) == 1, "in-memory ledger must keep working with no session dir"
            assert evidence_path.read_text().splitlines() == lines, (
                "no-op path must not touch any evidence file"
            )

    finally:
        GLIMMER_EVENTS_PATH = real_events_path
        GLIMMER_SESSION_ID = real_session_id
        _evidence_file_path.cache_clear()
        _evidence_seq = 0

    print("evidence persistence self-check: PASS")


def _tool_envelope_selfcheck() -> None:
    """Task 1.1 (glimmer-v7, V7 §12 "Tool result contract"): proves
    execute_tool's internal ToolEnvelope for both a success path
    (read_file) and a policy-blocked path (exec_shell_command denied by
    shell_policy) — envelope shape, durationMs, evidence ids, and that
    the model-facing message rendered from the envelope is byte-identical
    to the pre-envelope legacy return value. No model, no network:
    http_json is monkeypatched exactly like _repeat_guard_selfcheck above.
    Run with: python3 glimmer-engineer.py --tool-envelope-selfcheck
    """
    import tempfile

    global http_json, GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID, _evidence_seq

    real_http_json = http_json
    real_events_path = GLIMMER_EVENTS_PATH
    real_session_id = GLIMMER_SESSION_ID

    fake_result = {"plain_text_response": "contents of a.py"}

    def fake_http_json(method, endpoint, payload=None, extra_headers=None):
        return fake_result

    http_json = fake_http_json

    try:
        with tempfile.TemporaryDirectory() as td:
            session_dir = Path(td)
            (session_dir / "events.jsonl").write_text("")
            (session_dir / "prompt-00.txt").write_text("iteration 0")

            GLIMMER_EVENTS_PATH = str(session_dir / "events.jsonl")
            GLIMMER_SESSION_ID = "sess-envelope-selfcheck"
            _evidence_file_path.cache_clear()
            _evidence_seq = 0

            # Resolved (not "."), matching _semantic_tools_selfcheck's own
            # workspace convention above: resolve_workspace_path requires
            # the workspace argument itself to already be the same
            # (symlink-resolved) form Path.resolve() produces, or a real
            # path's containment check spuriously fails on platforms where
            # the temp dir is itself a symlink (e.g. macOS /tmp -> /private/tmp).
            workspace = Path(td).resolve()
            (workspace / "a.py").write_text("contents of a.py")

            cache = {}
            ledger = []
            approval_state = {"approve_all": True}

            # ------------------------------------------------------
            # 1. Success envelope: read_file.
            # ------------------------------------------------------
            legacy_message = result_text(fake_result)

            message, changed = execute_tool(
                "read_file",
                {"path": "a.py"},
                workspace,
                approval_state,
                cache,
                ledger,
            )

            assert message == legacy_message, (
                "message rendered from a success envelope must be "
                f"byte-identical to the legacy result_text() output, got: {message!r}"
            )
            assert changed is False

            evidence_path = session_dir / "evidence-00.jsonl"
            records = [json.loads(line) for line in evidence_path.read_text().splitlines()]
            envelopes = [r for r in records if r.get("kind") == "tool_envelope"]
            assert len(envelopes) == 1, f"expected 1 persisted envelope, got {len(envelopes)}"

            success_env = envelopes[0]
            assert success_env["ok"] is True
            assert success_env["tool"] == "read_file"
            assert isinstance(success_env["durationMs"], int) and success_env["durationMs"] >= 0
            assert success_env["data"] == message
            assert success_env["error"] is None
            assert success_env["warnings"] == []
            assert success_env["changed"] is False
            assert (
                len(success_env["evidence"]) == 1
                and success_env["evidence"][0].startswith("sess-envelope-selfcheck-ev-")
            ), "success envelope must carry the evidence id add_evidence assigned for this call"

            # ------------------------------------------------------
            # 2. Blocked envelope: exec_shell_command outside the
            #    shell_policy allowlist.
            # ------------------------------------------------------
            blocked_message, blocked_changed = execute_tool(
                "exec_shell_command",
                {"command": "rm -rf /"},
                workspace,
                approval_state,
                cache,
                ledger,
            )

            assert blocked_changed is False
            assert blocked_message == (
                "ENGINEERING SECURITY BLOCK: Command executable is "
                "outside the allowlist: rm"
            ), blocked_message

            records = [json.loads(line) for line in evidence_path.read_text().splitlines()]
            envelopes = [r for r in records if r.get("kind") == "tool_envelope"]
            assert len(envelopes) == 2, f"expected 2 persisted envelopes total, got {len(envelopes)}"

            blocked_env = envelopes[-1]
            assert blocked_env["ok"] is False
            assert blocked_env["tool"] == "exec_shell_command"
            assert blocked_env["error"] == {
                "code": "POLICY_BLOCK",
                "message": blocked_message,
            }
            assert isinstance(blocked_env["durationMs"], int) and blocked_env["durationMs"] >= 0
            assert blocked_env["evidence"] == [], "a blocked call must never carry an evidence id"
            assert blocked_env["changed"] is False
            assert blocked_env["data"] is None

    finally:
        http_json = real_http_json
        GLIMMER_EVENTS_PATH = real_events_path
        GLIMMER_SESSION_ID = real_session_id
        _evidence_file_path.cache_clear()
        _evidence_seq = 0

    print("tool envelope self-check: PASS")


def _architect_mode_selfcheck() -> None:
    """C1 (glimmer-v7): proves architect mode's core invariants without a
    live llama-server. Run with:
    python3 glimmer-engineer.py --architect-mode-selfcheck
    """
    import tempfile

    global GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID

    # ------------------------------------------------------------
    # 1. Structural read-only guarantee: the tool set ever offered to
    #    the model in architect mode never includes write_file/edit_file
    #    — this is the SAME filter expression run_architect() uses to
    #    build `architect_tools`, exercised here directly against a
    #    synthetic full tool-definition list standing in for whatever
    #    the live /tools endpoint returns. Since run_architect computes
    #    this list exactly ONCE (no engineer_phase, no per-turn state —
    #    unlike run_engineer's active_tools, there is no state that
    #    could ever widen it mid-session), one assertion here covers
    #    every turn/phase by construction.
    # ------------------------------------------------------------
    all_tool_names = (
        READ_TOOLS | WRITE_TOOLS | {"exec_shell_command", "get_datetime"} | SEMANTIC_TOOL_NAMES
    )
    synthetic_tools = [
        {"type": "function", "function": {"name": name}}
        for name in sorted(all_tool_names)
    ]

    architect_tools = [
        tool
        for tool in synthetic_tools
        if (tool.get("function") or {}).get("name") in ARCHITECT_TOOL_NAMES
    ]
    architect_tool_names = {
        (t.get("function") or {}).get("name") for t in architect_tools
    }

    assert "write_file" not in architect_tool_names, "architect tool set must never offer write_file"
    assert "edit_file" not in architect_tool_names, "architect tool set must never offer edit_file"
    assert architect_tool_names == ARCHITECT_TOOL_NAMES, (
        "architect tool set must be exactly READ_TOOLS + exec_shell_command"
    )
    assert architect_tool_names.issuperset(READ_TOOLS), "architect mode must still offer all read tools"

    # Defense-in-depth: even a tool_call NAMING an unoffered write tool
    # must be rejected before it can execute (execute_tool's own gate,
    # not just "we didn't offer it"). No live server needed — this path
    # returns before any HTTP call is made.
    for write_tool in WRITE_TOOLS:
        result, changed = execute_tool(
            write_tool,
            {"path": "whatever.py", "content": "x"},
            Path("/tmp"),
            {"approve_all": True},
            {},
            [],
            None,
            mode="architect",
        )
        assert changed is False, f"{write_tool} must never report a change in architect mode"
        assert "read-only" in result.lower() or "block" in result.lower(), (
            f"{write_tool} block message must be explicit, got: {result!r}"
        )

    # The same call names, with mode="engineer" (the default every
    # existing caller uses), must NOT be intercepted by the architect
    # gate — proven at the signature level (no live server available
    # here to exercise the real dispatch), i.e. engineer mode is the
    # untouched default.
    import inspect

    assert inspect.signature(execute_tool).parameters["mode"].default == "engineer", (
        "execute_tool's mode default must stay 'engineer' so every "
        "existing call site (which never passes mode=) is unaffected"
    )

    # exec_shell_command in architect mode: only read-only git passes.
    ws = Path("/tmp")
    assert architect_shell_policy("git status", ws)[0] is True
    assert architect_shell_policy("git diff --stat", ws)[0] is True
    assert architect_shell_policy("git rev-parse --show-toplevel", ws)[0] is True
    assert architect_shell_policy("npm run typecheck", ws)[0] is False
    assert architect_shell_policy("git commit -m x", ws)[0] is False
    assert architect_shell_policy("git push", ws)[0] is False
    assert architect_shell_policy("cat package.json", ws)[0] is False
    assert architect_shell_policy("git status; rm -rf /", ws)[0] is False
    # git branch --show-current: shell_policy itself allows this, but
    # architect mode is narrower still (branch isn't in
    # SAFE_READONLY_GIT_SUBCOMMANDS) — proves delegation narrows, not
    # just inherits, shell_policy's allowlist.
    assert shell_policy("git branch --show-current", ws)[0] is True
    assert architect_shell_policy("git branch --show-current", ws)[0] is False

    # Fix round 1 (Critical finding) regression test: the exact two
    # commands the reviewer confirmed were wrongly ALLOWED by a prior
    # version of architect_shell_policy (a write via `--output` and a
    # path escape via `--no-index`). Both must now be rejected, and must
    # be rejected for the SAME reason shell_policy itself rejects them
    # (proving delegation, not a second parallel guard that could drift).
    clobber_allowed, clobber_reason = architect_shell_policy("git diff --output CLOBBER.txt", ws)
    assert clobber_allowed is False, "git diff --output must be blocked in architect mode"
    assert clobber_reason == shell_policy("git diff --output CLOBBER.txt", ws)[1]

    escape_allowed, escape_reason = architect_shell_policy("git diff --no-index /etc/passwd /etc/hosts", ws)
    assert escape_allowed is False, "git diff --no-index must be blocked in architect mode"
    assert escape_reason == shell_policy("git diff --no-index /etc/passwd /etc/hosts", ws)[1]

    # Root cause (also affects engineer mode): `--output=X` (=-joined
    # form) must be blocked exactly like `--output X`, in BOTH policies.
    assert shell_policy("git diff --output=CLOBBER.txt", ws)[0] is False
    assert architect_shell_policy("git diff --output=CLOBBER.txt", ws)[0] is False

    # ------------------------------------------------------------
    # 1b. Fix round 1 (Important finding): run_architect must emit a
    #     lifecycle marker (real "agent_state_changed" EVENT_TYPES member,
    #     distinct state value) so architect activity is segmentable in
    #     events.jsonl. No live session dir needed — monkeypatch _emit
    #     to capture the call.
    # ------------------------------------------------------------
    captured = []
    real_emit_fn = globals()["_emit"]
    globals()["_emit"] = lambda event_type, **fields: captured.append((event_type, fields))
    try:
        _emit_architect_started()
    finally:
        globals()["_emit"] = real_emit_fn
    assert captured == [("agent_state_changed", {"state": "architect_planning"})], captured

    # ------------------------------------------------------------
    # 1c. Fix round 1 (Minor finding): the fallback plan's objective must
    #     be the real (short) task objective, not the whole multi-KB
    #     constructed architect prompt (contract JSON + repo map).
    # ------------------------------------------------------------
    fake_prompt = (
        "TASK CONTRACT (authoritative — sole source of scope/mode/constraints for this task):\n"
        '{"objective": "restore a session after reload", "scope": {"package": "repository"}}\n'
        "\n"
        "USER TASK:\n"
        "restore a session after reload\n"
        "\n"
        "MODE: implement\n"
        "SCOPE: package=repository\n"
        "\n"
        "TRUSTED REPOSITORY MAP:\n"
        + ("x" * 2000)  # stand-in for a large repo map — must NOT leak into the extracted objective
    )
    assert _extract_task_objective(fake_prompt) == "restore a session after reload"
    assert len(_extract_task_objective(fake_prompt)) < 100  # nowhere near the ~2KB+ full prompt

    # No "USER TASK:" marker (e.g. a standalone --mode architect
    # invocation not routed through glimmer-v2.py) -> bounded fallback,
    # never raises, never unbounded.
    assert _extract_task_objective("just do the thing") == "just do the thing"
    huge = "y" * 5000
    truncated = _extract_task_objective(huge)
    assert len(truncated) <= _TASK_OBJECTIVE_LIMIT + len("...(truncated)")
    assert truncated.endswith("...(truncated)")
    assert _extract_task_objective(None) == ""
    assert _extract_task_objective("") == ""

    # ------------------------------------------------------------
    # 1d. Fix round 1 (Minor finding): architect mode gets its own
    #     smaller default turn budget, engineer mode's is unchanged.
    # ------------------------------------------------------------
    assert ARCHITECT_MAX_TURNS_DEFAULT < ENGINEER_MAX_TURNS_DEFAULT
    assert ENGINEER_MAX_TURNS_DEFAULT == 32, "engineer mode's pre-C1 default must be unchanged"

    # ------------------------------------------------------------
    # 2. Valid model-shaped JSON: parses, validates, and writes
    #    architecture-plan.json with the right fields.
    # ------------------------------------------------------------
    real_events_path = GLIMMER_EVENTS_PATH
    real_session_id = GLIMMER_SESSION_ID

    try:
        with tempfile.TemporaryDirectory() as td:
            session_dir = Path(td)
            GLIMMER_EVENTS_PATH = str(session_dir / "events.jsonl")
            GLIMMER_SESSION_ID = "sess-architect-selfcheck"

            model_text = (
                "```json\n"
                + json.dumps(
                    {
                        "objective": "restore a session after reload",
                        "area": "role-room",
                        "packages": ["frontend", "server"],
                        "existingPatterns": [
                            {"name": "session hydration", "evidence": ["a.ts"]}
                        ],
                        "candidateFiles": [
                            {"path": "a.ts", "reason": "owns init", "confidence": 0.9}
                        ],
                        "constraints": ["reuse existing persistence"],
                        "implementationPlan": ["inspect hydration path", "implement hook"],
                        "verificationPlan": ["frontend_typecheck"],
                        "risk": "medium",
                        "expectedScope": {"minFiles": 1, "maxFiles": 4},
                        "uncertainties": [],
                    }
                )
                + "\n```"
            )

            parsed = _extract_json_object(model_text)
            ok, normalized = validate_architecture_plan(parsed)
            assert ok, f"valid model plan must validate, got: {normalized}"
            assert normalized["objective"] == "restore a session after reload"
            assert normalized["packages"] == ["frontend", "server"]
            assert normalized["risk"] == "medium"
            assert normalized["implementationPlan"] == ["inspect hydration path", "implement hook"]
            assert "planningFailed" not in normalized
            # Task 2.2 (V7 §5.12): "version" tolerates absence -- the model
            # never sends one (versioning is v2.py's job, stamped after this
            # validation step), so it must default to 1 for backward compat.
            assert normalized["version"] == 1
            ok_v2, normalized_v2 = validate_architecture_plan({**parsed, "version": 2})
            assert ok_v2 and normalized_v2["version"] == 2
            ok_bad_v, normalized_bad_v = validate_architecture_plan({**parsed, "version": "not-an-int"})
            assert ok_bad_v and normalized_bad_v["version"] == 1  # malformed -> default, never rejects the plan

            # Task 3.4: visualRequirements tolerates absence (-> []) and, when
            # present, is capped both by count and per-item length, with
            # non-string/blank junk dropped rather than passed through.
            assert normalized["visualRequirements"] == []
            oversized_requirements = [f"requirement {i}" for i in range(30)]
            oversized_requirements[0] = "x" * 500
            oversized_requirements.append(None)  # type: ignore[list-item]
            ok_vr, normalized_vr = validate_architecture_plan({**parsed, "visualRequirements": oversized_requirements})
            assert ok_vr
            assert len(normalized_vr["visualRequirements"]) == MAX_VISUAL_REQUIREMENTS
            assert len(normalized_vr["visualRequirements"][0]) == MAX_VISUAL_REQUIREMENT_CHARS
            ok_vr_bad, normalized_vr_bad = validate_architecture_plan({**parsed, "visualRequirements": "not a list"})
            assert ok_vr_bad and normalized_vr_bad["visualRequirements"] == []

            written_path = _write_architecture_plan_file(normalized)
            assert written_path is not None
            assert written_path.name == "architecture-plan.json"
            on_disk = json.loads(written_path.read_text(encoding="utf-8"))
            assert on_disk["objective"] == normalized["objective"]
            assert on_disk["risk"] == "medium"
            assert on_disk.get("planningFailed") is not True

            # --------------------------------------------------------
            # 3. Invalid/malformed response -> fallback file, not a crash.
            # --------------------------------------------------------
            for bad_text in (
                "not json at all",
                json.dumps({"objective": "x"}),  # missing packages/risk
                json.dumps({"packages": [], "risk": "medium"}),  # missing objective
                json.dumps({"objective": "x", "packages": [], "risk": "extreme"}),  # bad risk enum
            ):
                try:
                    parsed_bad = _extract_json_object(bad_text)
                    ok_bad, reason = validate_architecture_plan(parsed_bad)
                except ValueError:
                    ok_bad, reason = False, "unparseable"
                assert ok_bad is False, f"must reject: {bad_text!r}"

            fallback = _fallback_architecture_plan("original objective text", "model never produced valid JSON")
            assert fallback["planningFailed"] is True
            assert fallback["objective"] == "original objective text"
            assert fallback["risk"] in ARCHITECT_PLAN_RISK_VALUES
            for field in ARCHITECT_PLAN_OPTIONAL_ARRAY_FIELDS:
                assert fallback[field] == []
            assert fallback["visualRequirements"] == []

            written_fallback = _write_architecture_plan_file(fallback)
            assert written_fallback is not None
            on_disk_fallback = json.loads(written_fallback.read_text(encoding="utf-8"))
            assert on_disk_fallback["planningFailed"] is True
            assert on_disk_fallback["objective"] == "original objective text"
            # Same file identity as the success case above — glimmer-v2.py's
            # reader needs exactly one path/name, not two.
            assert written_fallback == written_path

            # No-op path: no session dir configured -> must not crash, must
            # not write anything.
            GLIMMER_EVENTS_PATH = None
            GLIMMER_SESSION_ID = None
            assert _write_architecture_plan_file(fallback) is None
    finally:
        GLIMMER_EVENTS_PATH = real_events_path
        GLIMMER_SESSION_ID = real_session_id

    print("architect mode self-check: PASS")


def _architect_review_selfcheck() -> None:
    """C2 (glimmer-v7): proves the pre-verification review's core
    invariants without a live llama-server. Run with:
    python3 glimmer-engineer.py --architect-review-selfcheck
    """
    import inspect
    import tempfile

    global GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID

    # ------------------------------------------------------------
    # 1. Critical safety property: review reuses the SAME mode="architect"
    #    execute_tool call site as planning — there is exactly one call
    #    site in run_architect's source, unconditionally passing
    #    mode="architect", so review cannot diverge from planning's
    #    read-only enforcement (ARCHITECT_TOOL_NAMES, the WRITE_TOOLS
    #    hard-block, architect_shell_policy) by construction.
    # ------------------------------------------------------------
    import ast

    architect_tree = ast.parse(inspect.getsource(run_architect))
    execute_tool_calls = [
        node
        for node in ast.walk(architect_tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "execute_tool"
    ]
    assert len(execute_tool_calls) == 1, (
        "run_architect must have exactly ONE execute_tool call site, "
        "shared by planning and review — two call sites could drift apart"
    )
    call_kwargs = {kw.arg: kw.value for kw in execute_tool_calls[0].keywords}
    assert isinstance(call_kwargs.get("mode"), ast.Constant) and call_kwargs["mode"].value == "architect", (
        "run_architect's one execute_tool call site must pass mode=\"architect\" unconditionally"
    )
    # main()'s --mode choices must still be exactly engineer/architect —
    # C2's review capability is a sub-mode of "architect", not a third
    # --mode value.
    assert 'choices=("engineer", "architect")' in inspect.getsource(main), (
        "C2 must not add a new --mode value; review is a sub-mode of architect"
    )

    # ------------------------------------------------------------
    # 2. Valid ArchitectReview JSON: parses, validates, arrays default
    #    empty when the model omits them.
    # ------------------------------------------------------------
    valid = {
        "decision": "APPROVED_WITH_CONDITIONS",
        "confidence": 0.91,
        "findings": ["reuses the existing persistence boundary"],
        "constraints": ["do not move persistence into component state"],
    }
    ok, normalized = validate_architect_review(valid)
    assert ok, normalized
    assert normalized["decision"] == "APPROVED_WITH_CONDITIONS"
    assert normalized["confidence"] == 0.91
    assert normalized["findings"] == ["reuses the existing persistence boundary"]
    assert normalized["requiredChanges"] == []
    assert normalized["verificationAdjustments"] == []

    # ------------------------------------------------------------
    # 3. Malformed/missing decision or confidence -> rejected; every
    #    real decision value in isolation validates.
    # ------------------------------------------------------------
    for bad in (
        {"confidence": 0.5},  # no decision
        {"decision": "MAYBE", "confidence": 0.5},  # bad enum
        {"decision": "APPROVED"},  # no confidence
        {"decision": "APPROVED", "confidence": "high"},  # wrong type
        {"decision": "APPROVED", "confidence": True},  # bool must not pass as number
        "not a dict",
    ):
        ok_bad, reason = validate_architect_review(bad)
        assert ok_bad is False, f"must reject: {bad!r}"

    for decision in ARCHITECT_REVIEW_DECISIONS:
        ok_d, norm_d = validate_architect_review({"decision": decision, "confidence": 0.5})
        assert ok_d, f"{decision} must validate on its own"
        assert norm_d["decision"] == decision

    # ------------------------------------------------------------
    # 4. Malformed model output -> reviewFailed fallback, never a crash;
    #    fallback decision is itself a real enum member (never acted on,
    #    but must stay schema-valid).
    # ------------------------------------------------------------
    fallback = _fallback_architect_review("model never produced valid JSON")
    assert fallback["reviewFailed"] is True
    assert fallback["decision"] in ARCHITECT_REVIEW_DECISIONS
    for field in ARCHITECT_REVIEW_ARRAY_FIELDS:
        assert fallback[field] == []

    # ------------------------------------------------------------
    # 5. Review-request file read failure (missing file) degrades to a
    #    fallback without ever reaching the model loop — exercised via
    #    _load_review_request directly (run_architect's own guard calls
    #    this before spending a single turn).
    # ------------------------------------------------------------
    missing, reason = _load_review_request("/nonexistent/review-request.json")
    assert missing is None
    assert reason is not None

    with tempfile.TemporaryDirectory() as td:
        bad_json_path = Path(td) / "bad.json"
        bad_json_path.write_text("not json{{{", encoding="utf-8")
        bad, bad_reason = _load_review_request(bad_json_path)
        assert bad is None and bad_reason is not None

        not_obj_path = Path(td) / "not_obj.json"
        not_obj_path.write_text("[1, 2, 3]", encoding="utf-8")
        not_obj, not_obj_reason = _load_review_request(not_obj_path)
        assert not_obj is None and not_obj_reason is not None

    # ------------------------------------------------------------
    # 6. File naming (architect-review-NN-MM.json), lifecycle emit, and
    #    a full write/read round trip.
    # ------------------------------------------------------------
    real_events_path = GLIMMER_EVENTS_PATH
    real_session_id = GLIMMER_SESSION_ID

    captured = []
    real_emit_fn = globals()["_emit"]
    globals()["_emit"] = lambda event_type, **fields: captured.append((event_type, fields))
    try:
        _emit_architect_review_started()
    finally:
        globals()["_emit"] = real_emit_fn
    assert captured == [("agent_state_changed", {"state": "architect_review"})], captured

    try:
        with tempfile.TemporaryDirectory() as td:
            session_dir = Path(td)
            GLIMMER_EVENTS_PATH = str(session_dir / "events.jsonl")
            GLIMMER_SESSION_ID = "sess-architect-review-selfcheck"

            written = _write_architect_review_file(normalized, 1, 2)
            assert written is not None
            assert written.name == "architect-review-01-02.json"
            on_disk = json.loads(written.read_text(encoding="utf-8"))
            assert on_disk["decision"] == "APPROVED_WITH_CONDITIONS"

            # No session dir configured -> must not crash, must not write.
            GLIMMER_EVENTS_PATH = None
            GLIMMER_SESSION_ID = None
            assert _write_architect_review_file(normalized, 1, 1) is None
    finally:
        GLIMMER_EVENTS_PATH = real_events_path
        GLIMMER_SESSION_ID = real_session_id

    # ------------------------------------------------------------
    # 7. _build_review_task_message never raises on a sparse/malformed
    #    review-request and includes the plan/diff/changed-files it IS
    #    given.
    # ------------------------------------------------------------
    msg = _build_review_task_message({
        "architecturePlan": {"risk": "medium"},
        "changedFiles": [{"path": "a.ts", "changeType": "modified"}],
        "diff": "--- a/a.ts\n+++ b/a.ts\n",
    })
    assert "a.ts" in msg and "medium" in msg and "--- a/a.ts" in msg
    assert "DERIVED TASK LIST" not in msg, "no taskList in the request -> no section, unchanged pre-Task-4.3 message"
    assert _build_review_task_message({}) is not None  # never raises on empty input

    # Task 4.3 ("Architect task-list review"): when glimmer-v2.py's
    # make_review_request carries a taskList (only on the session's first
    # review — see that function's docstring), it must show up in the
    # same review turn's message, not a second model call.
    msg_with_tasks = _build_review_task_message({
        "architecturePlan": {"risk": "low"},
        "changedFiles": [],
        "diff": "",
        "taskList": [
            {"id": "t1", "kind": "implementation", "priority": "required",
             "description": "Implement restoration hook", "dependsOn": []},
            {"id": "t2", "kind": "verification", "priority": "recommended",
             "description": "Run targeted tests", "dependsOn": ["t1"]},
        ],
    })
    assert "DERIVED TASK LIST" in msg_with_tasks
    assert "Implement restoration hook" in msg_with_tasks
    assert "depends on: t1" in msg_with_tasks
    # An empty/malformed taskList must degrade the same as its absence —
    # never an empty "(none)" section nobody asked for.
    assert "DERIVED TASK LIST" not in _build_review_task_message({"taskList": []})
    assert "DERIVED TASK LIST" not in _build_review_task_message({"taskList": "not a list"})

    # Review round 1 (Important 4): task-list observations must be steered
    # into findings/verificationAdjustments, and only REPLAN_REQUIRED may
    # be driven by a task-list problem — never a REVISE_IMPLEMENTATION
    # round burning budget over task-list prose.
    assert "findings" in msg_with_tasks and "verificationAdjustments" in msg_with_tasks
    assert "REPLAN_REQUIRED" in msg_with_tasks
    assert "requiredChanges" in msg_with_tasks and "NEVER" in msg_with_tasks

    # Review round 1 (Minor 8c): a large derived task list is capped, not
    # dumped verbatim into the prompt -- 50 tasks max, 300 chars per
    # description, with an honest "+N more" marker instead of silent
    # truncation.
    huge_task_list = [
        {"id": f"t{i}", "kind": "implementation", "priority": "required", "description": f"task {i}", "dependsOn": []}
        for i in range(60)
    ]
    capped_msg = _build_review_task_message({"taskList": huge_task_list})
    assert "t49" in capped_msg and "t50" not in capped_msg, "only the first 50 tasks are rendered"
    assert "+10 more tasks" in capped_msg

    long_desc_task = [{"id": "t1", "kind": "implementation", "priority": "required",
                        "description": "x" * 1000, "dependsOn": []}]
    long_desc_msg = _build_review_task_message({"taskList": long_desc_task})
    assert ("x" * 301) not in long_desc_msg, "description must be capped at 300 chars, not embedded whole"
    assert "…" in long_desc_msg

    print("architect review self-check: PASS")


def _delivery_review_selfcheck() -> None:
    """C6 (glimmer-v7): proves DeliveryReview's core invariants without a
    live llama-server. Run with:
    python3 glimmer-engineer.py --delivery-review-selfcheck
    """
    import inspect
    import tempfile

    global GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID, _evidence_seq
    global _known_delivery_review_evidence_ids

    # ------------------------------------------------------------
    # 1. run_delivery_review can only receive plain data — assert its
    #    signature has no parameter named/typed for workspace, manifest,
    #    or engineer state, so it is structurally unable to read or
    #    mutate anything session-outcome-relevant.
    # ------------------------------------------------------------
    params = set(inspect.signature(run_delivery_review).parameters)
    assert params == {"task", "ledger", "prose_report"}, (
        f"run_delivery_review must take only plain data, got: {params}"
    )

    # ------------------------------------------------------------
    # 2. Request-building genuinely omits tools — structural, not
    #    merely instructed.
    # ------------------------------------------------------------
    payload = _build_delivery_review_payload(
        "fix the thing", ["TOOL: read_file\nARGS: {}\nRESULT:\nok"], "All good."
    )
    assert "tools" not in payload, "delivery review turn must never offer tools"
    assert "functions" not in payload, "delivery review turn must never offer functions"
    assert "tool_choice" not in payload
    assert "parallel_tool_calls" not in payload

    # ------------------------------------------------------------
    # 3. Valid §23.7-shaped JSON parses, validates, and known
    #    evidenceIds survive while unknown ones are filtered out.
    # ------------------------------------------------------------
    known_ids = {"sess-abc-ev-1", "sess-abc-ev-2"}
    model_text = (
        "```json\n"
        + json.dumps(
            {
                "summary": "Restored session hydration via the existing service.",
                "approachRationale": ["Reused sessionPersistence; avoided a duplicate store."],
                "strengths": ["Small, targeted diff."],
                "concerns": [
                    {
                        "severity": "medium",
                        "category": "ux",
                        "description": "Recovery gives little feedback while restoring.",
                        "evidenceIds": ["sess-abc-ev-1", "sess-abc-ev-99"],
                    }
                ],
                "customerReadiness": "ready_with_known_limitations",
                "unresolvedItems": ["No loading indicator yet."],
                "intentionallyNotChanged": ["No API contract changes."],
                "nextSteps": [
                    {"priority": "recommended_next", "action": "Add a restoring state."}
                ],
                "confidence": {"level": "high", "reason": "Change is small and reviewed."},
            }
        )
        + "\n```"
    )
    parsed = _extract_json_object(model_text)
    ok, normalized = validate_delivery_review(parsed, known_ids)
    assert ok, f"valid model review must validate, got: {normalized}"
    assert normalized["summary"].startswith("Restored session")
    assert normalized["customerReadiness"] == "ready_with_known_limitations"
    assert normalized["confidence"] == {"level": "high", "reason": "Change is small and reviewed."}
    assert normalized["concerns"][0]["evidenceIds"] == ["sess-abc-ev-1"], (
        "known evidence id must survive"
    )
    assert normalized["filteredEvidenceIds"] == ["sess-abc-ev-99"], (
        "unknown/hallucinated evidence id must be filtered out, not persisted as real"
    )
    assert "reviewFailed" not in normalized

    # ------------------------------------------------------------
    # 3b. Malformed concern/nextStep sub-fields (fix round 1, Minor):
    #     unknown severity/category/priority coerce to a safe default;
    #     a concern with no real description, or a nextStep with no
    #     real action, is dropped rather than kept with fabricated
    #     content.
    # ------------------------------------------------------------
    ok_bad_sub, normalized_bad_sub = validate_delivery_review(
        {
            "summary": "x",
            "customerReadiness": "needs_polish",
            "confidence": {"level": "low", "reason": "r"},
            "concerns": [
                {"severity": "catastrophic", "category": "vibes", "description": "Real concern text."},
                {"severity": "high", "category": "security", "description": "   "},  # blank -> dropped
                {"severity": "high", "category": "security"},  # no description -> dropped
            ],
            "nextSteps": [
                {"priority": "asap!!", "action": "Do the thing."},
                {"priority": "recommended_next"},  # no action -> dropped
            ],
        },
        known_ids,
    )
    assert ok_bad_sub, f"malformed sub-fields must not reject the whole review, got: {normalized_bad_sub}"
    assert len(normalized_bad_sub["concerns"]) == 1, "concerns with no real description must be dropped"
    assert normalized_bad_sub["concerns"][0]["severity"] == "low", "unknown severity must coerce to 'low'"
    assert normalized_bad_sub["concerns"][0]["category"] == "functionality", "unknown category must coerce to 'functionality'"
    assert len(normalized_bad_sub["nextSteps"]) == 1, "nextSteps with no real action must be dropped"
    assert normalized_bad_sub["nextSteps"][0]["priority"] == "recommended_next", "unknown priority must coerce to 'recommended_next'"

    # ------------------------------------------------------------
    # 4. Invalid/malformed input -> reviewFailed fallback, not a crash.
    # ------------------------------------------------------------
    for bad_text in (
        "not json at all",
        json.dumps({"summary": "x"}),  # missing customerReadiness/confidence
        json.dumps({"customerReadiness": "ready_to_ship", "confidence": {"level": "high", "reason": "r"}}),  # missing summary
        json.dumps({"summary": "x", "customerReadiness": "extremely_ready", "confidence": {"level": "high", "reason": "r"}}),  # bad enum
        json.dumps({"summary": "x", "customerReadiness": "ready_to_ship", "confidence": {"level": "extreme", "reason": "r"}}),  # bad level
    ):
        try:
            parsed_bad = _extract_json_object(bad_text)
            ok_bad, _reason = validate_delivery_review(parsed_bad, known_ids)
        except ValueError:
            ok_bad = False
        assert ok_bad is False, f"must reject: {bad_text!r}"

    fallback = _fallback_delivery_review("model never produced valid JSON")
    assert fallback["reviewFailed"] is True
    assert fallback["customerReadiness"] in DELIVERY_REVIEW_READINESS_VALUES
    assert fallback["confidence"]["level"] in DELIVERY_REVIEW_CONFIDENCE_LEVELS
    for field in DELIVERY_REVIEW_ARRAY_FIELDS:
        assert fallback[field] == []

    # ------------------------------------------------------------
    # 5. File writing: success and fallback share one file identity;
    #    no-op path when no session dir is available.
    # ------------------------------------------------------------
    real_events_path = GLIMMER_EVENTS_PATH
    real_session_id = GLIMMER_SESSION_ID
    real_evidence_seq = _evidence_seq

    try:
        with tempfile.TemporaryDirectory() as td:
            session_dir = Path(td)
            GLIMMER_EVENTS_PATH = str(session_dir / "events.jsonl")
            GLIMMER_SESSION_ID = "sess-abc"
            _evidence_seq = 2

            assert _known_delivery_review_evidence_ids() == known_ids

            written = _write_delivery_review_file(normalized)
            assert written is not None
            assert written.name == "delivery-review.json"
            on_disk = json.loads(written.read_text(encoding="utf-8"))
            assert on_disk["customerReadiness"] == "ready_with_known_limitations"

            written_fallback = _write_delivery_review_file(fallback)
            assert written_fallback == written, (
                "success and fallback must share one file identity, same as "
                "architecture-plan.json's convention"
            )
            on_disk_fallback = json.loads(written_fallback.read_text(encoding="utf-8"))
            assert on_disk_fallback["reviewFailed"] is True

            GLIMMER_EVENTS_PATH = None
            GLIMMER_SESSION_ID = None
            assert _write_delivery_review_file(fallback) is None
    finally:
        GLIMMER_EVENTS_PATH = real_events_path
        GLIMMER_SESSION_ID = real_session_id
        _evidence_seq = real_evidence_seq

    # ------------------------------------------------------------
    # 6. Never-raises guarantee (fix round 1, Critical): the whole body
    #    of run_delivery_review is now inside its own try block,
    #    including the two calls that used to run BEFORE it
    #    (_known_delivery_review_evidence_ids / _build_delivery_review_
    #    payload). Prove it by making one of them raise and confirming
    #    run_delivery_review still returns normally and still writes
    #    the reviewFailed fallback file instead of propagating.
    # ------------------------------------------------------------
    real_known_ids_fn = _known_delivery_review_evidence_ids

    def _boom():
        raise RuntimeError("injected failure before the model call")

    try:
        with tempfile.TemporaryDirectory() as td:
            session_dir = Path(td)
            GLIMMER_EVENTS_PATH = str(session_dir / "events.jsonl")
            GLIMMER_SESSION_ID = "sess-boom"
            _known_delivery_review_evidence_ids = _boom

            try:
                run_delivery_review("task", [], "report")
            except Exception as exc:  # noqa: BLE001 - this IS the assertion
                assert False, f"run_delivery_review must never raise, got: {exc}"

            written = _delivery_review_file_path()
            assert written is not None and written.exists(), (
                "a pre-try failure must still land in the reviewFailed fallback file"
            )
            on_disk = json.loads(written.read_text(encoding="utf-8"))
            assert on_disk["reviewFailed"] is True
            assert "injected failure" in on_disk["reviewFailureReason"]
    finally:
        _known_delivery_review_evidence_ids = real_known_ids_fn
        GLIMMER_EVENTS_PATH = real_events_path
        GLIMMER_SESSION_ID = real_session_id

    print("delivery review self-check: PASS")


# ============================================================
# TOOL ARGUMENT PARSING
# ============================================================

def parse_arguments(raw):
    if isinstance(raw, dict):
        return raw

    if raw is None or raw == "":
        return {}

    try:
        return json.loads(raw)

    except json.JSONDecodeError as exc:
        raise ValueError(
            "Invalid tool arguments from model: "
            + str(raw)
        ) from exc


# ============================================================
# MODEL TOOL-RESULT COMPACTION
# ============================================================

def compact_tool_result_for_model(
    tool_name,
    result,
):
    """
    Keep the complete tool result in the execution ledger, but
    prevent very large search/read/shell outputs from bloating
    the model conversation.

    The model receives enough head/tail evidence to continue,
    while the orchestrator keeps the authoritative full result.
    """

    text = str(result)

    # Most normal tool responses pass through unchanged.
    if tool_name in {
        "grep_search",
        "file_glob_search",
    }:
        max_chars = 6000
    elif tool_name in {
        "read_file",
        "exec_shell_command",
    }:
        max_chars = 12000
    else:
        max_chars = 8000

    return _head_tail_cap(text, max_chars, "TOOL RESULT COMPACTED FOR MODEL CONTEXT")


# ============================================================
# CONTEXT TIERS (Task 5.1, V7 §7/§8)
# ============================================================

_TIER2_STUB_PREFIX = "[evidence "


def _tier1_stub(evidence_id):
    return f"{_TIER2_STUB_PREFIX}{evidence_id} — retrievable via get_evidence]"


def _tier1_chars(messages):
    """Sum of role=="tool" message content lengths currently live in the
    conversation -- Tier1 (V7 §7 "active evidence"). Tier0 (system+task)
    is measured separately (it's fixed per run, not per message)."""
    total = 0
    for msg in messages:
        if msg.get("role") == "tool":
            content = msg.get("content")
            if isinstance(content, str):
                total += len(content)
    return total


def _compact_tier1_to_tier2(messages, tool_evidence_by_call_id, budget_chars=None, protected_call_ids=None):
    """Task 5.1 (V7 §7/§8): when Tier1 (active tool-result history)
    exceeds its budget share, replace the OLDEST eligible tool-role
    messages with a one-line Tier2 stub -- but ONLY for a message whose
    tool call produced a persisted evidence id (tool_evidence_by_call_id),
    never for one that didn't (that content keeps exactly the truncation
    compact_tool_result_for_model already applied at append time; no new
    way to lose it is introduced here).

    Fix round 1 (MED, recency protection): `protected_call_ids` (e.g. the
    CURRENT turn's own tool_call_ids) are never stubbed regardless of
    budget -- a message the model just produced this turn must still be
    plainly readable on the very next turn, not already swapped for a
    retrieval pointer before the model has had a chance to reason over it.

    Caller contract (see run_engineer's call site): this must NOT be
    called at all while engineer_phase == "narrowed_to_edit_only" -- that
    phase's active_tools is {edit_file, write_file} only, so get_evidence
    isn't offered and a stub created there would be unrecoverable for the
    rest of the run. This function itself doesn't know the phase; the
    caller is the enforcement point.

    ponytail: recomputes _tier1_chars(messages) from scratch on every
    loop iteration (O(turns^2) over the whole run) -- turns per session
    are capped in the tens (ENGINEER_MAX_TURNS_DEFAULT-scale), so this is
    fine; revisit only if that budget ever grows by orders of magnitude.

    Returns the number of messages just replaced (0 when Tier1 is
    already under budget, or when every remaining eligible tool message
    lacks a persisted evidence id, is already a stub, or is protected).
    """
    limit = int((budget_chars if budget_chars is not None else CONTEXT_BUDGET_CHARS) * TIER1_BUDGET_PCT)
    protected = protected_call_ids or ()
    replaced = 0

    for msg in messages:
        if _tier1_chars(messages) <= limit:
            break
        if msg.get("role") != "tool":
            continue
        if msg.get("tool_call_id") in protected:
            continue
        content = msg.get("content")
        if not isinstance(content, str) or content.startswith(_TIER2_STUB_PREFIX):
            continue
        evidence_id = tool_evidence_by_call_id.get(msg.get("tool_call_id"))
        if not evidence_id:
            continue
        msg["content"] = _tier1_stub(evidence_id)
        replaced += 1

    return replaced


def _context_tiers_selfcheck() -> None:
    """Task 5.1: proves the tier1 char accounting, the stub-replacement-
    only-with-a-persisted-evidence-id rule, oldest-first ordering, and
    get_evidence's containment/cap behavior -- no live model or session
    needed. Run with:
    python3 glimmer-engineer.py --context-tiers-selfcheck
    """
    import tempfile

    global GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID, _evidence_seq

    real_events_path = GLIMMER_EVENTS_PATH
    real_session_id = GLIMMER_SESSION_ID
    real_evidence_seq = _evidence_seq

    try:
        # ------------------------------------------------------------
        # 1. _tier1_chars: only role=="tool" content counts.
        # ------------------------------------------------------------
        messages = [
            {"role": "system", "content": "x" * 1000},
            {"role": "user", "content": "y" * 1000},
            {"role": "assistant", "content": "z" * 1000},
            {"role": "tool", "tool_call_id": "c1", "content": "a" * 100},
            {"role": "tool", "tool_call_id": "c2", "content": "b" * 200},
        ]
        assert _tier1_chars(messages) == 300, "only tool-role content contributes to Tier1"

        # ------------------------------------------------------------
        # 2. Compaction is a no-op when under budget.
        # ------------------------------------------------------------
        assert _compact_tier1_to_tier2(messages, {"c1": "ev-1", "c2": "ev-2"}, budget_chars=100_000) == 0
        assert messages[3]["content"] == "a" * 100

        # ------------------------------------------------------------
        # 3. Over budget: oldest eligible tool message gets stubbed
        #    first; a message with NO persisted evidence id is skipped
        #    (its raw content survives untouched) even though it's
        #    older; stubbing stops as soon as back under budget.
        # ------------------------------------------------------------
        over = [
            {"role": "tool", "tool_call_id": "no-ev", "content": "n" * 500},  # oldest, no evidence id
            {"role": "tool", "tool_call_id": "c1", "content": "a" * 500},
            {"role": "tool", "tool_call_id": "c2", "content": "b" * 500},
        ]
        replaced = _compact_tier1_to_tier2(over, {"c1": "sess-ev-1", "c2": "sess-ev-2"}, budget_chars=1000)
        # budget_chars=1000 * TIER1_BUDGET_PCT(0.60) = 600; starting at 1500
        # chars, stubbing c1 (the oldest WITH an evidence id) drops it to
        # ~1000+len(stub), still over 600, so c2 must also be stubbed.
        assert replaced == 2, f"expected both eligible messages stubbed, got {replaced}"
        assert over[0]["content"] == "n" * 500, "no-evidence-id message must never be stubbed"
        assert over[1]["content"] == _tier1_stub("sess-ev-1")
        assert over[2]["content"] == _tier1_stub("sess-ev-2")

        # A second call is idempotent (already-stubbed messages are skipped).
        assert _compact_tier1_to_tier2(over, {"c1": "sess-ev-1", "c2": "sess-ev-2"}, budget_chars=1000) == 0

        # ------------------------------------------------------------
        # 4. get_evidence containment/caps: found, not-found, no-session-
        #    dir, and content capped at MAX_EVIDENCE_RESULT.
        # ------------------------------------------------------------
        with tempfile.TemporaryDirectory() as td:
            session_dir = Path(td)
            (session_dir / "events.jsonl").write_text("")
            (session_dir / "prompt-00.txt").write_text("iteration 0")

            GLIMMER_EVENTS_PATH = str(session_dir / "events.jsonl")
            GLIMMER_SESSION_ID = "sess-tiers"
            _evidence_file_path.cache_clear()
            _evidence_seq = 0

            ledger = []
            big_content = "z" * (MAX_EVIDENCE_RESULT + 500)
            evidence_id = add_evidence(ledger, "read_file", {"path": "a.py"}, big_content)
            assert evidence_id is not None

            found = _find_evidence_by_id(evidence_id)
            # Fix round 1 (HIGH): head+tail cap, matching compact_tool_
            # result_for_model's shape -- not the old head-only slice,
            # which silently dropped the tail a Tier1 message the model
            # had already seen this turn would still have carried.
            expected_capped = _head_tail_cap(big_content, MAX_EVIDENCE_RESULT, "EVIDENCE COMPACTED")
            assert found == expected_capped, "get_evidence must return the head+tail-capped content"
            assert found.endswith("z" * 1960), "tail must be preserved, not silently dropped"

            missing = _find_evidence_by_id("sess-tiers-ev-999")
            assert missing.startswith("EVIDENCE_NOT_FOUND")

            _execute_semantic_tool_result = _execute_semantic_tool(
                "get_evidence", {"id": evidence_id}, session_dir,
            )
            assert _execute_semantic_tool_result == {"plain_text_response": found}

            # ------------------------------------------------------------
            # 4b. Fix round 1 (MED): get_evidence must never self-amplify
            #     the evidence store/index -- a retrieval is not a new
            #     observation.
            # ------------------------------------------------------------
            idx_path_before = _evidence_index_file_path()
            entries_before = json.loads(idx_path_before.read_text(encoding="utf-8"))
            ledger_ge = []
            result_ge = add_evidence(ledger_ge, "get_evidence", {"id": evidence_id}, found)
            assert result_ge is None, "get_evidence must never be assigned a NEW evidence id"
            assert ledger_ge == [], "get_evidence must never append to the ledger"
            entries_after = json.loads(idx_path_before.read_text(encoding="utf-8"))
            assert entries_after == entries_before, "get_evidence must never add an evidence-index.json entry"

            GLIMMER_EVENTS_PATH = None
            GLIMMER_SESSION_ID = None
            _evidence_file_path.cache_clear()
            assert _find_evidence_by_id("anything").startswith("EVIDENCE_NOT_FOUND"), (
                "no session dir must degrade to a not-found string, never raise"
            )

        # ------------------------------------------------------------
        # 5. Fix round 1 (MED, recency protection): protected_call_ids
        #    are never stubbed regardless of budget.
        # ------------------------------------------------------------
        protect_case = [
            {"role": "tool", "tool_call_id": "old1", "content": "o" * 500},
            {"role": "tool", "tool_call_id": "new1", "content": "n" * 500},
        ]
        replaced_protected = _compact_tier1_to_tier2(
            protect_case, {"old1": "sess-ev-1", "new1": "sess-ev-2"},
            budget_chars=100, protected_call_ids={"new1"},
        )
        assert replaced_protected == 1, "only the unprotected message may be stubbed"
        assert protect_case[0]["content"] == _tier1_stub("sess-ev-1")
        assert protect_case[1]["content"] == "n" * 500, (
            "a protected (this-turn) call id must never be stubbed even far over budget"
        )

        # ------------------------------------------------------------
        # 6. Fix round 1 (HIGH): structural proof that compaction is
        #    gated on engineer_phase -- narrowed_to_edit_only offers
        #    get_evidence to no one (active_tools == {edit_file,
        #    write_file} there, per the router above it), so a stub
        #    created in that phase would be permanently unrecoverable
        #    for the rest of the run.
        # ------------------------------------------------------------
        import inspect
        engineer_source = inspect.getsource(run_engineer)
        assert (
            '        if engineer_phase != "narrowed_to_edit_only":\n'
            '            _newly_compacted = _compact_tier1_to_tier2(\n'
            '                messages, tool_evidence_by_call_id,\n'
            '                protected_call_ids={c["id"] for c in tool_calls},\n'
            '            )\n'
        ) in engineer_source, (
            "compaction must be structurally gated on "
            "engineer_phase != narrowed_to_edit_only, with this turn's "
            "own call ids protected"
        )

        # ------------------------------------------------------------
        # 7. Fix round 1 (MED): get_evidence is structurally exempted
        #    from both discovery_calls/post_gate_inspection_calls budget
        #    increments (context recovery, not new exploration).
        # ------------------------------------------------------------
        assert (
            "                and tool_name in discovery_tools\n"
            '                and tool_name != "get_evidence"\n'
        ) in engineer_source
        assert (
            "                and tool_name in post_gate_inspection_tools\n"
            '                and tool_name != "get_evidence"\n'
        ) in engineer_source

    finally:
        GLIMMER_EVENTS_PATH = real_events_path
        GLIMMER_SESSION_ID = real_session_id
        _evidence_file_path.cache_clear()
        _evidence_seq = real_evidence_seq

    print("context tiers self-check: PASS")


def _evidence_index_selfcheck() -> None:
    """Task 5.2: proves evidence-index.json's incremental build (id, kind,
    toolCall, path, relatesTo), the file->test and failure->file edge
    extraction, malformed-file tolerance, and the delivery-review known-
    ids union. No live model or session needed. Run with:
    python3 glimmer-engineer.py --evidence-index-selfcheck
    """
    import tempfile

    global GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID, _evidence_seq

    real_events_path = GLIMMER_EVENTS_PATH
    real_session_id = GLIMMER_SESSION_ID
    real_evidence_seq = _evidence_seq

    try:
        # ------------------------------------------------------------
        # 1. Deterministic edge extraction helpers.
        # ------------------------------------------------------------
        found_text = "Found 2 likely test file(s) for 'widget.ts':\nsrc/widget.test.ts\nsrc/widget.spec.ts"
        assert _extract_test_paths_from_related_tests_result(found_text) == [
            "src/widget.test.ts", "src/widget.spec.ts",
        ]
        assert _extract_test_paths_from_related_tests_result("No related test files found for 'x'.") == []

        # Fix round 1 (LOW): failure_text now ends with exec_shell_
        # command's OWN real "[exit code: N]" marker (llama.cpp/tools/
        # server/server-tools.cpp always appends exactly this) -- the
        # deterministic exit-status signal _shell_exit_code parses,
        # rather than sniffing for words like "error"/"fail".
        failure_text = (
            "src/foo.ts:12:3 - error TS2322: Type mismatch\n"
            "src/bar.ts:5:1 - error TS2304: not found\n[exit code: 2]"
        )
        assert _extract_failure_file_paths(failure_text) == ["src/foo.ts", "src/bar.ts"]
        assert _extract_failure_file_paths("all tests passed, 0 failures") == []

        assert _shell_exit_code(failure_text) == 2
        assert _shell_exit_code("no output at all") is None, "text with no marker must degrade to None, never raise"
        assert _shell_exit_code("some output\n[exit code: 0]") == 0
        assert _shell_exit_code("timed out\n[exit code: -1] [exit due to timed out]") == -1

        # ------------------------------------------------------------
        # 2. Incremental build: read_file (kind=file, path), find_related_
        #    tests (kind=test-search, relatesTo test edges), a failing
        #    exec_shell_command (kind reclassified to "failure",
        #    relatesTo file edges).
        # ------------------------------------------------------------
        with tempfile.TemporaryDirectory() as td:
            session_dir = Path(td)
            (session_dir / "events.jsonl").write_text("")
            (session_dir / "prompt-00.txt").write_text("iteration 0")

            GLIMMER_EVENTS_PATH = str(session_dir / "events.jsonl")
            GLIMMER_SESSION_ID = "sess-idx"
            _evidence_file_path.cache_clear()
            _evidence_seq = 0

            ledger = []
            id1 = add_evidence(ledger, "read_file", {"path": "src/widget.ts"}, "export function widget() {}")
            id2 = add_evidence(ledger, "find_related_tests", {"path": "src/widget.ts"}, found_text)
            id3 = add_evidence(ledger, "exec_shell_command", {"command": "npm run typecheck"}, failure_text)
            # Uninteresting tool: no evidence id, no index entry.
            add_evidence(ledger, "get_datetime", {}, "2026-01-01")

            idx_path = _evidence_index_file_path()
            assert idx_path.exists()
            entries = json.loads(idx_path.read_text(encoding="utf-8"))
            by_id = {e["id"]: e for e in entries}

            assert by_id[id1]["kind"] == "file"
            assert by_id[id1]["path"] == "src/widget.ts"
            assert by_id[id1]["toolCall"] == "read_file"
            assert "relatesTo" not in by_id[id1]

            assert by_id[id2]["kind"] == "test-search"
            assert by_id[id2]["relatesTo"] == [
                {"path": "src/widget.test.ts", "kind": "test"},
                {"path": "src/widget.spec.ts", "kind": "test"},
            ]

            assert by_id[id3]["kind"] == "failure", "a failing shell command must be reclassified"
            assert by_id[id3]["relatesTo"] == [
                {"path": "src/foo.ts", "kind": "file"},
                {"path": "src/bar.ts", "kind": "file"},
            ]

            # ------------------------------------------------------------
            # 2b. Fix round 1 (LOW): gate on the REAL exit status, not
            #     prose -- a successful (exit code 0) command whose
            #     output happens to contain error-shaped "path:line" text
            #     (e.g. grep matching the word "error" in a filename)
            #     must NOT be reclassified to "failure".
            # ------------------------------------------------------------
            clean_but_error_shaped_text = (
                "src/errors.ts:1:1 - grep matched the word error here\n[exit code: 0]"
            )
            id_clean = add_evidence(
                ledger, "exec_shell_command", {"command": "grep -rn error src"},
                clean_but_error_shaped_text,
            )
            entries_after_clean = json.loads(idx_path.read_text(encoding="utf-8"))
            by_id_after_clean = {e["id"]: e for e in entries_after_clean}
            assert by_id_after_clean[id_clean]["kind"] == "shell", (
                "exit code 0 must never be reclassified to 'failure' just because "
                "the output text LOOKS failure-shaped"
            )
            assert "relatesTo" not in by_id_after_clean[id_clean]

            # ------------------------------------------------------------
            # 3. Malformed existing index file: tolerated, not fatal --
            #    the next append still succeeds (starts a fresh list).
            # ------------------------------------------------------------
            idx_path.write_text("not json at all {{{")
            id4 = add_evidence(ledger, "grep_search", {"pattern": "foo"}, "a.py:1:foo")
            assert id4 is not None
            entries2 = json.loads(idx_path.read_text(encoding="utf-8"))
            assert len(entries2) == 1 and entries2[0]["id"] == id4, (
                "corrupt index file must be tolerated (reset), never crash evidence recording"
            )

            # ------------------------------------------------------------
            # 4. Delivery-review known-ids union: an id from an EARLIER
            #    iteration's evidence-index.json (not reachable via THIS
            #    process's _evidence_seq range) must still be accepted.
            # ------------------------------------------------------------
            _evidence_seq = 0  # simulate a fresh iteration with no local ids yet
            known = _known_delivery_review_evidence_ids()
            assert id4 in known, "ids present in evidence-index.json must be additively accepted"

    finally:
        GLIMMER_EVENTS_PATH = real_events_path
        GLIMMER_SESSION_ID = real_session_id
        _evidence_file_path.cache_clear()
        _evidence_seq = real_evidence_seq

    print("evidence index self-check: PASS")


# ============================================================
# PEG RETRY
# ============================================================

def chat_with_retry(
    payload,
    attempts=3,
):
    """
    Call llama-server with adaptive PEG recovery.

    Attempt 1:
        Preserve the normal model reasoning configuration.

    Attempts 2+ after a peg-native parser failure:
        Disable model thinking for tool-bearing turns so the
        model produces a simpler structured tool-call response.

    If parsing still fails after all attempts, the caller's
    deterministic fail-closed fallback handles the failure.
    """

    last_error = None

    base_payload = dict(payload)

    if "tools" in base_payload:
        base_payload[
            "parallel_tool_calls"
        ] = False

    for attempt in range(
        1,
        attempts + 1,
    ):
        request_payload = dict(
            base_payload
        )

        # ----------------------------------------------------
        # PEG RECOVERY MODE
        # ----------------------------------------------------
        #
        # Keep normal reasoning on the first attempt.
        #
        # If llama.cpp fails to parse the generated native
        # tool call, retry the SAME turn with thinking disabled.
        # This reduces the chance that reasoning text becomes
        # interleaved with the structured tool-call grammar.
        #
        # This applies only to tool-bearing requests.
        # Every new agent turn starts in normal mode again.
        # ----------------------------------------------------

        peg_recovery_mode = (
            attempt > 1
        )

        if peg_recovery_mode:
            request_payload[
                "reasoning_effort"
            ] = "none"

            template_kwargs = dict(
                request_payload.get(
                    "chat_template_kwargs"
                )
                or {}
            )

            template_kwargs[
                "enable_thinking"
            ] = False

            request_payload[
                "chat_template_kwargs"
            ] = template_kwargs

        debug_path = None

        try:
            if os.environ.get("GLIMMER_DEBUG_PEG_PAYLOAD") == "1":
                debug_dir = (
                    Path.home()
                    / ".muse-glimmer"
                    / "debug"
                )
                debug_dir.mkdir(
                    parents=True,
                    exist_ok=True,
                )

                import time

                debug_path = (
                    debug_dir
                    / (
                        f"peg-payload-{os.getpid()}-"
                        f"{time.time_ns()}-"
                        f"attempt-{attempt}.json"
                    )
                )

                debug_path.write_text(
                    json.dumps(
                        request_payload,
                        indent=2,
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )

                print(
                    f"[PEG DEBUG] payload: {debug_path}"
                )

            return http_json(
                "POST",
                "/v1/chat/completions",
                request_payload,
            )

        except RuntimeError as exc:
            if (
                "peg-native"
                not in str(exc)
            ):
                raise

            last_error = exc

            print()
            print(
                "⚠ PEG parser failure "
                f"({attempt}/{attempts})"
            )

            _emit(
                "parser_recovery",
                attempt=attempt,
                payloadPath=str(debug_path) if debug_path else "",
            )

            if attempt < attempts:
                strategy = (
                    "tool_safe_reasoning_off"
                    if "tools" in base_payload
                    else "same_turn"
                )
                _emit(
                    "model_retry",
                    attempt=attempt + 1,
                    strategy=strategy,
                )
                if "tools" in base_payload:
                    print(
                        "Retrying same turn with "
                        "tool-safe reasoning OFF..."
                    )
                else:
                    print(
                        "Retrying same turn..."
                    )

    raise last_error


# ============================================================
# FALLBACK SYNTHESIS
# ============================================================

def final_synthesis(
    original_task,
    ledger,
    changed_paths,
):
    """
    Deterministic emergency fallback.

    This path is used only after repeated PEG/chat-parser failure.

    SECURITY / RELIABILITY RULE:
    No model request is made here.
    No tools are requested here.
    No additional reasoning is performed here.

    The report is built only from evidence already captured by
    the engineering orchestrator.
    """

    try:
        evidence = compact_evidence(ledger)
    except Exception as exc:
        evidence = (
            "Could not compact execution ledger: "
            f"{type(exc).__name__}: {exc}"
        )

    if changed_paths:
        changed = "\n".join(
            f"- {path}"
            for path in sorted(
                str(path)
                for path in changed_paths
            )
        )
    else:
        changed = "- None recorded by the orchestrator."

    # Keep emergency reports bounded.
    max_evidence_chars = 12000

    if len(evidence) > max_evidence_chars:
        evidence = (
            evidence[:max_evidence_chars]
            + "\n\n[Evidence truncated by deterministic fallback.]"
        )

    report = (
        "## Summary\n\n"
        "The normal Glimmer response could not be parsed after "
        "repeated PEG-native parser failures. Engineering execution "
        "was stopped and this emergency report was generated "
        "deterministically from the already captured execution ledger. "
        "No additional model call was made.\n\n"

        "## Changes Made\n\n"
        f"{changed}\n\n"

        "## Verification\n\n"
        "The following evidence was captured before the parser failure. "
        "Treat it as execution evidence, not as a new model conclusion.\n\n"
        "```text\n"
        f"{evidence}\n"
        "```\n\n"

        "## Remaining Risk\n\n"
        "The requested engineering task may be incomplete because the "
        "model response parser failed before a normal completion. "
        "Do not infer that an intended edit or validation succeeded "
        "unless it is explicitly present in the execution evidence above."
    )

    # Return the same response shape as chat-completions so the
    # existing caller can handle this without another model request.
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": report,
                },
                "finish_reason": "stop",
            }
        ]
    }



# ============================================================
# FINAL LOCAL POST-FLIGHT
# ============================================================

def postflight(workspace):
    print()
    print(
        "════════════════════════════════════"
    )
    print("LOCAL POST-FLIGHT")
    print(
        "════════════════════════════════════"
    )

    status = git_local(
        workspace,
        "status",
        "--short",
    )

    print()
    print("git status --short")
    print(
        status
        or "(clean working tree)"
    )

    diff_stat = git_local(
        workspace,
        "diff",
        "--stat",
    )

    print()
    print("git diff --stat")
    print(
        diff_stat
        or "(no tracked diff)"
    )

    result = subprocess.run(
        [
            "git",
            "diff",
            "--check",
        ],
        cwd=workspace,
        text=True,
        capture_output=True,
    )

    print()

    if result.returncode == 0:
        print(
            "git diff --check: PASS"
        )
    else:
        print(
            "git diff --check: FAIL"
        )
        print(result.stdout)
        print(result.stderr)


# ============================================================
# ARCHITECT MODE (C1, glimmer-v7)
# ============================================================
#
# Opt-in only (glimmer-v2.py's --architect-first flag; never auto-
# triggered — see the reconciliation doc's C1 entry and §12 risk 2).
# Read-only: see ARCHITECT_TOOL_NAMES / architect_shell_policy above and
# the mode == "architect" gate in execute_tool. No approval path: run_
# architect below always passes approve_all=True regardless of caller,
# since it runs unattended as a subprocess with no interactive stdin.
# Output is architecture-plan.json (V7 §5.3 shape), not a prose report.

ARCHITECT_PLAN_RISK_VALUES = {
    "low",
    "medium",
    "high",
    "critical",
}

# V7 §5.3's optional array fields — always present in the written plan,
# defaulted to empty when the model omits them (spec: "don't be overly
# strict — a plan with some empty optional fields is still useful").
ARCHITECT_PLAN_OPTIONAL_ARRAY_FIELDS = (
    "existingPatterns",
    "candidateFiles",
    "constraints",
    "implementationPlan",
    "verificationPlan",
    "uncertainties",
)

# Task 3.4: visualRequirements is validated separately (see
# validate_architecture_plan) because it feeds the visual verification
# contract file rather than just prompt text, so it gets a count + per-item
# length cap the fields above don't have.
MAX_VISUAL_REQUIREMENTS = 20
MAX_VISUAL_REQUIREMENT_CHARS = 300

ARCHITECT_SYSTEM_PROMPT = (
    "Reasoning strength: high. "
    "You are Glimmer Architect: a read-only architecture-planning agent "
    "operating inside one git repository, one step before an engineer "
    "implements anything.\n\n"

    "You have NO write access. write_file and edit_file are not offered "
    "to you in this mode, and any attempt to call them is rejected "
    "before it can touch the filesystem. Your exec_shell_command access "
    "is restricted to read-only git commands only "
    "(git status, git diff, git show, git log, git rev-parse). You "
    "cannot install dependencies, run tests or builds, commit, push, or "
    "deploy.\n\n"

    "Your job, in order: understand the requested outcome; inspect the "
    "actual repository (not assumptions) before making any repository-"
    "specific claim; identify the relevant package, domain, subsystem, "
    "and ownership boundaries; locate existing patterns and reusable "
    "components, services, utilities, state stores, APIs, and schemas "
    "that already solve part of the problem; find likely candidate "
    "files and symbols; identify related tests and verification paths; "
    "identify architectural constraints; note likely cross-system "
    "consequences; estimate risk and expected scope; produce an "
    "implementation sequence and a verification strategy. Optimize for "
    "reuse before invention: do not propose a new store, service, "
    "abstraction, dependency, API, database object, or framework until "
    "you have checked whether an appropriate mechanism already exists. "
    "Record uncertainties instead of inventing missing facts.\n\n"

    "When you are done exploring, your FINAL answer must be exactly one "
    "JSON object and nothing else — no prose before or after it, no "
    "markdown code fence — matching this shape:\n\n"
    "{\n"
    '  "objective": "restated task objective (string, REQUIRED)",\n'
    '  "area": "sub-path/domain within the repo (string, optional)",\n'
    '  "packages": ["frontend", "backend", "..."],\n'
    '  "existingPatterns": [\n'
    '    {"name": "pattern name", "evidence": ["path/to/file.ts"]}\n'
    "  ],\n"
    '  "candidateFiles": [\n'
    '    {"path": "path/to/file.ts", "reason": "why", "confidence": 0.9}\n'
    "  ],\n"
    '  "constraints": ["reuse existing X", "avoid a second Y"],\n'
    '  "implementationPlan": ["step 1", "step 2"],\n'
    '  "verificationPlan": ["typecheck", "targeted_unit_tests"],\n'
    '  "risk": "low|medium|high|critical (REQUIRED)",\n'
    '  "expectedScope": {"minFiles": 1, "maxFiles": 4},\n'
    '  "uncertainties": ["anything you could not confirm"]\n'
    "}\n\n"
    "objective, packages, and risk are REQUIRED. Every other field must "
    "still be present, but may be an empty array/object if you have "
    "nothing to report for it — never omit a key."
)


def _architecture_plan_file_path():
    """C1 (glimmer-v7): same session-dir-derivation convention C5's
    _evidence_file_path() above already uses — the parent of
    GLIMMER_EVENTS_PATH — so this is not a third way of locating the
    session directory. Unlike evidence-NN.jsonl, this file is NOT
    iteration-numbered: exactly one architecture-plan.json exists per
    session, written once by the (at most one) architect run that
    precedes iteration 0. Returns None when no session dir is available
    (standalone invocation), matching every other _emit()/evidence-style
    no-op guarantee in this file.
    """
    if not GLIMMER_EVENTS_PATH or not GLIMMER_SESSION_ID:
        return None

    return Path(GLIMMER_EVENTS_PATH).parent / "architecture-plan.json"


def _fallback_architecture_plan(objective, reason):
    """Minimal, always-valid-JSON degradation target (see module docstring
    above run_architect). Deliberately the SAME SHAPE as a successful
    plan (same keys, "planningFailed" only ADDED, never a different
    schema) so glimmer-v2.py's reader needs exactly one code path: parse
    the file, check "planningFailed", and either use it or don't.
    """
    plan = {
        "objective": objective or "",
        "packages": [],
        "risk": "medium",
        "planningFailed": True,
        "planningFailureReason": reason,
    }

    for field in ARCHITECT_PLAN_OPTIONAL_ARRAY_FIELDS:
        plan[field] = []
    plan["visualRequirements"] = []  # same shape as a successful plan (see validate_architecture_plan)

    return plan


_TASK_OBJECTIVE_LIMIT = 500


def _extract_task_objective(task_text):
    """C1 fix round 1 (Minor finding): `task` as received by run_architect
    is the FULL constructed architect prompt (glimmer-v2.py's
    make_architect_prompt: the whole TASK CONTRACT json blob + up to
    ~12KB repo map, not just the objective) — using it verbatim as a
    fallback plan's "objective" field made that field multi-KB and
    useless as a summary. make_architect_prompt always embeds the real
    objective verbatim as "USER TASK:\\n<objective>\\n\\nMODE: ...", so
    extract just that line. Falls back to a bounded prefix of the raw
    text when the marker isn't found (e.g. a standalone --mode architect
    invocation that didn't go through glimmer-v2.py) — never raises,
    same "always produce something usable" spirit as the rest of this
    file's fallback paths.
    """
    match = re.search(r"USER TASK:\s*\n(.*?)\n\s*\n", task_text or "", re.DOTALL)
    objective = match.group(1).strip() if match else (task_text or "").strip()

    if len(objective) > _TASK_OBJECTIVE_LIMIT:
        objective = objective[:_TASK_OBJECTIVE_LIMIT] + "...(truncated)"

    return objective


def _write_architecture_plan_file(output):
    """Write architecture-plan.json (whether a real plan or the fallback
    marker) to the session dir. Never raises: a write failure here must
    degrade the same way a planning failure does (log and move on), not
    take down the architect subprocess. Returns the path written, or
    None when no session dir is available (standalone invocation) or the
    write failed.
    """
    path = _architecture_plan_file_path()

    if path is None:
        print(
            "[glimmer-engineer] no session dir available (standalone "
            "invocation); architecture-plan.json not written."
        )
        return None

    try:
        path.write_text(
            json.dumps(output, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        print(f"Wrote: {path}")
        return path
    except OSError as exc:
        print(f"[glimmer-engineer] failed to write architecture-plan.json: {exc}")
        return None


def validate_architecture_plan(data):
    """Validate a parsed JSON object against V7 §5.3's ArchitecturePlan
    shape. Minimum bar (per the C1 task scoping): objective (string),
    packages (array), risk (low/medium/high/critical) must be present
    and well-typed — everything else is filled in with an empty
    default when missing/malformed rather than rejected, since a plan
    with some empty optional fields is still useful evidence for
    make_prompt.

    Returns (True, normalized_plan_dict) or (False, reason_string).
    """
    if not isinstance(data, dict):
        return False, "response is not a JSON object"

    objective = data.get("objective")
    if not isinstance(objective, str) or not objective.strip():
        return False, "missing/invalid 'objective' (must be a non-empty string)"

    packages = data.get("packages")
    if not isinstance(packages, list):
        return False, "missing/invalid 'packages' (must be an array)"

    risk = data.get("risk")
    if risk not in ARCHITECT_PLAN_RISK_VALUES:
        return False, (
            "missing/invalid 'risk' (must be one of: "
            + ", ".join(sorted(ARCHITECT_PLAN_RISK_VALUES))
            + ")"
        )

    normalized = {
        "objective": objective,
        "packages": packages,
        "risk": risk,
    }

    area = data.get("area")
    if isinstance(area, str):
        normalized["area"] = area

    for field in ARCHITECT_PLAN_OPTIONAL_ARRAY_FIELDS:
        value = data.get(field, [])
        normalized[field] = value if isinstance(value, list) else []

    # Task 3.4 (V7 §22.10/22.18): visualRequirements -- UI-affecting
    # requirements the architect flags, which flow into the visual
    # verification contract (Task 3.3). Unlike ARCHITECT_PLAN_OPTIONAL_
    # ARRAY_FIELDS above (passed through as-is), this list feeds an
    # automation contract file, not just prompt text, so it gets the
    # stricter per-item tolerant-but-honest treatment _coerce_finding uses
    # elsewhere: non-string/blank entries are dropped rather than passed
    # through, and the whole list is capped (count + per-item length) so
    # one runaway model response can't blow up the contract file. Absent
    # entirely -> [], same convention as every other optional array field.
    visual_requirements_raw = data.get("visualRequirements", [])
    visual_requirements = []
    if isinstance(visual_requirements_raw, list):
        for item in visual_requirements_raw[:MAX_VISUAL_REQUIREMENTS]:
            if isinstance(item, str) and item.strip():
                visual_requirements.append(item.strip()[:MAX_VISUAL_REQUIREMENT_CHARS])
    normalized["visualRequirements"] = visual_requirements

    expected_scope = data.get("expectedScope")
    if isinstance(expected_scope, dict):
        normalized["expectedScope"] = expected_scope

    # Task 2.2 (V7 §5.12): plan versioning is owned by glimmer-v2.py (the
    # trusted layer) -- it stamps the real version number onto the plan
    # dict AFTER this validation step (run_architect_first/run_architect_
    # replan), not the model. This is tolerant-but-honest passthrough only:
    # absent or malformed "version" defaults to 1 (backward compat with
    # every plan produced before this field existed) rather than rejecting
    # the whole plan over one cosmetic field.
    version = data.get("version", 1)
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        version = 1
    normalized["version"] = version

    return True, normalized


def _load_architecture_plan_for_engineer():
    """Task 2.4 (V7 §5.5 second half): run_engineer's own read of
    architecture-plan.json, independent of glimmer-v2.py's prompt-text
    embedding (make_prompt) -- this process reads the file directly off
    disk (same _architecture_plan_file_path() convention as the writer
    side above) so the deterministic mid-implementation triggers and
    consult_architect have the REAL candidateFiles/expectedScope, not
    just the prose the model happened to receive in its prompt.

    Returns None whenever there is nothing usable to trigger/consult
    against: no session dir, no file, unreadable/malformed JSON, or a
    planningFailed fallback plan (the fallback's own arrays are always
    empty, so it could never legitimately fire a-file-count/candidate-
    scope trigger anyway -- treating it as "no plan" is simpler and
    equally correct). Never raises.
    """
    path = _architecture_plan_file_path()
    if path is None or not path.exists():
        return None

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

    if not isinstance(raw, dict) or raw.get("planningFailed"):
        return None

    ok, normalized = validate_architecture_plan(raw)
    return normalized if ok else None


def _extract_json_object(text):
    """Best-effort extraction of a single JSON object from the model's
    final-turn text. The system prompt asks for bare JSON, but models
    sometimes wrap it in prose or a ```json fence anyway; tolerate that
    before giving up, same spirit as final_synthesis's "never crash,
    always produce something usable" philosophy — just applied to
    parsing instead of report generation.
    """
    text = (text or "").strip()

    try:
        return json.loads(text)
    except (ValueError, TypeError):
        pass

    fence_match = re.search(
        r"```(?:json)?\s*(\{.*\})\s*```",
        text,
        re.DOTALL,
    )
    if fence_match:
        try:
            return json.loads(fence_match.group(1))
        except ValueError:
            pass

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except ValueError:
            pass

    raise ValueError("no parseable JSON object found in final answer")


# ============================================================
# ARCHITECT REVIEW (C2, glimmer-v7 — V7 §§5.6-5.13)
# ============================================================
#
# Pre-verification review: glimmer-v2.py invokes THIS SAME mode="architect"
# invocation (via --review-request, wired into run_architect below) after
# the engineer subprocess returns with a non-empty changed-files set and
# BEFORE verify() runs. Deliberately reuses mode == "architect" rather than
# a new mode string: ARCHITECT_TOOL_NAMES, execute_tool's write-tool hard-
# block, and architect_shell_policy all key off that exact string, so
# review gets every read-only guarantee C1's planning mode already has, by
# construction — see _architect_review_selfcheck below.

ARCHITECT_REVIEW_DECISIONS = {
    "APPROVED",
    "APPROVED_WITH_CONDITIONS",
    "REVISE_IMPLEMENTATION",
    "REPLAN_REQUIRED",
    "HUMAN_REVIEW_REQUIRED",
}

# V7 §5.7's optional array fields — same tolerant-but-honest default-to-
# empty treatment as ARCHITECT_PLAN_OPTIONAL_ARRAY_FIELDS.
ARCHITECT_REVIEW_ARRAY_FIELDS = (
    "findings",
    "requiredChanges",
    "constraints",
    "verificationAdjustments",
)

ARCHITECT_REVIEW_SYSTEM_PROMPT = (
    "Reasoning strength: high. "
    "You are Glimmer Architect performing a PRE-VERIFICATION REVIEW "
    "(V7 §5.9) of an implementation an engineer just produced, before "
    "the trusted verifier runs. You have the SAME read-only access as "
    "architecture planning: no write_file/edit_file, exec_shell_command "
    "restricted to read-only git. You cannot install dependencies, run "
    "tests or builds, commit, push, or deploy.\n\n"

    "You are not a rubber stamp (V7 §5.8). Using the ArchitecturePlan, "
    "the actual diff/changed files given to you, and repository "
    "evidence you inspect yourself, ask: Is the existing architecture "
    "being reused? Is state/data ownership still correct? Was "
    "unnecessary complexity introduced? Did scope expand without "
    "justification? Are new abstractions actually necessary? Are "
    "project conventions preserved? Is the verification plan still "
    "sufficient? Are there hidden cross-system effects? Is the "
    "solution minimal for the objective? Is the engineer solving the "
    "real problem, not just a symptom?\n\n"

    "Respond with EXACTLY one JSON object and nothing else — no prose, "
    "no markdown fence — matching this shape:\n\n"
    "{\n"
    '  "decision": "APPROVED|APPROVED_WITH_CONDITIONS|'
    'REVISE_IMPLEMENTATION|REPLAN_REQUIRED|HUMAN_REVIEW_REQUIRED '
    '(REQUIRED)",\n'
    '  "confidence": 0.0-1.0 (number, REQUIRED),\n'
    '  "findings": ["what you actually verified, evidence-based"],\n'
    '  "requiredChanges": ["only when decision is REVISE_IMPLEMENTATION"],\n'
    '  "constraints": ["conditions the engineer must respect if '
    'APPROVED_WITH_CONDITIONS"],\n'
    '  "verificationAdjustments": ["extra checks the verifier should '
    'run, if any"]\n'
    "}\n\n"
    "decision and confidence are REQUIRED. Other fields may be empty "
    "arrays if you have nothing to report, but must still be present. "
    "Use REPLAN_REQUIRED when the implementation contradicts the "
    "plan's architecture and a new plan is needed; HUMAN_REVIEW_"
    "REQUIRED when you cannot make a confident call at all."
)


def validate_architect_review(data):
    """Validate a parsed JSON object against V7 §5.7's ArchitectReview
    shape. Same tolerant-but-honest bar as validate_architecture_plan /
    validate_delivery_review: decision + confidence are required and
    well-typed; every array field defaults to [] when missing/malformed
    rather than rejecting the whole review.

    Returns (True, normalized_review_dict) or (False, reason_string).
    """
    if not isinstance(data, dict):
        return False, "response is not a JSON object"

    decision = data.get("decision")
    if decision not in ARCHITECT_REVIEW_DECISIONS:
        return False, (
            "missing/invalid 'decision' (must be one of: "
            + ", ".join(sorted(ARCHITECT_REVIEW_DECISIONS))
            + ")"
        )

    confidence = data.get("confidence")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
        return False, "missing/invalid 'confidence' (must be a number)"

    normalized = {
        "decision": decision,
        "confidence": confidence,
    }
    for field in ARCHITECT_REVIEW_ARRAY_FIELDS:
        value = data.get(field, [])
        normalized[field] = value if isinstance(value, list) else []

    return True, normalized


def _fallback_architect_review(reason):
    """Minimal, always-valid-JSON degradation target — same shape as a
    successful review (same keys, "reviewFailed" only ADDED, never a
    different schema), mirroring _fallback_architecture_plan /
    _fallback_delivery_review. glimmer-v2.py's loader treats
    reviewFailed=True as "review never happened" and fails open — the
    decision value here is never acted on.
    """
    review = {
        "decision": "HUMAN_REVIEW_REQUIRED",
        "confidence": 0.0,
        "reviewFailed": True,
        "reviewFailureReason": reason,
    }
    for field in ARCHITECT_REVIEW_ARRAY_FIELDS:
        review[field] = []
    return review


def _architect_review_file_path(iteration, review_round):
    """Same session-dir-derivation convention as
    _architecture_plan_file_path() — the parent of GLIMMER_EVENTS_PATH.
    Numbered architect-review-NN-MM.json (NN=iteration, MM=review round
    within that iteration) — same two-part convention as glimmer-v2.py's
    verify-NN-MM.json, since one iteration can run more than one review
    round (a REVISE_IMPLEMENTATION decision is followed by another
    review, budget permitting). Returns None when no session dir is
    available, same no-op guarantee as the rest of this file.
    """
    if not GLIMMER_EVENTS_PATH or not GLIMMER_SESSION_ID:
        return None
    return Path(GLIMMER_EVENTS_PATH).parent / f"architect-review-{iteration:02d}-{review_round:02d}.json"


def _write_architect_review_file(output, iteration, review_round):
    """Write architect-review-NN-MM.json (real review or the reviewFailed
    marker). Never raises. Returns the path written, or None when no
    session dir is available or the write failed.
    """
    path = _architect_review_file_path(iteration, review_round)
    if path is None:
        print(
            "[glimmer-engineer] no session dir available (standalone "
            "invocation); architect-review file not written."
        )
        return None
    try:
        path.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Wrote: {path}")
        return path
    except OSError as exc:
        print(f"[glimmer-engineer] failed to write architect-review file: {exc}")
        return None


def _load_review_request(path):
    """C2: read+parse glimmer-v2.py's review-request JSON file (the
    ArchitecturePlan, real changed-files list, and real `git diff` text
    it computed — see glimmer-v2.py's make_review_request/
    git_diff_text). Returns (dict, None) on success or (None,
    reason_string) on any failure — missing, unreadable, not valid
    JSON, not an object. Never raises; split out from run_architect so
    the fail-open path is exercised directly by the self-check without
    spinning up the model loop.
    """
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError) as exc:
        return None, f"could not read/parse review-request file: {exc}"
    if not isinstance(data, dict):
        return None, "review-request file is not a JSON object"
    return data, None


def _build_review_task_message(review_request):
    """Build the review turn's user message from glimmer-v2.py's already-
    trusted review-request dict (the ArchitecturePlan it used, the real
    changed-files list, and the real `git diff` text). Read directly by
    this trusted Python process at startup, not by a model tool call, so
    the review always sees the same evidence v2 computed regardless of
    what the model does with its own read-only tools this turn.
    """
    plan = review_request.get("architecturePlan") or {}
    changed_files = review_request.get("changedFiles") or []
    diff_text = review_request.get("diff") or ""

    files_text = "\n".join(
        f"  - {f.get('path')} ({f.get('changeType', 'modified')})"
        for f in changed_files
        if isinstance(f, dict) and f.get("path")
    ) or "  (none)"

    message = (
        "ARCHITECTURE PLAN (produced before implementation began):\n"
        + json.dumps(plan, indent=2) + "\n\n"
        "CHANGED FILES:\n" + files_text + "\n\n"
        "DIFF (git diff against the task baseline; new/untracked files "
        "have no tracked diff to show — use your own read-only tools "
        "if you need their full content):\n" + diff_text
    )

    # Task 4.3 ("Architect task-list review"): present only on the FIRST
    # review of a session (see glimmer-v2.py's run_architect_review call
    # site) — the derived task list (tasks.json), so this same review turn
    # also answers V7's task-list-review questions (does it still
    # implement the plan? anything missing/superfluous/misordered?) without
    # spending a second model call. Absent on every later round -- no
    # section is appended then, exactly the pre-Task-4.3 message.
    task_list = review_request.get("taskList")
    if isinstance(task_list, list) and task_list:
        dict_tasks = [t for t in task_list if isinstance(t, dict)]
        # Review round 1 (Minor 8c): cap what actually reaches the prompt --
        # this rides along inside an existing review request (V7 §5.6's
        # ARCHITECT_REVIEW_DIFF_MAX_CHARS-style token budget still applies
        # to the WHOLE message), so an unusually large derived task list
        # must degrade to a bounded summary, never balloon the turn.
        _TASK_LIST_MAX_TASKS = 50
        _TASK_LIST_DESC_MAX_CHARS = 300
        shown, overflow = dict_tasks[:_TASK_LIST_MAX_TASKS], len(dict_tasks) - _TASK_LIST_MAX_TASKS

        def _capped_description(t):
            desc = str(t.get("description") or "")
            return desc if len(desc) <= _TASK_LIST_DESC_MAX_CHARS else desc[:_TASK_LIST_DESC_MAX_CHARS] + "…"

        tasks_text = "\n".join(
            f"  - [{t.get('id')}] ({t.get('kind')}, {t.get('priority', 'required')}) "
            f"{_capped_description(t)}"
            + (f" — depends on: {', '.join(t.get('dependsOn'))}" if t.get("dependsOn") else "")
            for t in shown
        ) or "  (none)"
        if overflow > 0:
            tasks_text += f"\n  ... (+{overflow} more tasks not shown)"

        message += (
            "\n\nDERIVED TASK LIST (produced from the architecture plan before "
            "implementation began -- also review this as part of your decision: "
            "does it still implement the plan, is anything important missing or "
            "superfluous, are dependencies correct, is scope appropriate?):\n"
            + tasks_text
            + "\n\n"
            # Review round 1 (Important 4): task-list prose must never
            # burn the REVISE_IMPLEMENTATION budget (§5.13) on its own --
            # a wrong/missing/superfluous/misordered task is a PLANNING
            # problem, not an implementation defect this round's diff can
            # fix. Route observations into findings/verificationAdjustments
            # (non-blocking); only decision=REPLAN_REQUIRED may actually be
            # driven by a task-list problem, and only when the underlying
            # plan itself needs to change.
            "Note on the task list above: report any observations about it "
            "(missing/superfluous/misordered tasks, wrong dependencies, "
            "scope drift) via `findings` and, if you want to propose a "
            "concrete change, `verificationAdjustments` -- NEVER via "
            "`requiredChanges`, which would trigger a REVISE_IMPLEMENTATION "
            "round over task-list prose alone and burn the revise/re-review "
            "budget on something this round's diff cannot fix. If the task "
            "list is wrong enough that the underlying architecture plan "
            "itself needs to change, that must be expressed as "
            "decision=REPLAN_REQUIRED, not REVISE_IMPLEMENTATION."
        )

    return message


def run_architect(task, workspace, max_turns, review_request_path=None):
    """C1/C2 (glimmer-v7): read-only architecture-planning loop, and (C2)
    the SAME loop reused for pre-verification review when
    review_request_path is given.

    Structurally simpler than run_engineer's write-oriented state machine
    (engineer_phase, discovery/post-gate budgets, write-freeze, diff/
    validation tracking) — none of that exists to serve write decisions
    that architect mode can never make, so reusing run_engineer's 700+
    lines and threading a mode flag through every branch would be a
    forced fit, not a simplification. This function instead reuses the
    shared LOW-LEVEL primitives (get_tools, execute_tool, chat_with_retry,
    git_local, parse_arguments, compact_tool_result_for_model) so nothing
    about tool dispatch, shell policy, or HTTP plumbing is duplicated or
    can drift from the engineer path.

    C2 review mode does NOT branch the tool-call loop or the
    mode="architect" execute_tool call at all — only the system prompt,
    the seed user message, the final-answer validator, and where the
    result is written differ. This is deliberate: review must get
    EXACTLY the same read-only enforcement as planning, by sharing the
    one call site rather than adding a second one that could drift.
    """
    workspace = workspace.expanduser().resolve()

    if not workspace.is_dir():
        raise RuntimeError(f"Workspace missing: {workspace}")

    git_root = Path(
        git_local(workspace, "rev-parse", "--show-toplevel")
    ).resolve()

    if git_root != workspace:
        raise RuntimeError(
            "Architect workspace must be the git repository root.\n"
            f"Workspace: {workspace}\n"
            f"Git root:  {git_root}"
        )

    review_mode = review_request_path is not None
    review_request = None
    review_iteration, review_round = 0, 1

    if review_mode:
        # Read v2's review-request file BEFORE spending a single model
        # turn — a bad/missing file degrades straight to a reviewFailed
        # fallback, exactly like every other fail-open path in this file.
        review_request, load_error = _load_review_request(review_request_path)
        if review_request is None:
            _write_architect_review_file(
                _fallback_architect_review(load_error), review_iteration, review_round,
            )
            return
        try:
            review_iteration = int(review_request.get("iteration", 0))
        except (TypeError, ValueError):
            review_iteration = 0
        try:
            review_round = int(review_request.get("reviewRound", 1))
        except (TypeError, ValueError):
            review_round = 1

    if review_mode:
        _emit_architect_review_started()
    else:
        _emit_architect_started()

    metadata, tools = get_tools()

    architect_tools = [
        tool
        for tool in tools
        if (tool.get("function") or {}).get("name") in ARCHITECT_TOOL_NAMES
    ]

    print("Glimmer Architect Mode (C1/C2, read-only)")
    print(f"Workspace: {workspace}")
    print(f"Tools:     {len(architect_tools)} (read-only)")
    print("Writes:    STRUCTURALLY BLOCKED")
    print(f"Sub-mode:  {'review' if review_mode else 'planning'}")
    print()

    system_prompt = ARCHITECT_REVIEW_SYSTEM_PROMPT if review_mode else ARCHITECT_SYSTEM_PROMPT
    user_content = _build_review_task_message(review_request) if review_mode else task
    validate_fn = validate_architect_review if review_mode else validate_architecture_plan
    answer_label = "ArchitectReview" if review_mode else "ArchitecturePlan"

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]

    # No approval path (C1/C2 scoping): this runs unattended as a
    # subprocess with no interactive terminal, so approve() must never
    # block on input(). Forced True here regardless of any caller-
    # supplied flag — this is architect mode's own structural property,
    # not something a caller opts into.
    approvals = {"approve_all": True}
    cache = {}
    ledger = []  # kept for execute_tool's signature; never persisted (see execute_tool's mode == "architect" guard)

    final_result = None
    failure_reason = None

    try:
        for turn in range(max_turns):
            final_turn = turn == max_turns - 1

            payload = {
                "model": "muse-glimmer",
                "messages": messages,
                "tools": architect_tools,
                "tool_choice": "auto",
                "parallel_tool_calls": False,
                "max_tokens": 4096,
            }

            if final_turn:
                payload.pop("tools", None)
                payload.pop("tool_choice", None)
                payload.pop("parallel_tool_calls", None)

                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "Tool budget is exhausted. Do not request "
                            "tools. Produce your final answer now: the "
                            f"single {answer_label} JSON object "
                            "described earlier, and nothing else."
                        ),
                    }
                )

            try:
                response = chat_with_retry(payload, attempts=3)
            except RuntimeError as exc:
                if "peg-native" not in str(exc):
                    raise
                failure_reason = f"PEG parser repeatedly failed: {exc}"
                break

            message = response["choices"][0]["message"]
            content = message.get("content") or ""
            tool_calls = message.get("tool_calls") or []

            if not tool_calls:
                try:
                    data = _extract_json_object(content)
                except ValueError as exc:
                    if final_turn:
                        failure_reason = f"final answer was not parseable JSON: {exc}"
                        break

                    messages.append({"role": "assistant", "content": content})
                    messages.append(
                        {
                            "role": "user",
                            "content": (
                                "Your response must be exactly one JSON "
                                f"object matching the {answer_label} "
                                "shape given earlier — nothing else. "
                                "Try again."
                            ),
                        }
                    )
                    continue

                ok, validated = validate_fn(data)
                if not ok:
                    if final_turn:
                        failure_reason = f"{answer_label.lower()} failed validation: {validated}"
                        break

                    messages.append({"role": "assistant", "content": content})
                    messages.append(
                        {
                            "role": "user",
                            "content": (
                                f"Invalid {answer_label.lower()}: {validated}. "
                                "Re-send the corrected single JSON object."
                            ),
                        }
                    )
                    continue

                final_result = validated
                break

            # ------------------------------------------------
            # EXECUTE TOOL CALLS (read-only tool set only) — identical
            # dispatch for planning and review: mode="architect" is
            # passed unconditionally below, so every existing read-only
            # guard (execute_tool's WRITE_TOOLS hard-block,
            # architect_shell_policy) applies to review turns exactly as
            # it does to planning turns.
            # ------------------------------------------------

            for index, call in enumerate(tool_calls):
                if not call.get("id"):
                    call["id"] = f"call_{turn}_{index}"

            messages.append(
                {
                    "role": "assistant",
                    "content": message.get("content"),
                    "tool_calls": tool_calls,
                }
            )

            for call in tool_calls:
                function = call.get("function") or {}
                tool_name = function.get("name") or ""

                if tool_name not in metadata:
                    tool_result = "Unknown/unavailable tool: " + tool_name
                else:
                    try:
                        arguments = parse_arguments(function.get("arguments"))
                        tool_result, _changed = execute_tool(
                            tool_name,
                            arguments,
                            workspace,
                            approvals,
                            cache,
                            ledger,
                            None,
                            mode="architect",
                        )
                    except Exception as exc:
                        tool_result = "TOOL BLOCKED/ERROR: " + str(exc)
                        print()
                        print("✗ " + tool_result)

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call["id"],
                        "content": compact_tool_result_for_model(tool_name, tool_result),
                    }
                )
        else:
            # Loop exhausted max_turns without break (result or failure_reason).
            if final_result is None and failure_reason is None:
                failure_reason = f"reached max turns ({max_turns}) without a final {answer_label.lower()}"

    except Exception as exc:  # noqa: BLE001 - architect failure must degrade, never crash the caller
        failure_reason = f"{type(exc).__name__}: {exc}"

    if review_mode:
        if final_result is not None:
            output = final_result
            print()
            print("════════════════════════════════════")
            print("ARCHITECT REVIEW")
            print("════════════════════════════════════")
            print(f"Decision:   {output['decision']}")
            print(f"Confidence: {output['confidence']}")
        else:
            output = _fallback_architect_review(failure_reason or "unknown failure")
            print()
            print(f"⚠ Architect review failed: {failure_reason or 'unknown failure'}")
            print("Writing fallback architect-review file (reviewFailed=true).")
        _write_architect_review_file(output, review_iteration, review_round)
        return

    if final_result is not None:
        output = final_result
        print()
        print("════════════════════════════════════")
        print("ARCHITECTURE PLAN")
        print("════════════════════════════════════")
        print(f"Objective: {output['objective']}")
        print(f"Risk:      {output['risk']}")
        print(f"Packages:  {output['packages']}")
    else:
        output = _fallback_architecture_plan(
            _extract_task_objective(task),
            failure_reason or "unknown failure",
        )
        print()
        print(f"⚠ Architect planning failed: {failure_reason or 'unknown failure'}")
        print("Writing fallback architecture-plan.json (planningFailed=true).")

    _write_architecture_plan_file(output)


# ============================================================
# DELIVERY REVIEW (C6, glimmer-v7 — V7 §23.7)
# ============================================================
#
# One extra tool-free turn AFTER the existing prose "Final Engineering
# Report" turn. The prose report stays the human-facing artifact,
# unchanged; this is its machine-readable companion. Advisory only:
# nothing here (or anywhere else in this file) reads customerReadiness
# back into engineer_state/engineer_phase or any manifest-relevant
# value — this section only ever WRITES delivery-review.json. The
# function below deliberately takes no workspace/manifest/ledger-
# mutating reference, only plain already-computed strings, so it is
# structurally incapable of changing session outcome (§23.9/§23.11).

DELIVERY_REVIEW_READINESS_VALUES = {
    "ready_to_ship",
    "ready_with_known_limitations",
    "needs_polish",
    "needs_rework",
    "not_customer_ready",
}

DELIVERY_REVIEW_CONFIDENCE_LEVELS = {"low", "medium", "high"}

# DeliveryConcern sub-fields (V7 §23.7) and NextStep priority. Malformed
# values here are coerced to a conservative default rather than
# rejecting the whole review (fix round 1, Minor) — same tolerant-but-
# honest bar as the top-level fields, just applied one level deeper.
DELIVERY_CONCERN_SEVERITY_VALUES = {"low", "medium", "high", "critical"}
DELIVERY_CONCERN_CATEGORY_VALUES = {
    "architecture",
    "functionality",
    "visual",
    "ux",
    "performance",
    "security",
    "verification",
    "maintainability",
}
NEXT_STEP_PRIORITY_VALUES = {
    "required_before_ship",
    "recommended_next",
    "future_opportunity",
}

# V7 §23.7's optional array fields — always present in the written
# review, defaulted to empty when the model omits them (same tolerant-
# but-honest philosophy as ARCHITECT_PLAN_OPTIONAL_ARRAY_FIELDS).
DELIVERY_REVIEW_ARRAY_FIELDS = (
    "approachRationale",
    "strengths",
    "concerns",
    "unresolvedItems",
    "intentionallyNotChanged",
    "nextSteps",
)

DELIVERY_REVIEW_SYSTEM_PROMPT = (
    "Reasoning strength: low. "
    "You are Glimmer's self-review layer. Implementation and "
    "verification already happened and cannot be changed by you — you "
    "have no tools this turn. Judge the delivered result the way a "
    "senior engineer would before it reaches a customer.\n\n"

    "Ground every claim in the task, evidence, and report given to "
    "you below. Do not invent dissatisfaction: a concern must point "
    "to something specific (a failed/skipped check, a TODO, a scope "
    "compromise, a known limitation) — never a vague feeling.\n\n"

    "Explain decisions, never narrate reasoning. 'Why this approach' "
    "must be an externally useful decision summary (e.g. 'X already "
    "owned this data, so reusing it avoided a duplicate store'), "
    "never a thinking-out-loud trace ('first I considered..., "
    "then...'). Do not include chain-of-thought anywhere in your "
    "answer.\n\n"

    "customerReadiness is an advisory product judgment only. It never "
    "overrides, blocks, or replaces the technical verification status "
    "already recorded for this session.\n\n"

    "You are a reporter, not an implementer: nextSteps are "
    "recommendations for a human to accept, defer, or turn into a "
    "follow-up task. You are not authorized to act on them.\n\n"

    "Respond with EXACTLY one JSON object and nothing else — no "
    "prose, no markdown fence — matching this shape:\n\n"
    "{\n"
    '  "summary": "string, REQUIRED",\n'
    '  "approachRationale": ["decision summary, not a reasoning trace"],\n'
    '  "strengths": ["what is genuinely good, evidence-based"],\n'
    '  "concerns": [\n'
    "    {\n"
    '      "severity": "low|medium|high|critical",\n'
    '      "category": "architecture|functionality|visual|ux|'
    'performance|security|verification|maintainability",\n'
    '      "description": "string",\n'
    '      "evidenceIds": ["cite ids from the EVIDENCE INDEX only"]\n'
    "    }\n"
    "  ],\n"
    '  "customerReadiness": '
    '"ready_to_ship|ready_with_known_limitations|needs_polish|'
    'needs_rework|not_customer_ready (REQUIRED)",\n'
    '  "unresolvedItems": ["string"],\n'
    '  "intentionallyNotChanged": ["string"],\n'
    '  "nextSteps": [\n'
    '    {"priority": "required_before_ship|recommended_next|'
    'future_opportunity", "action": "string"}\n'
    "  ],\n"
    '  "confidence": {"level": "low|medium|high (REQUIRED)", '
    '"reason": "string (REQUIRED)"}\n'
    "}\n\n"
    "summary, customerReadiness, and confidence are REQUIRED. Other "
    "fields may be empty arrays if you have nothing to report, but "
    "must still be present."
)


def validate_delivery_review(data, known_evidence_ids):
    """Validate a parsed JSON object against V7 §23.7's DeliveryReview
    shape. Same tolerant-but-honest bar as validate_architecture_plan:
    summary/customerReadiness/confidence are required and well-typed;
    every other field is defaulted to [] when missing/malformed rather
    than rejected. concerns[].evidenceIds are filtered against
    known_evidence_ids (§23.5 — a cited id that isn't real is not
    evidence); dropped ids are collected into a top-level
    "filteredEvidenceIds" list rather than silently discarded, so a
    hallucinated citation is visible in the written file instead of
    trusted as real.

    Sub-fields one level deeper (fix round 1, Minor) get the same
    tolerant-but-honest treatment: an unrecognized concern severity
    coerces to "low" and an unrecognized category coerces to
    "functionality" (conservative defaults — malformed input should
    never silently escalate a concern's apparent severity); an
    unrecognized nextStep priority coerces to "recommended_next". A
    concern with no real (non-empty string) description, or a
    nextStep with no real action, is dropped entirely rather than kept
    with fabricated content — a concern's only substance IS its
    description, so a hollow one is worse than none (same "don't
    invent dissatisfaction" principle, applied to malformed input
    instead of a live model's own claims).

    Returns (True, normalized_review_dict) or (False, reason_string).
    """
    if not isinstance(data, dict):
        return False, "response is not a JSON object"

    summary = data.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        return False, "missing/invalid 'summary' (must be a non-empty string)"

    readiness = data.get("customerReadiness")
    if readiness not in DELIVERY_REVIEW_READINESS_VALUES:
        return False, (
            "missing/invalid 'customerReadiness' (must be one of: "
            + ", ".join(sorted(DELIVERY_REVIEW_READINESS_VALUES))
            + ")"
        )

    confidence = data.get("confidence")
    if (
        not isinstance(confidence, dict)
        or confidence.get("level") not in DELIVERY_REVIEW_CONFIDENCE_LEVELS
        or not isinstance(confidence.get("reason"), str)
    ):
        return False, (
            "missing/invalid 'confidence' (must be an object with "
            "'level' in low/medium/high and a string 'reason')"
        )

    normalized = {
        "summary": summary,
        "customerReadiness": readiness,
        "confidence": {
            "level": confidence["level"],
            "reason": confidence["reason"],
        },
    }

    for field in DELIVERY_REVIEW_ARRAY_FIELDS:
        if field in ("concerns", "nextSteps"):
            continue
        value = data.get(field, [])
        normalized[field] = value if isinstance(value, list) else []

    raw_concerns = data.get("concerns", [])
    concerns_out = []
    filtered_ids = []
    for concern in raw_concerns if isinstance(raw_concerns, list) else []:
        if not isinstance(concern, dict):
            continue
        description = concern.get("description")
        if not isinstance(description, str) or not description.strip():
            continue
        severity = concern.get("severity")
        category = concern.get("category")
        ids = concern.get("evidenceIds")
        ids = ids if isinstance(ids, list) else []
        concerns_out.append(
            {
                "severity": severity if severity in DELIVERY_CONCERN_SEVERITY_VALUES else "low",
                "category": category if category in DELIVERY_CONCERN_CATEGORY_VALUES else "functionality",
                "description": description,
                "evidenceIds": [i for i in ids if i in known_evidence_ids],
            }
        )
        filtered_ids.extend(i for i in ids if i not in known_evidence_ids)
    normalized["concerns"] = concerns_out
    if filtered_ids:
        normalized["filteredEvidenceIds"] = sorted(set(filtered_ids))

    raw_next_steps = data.get("nextSteps", [])
    next_steps_out = []
    for step in raw_next_steps if isinstance(raw_next_steps, list) else []:
        if not isinstance(step, dict):
            continue
        action = step.get("action")
        if not isinstance(action, str) or not action.strip():
            continue
        priority = step.get("priority")
        next_steps_out.append(
            {
                "priority": priority if priority in NEXT_STEP_PRIORITY_VALUES else "recommended_next",
                "action": action,
            }
        )
    normalized["nextSteps"] = next_steps_out

    return True, normalized


def _fallback_delivery_review(reason):
    """Minimal, always-valid-JSON degradation target — same shape as a
    successful review (same keys, "reviewFailed" only ADDED, never a
    different schema), mirroring _fallback_architecture_plan.
    """
    review = {
        "summary": "",
        "customerReadiness": "not_customer_ready",
        "confidence": {"level": "low", "reason": "delivery review generation failed"},
        "reviewFailed": True,
        "reviewFailureReason": reason,
    }
    for field in DELIVERY_REVIEW_ARRAY_FIELDS:
        review[field] = []
    return review


def _delivery_review_file_path():
    """Same session-dir-derivation convention as _evidence_file_path()/
    _architecture_plan_file_path() above — the parent of
    GLIMMER_EVENTS_PATH. Not iteration-numbered: exactly one
    delivery-review.json per session, written once at the very end.
    Returns None when no session dir is available (standalone
    invocation), same no-op guarantee as the rest of this file.
    """
    if not GLIMMER_EVENTS_PATH or not GLIMMER_SESSION_ID:
        return None

    return Path(GLIMMER_EVENTS_PATH).parent / "delivery-review.json"


def _write_delivery_review_file(output):
    """Write delivery-review.json (real review or the reviewFailed
    marker) to the session dir. Never raises. Returns the path written,
    or None when no session dir is available or the write failed.
    """
    path = _delivery_review_file_path()

    if path is None:
        print(
            "[glimmer-engineer] no session dir available (standalone "
            "invocation); delivery-review.json not written."
        )
        return None

    try:
        path.write_text(
            json.dumps(output, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        print(f"Wrote: {path}")
        return path
    except OSError as exc:
        print(f"[glimmer-engineer] failed to write delivery-review.json: {exc}")
        return None


def _known_delivery_review_evidence_ids():
    """Ids already persisted by _persist_evidence for THIS process (each
    engineer iteration is its own subprocess with its own _evidence_seq
    starting at 1, matching evidence-NN.jsonl's per-iteration file), as
    a plain set for validate_delivery_review's evidenceIds filter.

    Task 5.2 (V7 §26/§46): additively unioned with every id present in
    evidence-index.json -- that index is shared/incremental across the
    WHOLE session (not per-iteration like _evidence_seq), so a later
    iteration's delivery review can legitimately cite an evidence id an
    earlier iteration recorded. Absence of the index file (no session
    dir, nothing indexed yet, corrupt content) degrades to exactly the
    prior per-process-only set -- never raises, never shrinks it.
    """
    ids = (
        {f"{GLIMMER_SESSION_ID}-ev-{n}" for n in range(1, _evidence_seq + 1)}
        if GLIMMER_SESSION_ID
        else set()
    )
    try:
        idx_path = _evidence_index_file_path()
        if idx_path is not None and idx_path.exists():
            data = json.loads(idx_path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                ids |= {
                    entry.get("id")
                    for entry in data
                    if isinstance(entry, dict) and entry.get("id")
                }
    except Exception:  # noqa: BLE001 - index lookup is additive-only, never fatal
        pass
    return ids


def _build_delivery_review_payload(task, ledger, prose_report):
    """Pure request-builder, split out from run_delivery_review so a
    self-check can assert the constructed payload has no "tools" (or
    any tool-calling) key without needing a live model — the omission
    of that key IS the structural (not merely instructed) tool-free
    guarantee. Takes only plain data, same reasoning as
    run_delivery_review's docstring.
    """
    evidence_lines = []
    total = 0
    for index, item in enumerate(ledger):
        line = f"[{GLIMMER_SESSION_ID}-ev-{index + 1}] " + item.splitlines()[0]
        if total + len(line) > MAX_EVIDENCE_TOTAL:
            break
        evidence_lines.append(line)
        total += len(line)
    evidence_index = "\n".join(evidence_lines) or "(no tool evidence recorded)"

    objective = _extract_task_objective(task) or (task or "")[:_TASK_OBJECTIVE_LIMIT]

    return {
        "model": "muse-glimmer",
        "messages": [
            {"role": "system", "content": DELIVERY_REVIEW_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "TASK:\n" + objective + "\n\n"
                    "EVIDENCE INDEX (id: first line of each recorded "
                    "tool result; cite these exact ids in "
                    "concerns[].evidenceIds, never invent new ones):\n"
                    + evidence_index + "\n\n"
                    "FINAL ENGINEERING REPORT (already delivered to "
                    "the human; review it, do not repeat it "
                    "verbatim):\n" + prose_report[:8000]
                ),
            },
        ],
        "max_tokens": 2048,
    }
    # No "tools"/"tool_choice"/"parallel_tool_calls" key is ever added
    # above — this turn is structurally toolless, not merely instructed
    # to avoid tools (same discipline as the control-center Session
    # Assistant's tool-free turns).


def run_delivery_review(task, ledger, prose_report):
    """C6: build and send the one extra tool-free turn, then persist
    the result. Takes only plain data (task text, the in-memory
    evidence ledger, the already-produced prose report) — never a
    workspace path, manifest, or engineer_state/engineer_phase
    reference — so this function is structurally unable to read or
    change anything session-outcome-relevant; it can only write
    delivery-review.json. Never raises: any failure (unparseable JSON,
    failed validation, model/network error) degrades to the
    reviewFailed fallback file, exactly like architect mode's planning
    failure path. The caller's return value/session outcome never
    depends on this function.
    """
    _emit("delivery_review_started")
    try:
        known_ids = _known_delivery_review_evidence_ids()
        payload = _build_delivery_review_payload(task, ledger, prose_report)
        response = chat_with_retry(payload, attempts=3)
        content = response["choices"][0]["message"].get("content") or ""
        data = _extract_json_object(content)
        ok, result = validate_delivery_review(data, known_ids)
        if not ok:
            raise ValueError(result)
    except Exception as exc:  # noqa: BLE001 - this turn must never affect session outcome
        print(f"[glimmer-engineer] delivery review generation failed: {exc}")
        _write_delivery_review_file(
            _fallback_delivery_review(f"{type(exc).__name__}: {exc}")
        )
        return

    print()
    print("════════════════════════════════════")
    print("DELIVERY REVIEW")
    print("════════════════════════════════════")
    print(f"Customer readiness: {result['customerReadiness']}")
    print(f"Confidence:         {result['confidence']['level']}")

    _write_delivery_review_file(result)
    _emit(
        "delivery_review_completed",
        customerReadiness=result["customerReadiness"],
        confidence=result["confidence"]["level"],
    )


# ============================================================
# TASK 2.4 (V7 §5.5 second half): mid-implementation consultation
# ============================================================
#
# Two independent mechanisms, both advisory-only and fail-open (an
# exception anywhere in this section must never break run_engineer's
# loop):
#
#   1. Deterministic triggers (_evaluate_advisory_triggers), evaluated
#      once per turn: inject a system-role nudge + emit
#      architect_consult_advised. Never blocks a tool call, never fails
#      the session.
#   2. consult_architect tool: offered only when both an architecture
#      plan exists and glimmer-v2.py passed --architect-consult-enabled
#      (_augment_tools_with_consult_architect), intercepted client-side
#      in execute_tool exactly like the O4 semantic tools, budget-limited
#      to CONSULT_ARCHITECT_BUDGET/session.

CONSULT_ARCHITECT_BUDGET = 2

# Reset only by _consult_selfcheck (save/restore), same pattern as
# _evidence_seq -- each real engineer session is its own subprocess, so
# this only ever needs to count within one process's lifetime.
_consult_architect_used = 0

CONSULT_ARCHITECT_TOOL = {
    "display_name": "Consult architect",
    "tool": "consult_architect",
    "type": "function",
    "permissions": {"write": False},
    "uses_cwd": False,
    "definition": {
        "type": "function",
        "function": {
            "name": "consult_architect",
            "description": (
                "Ask the Architect ONE targeted question about this "
                "task's architecture plan -- e.g. whether a candidate "
                "file is still the right one, whether a new abstraction/"
                "dependency/service is warranted, or how to resolve a "
                "plan-vs-reality mismatch (V7 §5.5). Read-only: never "
                "changes anything. Budget: "
                f"{CONSULT_ARCHITECT_BUDGET} consultations per session -- "
                "use it deliberately for a real architectural question, "
                "not routine questions answerable by reading the code."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": (
                            "Your specific question for the architect "
                            "(max 2000 chars)."
                        ),
                    },
                },
                "required": ["question"],
            },
        },
    },
}


def _augment_tools_with_consult_architect(metadata, tools, architecture_plan, enabled):
    """Mutates metadata/tools IN PLACE to add consult_architect (same
    shape get_tools() already uses for SEMANTIC_TOOL_DEFINITIONS), but
    ONLY when both conditions hold: `enabled` (--architect-consult-
    enabled was passed) AND `architecture_plan` is not None (a usable
    plan actually exists for this session). No-op otherwise -- split out
    from run_engineer as its own pure function specifically so a
    self-check can exercise all four flag/plan combinations without a
    live model or tool server.
    """
    if not enabled or architecture_plan is None:
        return

    metadata[CONSULT_ARCHITECT_TOOL["tool"]] = CONSULT_ARCHITECT_TOOL
    tools.append(CONSULT_ARCHITECT_TOOL["definition"])


CONSULT_ARCHITECT_SYSTEM_PROMPT = (
    "Reasoning strength: low. You are Glimmer Architect, answering ONE "
    "targeted question from the engineer implementing your plan. Answer "
    "directly as the architect: no tool calls, no chain-of-thought, no "
    "restating the whole plan back -- just your answer, in prose, at "
    "most 400 words. If the plan doesn't resolve the question, say so "
    "honestly and give your best architectural judgment rather than "
    "inventing facts you don't have."
)


def _build_consult_architect_payload(architecture_plan, question):
    """Pure request-builder, split out from _run_consult_architect for
    the same reason _build_delivery_review_payload is split out from
    run_delivery_review: a self-check can assert the constructed payload
    has no "tools" key (the structural, not merely instructed, tool-free
    guarantee) without needing a live model. Returns (payload,
    question_capped)."""
    question_capped = str(question or "")[:2000]

    plan_json = json.dumps(architecture_plan or {}, ensure_ascii=False, indent=2)
    if len(plan_json) > 8000:
        plan_json = plan_json[:8000] + "\n...(truncated)"

    payload = {
        "model": "muse-glimmer",
        "messages": [
            {"role": "system", "content": CONSULT_ARCHITECT_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "ARCHITECTURE PLAN:\n" + plan_json
                    + "\n\nENGINEER QUESTION:\n" + question_capped
                ),
            },
        ],
        "max_tokens": 700,
    }
    # No "tools"/"tool_choice"/"parallel_tool_calls" key -- structurally
    # toolless, same discipline as _build_delivery_review_payload.
    return payload, question_capped


def _run_consult_architect(architecture_plan, question):
    """The ONE toolless model call behind consult_architect. Never
    raises: any failure (model/network error, empty response) degrades
    to an honest in-band answer explaining the failure, instead of
    raising out of execute_tool -- same fail-open spirit as
    run_delivery_review/run_architect's fallback paths. Returns
    (answer_text, question_chars)."""
    payload, question_capped = _build_consult_architect_payload(architecture_plan, question)

    try:
        response = chat_with_retry(payload, attempts=3)
        answer = response["choices"][0]["message"].get("content") or ""
        if not answer.strip():
            answer = "(architect returned an empty answer)"
    except Exception as exc:  # noqa: BLE001 - consult must never crash the engineer loop
        answer = (
            f"Architect consultation failed: {exc}. "
            "Proceed with your own best judgment."
        )

    return answer, len(question_capped)


def _format_advisory_nudge(detail):
    """The one, exact, deterministic nudge wording (no model text) that
    _evaluate_advisory_triggers' callers inject into `messages` on every
    fire."""
    return f"ADVISORY: {detail}. Consider consulting the architect before continuing."


def _normalize_advisory_path(raw):
    """Review round 1 (LOW): 3-line duplicate of glimmer-v2.py's
    _normalize_plan_path (same reasoning there: cheap, not a security
    boundary, just enough that "./src/x.ts", "src/x.ts/", and
    "src//x.ts" all compare equal) -- kept local rather than imported
    since glimmer-engineer.py and glimmer-v2.py are separate subprocess
    entry points that don't import each other."""
    p = str(raw).strip().replace("\\", "/").strip("/")
    return os.path.normpath(p) if p else p


def _evaluate_advisory_triggers(architecture_plan, changed_paths, turn, max_turns, fired):
    """Deterministic, cheap, per-turn checks -- no model call, no I/O.
    Each of the three trigger keys can fire AT MOST ONCE per session:
    callers must pass the SAME `fired` set across turns; a key already in
    `fired` is never re-evaluated or re-fired. Returns a list of (key,
    detail) tuples for triggers that fired on THIS call (mutating `fired`
    to record them); an empty list means nothing new fired.

    Pure/deterministic given its inputs (only mutates `fired`), so this
    is unit-testable without a real engineer loop or live model -- see
    _consult_selfcheck.

    Triggers (V7 §5.5):
      a. total changed-file count exceeds the plan's expected scope
         (expectedScope.maxFiles, falling back to len(candidateFiles)
         when maxFiles isn't given) -- only when a plan exists and gives
         a positive estimate. Fix round 2 (LOW): compares len(changed_
         paths) (every changed file this session, edits included), not
         just newly-created files -- aligned with glimmer-v2.py's
         check_post_verification_consistency, which flags on
         `len(files) > expectedScope.maxFiles` over the same total
         changed-files set. A plan budgeted for "at most N files" is
         blown just as much by N-1 edits + 2 new files as by N+1 new
         files.
      b. a changed file lands outside plan.candidateFiles -- only when a
         plan exists AND candidateFiles is non-empty.
      c. more than 60% of the turn budget has been used with zero
         repository writes so far -- independent of whether a plan
         exists.
    """
    fired_now = []

    if architecture_plan is not None:
        key = "new_file_count_exceeds_plan"
        if key not in fired:
            expected_scope = architecture_plan.get("expectedScope")
            if not isinstance(expected_scope, dict):
                expected_scope = {}
            candidate_files = architecture_plan.get("candidateFiles")
            if not isinstance(candidate_files, list):
                candidate_files = []

            estimate = expected_scope.get("maxFiles")
            if not isinstance(estimate, int) or isinstance(estimate, bool) or estimate <= 0:
                estimate = len(candidate_files)

            changed_count = len(changed_paths)
            if estimate > 0 and changed_count > estimate:
                detail = (
                    f"changed file count ({changed_count}) exceeds the "
                    f"architecture plan's estimate ({estimate})"
                )
                fired.add(key)
                fired_now.append((key, detail))

        key = "edit_outside_candidate_files"
        if key not in fired:
            candidate_files = architecture_plan.get("candidateFiles")
            if not isinstance(candidate_files, list):
                candidate_files = []

            candidate_paths = {
                _normalize_advisory_path(c.get("path"))
                for c in candidate_files
                if isinstance(c, dict) and isinstance(c.get("path"), str) and c.get("path")
            }

            if candidate_paths:
                outside = sorted(
                    p for p in changed_paths
                    if _normalize_advisory_path(p) not in candidate_paths
                )
                if outside:
                    detail = (
                        f"changed file {outside[0]!r} is outside the "
                        "architecture plan's candidateFiles"
                    )
                    fired.add(key)
                    fired_now.append((key, detail))

    key = "turns_high_no_writes"
    if key not in fired:
        if max_turns > 0 and (turn + 1) > 0.6 * max_turns and not changed_paths:
            detail = (
                f"turn {turn + 1}/{max_turns} (over 60% of the turn "
                "budget) with no repository write yet"
            )
            fired.add(key)
            fired_now.append((key, detail))

    return fired_now


def _consult_selfcheck() -> None:
    """Task 2.4 (V7 §5.5 second half) self-check. No network: the
    budget-exhaustion path below returns before any model call is ever
    made, and every other assertion here runs against pure functions or
    source inspection. Run with:
    python3 glimmer-engineer.py --consult-selfcheck
    """
    import inspect

    # ------------------------------------------------------------
    # 1. Trigger determinism: each of a/b/c fires exactly once, then
    #    never again given the same (or worse) fake state.
    # ------------------------------------------------------------
    fired = set()

    # (a) Fix round 2: total changed-file count (3) > maxFiles (2) --
    # candidateFiles lists 3 real paths so all 3 changed files stay
    # IN-scope (no incidental trigger-(b) fire in the same call).
    plan = {
        "expectedScope": {"maxFiles": 2},
        "candidateFiles": [
            {"path": "a.py", "reason": "x", "confidence": 0.9},
            {"path": "b.py", "reason": "y", "confidence": 0.8},
            {"path": "c.py", "reason": "z", "confidence": 0.7},
        ],
    }
    result_a = _evaluate_advisory_triggers(plan, {"a.py", "b.py", "c.py"}, 0, 10, fired)
    assert result_a == [
        (
            "new_file_count_exceeds_plan",
            "changed file count (3) exceeds the architecture plan's estimate (2)",
        )
    ], result_a
    assert "new_file_count_exceeds_plan" in fired

    # Same over-threshold state again: must NOT re-fire.
    result_a_again = _evaluate_advisory_triggers(plan, {"a.py", "b.py", "c.py"}, 0, 10, fired)
    assert not any(k == "new_file_count_exceeds_plan" for k, _ in result_a_again), (
        "trigger (a) must fire at most once per session"
    )

    # (b) a changed path outside candidateFiles.
    result_b = _evaluate_advisory_triggers(plan, {"z.py"}, 0, 10, fired)
    assert result_b == [
        (
            "edit_outside_candidate_files",
            "changed file 'z.py' is outside the architecture plan's candidateFiles",
        )
    ], result_b
    assert "edit_outside_candidate_files" in fired

    result_b_again = _evaluate_advisory_triggers(plan, {"z.py", "y.py"}, 0, 10, fired)
    assert not any(k == "edit_outside_candidate_files" for k, _ in result_b_again), (
        "trigger (b) must fire at most once per session"
    )

    # (c) turn count > 60% of max_turns with zero writes -- independent of
    # a plan existing at all (plan=None here).
    fired_c = set()
    result_c = _evaluate_advisory_triggers(None, set(), 6, 10, fired_c)
    assert result_c == [
        (
            "turns_high_no_writes",
            "turn 7/10 (over 60% of the turn budget) with no repository write yet",
        )
    ], result_c
    assert "turns_high_no_writes" in fired_c

    result_c_again = _evaluate_advisory_triggers(None, set(), 9, 10, fired_c)
    assert result_c_again == [], "trigger (c) must fire at most once per session"

    # (c) must not fire once a write has occurred.
    fired_c2 = set()
    result_c2 = _evaluate_advisory_triggers(None, {"x.py"}, 9, 10, fired_c2)
    assert result_c2 == [], "trigger (c) must not fire once a write has occurred"

    # A plan with no positive estimate at all (no expectedScope.maxFiles,
    # empty candidateFiles) must never fire (a) -- no 0-vs-anything false
    # positive.
    fired_d = set()
    empty_plan = {"expectedScope": {}, "candidateFiles": []}
    result_d = _evaluate_advisory_triggers(
        empty_plan, {"a.py", "b.py", "c.py", "d.py", "e.py"}, 0, 10, fired_d
    )
    assert result_d == [], "trigger (a) must not fire with a zero/absent estimate"

    # Review round 1 (LOW): path normalization -- a candidateFiles entry
    # written as "./src/x.ts" must match a changed path recorded as
    # "src/x.ts" (no false nudge from a cosmetic path-form difference).
    fired_e = set()
    dotted_plan = {
        "expectedScope": {},
        "candidateFiles": [{"path": "./src/x.ts", "reason": "x", "confidence": 0.9}],
    }
    result_e = _evaluate_advisory_triggers(dotted_plan, {"src/x.ts"}, 0, 10, fired_e)
    assert result_e == [], (
        "'./src/x.ts' candidate must match 'src/x.ts' changed path after normalization"
    )
    # A genuinely different path still fires.
    result_e2 = _evaluate_advisory_triggers(dotted_plan, {"other.ts"}, 0, 10, fired_e)
    assert result_e2 == [
        (
            "edit_outside_candidate_files",
            "changed file 'other.ts' is outside the architecture plan's candidateFiles",
        )
    ], result_e2

    # ------------------------------------------------------------
    # 2. Nudge message shape + real wiring into run_engineer (source
    #    inspection, same style as _plan_aware_budget_selfcheck /
    #    _gate_allow_write_file_selfcheck above).
    # ------------------------------------------------------------
    nudge = _format_advisory_nudge("some reason")
    assert nudge == (
        "ADVISORY: some reason. Consider consulting the architect before continuing."
    ), nudge

    engineer_source = inspect.getsource(run_engineer)
    assert "_evaluate_advisory_triggers(" in engineer_source, (
        "run_engineer must actually call _evaluate_advisory_triggers, not just define it"
    )
    assert "_format_advisory_nudge(" in engineer_source
    assert '"architect_consult_advised"' in engineer_source
    assert "advisory_fired" in engineer_source

    # ------------------------------------------------------------
    # 3. consult_architect tool gating: offered only when BOTH an
    #    architecture plan exists AND --architect-consult-enabled.
    # ------------------------------------------------------------
    for enabled, has_plan, expect_present in (
        (False, False, False),
        (False, True, False),
        (True, False, False),
        (True, True, True),
    ):
        metadata = {}
        tools = []
        fake_plan = (
            {"objective": "x", "packages": [], "risk": "low"} if has_plan else None
        )
        _augment_tools_with_consult_architect(metadata, tools, fake_plan, enabled)
        present = "consult_architect" in metadata
        assert present == expect_present, (
            f"enabled={enabled} has_plan={has_plan}: "
            f"expected tool present={expect_present}, got {present}"
        )
        assert (len(tools) == 1) == expect_present

    # ------------------------------------------------------------
    # 4. Budget exhaustion: execute_tool returns an ok:false envelope
    #    with error code CONSULT_BUDGET_EXHAUSTED once the budget is
    #    used up -- and never reaches the model to get there. Requires
    #    the tool to actually be "offered" (enabled + plan loaded) so
    #    this exercises the budget path, not the structural gate below.
    # ------------------------------------------------------------
    global _consult_architect_used, _architect_consult_enabled, _loaded_architecture_plan
    real_used = _consult_architect_used
    real_enabled = _architect_consult_enabled
    real_plan = _loaded_architecture_plan
    try:
        _consult_architect_used = CONSULT_ARCHITECT_BUDGET
        _architect_consult_enabled = True
        _loaded_architecture_plan = {"objective": "x", "packages": [], "risk": "low"}

        result_text_out, changed = execute_tool(
            "consult_architect",
            {"question": "is this the right abstraction?"},
            Path("."),
            {"approve_all": True},
            {},
            [],
        )
        assert changed is False
        assert "CONSULT_BUDGET_EXHAUSTED" in result_text_out, result_text_out
        assert _consult_architect_used == CONSULT_ARCHITECT_BUDGET, (
            "an already-exhausted budget must not keep incrementing"
        )

        # ------------------------------------------------------------
        # 5. Review round 1 (MED): unoffered-call denial. Even with
        #    budget remaining, a call must be denied -- with NO budget
        #    burn and no model call -- whenever the tool wasn't actually
        #    offered (flag off, or no plan loaded).
        # ------------------------------------------------------------
        for enabled, plan_loaded in ((False, True), (True, False), (False, False)):
            _consult_architect_used = 0
            _architect_consult_enabled = enabled
            _loaded_architecture_plan = (
                {"objective": "x", "packages": [], "risk": "low"} if plan_loaded else None
            )

            denied_text, denied_changed = execute_tool(
                "consult_architect",
                {"question": "is this the right abstraction?"},
                Path("."),
                {"approve_all": True},
                {},
                [],
            )
            assert denied_changed is False
            assert "CONSULT_NOT_OFFERED" in denied_text, (
                f"enabled={enabled} plan_loaded={plan_loaded}: {denied_text}"
            )
            assert _consult_architect_used == 0, (
                "a denied (unoffered) call must not burn budget"
            )
    finally:
        _consult_architect_used = real_used
        _architect_consult_enabled = real_enabled
        _loaded_architecture_plan = real_plan

    print("consult self-check: PASS")


# ============================================================
# ENGINEERING LOOP
# ============================================================

def _plan_aware_discovery_budget():
    """C1 handoff enforcement (Fix 2): when glimmer-v2.py's --architect-
    first handoff actually embedded pre-read candidate-file evidence in
    this run's prompt (Fix 1), the engineer already has that evidence and
    doesn't need the full discovery_tool_budget to re-explore the
    repository from scratch — see docs/c1-measured-gate-results.md, which
    measured 5 discovery calls with a plan vs. 4 without one on a smoke
    repo. GLIMMER_PLAN_CANDIDATES is code-enforced, not prompt prose: it
    directly gates the tool-router narrowing budget below, not just
    something mentioned in the prompt text.

    Fails open to the normal budget (8) on anything that isn't a clean
    positive integer — unset, empty, non-numeric ("abc"), zero, or
    negative — so a malformed/missing env var can never crash this
    process or silently over-restrict a normal (non-plan) run.
    """
    if not GLIMMER_PLAN_CANDIDATES:
        return 8
    try:
        n = int(GLIMMER_PLAN_CANDIDATES)
    except ValueError:
        return 8
    return 3 if n > 0 else 8


def _plan_aware_budget_selfcheck() -> None:
    """C1 handoff enforcement (Fix 2): proves discovery_tool_budget is
    driven by the real GLIMMER_PLAN_CANDIDATES module global that
    run_engineer reads at startup (_plan_aware_discovery_budget), and
    that malformed/absent values fail open to the safe default (8)
    rather than crashing or over-restricting a normal run.
    Run with: python3 glimmer-engineer.py --plan-aware-budget-selfcheck
    """
    global GLIMMER_PLAN_CANDIDATES

    real_value = GLIMMER_PLAN_CANDIDATES
    try:
        for valid in ("1", "3", "5", "42"):
            GLIMMER_PLAN_CANDIDATES = valid
            assert _plan_aware_discovery_budget() == 3, (
                f"valid positive candidate count {valid!r} must drop budget to 3"
            )

        for malformed in (None, "", "abc", "-1", "0", "  ", "3.5"):
            GLIMMER_PLAN_CANDIDATES = malformed
            assert _plan_aware_discovery_budget() == 8, (
                f"malformed/absent {malformed!r} must fail open to the default budget 8"
            )
    finally:
        GLIMMER_PLAN_CANDIDATES = real_value

    # discovery_tool_budget in run_engineer is assigned directly from this
    # function's return value (not a hardcoded 8) -- confirmed by source
    # inspection so the self-check would break if a future edit reverted
    # run_engineer back to a bare literal without updating this check.
    import inspect
    source = inspect.getsource(run_engineer)
    assert "discovery_tool_budget = _plan_aware_discovery_budget()" in source, (
        "run_engineer must assign discovery_tool_budget from "
        "_plan_aware_discovery_budget(), not a hardcoded literal"
    )

    print("plan-aware-budget self-check: PASS")


def _gate_allow_write_file_selfcheck() -> None:
    """
    Regression test for the R3 tool-router bug (fix: gate-allow-write-
    file): once the discovery gate narrowed active_tools to
    narrowed_to_read_edit / narrowed_to_edit_only, write_file was never
    in either set. edit_file only works on an EXISTING file and
    write_file only on a NEW one (check_write_path), so any task whose
    only legitimate implementation is creating a new file became
    structurally unreachable post-gate -- reproduced live in sessions
    20260818-112524 and 20260818-113308, both ending
    no-change-unverified with the model explicitly citing "blocked by
    current tool availability".

    Verifies via source inspection of the real run_engineer body (no
    live server needed) that:
      1. Both narrowed allowed_before_edit sets now include write_file.
      2. narrowed_to_edit_only offers nothing beyond edit_file/write_file.
      3. Both gate-transition directive messages sent to the model name
         write_file explicitly, not just edit_file.
      4. Architect mode's C1 structural read-only guarantee (proven in
         full by _architect_mode_selfcheck) is unaffected: run_architect
         never references engineer_phase/active_tools at all, so this
         change -- confined to run_engineer -- cannot widen it. Also
         re-checks ARCHITECT_TOOL_NAMES directly here as a second,
         independent proof point next to the router fix.
    Run with: python3 glimmer-engineer.py --gate-allow-write-file-selfcheck
    """
    import ast
    import inspect

    engineer_source = inspect.getsource(run_engineer)

    def _extract_set(anchor: str) -> set:
        idx = engineer_source.index(anchor)
        start = engineer_source.index("{", idx)
        end = engineer_source.index("}", start) + 1
        return ast.literal_eval(engineer_source[start:end])

    edit_only_set = _extract_set(
        'if engineer_phase == "narrowed_to_edit_only":'
    )
    read_edit_set = _extract_set(
        'elif engineer_phase == "narrowed_to_read_edit":'
    )

    assert edit_only_set == {"edit_file", "write_file"}, (
        "narrowed_to_edit_only must offer exactly {edit_file, write_file}, "
        f"got {edit_only_set}"
    )
    assert read_edit_set == {
        "read_file", "grep_search", "edit_file", "write_file",
    }, (
        "narrowed_to_read_edit must include write_file alongside the "
        f"existing read/edit tools, got {read_edit_set}"
    )

    # The directive user messages injected at each gate transition are
    # what the model actually reads when deciding its next legal action
    # -- the tool schema alone isn't enough evidence that creation is
    # still possible if the prose still only names edit_file.
    discovery_msg_idx = engineer_source.index(
        "Repository discovery budget is exhausted."
    )
    discovery_msg = engineer_source[discovery_msg_idx:discovery_msg_idx + 700]
    assert "write_file" in discovery_msg, (
        "discovery-gate directive message must name write_file"
    )

    deadline_msg_idx = engineer_source.index(
        "Candidate verification budget is exhausted."
    )
    deadline_msg = engineer_source[deadline_msg_idx:deadline_msg_idx + 700]
    assert "write_file" in deadline_msg, (
        "decision-deadline directive message must name write_file"
    )

    # Architect mode regression check: run_architect must remain
    # structurally independent of engineer_phase/active_tools, and
    # ARCHITECT_TOOL_NAMES must still exclude every write tool, exactly
    # as proven at length in _architect_mode_selfcheck. Re-asserted here
    # so THIS self-check fails on its own if a future change ever wires
    # architect mode into the engineer-phase router.
    architect_tree = ast.parse(inspect.getsource(run_architect))
    architect_names = {
        node.id
        for node in ast.walk(architect_tree)
        if isinstance(node, ast.Name)
    }
    assert "engineer_phase" not in architect_names, (
        "run_architect must never USE engineer_phase as a real name "
        "(docstring mentions for contrast are fine) -- it has its own "
        "separate, fixed, read-only tool set"
    )
    assert "active_tools" not in architect_names, (
        "run_architect must never USE active_tools as a real name "
        "(docstring mentions for contrast are fine) -- it has its own "
        "separate, fixed, read-only tool set"
    )
    assert "write_file" not in ARCHITECT_TOOL_NAMES, (
        "architect tool set must never offer write_file"
    )
    assert "edit_file" not in ARCHITECT_TOOL_NAMES, (
        "architect tool set must never offer edit_file"
    )

    print("gate-allow-write-file self-check: PASS")


def _semantic_tools_selfcheck() -> None:
    """O4 (glimmer-v7 reconciliation §3.11): find_symbol / find_references /
    find_related_tests. Builds a real scratch workspace on disk (no live
    llama-server needed — these tools never call http_json at all) and
    proves:
      1. find_symbol finds a planted TS function and a planted Python class.
      2. find_references is word-boundary correct (name "foo" does not
         match a line whose only occurrence is "foobar").
      3. find_related_tests finds both a same-basename X.test.ts and an
         indirectly-related file that imports the basename.
      4. Hostile inputs: regex metacharacters are escaped (name=".*" finds
         nothing, not everything); a 500-char name is rejected; a path
         outside the workspace is rejected via the existing containment
         (resolve_workspace_path/secure_tool_arguments — no new scheme).
      5. Ignore-directory discipline: a planted file under node_modules is
         never found.
      6. Results flow through the NORMAL dispatch path in execute_tool:
         a repeat call is served from the existing (tool, args) cache
         (never re-executes the underlying scan), and a real evidence
         entry is persisted via the existing add_evidence/evidence-NN.jsonl
         machinery.
    Run with: python3 glimmer-engineer.py --semantic-tools-selfcheck
    """
    import inspect
    import tempfile

    global GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID

    with tempfile.TemporaryDirectory() as td:
        ws = Path(td).resolve()

        (ws / "src").mkdir()
        (ws / "node_modules" / "ignored").mkdir(parents=True)

        (ws / "src" / "widget.ts").write_text(
            "export function createWidget(name: string) {\n"
            "  return { name };\n"
            "}\n"
        )
        (ws / "src" / "models.py").write_text(
            "class UserModel:\n"
            "    pass\n"
        )
        (ws / "src" / "widget.test.ts").write_text(
            'import { createWidget } from "./widget";\n'
            'test("creates widget", () => { createWidget("x"); });\n'
        )
        # Indirectly related: test-shaped (matches *.spec.*) but its own
        # basename ("widget_helpers") is not "widget" — only found via the
        # content-import check, not the same-basename check.
        (ws / "src" / "widget_helpers.spec.ts").write_text(
            'import { createWidget } from "../widget";\n'
            'test("helper uses widget", () => {});\n'
        )
        (ws / "src" / "refs.ts").write_text(
            "const foo = 1;\n"
            "const foobar = 2;\n"
            "function useFoobarOnly() {\n"
            "  return foobar;\n"
            "}\n"
            "console.log(foo);\n"
        )
        # Planted inside an ignored directory: must never surface in any
        # semantic tool result, exactly like glimmer-v2.py's walk_files
        # never descends into node_modules.
        (ws / "node_modules" / "ignored" / "widget.ts").write_text(
            "export function createWidget() { return 'should be ignored'; }\n"
        )
        # Binary file: must be skipped outright (no errors="ignore" decode-
        # and-scan), not crash the walk. Content includes a "foo" byte
        # sequence so a wrongly-lenient decode would have made it match
        # find_references("foo") below.
        (ws / "src" / "binary.bin").write_bytes(b"\xff\xfe\x00foo\x00\xff")

        # Deeply nested file (depth 6) — same max_depth=5 default/
        # convention as glimmer-v2.py's walk_files; must never be found.
        deep_dir = ws
        for part in ("d1", "d2", "d3", "d4", "d5", "d6"):
            deep_dir = deep_dir / part
        deep_dir.mkdir(parents=True)
        (deep_dir / "deepWidget.ts").write_text(
            "export function deepWidget() { return 'too deep'; }\n"
        )

        # ------------------------------------------------------------
        # 1. find_symbol: TS function + Python class.
        # ------------------------------------------------------------
        symbol_result = find_symbol("createWidget", None, ws)
        assert "src/widget.ts:1:" in symbol_result, symbol_result
        assert "node_modules" not in symbol_result, (
            "find_symbol must never surface matches from an ignored directory"
        )

        class_result = find_symbol("UserModel", "class", ws)
        assert "src/models.py:1:" in class_result, class_result

        # kind filter narrows correctly: a "class" search must not also
        # return the (nonexistent) function-shaped hit.
        no_such_kind = find_symbol("UserModel", "function", ws)
        assert "No definitions" in no_such_kind, no_such_kind

        # Binary file skipped outright: _semantic_read_text must return
        # None (never a garbage-decoded string via errors="ignore").
        assert _semantic_read_text(ws / "src" / "binary.bin") is None, (
            "binary files must be skipped, not decoded with errors='ignore'"
        )

        # Depth-6 file never found: same max_depth=5 convention as
        # glimmer-v2.py's walk_files.
        deep_result = find_symbol("deepWidget", None, ws)
        assert "No definitions" in deep_result, (
            f"a file 6 directories deep must not be walked (max_depth=5), got: {deep_result!r}"
        )

        # ------------------------------------------------------------
        # 2. find_references: word-boundary correctness.
        # ------------------------------------------------------------
        refs_result = find_references("foo", ws)
        assert "Found 2 reference(s)" in refs_result, refs_result
        assert "const foo = 1;" in refs_result
        assert "console.log(foo);" in refs_result
        assert "const foobar = 2;" not in refs_result, (
            "'foo' must not match inside 'foobar' (word-boundary correctness)"
        )
        assert "return foobar;" not in refs_result

        # ------------------------------------------------------------
        # 3. find_related_tests: same-basename + content-import match.
        # ------------------------------------------------------------
        tests_result = find_related_tests(str(ws / "src" / "widget.ts"), ws)
        assert "src/widget.test.ts" in tests_result, tests_result
        assert "src/widget_helpers.spec.ts" in tests_result, tests_result
        assert "node_modules" not in tests_result

        # ------------------------------------------------------------
        # 4. Hostile inputs.
        # ------------------------------------------------------------
        # Regex metacharacters escaped: a literal ".*" search must find
        # nothing (proving re.escape is applied), not match every line the
        # way an unescaped ".*" would.
        wildcard_symbol = find_symbol(".*", None, ws)
        assert "No definitions" in wildcard_symbol, (
            f"'.*' must be escaped to a literal, inert pattern, got: {wildcard_symbol!r}"
        )
        wildcard_refs = find_references(".*", ws)
        assert "No references" in wildcard_refs, (
            f"'.*' must be escaped to a literal, inert pattern, got: {wildcard_refs!r}"
        )

        # Over-length name rejected.
        too_long = "x" * 500
        try:
            find_symbol(too_long, None, ws)
            raise AssertionError("500-char name must be rejected")
        except ValueError:
            pass
        try:
            find_references(too_long, ws)
            raise AssertionError("500-char name must be rejected")
        except ValueError:
            pass

        # Empty name rejected.
        try:
            find_references("", ws)
            raise AssertionError("empty name must be rejected")
        except ValueError:
            pass

        # Path outside the workspace rejected via the EXISTING containment
        # mechanism (resolve_workspace_path via secure_tool_arguments,
        # since find_related_tests is in PATH_TOOLS) — exercised through
        # execute_tool, the real dispatch entry point, not a hand-rolled
        # check.
        try:
            execute_tool(
                "find_related_tests",
                {"path": "../../../etc/passwd"},
                ws,
                {"approve_all": True},
                {},
                [],
            )
            raise AssertionError("path escaping the workspace must be rejected")
        except PermissionError as exc:
            assert "escapes repository" in str(exc), str(exc)

        # ------------------------------------------------------------
        # 5. Normal dispatch path: cache hit + evidence persistence.
        # ------------------------------------------------------------
        global _execute_semantic_tool
        real_dispatch = _execute_semantic_tool
        calls = []

        def _counting_dispatch(tool_name, arguments, workspace):
            calls.append(tool_name)
            return real_dispatch(tool_name, arguments, workspace)

        _execute_semantic_tool = _counting_dispatch

        real_events_path = GLIMMER_EVENTS_PATH
        real_session_id = GLIMMER_SESSION_ID

        try:
            session_dir = Path(td) / "_session"
            session_dir.mkdir()
            (session_dir / "prompt-00.txt").write_text("iteration 0")
            GLIMMER_EVENTS_PATH = str(session_dir / "events.jsonl")
            GLIMMER_SESSION_ID = "sess-semantic-selfcheck"
            _evidence_file_path.cache_clear()

            cache = {}
            ledger = []

            result1, changed1 = execute_tool(
                "find_symbol",
                {"name": "createWidget"},
                ws,
                {"approve_all": True},
                cache,
                ledger,
            )
            assert changed1 is False, "semantic tools are read-only; must never report a change"
            assert len(calls) == 1, "first call must actually execute the scan"

            result2, changed2 = execute_tool(
                "find_symbol",
                {"name": "createWidget"},
                ws,
                {"approve_all": True},
                cache,
                ledger,
            )
            assert result2 == result1
            assert changed2 is False
            assert len(calls) == 1, (
                "repeat call with identical (tool, args) must be served "
                "from the existing read-tool cache, not re-executed"
            )

            evidence_path = session_dir / "evidence-00.jsonl"
            assert evidence_path.exists(), (
                "a semantic tool call must persist to evidence-NN.jsonl "
                "exactly like read_file/grep_search"
            )
            records = [json.loads(line) for line in evidence_path.read_text().splitlines()]
            assert any(r["tool"] == "find_symbol" for r in records), records
            assert any(ln.startswith("TOOL: find_symbol") for ln in ledger), ledger
        finally:
            _execute_semantic_tool = real_dispatch
            GLIMMER_EVENTS_PATH = real_events_path
            GLIMMER_SESSION_ID = real_session_id
            _evidence_file_path.cache_clear()

        # ------------------------------------------------------------
        # 6. Tool router wiring: available in architect mode, in the
        #    engineer discovery/narrowed-to-read-edit tool sets, excluded
        #    from narrowed_to_edit_only, and counted in discovery_tools.
        # ------------------------------------------------------------
        assert SEMANTIC_TOOL_NAMES <= ARCHITECT_TOOL_NAMES, (
            "semantic tools must be offered in architect mode (read-only, "
            "same as READ_TOOLS)"
        )

        engineer_source = inspect.getsource(run_engineer)
        # discovery_tools / post_gate_inspection_tools: must union in
        # SEMANTIC_TOOL_NAMES so calls count against both budgets.
        assert engineer_source.count("| SEMANTIC_TOOL_NAMES") >= 3, (
            "expected SEMANTIC_TOOL_NAMES unioned into discovery_tools, "
            "post_gate_inspection_tools, and narrowed_to_read_edit's "
            "allowed_before_edit"
        )
        # narrowed_to_edit_only's literal set must stay exactly
        # {edit_file, write_file} — no union, semantic tools withdrawn
        # once that budget is exhausted (deliberate, documented choice).
        edit_only_idx = engineer_source.index('if engineer_phase == "narrowed_to_edit_only":')
        edit_only_window = engineer_source[edit_only_idx:edit_only_idx + 400]
        assert "| SEMANTIC_TOOL_NAMES" not in edit_only_window, (
            "narrowed_to_edit_only must NOT offer the semantic tools"
        )

        # get_tools()'s metadata dict must carry these three names so the
        # `tool_name not in metadata` unknown-tool check (both run_engineer
        # and run_architect) never rejects them, exactly as it would a
        # real server tool.
        definition_names = {item["tool"] for item in SEMANTIC_TOOL_DEFINITIONS}
        assert definition_names == SEMANTIC_TOOL_NAMES

    print("semantic tools (O4) self-check: PASS")


def _failure_memory_selfcheck() -> None:
    """O3 (glimmer-v7 reconciliation): failure-memory self-check -- no
    live model or session needed. Covers write/dedupe/count, the
    BLOCKED_COMMANDS_CAP LRU cap, the prompt-injection addendum (present
    only when memory exists, most-frequent first, capped to both
    MAX_BLOCKED_MEMORY_ITEMS and MAX_BLOCKED_MEMORY_CHARS), and
    never-raises behavior on an unwritable memory directory / corrupt
    on-disk JSON. Run with:
    python3 glimmer-engineer.py --failure-memory-selfcheck
    """
    global MUSE_GLIMMER_HOME
    import tempfile as _tempfile

    real_home = MUSE_GLIMMER_HOME
    try:
        with _tempfile.TemporaryDirectory() as td, _tempfile.TemporaryDirectory() as home_td:
            MUSE_GLIMMER_HOME = Path(home_td)
            ws = Path(td)

            # ------------------------------------------------------------
            # 1. Zero behavior change: no memory file yet -> "" addendum.
            # ------------------------------------------------------------
            repo = ws / "repo"
            repo.mkdir()
            assert failure_memory_addendum(repo) == ""

            # ------------------------------------------------------------
            # 2. Write + dedupe + count.
            # ------------------------------------------------------------
            record_blocked_command(repo, "rm -rf /", "destructive path blocked")
            record_blocked_command(repo, "rm -rf /", "destructive path blocked")
            record_blocked_command(repo, "npm install left-pad", "install blocked")

            mem_path = _blocked_commands_path(repo)
            entries = json.loads(mem_path.read_text(encoding="utf-8"))
            assert len(entries) == 2, "duplicate command must dedupe into one entry"
            rm_entry = next(e for e in entries if e["command"] == "rm -rf /")
            assert rm_entry["count"] == 2
            assert rm_entry["reason"] == "destructive path blocked"
            assert "lastSeen" in rm_entry

            # ------------------------------------------------------------
            # 3. LRU cap at BLOCKED_COMMANDS_CAP entries -- oldest evicted.
            # ------------------------------------------------------------
            for i in range(BLOCKED_COMMANDS_CAP + 10):
                record_blocked_command(repo, f"cmd-{i}", "blocked")
            entries2 = json.loads(mem_path.read_text(encoding="utf-8"))
            assert len(entries2) == BLOCKED_COMMANDS_CAP
            commands = {e["command"] for e in entries2}
            assert "rm -rf /" not in commands, "oldest entries must be evicted past the cap"
            assert "npm install left-pad" not in commands
            assert f"cmd-{BLOCKED_COMMANDS_CAP + 9}" in commands, "most recent entry must survive"

            # ------------------------------------------------------------
            # 4. Injection text: present only when memory exists, sorted
            #    most-frequent first, capped in item count and chars.
            # ------------------------------------------------------------
            fresh_repo = ws / "repo2"
            fresh_repo.mkdir()
            assert failure_memory_addendum(fresh_repo) == "", "no memory file -> no addendum"

            record_blocked_command(fresh_repo, "git push origin main", "push blocked")
            record_blocked_command(fresh_repo, "git push origin main", "push blocked")
            record_blocked_command(fresh_repo, "npm run deploy", "deploy blocked")
            addendum = failure_memory_addendum(fresh_repo)
            assert addendum != ""
            assert "git push origin main" in addendum
            assert addendum.index("git push origin main") < addendum.index("npm run deploy"), (
                "higher-count entry must sort first"
            )
            assert len(addendum) <= MAX_BLOCKED_MEMORY_CHARS

            many_repo = ws / "repo3"
            many_repo.mkdir()
            for i in range(30):
                record_blocked_command(
                    many_repo,
                    f"blocked-command-number-{i:03d}-with-a-somewhat-long-name",
                    "blocked because policy said so, at some length",
                )
            big_addendum = failure_memory_addendum(many_repo)
            assert len(big_addendum) <= MAX_BLOCKED_MEMORY_CHARS
            assert big_addendum.count("- '") <= MAX_BLOCKED_MEMORY_ITEMS

            # ------------------------------------------------------------
            # 5. Never-raises: unwritable memory dir / corrupt on-disk
            #    JSON must never crash a session -- same discipline as
            #    C1/C3/C6's best-effort writers.
            # ------------------------------------------------------------
            unwritable_repo = ws / "repo4"
            unwritable_repo.mkdir()
            real_mkdir = Path.mkdir

            def _boom(self, *a, **kw):
                raise OSError("permission denied (simulated)")

            Path.mkdir = _boom
            try:
                record_blocked_command(unwritable_repo, "anything", "anything")  # must not raise
            finally:
                Path.mkdir = real_mkdir
            assert not _blocked_commands_path(unwritable_repo).exists()
            assert failure_memory_addendum(unwritable_repo) == ""

            corrupt_repo = ws / "repo5"
            corrupt_repo.mkdir()
            corrupt_path = _blocked_commands_path(corrupt_repo)
            corrupt_path.parent.mkdir(parents=True, exist_ok=True)
            corrupt_path.write_text("not json{{{", encoding="utf-8")
            assert failure_memory_addendum(corrupt_repo) == "", "corrupt JSON must degrade to no addendum"
            record_blocked_command(corrupt_repo, "x", "y")  # must not raise; self-heals
            entries_after = json.loads(corrupt_path.read_text(encoding="utf-8"))
            assert len(entries_after) == 1 and entries_after[0]["command"] == "x"
    finally:
        MUSE_GLIMMER_HOME = real_home

    print("failure memory (O3) self-check: PASS")


def run_engineer(
    task,
    workspace,
    max_turns,
    auto_yes,
    architect_consult_enabled=False,
):
    workspace = (
        workspace
        .expanduser()
        .resolve()
    )

    if not workspace.is_dir():
        raise RuntimeError(
            f"Workspace missing: {workspace}"
        )

    git_root = Path(
        git_local(
            workspace,
            "rev-parse",
            "--show-toplevel",
        )
    ).resolve()

    if git_root != workspace:
        raise RuntimeError(
            "Engineering workspace must "
            "be the git repository root.\n"
            f"Workspace: {workspace}\n"
            f"Git root:  {git_root}"
        )

    metadata, tools = get_tools()

    # Task 2.4 (V7 §5.5 second half): load once, same convention as
    # validation_allowlist below -- architecture-plan.json (when present)
    # doesn't change mid-session. Drives both the deterministic advisory
    # triggers (regardless of architect_consult_enabled) and, gated by
    # that flag too, whether consult_architect is offered at all.
    global _loaded_architecture_plan, _architect_consult_enabled
    _loaded_architecture_plan = _load_architecture_plan_for_engineer()
    architecture_plan = _loaded_architecture_plan
    _architect_consult_enabled = architect_consult_enabled

    _augment_tools_with_consult_architect(
        metadata, tools, architecture_plan, architect_consult_enabled,
    )

    # R5 (glimmer-v7): load once per session, not per shell_policy call —
    # repo-map.json doesn't change mid-session.
    validation_allowlist = (
        load_validation_script_allowlist()
    )

    baseline_status = git_local(
        workspace,
        "status",
        "--short",
    )

    dirty = [
        line
        for line
        in baseline_status.splitlines()
        if line.strip()
    ]

    print(
        "Glimmer Engineering Mode v1"
    )
    print(
        f"Workspace: {workspace}"
    )
    print(
        "Model:     muse-glimmer"
    )
    print(
        f"Tools:     {len(tools)}"
    )
    print(
        "Safety:    enforced"
    )
    print(
        "Commit:    BLOCKED"
    )
    print(
        "Push:      BLOCKED"
    )
    print(
        "Deploy:    BLOCKED"
    )
    print(
        "Install:   BLOCKED"
    )
    print(
        f"Existing dirty entries: {len(dirty)}"
    )
    print()

    # --------------------------------------------------------
    # SESSION OWNERSHIP
    # --------------------------------------------------------
    #
    # Engineering write sessions must begin from a clean
    # working tree. This prevents a fresh Glimmer session from
    # adopting edits created by a previous interrupted run or
    # by the user.
    #
    # Explicit resume support can be added separately later.
    # Until then, fail closed.
    # --------------------------------------------------------

    if dirty:
        print(
            "✗ SESSION BLOCKED: working tree is not clean."
        )
        print(
            "  A new engineering write session may not "
            "adopt pre-existing changes."
        )
        print()
        print("Existing changes:")

        for entry in dirty[:20]:
            print("  " + entry)

        if len(dirty) > 20:
            print(
                f"  ... and {len(dirty) - 20} more"
            )

        raise RuntimeError(
            "Engineering session requires a clean working "
            "tree. Review, restore, commit, or otherwise "
            "resolve existing changes before starting a "
            "new Glimmer write session."
        )

    baseline_preview = "\n".join(
        dirty[:100]
    )

    system = (
        "Reasoning strength: high. "
        "You are a senior software engineering "
        "agent operating inside one git repository. "

        "Inspect the actual implementation before "
        "making repository-specific claims or edits. "

        "Make the smallest correct change. "
        "Preserve unrelated user changes. "

        "Use edit_file for existing files. "
        "Use write_file only for genuinely new files. "

        "Never attempt dependency installation, "
        "git commit, git push, git reset, git clean, "
        "git checkout, git switch, git stash, "
        "git merge, git rebase, database migrations, "
        "production commands, releases or deployment. "

        "Never edit secrets or environment files. "

        "After editing, inspect git diff. "
        "Run relevant non-destructive typecheck or "
        "unit tests. Run git diff --check. "

        "Once you have made a successful edit and then "
        "run a validation command (npm run <script>, "
        "cargo check/test, or python -m py_compile), "
        "repository writes freeze: a pass, failure, or "
        "timeout is final evidence, and further edit_file "
        "or write_file calls will be blocked. Finish your "
        "report from that result instead of retrying. "

        "Do not claim that validation passed unless "
        "you actually ran the validation command and "
        "observed a successful result. "

        "If the repository already contains unrelated "
        "errors, clearly distinguish those from errors "
        "caused by your change. "

        "When finished, report exact files changed, "
        "commands run, validation results and "
        "remaining risk."
    )

    if baseline_preview:
        system += (
            "\n\nIMPORTANT: These working-tree "
            "changes existed before this session. "
            "Treat them as user-owned and do not "
            "overwrite unrelated changes:\n"
            + baseline_preview
        )

    # O3 (glimmer-v7 reconciliation): failure memory. Injected only when
    # this repo has prior tool_blocked history -- zero behavior change
    # (no addendum, no injected text at all) for every repo that has
    # never tripped shell_policy/the architect write-gate.
    system += failure_memory_addendum(workspace)

    # Task 1.2 (context_selected): glimmer-v2.py's make_prompt already
    # merges TASK CONTRACT/plan/skills/evidence into one `task` string
    # before this subprocess ever sees it (invoke_engineer passes it as a
    # single CLI arg) -- there is no separate skills/evidence value here
    # to size independently without v2.py passing structured byte counts
    # across that boundary.
    #
    # Task 5.1 (V7 §7): upgraded to the explicit tier shape --
    # tier0Chars (system + task: permanent, Round 1's systemBytes/
    # taskBytes collapsed into one number since both are part of the same
    # never-compacted Tier0), tier1Chars (active tool-result history live
    # in `messages`, 0 at this point -- no tool call has happened yet),
    # tier2Refs (evidence entries so far pushed out to Tier2 stubs, 0 at
    # start), tier3Note (a static description of what's cold/on-disk;
    # never a byte count -- Tier3 is never loaded). Re-emitted below
    # (inside the turn loop) only when compaction actually moves
    # something to Tier2 -- see _compact_tier1_to_tier2's call site.
    _emit(
        "context_selected",
        tier0Chars=len(system) + len(task),
        tier1Chars=0,
        tier2Refs=0,
        tier3Note=TIER3_COLD_NOTE,
    )

    messages = [
        {
            "role": "system",
            "content": system,
        },
        {
            "role": "user",
            "content": task,
        },
    ]

    approvals = {
        "approve_all": auto_yes,
    }

    cache = {}
    ledger = []
    changed_paths = set()

    # Task 5.1: call_id -> the single persisted evidence id that tool
    # call produced (populated right after each real execute_tool() call
    # in the turn loop below via _LAST_TOOL_ENVELOPE_EVIDENCE_IDS), and a
    # running count of how many Tier1 messages have been pushed to Tier2
    # so far (for context_selected's tier2Refs field).
    tool_evidence_by_call_id = {}
    tier2_ref_count = 0

    # Task 2.4 (V7 §5.5 second half): the once-per-session fired-set
    # shared by all three deterministic advisory triggers (see
    # _evaluate_advisory_triggers above). Trigger (a) reads changed_paths
    # directly (Fix round 2) -- no separate new-file counter needed.
    advisory_fired = set()

    diff_checked = False
    validation_checked = False

    # R5 (glimmer-v7): local verification state (see repository_write_
    # guard_decision above / ADR-0002). "verified" is monotonic — once a
    # post-write validation command has been attempted, it never resets,
    # so repository writes stay frozen for the rest of this process.
    engineer_state = "preflight"

    # Prevent the model from spending the entire turn budget
    # repeatedly exploring the repository without selecting
    # a concrete engineering candidate.
    #
    # C1 handoff enforcement (Fix 2): plan-aware — drops to 3 when a real
    # architect-plan evidence handoff is active for this run (see
    # _plan_aware_discovery_budget). The narrowing machinery below
    # (engineer_phase, discovery_calls >= discovery_tool_budget) is
    # unchanged; only this constant becomes conditional.
    discovery_calls = 0
    discovery_tool_budget = _plan_aware_discovery_budget()

    # After broad discovery, allow only a very small number of
    # calls to verify the selected candidate before forcing a
    # concrete edit/no-edit decision.
    post_gate_inspection_calls = 0
    post_gate_inspection_budget = 3

    # R3 (glimmer-v7): single engineer-loop-scoped phase variable that drives
    # active_tools, replacing the old writes_made / discovery_gate_sent /
    # decision_deadline_sent boolean trio. This is a SEPARATE, smaller scope
    # from the session-level manifest["state"] written by glimmer-v2.py — do
    # not conflate the two. Monotonic, "writing" is absorbing:
    #   discovering -> narrowed_to_read_edit -> narrowed_to_edit_only
    #   (any phase) -> writing   [on first successful repository write]
    # diff_checked / validation_checked stay separate variables: they track
    # per-write verification completeness and reset on every write.
    # engineer_state (R5) is a third, orthogonal axis — it does NOT reset on
    # write, because its whole purpose is to freeze writes permanently once
    # reached (see repository_write_guard_decision).
    engineer_phase = "discovering"
    _emit_engineer_phase(engineer_phase)

    # O4: find_symbol/find_references/find_related_tests are discovery
    # calls exactly like file_glob_search/grep_search/read_file, so they
    # count against the SAME discovery_tool_budget and (once narrowed)
    # the SAME post_gate_inspection_budget — a model couldn't otherwise
    # dodge either budget by switching to a semantic tool mid-exploration.
    discovery_tools = {
        "file_glob_search",
        "grep_search",
        "read_file",
    } | SEMANTIC_TOOL_NAMES

    post_gate_inspection_tools = {
        "read_file",
        "grep_search",
    } | SEMANTIC_TOOL_NAMES

    # C6 (glimmer-v7): tracks whether THIS turn's response came from
    # final_synthesis (the deterministic no-model fallback) rather than
    # a real model turn. Reset every turn (not just once) because a
    # PEG failure can be transient to a single turn — a later turn's
    # real model response must not be treated as a synthesis result.
    used_final_synthesis = False

    for turn in range(max_turns):

        used_final_synthesis = False

        active_tools = tools

        # active_tools is driven solely by engineer_phase (R3). Mapping from
        # the old boolean combinations, preserved here for traceability:
        #   decision_deadline_sent and not writes_made -> narrowed_to_edit_only
        #   discovery_gate_sent and not writes_made    -> narrowed_to_read_edit
        #   writes_made (from any prior phase)         -> writing (full tools)
        #   neither gate sent yet, no write yet        -> discovering (full tools)
        if engineer_phase == "narrowed_to_edit_only":
            # Verification budget is exhausted.
            # At this point the model must either edit/write the
            # chosen file or finish without making a change.
            # write_file is included alongside edit_file (fix:
            # gate-allow-write-file) so that a task whose only
            # legitimate implementation is a NEW file remains
            # reachable post-gate -- edit_file only works on
            # existing files (check_write_path), so without
            # write_file here, creation tasks were structurally
            # blocked once discovery narrowed. The real safety
            # boundary (new-file-only for write_file, protected
            # paths, write-freeze) is enforced at execute_tool
            # dispatch (check_write_path / repository_write_guard_
            # decision), independent of this router.
            allowed_before_edit = {
                "edit_file",
                "write_file",
            }

            active_tools = [
                tool
                for tool in tools
                if (
                    (tool.get("function") or {}).get("name")
                    in allowed_before_edit
                )
            ]

        elif engineer_phase == "narrowed_to_read_edit":
            # O4: the semantic tools are discovery aids alongside
            # read_file/grep_search, so they stay available here — unioned
            # onto the literal (rather than added inside it) so
            # _gate_allow_write_file_selfcheck's source-level extraction of
            # this exact set (read_file/grep_search/edit_file/write_file)
            # keeps proving the property it names. Deliberately NOT carried
            # into narrowed_to_edit_only below: once even that smaller
            # budget is exhausted, every non-edit tool — semantic ones
            # included — is withdrawn.
            # Task 2.4: consult_architect gets the same treatment as the
            # semantic tools -- a second union term (harmless when the
            # tool was never added to `tools` in the first place, per
            # _augment_tools_with_consult_architect's gating) rather than
            # inside the literal, for the same selfcheck-extraction reason.
            allowed_before_edit = {
                "read_file",
                "grep_search",
                "edit_file",
                "write_file",
            } | SEMANTIC_TOOL_NAMES | {"consult_architect"}

            active_tools = [
                tool
                for tool in tools
                if (
                    (tool.get("function") or {}).get("name")
                    in allowed_before_edit
                )
            ]

        payload = {
            "model": "muse-glimmer",
            "messages": messages,
            "tools": active_tools,
            "tool_choice": "auto",
            "parallel_tool_calls": False,
            "max_tokens": 4096,
        }

        # Final turn is always synthesis.
        if turn == max_turns - 1:
            payload.pop(
                "tools",
                None,
            )
            payload.pop(
                "tool_choice",
                None,
            )
            payload.pop(
                "parallel_tool_calls",
                None,
            )

            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Tool budget is exhausted. "
                        "Do not request tools. "
                        "Produce the final engineering "
                        "report from existing evidence."
                    ),
                }
            )

        try:
            response = chat_with_retry(
                payload,
                attempts=3,
            )

        except RuntimeError as exc:
            if (
                "peg-native"
                not in str(exc)
            ):
                raise

            print()
            print(
                "⚠ PEG parser repeatedly failed."
            )
            print(
                "Switching to compact evidence "
                "synthesis."
            )

            response = final_synthesis(
                task,
                ledger,
                changed_paths,
            )
            used_final_synthesis = True

        message = (
            response["choices"][0]["message"]
        )

        content = (
            message.get("content")
            or ""
        )

        tool_calls = (
            message.get("tool_calls")
            or []
        )

        if content and tool_calls:
            print()
            print("GLIMMER:")
            print(content)

        # ----------------------------------------------------
        # MODEL WANTS TO FINISH
        # ----------------------------------------------------

        if not tool_calls:

            if (
                engineer_phase == "writing"
                and turn < max_turns - 1
                and (
                    not diff_checked
                    or not validation_checked
                )
            ):
                messages.append(
                    {
                        "role": "assistant",
                        "content": content,
                    }
                )

                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "You modified repository "
                            "files but post-change "
                            "verification is incomplete. "
                            "Inspect git diff, run "
                            "relevant validation if it has "
                            "not already been attempted, and "
                            "run git diff --check before "
                            "finishing. Do not repeat a "
                            "validation command after a "
                            "pass, failure, or timeout — "
                            "that result is final evidence."
                        ),
                    }
                )

                print()
                print(
                    "↻ Verification gate: "
                    "final answer postponed."
                )

                continue

            print()
            print(
                "════════════════════════════════════"
            )
            print("GLIMMER")
            print(
                "════════════════════════════════════"
            )
            print()
            print(content)

            # C6 (glimmer-v7, V7 §23.7): DeliveryReview companion to the
            # prose report just printed above. Runs for both success and
            # failure outcomes of the engineer loop (§23.12 wants failed
            # tasks to self-explain too) — the prose report above is
            # unconditionally the final answer regardless of outcome, so
            # this always runs right after it. When the prose report
            # itself came from final_synthesis (the model was already
            # failing to produce parseable output), skip the extra model
            # call — one more request against a model that just failed
            # is waste — and write the reviewFailed fallback directly.
            if used_final_synthesis:
                _write_delivery_review_file(
                    _fallback_delivery_review(
                        "skipped: prose report came from the "
                        "deterministic final_synthesis fallback "
                        "(PEG parser already failing this session)"
                    )
                )
            else:
                # Belt-and-suspenders on top of run_delivery_review's own
                # try/except (fix round 1): this call site must survive
                # even if a future edit to that function reintroduces a
                # statement outside its try block. Session outcome must
                # never depend on this turn.
                try:
                    run_delivery_review(task, ledger, content)
                except Exception as exc:  # noqa: BLE001 - see comment above
                    print(f"[glimmer-engineer] delivery review turn failed: {exc}")

            postflight(workspace)

            return

        # ----------------------------------------------------
        # EXECUTE TOOL CALLS
        # ----------------------------------------------------

        for index, call in enumerate(
            tool_calls
        ):
            if not call.get("id"):
                call["id"] = (
                    f"call_{turn}_{index}"
                )

        messages.append(
            {
                "role": "assistant",
                "content":
                    message.get("content"),
                "tool_calls":
                    tool_calls,
            }
        )

        for call in tool_calls:

            function = (
                call.get("function")
                or {}
            )

            tool_name = (
                function.get("name")
                or ""
            )

            # Task 5.1: reset every call iteration so a call that never
            # reaches the real execute_tool() below (unknown tool,
            # repository-write-frozen block, exception) can never
            # attribute a STALE evidence id (left over in the module
            # global from a PREVIOUS call this turn) to this message.
            tool_evidence_ids = []

            # Fix round 1 (MED): get_evidence is context RECOVERY (reading
            # back something already discovered/stubbed), not new
            # exploration -- it stays a member of discovery_tools/
            # post_gate_inspection_tools (SEMANTIC_TOOL_NAMES, so it's
            # still OFFERED wherever those sets gate active_tools) but is
            # exempted here, at the increment sites, from burning either
            # budget. Otherwise a model recovering a Tier2 stub mid-
            # narrowing would be charged as if it were browsing new files.
            if (
                engineer_phase != "writing"
                and tool_name in discovery_tools
                and tool_name != "get_evidence"
            ):
                discovery_calls += 1

            if (
                engineer_phase in (
                    "narrowed_to_read_edit",
                    "narrowed_to_edit_only",
                )
                and tool_name in post_gate_inspection_tools
                and tool_name != "get_evidence"
            ):
                post_gate_inspection_calls += 1

            if tool_name not in metadata:
                result = (
                    "Unknown/unavailable tool: "
                    + tool_name
                )

            else:
                try:
                    arguments = parse_arguments(
                        function.get(
                            "arguments"
                        )
                    )

                    command_for_guard = ""

                    if tool_name == "exec_shell_command":
                        command_for_guard = (
                            arguments
                            .get("command", "")
                            .strip()
                        )

                    repository_write_blocked = (
                        repository_write_guard_decision(
                            tool_name,
                            engineer_state,
                        )
                    )

                    if repository_write_blocked:
                        result = (
                            "ENGINEERING VALIDATION BLOCK: "
                            "repository writes are frozen because "
                            "a post-edit validation command has "
                            "already been attempted. PASS, FAIL, "
                            "or TIMEOUT is terminal verification "
                            "evidence. Do not modify repository "
                            "files after verification."
                        )
                        changed = False

                        print()
                        print(
                            "✗ WRITE BLOCKED: repository is frozen "
                            "after post-edit verification"
                        )

                    else:
                        result, changed = (
                            execute_tool(
                                tool_name,
                                arguments,
                                workspace,
                                approvals,
                                cache,
                                ledger,
                                validation_allowlist,
                            )
                        )

                        # Task 5.1: this call just went through
                        # _persist_tool_envelope (execute_tool's every
                        # return path passes through it), which stashed
                        # this exact envelope's evidence id list.
                        tool_evidence_ids = list(_LAST_TOOL_ENVELOPE_EVIDENCE_IDS)

                        if (
                            tool_name == "exec_shell_command"
                            and engineer_phase == "writing"
                            and engineer_state != "verified"
                            and is_post_write_validation_command(
                                command_for_guard
                            )
                        ):
                            # Mark only after an execution was
                            # actually attempted. A normal command
                            # failure or timeout still counts as
                            # terminal verification evidence (R5).
                            result_text = str(result)

                            execution_was_attempted = not any(
                                marker in result_text
                                for marker in (
                                    "User denied this tool execution.",
                                    "ENGINEERING SECURITY BLOCK:",
                                    "TOOL BLOCKED/ERROR:",
                                )
                            )

                            if execution_was_attempted:
                                # I1: engineer_state is a local write-freeze
                                # marker (see R5 comment above), not a
                                # session-level verification claim. It must
                                # NOT be emitted as agent_state_changed — v2
                                # owns the real "verified" GlimmerSessionStatus
                                # and emits it only once its own verification
                                # actually runs (see readiness_probe /
                                # verification_started in glimmer-v2.py).
                                engineer_state = "verified"

                    if changed:
                        if engineer_phase != "writing":
                            engineer_phase = "writing"
                            _emit_engineer_phase(engineer_phase)
                        diff_checked = False
                        validation_checked = False

                        # Repository state changed. Any cached file reads,
                        # globs, or grep results may now describe stale
                        # pre-edit content, so invalidate the inspection
                        # cache before the model performs post-edit checks.
                        cache.clear()

                        path_value = (
                            arguments.get("path")
                        )

                        if path_value:
                            path = (
                                resolve_workspace_path(
                                    path_value,
                                    workspace,
                                )
                            )

                            changed_paths.add(
                                str(
                                    path.relative_to(
                                        workspace
                                    )
                                )
                            )

                    if (
                        tool_name
                        == "exec_shell_command"
                    ):
                        command = (
                            arguments
                            .get("command", "")
                            .strip()
                        )

                        if (
                            command.startswith(
                                "git diff"
                            )
                            and command
                            != "git diff --check"
                        ):
                            diff_checked = True

                        if (
                            command
                            == "git diff --check"
                        ):
                            validation_checked = True

                        if command.startswith(
                            "npm "
                        ):
                            validation_checked = True

                        if command.startswith(
                            "python3 -m py_compile"
                        ):
                            validation_checked = True

                        if command.startswith(
                            "python -m py_compile"
                        ):
                            validation_checked = True

                        if command.startswith(
                            "cargo check"
                        ):
                            validation_checked = True

                        if command.startswith(
                            "cargo test"
                        ):
                            validation_checked = True

                except Exception as exc:
                    result = (
                        "TOOL BLOCKED/ERROR: "
                        + str(exc)
                    )

                    print()
                    print(
                        "✗ "
                        + result
                    )

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id":
                        call["id"],
                    "content":
                        compact_tool_result_for_model(
                            tool_name,
                            result,
                        ),
                }
            )

            # Task 5.1: remember which evidence id (if any) this tool
            # message's own content can be swapped for later, so
            # _compact_tier1_to_tier2 (below) can move it to Tier2
            # instead of relying on raw truncation.
            if tool_evidence_ids:
                tool_evidence_by_call_id[call["id"]] = tool_evidence_ids[0]

        # ----------------------------------------------------
        # TASK 5.1: CONTEXT TIER COMPACTION (V7 §7/§8)
        # ----------------------------------------------------
        #
        # Runs once per turn, after every tool result for this turn has
        # been appended above. Only re-emits context_selected when
        # something actually moved to Tier2 -- an unconditional per-turn
        # emission was explicitly ruled out as too noisy (V7 §7's
        # "emit... whenever compaction moves items to Tier2").
        #
        # Fix round 1 (HIGH): skipped entirely once engineer_phase ==
        # "narrowed_to_edit_only" -- that phase's active_tools is
        # {edit_file, write_file} only (see the router above), so
        # get_evidence is not offered there. A stub created in that phase
        # would be permanently unrecoverable for the rest of the run,
        # exactly when the model most needs its evidence to make the
        # final edit. This turn's own tool_call_ids are also protected
        # (Fix round 1, MED) so a message never gets stubbed before the
        # model has had a turn to read it.
        if engineer_phase != "narrowed_to_edit_only":
            _newly_compacted = _compact_tier1_to_tier2(
                messages, tool_evidence_by_call_id,
                protected_call_ids={c["id"] for c in tool_calls},
            )
            if _newly_compacted:
                tier2_ref_count += _newly_compacted
                _emit(
                    "context_selected",
                    tier0Chars=len(system) + len(task),
                    tier1Chars=_tier1_chars(messages),
                    tier2Refs=tier2_ref_count,
                    tier3Note=TIER3_COLD_NOTE,
                )

        # ----------------------------------------------------
        # TASK 2.4: MID-IMPLEMENTATION ADVISORY TRIGGERS
        # ----------------------------------------------------
        #
        # Advisory only, never blocks: wrapped in its own try/except so an
        # exception here (a malformed plan field, anything unforeseen)
        # can never break the engineer loop -- _evaluate_advisory_triggers
        # is itself exception-free by construction, but this is belt-and-
        # suspenders on top of it, same discipline as run_delivery_review.
        try:
            newly_fired = _evaluate_advisory_triggers(
                architecture_plan,
                changed_paths,
                turn,
                max_turns,
                advisory_fired,
            )
        except Exception:  # noqa: BLE001 - advisory triggers must never break the loop
            newly_fired = []

        for _trigger_key, _trigger_detail in newly_fired:
            nudge = _format_advisory_nudge(_trigger_detail)

            # Review round 1 (LOW): "user", not "system" -- a second
            # mid-stream system message is untested against this
            # codebase's chat template (the only system message
            # elsewhere is the very first one), and advisory-never-
            # blocks means a template/role error on the NEXT turn must
            # never be able to crash run_engineer.
            messages.append(
                {
                    "role": "user",
                    "content": nudge,
                }
            )

            print()
            print(f"⚠ {nudge}")

            _emit(
                "architect_consult_advised",
                trigger=_trigger_key,
                detail=_trigger_detail[:MAX_EVENT_FIELD],
            )

        # ----------------------------------------------------
        # DISCOVERY DECISION GATE
        # ----------------------------------------------------

        if (
            engineer_phase == "discovering"
            and discovery_calls >= discovery_tool_budget
        ):
            engineer_phase = "narrowed_to_read_edit"
            _emit_engineer_phase(engineer_phase)

            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Repository discovery budget is exhausted. "
                        "Stop broad searching now. Based on the evidence "
                        "already collected, choose exactly one concrete, "
                        "small, low-risk candidate. You may use read_file, "
                        "grep_search, find_symbol, find_references, or "
                        "find_related_tests only to verify that selected "
                        "candidate. Then call edit_file (for an existing "
                        "file) or write_file (only for a new file) with "
                        "the smallest behavior-preserving change, or "
                        "explicitly finish without changes if no "
                        "candidate is safe. Do not continue browsing "
                        "alternative candidates."
                    ),
                }
            )

            print()
            print(
                "↻ Discovery gate: "
                f"{discovery_calls} inspection calls used. "
                "Broad exploration disabled until first edit."
            )


        if (
            engineer_phase == "narrowed_to_read_edit"
            and post_gate_inspection_calls
                >= post_gate_inspection_budget
        ):
            engineer_phase = "narrowed_to_edit_only"
            _emit_engineer_phase(engineer_phase)

            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Candidate verification budget is exhausted. "
                        "Do not inspect or search any more files. "
                        "Make the engineering decision now. "
                        "If the selected candidate is objectively safe "
                        "and behavior-preserving, call edit_file "
                        "(existing file) or write_file (new file only) "
                        "with exactly one minimal change. Otherwise "
                        "finish without modifications and explain why. "
                        "Do not switch to another candidate."
                    ),
                }
            )

            print()
            print(
                "↻ Decision deadline: "
                f"{post_gate_inspection_calls} post-gate "
                "inspection calls used. "
                "Next action must be edit_file, write_file, or finish."
            )

    raise RuntimeError(
        "Engineering agent reached "
        f"max turns ({max_turns})."
    )


# ============================================================
# CLI
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description=(
            "Controlled Muse Glimmer "
            "engineering agent"
        )
    )

    parser.add_argument(
        "prompt",
        nargs="+",
        help="Engineering task",
    )

    parser.add_argument(
        "--workspace",
        type=Path,
        required=True,
        help=(
            "Git repository root to operate in. "
            "No default — every caller (glimmer-v2.py, "
            "new-glimmer-task.sh) already passes this "
            "explicitly, so a repo-specific fallback "
            "would only mask a missing argument."
        ),
    )

    parser.add_argument(
        "--max-turns",
        type=int,
        default=None,
        help=(
            "Turn budget. Default (when omitted): "
            f"{ENGINEER_MAX_TURNS_DEFAULT} for engineer mode (unchanged), "
            f"{ARCHITECT_MAX_TURNS_DEFAULT} for architect mode — see "
            "ARCHITECT_MAX_TURNS_DEFAULT's comment."
        ),
    )

    parser.add_argument(
        "--yes",
        action="store_true",
        help=(
            "Automatically approve actions "
            "that already pass the safety policy."
        ),
    )

    # C1 (glimmer-v7): opt-in only. Default "engineer" means every
    # existing invocation (direct or via new-glimmer-task.sh / v2.py's
    # existing spawn) is completely unaffected unless a caller explicitly
    # passes --mode architect. There is no auto-trigger anywhere in this
    # file — glimmer-v2.py's --architect-first is the only thing that
    # ever requests architect mode, and only when a human/caller passes
    # that flag explicitly.
    parser.add_argument(
        "--mode",
        choices=("engineer", "architect"),
        default="engineer",
        help=(
            "engineer (default): the existing full read/write "
            "engineering loop, unchanged. "
            "architect: read-only planning mode (V7 §5) — explores the "
            "repository with a read-only tool set and writes "
            "architecture-plan.json instead of editing files."
        ),
    )

    parser.add_argument(
        "--review-request",
        type=Path,
        default=None,
        help=(
            "C2 (glimmer-v7): only meaningful with --mode architect. "
            "Path to a review-request JSON file (written by "
            "glimmer-v2.py: the ArchitecturePlan, changed files, and "
            "diff) — switches architect mode from planning to "
            "reviewing an implementation (V7 §§5.6-5.13), writing "
            "architect-review-NN-MM.json instead of "
            "architecture-plan.json. Ignored in engineer mode."
        ),
    )

    parser.add_argument(
        "--architect-consult-enabled",
        action="store_true",
        help=(
            "Task 2.4 (V7 §5.5 second half): offer the consult_architect "
            "tool in engineer mode. Only takes effect when an "
            "architecture-plan.json also exists for this session -- "
            "passed by glimmer-v2.py's invoke_engineer whenever architect "
            "mode is active. Ignored in --mode architect."
        ),
    )

    args = parser.parse_args()

    if args.mode == "architect":
        max_turns = (
            args.max_turns
            if args.max_turns is not None
            else ARCHITECT_MAX_TURNS_DEFAULT
        )
        run_architect(
            " ".join(args.prompt),
            args.workspace,
            max_turns,
            review_request_path=args.review_request,
        )
    else:
        max_turns = (
            args.max_turns
            if args.max_turns is not None
            else ENGINEER_MAX_TURNS_DEFAULT
        )
        run_engineer(
            " ".join(args.prompt),
            args.workspace,
            max_turns,
            args.yes,
            architect_consult_enabled=args.architect_consult_enabled,
        )


if __name__ == "__main__":
    if sys.argv[1:] == ["--repeat-guard-selfcheck"]:
        _repeat_guard_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--evidence-selfcheck"]:
        _evidence_persistence_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--tool-envelope-selfcheck"]:
        _tool_envelope_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--architect-mode-selfcheck"]:
        _architect_mode_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--architect-review-selfcheck"]:
        _architect_review_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--delivery-review-selfcheck"]:
        _delivery_review_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--plan-aware-budget-selfcheck"]:
        _plan_aware_budget_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--gate-allow-write-file-selfcheck"]:
        _gate_allow_write_file_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--semantic-tools-selfcheck"]:
        _semantic_tools_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--failure-memory-selfcheck"]:
        _failure_memory_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--consult-selfcheck"]:
        _consult_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--context-tiers-selfcheck"]:
        _context_tiers_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--evidence-index-selfcheck"]:
        _evidence_index_selfcheck()
        sys.exit(0)

    try:
        main()

    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(130)

    except Exception as exc:
        print(
            f"\nERROR: {exc}",
            file=sys.stderr,
        )
        sys.exit(1)
