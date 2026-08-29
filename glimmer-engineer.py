#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
import atexit
import functools
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib import error, request
from urllib.parse import urlsplit

from glimmer_events import emit as emit_event
from glimmer_journal import DurableJournal, append_jsonl_durable, atomic_write_json
from glimmer_memory import record_outcome
from glimmer_models import (
    critic_model,
    load_model_registry,
    model_for_role,
    model_independence,
    routing_decision,
)
from glimmer_quality import (
    build_critic_request,
    parse_critic_response,
    validate_task_report_v2,
)
from glimmer_semantic import (
    impact_paths as semantic_impact_paths,
)
from glimmer_semantic import (
    query_references as semantic_query_references,
)
from glimmer_semantic import (
    query_symbols as semantic_query_symbols,
)
from glimmer_semantic import (
    related_tests as semantic_related_tests,
)
from glimmer_semantic import (
    repository_cache_key as semantic_repository_cache_key,
)

GLIMMER_EVENTS_PATH = os.environ.get("GLIMMER_EVENTS_PATH")
GLIMMER_SESSION_ID = os.environ.get("GLIMMER_SESSION_ID")
# C1 handoff enforcement (Fix 2): set by glimmer-v2.py (same spawn-env code
# path as the two vars above) to the count of architect-plan candidateFiles
# it successfully pre-read and embedded in this run's prompt — only when
# that count is > 0. See _plan_aware_discovery_budget below.
GLIMMER_PLAN_CANDIDATES = os.environ.get("GLIMMER_PLAN_CANDIDATES")

# Set only by run_engineer when it has a real session directory. Keeping the
# journal optional preserves standalone/architect/consult behavior while the
# main write-capable loop gains transactional model/tool checkpoints.
_DURABLE_JOURNAL = None
_DURABLE_MODEL_TURN = None

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

# Task 7.4 (V7 "Documentation tools"): the parsed docs/graph.json dict,
# loaded once at run_engineer/run_architect startup by
# _augment_tools_with_doc_tools -- None whenever the workspace has no
# graph yet (most repos, today). Same module-level pattern as
# _loaded_architecture_plan just above, for the same reason: execute_tool
# is called from ~8 existing call sites with an unchanged signature, so a
# tool that needs session-lifetime state reads it from a module global
# instead of a new threaded-through parameter.
_loaded_doc_graph = None

# V7 §15 follow-up ("large expansion -> pause for approval"): the
# contract's declared scope, as a flat list of boundary-safe path
# prefixes -- set once at run_engineer startup from GLIMMER_CONTRACT_SCOPE
# (see _load_contract_scope_prefixes below), None whenever glimmer-v2.py
# didn't set that env var at all (no bounded scope, or this process was
# invoked standalone / in a mode other than plain engineer). None is the
# ONLY value that disables the check in check_write_path -- absent env is
# byte-identical to pre-follow-up behavior (no per-write scope check at
# all; glimmer-v2.py's own post-hoc compute_scope_guard/scopeApproved gate
# computation is completely unaffected either way, see its own module
# comment in glimmer-v2.py).
_contract_scope_prefixes = None

# M2 (followup-1-2 review): request_approval_and_wait is the single shared
# entry point for every YELLOW approval (install/migration/scope-expansion)
# -- both a session-scoped memo and a request cap live here so no caller
# needs its own bookkeeping. Both are plain module globals: this process is
# exactly one engineering session, so "per session" == "per process", reset
# automatically on every fresh invocation with no explicit reset needed.
#
# ponytail: exact-match memo keyed on (tool_name, command) -- an approval
# for `write_file backend/x.ts` covers only THAT literal path/command
# again, forever, for the rest of this session; it does not notice the
# file being deleted and recreated, or re-verify anything about it. Known
# ceiling, not a bug: upgrade to path-existence/mtime invalidation if a
# session ever needs to re-pause on a path it already got a human decision
# about.
_approved_action_memo: dict = {}

# NEW-2 (1+2 re-review): approvalId of the most recent approved request
# (fresh or memo hit) -- the one link between a scope_expanded timeline
# row and its approvals.json/waiver record. Single-threaded engineer
# loop, so a module-level latch is race-free.
_last_approval_id = None

# "beyond cap -> immediate POLICY_BLOCK": once a session has already made
# this many NEW approval requests (memo hits don't count -- they're not a
# new request), every further one is denied immediately, no wait, no new
# approvals.json entry -- caps the worst case (a narrow declared scope
# fighting a legitimately broad task) at N * DEFAULT_APPROVAL_TIMEOUT_SECONDS
# instead of an unbounded serial string of 300s stalls.
MAX_APPROVAL_REQUESTS_PER_SESSION = 5
_approval_request_count = 0


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

API_KEY_FILE = Path(
    os.environ.get("GLIMMER_API_KEY_FILE")
    or (Path.home() / "AI/muse-glimmer/config/api-key.txt")
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
MUSE_GLIMMER_HOME = Path(os.environ.get("GLIMMER_STATE_ROOT") or (Path.home() / ".muse-glimmer"))


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
        atomic_write_json(path, entries)
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

# Populated from the live /tools metadata on every get_tools() call. MCP
# tools are optional and their names are not known at build time, so the
# approval boundary cannot be a static allow-list. Missing or malformed
# permission metadata fails closed into the approval-required set.
_runtime_approval_tools = set()
_runtime_read_only_tools = set()


def _mcp_requires_approval(item):
    if item.get("type") != "mcp":
        return False
    permissions = item.get("permissions")
    return not isinstance(permissions, dict) or permissions.get("write") is not False


def _requires_tool_approval(tool_name):
    return tool_name in WRITE_TOOLS or tool_name in _runtime_approval_tools


def _architect_tool_names():
    return ARCHITECT_TOOL_NAMES | _runtime_read_only_tools

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
    "impact_paths",
    # Task 5.1 (V7 §7 Tier2 "retrievable"): get_evidence(id) reads one
    # already-persisted evidence-*.jsonl entry back into the conversation
    # by id -- same client-side interception path as the other three (see
    # _execute_semantic_tool below), reusing every piece of existing
    # plumbing keyed off this set (the ledger-eligible tool list, the
    # generic read-tool result cache, discovery/post-gate budget
    # counting, and architect-mode availability).
    "get_evidence",
}

# Task 7.4 (V7 "Documentation tools"): docs_search/docs_get_node/
# docs_impact -- same client-side in-process interception path as
# SEMANTIC_TOOL_NAMES above, but a SEPARATE set because their availability
# is conditional (offered only when <workspace>/docs/graph.json exists --
# see _augment_tools_with_doc_tools below), unlike SEMANTIC_TOOL_NAMES
# which is always offered. Definitions/dispatch implementation live
# further down this file, right where the graph reader is defined.
DOC_TOOL_NAMES = {
    "docs_search",
    "docs_get_node",
    "docs_impact",
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
    "impact_paths",
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
#
# Task 7.4 (V7 "Documentation tools"): "Architect gets read-oriented
# documentation tools" — same reasoning, DOC_TOOL_NAMES included here too.
# Whether they're actually IN `tools` at all still depends on
# _augment_tools_with_doc_tools having found a real docs/graph.json first
# (run_architect calls it, same as run_engineer) — this set only decides
# what's ALLOWED, never what's offered.
ARCHITECT_TOOL_NAMES = READ_TOOLS | {"exec_shell_command"} | SEMANTIC_TOOL_NAMES | DOC_TOOL_NAMES

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

def _model_endpoint_url(base_url, endpoint):
    """Join either an origin-style or OpenAI ``.../v1`` base URL.

    Registry users commonly paste ``https://provider.example/v1`` while
    Glimmer's legacy local URL is only an origin. Both must resolve to one
    and only one ``/v1`` segment for OpenAI-compatible endpoints.
    """
    base = str(base_url).rstrip("/")
    if base.endswith("/v1") and endpoint.startswith("/v1/"):
        return f"{base}{endpoint[3:]}"
    return f"{base}{endpoint}"


def _http_json_at(
    base_url,
    api_key_path,
    method,
    endpoint,
    payload=None,
    extra_headers=None,
    # Task 6.1 (V7 §16): per-call timeout, default unchanged (3600) so
    # every pre-existing caller that doesn't pass this is byte-compatible.
    timeout_s=3600,
):
    headers = {
        "Content-Type": "application/json",
    }
    if api_key_path is not None:
        key = Path(api_key_path).read_text(encoding="utf-8").strip()
        if key:
            headers["Authorization"] = f"Bearer {key}"

    if extra_headers:
        headers.update(extra_headers)

    data = None

    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    req = request.Request(
        _model_endpoint_url(base_url, endpoint),
        data=data,
        headers=headers,
        method=method,
    )

    try:
        with request.urlopen(
            req,
            timeout=timeout_s,
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


def http_json(method, endpoint, payload=None, extra_headers=None, timeout_s=3600):
    """Legacy tools/default-model transport retained for non-provider calls."""
    return _http_json_at(
        API_BASE, API_KEY_FILE, method, endpoint, payload, extra_headers, timeout_s
    )


def model_http_json(provider, method, endpoint, payload=None, extra_headers=None, timeout_s=3600):
    """Provider-bound transport: URL and key path come from that provider."""
    return _http_json_at(
        provider.base_url, provider.api_key_path, method, endpoint,
        payload, extra_headers, timeout_s,
    )


class StreamingUnsupported(RuntimeError):
    """The provider rejected streaming before returning any model output."""


def _streaming_chat_at(provider, payload, timeout_s, on_progress):
    """Read OpenAI-compatible SSE and assemble the normal response shape.

    ``on_progress`` receives the complete API-visible content/tool-call state
    after each delta. It never sees authentication headers or hidden provider
    state. A provider that rejects streaming before producing a delta can be
    retried once through the existing non-streaming transport without risking
    duplicate tool execution.
    """
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if provider.api_key_path is not None:
        key = Path(provider.api_key_path).read_text(encoding="utf-8").strip()
        if key:
            headers["Authorization"] = f"Bearer {key}"

    stream_payload = dict(payload)
    stream_payload["stream"] = True
    req = request.Request(
        _model_endpoint_url(provider.base_url, "/v1/chat/completions"),
        data=json.dumps(stream_payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    try:
        response = request.urlopen(req, timeout=timeout_s)
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        if exc.code in {400, 404, 405, 415, 422}:
            raise StreamingUnsupported(f"HTTP {exc.code}: {body[-1000:]}") from exc
        raise RuntimeError(f"HTTP {exc.code} /v1/chat/completions\n{body}") from exc

    content_parts = []
    tool_parts = {}
    usage = None
    finish_reason = None
    response_id = None
    saw_sse = False
    saw_choice = False
    non_sse = []

    with response:
        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            if not line.startswith("data:"):
                non_sse.append(line)
                continue
            saw_sse = True
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except ValueError as exc:
                raise RuntimeError(f"Malformed streaming model response: {data[:500]}") from exc
            if not isinstance(chunk, dict):
                continue
            if chunk.get("error"):
                raise RuntimeError(
                    "Streaming model error: " + json.dumps(chunk["error"], ensure_ascii=False)[:2000]
                )
            response_id = chunk.get("id") or response_id
            if isinstance(chunk.get("usage"), dict):
                usage = chunk["usage"]
            choices = chunk.get("choices") or []
            if not choices:
                continue
            saw_choice = True
            choice = choices[0] if isinstance(choices[0], dict) else {}
            finish_reason = choice.get("finish_reason") or finish_reason
            delta = choice.get("delta") or {}
            delta_content = delta.get("content")
            if isinstance(delta_content, str):
                content_parts.append(delta_content)
            for position, tool_delta in enumerate(delta.get("tool_calls") or []):
                if not isinstance(tool_delta, dict):
                    continue
                index = tool_delta.get("index")
                if not isinstance(index, int):
                    index = position
                assembled = tool_parts.setdefault(
                    index,
                    {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
                )
                if isinstance(tool_delta.get("id"), str):
                    assembled["id"] += tool_delta["id"]
                if isinstance(tool_delta.get("type"), str):
                    assembled["type"] = tool_delta["type"]
                function_delta = tool_delta.get("function") or {}
                if isinstance(function_delta.get("name"), str):
                    assembled["function"]["name"] += function_delta["name"]
                if isinstance(function_delta.get("arguments"), str):
                    assembled["function"]["arguments"] += function_delta["arguments"]

            on_progress("".join(content_parts), [tool_parts[key] for key in sorted(tool_parts)])

    if not saw_sse:
        raw = "\n".join(non_sse)
        try:
            parsed = json.loads(raw)
        except ValueError as exc:
            raise StreamingUnsupported("provider returned neither SSE nor a JSON response") from exc
        if not isinstance(parsed, dict):
            raise StreamingUnsupported("provider returned an unsupported streaming response")
        return parsed

    if not saw_choice:
        raise RuntimeError("Streaming model response ended without a completion choice")

    message = {
        "role": "assistant",
        "content": "".join(content_parts) or None,
    }
    assembled_tools = [tool_parts[key] for key in sorted(tool_parts)]
    if assembled_tools:
        message["tool_calls"] = assembled_tools
    result = {
        "id": response_id,
        "object": "chat.completion",
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
    }
    if usage is not None:
        result["usage"] = usage
    return result


# ============================================================
# MODEL PROVIDER (V7 §16 Model Runtime, §31 Model routing)
# ============================================================
#
# C1 activates the routing seam Task 6.1 introduced. The registry is written
# by the local control center, contains paths rather than secret contents, and
# is loaded once per engineer subprocess. Every physical request below now
# uses its provider's URL, key path, and model id.
# glimmer-visual.py's vision model call is a SEPARATE provider in this
# same sense (see its own module comment) -- it already takes its
# endpoint as a CLI arg, which IS its routing; it stays standalone.

MODEL_REGISTRY = load_model_registry(default_base_url=API_BASE)
TASK_RISK = os.environ.get("GLIMMER_TASK_RISK", "UNKNOWN").upper()
MODEL_ROLES = {
    role: model_for_role(MODEL_REGISTRY, role, TASK_RISK)["id"]
    for role in ("engineer", "architect", "consult")
}

# Round 6 usage-metrics totals, keyed by role: {"promptTokens",
# "completionTokens", "calls", "models"}. Written out once at process exit by
# _write_model_usage_file (registered below) -- see that function's
# docstring for why atexit rather than an explicit call at every
# run_engineer/run_architect return point.
_MODEL_USAGE_TOTALS = {}


def _accumulate_usage(role, model_id, usage):
    """Never raises -- usage metrics are observability, not correctness.
    `usage` is the OpenAI-compatible {"prompt_tokens", "completion_tokens",
    ...} dict from a chat-completions response when the server includes
    one; absent/malformed usage still counts the call."""
    try:
        bucket = _MODEL_USAGE_TOTALS.setdefault(
            role, {"promptTokens": 0, "completionTokens": 0, "calls": 0, "models": {}}
        )
        bucket["calls"] += 1
        bucket["models"][model_id] = bucket["models"].get(model_id, 0) + 1
        if isinstance(usage, dict):
            bucket["promptTokens"] += int(usage.get("prompt_tokens") or 0)
            bucket["completionTokens"] += int(usage.get("completion_tokens") or 0)
    except Exception:  # noqa: BLE001 - metrics must never break a real call
        pass


def _write_model_usage_file():
    """Registered with atexit so totals are written whether the process
    ends normally or via an uncaught exception -- no-op (same convention
    as _architecture_plan_file_path/every other session-dir writer here)
    when there's no session dir (standalone invocation) or nothing was
    ever accumulated."""
    if not GLIMMER_EVENTS_PATH or not GLIMMER_SESSION_ID:
        return
    if not _MODEL_USAGE_TOTALS:
        return
    try:
        path = Path(GLIMMER_EVENTS_PATH).parent / "model-usage.json"
        atomic_write_json(path, _MODEL_USAGE_TOTALS)
    except OSError:
        pass


atexit.register(_write_model_usage_file)


def _is_retryable_network_error(exc):
    """True only for connection-refused/reset -- the request never
    reached the server, so resending it can't double-execute anything.
    Deliberately NOT true for a timeout (the server may already be mid-
    flight processing the first request) and NOT true for an HTTPError/
    RuntimeError (that's already a real response the server produced and
    acted on) -- request idempotency at the model server is unknown, so
    only the "never arrived" case is safe to retry blindly."""
    if isinstance(exc, (ConnectionRefusedError, ConnectionResetError)):
        return True
    if isinstance(exc, error.URLError) and not isinstance(exc, error.HTTPError):
        reason = getattr(exc, "reason", None)
        return isinstance(reason, (ConnectionRefusedError, ConnectionResetError))
    return False


class ModelProvider:
    """One configured, role-bound OpenAI-compatible model provider."""

    def __init__(self, base_url, api_key_path, role, model_id="muse-glimmer", provider_id=None):
        self.base_url = base_url
        self.api_key_path = api_key_path
        self.role = role
        self.model_id = model_id
        self.provider_id = provider_id or role
        self.last_request_id = None
        self._capabilities_cache = None  # None = not yet probed; {} on a failed probe

    def generate(self, payload, timeout_s=None, request_id=None):
        """POST /v1/chat/completions. Byte-compatible with the direct
        http_json call sites it replaces (same headers/auth/error
        behavior -- see http_json). Exactly ONE generic retry, and only
        for a connection-refused/reset (see _is_retryable_network_error);
        never for an HTTP 4xx/5xx body and never for a timeout. `request_id`
        lets a caller pre-announce the id it's about to use (e.g. in a
        model_retry event fired just before this call) so the same id
        shows up in this call's own logs; a retried physical attempt
        always gets its OWN fresh id, since it's a genuinely different
        request against the server."""
        kwargs = {"timeout_s": timeout_s} if timeout_s is not None else {}

        for attempt_no in (1, 2):
            this_id = (
                request_id
                if (attempt_no == 1 and request_id)
                else uuid.uuid4().hex[:12]
            )
            self.last_request_id = this_id

            request_payload = dict(payload)
            request_payload["model"] = self.model_id
            _emit(
                "model_request_started",
                requestId=this_id,
                role=self.role,
                providerId=self.provider_id,
                modelId=self.model_id,
            )

            journal = _DURABLE_JOURNAL
            journal_turn = _DURABLE_MODEL_TURN if _DURABLE_MODEL_TURN is not None else -1
            if journal is not None:
                journal.begin_model(this_id, journal_turn)

            try:
                if journal is not None:
                    try:
                        response = _streaming_chat_at(
                            self,
                            request_payload,
                            timeout_s if timeout_s is not None else 3600,
                            lambda content, calls: journal.update_model(
                                this_id, journal_turn, content, calls
                            ),
                        )
                    except StreamingUnsupported as exc:
                        journal.append(
                            "model_streaming_fallback",
                            {"reason": str(exc)[:1000]},
                            turn=journal_turn,
                            request_id=this_id,
                        )
                        response = model_http_json(
                            self, "POST", "/v1/chat/completions", request_payload, **kwargs
                        )
                else:
                    response = model_http_json(
                        self, "POST", "/v1/chat/completions", request_payload, **kwargs
                    )
            except RuntimeError as exc:
                # HTTP 4xx/5xx: http_json already converted the response
                # into this RuntimeError -- never retried (see
                # _is_retryable_network_error's docstring).
                if journal is not None:
                    journal.fail_model(this_id, journal_turn, str(exc))
                print(f"[ModelProvider:{self.role}] request {this_id} failed: {exc}")
                raise
            except Exception as exc:
                if journal is not None:
                    journal.fail_model(this_id, journal_turn, str(exc))
                if attempt_no == 1 and _is_retryable_network_error(exc):
                    print(
                        f"[ModelProvider:{self.role}] request {this_id} "
                        f"connection error, retrying once: {exc}"
                    )
                    continue
                print(f"[ModelProvider:{self.role}] request {this_id} failed: {exc}")
                raise
            else:
                usage = response.get("usage") if isinstance(response, dict) else None
                _accumulate_usage(self.role, self.model_id, usage)
                if journal is not None:
                    try:
                        response_message = response["choices"][0]["message"]
                    except (KeyError, IndexError, TypeError):
                        response_message = {"content": "", "tool_calls": []}
                    journal.complete_model(this_id, journal_turn, response_message)
                    _write_model_usage_file()
                return response

    def health(self):
        """GET /health -- same endpoint glimmer-status.sh already curls.
        Never raises: an unreachable/unhealthy server degrades to a
        {"ok": False, "error": ...} dict instead of an exception."""
        try:
            return model_http_json(self, "GET", "/health")
        except Exception as exc:  # noqa: BLE001 - health probe must never blow up a caller
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    def capabilities(self):
        """GET /v1/models, probed at most once per instance and cached.
        Never raises and never blocks operation on a failed probe: an
        unreachable/unsupported endpoint degrades to {} (honest "nothing
        known"), not an exception -- callers must already treat {} as
        "no capability info", never as "the model has zero capabilities"."""
        if self._capabilities_cache is not None:
            return self._capabilities_cache
        try:
            result = model_http_json(self, "GET", "/v1/models")
            if not isinstance(result, dict):
                result = {}
        except Exception:  # noqa: BLE001 - fail-open, see docstring
            result = {}
        self._capabilities_cache = result
        return result


_MODEL_PROVIDERS = {}
for _role, _provider_id in MODEL_ROLES.items():
    _entry = model_for_role(MODEL_REGISTRY, _role, TASK_RISK)
    _MODEL_PROVIDERS[_role] = ModelProvider(
        base_url=_entry["baseUrl"],
        api_key_path=_entry["apiKeyFile"],
        role=_role,
        model_id=_entry["modelId"],
        provider_id=_entry["id"],
    )

_critic_entry = critic_model(MODEL_REGISTRY)
_MODEL_PROVIDERS["critic"] = ModelProvider(
    base_url=_critic_entry["baseUrl"],
    api_key_path=_critic_entry["apiKeyFile"],
    role="critic",
    model_id=_critic_entry["modelId"],
    provider_id=_critic_entry["id"],
)

for _routing_role in ("engineer", "architect", "consult"):
    _emit("model_routing_decision", **routing_decision(MODEL_REGISTRY, _routing_role, TASK_RISK))


def _provider_for_role(role):
    return _MODEL_PROVIDERS.get(role) or _MODEL_PROVIDERS["engineer"]


def _model_provider_selfcheck() -> None:
    """Task 6.1/C1 (V7 §16/§31): ModelProvider routing, intercepting the
    final URL opener and provider transport so no live server is needed. Run with:
    python3 glimmer-engineer.py --model-provider-selfcheck
    """
    import tempfile

    global model_http_json, GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID

    real_model_http_json = model_http_json
    real_events_path = GLIMMER_EVENTS_PATH
    real_session_id = GLIMMER_SESSION_ID
    real_totals = dict(_MODEL_USAGE_TOTALS)
    _MODEL_USAGE_TOTALS.clear()
    event_dir = tempfile.TemporaryDirectory()
    GLIMMER_EVENTS_PATH = str(Path(event_dir.name) / "events.jsonl")
    GLIMMER_SESSION_ID = "model-provider-selfcheck"

    try:
        # ------------------------------------------------------------
        # 0. Real provider transport wiring: configured URL, model id,
        #    and key FILE are used at the final HTTP boundary. urlopen is
        #    replaced, so no network request leaves this self-check.
        # ------------------------------------------------------------
        transport_seen = {}
        key_file = Path(event_dir.name) / "provider.key"
        key_file.write_text("transport-test-key\n", encoding="utf-8")
        real_urlopen = request.urlopen

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({
                    "choices": [{"message": {"content": "routed"}}]
                }).encode("utf-8")

        def fake_urlopen(req, timeout=None):
            transport_seen.update({
                "url": req.full_url,
                "authorization": req.headers.get("Authorization"),
                "payload": json.loads(req.data.decode("utf-8")),
                "timeout": timeout,
            })
            return FakeResponse()

        request.urlopen = fake_urlopen
        try:
            routed = ModelProvider(
                base_url="https://models.example/v1", api_key_path=key_file,
                role="architect", model_id="frontier-model", provider_id="frontier",
            )
            routed.generate({"model": "ignored", "messages": []}, timeout_s=41)
        finally:
            request.urlopen = real_urlopen
        assert transport_seen == {
            "url": "https://models.example/v1/chat/completions",
            "authorization": "Bearer transport-test-key",
            "payload": {"model": "frontier-model", "messages": []},
            "timeout": 41,
        }, transport_seen
        routed_event = json.loads(Path(GLIMMER_EVENTS_PATH).read_text(encoding="utf-8").splitlines()[-1])
        assert routed_event["providerId"] == "frontier" and routed_event["modelId"] == "frontier-model"
        assert "transport-test-key" not in json.dumps(routed_event)
        _MODEL_USAGE_TOTALS.clear()

        assert _model_endpoint_url("https://models.example/v1", "/v1/chat/completions") == (
            "https://models.example/v1/chat/completions"
        )
        assert _model_endpoint_url("http://127.0.0.1:8080", "/v1/models") == (
            "http://127.0.0.1:8080/v1/models"
        )

        # ------------------------------------------------------------
        # 1. generate() byte-compat: same request shape (method/endpoint/
        #    payload/timeout_s) a direct http_json call would have used,
        #    same return value passed straight through.
        # ------------------------------------------------------------
        calls = []

        def fake_ok(provider_arg, method, endpoint, payload=None, extra_headers=None, timeout_s=3600):
            calls.append((provider_arg.base_url, provider_arg.api_key_path, method, endpoint, payload, timeout_s))
            return {
                "choices": [{"message": {"role": "assistant", "content": "hi"}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            }

        model_http_json = fake_ok
        provider = ModelProvider(
            base_url="http://x", api_key_path=Path("/nope"), role="test-role",
            model_id="test-model", provider_id="test-provider",
        )
        response = provider.generate({"model": "m", "messages": []})
        assert calls == [(
            "http://x", Path("/nope"), "POST", "/v1/chat/completions",
            {"model": "test-model", "messages": []}, 3600,
        )], calls
        assert response["choices"][0]["message"]["content"] == "hi"
        assert provider.last_request_id is not None and len(provider.last_request_id) == 12
        event = json.loads(Path(GLIMMER_EVENTS_PATH).read_text(encoding="utf-8").splitlines()[-1])
        assert event["type"] == "model_request_started"
        assert event["requestId"] == provider.last_request_id
        assert event["providerId"] == "test-provider" and event["modelId"] == "test-model"
        assert "baseUrl" not in event and "apiKey" not in event, "events carry identity, never connection secrets"

        calls.clear()
        provider.generate({"model": "m", "messages": []}, timeout_s=30)
        assert calls[-1][5] == 30, "a supplied timeout_s must be forwarded to the provider transport"

        # ------------------------------------------------------------
        # 2. Usage accumulation: promptTokens/completionTokens/calls per
        #    role, across multiple generate() calls; a response with no
        #    usage key still counts the call without fabricating tokens.
        # ------------------------------------------------------------
        assert _MODEL_USAGE_TOTALS["test-role"] == {
            "promptTokens": 20, "completionTokens": 10, "calls": 2,
            "models": {"test-model": 2},
        }, _MODEL_USAGE_TOTALS

        def fake_no_usage(provider_arg, method, endpoint, payload=None, extra_headers=None, timeout_s=3600):
            return {"choices": [{"message": {"content": "x"}}]}

        model_http_json = fake_no_usage
        provider.generate({"model": "m", "messages": []})
        assert _MODEL_USAGE_TOTALS["test-role"]["calls"] == 3
        assert _MODEL_USAGE_TOTALS["test-role"]["promptTokens"] == 20, "missing usage must not add fake tokens"

        # ------------------------------------------------------------
        # 3. Retry exactly once on connection-refused/reset; never on an
        #    HTTP error (already a RuntimeError by the time it reaches
        #    generate -- see http_json) and never on a timeout.
        # ------------------------------------------------------------
        attempts_seen = []

        def fake_refused_then_ok(provider_arg, method, endpoint, payload=None, extra_headers=None, timeout_s=3600):
            attempts_seen.append(1)
            if len(attempts_seen) == 1:
                raise ConnectionRefusedError("refused")
            return {"choices": [{"message": {"content": "recovered"}}]}

        model_http_json = fake_refused_then_ok
        response = provider.generate({"model": "m", "messages": []})
        assert len(attempts_seen) == 2, "must retry exactly once on connection-refused"
        assert response["choices"][0]["message"]["content"] == "recovered"

        attempts_seen.clear()

        def fake_refused_twice(provider_arg, method, endpoint, payload=None, extra_headers=None, timeout_s=3600):
            attempts_seen.append(1)
            raise ConnectionResetError("reset")

        model_http_json = fake_refused_twice
        try:
            provider.generate({"model": "m", "messages": []})
            assert False, "must raise once the one retry is also exhausted"
        except ConnectionResetError:
            pass
        assert len(attempts_seen) == 2, "exactly one retry, never more"

        attempts_seen.clear()

        def fake_http_error(provider_arg, method, endpoint, payload=None, extra_headers=None, timeout_s=3600):
            attempts_seen.append(1)
            raise RuntimeError("HTTP 500 /v1/chat/completions\nboom")

        model_http_json = fake_http_error
        try:
            provider.generate({"model": "m", "messages": []})
            assert False, "an HTTP error must propagate"
        except RuntimeError:
            pass
        assert len(attempts_seen) == 1, "an HTTP error body must never be retried"

        attempts_seen.clear()

        def fake_timeout(provider_arg, method, endpoint, payload=None, extra_headers=None, timeout_s=3600):
            attempts_seen.append(1)
            raise TimeoutError("timed out")

        model_http_json = fake_timeout
        try:
            provider.generate({"model": "m", "messages": []})
            assert False, "a timeout must propagate"
        except TimeoutError:
            pass
        assert len(attempts_seen) == 1, "a timeout must never be retried -- idempotency at the server is unknown"

        # ------------------------------------------------------------
        # 4. Request ids: unique per call; a caller-supplied id is used
        #    for the first physical attempt.
        # ------------------------------------------------------------
        model_http_json = fake_ok
        seen_ids = set()
        for _ in range(5):
            provider.generate({"model": "m", "messages": []})
            seen_ids.add(provider.last_request_id)
        assert len(seen_ids) == 5, "each call must get its own request id"

        provider.generate({"model": "m", "messages": []}, request_id="caller-supplied-1")
        assert provider.last_request_id == "caller-supplied-1", (
            "a caller-supplied request_id must be used for the first physical attempt"
        )

        # ------------------------------------------------------------
        # 5. capabilities(): probed once, cached, fail-open to {}.
        # ------------------------------------------------------------
        probe_calls = []

        def fake_models(provider_arg, method, endpoint, payload=None, extra_headers=None, timeout_s=3600):
            probe_calls.append(endpoint)
            return {"data": [{"id": "muse-glimmer"}]}

        model_http_json = fake_models
        cap_provider = ModelProvider(base_url="http://x", api_key_path=Path("/nope"), role="cap-role")
        caps1 = cap_provider.capabilities()
        caps2 = cap_provider.capabilities()
        assert caps1 == {"data": [{"id": "muse-glimmer"}]}
        assert caps2 == caps1
        assert probe_calls == ["/v1/models"], "capabilities() must probe /v1/models exactly ONCE, then cache"

        def fake_models_fail(provider_arg, method, endpoint, payload=None, extra_headers=None, timeout_s=3600):
            raise RuntimeError("HTTP 500 /v1/models")

        model_http_json = fake_models_fail
        fail_provider = ModelProvider(base_url="http://x", api_key_path=Path("/nope"), role="fail-role")
        assert fail_provider.capabilities() == {}, "a failed probe must degrade to {} honestly, never raise"
        assert fail_provider.capabilities() == {}, "the failed-probe result is cached too (probed only once)"

        # ------------------------------------------------------------
        # 6. health(): never raises.
        # ------------------------------------------------------------
        def fake_health_down(provider_arg, method, endpoint, payload=None, extra_headers=None, timeout_s=3600):
            raise ConnectionRefusedError("down")

        model_http_json = fake_health_down
        health = ModelProvider(base_url="http://x", api_key_path=Path("/nope"), role="h").health()
        assert health.get("ok") is False and "error" in health

        # ------------------------------------------------------------
        # 7. MODEL_ROLES / _provider_for_role: every runtime role resolves
        #    to the configured provider (roles may intentionally share one).
        # ------------------------------------------------------------
        assert set(MODEL_ROLES) == {"engineer", "architect", "consult"}
        assert _provider_for_role("architect").role == "architect"
        assert _provider_for_role("architect").provider_id == MODEL_ROLES["architect"]
        assert _provider_for_role("unknown-role").role == "engineer", "an unknown role must fail open to engineer"

    finally:
        model_http_json = real_model_http_json
        GLIMMER_EVENTS_PATH = real_events_path
        GLIMMER_SESSION_ID = real_session_id
        event_dir.cleanup()
        _MODEL_USAGE_TOTALS.clear()
        _MODEL_USAGE_TOTALS.update(real_totals)

    print("model-provider self-check: PASS")


def _streaming_transport_selfcheck() -> None:
    """Prove fragmented content/tool deltas assemble and checkpoint correctly."""
    import sqlite3
    import tempfile

    chunks = [
        {"id": "stream-1", "choices": [{"delta": {"content": "hel"}}]},
        {"choices": [{"delta": {"content": "lo", "tool_calls": [{
            "index": 0, "id": "call_", "type": "function",
            "function": {"name": "write_", "arguments": "{\"path\":\"x"},
        }]}}]},
        {"choices": [{"delta": {"tool_calls": [{
            "index": 0, "id": "1", "function": {"name": "file", "arguments": ".txt\"}"},
        }]}, "finish_reason": "tool_calls"}]},
    ]

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def __iter__(self):
            lines = [("data: " + json.dumps(chunk) + "\n").encode("utf-8") for chunk in chunks]
            return iter(lines + [b"data: [DONE]\n"])

    seen_payload = {}
    real_urlopen = request.urlopen

    def fake_urlopen(req, timeout=None):
        seen_payload.update(json.loads(req.data.decode("utf-8")))
        assert timeout == 5
        return FakeResponse()

    request.urlopen = fake_urlopen
    try:
        with tempfile.TemporaryDirectory() as td:
            journal = DurableJournal(Path(td), "stream-selfcheck")
            journal.begin_model("request-1", 3)
            provider = ModelProvider(
                "http://127.0.0.1:1", None, "engineer", "test-model"
            )
            result = _streaming_chat_at(
                provider,
                {"messages": []},
                5,
                lambda content, calls: journal.update_model(
                    "request-1", 3, content, calls, force=True
                ),
            )
            message = result["choices"][0]["message"]
            assert message["content"] == "hello"
            assert message["tool_calls"][0] == {
                "id": "call_1",
                "type": "function",
                "function": {"name": "write_file", "arguments": '{"path":"x.txt"}'},
            }
            journal.complete_model("request-1", 3, message)
            journal.close("completed")
            db = sqlite3.connect(str(Path(td) / "runtime.sqlite3"))
            row = db.execute(
                "SELECT status, content, tool_calls_json FROM model_streams WHERE request_id=?",
                ("request-1",),
            ).fetchone()
            db.close()
            assert row[0] == "completed" and row[1] == "hello"
            assert json.loads(row[2])[0]["function"]["name"] == "write_file"
            assert seen_payload["stream"] is True

            chunks[:] = [{"error": {"message": "provider failed"}}]
            try:
                _streaming_chat_at(provider, {"messages": []}, 5, lambda *_args: None)
                assert False, "an SSE error object must never become an empty successful response"
            except RuntimeError as exc:
                assert "provider failed" in str(exc)
    finally:
        request.urlopen = real_urlopen

    print("streaming transport self-check: PASS")


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
        # ToolPolicyBlock, not plain PermissionError (round-9 re-review
        # NEW-1): a traversal attempt is a security-boundary violation and
        # must reach the audit trail (tool_blocked + POLICY_BLOCK), same
        # as check_write_path's blocks.
        raise ToolPolicyBlock(
            f"Path escapes repository: {value}"
        )

    return resolved


class ToolPolicyBlock(PermissionError):
    """Round 9 review (M5): a real POLICY_BLOCK, raised only by
    check_write_path below -- distinct from the plain PermissionError
    secure_tool_arguments' OTHER guards raise (path traversal via
    resolve_workspace_path, read_file-on-a-directory, write_file-on-an-
    existing-file, edit_file-on-a-missing-file). Subclasses PermissionError
    so every existing `except PermissionError` catch site (check_write_path's
    own unit-test assertions, etc.) still works unchanged; execute_tool
    catches this SPECIFIC subclass to route it through the same
    tool_blocked/record_blocked_command/POLICY_BLOCK-envelope audit path
    shell_policy rejections already use -- deliberately narrower than
    catching every PermissionError there, so this fix doesn't silently
    change the (already-tested) propagate-and-let-the-caller-handle-it
    contract for the OTHER guards, which is out of this finding's scope."""


def _load_contract_scope_prefixes():
    """V7 §15 follow-up: parses GLIMMER_CONTRACT_SCOPE (a JSON list of
    boundary-safe path-prefix strings -- see glimmer-v2.py's
    _expected_prefixes/invoke_engineer, the ONLY writer of this env var)
    into the list check_write_path guards writes against.

    Returns None on ANY malformed/absent input -- a missing env var, a
    parse failure, or a value that isn't a non-empty list of non-empty
    strings all collapse to the SAME "no scope guard active" state as a
    contract with no bounded scope at all (compute_scope_guard's own
    `expected` can be legitimately empty for a "repository" scope). Never
    raises: a broken env var must degrade to today's behavior, not fail
    closed by accident on a parse error.
    """
    raw = os.environ.get("GLIMMER_CONTRACT_SCOPE")
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, list) or not data or not all(
        isinstance(p, str) and p for p in data
    ):
        return None
    return data


def _path_in_scope(relative, prefixes) -> bool:
    """Boundary-safe prefix match -- deliberately mirrors glimmer-v2.py's
    compute_scope_guard/_expected_prefixes rule (a path is in scope only
    if it equals a declared prefix exactly, or starts with `prefix + "/"`,
    after stripping any trailing slash from the prefix) so a file that is
    reported in-scope by the orchestrator's post-hoc gate can never be
    reported out-of-scope by this live, per-write check, or vice versa.
    No shared module between the two processes (existing convention --
    see classify_yellow's own module comment), so this is a deliberate,
    cross-linked mirror, not a new scheme."""
    posix = relative.as_posix()
    return any(
        posix == p.rstrip("/") or posix.startswith(p.rstrip("/") + "/")
        for p in prefixes
    )


def check_write_path(
    path,
    workspace,
    tool_name=None,
    *,
    # Test-only override hooks (never passed by secure_tool_arguments'
    # real call site below): let the selfcheck exercise a real, resolved
    # approve/deny/timeout round-trip through request_approval_and_wait in
    # milliseconds instead of the real 300s/2s production defaults, the
    # same way _approval_wait_selfcheck already does for classify_yellow's
    # own approval calls. None means "use request_approval_and_wait's own
    # defaults" -- production behavior is completely unaffected.
    approval_timeout_s=None,
    approval_poll_interval_s=None,
):
    relative = path.relative_to(workspace)

    for part in relative.parts:
        if part in PROTECTED_DIRS:
            raise ToolPolicyBlock(
                "Writing to protected directory "
                f"is blocked: {relative}"
            )

    if path.name.startswith(".env"):
        raise ToolPolicyBlock(
            "Writing environment/secret files "
            f"is blocked: {relative}"
        )

    if path.name in PROTECTED_FILES:
        raise ToolPolicyBlock(
            "Lockfile writes are blocked in "
            f"Engineering Mode v1: {relative}"
        )

    if path.suffix == ".lock":
        raise ToolPolicyBlock(
            f"Lockfile writes are blocked: {relative}"
        )

    # CR1 (round-7 re-review 2): docs/graph.json is orchestrator-owned
    # bookkeeping that changed_files() deliberately excludes from model
    # attribution/scope/budget -- so a MODEL write here would be invisible
    # to every downstream guard and mislabeled as orchestrator output.
    # Exact relative-path check, not PROTECTED_FILES (that matches on
    # path.name and would block any graph.json anywhere in the repo).
    if relative.as_posix() == DOC_GRAPH_RELATIVE_PATH:
        raise ToolPolicyBlock(
            "docs/graph.json is orchestrator-owned documentation "
            f"bookkeeping; model writes are blocked: {relative}"
        )

    # V7 §15 follow-up ("large expansion -> pause for approval"): only
    # active when glimmer-v2.py declared a real bounded scope for this
    # session (_contract_scope_prefixes is not None) -- absent env, this
    # is a no-op and every check above already ran unchanged, so a
    # session with no GLIMMER_CONTRACT_SCOPE is byte-identical to before
    # this follow-up. check_write_path is the single choke point both
    # write_file and edit_file dispatch through (secure_tool_arguments
    # below), so this can't be bypassed per-tool by construction -- the
    # same discipline classify_yellow's own docstring credits to routing
    # every YELLOW arm through one shared entry point, applied here to
    # the write path instead of the shell-command path.
    if (
        _contract_scope_prefixes is not None
        and not _path_in_scope(relative, _contract_scope_prefixes)
    ):
        _enforce_scope_expansion_approval(
            relative, tool_name,
            timeout_s=approval_timeout_s, poll_interval_s=approval_poll_interval_s,
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
            tool_name,
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

# GitHub CLI integration is deliberately narrower than the `gh` command
# surface. Every entry here is a built-in read operation; commands that
# create/edit/merge/comment, trigger workflows, expose tokens, invoke the
# generic API client, or select another repository never reach execution.
SAFE_READONLY_GH_COMMANDS = {
    "repo": {"view"},
    "pr": {"list", "view", "status", "checks", "diff"},
    "issue": {"list", "view", "status"},
    "run": {"list", "view"},
    "workflow": {"list", "view"},
    "release": {"list", "view"},
}

GH_REPOSITORY_SELECTOR_FLAGS = {"-R", "--repo"}
GH_INTERACTIVE_FLAGS = {"-w", "--web", "--watch"}


def _github_auth_status_policy(tokens):
    """Allow only non-secret github.com auth status inspection."""
    args = tokens[3:]
    index = 0

    while index < len(args):
        token = args[index]

        if token == "--active":
            index += 1
            continue

        if token in {"-h", "--hostname"}:
            if index + 1 >= len(args) or args[index + 1].lower() != "github.com":
                return False, "GitHub auth status is restricted to github.com"
            index += 2
            continue

        if token.startswith("--hostname="):
            if token.split("=", 1)[1].lower() != "github.com":
                return False, "GitHub auth status is restricted to github.com"
            index += 1
            continue

        return False, "Only non-secret GitHub auth status flags are allowed"

    return True, "safe GitHub authentication status"


def _github_repo_view_policy(args):
    """Keep `gh repo view` bound to the repository selected by cwd."""
    flags_with_value = {"--branch", "--json", "--jq", "--template"}
    boolean_flags = {"--exit-status"}
    index = 0

    while index < len(args):
        token = args[index]

        if token in boolean_flags:
            index += 1
            continue

        if token in flags_with_value:
            if index + 1 >= len(args):
                return False, f"{token} requires a value"
            index += 2
            continue

        if any(token.startswith(flag + "=") for flag in flags_with_value):
            index += 1
            continue

        return False, (
            "gh repo view may only inspect the current repository; "
            "repository arguments are blocked"
        )

    return True, "safe read-only GitHub repo view"


def github_cli_policy(tokens):
    """Positive allowlist for a single, already-tokenized `gh` command."""
    if len(tokens) < 3:
        return False, "Incomplete GitHub CLI command"

    namespace = tokens[1].lower()
    subcommand = tokens[2].lower()

    if namespace == "auth":
        if subcommand != "status":
            return False, "GitHub authentication changes and token access are blocked"
        return _github_auth_status_policy(tokens)

    if subcommand not in SAFE_READONLY_GH_COMMANDS.get(namespace, set()):
        return False, (
            f"gh {namespace} {subcommand} is outside the read-only allowlist. "
            "Create/edit/comment/merge/trigger/API operations are blocked."
        )

    args = tokens[3:]
    for index, token in enumerate(args):
        if token in GH_REPOSITORY_SELECTOR_FLAGS:
            return False, "GitHub repository override flags are blocked"
        if token.startswith("--repo=") or token.startswith("-R=") or (
            token.startswith("-R") and token != "-R"
        ):
            return False, "GitHub repository override flags are blocked"
        if token in GH_INTERACTIVE_FLAGS or token.startswith("--web="):
            return False, "Interactive GitHub CLI flags are blocked"
        if token in {"-h", "--hostname"} or token.startswith("--hostname="):
            return False, "GitHub hostname overrides are blocked"
        lowered = token.lower()
        if (
            "://" in lowered
            or lowered.startswith("git@")
            or "github.com/" in lowered
        ):
            return False, "GitHub URL arguments are blocked; use the current repository"

        # A selector flag's value can never be reached as an independent
        # repository argument, even if future parsing changes above.
        if index > 0 and args[index - 1] in GH_REPOSITORY_SELECTOR_FLAGS:
            return False, "GitHub repository override flags are blocked"

    if namespace == "repo":
        return _github_repo_view_policy(args)

    return True, f"safe read-only GitHub CLI: gh {namespace} {subcommand}"


def _is_typecheck_script(script):
    return script == "typecheck" or script.startswith("typecheck:")


def _structural_shell_guard(command):
    """8.3 re-review fix (NC1, V7 §14/§35): the composition/substitution/
    quoting precondition every shell command must pass BEFORE anything
    else is decided -- factored out of shell_policy so it is the single
    place this check is ever written, shared by shell_policy itself AND
    classify_yellow's single entry point (see that function's docstring:
    NC1 was a migration arm that classified a command as YELLOW-eligible
    without ever routing it through this check at all, so `npm run
    migrate ; git push origin main` classified as run_migration and the
    composed string dispatched verbatim). Returns (tokens, None) for a
    single, clean, uncomposed command, or (None, reason) otherwise. Never
    raises."""
    if not isinstance(command, str):
        return None, "Command must be a string"

    command = command.strip()

    if not command:
        return None, "Empty command"

    # No shell composition / pipes / redirects / substitutions.
    if re.search(
        r"[;&|><\n\r`]",
        command,
    ):
        return None, (
            "Shell composition, pipes and redirects "
            "are blocked"
        )

    if "$(" in command:
        return None, (
            "Command substitution is blocked"
        )

    try:
        tokens = shlex.split(command)
    except ValueError as exc:
        return None, (
            f"Invalid shell quoting: {exc}"
        )

    if not tokens:
        return None, "Empty command"

    return tokens, None


def shell_policy(
    command,
    workspace,
    validation_allowlist=None,
    *,
    yellow_relax=frozenset(),
):
    """yellow_relax (8.3 review fix-round, V7 §14/§35): a set of npm
    SUBCOMMAND names (e.g. {"install","i","ci","add"}) this ONE call may
    treat as not-forbidden -- used exclusively by classify_yellow to
    probe "would this exact command be allowed if only its dependency-
    install subcommand were waived", never to actually relax enforcement
    for a real dispatch. Every real exec_shell_command call site in this
    file passes the default empty frozenset(), so this parameter is a
    no-op for real command execution: every check this function already
    performs -- composition/pipe/redirect/substitution/quoting rejection
    up top (via _structural_shell_guard), the forbidden-token scan,
    --prefix containment -- still runs in full and still returns False
    for anything that isn't a genuinely simple, uncomposed `npm
    <relaxed-subcommand> ...` command. This is the SAME "BY CONSTRUCTION,
    not by re-implementing" remedy architect_shell_policy already uses
    (see its own docstring) applied to a second caller."""
    tokens, reason = _structural_shell_guard(command)
    if tokens is None:
        return False, reason

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
    # READ-ONLY GITHUB CLI
    # --------------------------------------------------------

    if executable == "gh":
        return github_cli_policy(tokens)


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

        # yellow_relax (8.3 review fix-round, V7 §14/§35): position-exact
        # -- only npm's own SUBCOMMAND slot (tokens[1]) may ever be
        # relaxed, never a package-name/argument token that happens to
        # collide with a forbidden word elsewhere (the "anywhere in the
        # tail" scans below stay exactly as strict as before for every
        # OTHER position -- that looseness in the OLD classify_yellow,
        # not here, is what let `npm run deploy add` misclassify). Every
        # real exec_shell_command dispatch passes the default empty
        # frozenset, so this whole block is a byte-identical no-op for
        # real enforcement -- only classify_yellow's shell_policy PROBE
        # (never a real dispatch) ever passes a non-empty relax set.
        subcommand = lowered[1] if len(lowered) > 1 else ""
        relaxed = bool(subcommand) and subcommand in yellow_relax

        if not relaxed and any(
            item in forbidden
            for item in lowered[1:]
        ):
            return False, (
                "npm dependency/package operations "
                "are blocked"
            )

        if relaxed and any(
            item in forbidden
            for item in lowered[2:]
        ):
            # The relaxed subcommand itself is fine, but some OTHER
            # forbidden token still appears later in the command -- stays
            # blocked.
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

        if relaxed:
            # Dependency-install commands aren't "npm run <script>"
            # invocations -- every check above (composition/substitution/
            # quoting at the top of this function, the forbidden-token
            # scan, and --prefix containment) already ran in full; there
            # is nothing left to gate for this exact shape.
            return True, f"yellow-relaxed npm {subcommand}"

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


# ============================================================
# Task 8.3 (V7 §14/§35): YELLOW approval-boundary classification
# ============================================================
#
# 8.3 review fix-round: the original version of this function was an
# INDEPENDENT token scan that re-implemented shell_policy's own parsing
# with none of its preamble (composition/substitution/quoting rejection,
# --prefix containment, position-exact subcommand extraction) -- exactly
# the class of hole round 1 forced architect_shell_policy to close "BY
# CONSTRUCTION -- by delegating to it -- not by re-implementing". Fixed
# the same way: this function now DELEGATES the actual verdict to
# shell_policy itself (via its yellow_relax hook, see that function's
# docstring), never re-derives it. There is exactly one copy of this
# function now (glimmer-v2.py's former "reference" mirror was removed --
# it has no shell_policy/workspace to delegate to at all, and a copy that
# can't be held to the same standard is worse than no copy).
#
# Scope-expansion YELLOW (V7 §15 "large expansion -> pause for approval")
# was dropped in this same fix-round: it had no caller anywhere in either
# process (glimmer-engineer.py has no structured contract.scope to check
# it against -- that would need a new spawn-env flag threading it in from
# glimmer-v2.py, out of scope here) and shipping an unreachable classifier
# arm is worse than not having one. Tracked as future work, not shipped.
YELLOW_DEPENDENCY_INSTALL_SUBCOMMANDS = frozenset({"install", "i", "ci", "add"})
YELLOW_MIGRATION_KEYWORDS = ("migrate", "migration", "seed")
# V7 §35: "commit, push, deploy" (and the rest of shell_policy's own
# dangerous_fragments set) stay RED even when a migration keyword ALSO
# appears in the same script name (e.g. "deploy:migrate") -- no
# escalation offered for those, ever.
YELLOW_MIGRATION_EXCLUDED_FRAGMENTS = ("deploy", "publish", "release", "production", ":prod", ":live")


def _resolve_npm_script_body(workspace, script):
    """8.3 review fix (C3): resolve the LITERAL command an `npm run
    <script>` will execute, straight from the workspace's package.json,
    so a migration-keyword approval shows the operator the real command
    body -- not just a model-chosen script NAME the model itself could
    have written moments earlier (package.json is model-writable; only
    the lockfiles are protected, see check_write_path/PROTECTED_FILES).
    Returns None (fail closed -- not YELLOW-eligible at all) whenever
    package.json is missing, unreadable, malformed, has no "scripts"
    object, or no matching key: an operator must never approve a bare
    name whose body couldn't be shown to them."""
    try:
        data = json.loads((Path(workspace) / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    scripts = data.get("scripts")
    if not isinstance(scripts, dict):
        return None
    body = scripts.get(script)
    return body if isinstance(body, str) and body.strip() else None


def classify_yellow(command, workspace, validation_allowlist=None) -> dict | None:
    """V7 §14/§35 YELLOW escalation. Called ONLY from execute_tool's
    exec_shell_command branch, and ONLY after shell_policy has already
    said no for this exact `command` string. Returns a structured V7 §35
    approval-request dict -- {"action","reason","proposedChanges","risk"}
    -- or None, meaning "stays exactly what shell_policy already said"
    (RED stays RED).

    8.3 re-review fix (NC1): a SINGLE structural precondition, applied
    HERE at the one entry point before either arm below runs at all --
    the command must be a single, uncomposed, cleanly-quoted command
    (the exact same check shell_policy itself always applies first, via
    the shared _structural_shell_guard -- not a second hand-rolled copy).
    The install arm ALSO independently re-verifies via a real shell_policy
    call (belt and suspenders, since it already needs shell_policy for
    --prefix containment anyway); the migration arm has no shell_policy
    delegation of its own, which is exactly why this top-level guard has
    to run for BOTH arms, not be duplicated per-arm -- a composed command
    like `npm run migrate ; git push origin main` is rejected right here,
    before `subcommand` is even inspected, regardless of which arm would
    otherwise have matched.
    """
    tokens, _structural_reason = _structural_shell_guard(command)
    if tokens is None:
        return None
    if len(tokens) < 2 or tokens[0] != "npm":
        return None

    subcommand = tokens[1].lower()

    # --- dependency install ---------------------------------------------
    if subcommand in YELLOW_DEPENDENCY_INSTALL_SUBCOMMANDS:
        try:
            allowed, _reason = shell_policy(
                command, workspace, validation_allowlist,
                yellow_relax=YELLOW_DEPENDENCY_INSTALL_SUBCOMMANDS,
            )
        except PermissionError:
            # e.g. --prefix escaping the workspace -- shell_policy's own
            # containment check still ran in full (yellow_relax only
            # skips the forbidden-subcommand short-circuit, nothing
            # else) and it said no. Fail closed: not eligible.
            return None
        if not allowed:
            return None
        return {
            "action": "modify_dependencies",
            # M4 (followup-1-2 review): an install runs the package's own
            # lifecycle scripts (preinstall/postinstall/etc) as the invoking
            # user -- arbitrary code execution, not just a file-content
            # change. The card must say so; a reviewer approving "medium /
            # two files change" is approving something they weren't told.
            "reason": (
                f"engineer requested a dependency-install command: {command} "
                "-- installed packages can run arbitrary lifecycle scripts "
                "(preinstall/postinstall/etc) as this user, not just change "
                "package.json/package-lock.json"
            ),
            "proposedChanges": ["package.json", "package-lock.json"],
            "risk": "high",
        }

    # --- migration-shaped npm run script ---------------------------------
    if subcommand == "run" and len(tokens) > 2:
        script = tokens[2]
        script_lower = script.lower()
        if not any(k in script_lower for k in YELLOW_MIGRATION_KEYWORDS):
            return None
        resolved = _resolve_npm_script_body(workspace, script)
        if resolved is None:
            return None
        # NM1 fix: scan the FULL command (every token, not just tokens[2])
        # AND the resolved script body for the exclusion fragments --
        # `npm run migrate --env=production --force` must exclude on
        # "production" appearing in a trailing arg, and a resolved body
        # that itself does something deploy/production-shaped must
        # exclude too. The structural guard above already proved
        # `command` is a single, uncomposed string, so a plain substring
        # scan over it is safe (no hidden second command to miss).
        excluded_haystack = f"{command.lower()} {resolved.lower()}"
        if any(f in excluded_haystack for f in YELLOW_MIGRATION_EXCLUDED_FRAGMENTS):
            return None
        # Re-review-2 minor: `:prod`/`:live` are script-name-shaped, so
        # argument forms (`--prod`, `--live`, `--env=prod`) slipped past.
        # Bare `prod`/`live` scan the COMMAND tokens only -- on the body
        # they'd overmatch ("product", "reproduce"), and overmatching
        # here is fail-closed anyway (excluded -> not YELLOW-eligible).
        if any(f in command.lower() for f in ("prod", "live")):
            return None
        return {
            "action": "run_migration",
            # Disclosure fix: the reason/proposedChanges carry the FULL
            # literal command (every trailing arg) AND the resolved
            # script body -- the operator approves everything that will
            # actually execute, not just a script name.
            "reason": f"engineer requested: {command!r} -> npm run {script} resolves to: {resolved!r}",
            "proposedChanges": [command, resolved],
            "risk": "high",
        }

    return None


# --- approvals.json sidecar (V7 §35 file-based approval) -------------------
#
# The gateway spawns glimmer-v2.py (which spawns THIS process) with no
# stdin at all for a UI-launched run (see invoke_engineer's --yes/
# --auto-approve handling and the module docstring's cross-reference to
# the gateway auto-approve deadlock lesson) -- an interactive prompt here
# would deadlock the session exactly like the parked round-7 repro. File-
# based polling is the only safe mechanism: this process writes the
# request, the Control Center gateway (a human clicking Approve/Deny)
# writes the resolution, both to the SAME sidecar file, same "two
# processes, one JSON file, each writes only its own half" discipline as
# task-overrides.json (glimmer-v2.py's load_task_overrides / control-
# center's writeTaskOverride).
APPROVAL_POLL_INTERVAL_SECONDS = 2
DEFAULT_APPROVAL_TIMEOUT_SECONDS = 300


def _atomic_write_json(path: Path, data) -> None:
    """Write-to-temp-then-rename, same discipline control-center's
    writeTaskOverride uses for task-overrides.json: a crash/kill mid-write
    must never leave a torn file for a concurrent reader (the gateway, or
    this process's own next poll) to trip over. os.replace is atomic on
    the same filesystem, and the temp file lives in the same directory so
    it always is."""
    atomic_write_json(path, data)


def _approvals_path(session_dir) -> Path:
    return Path(session_dir) / "approvals.json"


def load_approvals(session_dir) -> dict:
    """Tolerant read, same uniform-degrade-to-{} contract as glimmer-v2.py's
    load_task_overrides: missing file, unreadable, malformed JSON, or valid
    JSON that isn't an object all resolve to {}."""
    try:
        data = json.loads(_approvals_path(session_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _bound_action_hash(tool_name, command) -> str:
    """8.3 review fix (exact-action binding, defense in depth): a compact
    fingerprint of the tool + exact command string this approval covers.
    Compared byte-exact at resolution time in request_approval_and_wait --
    a mismatch (approvals.json hand-edited, or any future refactor that
    reuses an approval record for a different call) fails closed to
    POLICY_BLOCK rather than executing something other than what the
    human actually saw approved."""
    return hashlib.sha256(
        json.dumps({"tool": tool_name, "command": command}, sort_keys=True).encode("utf-8")
    ).hexdigest()


def _write_approval_request(session_dir, approval_id, action, reason, proposed_changes, risk, tool_name, command) -> dict:
    """Read-modify-write over the whole file (there is at most one pending
    approval per session in practice), same pattern as writeTaskOverride.
    boundTool/boundCommand/boundArgsHash bind this record to the EXACT
    action it was requested for (see _bound_action_hash)."""
    existing = load_approvals(session_dir)
    record = {
        "action": action,
        "reason": reason,
        "proposedChanges": list(proposed_changes or []),
        "risk": risk,
        "requestedAt": datetime.now(timezone.utc).isoformat(),
        "status": "pending",
        "boundTool": tool_name,
        "boundCommand": command,
        "boundArgsHash": _bound_action_hash(tool_name, command),
    }
    existing[approval_id] = record
    _atomic_write_json(_approvals_path(session_dir), existing)
    return record


def _patch_manifest_approval_state(session_dir, approval_id, pending: dict | None) -> None:
    """Best-effort direct patch of manifest.json's status/state/
    pendingApproval fields -- the ONLY way a human watching the Control
    Center can see "waiting_for_approval" live, since glimmer-v2.py itself
    is blocked reading this process's stdout for the entire duration of
    the wait (invoke_engineer's Popen loop) and cannot update manifest.json
    until this process exits. Safe: manifest.json has exactly one writer
    at any given moment -- glimmer-v2.py never touches it while blocked on
    this subprocess, so there is no concurrent-writer race, only a
    sequential handoff (same assumption architecture-plan.json/tasks.json/
    every other session-dir artifact this process writes directly already
    relies on).

    pending is not None: save the CURRENT status/state (so they can be
    restored exactly) under a private key, then set status/state to the
    waiting-for-approval raw string glimmer-v2.py's canonical_session_state
    recognizes, plus the structured pendingApproval envelope.

    pending is None: restore the previously-saved status/state and drop
    pendingApproval -- called once the wait resolves (approved/denied/
    timeout), so the session never reports "waiting_for_approval" after
    it's no longer true.

    Never raises -- a missing/malformed manifest.json (standalone
    invocation with no v2 parent, or a torn read mid-write) degrades to
    "no live status update", never to a crashed session. The actual
    approval gate (execute_tool's caller) does not depend on this
    succeeding."""
    path = Path(session_dir) / "manifest.json"
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(manifest, dict):
        return

    if pending is not None:
        manifest["_preApprovalStatus"] = manifest.get("status")
        manifest["_preApprovalState"] = manifest.get("state")
        manifest["status"] = "waiting-for-approval"
        manifest["state"] = "waiting_for_approval"
        manifest["pendingApproval"] = {"approvalId": approval_id, **pending}
    else:
        if "_preApprovalStatus" in manifest:
            manifest["status"] = manifest.pop("_preApprovalStatus")
        if "_preApprovalState" in manifest:
            manifest["state"] = manifest.pop("_preApprovalState")
        manifest.pop("pendingApproval", None)

    try:
        _atomic_write_json(path, manifest)
    except OSError:
        pass


def _record_approved_action(session_dir, approval_id, action, reason, risk, tool_name, command, approved_by) -> None:
    """M1 (followup-1-2 review): a human approving a YELLOW action (most
    visibly, an install/migration the task contract's own prose calls
    forbidden -- see make_prompt's constraint text) is a deviation from
    the contract's declared constraints. That deviation lived ONLY in the
    approvals.json sidecar before this -- auditable if you knew to look,
    invisible everywhere else. Appends one entry to manifest.json's
    additive "approvedActions" list so it is visible wherever the manifest
    already is (Control Center, delivery packet, any future reader) --
    same best-effort, never-raises, read-modify-write-then-atomic-replace
    discipline as _patch_manifest_approval_state right above, and the same
    "manifest.json has exactly one writer at a time" assumption."""
    path = Path(session_dir) / "manifest.json"
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(manifest, dict):
        return

    entry = {
        "approvalId": approval_id,
        "action": action,
        "reason": reason,
        "risk": risk,
        "tool": tool_name,
        "command": command,
        "approvedBy": approved_by,
        "approvedAt": datetime.now(timezone.utc).isoformat(),
    }
    approved_actions = manifest.get("approvedActions")
    if not isinstance(approved_actions, list):
        approved_actions = []
    approved_actions.append(entry)
    manifest["approvedActions"] = approved_actions

    try:
        _atomic_write_json(path, manifest)
    except OSError:
        pass


def request_approval_and_wait(
    action, reason, proposed_changes, risk,
    *, tool_name, command, timeout_s=None, poll_interval_s=APPROVAL_POLL_INTERVAL_SECONDS,
) -> tuple:
    """V7 §35: request human approval for a YELLOW-classified action and
    block (polling, never an interactive prompt -- see the module note
    above) until it's approved, denied, or the timeout elapses.

    tool_name/command are the EXACT action this approval is bound to (see
    _bound_action_hash) -- required, not optional, so a caller can never
    accidentally request approval for one action and let a different one
    execute on approval. The SAME (tool_name, command) pair is also this
    function's memo key (M2, followup-1-2 review): a call that exactly
    matches a PRIOR approval this session resolves instantly to
    ("approved", <original approver>) with no new sidecar entry, no wait,
    and no cap consumption -- see _approved_action_memo's module comment.

    Returns (decision, detail):
      decision in {"approved", "denied", "timeout", "unavailable", "capped"}.
      "unavailable" -- no GLIMMER_EVENTS_PATH (no session directory to
      write the sidecar into, e.g. a standalone/test invocation) OR the
      sidecar write itself failed (unwritable/removed session dir) --
      fails CLOSED (same as "denied") rather than allowing with nothing
      for a human to actually approve, and never raises out of this
      function (M2, 8.3 review fix-round).
      "denied" also covers a resolved record whose boundTool/boundCommand/
      boundArgsHash no longer match this exact call (exact-action binding,
      defense in depth) -- approvals.json hand-tampered, or reused for a
      different action, is treated as a denial, never as approval.
      "capped" (M2, followup-1-2 review) -- this session already made
      MAX_APPROVAL_REQUESTS_PER_SESSION genuinely NEW requests (memo hits
      don't count); every caller already treats any non-"approved"
      decision as a failure to route through the same POLICY_BLOCK path
      (see classify_yellow's caller / _enforce_scope_expansion_approval),
      so this needed no new branch anywhere else.
      detail is approvedBy (for "approved"/"denied", when the gateway
      recorded one) or a short human-readable reason otherwise.

    An "approved" resolution is ALSO recorded as a durable
    manifest.json["approvedActions"] entry (M1, followup-1-2 review) --
    see _record_approved_action -- so a human overriding a declared
    contract constraint (e.g. noDependencyInstall) is auditable in the
    manifest itself, not only in the approvals.json sidecar.

    timeout_s defaults to DEFAULT_APPROVAL_TIMEOUT_SECONDS, overridable via
    GLIMMER_APPROVAL_TIMEOUT_SECONDS (same env-var-configuration convention
    as the other GLIMMER_* cross-process settings glimmer-v2.py's spawn env
    already uses) -- never via a new CLI flag threaded through execute_tool
    and its ~8 call sites. Both timeout_s and poll_interval_s are
    parameters (not hardcoded reads of the env var/module constant) purely
    so a selfcheck can pass tiny values and finish in milliseconds, never a
    real 300-second sleep.
    """
    global _approval_request_count

    global _last_approval_id
    memo_key = (tool_name, command)
    if memo_key in _approved_action_memo:
        detail, memo_approval_id = _approved_action_memo[memo_key]
        _last_approval_id = memo_approval_id
        print(f"\n↻ APPROVAL MEMO: {tool_name} {command!r} already approved by {detail or 'a human'} this session")
        return "approved", detail

    if timeout_s is None:
        try:
            timeout_s = int(os.environ.get("GLIMMER_APPROVAL_TIMEOUT_SECONDS", "") or DEFAULT_APPROVAL_TIMEOUT_SECONDS)
        except ValueError:
            timeout_s = DEFAULT_APPROVAL_TIMEOUT_SECONDS

    if not GLIMMER_EVENTS_PATH:
        return "unavailable", "no session directory available for approval sidecar (fail closed)"

    if _approval_request_count >= MAX_APPROVAL_REQUESTS_PER_SESSION:
        return "capped", (
            f"approval request cap ({MAX_APPROVAL_REQUESTS_PER_SESSION}/session) reached; "
            "denying further out-of-policy requests to avoid an unbounded string of pauses"
        )
    _approval_request_count += 1

    session_dir = Path(GLIMMER_EVENTS_PATH).parent
    approval_id = f"{GLIMMER_SESSION_ID or 'session'}-appr-{uuid.uuid4().hex[:8]}"

    # M2 (8.3 review fix-round): a write failure here (unwritable/removed
    # session dir) must fail closed, not raise out of execute_tool and
    # kill the whole engineer run -- same discipline every other sidecar
    # writer in this file already follows.
    try:
        pending = _write_approval_request(
            session_dir, approval_id, action, reason, proposed_changes, risk, tool_name, command,
        )
    except OSError as exc:
        return "unavailable", f"could not write approval sidecar (fail closed): {exc}"

    bound_hash = pending["boundArgsHash"]
    _patch_manifest_approval_state(session_dir, approval_id, pending)
    _emit("approval_requested", approvalId=approval_id, action=action, reason=reason, risk=risk)
    _emit("agent_state_changed", state="waiting_for_approval")

    print()
    print("┌─ YELLOW APPROVAL REQUESTED (V7 §35)")
    print(f"│ {action}: {reason}")
    print(f"│ waiting up to {timeout_s}s for a human decision (approvals.json) ...")
    print("└─")

    deadline = time.monotonic() + timeout_s
    decision, detail = "timeout", f"no approval decision recorded within {timeout_s}s"
    while time.monotonic() < deadline:
        time.sleep(poll_interval_s)
        record = load_approvals(session_dir).get(approval_id)
        if isinstance(record, dict) and record.get("status") in ("approved", "denied"):
            decision = record["status"]
            detail = record.get("approvedBy") or ""
            if decision == "approved" and (
                record.get("boundTool") != tool_name
                or record.get("boundCommand") != command
                or record.get("boundArgsHash") != bound_hash
            ):
                # Exact-action binding mismatch: the resolved record no
                # longer describes the SAME action this call requested --
                # fail closed regardless of what status it carries.
                decision, detail = "denied", "approval record no longer matches the exact action requested"
            break

    _patch_manifest_approval_state(session_dir, approval_id, None)
    # Cosmetic only (see the STATES/waiting_for_approval stepper entry the
    # Control Center already carries): move the live stepper off
    # "waiting_for_approval" now that the wait is over. "implementing" is a
    # reasonable generic "back to work" bucket -- this loop has no record
    # of whatever more specific phase preceded the request.
    _emit("agent_state_changed", state="implementing")
    if decision == "approved":
        # M2: memoize so an identical subsequent call never re-pauses.
        # NEW-2: keep the approvalId with it so memo-hit emits still link
        # back to the original approvals.json/waiver record.
        _approved_action_memo[memo_key] = (detail, approval_id)
        _last_approval_id = approval_id
        # M1: durable, manifest-visible waiver record.
        _record_approved_action(session_dir, approval_id, action, reason, risk, tool_name, command, detail)
    print(f"\n{'✓ APPROVED' if decision == 'approved' else '✗ ' + decision.upper()}: {action}")
    return decision, detail


def _enforce_scope_expansion_approval(relative, tool_name, *, timeout_s=None, poll_interval_s=None) -> None:
    """V7 §15 follow-up: called only from check_write_path, only when
    _contract_scope_prefixes is set AND `relative` falls outside it --
    the write-path equivalent of classify_yellow's YELLOW escalation,
    reusing the exact same request_approval_and_wait sidecar (V7 §35).

    Approved: returns normally (the write proceeds) and emits a
    scope_expanded event of its own, carrying who approved it. This does
    NOT retroactively make the write "in scope" -- glimmer-v2.py's own
    post-hoc compute_scope_guard/gates.scopeApproved computation, run
    after this session exits, is completely untouched by this function
    and still reports the same file as expanded; approval only decides
    whether the write itself was allowed to happen, with its own honest,
    separately-provenanced record of why.

    Denied/timeout/unavailable: raises ToolPolicyBlock -- fails closed,
    same as every other check_write_path rejection (tool_blocked +
    record_blocked_command + a POLICY_BLOCK envelope, via execute_tool's
    existing ToolPolicyBlock catch).

    timeout_s/poll_interval_s: test-only overrides forwarded verbatim from
    check_write_path's own same-named kwargs (see that function's
    docstring) -- omitted entirely (not passed at all) unless a caller
    explicitly set one, so request_approval_and_wait's own real defaults
    apply for every production call, unchanged."""
    posix = relative.as_posix()
    kwargs = {}
    if timeout_s is not None:
        kwargs["timeout_s"] = timeout_s
    if poll_interval_s is not None:
        kwargs["poll_interval_s"] = poll_interval_s
    decision, detail = request_approval_and_wait(
        "scope_expansion",
        f"write outside declared task scope: {posix}",
        [posix],
        "medium",
        tool_name=tool_name or "write_file",
        command=posix,
        **kwargs,
    )
    if decision == "approved":
        _emit(
            "scope_expanded",
            expected=list(_contract_scope_prefixes or []),
            actual=[posix],
            approved=True,
            approvedBy=detail or None,
            approvalId=_last_approval_id,
        )
        return
    raise ToolPolicyBlock(
        f"out-of-scope write requires human approval [{decision}]: {posix}"
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

    Additionally requires either a Git subcommand in the shared
    SAFE_READONLY_GIT_SUBCOMMANDS set or a command accepted by the shared
    GitHub CLI read-only policy. Architect mode still has no legitimate
    use for npm/cargo/py_compile validation commands or `git branch
    --show-current` (shell_policy allows those; architect mode is narrower).
    """
    allowed, reason = shell_policy(command, workspace)

    if not allowed:
        return False, reason

    # shell_policy already proved this parses (allowed == True), so this
    # can't raise — re-split just to inspect the executable/subcommand.
    tokens = shlex.split(command.strip())

    if tokens[0] == "git" and len(tokens) >= 2 and tokens[1] in SAFE_READONLY_GIT_SUBCOMMANDS:
        return True, f"safe read-only git {tokens[1]} (architect mode)"

    if tokens[0] == "gh":
        return True, f"safe read-only GitHub CLI (architect mode): {tokens[1]} {tokens[2]}"

    return False, (
        "Architect mode allows only read-only git and allowlisted "
        "GitHub CLI inspection commands"
    )


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

    _runtime_approval_tools.clear()
    _runtime_read_only_tools.clear()

    for item in raw:
        name = item.get("tool")
        definition = item.get("definition")

        if not name or not definition:
            continue

        metadata[name] = item
        definitions.append(definition)

        if item.get("type") == "mcp":
            if _mcp_requires_approval(item):
                _runtime_approval_tools.add(name)
            else:
                _runtime_read_only_tools.add(name)

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
        append_jsonl_durable(path, record)
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
    "impact_paths": "impact",
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
        atomic_write_json(idx_path, existing)
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

    if tool_name in _runtime_approval_tools:
        return f"{tool_name}: approval-required MCP action"

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
# find_symbol / find_references / find_related_tests / impact_paths, served
# client-side (see the SEMANTIC_TOOL_NAMES comment above). They prefer the
# session's versioned Tree-sitter repository index and label its per-result
# provenance. A missing/stale index falls back to the existing lexical/AST
# scans rather than presenting incomplete semantic data as current.
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


def _load_current_repo_index(workspace):
    """Return this session's index only when its cache key still matches.

    The index is built before the engineer starts. A write during the session
    changes the dirty-file hash, so semantic tools invoked afterwards must not
    silently reuse the pre-write graph.
    """
    if not GLIMMER_EVENTS_PATH:
        return None
    path = Path(GLIMMER_EVENTS_PATH).parent / "repo-index.json"
    try:
        index = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(index, dict) or index.get("schemaVersion") != 1:
            return None
        parser_versions = index.get("parserVersions")
        if not isinstance(parser_versions, dict):
            return None
        current_key, _head, _dirty_hash = semantic_repository_cache_key(
            Path(workspace),
            {str(key): str(value) for key, value in parser_versions.items()},
        )
        return index if current_key == index.get("cacheKey") else None
    except (OSError, UnicodeDecodeError, ValueError, TypeError):
        return None


def _relative_semantic_path(path, workspace):
    try:
        return Path(path).resolve(strict=False).relative_to(Path(workspace)).as_posix()
    except (OSError, ValueError):
        return None


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


# Task 9.3d (V7 §28 semantic code intelligence, O4): .py targets get a real
# parse instead of the per-line lexical scan every other extension uses.
# stdlib `ast` only (no new dependency) -- ast.NodeVisitor subclasses below,
# one for definitions (find_symbol) and one for references (find_references).
# Ceiling, spelled out here once rather than repeated at every call site:
#   - module/class/function SCOPE is not used to disambiguate two same-named
#     symbols in different scopes -- every match, at any nesting depth, is
#     reported (still strictly more accurate than the regex path, which is
#     scope-blind in the same way).
#   - a `keyword.arg` name in a call site (`f(target=1)`'s "target") is NOT
#     counted -- keyword.arg is a plain string field, not a node, so
#     NodeVisitor never visits it; only the value expression is (already
#     true of the regex path's blindness to which token is the kwarg name
#     vs. the value, just the opposite miss).
#   - no cross-file resolution, no type information -- this remains a
#     single-file, name-based tool, same as the regex path it upgrades.
# TS/JS get no equivalent upgrade (no stdlib AST for those languages) and
# stay exactly the lexical/regex scan documented above.
class _PySymbolDefVisitor(ast.NodeVisitor):
    """Collects the line numbers of every FunctionDef/AsyncFunctionDef/
    ClassDef node named `name`, restricted to `wanted_kinds` (a subset of
    {"def", "class"})."""

    def __init__(self, name, wanted_kinds):
        self.name = name
        self.wanted_kinds = wanted_kinds
        self.linenos = []

    def visit_FunctionDef(self, node):
        if "def" in self.wanted_kinds and node.name == self.name:
            self.linenos.append(node.lineno)
        self.generic_visit(node)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        if "class" in self.wanted_kinds and node.name == self.name:
            self.linenos.append(node.lineno)
        self.generic_visit(node)


class _PyReferenceVisitor(ast.NodeVisitor):
    """Collects the line numbers of every real usage of `name`: a bare
    identifier (ast.Name -- a call, a read, an argument, an assignment
    target, ...), an attribute access (ast.Attribute, e.g. `self.name`/
    `obj.name(...)`), an import name or alias (ast.alias, e.g. `import name`/
    `from mod import name`/`import mod as name`), a function/lambda
    parameter name (ast.arg), or a `global`/`nonlocal name` declaration
    (ast.Global/ast.Nonlocal). Unlike the regex path's word-boundary text
    match, this cannot false-positive on a comment or string literal that
    merely mentions the name — ast.parse never turns those into nodes at
    all. Round 9 review (M4): imports/params/global/nonlocal were the four
    reproduced gaps versus the regex path this upgrades; see the ceiling
    note above this class for what's still deliberately out of scope."""

    def __init__(self, name):
        self.name = name
        self.linenos = set()

    def visit_Name(self, node):
        if node.id == self.name:
            self.linenos.add(node.lineno)
        self.generic_visit(node)

    def visit_Attribute(self, node):
        if node.attr == self.name:
            self.linenos.add(node.lineno)
        self.generic_visit(node)

    def visit_Import(self, node):
        # py3.9 compat: ast.alias has no lineno before 3.10 -- stash the
        # statement's own lineno for visit_alias to fall back on.
        self._import_lineno = node.lineno
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        self._import_lineno = node.lineno
        self.generic_visit(node)

    def visit_alias(self, node):
        # `import pkg.sub` binds "pkg" locally, so check every dotted
        # component of the imported name, plus the `as` alias if present
        # (`import target as t` mentions "target" in source even though it
        # binds "t") -- either matching `name` counts as a real mention.
        candidates = set(node.name.split(".")) if node.name else set()
        if node.asname:
            candidates.add(node.asname)
        if self.name in candidates:
            self.linenos.add(getattr(node, "lineno", None) or getattr(self, "_import_lineno", 0))
        self.generic_visit(node)

    def visit_arg(self, node):
        if node.arg == self.name:
            self.linenos.add(node.lineno)
        self.generic_visit(node)

    def visit_Global(self, node):
        if self.name in node.names:
            self.linenos.add(node.lineno)
        self.generic_visit(node)

    visit_Nonlocal = visit_Global


def _ast_line_hits(text, linenos):
    """Shared tail: sorted (lineno, stripped source line) pairs for a set/
    list of line numbers already collected by one of the visitors above."""
    lines = text.splitlines()
    return sorted(
        (lineno, lines[lineno - 1].strip() if 0 < lineno <= len(lines) else "")
        for lineno in set(linenos)
    )


def _ast_symbol_matches_py(text, name, wanted_kinds):
    """AST-based definition finder for one Python file's source text.
    Raises SyntaxError (propagated) on invalid Python -- the caller
    catches this and falls back to the same lexical regex scan used for
    every other extension, for this one file only."""
    tree = ast.parse(text)
    visitor = _PySymbolDefVisitor(name, wanted_kinds)
    visitor.visit(tree)
    return _ast_line_hits(text, visitor.linenos)


def _ast_reference_lines_py(text, name):
    """AST-based reference finder for one Python file's source text.
    Raises SyntaxError (propagated) on invalid Python -- same per-file
    regex fallback contract as _ast_symbol_matches_py above."""
    tree = ast.parse(text)
    visitor = _PyReferenceVisitor(name)
    visitor.visit(tree)
    return _ast_line_hits(text, visitor.linenos)


def find_symbol(name, kind, workspace):
    """Locate definition(s) of `name` across the workspace. TS/JS:
    function/const/class/interface/type declarations, lexical/regex-based
    (unchanged). Python: def/class/method, via a real stdlib `ast` parse
    (Task 9.3d) — finds definitions at any nesting depth (a method inside a
    class, a function nested inside another function) and never
    false-positives on a comment or string literal that merely mentions the
    name, unlike a per-line regex scan. Falls back to the same lexical
    regex scan TS/JS uses for a .py file that fails to parse (a real
    SyntaxError — e.g. a work-in-progress edit) — for that one file only;
    every other .py file still gets the AST treatment. See the ceiling note
    on _PySymbolDefVisitor above. `kind` optionally narrows to one of
    function/const/class/interface/type/def (kind="function" also matches
    Python `def`, since callers rarely distinguish the two). Capped at
    _SEMANTIC_MAX_MATCHES; returns "file:line: <matched line>" per hit."""
    name = _validate_semantic_name(name)
    index = _load_current_repo_index(workspace)
    if index is not None:
        indexed = semantic_query_symbols(index, name, _SEMANTIC_MAX_MATCHES)
        if kind:
            wanted_kind = str(kind).strip().lower()
            indexed = [
                item for item in indexed
                if wanted_kind in str(item.get("kind") or "").lower()
                or (wanted_kind == "function" and "method" in str(item.get("kind") or "").lower())
            ]
        if indexed:
            rows = [
                f"{item.get('path')}:{item.get('line')}: {item.get('name')} "
                f"[{item.get('kind')}; provenance={item.get('provenance')}]"
                for item in indexed
            ]
            return (
                f"Found {len(rows)} indexed symbol match(es) for '{name}' "
                "(current repo-index.json):\n" + "\n".join(rows)
            )
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

        if ext in _PY_EXTS:
            try:
                ast_hits = _ast_symbol_matches_py(text, name, set(active.keys()))
            except SyntaxError:
                ast_hits = None
            if ast_hits is not None:
                for lineno, line_text in ast_hits:
                    matches.append(f"{rel}:{lineno}: {line_text}")
                    if len(matches) >= _SEMANTIC_MAX_MATCHES:
                        break
                if len(matches) >= _SEMANTIC_MAX_MATCHES:
                    break
                continue  # AST path handled this file; skip the regex scan below

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
    """All usages of `name` across the workspace, grouped by file. TS/JS
    (and any .py file that fails to parse): word-boundary lexical match
    (so searching "foo" will never match inside "foobar") — definition
    lines are NOT excluded from the results, since distinguishing "this
    line defines X" from "this line merely mentions X" would require real
    parsing, which this lexical path doesn't do.

    Python (.py) files that parse successfully (Task 9.3d) use a real
    stdlib `ast` NodeVisitor instead: a reference is an ast.Name(id=name)
    (a call, a read, an argument, ...), an ast.Attribute(attr=name)
    (`self.name`/`obj.name(...)`), an import name/alias (ast.alias), a
    function/lambda parameter name (ast.arg), or a `global`/`nonlocal name`
    declaration. This is strictly more precise than the lexical path for
    those files — a def/class statement's own name is not one of those node
    types, so definition lines are correctly excluded, and a comment or
    string literal merely mentioning the name is never counted (ast.parse
    doesn't turn those into nodes at all). See the ceiling note on
    _PyReferenceVisitor above for what's still out of scope (e.g. a call's
    keyword-argument name). Per-file results below say which path a given
    file actually took (Round 9 review M3: the header used to make one
    blanket "lexical, definitions included" claim even for files the AST
    path — the opposite on both counts — actually handled). Capped at
    _SEMANTIC_MAX_MATCHES total matches."""
    name = _validate_semantic_name(name)
    index = _load_current_repo_index(workspace)
    if index is not None:
        symbols = [
            item for item in semantic_query_symbols(index, name, _SEMANTIC_MAX_MATCHES)
            if str(item.get("name") or "") == name
        ]
        indexed = []
        for symbol in symbols:
            for edge in semantic_query_references(
                index, str(symbol.get("id") or ""), _SEMANTIC_MAX_MATCHES
            ):
                row = dict(edge)
                row["symbol"] = symbol.get("id")
                indexed.append(row)
                if len(indexed) >= _SEMANTIC_MAX_MATCHES:
                    break
            if len(indexed) >= _SEMANTIC_MAX_MATCHES:
                break
        if indexed:
            rows = [
                f"{str(item.get('from') or 'file:unknown').removeprefix('file:')}:"
                f"{item.get('line')}: -> {item.get('symbol')} "
                f"[provenance={item.get('provenance', 'tree-sitter')}]"
                for item in indexed
            ]
            return (
                f"Found {len(rows)} indexed reference(s) to '{name}' "
                "(current repo-index.json):\n" + "\n".join(rows)
            )
    pattern = re.compile(r"\b" + re.escape(name) + r"\b")

    by_file = {}
    total = 0
    for path in _semantic_walk_files(workspace):
        text = _semantic_read_text(path)
        if text is None:
            continue

        file_matches = []
        ast_handled = False
        if path.suffix in _PY_EXTS:
            try:
                ast_hits = _ast_reference_lines_py(text, name)
                ast_handled = True
            except SyntaxError:
                ast_hits = None
            if ast_handled:
                for lineno, line_text in ast_hits:
                    file_matches.append(f"{lineno}: {line_text}")
                    total += 1
                    if total >= _SEMANTIC_MAX_MATCHES:
                        break

        if not ast_handled:
            for lineno, line in enumerate(text.splitlines(), start=1):
                if pattern.search(line):
                    file_matches.append(f"{lineno}: {line.strip()}")
                    total += 1
                    if total >= _SEMANTIC_MAX_MATCHES:
                        break

        if file_matches:
            rel = path.relative_to(workspace).as_posix()
            by_file[rel] = (file_matches, ast_handled)
        if total >= _SEMANTIC_MAX_MATCHES:
            break

    if not by_file:
        return (
            f"No references to '{name}' found (word-boundary lexical search "
            "for non-Python files and any .py file that failed to parse; "
            "real ast parse — definition lines excluded — for .py files "
            "that parsed)."
        )

    lines = [f"Found {total} reference(s) to '{name}' across {len(by_file)} file(s):"]
    for rel, (file_matches, ast_handled) in by_file.items():
        mode = (
            "ast match; definition lines excluded"
            if ast_handled else
            "word-boundary lexical match; definition lines included, not "
            "excluded — see find_symbol to specifically locate definitions"
        )
        lines.append(f"\n{rel} ({mode}):")
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
    index = _load_current_repo_index(workspace)
    relative = _relative_semantic_path(source, workspace)
    if index is not None and relative:
        indexed = semantic_related_tests(index, relative)
        if indexed:
            return (
                f"Found {len(indexed)} indexed related test file(s) for "
                f"'{source.name}' [provenance=repo-index relation]:\n"
                + "\n".join(indexed)
            )
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


def find_impact_paths(path, workspace):
    """Return import-neighbour and test paths from a current repo index."""
    relative = _relative_semantic_path(path, workspace)
    if not relative:
        return "No impact paths: path is outside the workspace."
    index = _load_current_repo_index(workspace)
    if index is None:
        return (
            "No impact paths available: repo-index.json is missing or stale. "
            "Use find_references/grep_search as the explicitly lexical fallback."
        )
    paths = semantic_impact_paths(index, relative, _SEMANTIC_MAX_MATCHES)
    if not paths:
        return f"No indexed impact paths found for '{relative}'."
    return (
        f"Found {len(paths)} impact path(s) for '{relative}' "
        "[provenance=repo-index graph]:\n" + "\n".join(paths)
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
    elif tool_name == "impact_paths":
        text = find_impact_paths(arguments.get("path", ""), workspace)
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
                    "TS/JS: lexical/regex-based (function X / const X = / "
                    "class X / interface X / type X =) — not a real "
                    "language server; unusual declaration syntax may be "
                    "missed. Python: a real stdlib `ast` parse (def X / "
                    "class X, including methods nested inside a class), "
                    "falling back to the same lexical scan only on a file "
                    "with a real syntax error."
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
                    "workspace (grouped by file). Prefer this over "
                    "grep_search for 'where is X used' questions. TS/JS: "
                    "lexical word-boundary match — will not match the "
                    "name as a substring of a longer identifier (e.g. "
                    "'foo' will not match 'foobar'), but the definition "
                    "line(s) are NOT excluded (they contain the bare word "
                    "too), so this tool's output may overlap with "
                    "find_symbol's. Python: a real stdlib `ast` parse — "
                    "only real usage sites (calls, reads, `self.x`-style "
                    "attribute access) are reported, definition lines are "
                    "correctly excluded, and a comment/string merely "
                    "mentioning the name is never a false match; falls "
                    "back to the same lexical scan on a file with a real "
                    "syntax error."
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
        "display_name": "Find impact paths",
        "tool": "impact_paths",
        "type": "function",
        "permissions": {"write": False},
        "uses_cwd": True,
        "definition": {
            "type": "function",
            "function": {
                "name": "impact_paths",
                "description": (
                    "Find files connected to a source path through the current "
                    "repository import/test graph. Results are available only "
                    "from a cache-valid repo-index.json and include explicit "
                    "graph provenance; use grep_search as a labelled fallback."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Workspace-relative or absolute source path.",
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
# Task 7.4 (V7 "Documentation tools" / "Bootstrapping an existing
# repository"): docs_search / docs_get_node / docs_impact -- read-only,
# served in-process exactly like the O4 semantic tools above, but offered
# ONLY when <workspace>/docs/graph.json exists (deterministic
# availability, same "structural gate" spirit as
# _augment_tools_with_consult_architect below, just with no budget: these
# are pure reads with no side effect or cost to ration).
#
# glimmer-v2.py owns the AUTHORITATIVE graph reader/writer and impact
# mapper (load_doc_graph / map_changed_files_to_doc_nodes /
# _categories_for_path / _CATEGORY_TO_NODE_TYPE) -- but v2.py and this
# file are separate subprocess entry points that never import each other
# (same reasoning as _normalize_advisory_path's comment further below).
# docs_impact's mapping logic is therefore REPLICATED verbatim rather than
# shared, so keep the two in sync by hand if either changes -- same
# discipline this codebase already applies to the architect-risk-table
# mirror between the two files.
# ============================================================

DOC_GRAPH_RELATIVE_PATH = "docs/graph.json"
ADR_DECISIONS_RELATIVE_DIR = "docs/decisions"

DOC_TOOLS_SEARCH_CAP = 20
DOC_TOOLS_NODE_EDGES_CAP = 50
DOC_TOOLS_ADR_SCAN_CAP = 100


def _load_doc_graph_for_engineer(workspace):
    """Read-only mirror of glimmer-v2.py's load_doc_graph: absent file ->
    None (most repos have no graph yet -- not an error); malformed JSON,
    or valid JSON that isn't the {"nodes": [...]} shape -> None + a
    warning, never raises. `workspace` is always the resolved, already-
    validated (git-root) workspace Path run_engineer/run_architect pass
    in -- DOC_GRAPH_RELATIVE_PATH is a fixed literal, never model/
    argument-controlled, so there is no path-containment concern here
    (contrast PATH_TOOLS, which sanitize a model-supplied path)."""
    path = Path(workspace) / DOC_GRAPH_RELATIVE_PATH
    if not path.is_file():
        return None
    try:
        graph = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        print(f"[glimmer-engineer] WARN: malformed {DOC_GRAPH_RELATIVE_PATH}: {exc}")
        return None
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list):
        return None
    graph.setdefault("edges", [])
    return graph


def _load_adr_titles_for_engineer(workspace):
    """Minimal ADR reader for docs_search only: id/title/path, not the
    full frontmatter glimmer-v2.py's load_adrs parses (areas/status/body
    aren't needed for a title search). Same tolerant, capped, never-
    raises discipline as that reader -- deliberately smaller since a
    title search is the ONLY thing this file needs from an ADR."""
    decisions_dir = Path(workspace) / ADR_DECISIONS_RELATIVE_DIR
    if not decisions_dir.is_dir():
        return []
    out = []
    for path in sorted(decisions_dir.glob("ADR-*.md"))[:DOC_TOOLS_ADR_SCAN_CAP]:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        adr_id, title = None, None
        for line in text.splitlines()[:20]:
            line = line.strip()
            if line.lower().startswith("id:"):
                adr_id = line.split(":", 1)[1].strip()
            elif line.lower().startswith("title:"):
                title = line.split(":", 1)[1].strip()
            if adr_id and title:
                break
        if adr_id:
            out.append({
                "id": adr_id,
                "title": title or adr_id,
                "path": str(path.relative_to(Path(workspace))),
            })
    return out


def _docs_search(query, graph, workspace):
    """docs_search(query): exact-token search (split on non-alnum, case-
    insensitive -- same boundary rule as this codebase's other
    deterministic matchers) over graph node id/type/path/title AND ADR
    id/title. Capped to DOC_TOOLS_SEARCH_CAP results."""
    tokens = {t for t in re.split(r"[^a-z0-9]+", str(query or "").lower()) if t}
    if not tokens:
        return "docs_search: empty query."

    results = []
    for node in graph.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        haystack = " ".join(str(node.get(k, "")) for k in ("id", "type", "path", "title"))
        node_tokens = {t for t in re.split(r"[^a-z0-9]+", haystack.lower()) if t}
        if tokens & node_tokens:
            results.append(
                f"node {node.get('id')} ({node.get('type')}, {node.get('status')}): "
                f"{node.get('path')} -- {node.get('title')}"
            )

    for adr in _load_adr_titles_for_engineer(workspace):
        haystack = f"{adr['id']} {adr['title']}"
        adr_tokens = {t for t in re.split(r"[^a-z0-9]+", haystack.lower()) if t}
        if tokens & adr_tokens:
            results.append(f"adr {adr['id']}: {adr['title']} ({adr['path']})")

    if not results:
        return f"docs_search: no matches for {query!r}."
    return "\n".join(results[:DOC_TOOLS_SEARCH_CAP])


def _docs_get_node(node_id, graph):
    """docs_get_node(id): one node plus its edges (either endpoint),
    capped to DOC_TOOLS_NODE_EDGES_CAP. Read-only, one hop only -- no
    graph traversal beyond the node's own direct edges."""
    node = next(
        (n for n in (graph.get("nodes") or []) if isinstance(n, dict) and n.get("id") == node_id),
        None,
    )
    if node is None:
        return f"docs_get_node: no node with id {node_id!r}."
    edges = [
        e for e in (graph.get("edges") or [])
        if isinstance(e, dict) and (e.get("from") == node_id or e.get("to") == node_id)
    ][:DOC_TOOLS_NODE_EDGES_CAP]
    return json.dumps({"node": node, "edges": edges}, indent=2, ensure_ascii=False)


# Task 7.2 keyword table, REPLICATED verbatim from glimmer-v2.py's
# _DOC_IMPACT_WORDS / _CAMEL_AWARE_CATEGORIES / _word_hits /
# _categories_for_path / _CATEGORY_TO_NODE_TYPE (see the module comment
# at the top of this section for why this is a replica, not an import) --
# keep these five in sync by hand with glimmer-v2.py if either changes.
_DOC_IMPACT_WORDS = {
    "routes": ("routes", "router"),
    "schema": ("schema", "schemas", "migration", "migrations", "prisma"),
    "api": ("api", "openapi", "swagger"),
    "config": ("config",),
    "auth": ("auth", "authentication", "session", "sessions", "permission",
              "permissions", "token", "tokens"),
}
_CAMEL_AWARE_CATEGORIES = {"auth"}


def _doc_impact_word_hits(word, path, camel_aware):
    """Replica of glimmer-v2.py's _word_hits -- see that function's
    docstring for the full boundary-rule rationale."""
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


def _doc_impact_categories_for_path(raw):
    """Replica of glimmer-v2.py's _categories_for_path."""
    path = str(raw).replace("\\", "/")
    lower = path.lower()
    segments = [s for s in lower.split("/") if s]
    basename = segments[-1] if segments else lower

    categories = set()
    for category, words in _DOC_IMPACT_WORDS.items():
        camel_aware = category in _CAMEL_AWARE_CATEGORIES
        for word in words:
            if _doc_impact_word_hits(word, path, camel_aware):
                categories.add(category)
                break

    if basename.endswith(".sql"):
        categories.add("schema")
    if basename == "dockerfile" or basename.startswith("docker-compose"):
        categories.add("config")
    if basename == ".env.example":
        categories.add("config")
    if ".github" in segments and "workflows" in segments:
        categories.add("config")
    return categories


_CATEGORY_TO_NODE_TYPE = {
    "routes": "route",
    "schema": "schema",
    "config": "config",
    "api": "service",
    "auth": "service",
}


def _paths_share_area(path, node_path):
    """Replica of glimmer-v2.py's _paths_share_area (Review round 7, M1)
    -- see that function's docstring for the full rationale. Scopes the
    category heuristic below to nodes actually near the changed file
    instead of every node of that type in the graph."""
    if not path or not node_path:
        return False
    if path == node_path:
        return True
    if path.startswith(node_path.rstrip("/") + "/") or node_path.startswith(path.rstrip("/") + "/"):
        return True
    path_dir = path.rsplit("/", 1)[0] if "/" in path else ""
    node_dir = node_path.rsplit("/", 1)[0] if "/" in node_path else ""
    return bool(path_dir) and path_dir == node_dir


def _map_changed_files_to_doc_nodes(graph, changed_files):
    """Replica of glimmer-v2.py's map_changed_files_to_doc_nodes -- see
    that function's docstring for the full three-signal (path-prefix +
    keyword-category + evidence-link) rationale, including the M1
    path-scoping fix on the category signal and the Round 7 live
    checkpoint L3 evidence-link signal. Pure, no I/O."""
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
            evidence = (node.get("provenance") or {}).get("evidence") or []
            if any(path == str(ev).replace("\\", "/") for ev in evidence):
                touched.add(node["id"])
        for category in _doc_impact_categories_for_path(path):
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


def _docs_impact(files, graph):
    impacted = _map_changed_files_to_doc_nodes(graph, files)
    if not impacted:
        return "docs_impact: no impacted documentation nodes."
    return "\n".join(impacted)


def _execute_doc_tool(tool_name, arguments, workspace):
    """Single dispatch point for DOC_TOOL_NAMES, same shape convention as
    _execute_semantic_tool. `_loaded_doc_graph` is re-checked here (not
    just at offer-time in _augment_tools_with_doc_tools) so a model that
    calls one of these anyway when no graph exists gets an honest "not
    available" text answer -- harmless (these tools have no side effects
    or budget to abuse), rather than a crash."""
    if _loaded_doc_graph is None:
        return {"plain_text_response": (
            f"{tool_name}: no {DOC_GRAPH_RELATIVE_PATH} in this workspace -- "
            "documentation tools are unavailable for this session."
        )}
    if tool_name == "docs_search":
        text = _docs_search(arguments.get("query", ""), _loaded_doc_graph, workspace)
    elif tool_name == "docs_get_node":
        text = _docs_get_node(str(arguments.get("id", "")), _loaded_doc_graph)
    elif tool_name == "docs_impact":
        files = arguments.get("files")
        if not isinstance(files, list):
            files = [files] if files else []
        text = _docs_impact(files, _loaded_doc_graph)
    else:
        raise ValueError(f"unknown doc tool: {tool_name}")
    return {"plain_text_response": text}


DOC_TOOL_DEFINITIONS = [
    {
        "display_name": "Search documentation",
        "tool": "docs_search",
        "type": "function",
        "permissions": {"write": False},
        "uses_cwd": True,
        "definition": {
            "type": "function",
            "function": {
                "name": "docs_search",
                "description": (
                    "Exact-token search over the workspace's documentation "
                    "graph (docs/graph.json node ids/types/paths/titles) "
                    "and ADR titles (docs/decisions/). Only offered when "
                    "docs/graph.json exists. Capped to "
                    f"{DOC_TOOLS_SEARCH_CAP} results."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search terms."},
                    },
                    "required": ["query"],
                },
            },
        },
    },
    {
        "display_name": "Get documentation node",
        "tool": "docs_get_node",
        "type": "function",
        "permissions": {"write": False},
        "uses_cwd": True,
        "definition": {
            "type": "function",
            "function": {
                "name": "docs_get_node",
                "description": (
                    "Fetch one documentation graph node by exact id, plus "
                    "its edges (one hop). Only offered when docs/graph.json "
                    "exists."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "description": "Exact node id."},
                    },
                    "required": ["id"],
                },
            },
        },
    },
    {
        "display_name": "Documentation impact",
        "tool": "docs_impact",
        "type": "function",
        "permissions": {"write": False},
        "uses_cwd": True,
        "definition": {
            "type": "function",
            "function": {
                "name": "docs_impact",
                "description": (
                    "Given a list of changed file paths, return which "
                    "documentation graph node ids are impacted (path-prefix "
                    "and keyword-category matching against docs/graph.json). "
                    "Only offered when docs/graph.json exists."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "files": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Changed file paths (workspace-relative).",
                        },
                    },
                    "required": ["files"],
                },
            },
        },
    },
]


def _augment_tools_with_doc_tools(metadata, tools, workspace):
    """Mutates metadata/tools IN PLACE to add the three docs_* tools --
    ONLY when <workspace>/docs/graph.json exists (deterministic
    availability, per Task 7.4: "Tools offered ONLY when docs/graph.json
    exists in the workspace"). Also sets the module-level _loaded_doc_
    graph global _execute_doc_tool reads from -- same single-load-point
    pattern as _loaded_architecture_plan."""
    global _loaded_doc_graph
    _loaded_doc_graph = _load_doc_graph_for_engineer(workspace)
    if _loaded_doc_graph is None:
        return
    for item in DOC_TOOL_DEFINITIONS:
        metadata[item["tool"]] = item
        tools.append(item["definition"])


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
        append_jsonl_durable(path, record)
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
    if mode == "architect" and _requires_tool_approval(tool_name):
        message = (
            "ENGINEERING SECURITY BLOCK: architect mode is read-only; "
            "write-capable tools are never executed in this mode."
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

    try:
        arguments = secure_tool_arguments(
            tool_name,
            arguments,
            workspace,
        )
    except ToolPolicyBlock as exc:
        # Round 9 review (M5): check_write_path raises ToolPolicyBlock for a
        # real policy block (.env*, PROTECTED_DIRS, lockfiles, docs/
        # graph.json) -- but nothing here used to emit tool_blocked or
        # record_blocked_command. The caller's own generic `except
        # Exception` just stringified it into "TOOL BLOCKED/ERROR: ..." and
        # printed it: a real write was attempted and blocked, with ZERO
        # audit trail (no tool_blocked event, no repo-memory record, no
        # POLICY_BLOCK envelope -- classify_failure's POLICY_BLOCK branch,
        # glimmer-metrics.py's taxonomy, and CC's event feed never saw it).
        # Route it through the exact same block-reporting shape the
        # shell_policy rejection below uses, so every policy-block class
        # shares one audit path. Deliberately NOT catching plain
        # PermissionError here -- see ToolPolicyBlock's own docstring for
        # why the usage-error guards (existing-file write, missing-file
        # edit, read-dir) must keep propagating unchanged. Path traversal
        # ("Path escapes repository") is a ToolPolicyBlock too (round-9
        # re-review NEW-1): a security-boundary violation belongs on this
        # audit path, not in the generic stringifier.
        reason = str(exc)
        # m4 (followup-1-2 review): a human declining a scope expansion is
        # not "you tried to write a secret" -- same ToolPolicyBlock/
        # POLICY_BLOCK plumbing (right, keeps one audit path), distinct
        # label (see _enforce_scope_expansion_approval's own raise text).
        if reason.startswith("out-of-scope write requires human approval"):
            message = "SCOPE EXPANSION DECLINED: " + reason
        else:
            message = "ENGINEERING SECURITY BLOCK: " + reason
        blocked_path = str(arguments.get("path", tool_name))[:MAX_EVENT_FIELD]

        print()
        print(f"✗ BLOCKED: {tool_name} {blocked_path}")
        print(f"  {reason}")

        _emit(
            "tool_blocked",
            command=blocked_path,
            reason=reason,
        )
        record_blocked_command(workspace, blocked_path, reason)

        envelope = _build_tool_envelope(
            ok=False,
            tool=tool_name,
            duration_ms=_duration_ms(),
            error={"code": "POLICY_BLOCK", "message": message},
        )
        _persist_tool_envelope(envelope)

        return _render_tool_envelope_message(envelope), False

    cache_key = None

    # O4: the three semantic tools are idempotent/read-only exactly like
    # read_file/file_glob_search/grep_search, so they share the same
    # (tool, args)-keyed cache — including its existing invalidation
    # (cache.clear() on every successful write in run_engineer's loop).
    # Task 7.4: the docs_* tools are equally idempotent within a session
    # (the graph is loaded once, never changes mid-session) — same cache.
    if tool_name in {
        "read_file",
        "file_glob_search",
        "grep_search",
    } | SEMANTIC_TOOL_NAMES | DOC_TOOL_NAMES:
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
            # Stricter than shell_policy: read-only git and the shared
            # positive GitHub CLI inspection allowlist only. See
            # architect_shell_policy's docstring.
            allowed, reason = architect_shell_policy(command, workspace)
        else:
            allowed, reason = shell_policy(
                command,
                workspace,
                validation_allowlist,
            )

        if not allowed:
            # Task 8.3 (V7 §14/§35): a shell_policy-rejected command may
            # STILL be a YELLOW case -- dependency install / migration
            # keyword -- that a human can unlock via the file-based
            # approval sidecar, rather than a hard RED block. classify_
            # yellow delegates the actual verdict back to shell_policy
            # (via yellow_relax), so it never changes what shell_policy
            # already said for anything it doesn't match (commit/push/
            # deploy and everything else stay exactly as blocked as
            # before). Positive allowlist (mode is None, i.e. plain
            # engineer mode), not a negative one keyed off "architect" --
            # architect mode has no approval path (C1 scoping) and any
            # future mode inherits that safe default automatically
            # instead of silently getting the approval path by omission
            # (mode defaults to the literal string "engineer" -- there is
            # no real None value in practice, see execute_tool's own
            # signature).
            yellow = classify_yellow(command, workspace, validation_allowlist) if mode == "engineer" else None
            if yellow is not None:
                decision, detail = request_approval_and_wait(
                    yellow["action"], yellow["reason"], yellow["proposedChanges"], yellow["risk"],
                    tool_name=tool_name, command=command,
                )
                if decision == "approved":
                    allowed = True
                    reason = f"human-approved YELLOW escalation: {yellow['action']}" + (
                        f" (approved by {detail})" if detail else ""
                    )
                else:
                    reason = f"{reason} [YELLOW escalation {decision}]"

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
                    "\n↻ CACHE: exec_shell_command "
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
        _requires_tool_approval(tool_name)
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

    if _requires_tool_approval(tool_name):
        # Redacted: write-capable tool arguments can carry file content,
        # credentials, or external payloads, so only keys and a safe local
        # path (for the two built-in file tools) are ever emitted.
        display_args = {
            "keys":
                list(arguments.keys()),
        }
        if tool_name in WRITE_TOOLS:
            display_args["path"] = arguments.get("path")
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
    elif tool_name in DOC_TOOL_NAMES:
        # Task 7.4: same in-process interception as the semantic tools
        # just above, never reaches http_json either.
        result = _execute_doc_tool(
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

            # ------------------------------------------------------
            # 3. Round 9 review (M5): a write-path PermissionError
            #    (check_write_path via secure_tool_arguments -- .env* here)
            #    must get the SAME audit trail as the shell_policy block
            #    above: a tool_blocked event, a repo-memory record, and a
            #    POLICY_BLOCK envelope -- not just a stringified message
            #    swallowed by the caller's generic except.
            # ------------------------------------------------------
            events_before = [
                json.loads(line) for line in Path(GLIMMER_EVENTS_PATH).read_text().splitlines()
            ]

            env_message, env_changed = execute_tool(
                "write_file",
                {"path": ".env", "content": "SECRET=1"},
                workspace,
                approval_state,
                cache,
                ledger,
            )

            assert env_changed is False
            assert "ENGINEERING SECURITY BLOCK" in env_message, env_message
            assert ".env" in env_message, env_message
            assert not (workspace / ".env").exists(), (
                "the blocked write must never actually happen"
            )

            records = [json.loads(line) for line in evidence_path.read_text().splitlines()]
            envelopes = [r for r in records if r.get("kind") == "tool_envelope"]
            env_envelope = envelopes[-1]
            assert env_envelope["ok"] is False
            assert env_envelope["tool"] == "write_file"
            assert env_envelope["error"]["code"] == "POLICY_BLOCK"

            events_after = [
                json.loads(line) for line in Path(GLIMMER_EVENTS_PATH).read_text().splitlines()
            ]
            new_events = events_after[len(events_before):]
            blocked_events = [e for e in new_events if e.get("type") == "tool_blocked"]
            assert len(blocked_events) == 1, (
                f"write_file(.env) must emit exactly one tool_blocked event, got: {new_events!r}"
            )
            assert ".env" in blocked_events[0].get("command", ""), blocked_events[0]

    finally:
        http_json = real_http_json
        GLIMMER_EVENTS_PATH = real_events_path
        GLIMMER_SESSION_ID = real_session_id
        _evidence_file_path.cache_clear()
        _evidence_seq = 0

    print("tool envelope self-check: PASS")


def _github_cli_policy_selfcheck() -> None:
    """Regression coverage for the positive GitHub CLI allowlist."""
    workspace = Path("/tmp")

    allowed_commands = (
        "gh auth status",
        "gh auth status --hostname github.com --active",
        "gh pr list",
        "gh pr view 42 --comments",
        "gh pr status",
        "gh pr checks 42",
        "gh issue list --limit 20",
        "gh run view 123 --log",
        "gh workflow view ci.yml",
        "gh release view v1",
        "gh repo view",
        "gh repo view --json name,url",
    )
    blocked_commands = (
        "gh auth login",
        "gh auth logout",
        "gh auth token",
        "gh auth status --hostname enterprise.example.com",
        "gh api repos/owner/repo",
        "gh secret list",
        "gh pr create --title x --body y",
        "gh pr merge 42",
        "gh pr comment 42 --body x",
        "gh issue create --title x --body y",
        "gh workflow run ci.yml",
        "gh run rerun 123",
        "gh run cancel 123",
        "gh release create v1",
        "gh pr list --repo owner/other",
        "gh pr list -Rowner/other",
        "gh repo view owner/other",
        "gh pr view https://github.com/owner/other/pull/42",
        "gh pr view 42 --web",
        "gh pr checks 42 --watch",
        "gh pr list; gh pr create --title x --body y",
    )

    for command in allowed_commands:
        allowed, reason = shell_policy(command, workspace)
        assert allowed is True, f"expected GitHub CLI read to pass: {command!r}: {reason}"

    for command in blocked_commands:
        allowed, reason = shell_policy(command, workspace)
        assert allowed is False, f"expected GitHub CLI mutation/scope escape to fail: {command!r}: {reason}"

    assert architect_shell_policy("gh pr list", workspace)[0] is True
    assert architect_shell_policy("gh workflow run ci.yml", workspace)[0] is False

    print("GitHub CLI policy self-check: PASS")


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
        READ_TOOLS | WRITE_TOOLS | {"exec_shell_command", "get_datetime"}
        | SEMANTIC_TOOL_NAMES | DOC_TOOL_NAMES
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

    # exec_shell_command in architect mode: read-only git and the shared,
    # positive GitHub CLI inspection allowlist pass.
    ws = Path("/tmp")
    assert architect_shell_policy("git status", ws)[0] is True
    assert architect_shell_policy("git diff --stat", ws)[0] is True
    assert architect_shell_policy("git rev-parse --show-toplevel", ws)[0] is True
    assert architect_shell_policy("gh pr list", ws)[0] is True
    assert architect_shell_policy("gh issue view 42", ws)[0] is True
    assert architect_shell_policy("gh pr create --title x --body y", ws)[0] is False
    assert architect_shell_policy("gh api repos/owner/repo", ws)[0] is False
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
                    ok_bad, _reason = validate_architecture_plan(parsed_bad)
                except ValueError:
                    ok_bad, _reason = False, "unparseable"
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
    # main()'s --mode choices must still treat C2's review capability as
    # a sub-mode of "architect", not a distinct --mode value of its own —
    # unlike Task 8.2's later "consult" (a genuinely different, tool-free
    # one-call mode with no read-only repo-exploration loop at all, so it
    # earns its own --mode value rather than piggybacking on architect's).
    assert 'choices=("engineer", "architect", "consult")' in inspect.getsource(main), (
        "C2 must not add a new --mode value for review; review is a sub-mode of architect"
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

def _reduced_context_messages(messages):
    """Task 6.2 (V7 §17 recovery attempt 3): rebuild `messages` down to
    Tier0 (system + task/contract -- indices 0/1, see the
    CONTEXT_BUDGET_CHARS/TIER0_BUDGET_PCT tier model above run_engineer)
    plus the single most recent message -- the immediate failure/tool-
    result context the model was reacting to when the parser failure
    hit. Returns None when there's nothing left to usefully reduce
    (3 or fewer messages already IS system+task+one message -- rebuilding
    would just repeat the exact request an earlier attempt already
    tried)."""
    if len(messages) <= 3:
        return None
    return [messages[0], messages[1], messages[-1]]


def chat_with_retry(
    payload,
    attempts=3,
    role="engineer",
):
    """
    Call llama-server with adaptive PEG recovery.

    Attempt 1:
        Preserve the normal model reasoning configuration.

    Attempts 2+ after a peg-native parser failure:
        Disable model thinking for tool-bearing turns so the
        model produces a simpler structured tool-call response.

    One further attempt (V7 §17 recovery tier 3), after the attempts
    above are exhausted:
        Reduced context -- rebuild messages as Tier0 (system + task)
        plus only the single most recent message, thinking still
        disabled. See _reduced_context_messages.

    If parsing still fails after all attempts, the caller's
    deterministic fail-closed fallback (final_synthesis) handles the
    failure.

    `role` selects which ModelProvider (see MODEL_ROLES) makes the
    actual call -- callers pass "architect"/"consult" for those modes;
    "engineer" (the default) covers the main engineer loop and the
    delivery-review turn.
    """

    last_error = None
    provider = _provider_for_role(role)

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

            request_id = uuid.uuid4().hex[:12]
            return provider.generate(request_payload, request_id=request_id)

        except RuntimeError as exc:
            if (
                "peg-native"
                not in str(exc)
            ):
                raise

            last_error = exc
            # The id actually used for the failed attempt (generate()
            # sets this even when it raises) -- included in the events
            # below and already printed by ModelProvider.generate itself.
            request_id = provider.last_request_id

            print()
            print(
                "⚠ PEG parser failure "
                f"({attempt}/{attempts}) [request {request_id}]"
            )

            _emit(
                "parser_recovery",
                attempt=attempt,
                payloadPath=str(debug_path) if debug_path else "",
                requestId=request_id,
                # Additive (Task 6.2): "thinking_disabled" once reasoning
                # is off (attempt > 1); omitted for the plain first
                # attempt, which used neither recovery strategy.
                **({"strategy": "thinking_disabled"} if peg_recovery_mode else {}),
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
                    requestId=request_id,
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

    # ----------------------------------------------------
    # RECOVERY TIER 3 (V7 §17 attempt 3): reduced context.
    # ----------------------------------------------------
    #
    # One extra attempt after the normal attempts ladder above is
    # exhausted, before the caller's final_synthesis fail-closed
    # fallback (attempt 4) takes over. Thinking stays disabled (same
    # reasoning as attempts 2+ above) on top of the smaller context.
    reduced_messages = _reduced_context_messages(base_payload.get("messages") or [])

    if reduced_messages is not None:
        reduced_payload = dict(base_payload)
        reduced_payload["messages"] = reduced_messages
        reduced_payload["reasoning_effort"] = "none"

        template_kwargs = dict(reduced_payload.get("chat_template_kwargs") or {})
        template_kwargs["enable_thinking"] = False
        reduced_payload["chat_template_kwargs"] = template_kwargs

        request_id = uuid.uuid4().hex[:12]

        _emit(
            "model_retry",
            attempt=attempts + 1,
            strategy="reduced_context",
            requestId=request_id,
        )
        print()
        print(
            "Retrying with reduced context "
            "(system + task + last message only)..."
        )

        try:
            return provider.generate(reduced_payload, request_id=request_id)
        except RuntimeError as exc:
            if "peg-native" not in str(exc):
                raise

            last_error = exc
            request_id = provider.last_request_id

            print()
            print(
                "⚠ PEG parser failure "
                f"(reduced-context attempt) [request {request_id}]"
            )
            _emit(
                "parser_recovery",
                attempt=attempts + 1,
                payloadPath="",
                strategy="reduced_context",
                requestId=request_id,
            )

    raise last_error


def _recovery_ladder_selfcheck() -> None:
    """Task 6.2 (V7 §17): chat_with_retry's full recovery ladder --
    normal -> thinking-disabled (attempts 2..N) -> reduced-context (one
    extra attempt) -> the caller's final_synthesis fallback (exercised
    via source inspection: chat_with_retry itself only raises; the
    caller decides to fall back). Monkeypatches http_json (the shared
    transport) so no live llama-server is needed. Run with:
    python3 glimmer-engineer.py --recovery-ladder-selfcheck
    """
    import inspect
    import tempfile

    global model_http_json, GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID

    real_model_http_json = model_http_json
    real_events_path = GLIMMER_EVENTS_PATH
    real_session_id = GLIMMER_SESSION_ID
    # Fix round 1 (MED): same discipline as _model_provider_selfcheck --
    # the tier-3 success sub-check routes through the real "engineer"
    # provider singleton, which bumps the module-global usage totals; left
    # unrestored, the atexit writer could fabricate a model-usage.json
    # into a live session dir when this selfcheck runs with session env set.
    real_totals = {k: dict(v) for k, v in _MODEL_USAGE_TOTALS.items()}
    _MODEL_USAGE_TOTALS.clear()

    messages = [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "TASK"},
        {"role": "assistant", "content": "did something"},
        {"role": "tool", "content": "tool result 1", "tool_call_id": "c1"},
        {"role": "assistant", "content": "did more"},
        {"role": "tool", "content": "tool result 2 -- the last one", "tool_call_id": "c2"},
    ]
    payload = {
        "model": "muse-glimmer",
        "messages": messages,
        "tools": [{"type": "function", "function": {"name": "x"}}],
    }

    seen_payloads = []

    def fake_peg_failure(provider_arg, method, endpoint, payload=None, extra_headers=None, timeout_s=3600):
        seen_payloads.append(payload)
        raise RuntimeError("peg-native parse failure: bad tool call")

    try:
        with tempfile.TemporaryDirectory() as td:
            events_path = Path(td) / "events.jsonl"
            events_path.write_text("")
            GLIMMER_EVENTS_PATH = str(events_path)
            GLIMMER_SESSION_ID = "sess-ladder"

            model_http_json = fake_peg_failure
            try:
                chat_with_retry(payload, attempts=3)
                assert False, "must raise once every ladder rung is exhausted"
            except RuntimeError as exc:
                assert "peg-native" in str(exc)

            # attempts=3 (normal, thinking-disabled x2) + 1 reduced-context
            # tier-3 attempt = 4 physical calls total.
            assert len(seen_payloads) == 4, f"expected 4 ladder attempts, got {len(seen_payloads)}"

            # Attempt 1: normal -- no reasoning_effort/enable_thinking
            # override, full message history untouched.
            assert "reasoning_effort" not in seen_payloads[0]
            assert seen_payloads[0]["messages"] == messages

            # Attempts 2-3: thinking disabled, SAME (full) message history
            # -- only reasoning changes, not context.
            for i in (1, 2):
                assert seen_payloads[i]["reasoning_effort"] == "none"
                assert seen_payloads[i]["chat_template_kwargs"]["enable_thinking"] is False
                assert seen_payloads[i]["messages"] == messages

            # Attempt 4: reduced context -- Tier0 (system+task) + last
            # message only, thinking still disabled.
            reduced = seen_payloads[3]
            assert reduced["reasoning_effort"] == "none"
            assert reduced["chat_template_kwargs"]["enable_thinking"] is False
            assert reduced["messages"] == [messages[0], messages[1], messages[-1]], (
                f"reduced-context attempt must be [system, task, last message only], "
                f"got {reduced['messages']}"
            )
            assert len(reduced["messages"]) == 3

            # Events: parser_recovery gains strategy on the recovery
            # attempts (never on the plain first attempt), and every
            # emit carries a requestId; model_retry announces the
            # reduced_context tier by name.
            events = [json.loads(line) for line in events_path.read_text().splitlines()]

            parser_recovery_events = [e for e in events if e["type"] == "parser_recovery"]
            assert len(parser_recovery_events) == 4
            assert "strategy" not in parser_recovery_events[0], "attempt 1's failure has no recovery strategy yet"
            assert parser_recovery_events[1]["strategy"] == "thinking_disabled"
            assert parser_recovery_events[2]["strategy"] == "thinking_disabled"
            assert parser_recovery_events[3]["strategy"] == "reduced_context"
            assert all(e.get("requestId") for e in parser_recovery_events), "every parser_recovery needs a requestId"

            model_retry_events = [e for e in events if e["type"] == "model_retry"]
            # 2 mid-ladder retries (announcing attempts 2 and 3) + 1
            # announcing the reduced-context tier.
            assert len(model_retry_events) == 3
            assert model_retry_events[-1]["strategy"] == "reduced_context"
            assert model_retry_events[-1]["attempt"] == 4
            assert all(e.get("requestId") for e in model_retry_events)

        # No session dir needed for the remaining sub-checks (payload
        # shape / return value only) -- avoid emitting into a now-deleted
        # temp dir.
        GLIMMER_EVENTS_PATH = None
        GLIMMER_SESSION_ID = None

        # ------------------------------------------------------------
        # Fewer than 4 messages: reduced context has nothing left to cut
        # -- the tier-3 attempt must be skipped (not repeat an identical
        # request), so exactly `attempts` calls are made, not attempts+1.
        # ------------------------------------------------------------
        seen_payloads.clear()
        small_payload = {
            "model": "muse-glimmer",
            "messages": [
                {"role": "system", "content": "SYS"},
                {"role": "user", "content": "TASK"},
            ],
        }
        try:
            chat_with_retry(small_payload, attempts=2)
            assert False
        except RuntimeError:
            pass
        assert len(seen_payloads) == 2, (
            f"with only Tier0 messages, the reduced-context tier must be "
            f"skipped entirely (got {len(seen_payloads)} calls)"
        )

        # ------------------------------------------------------------
        # Success at the reduced-context tier: chat_with_retry returns
        # normally, same as any other successful attempt.
        # ------------------------------------------------------------
        call_count = {"n": 0}

        def fake_fail_then_succeed(provider_arg, method, endpoint, payload=None, extra_headers=None, timeout_s=3600):
            call_count["n"] += 1
            if call_count["n"] <= 3:
                raise RuntimeError("peg-native parse failure")
            return {"choices": [{"message": {"role": "assistant", "content": "recovered"}}]}

        model_http_json = fake_fail_then_succeed
        response = chat_with_retry(payload, attempts=3)
        assert response["choices"][0]["message"]["content"] == "recovered"
        assert call_count["n"] == 4, "must succeed on exactly the reduced-context (4th) attempt"

        # ------------------------------------------------------------
        # role routing: chat_with_retry(role=...) actually reaches the
        # matching ModelProvider; run_architect / _run_consult_architect
        # actually pass their role (source inspection, same style as
        # _consult_selfcheck's wiring checks).
        # ------------------------------------------------------------
        source = inspect.getsource(chat_with_retry)
        assert "_provider_for_role(role)" in source

        architect_source = inspect.getsource(run_architect)
        assert 'role="architect"' in architect_source, (
            'run_architect must call chat_with_retry with role="architect"'
        )
        consult_source = inspect.getsource(_run_consult_architect)
        assert 'role="consult"' in consult_source, (
            '_run_consult_architect must call chat_with_retry with role="consult"'
        )

    finally:
        model_http_json = real_model_http_json
        GLIMMER_EVENTS_PATH = real_events_path
        GLIMMER_SESSION_ID = real_session_id
        _MODEL_USAGE_TOTALS.clear()
        _MODEL_USAGE_TOTALS.update(real_totals)

    print("recovery-ladder self-check: PASS")


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
ARCHITECT_DESIGN_REQUIREMENT_FIELDS = (
    "visualRequirements",
    "uxRequirements",
    "cmsRequirements",
    "designTokenRequirements",
)

ARCHITECT_SYSTEM_PROMPT = (
    "Reasoning strength: high. "
    "You are Glimmer Architect: a read-only architecture-planning agent "
    "operating inside one git repository, one step before an engineer "
    "implements anything.\n\n"

    "You have NO write access. write_file and edit_file are not offered "
    "to you in this mode, and any attempt to call them is rejected "
    "before it can touch the filesystem. Your exec_shell_command access "
    "is restricted to read-only git commands "
    "(git status, git diff, git show, git log, git rev-parse) and an "
    "allowlisted read-only subset of GitHub CLI (status/list/view/checks/"
    "diff for the current repository). GitHub CLI auth changes, token/API "
    "access, repository overrides, comments, merges and workflow triggers "
    "are blocked. You "
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

    "When TASK CONTRACT contains design, treat it as authoritative design "
    "intent. Trace the primary user action and every declared interaction "
    "state. Inspect the repository's existing CMS/content model before "
    "proposing content changes: preserve its source of truth, editorial "
    "workflow, preview/draft semantics, localization, empty/loading/error "
    "states, and avoid hardcoded editor-managed copy. Inspect existing "
    "design-token/theme sources before proposing styles: reuse semantic "
    "tokens and components, preserve theme mappings, and propose a new token "
    "only when design.designTokens.allowNewTokens is true and existing tokens "
    "cannot express the requirement. Treat design.inspirations as reference "
    "patterns, never permission to copy brand assets. For design.variants, "
    "produce the declared bounded alternatives for the named target and keep "
    "each alternative compatible with the existing component, CMS, responsive, "
    "accessibility, and token architecture. For design.elementEdits, treat the "
    "captured region and requested properties as authoritative intent, but verify "
    "the actual owning component and current literal: selectorHint and sourcePathHint "
    "are navigation hints, not proof, and must never trigger broad replacement. For "
    "design.assetRequests, identify a genuinely installed/configured generator and "
    "the declared output path. Never plan placeholder bytes, renamed unrelated media, "
    "or a success claim without a real generated artifact. Respect local-only versus "
    "generation-model reference policy; when the required capability or credentials "
    "are absent, plan an explicit BLOCKED result naming that prerequisite. Ground each "
    "CMS/token/tool-availability claim in files.\n\n"

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
    '  "visualRequirements": ["visible design checks"],\n'
    '  "uxRequirements": ["interaction, state, responsive and accessibility behavior"],\n'
    '  "cmsRequirements": ["content model and editorial workflow requirements"],\n'
    '  "designTokenRequirements": ["token reuse or justified token additions"],\n'
    '  "risk": "low|medium|high|critical (REQUIRED)",\n'
    '  "expectedScope": {"minFiles": 1, "maxFiles": 4},\n'
    '  "uncertainties": ["anything you could not confirm"],\n'
    '  "decisionPoints": [{"id":"decision-1", "question":"...", "impact":"low|medium|high", '
    '"options":["option A", "option B"]}]\n'
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
    for field in ARCHITECT_DESIGN_REQUIREMENT_FIELDS:
        plan[field] = []
    plan["decisionPoints"] = []

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
        atomic_write_json(path, output)
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
    for field in ARCHITECT_DESIGN_REQUIREMENT_FIELDS:
        requirements_raw = data.get(field, [])
        requirements = []
        if isinstance(requirements_raw, list):
            for item in requirements_raw[:MAX_VISUAL_REQUIREMENTS]:
                if isinstance(item, str) and item.strip():
                    requirements.append(item.strip()[:MAX_VISUAL_REQUIREMENT_CHARS])
        normalized[field] = requirements

    decision_points = []
    raw_decision_points = data.get("decisionPoints", [])
    if isinstance(raw_decision_points, list):
        for index, point in enumerate(raw_decision_points[:10]):
            if not isinstance(point, dict):
                continue
            question = point.get("question")
            impact = point.get("impact")
            options = point.get("options")
            if (
                not isinstance(question, str)
                or not question.strip()
                or impact not in {"low", "medium", "high"}
                or not isinstance(options, list)
            ):
                continue
            clean_options = [
                option.strip()[:300] for option in options[:3]
                if isinstance(option, str) and option.strip()
            ]
            if len(clean_options) < 2:
                continue
            decision_points.append({
                "id": str(point.get("id") or f"decision-{index + 1}")[:80],
                "question": question.strip()[:1000],
                "impact": impact,
                "options": clean_options,
            })
    normalized["decisionPoints"] = decision_points

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
# READ-ONLY TASK REPORTS (inspect / plan / review)
# ============================================================

TASK_REPORT_MODES = {"inspect", "plan", "review"}
TASK_REPORT_SEVERITIES = {"critical", "high", "medium", "low", "info"}
TASK_REPORT_CONFIDENCE = {"high", "medium", "low"}

TASK_REPORT_SYSTEM_PROMPT = (
    "Reasoning strength: high. You are Glimmer's read-only repository analyst. "
    "This is a terminal task mode, not a planning pre-step for a writer. You have "
    "NO write access: write_file/edit_file are not offered and are hard-blocked; "
    "exec_shell_command is restricted to read-only git and the allowlisted read-only "
    "GitHub CLI subset for the current repository. Do not install dependencies, "
    "run tests/builds, commit, push, or deploy. Inspect actual repository evidence "
    "before making repository-specific claims. Cite concrete files and line numbers "
    "when available; record uncertainty instead of inventing facts.\n\n"
    "For inspect, identify and prioritize evidence-backed repository findings. For "
    "plan, produce an actionable ordered implementation plan grounded in evidence. "
    "For review, focus on correctness, regressions, security, maintainability and "
    "missing tests in the selected scope.\n\n"
    "Your FINAL answer must be exactly one JSON object, no prose or markdown fence:\n"
    "{\n"
    '  "summary": "concise evidence-based result",\n'
    '  "findings": [{"severity":"critical|high|medium|low|info", "category":"...", '
    '"title":"...", "description":"...", "claimType":"presence|absence|behavior|risk", '
    '"evidenceIds":["exact ids returned by repository tools"], '
    '"evidence":[{"path":"src/x.ts", '
    '"line":12, "detail":"..."}], "recommendedFix":"..."}],\n'
    '  "implementationPlan": ["ordered step 1", "ordered step 2"],\n'
    '  "decisionPoints": [{"id":"decision-1", "question":"...", "impact":"low|medium|high", '
    '"options":["option A", "option B"]}],\n'
    '  "confidence": "high|medium|low"\n'
    "}\n"
    "All five keys are required. Empty arrays are allowed when repository evidence "
    "supports no findings or no implementation steps."
)


def validate_task_report(data, mode, objective):
    if mode not in TASK_REPORT_MODES:
        return False, "invalid task report mode"
    if not isinstance(data, dict):
        return False, "response is not a JSON object"
    summary = data.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        return False, "missing/invalid 'summary'"
    confidence = data.get("confidence")
    if confidence not in TASK_REPORT_CONFIDENCE:
        return False, "missing/invalid 'confidence'"
    raw_findings = data.get("findings")
    raw_plan = data.get("implementationPlan")
    if not isinstance(raw_findings, list) or not isinstance(raw_plan, list):
        return False, "findings and implementationPlan must be arrays"

    findings = []
    for raw in raw_findings[:100]:
        if not isinstance(raw, dict):
            continue
        severity = raw.get("severity")
        if severity not in TASK_REPORT_SEVERITIES:
            severity = "info"
        title = raw.get("title")
        description = raw.get("description")
        category = raw.get("category")
        recommended = raw.get("recommendedFix")
        claim_type = raw.get("claimType")
        if not all(isinstance(v, str) and v.strip() for v in (title, description, category, recommended)):
            continue
        if claim_type not in {"presence", "absence", "behavior", "risk"}:
            claim_type = "risk"
        evidence_ids = [
            value[:200] for value in raw.get("evidenceIds", [])[:50]
            if isinstance(value, str) and value.strip()
        ] if isinstance(raw.get("evidenceIds"), list) else []
        evidence = []
        raw_evidence = raw.get("evidence")
        if isinstance(raw_evidence, list):
            for item in raw_evidence[:20]:
                if not isinstance(item, dict):
                    continue
                path = item.get("path")
                detail = item.get("detail")
                if not isinstance(path, str) or not path.strip() or not isinstance(detail, str) or not detail.strip():
                    continue
                record = {"path": path.strip()[:500], "detail": detail.strip()[:2000]}
                line = item.get("line")
                if isinstance(line, int) and not isinstance(line, bool) and line > 0:
                    record["line"] = line
                evidence.append(record)
        findings.append({
            "severity": severity,
            "category": category.strip()[:200],
            "title": title.strip()[:500],
            "description": description.strip()[:4000],
            "claimType": claim_type,
            "evidenceIds": evidence_ids,
            "evidence": evidence,
            "recommendedFix": recommended.strip()[:4000],
        })

    plan = [step.strip()[:2000] for step in raw_plan[:100] if isinstance(step, str) and step.strip()]
    decision_points = raw.get("decisionPoints") if isinstance(raw.get("decisionPoints"), list) else []
    return True, {
        "schemaVersion": 2,
        "mode": mode,
        "objective": objective,
        "summary": summary.strip()[:8000],
        "findings": findings,
        "implementationPlan": plan,
        "decisionPoints": decision_points[:10],
        "confidence": confidence,
    }


def _fallback_task_report(mode, objective, reason):
    return {
        "schemaVersion": 2,
        "mode": mode,
        "objective": objective,
        "summary": "The read-only report could not be completed.",
        "findings": [],
        "rejectedFindings": [],
        "implementationPlan": [],
        "decisionPoints": [],
        "confidence": "low",
        "coverage": {
            "filesInspected": 0,
            "searchesRun": 0,
            "graphCoverage": None,
            "unsupportedLanguages": [],
            "evidenceRecords": 0,
        },
        "critic": {"status": "unavailable", "independence": "unavailable"},
        "reportFailed": True,
        "reportFailureReason": reason,
    }


def _write_task_report_file(output):
    if not GLIMMER_EVENTS_PATH or not GLIMMER_SESSION_ID:
        print("[glimmer-engineer] no session dir available; task-report.json not written.")
        return None
    path = Path(GLIMMER_EVENTS_PATH).parent / "task-report.json"
    try:
        atomic_write_json(path, output)
        print(f"Wrote: {path}")
        return path
    except OSError as exc:
        print(f"[glimmer-engineer] failed to write task-report.json: {exc}")
        return None


def _run_task_report_critic(candidate):
    """Run a second review only on a loopback provider.

    Repository evidence is sensitive. A configured remote critic is recorded
    as unavailable instead of receiving repository-derived payloads without a
    separate, explicit egress contract.
    """
    if not GLIMMER_EVENTS_PATH:
        return None
    session_dir = Path(GLIMMER_EVENTS_PATH).parent
    primary = _provider_for_role("architect")
    critic = _provider_for_role("critic")
    independence = model_independence(
        {"id": primary.provider_id, "modelId": primary.model_id},
        {"id": critic.provider_id, "modelId": critic.model_id},
    )
    require_independent = bool(
        (MODEL_REGISTRY.get("routing") or {}).get("requireIndependentCritic")
    )
    critic_host = (urlsplit(critic.base_url).hostname or "").lower()
    if critic_host not in {"127.0.0.1", "localhost", "::1"}:
        print("[glimmer-engineer] remote task-report critic disabled: repository evidence stays local")
        return {
            "acceptedFindingIndexes": [],
            "reasons": {},
            "independence": "unavailable",
            "requireIndependent": require_independent,
        }
    try:
        request_payload = build_critic_request(
            candidate,
            session_dir,
            {"providerId": critic.provider_id, "modelId": critic.model_id},
        )
        request_payload.pop("modelIdentity", None)
        request_payload["model"] = critic.model_id
        response = chat_with_retry(request_payload, attempts=2, role="critic")
        content = response["choices"][0]["message"].get("content") or ""
        data = _extract_json_object(content)
        return parse_critic_response(
            data,
            len(candidate.get("findings") or []),
            independence,
            require_independent,
        )
    except Exception as exc:  # critic failure must not erase deterministic validation
        print(f"[glimmer-engineer] task-report critic unavailable: {type(exc).__name__}: {exc}")
        return {
            "acceptedFindingIndexes": [],
            "reasons": {},
            "independence": "unavailable",
            "requireIndependent": require_independent,
        }


def _finalize_task_report(candidate, mode, objective, workspace):
    session_dir = Path(GLIMMER_EVENTS_PATH).parent if GLIMMER_EVENTS_PATH else Path(workspace)
    repo_index = None
    try:
        loaded_index = json.loads((session_dir / "repo-index.json").read_text(encoding="utf-8"))
        if isinstance(loaded_index, dict):
            repo_index = loaded_index
    except (OSError, ValueError):
        pass
    critic = _run_task_report_critic(candidate)
    ok, output = validate_task_report_v2(
        candidate, mode, objective, workspace, session_dir, critic, repo_index,
    )
    if not ok:
        return _fallback_task_report(mode, objective, str(output))
    verified = sum(
        1 for finding in output["findings"]
        if finding.get("verification", {}).get("status") == "verified"
    )
    _emit(
        "claim_validation_completed",
        verified=verified,
        partial=len(output["findings"]) - verified,
        rejected=len(output["rejectedFindings"]),
        confidence=output["confidence"],
    )
    for finding in output["rejectedFindings"]:
        reasons = finding.get("verification", {}).get("reasons") or ["unknown"]
        record_outcome(
            workspace,
            "rejected-claim",
            {
                "claimType": finding.get("claimType"),
                "category": finding.get("category"),
                "reasonCode": reasons[0],
            },
        )
    return output


def _task_report_selfcheck():
    import inspect
    import tempfile

    valid = {
        "summary": "One evidence-backed issue found.",
        "findings": [{
            "severity": "high", "category": "correctness", "title": "Unsafe fallback",
            "description": "The fallback hides a real failure.",
            "claimType": "behavior", "evidenceIds": ["task-report-selfcheck-ev-1"],
            "evidence": [{"path": "src/a.ts", "line": 12, "detail": "catch returns success"}],
            "recommendedFix": "Preserve the failure state.",
        }],
        "implementationPlan": ["Change the fallback", "Add a regression test"],
        "decisionPoints": [],
        "confidence": "high",
    }
    ok, normalized = validate_task_report(valid, "inspect", "Hva kan bli bedre?")
    assert ok
    assert normalized["schemaVersion"] == 2
    assert normalized["mode"] == "inspect"
    assert normalized["objective"] == "Hva kan bli bedre?"
    assert validate_task_report(valid, "implement", "x")[0] is False
    assert _fallback_task_report("review", "x", "failed")["reportFailed"] is True

    tree = ast.parse(inspect.getsource(run_architect))
    calls = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        and node.func.id == "execute_tool"
    ]
    assert len(calls) == 1
    kwargs = {kw.arg: kw.value for kw in calls[0].keywords}
    assert isinstance(kwargs.get("mode"), ast.Constant) and kwargs["mode"].value == "architect"

    global GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID
    old_events, old_session = GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID
    try:
        with tempfile.TemporaryDirectory() as td:
            GLIMMER_EVENTS_PATH = str(Path(td) / "events.jsonl")
            GLIMMER_SESSION_ID = "task-report-selfcheck"
            written = _write_task_report_file(normalized)
            assert written == Path(td) / "task-report.json"
            assert json.loads(written.read_text(encoding="utf-8"))["objective"] == "Hva kan bli bedre?"
    finally:
        GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID = old_events, old_session

    print("read-only task report self-check: PASS")


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
    "restricted to read-only git and allowlisted GitHub CLI inspection. "
    "You cannot install dependencies, run "
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
        atomic_write_json(path, output)
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


def run_architect(task, workspace, max_turns, review_request_path=None, task_mode=None):
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
    report_mode = task_mode in TASK_REPORT_MODES
    if review_mode and report_mode:
        raise RuntimeError("architect review and task-report modes are mutually exclusive")
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
    elif report_mode:
        _emit("agent_state_changed", state="discovery")
    else:
        _emit_architect_started()

    metadata, tools = get_tools()

    # Task 7.4 (V7 "Documentation tools"): "Architect gets read-oriented
    # documentation tools" -- same offer-only-when-graph-exists gate as
    # run_engineer. Must run BEFORE the ARCHITECT_TOOL_NAMES filter below
    # so a newly-appended docs_* definition actually survives it.
    _augment_tools_with_doc_tools(metadata, tools, workspace)

    architect_tools = [
        tool
        for tool in tools
        if (tool.get("function") or {}).get("name") in _architect_tool_names()
    ]

    print("Glimmer Architect Mode (C1/C2, read-only)")
    print(f"Workspace: {workspace}")
    print(f"Tools:     {len(architect_tools)} (read-only)")
    print("Writes:    STRUCTURALLY BLOCKED")
    print(f"Sub-mode:  {task_mode if report_mode else ('review' if review_mode else 'planning')}")
    print()

    system_prompt = (
        TASK_REPORT_SYSTEM_PROMPT if report_mode
        else ARCHITECT_REVIEW_SYSTEM_PROMPT if review_mode
        else ARCHITECT_SYSTEM_PROMPT
    )
    user_content = _build_review_task_message(review_request) if review_mode else task
    if report_mode:
        objective = _extract_task_objective(task)

        def validate_fn(data):
            return validate_task_report(data, task_mode, objective)

        answer_label = "TaskReport"
    else:
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
                response = chat_with_retry(payload, attempts=3, role="architect")
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

    if report_mode:
        if final_result is not None:
            output = _finalize_task_report(
                final_result, task_mode, _extract_task_objective(task), workspace,
            )
            print()
            print("════════════════════════════════════")
            print(f"{task_mode.upper()} TASK REPORT")
            print("════════════════════════════════════")
            print(f"Findings:   {len(output['findings'])}")
            print(f"Confidence: {output['confidence']}")
        else:
            output = _fallback_task_report(
                task_mode, _extract_task_objective(task), failure_reason or "unknown failure",
            )
            print()
            print(f"⚠ Task report failed: {failure_reason or 'unknown failure'}")
            print("Writing fallback task-report.json (reportFailed=true).")
        _write_task_report_file(output)
        return

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
        atomic_write_json(path, output)
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
        response = chat_with_retry(payload, attempts=3, role="consult")
        answer = response["choices"][0]["message"].get("content") or ""
        if not answer.strip():
            answer = "(architect returned an empty answer)"
    except Exception as exc:  # noqa: BLE001 - consult must never crash the engineer loop
        answer = (
            f"Architect consultation failed: {exc}. "
            "Proceed with your own best judgment."
        )

    return answer, len(question_capped)


# ============================================================
# Task 8.2 (V7 §23.15): architect escalation for a delivery-review high/
# critical concern. A tiny standalone `--mode consult` subprocess --
# deliberately NOT the live engineer loop's consult_architect TOOL above
# (that budget counter lives and dies inside a DIFFERENT subprocess's
# memory: the engineering run that already finished by the time
# glimmer-v2.py decides to escalate). Reuses _build_consult_architect_
# payload -- the exact same request shape the live tool sends -- but
# talks to chat_with_retry directly rather than through _run_consult_
# architect, because that function's own fail-open contract swallows a
# model/network failure into an in-band answer string; this caller needs
# a REAL success/failure signal so it can write an honest
# consultationFailed record (V7 §23.15's "model down -> consultation_
# failed, session outcome unchanged") instead of silently reporting a
# failure message as if it were the architect's real answer.
# ============================================================

def _escalation_file_path():
    """Same session-dir-derivation convention as _delivery_review_file_
    path -- the parent of GLIMMER_EVENTS_PATH. Returns None when no
    session dir is available (standalone invocation)."""
    if not GLIMMER_EVENTS_PATH or not GLIMMER_SESSION_ID:
        return None
    return Path(GLIMMER_EVENTS_PATH).parent / "architect-escalation.json"


def _write_escalation_file(output):
    """Write architect-escalation.json (real consultation or a
    consultationFailed marker) to the session dir. Never raises. Returns
    the path written, or None when no session dir is available or the
    write failed."""
    path = _escalation_file_path()
    if path is None:
        print(
            "[glimmer-engineer] no session dir available (standalone "
            "invocation); architect-escalation.json not written."
        )
        return None
    try:
        atomic_write_json(path, output)
        print(f"Wrote: {path}")
        return path
    except OSError as exc:
        print(f"[glimmer-engineer] failed to write architect-escalation.json: {exc}")
        return None


def _load_consult_request(path):
    """Load the escalation request glimmer-v2.py writes ({"architecturePlan":
    plan-or-null, "question": str}) -- same uniform-None-on-any-degraded-
    case contract as _load_review_request: missing file, unreadable, not
    valid JSON, or not an object all degrade to None."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def run_consult_escalation(request_path):
    """V7 §23.15: the ONE toolless model call behind `--mode consult`.
    Never raises: any failure (missing/malformed request, model/network
    error, empty answer) writes a consultationFailed architect-
    escalation.json instead of raising -- glimmer-v2.py's own caller
    (run_architect_escalation) treats this subprocess's exit code as
    advisory only and never depends on it for session outcome.
    """
    request = _load_consult_request(request_path) if request_path else None
    question = str((request or {}).get("question") or "").strip()
    plan = (request or {}).get("architecturePlan")

    if not question:
        _write_escalation_file({
            "consultationFailed": True,
            "reason": "missing/invalid escalation request (no question)",
        })
        return

    payload, question_capped = _build_consult_architect_payload(plan, question)
    try:
        response = chat_with_retry(payload, attempts=3, role="consult")
        answer = response["choices"][0]["message"].get("content") or ""
        if not answer.strip():
            raise ValueError("architect returned an empty answer")
    except Exception as exc:  # noqa: BLE001 - model-down must degrade honestly, never crash
        print(f"[glimmer-engineer] architect escalation failed: {exc}")
        _write_escalation_file({
            "consultationFailed": True,
            "reason": f"{type(exc).__name__}: {exc}",
        })
        return

    print()
    print("════════════════════════════════════")
    print("ARCHITECT ESCALATION")
    print("════════════════════════════════════")
    print(answer[:1800])

    _write_escalation_file({"question": question_capped, "answer": answer})
    _emit("architect_consulted", questionChars=len(question_capped), answerChars=len(answer))


def _consult_escalation_selfcheck() -> None:
    """Task 8.2 (V7 §23.15) — proves run_consult_escalation's success,
    model-down, and empty-answer paths by monkeypatching chat_with_retry
    (same no-live-llama-server style as _model_provider_selfcheck/
    _recovery_ladder_selfcheck), plus that `--mode consult` is
    structurally toolless -- checked against the REAL _build_consult_
    architect_payload output and the REAL main() dispatch source, not a
    hand-written re-implementation of what "read-only" should mean
    (round-7 review lesson: assert against real computation, never a
    parallel model of it). Run with:
    python3 glimmer-engineer.py --consult-escalation-selfcheck
    """
    import inspect
    import tempfile

    global GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID

    real_events_path = GLIMMER_EVENTS_PATH
    real_session_id = GLIMMER_SESSION_ID
    real_chat_with_retry = chat_with_retry

    try:
        with tempfile.TemporaryDirectory() as td:
            session_dir = Path(td)
            GLIMMER_EVENTS_PATH = str(session_dir / "events.jsonl")
            GLIMMER_SESSION_ID = "sess-esc"
            request_path = session_dir / "escalation-request.json"
            escalation_path = session_dir / "architect-escalation.json"

            request_path.write_text(json.dumps({
                "architecturePlan": {"objective": "x", "packages": [], "risk": "low"},
                "question": "Is this architecturally sound?",
            }))

            # ------------------------------------------------------------
            # 1. Success: writes the real {"question", "answer"} pair --
            #    genuine model output, never marked consultationFailed.
            # ------------------------------------------------------------
            def fake_ok(payload, attempts=3, role=None):
                assert role == "consult", "run_consult_escalation must call chat_with_retry with role='consult'"
                return {"choices": [{"message": {"content": "Approved, proceed as-is."}}]}

            globals()["chat_with_retry"] = fake_ok
            run_consult_escalation(request_path)
            written = json.loads(escalation_path.read_text(encoding="utf-8"))
            assert written == {
                "question": "Is this architecturally sound?",
                "answer": "Approved, proceed as-is.",
            }, written
            assert "consultationFailed" not in written, "real model output must never be marked failed"

            # ------------------------------------------------------------
            # 2. Model unreachable: consultationFailed recorded, function
            #    never raises -- the caller (glimmer-v2.py's own
            #    run_architect_escalation) only ever reads the exit code/
            #    file, so session outcome is unaffected either way.
            # ------------------------------------------------------------
            def fake_down(payload, attempts=3, role=None):
                raise ConnectionRefusedError("model server unreachable")

            globals()["chat_with_retry"] = fake_down
            run_consult_escalation(request_path)  # must not raise
            written = json.loads(escalation_path.read_text(encoding="utf-8"))
            assert written.get("consultationFailed") is True
            assert "model server unreachable" in written["reason"]

            # ------------------------------------------------------------
            # 3. Empty/whitespace answer: honestly degraded, never
            #    fabricated as a real consultation.
            # ------------------------------------------------------------
            def fake_blank(payload, attempts=3, role=None):
                return {"choices": [{"message": {"content": "   "}}]}

            globals()["chat_with_retry"] = fake_blank
            run_consult_escalation(request_path)
            written = json.loads(escalation_path.read_text(encoding="utf-8"))
            assert written.get("consultationFailed") is True
            assert "empty answer" in written["reason"]
    finally:
        globals()["chat_with_retry"] = real_chat_with_retry
        GLIMMER_EVENTS_PATH = real_events_path
        GLIMMER_SESSION_ID = real_session_id

    # ------------------------------------------------------------
    # 4. Structurally toolless: the REAL request-builder never offers
    #    tools (same discipline _delivery_review_selfcheck already
    #    proves for _build_delivery_review_payload), and the REAL
    #    main() dispatch for --mode consult never reaches get_tools/
    #    execute_tool/run_engineer/run_architect -- read-only by
    #    construction, not by a re-implemented allow-list.
    # ------------------------------------------------------------
    payload, _ = _build_consult_architect_payload(
        {"objective": "x", "packages": [], "risk": "low"}, "q"
    )
    assert "tools" not in payload
    assert "functions" not in payload
    assert "tool_choice" not in payload
    assert "parallel_tool_calls" not in payload

    consult_body = inspect.getsource(run_consult_escalation)
    for forbidden in ("get_tools(", "execute_tool(", "WRITE_TOOLS", "run_engineer(", "run_architect("):
        assert forbidden not in consult_body, (
            f"run_consult_escalation must never reference {forbidden!r} -- it has no tool loop at all"
        )

    main_source = inspect.getsource(main)
    consult_dispatch_start = main_source.index('if args.mode == "consult":')
    consult_dispatch_end = main_source.index('elif args.mode == "architect":', consult_dispatch_start)
    consult_dispatch = main_source[consult_dispatch_start:consult_dispatch_end]
    assert "run_consult_escalation(args.consult_request)" in consult_dispatch
    for forbidden in ("get_tools(", "execute_tool(", "run_engineer(", "run_architect("):
        assert forbidden not in consult_dispatch, f"--mode consult's dispatch must never reach {forbidden!r}"

    print("consult escalation (Task 8.2, V7 §23.15) self-check: PASS")


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
      1b. Task 9.3d: find_symbol on .py targets uses real `ast` parsing --
          finds a method nested inside a class, does not false-positive on
          a comment merely mentioning the name, and falls back to the same
          regex scan on a syntactically-broken .py file.
      2. find_references is word-boundary correct (name "foo" does not
         match a line whose only occurrence is "foobar").
      2b. Task 9.3d: find_references on .py targets uses real `ast` too --
          finds a real attribute-access usage, excludes the definition's
          own name, ignores a comment mention, and falls back to regex on
          a syntactically-broken file.
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
            "    # not a real definition: def get_name would be a false regex hit here\n"
            "    def get_name(self):\n"
            "        return self.name\n"
            "\n"
            "def make_user():\n"
            "    return UserModel().get_name()\n"
        )
        # Task 9.3d: syntactically invalid Python -- ast.parse must raise
        # SyntaxError on this, so find_symbol/find_references fall back to
        # the same lexical regex scan TS/JS always uses, for this file only.
        (ws / "src" / "broken.py").write_text(
            "def get_name(:\n"
            "    return None\n"
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

        # ------------------------------------------------------------
        # 1b. Task 9.3d: Python find_symbol uses real `ast`, not a
        #     per-line regex scan, for .py files that parse successfully.
        # ------------------------------------------------------------
        method_result = find_symbol("get_name", "function", ws)
        # Real definition (a method nested inside a class) IS found, at
        # its real line (3) -- proves NodeVisitor walks into class bodies.
        assert "src/models.py:3:" in method_result, method_result
        # The comment on line 2 merely CONTAINS the text "def get_name" --
        # a per-line regex would have matched it; real AST parsing never
        # turns a comment into a node, so it must not appear here.
        assert "src/models.py:2:" not in method_result, (
            "a comment merely mentioning 'def get_name' as text must not "
            f"be reported as a definition: {method_result!r}"
        )
        # broken.py can't be ast.parse'd (SyntaxError) -- must still be
        # found via the same regex fallback TS/JS always uses, not
        # silently dropped.
        assert "src/broken.py:1:" in method_result, (
            f"a syntactically-broken .py file must fall back to the regex "
            f"scan, not be silently skipped: {method_result!r}"
        )

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
        # 2b. Task 9.3d: Python find_references uses real `ast` for .py
        #     files that parse -- finds the real attribute-access usage in
        #     make_user, excludes the def statement's own name, and never
        #     false-positives on the comment merely mentioning the name.
        # ------------------------------------------------------------
        py_refs = find_references("get_name", ws)
        assert "src/models.py" in py_refs, py_refs
        assert "return UserModel().get_name()" in py_refs, py_refs
        assert "not a real definition" not in py_refs, (
            "a comment merely mentioning the name as text must not count "
            f"as a real reference: {py_refs!r}"
        )
        assert "def get_name(self):" not in py_refs, (
            "the def statement's own name is not an ast.Name/Attribute "
            f"node and must not be reported as a reference: {py_refs!r}"
        )
        # broken.py still contributes via the same regex fallback as
        # find_symbol above.
        assert "src/broken.py" in py_refs, py_refs

        # M3: the per-file annotation must say what that file actually
        # got -- ast for a parsed .py file, lexical for the regex-fallback
        # broken.py in the SAME result.
        assert "src/models.py (ast match; definition lines excluded):" in py_refs, py_refs
        assert "src/broken.py (word-boundary lexical match" in py_refs, py_refs

        # ------------------------------------------------------------
        # 2c. Round 9 review (M4): the AST reference visitor also collects
        #     imports (ast.alias), function parameters (ast.arg), and
        #     global/nonlocal declarations -- four real reference sites
        #     the regex path found and the AST path used to silently drop.
        # ------------------------------------------------------------
        (ws / "src" / "imports_and_params.py").write_text(
            "from mod import target\n"          # 1: ast.alias (import name)
            "import target as t\n"               # 2: ast.alias (import name, aliased)
            "\n"
            "def f(target=1):\n"                 # 4: ast.arg (parameter name)
            "    global target\n"                 # 5: ast.Global
            "    return call(target=target)\n"    # 6: ast.Name (the value only)
        )
        target_refs = find_references("target", ws)
        assert "src/imports_and_params.py (ast match" in target_refs, target_refs
        assert "1: from mod import target" in target_refs, (
            f"import name site missed: {target_refs!r}"
        )
        assert "2: import target as t" in target_refs, (
            f"aliased import name site missed: {target_refs!r}"
        )
        assert "4: def f(target=1):" in target_refs, (
            f"parameter name site missed: {target_refs!r}"
        )
        assert "5: global target" in target_refs, (
            f"global declaration site missed: {target_refs!r}"
        )
        assert "6: return call(target=target)" in target_refs, (
            f"the value half of the keyword arg (a real ast.Name) missed: {target_refs!r}"
        )

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
        # NEW-1 (round-9 re-review): traversal is now a ToolPolicyBlock,
        # so execute_tool returns a POLICY_BLOCK envelope (with audit
        # trail) instead of raising -- assert the blocked result shape.
        result, changed = execute_tool(
            "find_related_tests",
            {"path": "../../../etc/passwd"},
            ws,
            {"approve_all": True},
            {},
            [],
        )
        assert changed is False
        assert "escapes repository" in result, result
        assert "ENGINEERING SECURITY BLOCK" in result, result

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
    global _loaded_architecture_plan, _architect_consult_enabled, _contract_scope_prefixes
    global _DURABLE_JOURNAL, _DURABLE_MODEL_TURN
    _loaded_architecture_plan = _load_architecture_plan_for_engineer()
    architecture_plan = _loaded_architecture_plan
    _architect_consult_enabled = architect_consult_enabled

    # V7 §15 follow-up: load once per session, same convention as the
    # architecture plan just above -- GLIMMER_CONTRACT_SCOPE doesn't
    # change mid-session either.
    _contract_scope_prefixes = _load_contract_scope_prefixes()

    _augment_tools_with_consult_architect(
        metadata, tools, architecture_plan, architect_consult_enabled,
    )

    # Task 7.4 (V7 "Documentation tools"): docs_search/docs_get_node/
    # docs_impact -- offered only when a real docs/graph.json exists.
    _augment_tools_with_doc_tools(metadata, tools, workspace)

    # R5 (glimmer-v7): load once per session, not per shell_policy call —
    # repo-map.json doesn't change mid-session.
    validation_allowlist = (
        load_validation_script_allowlist()
    )

    # Round 7 live checkpoint (L2): docs/graph.json (only that exact
    # path, see DOC_GRAPH_RELATIVE_PATH) is excluded from this repo's own
    # clean-tree gate via a git pathspec -- it is orchestrator-owned
    # bookkeeping glimmer-v2.py's doc pass may have legitimately left
    # modified/uncommitted (Glimmer never commits on the model's behalf),
    # so a fresh write session must not deadlock against a prior
    # session's own doc-graph rewrite. Every other dirty path still
    # blocks, exactly as before.
    baseline_status = git_local(
        workspace,
        "status",
        "--short",
        "--",
        ".",
        f":(exclude){DOC_GRAPH_RELATIVE_PATH}",
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

    recovery_baseline = git_local(workspace, "rev-parse", "HEAD")

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

        "Never attempt git commit, git push, git reset, "
        "git clean, git checkout, git switch, git stash, "
        "git merge, git rebase, production commands, "
        "releases or deployment -- these are always blocked. "

        "GitHub CLI is available only for allowlisted read-only inspection "
        "of the current repository (auth status and repo/PR/issue/run/"
        "workflow/release list or view operations). Never attempt gh api, "
        "authentication changes, token access, repository overrides, PR/"
        "issue creation or edits, comments, merges, workflow triggers, or "
        "release changes -- these are always blocked. "

        "Dependency installation (npm install/i/ci/add) and "
        "npm run migration/seed scripts are different: they "
        "are not flat-blocked. When the task genuinely "
        "requires one, attempt it as a normal command -- it "
        "will pause for a human approval decision (V7 §35) "
        "instead of running immediately, so wait for that "
        "decision. This only applies to a single, plain npm "
        "command (no chaining, pipes, redirects or "
        "substitution) -- a composed command, or any other "
        "migration tool (alembic, prisma, django manage.py, "
        "etc), is still blocked outright. No one may be "
        "watching this session: an unanswered request times "
        "out after a few minutes, and a session only gets a "
        "handful of these pauses before further ones are "
        "blocked immediately too -- either way, treat a "
        "denied, timed-out, or blocked result like any other "
        "policy block and continue honestly without the "
        "action, noting it as a remaining risk. "

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

    # The event path is the existing, trusted session-directory handoff from
    # glimmer-v2.py. Standalone runs remain unchanged; gateway/v2 sessions get
    # an immediate durable Tier-0 checkpoint before the first model request.
    if GLIMMER_EVENTS_PATH and GLIMMER_SESSION_ID:
        _DURABLE_JOURNAL = DurableJournal(
            Path(GLIMMER_EVENTS_PATH).parent,
            GLIMMER_SESSION_ID,
            process_name="engineer",
        )
        atexit.register(_DURABLE_JOURNAL.close)
        _DURABLE_JOURNAL.checkpoint_conversation(messages, -1, "initialized")

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

        _DURABLE_MODEL_TURN = turn

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

                if _DURABLE_JOURNAL is not None:
                    _DURABLE_JOURNAL.checkpoint_conversation(
                        messages, turn, "verification_gate"
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

            if _DURABLE_JOURNAL is not None:
                _DURABLE_JOURNAL.checkpoint_conversation(
                    messages + [{"role": "assistant", "content": content}],
                    turn,
                    "final_response",
                )

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

            if _DURABLE_JOURNAL is not None:
                _DURABLE_JOURNAL.close("completed")

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

        if _DURABLE_JOURNAL is not None:
            _DURABLE_JOURNAL.checkpoint_conversation(
                messages, turn, "assistant_tool_calls"
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

            changed = False
            arguments = function.get("arguments") or {}
            try:
                journal_arguments = parse_arguments(arguments)
            except Exception:  # malformed arguments are still a durable intent fact
                journal_arguments = arguments
            if _DURABLE_JOURNAL is not None:
                _DURABLE_JOURNAL.begin_tool(
                    call["id"], turn, tool_name, journal_arguments
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

            snapshot = None
            if _DURABLE_JOURNAL is not None and changed:
                try:
                    snapshot = _DURABLE_JOURNAL.snapshot_worktree(
                        workspace, recovery_baseline, turn, call["id"]
                    )
                except Exception as exc:  # journal failure is visible, never hidden
                    _DURABLE_JOURNAL.append(
                        "worktree_snapshot_failed",
                        {"error": str(exc)[:2000]},
                        turn=turn,
                        call_id=call["id"],
                    )
                    print(f"[glimmer-engineer] recovery snapshot failed: {exc}", flush=True)

            if _DURABLE_JOURNAL is not None:
                _DURABLE_JOURNAL.complete_tool(
                    call["id"],
                    turn,
                    tool_name,
                    result,
                    changed=changed,
                    snapshot=snapshot,
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

            if _DURABLE_JOURNAL is not None:
                _DURABLE_JOURNAL.checkpoint_conversation(
                    messages, turn, "tool_result"
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

        if _DURABLE_JOURNAL is not None:
            _DURABLE_JOURNAL.checkpoint_conversation(
                messages, turn, "turn_complete"
            )

    raise RuntimeError(
        "Engineering agent reached "
        f"max turns ({max_turns})."
    )


def _doc_tools_selfcheck() -> None:
    """Task 7.4 (V7 "Documentation tools"). Covers: availability gating
    (_augment_tools_with_doc_tools offers the three docs_* tools only when
    docs/graph.json exists), docs_search/docs_get_node/docs_impact results
    against a real fixture graph + ADRs on disk, the DOC_TOOLS_SEARCH_CAP
    cap, the structural "not offered" fallback (_execute_doc_tool never
    crashes when called with no graph loaded), and that a node id is never
    used as a filesystem path (no containment surface to exploit -- it's
    a plain dict-key lookup into the already-parsed, workspace-relative
    graph).
    Run with: python3 glimmer-engineer.py --doc-tools-selfcheck
    """
    import tempfile

    global _loaded_doc_graph
    saved_graph = _loaded_doc_graph

    try:
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)

            # ------------------------------------------------------------
            # 1. Availability gating: absent docs/graph.json -> tools never
            #    offered, _loaded_doc_graph stays None.
            # ------------------------------------------------------------
            metadata, tools = {}, []
            _augment_tools_with_doc_tools(metadata, tools, ws)
            assert _loaded_doc_graph is None
            assert not DOC_TOOL_NAMES & set(metadata), "no graph -> no doc tools offered"
            assert tools == []

            # Malformed graph.json (not valid JSON) must degrade to
            # None + a warning, never raise -- same tolerance as
            # glimmer-v2.py's load_doc_graph.
            (ws / "docs").mkdir()
            (ws / "docs" / "graph.json").write_text("not json{{{", encoding="utf-8")
            metadata2, tools2 = {}, []
            _augment_tools_with_doc_tools(metadata2, tools2, ws)
            assert _loaded_doc_graph is None
            assert tools2 == []

            # ------------------------------------------------------------
            # 2. A real graph -> all three tools offered, with the fixed
            #    definition shape get_tools() expects.
            # ------------------------------------------------------------
            graph = {
                "schemaVersion": 1,
                "nodes": [
                    {"id": "svc:auth", "type": "service", "path": "backend/auth",
                     "title": "Auth service", "status": "CURRENT"},
                    {"id": "doc:auth-flow", "type": "doc", "path": "docs/auth-flow.md",
                     "title": "Auth flow", "status": "CURRENT"},
                    {"id": "doc:evidence-linked", "type": "doc", "path": "docs/evidence-linked.md",
                     "title": "Evidence-linked doc", "status": "CURRENT",
                     "provenance": {"evidence": ["src/unrelated_evidence.ts"]}},
                ],
                "edges": [
                    {"from": "doc:auth-flow", "to": "svc:auth", "kind": "documents"},
                ],
            }
            (ws / "docs" / "graph.json").write_text(json.dumps(graph), encoding="utf-8")

            decisions = ws / "docs" / "decisions"
            decisions.mkdir()
            (decisions / "ADR-0001.md").write_text(
                "---\nid: ADR-0001\nstatus: accepted\nareas: [auth]\n"
                "title: Backend owns auth session state\n---\nBody.\n",
                encoding="utf-8",
            )

            metadata3, tools3 = {}, []
            _augment_tools_with_doc_tools(metadata3, tools3, ws)
            assert DOC_TOOL_NAMES <= set(metadata3), "a real graph must offer all three doc tools"
            assert len(tools3) == 3
            assert _loaded_doc_graph is not None

            # ------------------------------------------------------------
            # 3. docs_search: exact-token match over node fields AND ADR
            #    id/title; capped; empty query handled; no match handled.
            # ------------------------------------------------------------
            search_result = _docs_search("auth", _loaded_doc_graph, ws)
            assert "svc:auth" in search_result
            assert "ADR-0001" in search_result, "docs_search must also match ADR titles"

            assert _docs_search("", _loaded_doc_graph, ws) == "docs_search: empty query."
            assert "no matches" in _docs_search("zzznope", _loaded_doc_graph, ws)

            # Cap: DOC_TOOLS_SEARCH_CAP results max even when more match.
            big_graph = {
                "nodes": [
                    {"id": f"svc:widget{i}", "type": "service", "path": f"p{i}",
                     "title": "widget"}
                    for i in range(DOC_TOOLS_SEARCH_CAP + 10)
                ],
                "edges": [],
            }
            capped = _docs_search("widget", big_graph, ws)
            assert len(capped.splitlines()) == DOC_TOOLS_SEARCH_CAP

            # ------------------------------------------------------------
            # 4. docs_get_node: node + edges (one hop); missing id handled;
            #    id is a plain dict-key lookup -- never touches the
            #    filesystem, so a path-traversal-shaped id is inert.
            # ------------------------------------------------------------
            node_result = json.loads(_docs_get_node("svc:auth", _loaded_doc_graph))
            assert node_result["node"]["id"] == "svc:auth"
            assert len(node_result["edges"]) == 1
            assert node_result["edges"][0]["from"] == "doc:auth-flow"

            assert "no node with id" in _docs_get_node("does-not-exist", _loaded_doc_graph)
            assert "no node with id" in _docs_get_node("../../etc/passwd", _loaded_doc_graph), (
                "a path-traversal-shaped id must be treated as an ordinary "
                "(nonexistent) lookup key, never a filesystem path"
            )

            # ------------------------------------------------------------
            # 5. docs_impact: changed backend/auth/* file -> svc:auth
            #    touched -> doc:auth-flow impacted via the "documents" edge.
            # ------------------------------------------------------------
            impact_result = _docs_impact(["backend/auth/session.ts"], _loaded_doc_graph)
            assert "doc:auth-flow" in impact_result

            assert _docs_impact([], _loaded_doc_graph) == "docs_impact: no impacted documentation nodes."
            assert _docs_impact(["totally/unrelated.ts"], _loaded_doc_graph) == (
                "docs_impact: no impacted documentation nodes."
            )

            # Round 7 live checkpoint (L3), mirrored from glimmer-v2.py: a
            # changed file matching a doc node's own provenance.evidence
            # must be treated as impacted, even with no path-prefix or
            # category relationship to that node at all.
            evidence_impact = _docs_impact(["src/unrelated_evidence.ts"], _loaded_doc_graph)
            assert "doc:evidence-linked" in evidence_impact, (
                "changed file matching provenance.evidence must impact its doc node (L3)"
            )

            # ------------------------------------------------------------
            # 6. _execute_doc_tool: structural "not offered" fallback --
            #    calling a doc tool with no graph loaded must degrade to an
            #    honest text answer, never raise.
            # ------------------------------------------------------------
            _loaded_doc_graph = None
            envelope = _execute_doc_tool("docs_search", {"query": "auth"}, ws)
            assert "unavailable" in envelope["plain_text_response"]

            # ------------------------------------------------------------
            # 7. Containment: DOC_GRAPH_RELATIVE_PATH is a fixed, workspace-
            #    relative literal -- no argument ever controls which file
            #    gets read.
            # ------------------------------------------------------------
            assert DOC_GRAPH_RELATIVE_PATH == "docs/graph.json"
            assert not DOC_GRAPH_RELATIVE_PATH.startswith("/")

            # ------------------------------------------------------------
            # 8. ARCHITECT_TOOL_NAMES includes the doc tools too (Architect
            #    gets read-oriented documentation tools, same as engineer).
            # ------------------------------------------------------------
            assert DOC_TOOL_NAMES <= ARCHITECT_TOOL_NAMES

            # ------------------------------------------------------------
            # 9. Round 7 live checkpoint (L2): run_engineer's own clean-
            #    working-tree gate uses the exact same git pathspec-exclude
            #    call as glimmer-v2.py's clean_start_dirty -- a solely-
            #    dirty docs/graph.json must not trip it, a genuinely dirty
            #    OTHER path still must. Exercised directly against the
            #    real git command (not run_engineer() itself, which needs
            #    a live model) so a regression here is still caught.
            # ------------------------------------------------------------
            git_local(ws, "init", "-q")
            git_local(ws, "add", "-A")
            git_local(ws, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "init")
            (ws / "docs" / "graph.json").write_text('{"nodes": [], "edges": [], "changed": true}')
            clean_tree_status = git_local(
                ws, "status", "--short", "--", ".", f":(exclude){DOC_GRAPH_RELATIVE_PATH}",
            )
            assert clean_tree_status == "", (
                "a solely-dirty docs/graph.json must not trip run_engineer's clean-tree gate"
            )
            (ws / "extra.ts").write_text("export const y = 2;")
            dirty_status = git_local(
                ws, "status", "--short", "--", ".", f":(exclude){DOC_GRAPH_RELATIVE_PATH}",
            )
            assert "extra.ts" in dirty_status, "a genuinely dirty OTHER path must still trip the gate"

            # ------------------------------------------------------------
            # CR1 (round-7 re-review 2): the MODEL must never be able to
            # write docs/graph.json -- changed_files() excludes that path
            # from attribution/scope/budget on the assumption that only
            # run_doc_pass writes it, so a model write there would be
            # invisible to every downstream guard. check_write_path is
            # the enforcement point; assert both tools are blocked, and
            # that only the exact repo-root path is protected.
            # ------------------------------------------------------------
            for blocked in (ws / "docs" / "graph.json",):
                try:
                    check_write_path(blocked, ws)
                    raise AssertionError("model write to docs/graph.json must be blocked")
                except PermissionError:
                    pass
            for allowed in (ws / "docs" / "other.md", ws / "nested" / "docs" / "graph.json"):
                check_write_path(allowed, ws)  # must NOT raise
    finally:
        _loaded_doc_graph = saved_graph

    print("documentation tools (V7 §7.4) self-check: PASS")


def _approval_wait_selfcheck() -> None:
    """Task 8.3 (V7 §14/§35) self-check, extended by the 8.3 review
    fix-round to reproduce every finding verbatim: classify_yellow now
    delegates to shell_policy (C1/C2/M1), the migration arm re-excludes
    deploy/publish/release/production/:prod/:live and requires a
    resolvable script body (C3), request_approval_and_wait never raises
    (M2) and binds each approval to the exact tool+command it was
    requested for (defense in depth). Never sleeps anywhere near the real
    300s default -- every timeout_s/poll_interval_s below is a tiny
    override passed explicitly, and the "resolved while waiting" cases
    use a short-lived background thread standing in for a human clicking
    Approve/Deny in the Control Center.
    Run with: python3 glimmer-engineer.py --approval-wait-selfcheck
    """
    import ast
    import inspect
    import tempfile
    import threading

    global GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID
    global _approved_action_memo, _approval_request_count
    real_events_path, real_session_id = GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID
    real_memo, real_count = _approved_action_memo, _approval_request_count
    _approved_action_memo, _approval_request_count = {}, 0

    try:
        with tempfile.TemporaryDirectory() as wd:
            ws = Path(wd)
            (ws / "package.json").write_text(json.dumps({
                "scripts": {
                    "migrate": "node scripts/migrate.js",
                    "migrate:prod": "node scripts/migrate.js --env=prod",
                    "deploy:migrate": "node scripts/deploy-and-migrate.js",
                    "seed:production": "node scripts/seed.js --env=production",
                    "migrate:unresolvable": None,  # present but not a string body
                },
            }))

            # 1. RED stays RED -- every 8.3-review reproduction command
            #    returns None (never YELLOW-eligible), because the REAL
            #    shell_policy verdict (composition, position-exact
            #    subcommand, dangerous_fragments) is what decides, not a
            #    hand-rolled scan.
            for red_command in (
                "git push",
                "git commit -m x",
                "npm install x; git push origin main",   # C1: composition
                "npm run deploy add",                     # C2: run/deploy, not install-shaped
                "npm publish --tag add",                  # C2
                "npm exec -- some-pkg add",                # C2
                "npm uninstall react add",                # C2
                "npm update add",
                "npm --prefix /tmp/elsewhere install",    # M1: not install-shaped at tokens[1]
                "npm run migrate:prod",                   # C3: migrate + :prod excluded
                "npm run deploy:migrate",                 # C3: migrate + deploy excluded
                "npm run seed:production",                 # C3: seed + production excluded
                "npm run migrate:unresolvable",            # C3: migration keyword, but body isn't a string
                # NC1 (re-review Critical): the migration arm had NO
                # structural precondition of its own at all -- a composed
                # command classified as YELLOW and dispatched verbatim.
                # Now caught by classify_yellow's single shared entry-
                # point guard, before either arm even runs.
                "npm run migrate ; git push origin main",
                "npm run migrate && git push origin main",
                "npm run migrate > /tmp/out",
                "npm run migrate $(whoami)",
                "npm run migrate `whoami`",
                # NM1 (re-review Major): the exclusion scan only looked at
                # tokens[2] (the bare script name) -- a trailing arg
                # carrying an excluded fragment must still exclude.
                "npm run migrate --env=production --force",
            ):
                assert classify_yellow(red_command, ws) is None, red_command

            # 1b. C3's "script body must be resolvable" requirement,
            #     isolated from the exclusion-set check: a migration-
            #     keyword script whose package.json doesn't even exist/
            #     parse must never be YELLOW-eligible either.
            with tempfile.TemporaryDirectory() as empty_wd:
                assert classify_yellow("npm run migrate", Path(empty_wd)) is None

            # 2. GREEN unaffected.
            assert classify_yellow("npm run typecheck", ws) is None
            assert classify_yellow("git status", ws) is None

            # 3. YELLOW: plain dependency install, and migration WITH the
            #    FULL literal command and its resolved script body
            #    surfaced (re-review disclosure fix) -- not just a bare
            #    script name.
            yellow = classify_yellow("npm install left-pad", ws)
            assert yellow is not None and yellow["action"] == "modify_dependencies"
            # M4 (followup-1-2 review): install runs arbitrary lifecycle
            # scripts -- risk must be "high" (matching the migration arm
            # below), and the card must say so explicitly.
            assert yellow["risk"] == "high", yellow
            assert "lifecycle script" in yellow["reason"], yellow
            migration = classify_yellow("npm run migrate", ws)
            assert migration is not None and migration["action"] == "run_migration"
            assert migration["proposedChanges"] == ["npm run migrate", "node scripts/migrate.js"]
            assert "npm run migrate" in migration["reason"]
            assert "node scripts/migrate.js" in migration["reason"]

            # 3b. Structural check (house AST pattern, e.g. C2's
            #     run_architect execute_tool-call-site assertion): the
            #     shared structural guard must run BEFORE either arm's
            #     subcommand-specific logic in classify_yellow's own
            #     source, so a future third arm can't be added ahead of
            #     it by accident.
            body = ast.parse(inspect.getsource(classify_yellow)).body[0].body
            guard_idx = next(
                (i for i, stmt in enumerate(body) if "_structural_shell_guard" in ast.dump(stmt)), None,
            )
            first_arm_idx = next(
                (i for i, stmt in enumerate(body)
                 if "subcommand" in ast.dump(stmt) and "YELLOW_DEPENDENCY_INSTALL_SUBCOMMANDS" in ast.dump(stmt)),
                None,
            )
            assert guard_idx is not None, "classify_yellow must call _structural_shell_guard"
            assert first_arm_idx is not None, "classify_yellow must still dispatch the install arm"
            assert guard_idx < first_arm_idx, (
                "the structural guard must run before ANY arm-specific classification"
            )

            # 4. M1 fix, verified against the real shell_policy call (not
            #    just classify_yellow's own gate): a workspace-contained
            #    --prefix DOESN'T qualify either, because --prefix never
            #    puts "install" at tokens[1].
            assert classify_yellow(f"npm --prefix {ws} install left-pad", ws) is None

        with tempfile.TemporaryDirectory() as td:
            session_dir = Path(td)
            (session_dir / "events.jsonl").write_text("")
            GLIMMER_EVENTS_PATH = str(session_dir / "events.jsonl")
            GLIMMER_SESSION_ID = "sess-approval-selfcheck"

            # 5. No manifest.json at all (standalone invocation, no v2
            #    parent) -- the manifest patch must degrade silently.
            _patch_manifest_approval_state(
                session_dir, "appr-x",
                {"action": "a", "reason": "r", "proposedChanges": [], "risk": "low"},
            )
            _patch_manifest_approval_state(session_dir, "appr-x", None)

            manifest_path = session_dir / "manifest.json"
            manifest_path.write_text(json.dumps({"status": "initialized", "state": "preflight"}))

            # 6. Denied path: a background "human" writes status="denied"
            #    shortly after the request lands in approvals.json.
            def _deny_soon():
                time.sleep(0.03)
                approvals = load_approvals(session_dir)
                [approval_id] = approvals.keys()
                approvals[approval_id]["status"] = "denied"
                approvals[approval_id]["approvedBy"] = "test-human"
                _atomic_write_json(_approvals_path(session_dir), approvals)

            threading.Thread(target=_deny_soon, daemon=True).start()
            decision, detail = request_approval_and_wait(
                "modify_dependencies", "install left-pad", ["package.json"], "medium",
                tool_name="exec_shell_command", command="npm install left-pad",
                timeout_s=2, poll_interval_s=0.01,
            )
            assert decision == "denied", decision
            assert detail == "test-human", detail
            # manifest restored to its pre-approval status/state, pendingApproval cleared.
            after = json.loads(manifest_path.read_text())
            assert after["status"] == "initialized" and after["state"] == "preflight"
            assert "pendingApproval" not in after
            assert "_preApprovalStatus" not in after and "_preApprovalState" not in after

            # 7. Approved path.
            def _approve_soon():
                time.sleep(0.03)
                approvals = load_approvals(session_dir)
                [approval_id] = [k for k, v in approvals.items() if v.get("status") == "pending"]
                approvals[approval_id]["status"] = "approved"
                approvals[approval_id]["approvedBy"] = "daniel"
                _atomic_write_json(_approvals_path(session_dir), approvals)

            threading.Thread(target=_approve_soon, daemon=True).start()
            decision, detail = request_approval_and_wait(
                "run_migration", "npm run migrate -> node scripts/migrate.js", [], "high",
                tool_name="exec_shell_command", command="npm run migrate",
                timeout_s=2, poll_interval_s=0.01,
            )
            assert decision == "approved" and detail == "daniel"

            # 7b. M1 (followup-1-2 review): the approval is recorded as a
            #     durable, manifest-visible waiver -- not only in the
            #     approvals.json sidecar.
            approved_actions = json.loads(manifest_path.read_text())["approvedActions"]
            assert len(approved_actions) == 1, approved_actions
            waiver = approved_actions[0]
            assert waiver["action"] == "run_migration", waiver
            assert waiver["tool"] == "exec_shell_command", waiver
            assert waiver["command"] == "npm run migrate", waiver
            assert waiver["approvedBy"] == "daniel", waiver

            # 7c. M2 (followup-1-2 review): the IDENTICAL request again --
            #     resolves instantly from the memo (no background thread
            #     to resolve it, no wait) and does not consume the cap or
            #     write a second approvedActions entry.
            count_before_memo_hit = _approval_request_count
            decision, detail = request_approval_and_wait(
                "run_migration", "npm run migrate -> node scripts/migrate.js", [], "high",
                tool_name="exec_shell_command", command="npm run migrate",
                timeout_s=2, poll_interval_s=0.01,
            )
            assert decision == "approved" and detail == "daniel"
            assert _approval_request_count == count_before_memo_hit, "a memo hit must not consume a new request"
            assert len(json.loads(manifest_path.read_text())["approvedActions"]) == 1, (
                "a memo hit must not add a second waiver entry"
            )

            # 8. Exact-action binding mismatch: the record resolves
            #    "approved", but for a DIFFERENT command than this call
            #    requested (approvals.json tampered, or reused) -- must
            #    fail closed to "denied", never execute the original
            #    command on the strength of an approval for something
            #    else.
            def _approve_wrong_command_soon():
                time.sleep(0.03)
                approvals = load_approvals(session_dir)
                [approval_id] = [k for k, v in approvals.items() if v.get("status") == "pending"]
                approvals[approval_id]["status"] = "approved"
                approvals[approval_id]["approvedBy"] = "daniel"
                approvals[approval_id]["boundCommand"] = "npm install totally-different-package"
                approvals[approval_id]["boundArgsHash"] = "tampered"
                _atomic_write_json(_approvals_path(session_dir), approvals)

            threading.Thread(target=_approve_wrong_command_soon, daemon=True).start()
            decision, detail = request_approval_and_wait(
                "modify_dependencies", "install left-pad", ["package.json"], "medium",
                tool_name="exec_shell_command", command="npm install left-pad",
                timeout_s=2, poll_interval_s=0.01,
            )
            assert decision == "denied", decision
            assert "exact action" in detail, detail

            # 9. Timeout path: nobody ever resolves it -> fail closed.
            decision, detail = request_approval_and_wait(
                "modify_dependencies", "npm install x", [], "medium",
                tool_name="exec_shell_command", command="npm install x",
                timeout_s=0.05, poll_interval_s=0.01,
            )
            assert decision == "timeout", decision

            # 10. Sidecar tolerant of malformed JSON.
            (session_dir / "approvals.json").write_text("not json{{{")
            assert load_approvals(session_dir) == {}
            (session_dir / "approvals.json").write_text(json.dumps(["not", "an", "object"]))
            assert load_approvals(session_dir) == {}

            # 11. M2: an unwritable session dir must not raise out of
            #     request_approval_and_wait -- fails closed as
            #     "unavailable", exactly like the no-session-dir case.
            real_write = _write_approval_request

            def _raising_write(*args, **kwargs):
                raise OSError("simulated: session dir removed/unwritable")

            globals()["_write_approval_request"] = _raising_write
            try:
                decision, detail = request_approval_and_wait(
                    "modify_dependencies", "install x", [], "medium",
                    tool_name="exec_shell_command", command="npm install x",
                    timeout_s=1, poll_interval_s=0.01,
                )
            finally:
                globals()["_write_approval_request"] = real_write
            assert decision == "unavailable", decision

            # 11b. M2 (followup-1-2 review): once the session hits the
            #      request cap, a brand-new command (never seen before, so
            #      no memo hit) is denied immediately -- no wait, no new
            #      approvals.json entry.
            _approval_request_count = MAX_APPROVAL_REQUESTS_PER_SESSION
            approvals_before_cap = load_approvals(session_dir)
            started = time.monotonic()
            decision, detail = request_approval_and_wait(
                "modify_dependencies", "install something-else", [], "medium",
                tool_name="exec_shell_command", command="npm install something-else",
                timeout_s=2, poll_interval_s=0.01,
            )
            assert decision == "capped", decision
            assert time.monotonic() - started < 1, "a capped request must never wait"
            assert load_approvals(session_dir) == approvals_before_cap

            # 12. No session directory at all -> "unavailable", fails
            #     closed immediately (no wait, no allow-by-default).
            GLIMMER_EVENTS_PATH = None
            decision, detail = request_approval_and_wait(
                "x", "y", [], "low", tool_name="exec_shell_command", command="x",
                timeout_s=1, poll_interval_s=0.01,
            )
            assert decision == "unavailable", decision
    finally:
        GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID = real_events_path, real_session_id
        _approved_action_memo, _approval_request_count = real_memo, real_count

    print("approval wait loop (V7 §14/§35) self-check: PASS (12/12)")


def _scope_expansion_selfcheck() -> None:
    """V7 §15 follow-up ("large expansion -> pause for approval") self-
    check. Same tiny-timeout/no-real-sleep discipline as
    _approval_wait_selfcheck: every approval round-trip below resolves in
    milliseconds via check_write_path's test-only approval_timeout_s/
    approval_poll_interval_s overrides, never the real 300s/2s production
    defaults.

    Run with: python3 glimmer-engineer.py --scope-approval-selfcheck
    """
    import tempfile
    import threading

    global GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID, _contract_scope_prefixes
    global _approved_action_memo, _approval_request_count
    real_events_path, real_session_id = GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID
    real_scope_prefixes = _contract_scope_prefixes
    real_memo, real_count = _approved_action_memo, _approval_request_count
    _approved_action_memo, _approval_request_count = {}, 0

    try:
        with tempfile.TemporaryDirectory() as wd:
            ws = Path(wd)
            (ws / "src" / "dialog").mkdir(parents=True)
            (ws / "backend").mkdir()
            in_scope = ws / "src" / "dialog" / "file.ts"
            out_of_scope = ws / "backend" / "x.ts"
            out_of_scope_deny = ws / "backend" / "y.ts"
            out_of_scope_timeout = ws / "backend" / "z.ts"

            # 1. Absent env, no session dir at all: legacy behavior byte-
            #    identical -- an out-of-scope-shaped write is never
            #    blocked or paused. If this accidentally DID try to
            #    request approval, request_approval_and_wait would fail
            #    closed to "unavailable" (no GLIMMER_EVENTS_PATH) and this
            #    would raise instead of returning -- so this also proves
            #    the check is a true no-op, not silently swallowed.
            _contract_scope_prefixes = None
            GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID = None, None
            check_write_path(out_of_scope, ws, "write_file")  # must NOT raise

            with tempfile.TemporaryDirectory() as td:
                session_dir = Path(td)
                events_path = session_dir / "events.jsonl"
                events_path.write_text("")
                GLIMMER_EVENTS_PATH = str(events_path)
                GLIMMER_SESSION_ID = "sess-scope-selfcheck"

                # 2. A real session dir now exists, but GLIMMER_CONTRACT_
                #    SCOPE was never set (_contract_scope_prefixes stays
                #    None) -- still a complete no-op: no approval request,
                #    no scope_expanded event, write proceeds.
                check_write_path(out_of_scope, ws, "write_file")  # must NOT raise
                assert load_approvals(session_dir) == {}
                assert events_path.read_text() == ""

                # 3. Explicit scope declared: an IN-scope write is
                #    completely untouched -- no approval requested.
                _contract_scope_prefixes = ["src/dialog"]
                check_write_path(in_scope, ws, "write_file")  # must NOT raise
                assert load_approvals(session_dir) == {}

                # 4. Out-of-scope + explicit scope + approved: bound to
                #    the exact relative path, write proceeds, and a
                #    scope_expanded event carries approval provenance.
                #    v2.py's own post-hoc scopeApproved gate computation is
                #    untouched by any of this (a separate process/file);
                #    this only asserts what THIS process's write-time
                #    check does.
                def _approve_soon():
                    time.sleep(0.03)
                    approvals = load_approvals(session_dir)
                    [approval_id] = approvals.keys()
                    record = approvals[approval_id]
                    assert record["boundTool"] == "write_file", record
                    assert record["boundCommand"] == "backend/x.ts", record
                    record["status"] = "approved"
                    record["approvedBy"] = "daniel"
                    _atomic_write_json(_approvals_path(session_dir), approvals)

                threading.Thread(target=_approve_soon, daemon=True).start()
                check_write_path(
                    out_of_scope, ws, "write_file",
                    approval_timeout_s=2, approval_poll_interval_s=0.01,
                )  # must NOT raise
                scope_events = [
                    json.loads(line) for line in events_path.read_text().splitlines()
                    if json.loads(line).get("type") == "scope_expanded"
                ]
                assert len(scope_events) == 1, scope_events
                assert scope_events[0]["expected"] == ["src/dialog"]
                assert scope_events[0]["actual"] == ["backend/x.ts"]
                assert scope_events[0]["approved"] is True
                assert scope_events[0]["approvedBy"] == "daniel"
                approvals_after_first = load_approvals(session_dir)
                assert len(approvals_after_first) == 1
                assert _approval_request_count == 1

                # 4b. M2 memo: an IDENTICAL subsequent call (same tool_name
                #     + same exact path) never re-pauses -- resolves
                #     "approved" from the in-process memo with NO new
                #     approvals.json entry and NO cap consumption, but it
                #     still emits its own scope_expanded event (the write
                #     is still honestly reported as an expansion every
                #     time, only the human wait is skipped). No background
                #     thread/timeout override needed -- this must return
                #     instantly with nobody resolving anything.
                check_write_path(out_of_scope, ws, "write_file")  # must NOT raise, must NOT hang
                assert load_approvals(session_dir) == approvals_after_first, (
                    "a memoized approval must not create a second approvals.json entry"
                )
                assert _approval_request_count == 1, "a memo hit must not consume a new approval request"
                scope_events = [
                    json.loads(line) for line in events_path.read_text().splitlines()
                    if json.loads(line).get("type") == "scope_expanded"
                ]
                assert len(scope_events) == 2, scope_events
                assert scope_events[1]["approvedBy"] == "daniel"

                # 5. Out-of-scope + explicit scope + denied (a FRESH path --
                #    out_of_scope is already memoized as approved above, so
                #    reusing it here would just hit the memo): fails closed
                #    (ToolPolicyBlock -- the same exception class every
                #    other check_write_path rejection raises, so
                #    execute_tool's existing catch routes it through the
                #    normal tool_blocked/POLICY_BLOCK audit path with no
                #    new plumbing).
                def _deny_soon():
                    time.sleep(0.03)
                    approvals = load_approvals(session_dir)
                    pending = [k for k, v in approvals.items() if v.get("status") == "pending"]
                    [approval_id] = pending
                    approvals[approval_id]["status"] = "denied"
                    approvals[approval_id]["approvedBy"] = "daniel"
                    _atomic_write_json(_approvals_path(session_dir), approvals)

                threading.Thread(target=_deny_soon, daemon=True).start()
                try:
                    check_write_path(
                        out_of_scope_deny, ws, "write_file",
                        approval_timeout_s=2, approval_poll_interval_s=0.01,
                    )
                    raise AssertionError("a denied scope expansion must raise ToolPolicyBlock")
                except ToolPolicyBlock as exc:
                    assert "denied" in str(exc), exc
                assert _approval_request_count == 2, "a real denied request must still consume the cap"
                # A denial must never memoize as "approved" -- only an
                # actual "approved" resolution is ever stored.
                assert ("write_file", "backend/y.ts") not in _approved_action_memo

                # 6. Out-of-scope + explicit scope + nobody ever decides
                #    (a THIRD fresh path): timeout also fails closed.
                try:
                    check_write_path(
                        out_of_scope_timeout, ws, "write_file",
                        approval_timeout_s=0.05, approval_poll_interval_s=0.01,
                    )
                    raise AssertionError("an unresolved scope expansion must time out closed")
                except ToolPolicyBlock as exc:
                    assert "timeout" in str(exc), exc
                assert _approval_request_count == 3, "a real timed-out request must still consume the cap"

                # 7. M2 cap: once the session has made
                #    MAX_APPROVAL_REQUESTS_PER_SESSION genuinely NEW
                #    requests, a further out-of-scope write on a path
                #    that was NEVER seen before (no memo entry to hit) is
                #    denied immediately -- no sidecar entry, no wait.
                _approval_request_count = MAX_APPROVAL_REQUESTS_PER_SESSION
                before_cap = load_approvals(session_dir)
                capped_path = ws / "backend" / "capped.ts"
                started = time.monotonic()
                try:
                    check_write_path(
                        capped_path, ws, "write_file",
                        approval_timeout_s=2, approval_poll_interval_s=0.01,
                    )
                    raise AssertionError("a request past the cap must raise ToolPolicyBlock")
                except ToolPolicyBlock as exc:
                    assert "cap" in str(exc), exc
                assert time.monotonic() - started < 1, "a capped request must never wait at all"
                assert load_approvals(session_dir) == before_cap, (
                    "a capped request must never create a new approvals.json entry"
                )

                # 8. Composition/traversal can't sneak past this check:
                #    resolve_workspace_path's containment guard runs
                #    BEFORE check_write_path even sees a path (secure_
                #    tool_arguments' existing call order), so a traversal
                #    attempt never reaches the scope check at all -- no
                #    approval request, no scope_expanded event, just the
                #    pre-existing "escapes repository" block.
                before = load_approvals(session_dir)
                try:
                    secure_tool_arguments("write_file", {"path": "../outside.txt"}, ws)
                    raise AssertionError("a path escaping the workspace must still be blocked")
                except ToolPolicyBlock as exc:
                    assert "escapes repository" in str(exc), exc
                assert load_approvals(session_dir) == before, (
                    "a blocked traversal attempt must never reach the scope-expansion check"
                )
    finally:
        GLIMMER_EVENTS_PATH, GLIMMER_SESSION_ID = real_events_path, real_session_id
        _contract_scope_prefixes = real_scope_prefixes
        _approved_action_memo, _approval_request_count = real_memo, real_count

    print("scope-expansion approval (V7 §15 follow-up) self-check: PASS (9/9)")


def _mcp_permissions_selfcheck() -> None:
    """Prove that MCP permission metadata reaches every client-side gate."""
    import tempfile

    global MUSE_GLIMMER_HOME

    real_approval = set(_runtime_approval_tools)
    real_read_only = set(_runtime_read_only_tools)
    real_glimmer_home = MUSE_GLIMMER_HOME
    try:
        assert _mcp_requires_approval({"type": "mcp"}) is True
        assert _mcp_requires_approval({"type": "mcp", "permissions": {}}) is True
        assert _mcp_requires_approval(
            {"type": "mcp", "permissions": {"write": True}}
        ) is True
        assert _mcp_requires_approval(
            {"type": "mcp", "permissions": {"write": False}}
        ) is False
        assert _mcp_requires_approval(
            {"type": "builtin", "permissions": {"write": True}}
        ) is False

        _runtime_approval_tools.clear()
        _runtime_read_only_tools.clear()
        _runtime_approval_tools.add("browser_submit")
        _runtime_read_only_tools.add("context7_query")

        assert _requires_tool_approval("browser_submit") is True
        assert "browser_submit" not in _architect_tool_names()
        assert "context7_query" in _architect_tool_names()
        description = approval_description(
            "browser_submit",
            {"password": "must-not-leak"},
            Path("/tmp"),
        )
        assert description == "browser_submit: approval-required MCP action"
        assert "must-not-leak" not in description

        with tempfile.TemporaryDirectory() as td:
            MUSE_GLIMMER_HOME = Path(td) / ".muse-glimmer"
            result, changed = execute_tool(
                "browser_submit",
                {"password": "must-not-run"},
                Path(td),
                {"approve_all": True},
                {},
                [],
                mode="architect",
            )
            assert "architect mode is read-only" in result
            assert changed is False
    finally:
        _runtime_approval_tools.clear()
        _runtime_approval_tools.update(real_approval)
        _runtime_read_only_tools.clear()
        _runtime_read_only_tools.update(real_read_only)
        MUSE_GLIMMER_HOME = real_glimmer_home

    print("MCP permission boundary self-check: PASS")


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
        choices=("engineer", "architect", "consult"),
        default="engineer",
        help=(
            "engineer (default): the existing full read/write "
            "engineering loop, unchanged. "
            "architect: read-only planning mode (V7 §5) — explores the "
            "repository with a read-only tool set and writes "
            "architecture-plan.json instead of editing files. "
            "consult: V7 §23.15 architect escalation -- exactly ONE "
            "toolless model call (--consult-request required), writing "
            "architect-escalation.json. No repository access at all."
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
        "--task-mode",
        choices=("inspect", "plan", "review"),
        default=None,
        help=(
            "Terminal read-only task mode used with --mode architect. "
            "Produces task-report.json instead of architecture-plan.json."
        ),
    )

    parser.add_argument(
        "--consult-request",
        type=Path,
        default=None,
        help=(
            "Task 8.2 (V7 §23.15): only meaningful with --mode consult. "
            "Path to a JSON file written by glimmer-v2.py: "
            '{"architecturePlan": plan-or-null, "question": str}. Required '
            "for --mode consult; ignored otherwise."
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

    if args.mode == "consult":
        # Task 8.2: no workspace access, no tool loop, no turn budget --
        # exactly one toolless model call. args.prompt/args.workspace are
        # still required by argparse but unused here.
        run_consult_escalation(args.consult_request)
    elif args.mode == "architect":
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
            task_mode=args.task_mode,
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

    if sys.argv[1:] == ["--github-cli-selfcheck"]:
        _github_cli_policy_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--architect-mode-selfcheck"]:
        _architect_mode_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--architect-review-selfcheck"]:
        _architect_review_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--task-report-selfcheck"]:
        _task_report_selfcheck()
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

    if sys.argv[1:] == ["--consult-escalation-selfcheck"]:
        _consult_escalation_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--context-tiers-selfcheck"]:
        _context_tiers_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--evidence-index-selfcheck"]:
        _evidence_index_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--model-provider-selfcheck"]:
        _model_provider_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--streaming-transport-selfcheck"]:
        _streaming_transport_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--recovery-ladder-selfcheck"]:
        _recovery_ladder_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--doc-tools-selfcheck"]:
        _doc_tools_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--approval-wait-selfcheck"]:
        _approval_wait_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--scope-approval-selfcheck"]:
        _scope_expansion_selfcheck()
        sys.exit(0)

    if sys.argv[1:] == ["--mcp-permissions-selfcheck"]:
        _mcp_permissions_selfcheck()
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
