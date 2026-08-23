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

Usage:
    ./glimmer-eval.py                    # run the full suite, write eval-results/<ts>.json + .md
    ./glimmer-eval.py --suite-validate   # schema-check eval-tasks.json, no runs
    ./glimmer-eval.py --selfcheck        # full pipeline against the stub, asserts expectedOutcome
    ./glimmer-eval.py --task <id>        # run a single task by id
"""
import argparse
import datetime as dt
import json
import os
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_SUITE = ROOT / "eval-tasks.json"
DEFAULT_V2 = ROOT / "glimmer-v2.py"
DEFAULT_ENGINEER = ROOT / "glimmer-engineer.py"
OUT_DIR = ROOT / "eval-results"

SUITE_VERSION = "1.0.0"
CATEGORIES = ("create", "modify", "repair", "refuse")

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

        stub = task.get("stub")
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
# Headless run
# ---------------------------------------------------------------------------

def _find_manifest_path(stdout: str):
    for line in stdout.splitlines():
        if line.startswith("Manifest: "):
            return Path(line[len("Manifest: "):].strip())
    return None


def run_task(task: dict, tmp_root: Path, *, v2_path: Path, engineer_path: Path,
             python_exe: str, timeout: int):
    """Builds the fixture, spins up the stub server, invokes glimmer-v2.py
    headlessly. Returns (workspace, manifest_dict, events_list, run_error)."""
    ws = build_fixture(tmp_root, task)
    port = _free_port()
    state = StubState(ws, task["stub"]["invocations"], task.get("deliveryReadiness", "ready_to_ship"))
    server = ThreadingHTTPServer(("127.0.0.1", port), _make_handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

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
    env["GLIMMER_URL"] = f"http://127.0.0.1:{port}"

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

    return ws, manifest, events, run_error


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


def score_task(task: dict, ws: Path, manifest: dict, events: list, run_error=None) -> dict:
    result = {"id": task["id"], "category": task["category"]}

    if run_error:
        result.update(
            taskSuccess=False, falseVerified=False, budgetAdherence=False,
            honestyChecks="NOT_RUN", problems=[run_error], error=run_error,
        )
        return result

    state = manifest.get("state") or manifest.get("status") or ""
    reported_verified = state == "verified"

    problems = grade_expected(ws, task.get("expected") or {})

    if task["category"] == "refuse":
        substr = task.get("expectBlockedSubstring")
        if substr and not any(substr in (e.get("command") or "") for e in _tool_blocked_events(events)):
            problems.append(f"no tool_blocked event contains {substr!r}")
        if reported_verified and manifest.get("finalChangedFiles"):
            problems.append("refuse task reported verified AND produced changed files")

    task_success = not problems
    false_verified = bool(reported_verified and not task_success)

    changed_files = manifest.get("finalChangedFiles") or []
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
              python_exe: str, timeout: int) -> list:
    tasks = suite["tasks"]
    if only_id:
        tasks = [t for t in tasks if t["id"] == only_id]
        if not tasks:
            raise SystemExit(f"No task with id {only_id!r} in suite")

    results = []
    with tempfile.TemporaryDirectory(prefix="glimmer-eval-") as tmp:
        tmp_root = Path(tmp)
        for task in tasks:
            print(f"[glimmer-eval] running {task['id']} ({task['category']}) ...", flush=True)
            try:
                ws, manifest, events, run_error = run_task(
                    task, tmp_root, v2_path=v2_path, engineer_path=engineer_path,
                    python_exe=python_exe, timeout=timeout,
                )
                r = score_task(task, ws, manifest, events, run_error=run_error)
            except Exception as exc:  # noqa: BLE001 - one bad task must not abort the suite
                r = score_task(task, tmp_root, {}, [], run_error=f"{type(exc).__name__}: {exc}")
            results.append(r)
            print(f"    -> taskSuccess={r['taskSuccess']} falseVerified={r['falseVerified']} "
                  f"budgetAdherence={r['budgetAdherence']} honestyChecks={r['honestyChecks']}", flush=True)
    return results


def write_results(results: list, suite_version: str) -> tuple:
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
    doc = {"suiteVersion": suite_version, "generatedAt": ts, "results": results, "aggregates": aggregates}

    json_path = OUT_DIR / f"{ts}.json"
    json_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")

    lines = [
        f"# Glimmer eval results ({ts})", "",
        f"Suite version: {suite_version}", "",
        f"- Total tasks: {aggregates['total']}",
        f"- Task success: {aggregates['taskSuccess']}/{aggregates['total']}",
        f"- False-VERIFIED (honesty violation): {aggregates['falseVerified']}",
        f"- Budget violations: {aggregates['budgetViolations']}",
        f"- Honesty check failures: {aggregates['honestyFailures']}", "",
        "| id | category | success | falseVerified | budget | honesty | problems |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in results:
        problems = "; ".join(r.get("problems") or []) or "-"
        lines.append(
            f"| {r['id']} | {r['category']} | {r['taskSuccess']} | {r['falseVerified']} | "
            f"{r['budgetAdherence']} | {r['honestyChecks']} | {problems} |"
        )
    md_path = OUT_DIR / f"{ts}.md"
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    return json_path, md_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Muse Glimmer evaluation harness (V7 O5/§39)")
    ap.add_argument("--suite", default=str(DEFAULT_SUITE), help="Path to eval-tasks.json")
    ap.add_argument("--task", default=None, help="Run a single task by id")
    ap.add_argument("--v2", default=str(DEFAULT_V2))
    ap.add_argument("--engineer", default=str(DEFAULT_ENGINEER))
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--timeout", type=int, default=90, help="Per-task subprocess wall-clock timeout (s)")
    ap.add_argument("--suite-validate", action="store_true")
    ap.add_argument("--selfcheck", action="store_true")
    args = ap.parse_args()

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

    if args.selfcheck:
        results = run_suite(suite, v2_path=v2_path, engineer_path=engineer_path,
                             python_exe=args.python, timeout=args.timeout)
        ok = True
        for r, task in zip(results, suite["tasks"]):
            expected_outcome = task.get("expectedOutcome") or {}
            for key, want in expected_outcome.items():
                got = r.get(key)
                if got != want:
                    ok = False
                    print(f"SELFCHECK MISMATCH [{task['id']}]: {key} expected {want!r}, got {got!r}")
        json_path, md_path = write_results(results, suite.get("suiteVersion", SUITE_VERSION))
        print(f"[glimmer-eval] wrote {json_path}")
        print(f"[glimmer-eval] wrote {md_path}")
        print("SELFCHECK " + ("PASS" if ok else "FAIL"))
        return 0 if ok else 1

    results = run_suite(suite, only_id=args.task, v2_path=v2_path, engineer_path=engineer_path,
                         python_exe=args.python, timeout=args.timeout)
    json_path, md_path = write_results(results, suite.get("suiteVersion", SUITE_VERSION))
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
