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
NODE_OPTIONS_DEFAULT = "--max-old-space-size=12288"
READINESS_URL_DEFAULT = os.environ.get("GLIMMER_TOOLS_URL", "http://127.0.0.1:8080/tools")

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
    port). Mirrors that TS logic exactly as it stands today, INCLUDING a
    known gap: the TS prefix match is a plain `p.startsWith(prefix)`, not
    boundary-safe (`frontend/src/dialog` would match `frontend/src/dialog-old`).
    An earlier draft of this task's brief believed that had already been
    hardened; re-reading repoAnalysis.ts and its test file (repoAnalysis.test.ts)
    for this task confirmed it has NOT — no boundary-safe test exists, and the
    implementation is plain startsWith. Per this task's own instructions, the
    real TS is the source of truth over the brief's aspirational snippet, so
    this port intentionally preserves the TS's real (imperfect) behavior
    rather than silently diverging from the reference it's ported from. See
    task-6a-report.md for the follow-up recommendation."""
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
    expanded = [p for p in actual if not any(p.startswith(prefix) for prefix in expected)]
    return {"inScope": len(expanded) == 0, "expected": expected, "actual": actual, "expandedFiles": expanded}


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


def build_repo_map(ws):
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
        if path.name in {"package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"}:
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

            if result["status"] == "CODE_FAIL":
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


def make_prompt(contract, summary, iteration, failure=None, checkpoint_sha=None):
    # R2: the contract dict (same shape as manifest["contract"]) is the sole
    # source of truth for scope/mode/constraints — derive the human-readable
    # OPERATING CONTRACT lines below FROM it rather than maintaining separate
    # hardcoded prose that can drift out of sync with the CLI flags.
    task = contract["objective"]
    scope = contract["scope"]
    constraints = contract["constraints"]

    scope_bits = [f"package={scope['package']}"]
    if scope.get("area"):
        scope_bits.append(f"area={scope['area']}")
    if scope.get("paths"):
        scope_bits.append(f"paths={scope['paths']}")
    scope_text = ", ".join(scope_bits)

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
    """).strip()


def invoke_engineer(engineer, ws, prompt, auto_approve, max_turns, log_path, events_path, session_id):
    cmd = [str(engineer), "--workspace", str(ws)]
    if max_turns is not None:
        cmd += ["--max-turns", str(max_turns)]
    if auto_approve:
        cmd.append("--yes")
    cmd.append(prompt)
    print("\n[V2] Launching existing glimmer-engineer.py...")
    env = os.environ.copy()
    env["GLIMMER_EVENTS_PATH"] = str(events_path)
    env["GLIMMER_SESSION_ID"] = session_id
    with log_path.open("w", encoding="utf-8") as log:
        p = subprocess.Popen(cmd, cwd=str(ws), text=True, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, env=env, bufsize=1)
        assert p.stdout is not None
        for line in p.stdout:
            sys.stdout.write(line)
            log.write(line)
        return p.wait()


def main():
    ap = argparse.ArgumentParser(description="Muse Glimmer Engineering Mode v2.1")
    ap.add_argument("task", nargs="+")
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--engineer", default=str(ENGINEER_DEFAULT))
    ap.add_argument("--max-repairs", type=int, default=2)
    ap.add_argument("--verification-level", choices=("minimal", "standard", "full"), default="standard")
    ap.add_argument("--verify", action="append", default=[])
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

        for iteration in range(args.max_repairs + 1):
            if iteration > 0:
                emit_event(events_path, "repair_started", sid, iteration=iteration)
            prompt = make_prompt(contract, summary, iteration, failure, checkpoint_sha)
            (session / f"prompt-{iteration:02d}.txt").write_text(prompt, encoding="utf-8")
            rc = invoke_engineer(engineer, ws, prompt, args.auto_approve, args.max_turns,
                                 session / f"engineer-{iteration:02d}.log", events_path, sid)
            files = changed_files(ws, baseline)
            change_types = file_change_types(ws, baseline)
            for f in files:
                emit_event(events_path, "file_changed", sid, path=f,
                           changeType=change_types.get(f, "modified"))
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
                for raw in args.verify:
                    cmd = shlex.split(raw)
                    if cmd and cmd not in commands:
                        commands.append(cmd)
                if args.verify:
                    ok, results = verify(ws, commands, args.timeout, session, iteration,
                                         repo, source_root, baseline, args.toolchain_mode,
                                         events_path, sid)
                    attempt["verificationCommands"] = [shlex.join(c) for c in commands]
                    attempt["verificationResults"] = results
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

            commands = verifier_commands(repo, files, args.verification_level)
            for raw in args.verify:
                cmd = shlex.split(raw)
                if cmd and cmd not in commands:
                    commands.append(cmd)
            attempt["verificationCommands"] = [shlex.join(c) for c in commands]

            before = diff_hash(ws, baseline)
            ok, results = verify(ws, commands, args.timeout, session, iteration,
                                 repo, source_root, baseline, args.toolchain_mode,
                                 events_path, sid)
            after = diff_hash(ws, baseline)
            attempt["verificationResults"] = results
            attempt["diffHashAfterVerify"] = after
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


if __name__ == "__main__":
    if sys.argv[1:] == ["--r6-selfcheck"]:
        _r6_selfcheck()
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
