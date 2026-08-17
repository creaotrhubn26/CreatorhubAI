#!/usr/bin/env python3

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
from urllib import request, error

from glimmer_events import emit as emit_event

GLIMMER_EVENTS_PATH = os.environ.get("GLIMMER_EVENTS_PATH")
GLIMMER_SESSION_ID = os.environ.get("GLIMMER_SESSION_ID")


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

PATH_TOOLS = {
    "read_file",
    "file_glob_search",
    "grep_search",
    "write_file",
    "edit_file",
}

REQUIRED_ENGINEERING_TOOLS = {
    "read_file",
    "file_glob_search",
    "grep_search",
    "write_file",
    "edit_file",
    "exec_shell_command",
}


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

            if "--output" in tokens:
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


def add_evidence(
    ledger,
    tool_name,
    arguments,
    content,
):
    interesting = {
        "read_file",
        "file_glob_search",
        "grep_search",
        "exec_shell_command",
        "write_file",
        "edit_file",
    }

    if tool_name not in interesting:
        return

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
# TOOL EXECUTION
# ============================================================

def execute_tool(
    tool_name,
    arguments,
    workspace,
    approval_state,
    cache,
    ledger,
    validation_allowlist=None,
):
    arguments = secure_tool_arguments(
        tool_name,
        arguments,
        workspace,
    )

    cache_key = None

    if tool_name in {
        "read_file",
        "file_glob_search",
        "grep_search",
    }:
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

            return (
                cache[cache_key],
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

            return message, False

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

                return (
                    cache[cache_key],
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

            return (
                "User denied this tool execution.",
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

    add_evidence(
        ledger,
        tool_name,
        arguments,
        content,
    )

    changed = (
        tool_name in WRITE_TOOLS
    )

    return content, changed


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

    if len(text) <= max_chars:
        return text

    head_size = int(max_chars * 0.72)
    tail_size = max_chars - head_size

    omitted = len(text) - max_chars

    return (
        text[:head_size]
        + "\n\n"
        + "<<< TOOL RESULT COMPACTED FOR MODEL CONTEXT; "
        + f"{omitted} CHARACTERS OMITTED >>>"
        + "\n\n"
        + text[-tail_size:]
    )


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
# ENGINEERING LOOP
# ============================================================

def run_engineer(
    task,
    workspace,
    max_turns,
    auto_yes,
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
    discovery_calls = 0
    discovery_tool_budget = 8

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

    discovery_tools = {
        "file_glob_search",
        "grep_search",
        "read_file",
    }

    post_gate_inspection_tools = {
        "read_file",
        "grep_search",
    }

    for turn in range(max_turns):

        active_tools = tools

        # active_tools is driven solely by engineer_phase (R3). Mapping from
        # the old boolean combinations, preserved here for traceability:
        #   decision_deadline_sent and not writes_made -> narrowed_to_edit_only
        #   discovery_gate_sent and not writes_made    -> narrowed_to_read_edit
        #   writes_made (from any prior phase)         -> writing (full tools)
        #   neither gate sent yet, no write yet        -> discovering (full tools)
        if engineer_phase == "narrowed_to_edit_only":
            # Verification budget is exhausted.
            # At this point the model must either edit the chosen
            # file or finish without making a change.
            allowed_before_edit = {
                "edit_file",
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
            allowed_before_edit = {
                "read_file",
                "grep_search",
                "edit_file",
            }

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

            if (
                engineer_phase != "writing"
                and tool_name in discovery_tools
            ):
                discovery_calls += 1

            if (
                engineer_phase in (
                    "narrowed_to_read_edit",
                    "narrowed_to_edit_only",
                )
                and tool_name in post_gate_inspection_tools
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
                        "small, low-risk candidate. You may use read_file "
                        "or grep_search only to verify that selected "
                        "candidate. Then either call edit_file with the "
                        "smallest behavior-preserving fix, or explicitly "
                        "finish without changes if no candidate is safe. "
                        "Do not continue browsing alternative candidates."
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
                        "and behavior-preserving, call edit_file with "
                        "exactly one minimal change. Otherwise finish "
                        "without modifications and explain why. "
                        "Do not switch to another candidate."
                    ),
                }
            )

            print()
            print(
                "↻ Decision deadline: "
                f"{post_gate_inspection_calls} post-gate "
                "inspection calls used. "
                "Next action must be edit_file or finish."
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
        default=32,
    )

    parser.add_argument(
        "--yes",
        action="store_true",
        help=(
            "Automatically approve actions "
            "that already pass the safety policy."
        ),
    )

    args = parser.parse_args()

    run_engineer(
        " ".join(args.prompt),
        args.workspace,
        args.max_turns,
        args.yes,
    )


if __name__ == "__main__":
    if sys.argv[1:] == ["--repeat-guard-selfcheck"]:
        _repeat_guard_selfcheck()
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
