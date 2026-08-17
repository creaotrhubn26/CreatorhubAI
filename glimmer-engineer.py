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


API_BASE = os.environ.get(
    "GLIMMER_URL",
    "http://127.0.0.1:8080",
)

API_KEY_FILE = (
    Path.home()
    / "AI/muse-glimmer/config/api-key.txt"
)

DEFAULT_WORKSPACE = Path(
    "/Users/danielqazi/Creatorhubn-monorepo"
)

MAX_TOOL_RESULT = 28000
MAX_EVIDENCE_RESULT = 7000
MAX_EVIDENCE_TOTAL = 50000


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

def shell_policy(
    command,
    workspace,
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

        safe_git = {
            "status",
            "diff",
            "show",
            "log",
            "rev-parse",
        }

        if subcommand in safe_git:
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

        safe_validation = (
            script == "typecheck"
            or script.startswith("typecheck:")
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
# FRONTEND TYPECHECK NORMALIZATION
# ============================================================

def is_full_frontend_typecheck_command(
    command,
    workspace,
):
    """
    Recognize the canonical CreatorHub frontend typecheck
    semantically instead of relying on one exact command string.

    These are equivalent when they resolve to workspace/frontend:

      npm --prefix frontend run typecheck
      npm --prefix ./frontend run typecheck
      npm --prefix=/absolute/workspace/frontend run typecheck
      npm --prefix /absolute/workspace/frontend run typecheck

    Commands targeting any other prefix are not classified as the
    full frontend typecheck.
    """

    import shlex

    try:
        tokens = shlex.split(command)
    except (TypeError, ValueError):
        return False

    if not tokens or tokens[0] != "npm":
        return False

    has_run_typecheck = any(
        tokens[index] == "run"
        and tokens[index + 1] == "typecheck"
        for index in range(len(tokens) - 1)
    )

    if not has_run_typecheck:
        return False

    prefix_values = []
    index = 1

    while index < len(tokens):
        token = tokens[index]

        if token == "--prefix":
            if index + 1 >= len(tokens):
                return False

            prefix_values.append(
                tokens[index + 1]
            )

            index += 2
            continue

        if token.startswith("--prefix="):
            prefix_values.append(
                token.split("=", 1)[1]
            )

        index += 1

    # Ambiguous/no-prefix forms are intentionally not treated as
    # the canonical CreatorHub frontend validation command.
    if len(prefix_values) != 1:
        return False

    prefix = Path(
        prefix_values[0]
    ).expanduser()

    workspace_path = Path(
        workspace
    ).expanduser().resolve()

    if not prefix.is_absolute():
        prefix = workspace_path / prefix

    try:
        resolved_prefix = prefix.resolve()
        expected_prefix = (
            workspace_path / "frontend"
        ).resolve()
    except (OSError, RuntimeError):
        return False

    return resolved_prefix == expected_prefix


def frontend_typecheck_guard_decision(
    is_full_frontend_typecheck,
    writes_made,
    diagnostic_typecheck_attempted,
    verification_typecheck_attempted,
):
    """
    Return (phase, blocked) for frontend typecheck governance.

    Before first successful edit:
        one diagnostic typecheck.

    After first successful edit:
        one verification typecheck.
    """

    if not is_full_frontend_typecheck:
        return None, False

    phase = (
        "verification"
        if writes_made
        else "diagnostic"
    )

    if phase == "diagnostic":
        return (
            phase,
            bool(diagnostic_typecheck_attempted),
        )

    return (
        phase,
        bool(verification_typecheck_attempted),
    )



def repository_write_guard_decision(
    tool_name,
    verification_typecheck_attempted,
):
    """
    Freeze repository writes after the first post-edit full
    frontend verification typecheck has actually been attempted.

    PASS, FAIL, and TIMEOUT are all terminal verification evidence.
    Once that evidence exists, later repository edits would invalidate
    the verified snapshot and therefore must be blocked.
    """
    return bool(
        verification_typecheck_attempted
        and tool_name in WRITE_TOOLS
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
        #
        # Full frontend TypeScript validation is especially heavy
        # in CreatorHub and has a manually verified clean baseline,
        # so allow up to 20 minutes.
        if is_full_frontend_typecheck_command(
            command,
            workspace,
        ):
            minimum_timeout = 1200
        elif command.startswith(("npm ", "cargo ")):
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
                command=command,
                reason=reason,
            )

            return message, False


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
        args=display_args,
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

        "The full frontend typecheck may be executed "
        "at most once before the first successful edit for "
        "diagnosis, and at most once after the first "
        "successful edit for verification. Equivalent "
        "--prefix forms resolving to workspace/frontend "
        "count as the same validation command. A pass, "
        "failure, or timeout is final evidence for that "
        "phase; never retry the frontend typecheck within "
        "the same phase. "

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

    writes_made = False
    diff_checked = False
    validation_checked = False

    # Full frontend typecheck governance is phase-aware.
    #
    # Before the first successful edit:
    #   one diagnostic typecheck may be executed.
    #
    # After the first successful edit:
    #   one verification typecheck may be executed.
    #
    # PASS, FAIL, or TIMEOUT is terminal evidence for that phase.
    # A third attempt, or a retry within either phase, is blocked.
    diagnostic_typecheck_attempted = False
    diagnostic_typecheck_result = None

    verification_typecheck_attempted = False
    verification_typecheck_result = None

    # Prevent the model from spending the entire turn budget
    # repeatedly exploring the repository without selecting
    # a concrete engineering candidate.
    discovery_calls = 0
    discovery_gate_sent = False
    discovery_tool_budget = 8

    # After broad discovery, allow only a very small number of
    # calls to verify the selected candidate before forcing a
    # concrete edit/no-edit decision.
    post_gate_inspection_calls = 0
    post_gate_inspection_budget = 3
    decision_deadline_sent = False

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

        # Once discovery budget is exhausted, remove broad
        # exploration/shell tools until the first edit.
        # The model can still inspect the selected target and edit it.
        if decision_deadline_sent and not writes_made:
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

        elif discovery_gate_sent and not writes_made:
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
                writes_made
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
                            "finishing. Never retry the "
                            "post-change frontend typecheck "
                            "after a failure or timeout."
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
                not writes_made
                and tool_name in discovery_tools
            ):
                discovery_calls += 1

            if (
                discovery_gate_sent
                and not writes_made
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

                    is_full_frontend_typecheck = (
                        is_full_frontend_typecheck_command(
                            command_for_guard,
                            workspace,
                        )
                    )

                    (
                        frontend_typecheck_phase,
                        frontend_typecheck_already_attempted,
                    ) = frontend_typecheck_guard_decision(
                        is_full_frontend_typecheck,
                        writes_made,
                        diagnostic_typecheck_attempted,
                        verification_typecheck_attempted,
                    )

                    repository_write_blocked = (
                        repository_write_guard_decision(
                            tool_name,
                            verification_typecheck_attempted,
                        )
                    )

                    if repository_write_blocked:
                        result = (
                            "ENGINEERING VALIDATION BLOCK: "
                            "repository writes are frozen because "
                            "the post-edit frontend verification "
                            "typecheck has already been attempted. "
                            "PASS, FAIL, or TIMEOUT is terminal "
                            "verification evidence. Do not modify "
                            "repository files after verification."
                        )
                        changed = False

                        print()
                        print(
                            "✗ WRITE BLOCKED: repository is frozen "
                            "after frontend verification"
                        )

                    elif frontend_typecheck_already_attempted:
                        result = (
                            "ENGINEERING VALIDATION BLOCK: "
                            "the full frontend typecheck has "
                            "already been attempted in the "
                            f"{frontend_typecheck_phase} phase. "
                            "Do not retry it. Use the recorded "
                            "result from that phase as final "
                            "validation evidence."
                        )
                        changed = False

                        print()
                        print(
                            "✗ VALIDATION BLOCKED: "
                            "full frontend typecheck already "
                            f"attempted in {frontend_typecheck_phase} "
                            "phase"
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
                            )
                        )

                        if is_full_frontend_typecheck:
                            # Mark only after an execution was
                            # actually attempted. A normal command
                            # failure or timeout still counts as
                            # terminal evidence for its phase.
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
                                if (
                                    frontend_typecheck_phase
                                    == "diagnostic"
                                ):
                                    diagnostic_typecheck_attempted = True
                                    diagnostic_typecheck_result = (
                                        result_text
                                    )

                                elif (
                                    frontend_typecheck_phase
                                    == "verification"
                                ):
                                    verification_typecheck_attempted = True
                                    verification_typecheck_result = (
                                        result_text
                                    )

                    if changed:
                        writes_made = True
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
            not writes_made
            and not discovery_gate_sent
            and discovery_calls >= discovery_tool_budget
        ):
            discovery_gate_sent = True

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
            discovery_gate_sent
            and not writes_made
            and not decision_deadline_sent
            and post_gate_inspection_calls
                >= post_gate_inspection_budget
        ):
            decision_deadline_sent = True

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
        default=DEFAULT_WORKSPACE,
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
