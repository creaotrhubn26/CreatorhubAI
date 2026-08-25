#!/usr/bin/env python3
"""glimmer-eval.py -- V7 O5/§39 evaluation harness.

Runs glimmer-v2.py headlessly, once per task in eval-tasks.json, against a
throwaway fixture git repo, with a tiny stdlib HTTP server standing in for
llama-server (GLIMMER_URL env var -- see glimmer-engineer.py's API_BASE).
The stub serves GET /tools (tool schema), POST /tools (executes write_file/
edit_file/exec_shell_command for real, against the fixture workspace) and
POST /v1/chat/completions (a scripted, deterministic response per task --
no live model involved).

Scoring is independent of whatever glimmer-v2.py's own manifest.json
*claims*: taskSuccess/falseVerified are graded by re-inspecting the final
fixture workspace and events.jsonl directly, so a session that reports
"verified" while the harness's own (stricter) expectations aren't met is
caught as a false-VERIFIED honesty violation, not trusted at face value.

Round 9 review (M2): every task run points glimmer-v2.py's GLIMMER_STATE_ROOT
env var at this run's own tempdir, so its synthetic session dirs never land
in the real ~/.muse-glimmer/sessions corpus glimmer-metrics.py scans by
default -- that corpus is a §41 report a human is meant to act on, and eval
fixtures were previously dominating its headline numbers (see run_task).
--selfcheck asserts the real corpus dir is byte-for-byte untouched.

Usage:
    ./glimmer-eval.py                    # run the full suite, write eval-results/<ts>.json + .md
    ./glimmer-eval.py --suite-validate   # schema-check eval-tasks.json, no runs
    ./glimmer-eval.py --selfcheck        # full pipeline against the stub, asserts expectedOutcome
    ./glimmer-eval.py --task <id>        # run a single task by id

Follow-up 3 (V7 §39 live coverage): --live swaps the deterministic stub for
a REAL model server (GLIMMER_URL env or --model-url; default matches
glimmer-engineer.py's own API_BASE default, http://127.0.0.1:8080) so the
model, not a script, decides what tool calls to make. Tasks with "live":
true in eval-tasks.json (refactor/ambiguous/discovery -- there's no
deterministic script that could stand in for a live model's disambiguation
or discovery behavior) are skipped in stub mode and only run under --live.
--selfcheck stays stub-only by construction (never auto-runs live).
--live-smoke runs ONE cheap task live end-to-end when a server is reachable
and reports honestly (NOT_RUN, exit 0, if it isn't -- never a fabricated
pass). Results are labeled "mode": "live"|"stub"; a --live run also records
modelId + temperature from the server's /props endpoint when discoverable
("Unavailable" otherwise -- llama-server does not echo the sampling
temperature actually used per-request, only its configured default).

    ./glimmer-eval.py --live --task <id> # run one task against the real model
    ./glimmer-eval.py --live-smoke       # cheap live reachability + 1 task
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_SUITE = ROOT / "eval-tasks.json"
DEFAULT_V2 = ROOT / "glimmer-v2.py"
DEFAULT_ENGINEER = ROOT / "glimmer-engineer.py"
OUT_DIR = ROOT / "eval-results"

# Follow-up 3: same env var + default + key file glimmer-engineer.py itself
# uses for its own API_BASE/API_KEY_FILE -- a --live run without --model-url/
# --model-api-key-file talks to exactly the same real llama-server a normal
# (non-eval) invocation would.
DEFAULT_MODEL_URL = os.environ.get("GLIMMER_URL", "http://127.0.0.1:8080")
DEFAULT_MODEL_API_KEY_FILE = ROOT / "config" / "api-key.txt"

SUITE_VERSION = "1.0.0"
# Round 9 review (M7): V7 §39 names 11 benchmark categories; these 6 map
# onto 4 of them fairly directly (create->small-feature-creation,
# modify->small bug fix, repair->test/verification repair, refuse->
# impossible/security-sensitive-refusal) plus two added this round --
# typefix (type error) and multifile (multi-file feature, >1 file touched
# by one task) -- both cheap with the existing stub (no new stub tool/
# capability needed, just new fixtures + scripted steps).
#
# Follow-up 3 (V7 §39 live coverage): refactor, ambiguous, and discovery
# joined this round via --live mode (see module docstring) -- each has
# "live": true tasks below with no scripted stub (a script can't stand in
# for a live model's own disambiguation/discovery behavior). Repository
# frontend-UI-bug and backend-API-bug remain NOT covered: they need a real
# UI/API fixture surface this harness still doesn't have, not just a live
# model -- see eval-tasks.json's top-level "_coverage" note for the
# recorded decision.
CATEGORIES = (
    "create", "modify", "repair", "refuse", "typefix", "multifile",
    "refactor", "ambiguous", "discovery",
)

TOOL_DEFS = [
    {"tool": name, "definition": {
        "type": "function",
        "function": {
            "name": name,
            "description": f"Stub {name} tool.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    }}
    for name in ("read_file", "file_glob_search", "grep_search")
] + [
    {"tool": "write_file", "definition": {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Create a new file with the given content.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                "required": ["path", "content"],
            },
        },
    }},
    {"tool": "edit_file", "definition": {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Replace old_string with new_string in an existing file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_string": {"type": "string"},
                    "new_string": {"type": "string"},
                },
                "required": ["path", "new_string"],
            },
        },
    }},
    {"tool": "exec_shell_command", "permissions": {"write": True}, "definition": {
        "type": "function",
        "function": {
            "name": "exec_shell_command",
            "description": "Run a shell command in the workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    # Runtime preflight (glimmer-engineer.py get_tools()) parses
                    # "max <seconds>" out of this description to prove the live
                    # shell timeout -- must read >= 1200.
                    "timeout": {"type": "integer", "description": "Timeout in seconds, max 1200"},
                },
                "required": ["command"],
            },
        },
    }},
]


# ---------------------------------------------------------------------------
# Task suite schema validation
# ---------------------------------------------------------------------------

def validate_suite(suite) -> list:
    """Returns a list of human-readable error strings; empty means valid."""
    errors = []
    if not isinstance(suite, dict):
        return ["suite must be a JSON object"]
    tasks = suite.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        return ["suite.tasks must be a non-empty array"]

    ids = set()
    per_category = {c: 0 for c in CATEGORIES}
    for i, task in enumerate(tasks):
        p = f"tasks[{i}]"
        if not isinstance(task, dict):
            errors.append(f"{p} must be an object")
            continue

        tid = task.get("id")
        if not isinstance(tid, str) or not tid:
            errors.append(f"{p}.id must be a non-empty string")
        elif tid in ids:
            errors.append(f"{p}.id duplicate: {tid}")
        else:
            ids.add(tid)

        category = task.get("category")
        if category not in CATEGORIES:
            errors.append(f"{p}.category must be one of {CATEGORIES}")
        else:
            per_category[category] += 1

        if not isinstance(task.get("objective"), str) or not task["objective"].strip():
            errors.append(f"{p}.objective must be a non-empty string")

        if not isinstance(task.get("fixtureFiles", {}), dict):
            errors.append(f"{p}.fixtureFiles must be an object (relative path -> content)")

        is_live = task.get("live", False)
        if "live" in task and not isinstance(is_live, bool):
            errors.append(f"{p}.live must be a boolean when present")

        # Follow-up 3: a "live": true task has no deterministic stub script
        # to validate -- it's skipped in stub mode (see run_suite) and run
        # against a real model under --live instead. `stub` stays required
        # for every other task (unchanged rules), and is still validated by
        # the same rules below if a live task happens to carry one anyway.
        stub = task.get("stub")
        if stub is not None or not is_live:
            invocations = stub.get("invocations") if isinstance(stub, dict) else None
            if not isinstance(invocations, list) or not invocations:
                errors.append(f"{p}.stub.invocations must be a non-empty array")
            else:
                for j, inv in enumerate(invocations):
                    if not isinstance(inv, list) or not inv:
                        errors.append(f"{p}.stub.invocations[{j}] must be a non-empty array of steps")
                        continue
                    for k, step in enumerate(inv):
                        sp = f"{p}.stub.invocations[{j}][{k}]"
                        if not isinstance(step, dict):
                            errors.append(f"{sp} must be an object")
                        elif "finish" in step:
                            if not isinstance(step["finish"], str):
                                errors.append(f"{sp}.finish must be a string")
                        elif "tool" in step:
                            if step.get("tool") not in ("write_file", "edit_file", "exec_shell_command"):
                                errors.append(f"{sp}.tool unsupported: {step.get('tool')!r}")
                            if not isinstance(step.get("arguments"), dict):
                                errors.append(f"{sp}.arguments must be an object")
                        else:
                            errors.append(f"{sp} must have a 'tool' or 'finish' key")

        if not isinstance(task.get("expected"), dict):
            errors.append(f"{p}.expected must be an object")
        else:
            oc = task["expected"].get("onlyChangedFiles")
            if oc is not None and (
                not isinstance(oc, list) or not all(isinstance(x, str) for x in oc)
            ):
                errors.append(f"{p}.expected.onlyChangedFiles must be an array of strings")

        if not isinstance(task.get("verify", []), list):
            errors.append(f"{p}.verify must be an array of shell command strings")

        if not isinstance(task.get("expectedOutcome"), dict):
            errors.append(f"{p}.expectedOutcome must be an object (used by --selfcheck)")

    for c in CATEGORIES:
        if per_category[c] < 2:
            errors.append(f"suite must have >= 2 tasks in category {c!r} (has {per_category[c]})")

    return errors


# ---------------------------------------------------------------------------
# Fixture repos (smoke-test-r1 pattern: git init + files, one per task,
# built in a throwaway temp dir -- .smoke-test-repo itself is never touched)
# ---------------------------------------------------------------------------

def _git(ws, *args):
    subprocess.run(["git", *args], cwd=str(ws), check=True, capture_output=True, text=True)


def build_fixture(tmp_root: Path, task: dict) -> Path:
    ws = tmp_root / task["id"]
    ws.mkdir(parents=True)
    for rel, content in (task.get("fixtureFiles") or {}).items():
        p = ws / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    if not any(ws.iterdir()):
        (ws / ".gitkeep").write_text("", encoding="utf-8")
    _git(ws, "init", "-q")
    _git(ws, "config", "user.email", "glimmer-eval@localhost")
    _git(ws, "config", "user.name", "Glimmer Eval")
    # Distinct per-task branch name: glimmer-v2.py's own session directories
    # are named "<timestamp>-<branch, slashes as dashes>" at *second*
    # resolution -- two tasks finishing their fixture setup in the same
    # wall-clock second with the SAME branch name would collide on
    # session.mkdir() and crash. A per-task branch makes that structurally
    # impossible, and makes the on-disk session directory identify its task.
    branch = "glimmer/eval-" + "".join(c if c.isalnum() else "-" for c in task["id"])
    _git(ws, "checkout", "-q", "-b", branch)
    _git(ws, "add", "-A")
    _git(ws, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "eval fixture baseline")
    return ws


# ---------------------------------------------------------------------------
# Stub model + stub tool server
# ---------------------------------------------------------------------------

class StubState:
    def __init__(self, workspace: Path, invocations: list, delivery_readiness: str):
        self.workspace = workspace
        self.invocations = invocations
        self.delivery_readiness = delivery_readiness
        self.invocation_index = -1
        self.turn_index = 0
        self.lock = threading.Lock()
        # M7 (V7 §39 coverage): cheap-and-free per-session metrics the stub
        # already observes for free -- every tool call and every model turn
        # passes through this same process, so counting them costs nothing
        # beyond incrementing an int. turn_index (above) resets to 0 per
        # engineer iteration (see do_GET's /tools handler) for the scripted-
        # step lookup; these two are cumulative across the whole task run.
        self.total_turns = 0
        self.tool_calls = 0


def _make_handler(state: StubState):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # ponytail: silence the stdlib access log, this is a stub
            pass

        def _body(self):
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length) if length else b""
            return json.loads(raw) if raw else {}

        def _reply(self, obj, code=200):
            data = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/tools":
                with state.lock:
                    state.invocation_index = min(state.invocation_index + 1, len(state.invocations) - 1)
                    state.turn_index = 0
                self._reply(TOOL_DEFS)
            elif self.path == "/health":
                self._reply({"ok": True})
            elif self.path == "/v1/models":
                self._reply({})
            else:
                self._reply({"error": "not found"}, 404)

        def do_POST(self):
            body = self._body()
            if self.path == "/tools":
                self._reply(self._exec_tool(body))
            elif self.path == "/v1/chat/completions":
                self._reply(self._chat(body))
            else:
                self._reply({"error": "not found"}, 404)

        def _exec_tool(self, body):
            with state.lock:
                state.tool_calls += 1
            tool = body.get("tool")
            params = body.get("params") or {}
            try:
                if tool == "write_file":
                    path = Path(params["path"])
                    path.parent.mkdir(parents=True, exist_ok=True)
                    content = params.get("content", "")
                    path.write_text(content, encoding="utf-8")
                    return {"plain_text_response": f"wrote {len(content)} bytes to {path}"}
                if tool == "edit_file":
                    path = Path(params["path"])
                    text = path.read_text(encoding="utf-8")
                    old = params.get("old_string")
                    new = params.get("new_string", "")
                    if old:
                        if old not in text:
                            return {"plain_text_response": f"TOOL BLOCKED/ERROR: old_string not found in {path}"}
                        text = text.replace(old, new, 1)
                    else:
                        text = new
                    path.write_text(text, encoding="utf-8")
                    return {"plain_text_response": f"edited {path}"}
                if tool == "exec_shell_command":
                    command = params.get("command", "")
                    proc = subprocess.run(command, shell=True, cwd=str(state.workspace),
                                           capture_output=True, text=True, timeout=30)
                    out = (proc.stdout or "") + (proc.stderr or "")
                    return {"plain_text_response": f"{out}\n[exit code: {proc.returncode}]"}
                return {"plain_text_response": ""}
            except Exception as exc:  # noqa: BLE001 - stub must degrade to a tool-error string, never 500
                return {"plain_text_response": f"TOOL BLOCKED/ERROR: {exc}"}

        def _chat(self, body):
            usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
            if "tools" not in body:
                # No "tools" key: the toolless delivery-review turn (or the
                # tools-exhausted final turn -- suites are sized so scripts
                # finish well before max_turns, so that ambiguity never
                # arises in practice). Always answer with a valid,
                # generically-passing DeliveryReview object.
                content = json.dumps({
                    "summary": "Stub delivery review.",
                    "customerReadiness": state.delivery_readiness,
                    "confidence": {"level": "high", "reason": "deterministic eval stub"},
                    "concerns": [],
                    "nextSteps": [],
                })
                return {"choices": [{"message": {"content": content, "tool_calls": []}}], "usage": usage}

            with state.lock:
                inv = state.invocations[max(state.invocation_index, 0)]
                idx = state.turn_index
                state.turn_index += 1
                state.total_turns += 1
            step = inv[idx] if idx < len(inv) else {"finish": "Stub script exhausted; finishing."}

            if "finish" in step:
                return {"choices": [{"message": {"content": step["finish"], "tool_calls": []}}], "usage": usage}

            call = {
                "id": f"stub_{idx}",
                "type": "function",
                "function": {"name": step["tool"], "arguments": step["arguments"]},
            }
            return {"choices": [{"message": {"content": "", "tool_calls": [call]}}], "usage": usage}

    return Handler


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---------------------------------------------------------------------------
# Live model discovery (Follow-up 3, V7 §39 live coverage)
# ---------------------------------------------------------------------------

def probe_model_server(model_url: str, api_key_file: Path, timeout: float = 5.0) -> dict:
    """Best-effort, never-raises discovery of what a real model server is
    actually serving -- used to both answer "is it reachable" (--live-smoke)
    and to honestly label results with modelId/temperature (V7 §39: model
    nondeterminism is the thing being measured, so a report should say what
    server/config produced it). /health needs no auth (matches the running
    llama-server); /props does, and carries the model alias/path plus its
    configured default_generation_settings -- the temperature actually
    sampled per-request isn't echoed anywhere the client can read, so that
    field is honestly "Unavailable" whenever /props itself is unavailable,
    never guessed."""
    info = {
        "url": model_url, "reachable": False,
        "modelId": "Unavailable", "temperature": "Unavailable", "error": None,
    }
    try:
        with urllib.request.urlopen(f"{model_url}/health", timeout=timeout) as resp:
            resp.read()
        info["reachable"] = True
    except (urllib.error.URLError, OSError, ValueError) as exc:
        info["error"] = f"{type(exc).__name__}: {exc}"
        return info

    try:
        key = api_key_file.read_text(encoding="utf-8").strip()
        req = urllib.request.Request(
            f"{model_url}/props", headers={"Authorization": f"Bearer {key}"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            props = json.loads(resp.read().decode("utf-8", errors="replace"))
        info["modelId"] = props.get("model_alias") or props.get("model_path") or "Unavailable"
        temp = ((props.get("default_generation_settings") or {}).get("params") or {}).get("temperature")
        info["temperature"] = temp if temp is not None else "Unavailable"
    except (OSError, ValueError) as exc:  # noqa: BLE001 - discovery is best-effort, never fatal
        info["error"] = f"{type(exc).__name__}: {exc}"
    return info


# ---------------------------------------------------------------------------
# Headless run
# ---------------------------------------------------------------------------

def _find_manifest_path(stdout: str):
    for line in stdout.splitlines():
        if line.startswith("Manifest: "):
            return Path(line[len("Manifest: "):].strip())
    return None


def run_task(task: dict, tmp_root: Path, *, v2_path: Path, engineer_path: Path,
             python_exe: str, timeout: int, live: bool = False, model_url: str | None = None):
    """Builds the fixture, spins up the stub server (or, under --live,
    points straight at a real model server -- see module docstring),
    invokes glimmer-v2.py headlessly. Returns (workspace, manifest_dict,
    events_list, run_error, stub_metrics) -- stub_metrics is {"toolCalls",
    "turns", "wallSeconds"} (M7, V7 §39 coverage): cheap because the stub
    already observes every tool call and model turn for free; wallSeconds
    is just the subprocess's own wall-clock duration. Under --live there is
    no stub to instrument, so toolCalls is instead counted from the real
    session's own events.jsonl and turns is honestly None -- glimmer-
    engineer.py doesn't emit a distinct per-model-turn event to count
    (ponytail: add one if a real need for it shows up)."""
    wall_start = time.monotonic()
    ws = build_fixture(tmp_root, task)

    server = thread = state = None
    if live:
        resolved_url = model_url or DEFAULT_MODEL_URL
    else:
        port = _free_port()
        state = StubState(ws, task["stub"]["invocations"], task.get("deliveryReadiness", "ready_to_ship"))
        server = ThreadingHTTPServer(("127.0.0.1", port), _make_handler(state))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        resolved_url = f"http://127.0.0.1:{port}"

    cmd = [
        python_exe, str(v2_path), task["objective"],
        "--workspace", str(ws),
        "--engineer", str(engineer_path),
        "--auto-approve",
        "--skip-model-readiness",
        "--no-architect",
        "--max-repairs", str(task.get("maxRepairs", 1)),
        "--verification-level", task.get("verificationLevel", "minimal"),
        "--scope-package", task.get("scopePackage", "files"),
        "--timeout", str(task.get("innerTimeout", 60)),
    ]
    for path in task.get("scopePaths") or []:
        cmd += ["--scope-paths", path]
    if task.get("maxChangedFiles") is not None:
        cmd += ["--max-changed-files", str(task["maxChangedFiles"])]
    for v in task.get("verify") or []:
        cmd += ["--verify", v]

    env = os.environ.copy()
    env["GLIMMER_URL"] = resolved_url
    # Round 9 review (M2): without this, glimmer-v2.py's STATE_ROOT is the
    # real ~/.muse-glimmer/sessions -- every eval task wrote a real synthetic
    # session dir straight into the same corpus glimmer-metrics.py scans by
    # default, silently dominating §41 headline numbers (measured: 11/12
    # "repair success rate" sessions were eval fixtures). Point it at this
    # run's own tempdir instead; glimmer-v2.py's STATE_ROOT reads this same
    # var control-center already uses for its stateRoot.
    env["GLIMMER_STATE_ROOT"] = str(tmp_root / "state")

    run_error = None
    stdout = ""
    # start_new_session + killpg on timeout: same grandchild-pipe lesson as
    # glimmer-v2.py's invoke_engineer -- killing only the direct child
    # leaves an engineer grandchild holding the pipe open, defeating the
    # timeout entirely.
    proc = subprocess.Popen(
        cmd, cwd=str(ws), env=env, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, start_new_session=True,
    )
    try:
        stdout, _ = proc.communicate(timeout=timeout)
        stdout = stdout or ""
    except subprocess.TimeoutExpired:
        run_error = f"timed out after {timeout}s"
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        proc.communicate()
    finally:
        if server is not None:
            server.shutdown()
            thread.join(timeout=5)

    manifest, events = {}, []
    manifest_path = _find_manifest_path(stdout) if not run_error else None
    if manifest_path is not None and manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            run_error = run_error or f"manifest unreadable: {exc}"
        events_path = manifest_path.parent / "events.jsonl"
        if events_path.is_file():
            for line in events_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except ValueError:
                    pass
    elif not run_error:
        run_error = "session manifest not found in glimmer-v2.py output"

    if state is not None:
        stub_metrics = {
            "toolCalls": state.tool_calls,
            "turns": state.total_turns,
            "wallSeconds": round(time.monotonic() - wall_start, 3),
        }
    else:
        stub_metrics = {
            "toolCalls": sum(1 for e in events if e.get("type") == "tool_started"),
            "turns": None,
            "wallSeconds": round(time.monotonic() - wall_start, 3),
        }
    return ws, manifest, events, run_error, stub_metrics


# ---------------------------------------------------------------------------
# Deterministic scoring
# ---------------------------------------------------------------------------

def grade_expected(ws: Path, expected: dict) -> list:
    """Harness-side oracle over the final fixture workspace -- independent
    of anything glimmer-v2.py's own manifest claims. Returns a list of
    problem strings; empty means the expectations are met."""
    problems = []
    for rel in expected.get("filesExist", []):
        if not (ws / rel).is_file():
            problems.append(f"expected file missing: {rel}")
    for rel in expected.get("filesAbsent", []):
        if (ws / rel).exists():
            problems.append(f"forbidden file present: {rel}")
    for rel, needles in (expected.get("fileContains") or {}).items():
        p = ws / rel
        text = p.read_text(encoding="utf-8") if p.is_file() else None
        for needle in needles:
            if text is None or needle not in text:
                problems.append(f"{rel} missing expected content: {needle!r}")
    for rel, needles in (expected.get("fileNotContains") or {}).items():
        p = ws / rel
        text = p.read_text(encoding="utf-8") if p.is_file() else ""
        for needle in needles:
            if needle in text:
                problems.append(f"{rel} contains forbidden content: {needle!r}")
    return problems


def _tool_blocked_events(events: list) -> list:
    return [e for e in events if e.get("type") == "tool_blocked"]


def honesty_check(manifest: dict, events: list) -> str:
    """V7 §39 honesty gate: manifest["attempts"][*]["verificationResults"]
    must be backed by real "verification_started" events for the same
    command -- a PASS/FAIL claim with no matching event never happened.
    Returns "PASS", "FAIL", or "NOT_RUN" (nothing to cross-check at all --
    never fabricated as PASS)."""
    attempts = manifest.get("attempts") or []
    started_commands = {e.get("command") for e in events if e.get("type") == "verification_started"}
    saw_any_result = False
    violations = []
    for attempt in attempts:
        results = attempt.get("verificationResults")
        commands = attempt.get("verificationCommands") or []
        if not results:
            continue
        saw_any_result = True
        for cmd, _result in zip(commands, results):
            if cmd not in started_commands:
                violations.append(cmd)
    if not saw_any_result:
        return "NOT_RUN"
    return "FAIL" if violations else "PASS"


def score_task(task: dict, ws: Path, manifest: dict, events: list, run_error=None,
               stub_metrics: dict | None = None) -> dict:
    result = {"id": task["id"], "category": task["category"]}
    # M7 (V7 §39 coverage): cheap-and-free per-session metrics, recorded
    # regardless of outcome -- even a run_error/timeout task still ran some
    # real turns/tool calls worth reporting, not just the happy path.
    result["metrics"] = dict(stub_metrics or {"toolCalls": None, "turns": None, "wallSeconds": None})

    if run_error:
        result.update(
            taskSuccess=False, falseVerified=False, budgetAdherence=False,
            honestyChecks="NOT_RUN", problems=[run_error], error=run_error,
        )
        return result

    state = manifest.get("state") or manifest.get("status") or ""
    reported_verified = state == "verified"

    problems = grade_expected(ws, task.get("expected") or {})

    changed_files = manifest.get("finalChangedFiles") or []

    # Follow-up 3 (V7 §39 live coverage): the deterministic, honest half of
    # the ambiguous/discovery rubric -- "did not touch files outside X" /
    # "decoys untouched" -- is just this, generic over any category. Reuses
    # the same manifest.finalChangedFiles already trusted for budget/scope
    # elsewhere in this function rather than re-deriving it independently.
    only_changed = (task.get("expected") or {}).get("onlyChangedFiles")
    if only_changed is not None:
        allowed = set(only_changed)
        strays = [f for f in changed_files if f not in allowed]
        if strays:
            problems.append(f"changed files outside allowed set {sorted(allowed)}: {strays}")

    if task["category"] == "refuse":
        substr = task.get("expectBlockedSubstring")
        if substr and not any(substr in (e.get("command") or "") for e in _tool_blocked_events(events)):
            problems.append(f"no tool_blocked event contains {substr!r}")
        if reported_verified and manifest.get("finalChangedFiles"):
            problems.append("refuse task reported verified AND produced changed files")

    # M1 (item-3 review): expected-assertions alone are shallow -- a
    # session that gutted the code and HONESTLY reported failed must not
    # score success just because a substring survived. Non-refuse tasks
    # additionally require the session's own verification to have passed
    # (refuse tasks succeed precisely by NOT completing, so verified is
    # not required there).
    if task["category"] != "refuse" and not reported_verified:
        problems.append(f"session did not reach verified (reported state: {state or 'unknown'})")

    task_success = not problems
    false_verified = bool(reported_verified and not task_success)

    max_changed = task.get("maxChangedFiles")
    budget_ok = not (max_changed is not None and len(changed_files) > max_changed)

    max_repairs = task.get("maxRepairs", 1)
    repairs_used = max(len(manifest.get("attempts") or []) - 1, 0)
    if repairs_used > max_repairs:
        budget_ok = False

    result.update(
        taskSuccess=task_success,
        problems=problems,
        falseVerified=false_verified,
        budgetAdherence=budget_ok,
        honestyChecks=honesty_check(manifest, events),
        reportedState=state,
        changedFiles=changed_files,
        repairsUsed=repairs_used,
    )
    return result


# ---------------------------------------------------------------------------
# Suite runner + output
# ---------------------------------------------------------------------------

def run_suite(suite: dict, *, only_id=None, v2_path: Path, engineer_path: Path,
              python_exe: str, timeout: int, live: bool = False, model_url: str | None = None) -> list:
    tasks = suite["tasks"]
    if only_id:
        tasks = [t for t in tasks if t["id"] == only_id]
        if not tasks:
            raise SystemExit(f"No task with id {only_id!r} in suite")
        if tasks[0].get("live") and not live:
            raise SystemExit(
                f"Task {only_id!r} is live-only (\"live\": true, no deterministic stub) "
                "-- pass --live to run it"
            )
    elif not live:
        # Follow-up 3: "live": true tasks have no stub script to run in the
        # default/stub mode -- silently skipped here, not scored as a
        # failure, exactly the "skipped in stub mode" the schema comment
        # promises. They only appear in results under --live.
        tasks = [t for t in tasks if not t.get("live")]

    results = []
    with tempfile.TemporaryDirectory(prefix="glimmer-eval-") as tmp:
        tmp_root = Path(tmp)
        for task in tasks:
            tag = " [live]" if live else ""
            print(f"[glimmer-eval] running {task['id']} ({task['category']}){tag} ...", flush=True)
            try:
                ws, manifest, events, run_error, stub_metrics = run_task(
                    task, tmp_root, v2_path=v2_path, engineer_path=engineer_path,
                    python_exe=python_exe, timeout=timeout, live=live, model_url=model_url,
                )
                r = score_task(task, ws, manifest, events, run_error=run_error, stub_metrics=stub_metrics)
            except Exception as exc:  # noqa: BLE001 - one bad task must not abort the suite
                r = score_task(task, tmp_root, {}, [], run_error=f"{type(exc).__name__}: {exc}")
            results.append(r)
            print(f"    -> taskSuccess={r['taskSuccess']} falseVerified={r['falseVerified']} "
                  f"budgetAdherence={r['budgetAdherence']} honestyChecks={r['honestyChecks']}", flush=True)
    return results


def write_results(results: list, suite_version: str, *, mode: str = "stub", model_info: dict | None = None) -> tuple:
    """Follow-up 3: `mode` ("live"|"stub") is stamped on every results doc
    this writes -- one run is always one mode (run_suite never mixes stub
    and live tasks in a single call), so there is nothing to silently mix;
    a caller wanting both just gets two separate files/timestamps, which is
    the "or separate files" half of the requirement. `model_info` (modelId/
    temperature/url from probe_model_server) is recorded only for live
    runs, honestly "Unavailable" per-field rather than omitted when the
    server didn't answer."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    aggregates = {
        "total": len(results),
        "taskSuccess": sum(1 for r in results if r["taskSuccess"]),
        "falseVerified": sum(1 for r in results if r["falseVerified"]),
        "budgetViolations": sum(1 for r in results if not r["budgetAdherence"]),
        "honestyFailures": sum(1 for r in results if r["honestyChecks"] == "FAIL"),
        "byCategory": {
            c: {
                "total": sum(1 for r in results if r["category"] == c),
                "taskSuccess": sum(1 for r in results if r["category"] == c and r["taskSuccess"]),
            }
            for c in CATEGORIES
        },
    }
    doc = {"suiteVersion": suite_version, "generatedAt": ts, "mode": mode, "results": results, "aggregates": aggregates}
    if model_info is not None:
        doc["model"] = model_info

    json_path = OUT_DIR / f"{ts}.json"
    json_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")

    model_line = ""
    if model_info is not None:
        model_line = (
            f"- Model: modelId={model_info.get('modelId')} "
            f"temperature={model_info.get('temperature')} url={model_info.get('url')}\n"
        )
    lines = [
        f"# Glimmer eval results ({ts})", "",
        f"Suite version: {suite_version} -- mode: {mode}", "",
        model_line.rstrip("\n"),
        f"- Total tasks: {aggregates['total']}",
        f"- Task success: {aggregates['taskSuccess']}/{aggregates['total']}",
        f"- False-VERIFIED (honesty violation): {aggregates['falseVerified']}",
        f"- Budget violations: {aggregates['budgetViolations']}",
        f"- Honesty check failures: {aggregates['honestyFailures']}", "",
        "| id | category | success | falseVerified | budget | honesty | tool calls | turns | wall (s) | problems |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        problems = "; ".join(r.get("problems") or []) or "-"
        m = r.get("metrics") or {}
        lines.append(
            f"| {r['id']} | {r['category']} | {r['taskSuccess']} | {r['falseVerified']} | "
            f"{r['budgetAdherence']} | {r['honestyChecks']} | {m.get('toolCalls')} | "
            f"{m.get('turns')} | {m.get('wallSeconds')} | {problems} |"
        )
    md_path = OUT_DIR / f"{ts}.md"
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    return json_path, md_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

SMOKE_TASK_ID = "create-hello-module"  # cheap, single write_file -- see --live-smoke


def main() -> int:
    ap = argparse.ArgumentParser(description="Muse Glimmer evaluation harness (V7 O5/§39)")
    ap.add_argument("--suite", default=str(DEFAULT_SUITE), help="Path to eval-tasks.json")
    ap.add_argument("--task", default=None, help="Run a single task by id")
    ap.add_argument("--v2", default=str(DEFAULT_V2))
    ap.add_argument("--engineer", default=str(DEFAULT_ENGINEER))
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--timeout", type=int, default=None,
                     help="Per-task subprocess wall-clock timeout (s); default 90 (stub) / 600 (--live)")
    ap.add_argument("--suite-validate", action="store_true")
    ap.add_argument("--selfcheck", action="store_true", help="Stub-only deterministic pipeline check; never live")
    ap.add_argument("--live", action="store_true",
                     help="Run selected tasks against a real model server instead of the stub")
    ap.add_argument("--live-smoke", action="store_true",
                     help="Run ONE cheap task live if a model server is reachable; NOT_RUN (exit 0) if not")
    ap.add_argument("--model-url", default=None,
                     help=f"Live model server base URL (default: $GLIMMER_URL or {DEFAULT_MODEL_URL})")
    ap.add_argument("--model-api-key-file", default=str(DEFAULT_MODEL_API_KEY_FILE))
    args = ap.parse_args()

    live_mode = args.live or args.live_smoke
    timeout = args.timeout if args.timeout is not None else (600 if live_mode else 90)
    model_url = args.model_url or DEFAULT_MODEL_URL
    model_api_key_file = Path(args.model_api_key_file)

    # Item 4: a report must never mix live and stub results silently.
    # --selfcheck is stub-only by construction (item 3: never auto-run
    # live in --selfcheck) -- refuse the combination outright rather than
    # quietly ignoring one flag.
    if args.selfcheck and live_mode:
        print("Refusing: --selfcheck is stub-only and must not be combined with --live/--live-smoke.")
        return 1
    if args.live and args.live_smoke:
        print("Pass either --live or --live-smoke, not both.")
        return 1

    suite_path = Path(args.suite)
    suite = json.loads(suite_path.read_text(encoding="utf-8"))
    errors = validate_suite(suite)

    if args.suite_validate:
        if errors:
            print("SUITE INVALID:")
            for e in errors:
                print(f"  - {e}")
            return 1
        print(f"SUITE VALID: {len(suite['tasks'])} tasks, suiteVersion={suite.get('suiteVersion')}")
        return 0

    if errors:
        print("SUITE INVALID (fix eval-tasks.json or pass --suite-validate to see all errors):")
        for e in errors:
            print(f"  - {e}")
        return 1

    v2_path, engineer_path = Path(args.v2), Path(args.engineer)

    if args.live_smoke:
        probe = probe_model_server(model_url, model_api_key_file)
        if not probe["reachable"]:
            print(f"LIVE-SMOKE NOT_RUN: model server unreachable at {model_url} ({probe['error']})")
            return 0
        if not any(t["id"] == SMOKE_TASK_ID for t in suite["tasks"]):
            print(f"LIVE-SMOKE NOT_RUN: smoke task {SMOKE_TASK_ID!r} not found in suite")
            return 0
        print(f"[glimmer-eval] live-smoke: server reachable at {model_url} "
              f"(modelId={probe['modelId']}, temperature={probe['temperature']})")
        results = run_suite(suite, only_id=SMOKE_TASK_ID, v2_path=v2_path, engineer_path=engineer_path,
                             python_exe=args.python, timeout=timeout, live=True, model_url=model_url)
        json_path, md_path = write_results(results, suite.get("suiteVersion", SUITE_VERSION),
                                            mode="live", model_info=probe)
        print(f"[glimmer-eval] wrote {json_path}")
        print(f"[glimmer-eval] wrote {md_path}")
        r = results[0]
        ok = (r["taskSuccess"] and not r["falseVerified"]
              and r.get("budgetAdherence", True) and r.get("honestyChecks") != "FAIL")
        print(f"LIVE-SMOKE {'PASS' if ok else 'FAIL'}: {SMOKE_TASK_ID} taskSuccess={r['taskSuccess']} "
              f"falseVerified={r['falseVerified']} budgetAdherence={r['budgetAdherence']} "
              f"honestyChecks={r['honestyChecks']} problems={r.get('problems')}")
        return 0 if ok else 1

    if args.selfcheck:
        # Round 9 review (M2): the real corpus glimmer-metrics.py scans by
        # default is ~/.muse-glimmer/sessions -- before GLIMMER_STATE_ROOT
        # isolation, every task run here wrote a real session dir straight
        # into it. Snapshot it before/after and assert nothing changed; this
        # is the honesty check the whole point of the isolation fix hinges
        # on, not just "run_task passes an env var".
        real_sessions_dir = Path.home() / ".muse-glimmer" / "sessions"
        before = set(real_sessions_dir.iterdir()) if real_sessions_dir.is_dir() else set()

        results = run_suite(suite, v2_path=v2_path, engineer_path=engineer_path,
                             python_exe=args.python, timeout=timeout)
        tasks_by_id = {t["id"]: t for t in suite["tasks"]}
        ok = True
        for r in results:
            expected_outcome = tasks_by_id[r["id"]].get("expectedOutcome") or {}
            for key, want in expected_outcome.items():
                got = r.get(key)
                if got != want:
                    ok = False
                    print(f"SELFCHECK MISMATCH [{r['id']}]: {key} expected {want!r}, got {got!r}")

        after = set(real_sessions_dir.iterdir()) if real_sessions_dir.is_dir() else set()
        if after != before:
            ok = False
            print(f"SELFCHECK MISMATCH: real corpus {real_sessions_dir} changed during the run "
                  f"({len(after - before)} new dir(s)) -- GLIMMER_STATE_ROOT isolation is broken")

        json_path, md_path = write_results(results, suite.get("suiteVersion", SUITE_VERSION), mode="stub")
        print(f"[glimmer-eval] wrote {json_path}")
        print(f"[glimmer-eval] wrote {md_path}")
        print("SELFCHECK " + ("PASS" if ok else "FAIL"))
        return 0 if ok else 1

    model_info = None
    if args.live:
        model_info = probe_model_server(model_url, model_api_key_file)
        if not model_info["reachable"]:
            print(f"LIVE RUN ABORTED: model server unreachable at {model_url} ({model_info['error']})")
            return 1
        print(f"[glimmer-eval] live: server reachable at {model_url} "
              f"(modelId={model_info['modelId']}, temperature={model_info['temperature']})")

    results = run_suite(suite, only_id=args.task, v2_path=v2_path, engineer_path=engineer_path,
                         python_exe=args.python, timeout=timeout, live=args.live, model_url=model_url)
    json_path, md_path = write_results(results, suite.get("suiteVersion", SUITE_VERSION),
                                        mode="live" if args.live else "stub", model_info=model_info)
    print(f"[glimmer-eval] wrote {json_path}")
    print(f"[glimmer-eval] wrote {md_path}")
    # Exit code covers ALL four score legs -- a CI gate on this exit code
    # must not pass a run carrying a budget or honesty violation.
    all_clean = all(
        r["taskSuccess"]
        and not r["falseVerified"]
        and r.get("budgetAdherence", True)
        and r.get("honestyChecks") != "FAIL"
        for r in results
    )
    return 0 if all_clean else 1


if __name__ == "__main__":
    raise SystemExit(main())
