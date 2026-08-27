#!/usr/bin/env python3
"""Crash-safe local progress journal for Muse Glimmer.

The journal deliberately uses only Python's standard library. SQLite in WAL
mode provides transactional boundaries while an atomic, fsync-backed JSON
sidecar exposes a small recovery summary to the TypeScript gateway without
requiring a Node SQLite dependency.

Only API-visible conversation state is stored. Provider credentials and HTTP
headers never enter this module. Session directories and journal files are
private to the current user (0700/0600).
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1
RECOVERY_FILE = "recovery-state.json"
JOURNAL_FILE = "runtime.sqlite3"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fsync_directory(directory: Path) -> None:
    """Persist a rename on POSIX filesystems; best effort on other hosts."""
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        fd = os.open(str(directory), flags)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write_bytes(
    path: Path, data: bytes, mode: int = 0o600, *, private_parent: bool = True
) -> None:
    """Durably replace ``path`` without ever exposing a partially written file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700 if private_parent else 0o755)
    if private_parent:
        try:
            os.chmod(path.parent, 0o700)
        except OSError:
            pass
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb", closefd=True) as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        try:
            os.chmod(path, mode)
        except OSError:
            pass
        _fsync_directory(path.parent)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            temp_path.unlink()
        except OSError:
            pass
        raise


def atomic_write_json(
    path: Path, value, mode: int = 0o600, *, private_parent: bool = True
) -> None:
    encoded = (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    atomic_write_bytes(path, encoded, mode=mode, private_parent=private_parent)


def append_jsonl_durable(path: Path, record) -> None:
    """Append one JSON line and make that line durable before returning."""
    encoded = (json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8")
    fd = os.open(str(path), os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.write(fd, encoded)
        os.fsync(fd)
        try:
            os.fchmod(fd, 0o600)
        except OSError:
            pass
    finally:
        os.close(fd)


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _bounded(value, limit=4000):
    """Bound recovery metadata while retaining its deterministic identity."""
    if isinstance(value, str) and len(value) > limit:
        return {
            "sha256": hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest(),
            "characters": len(value),
            "preview": value[:256],
        }
    if isinstance(value, dict):
        return {str(key): _bounded(item, limit) for key, item in value.items()}
    if isinstance(value, list):
        return [_bounded(item, limit) for item in value[:100]]
    return value


def summarize_tool_arguments(tool: str, arguments) -> dict:
    """Store useful intent metadata without duplicating full write payloads."""
    if not isinstance(arguments, dict):
        if isinstance(arguments, str):
            return {"rawSha256": hashlib.sha256(arguments.encode("utf-8")).hexdigest()}
        return {}
    summary = {}
    for key, value in arguments.items():
        lowered = str(key).lower()
        if tool in {"write_file", "edit_file"} and lowered in {
            "content", "new_content", "old_content", "replacement", "patch"
        }:
            raw = str(value)
            summary[key] = {
                "sha256": hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest(),
                "characters": len(raw),
            }
        else:
            summary[key] = _bounded(value)
    return summary


class DurableJournal:
    """One process-safe writer facade over a per-session SQLite journal."""

    def __init__(self, session_dir: Path, session_id: str, process_name: str = "engineer"):
        self.session_dir = Path(session_dir).resolve()
        self.session_id = session_id
        self.process_name = process_name
        self.path = self.session_dir / JOURNAL_FILE
        self.recovery_path = self.session_dir / RECOVERY_FILE
        self._lock = threading.RLock()
        self._closed = False
        self._last_stream_flush: dict[str, float] = {}
        self._stop_heartbeat = threading.Event()

        self.session_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(self.session_dir, 0o700)
        except OSError:
            pass
        self._db = sqlite3.connect(str(self.path), timeout=10, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.execute("PRAGMA busy_timeout=10000")
        self._db.execute("PRAGMA foreign_keys=ON")
        self._create_schema()
        self._protect_sqlite_files()
        self._state = self._read_recovery_state()
        self._state.update({
            "schemaVersion": SCHEMA_VERSION,
            "sessionId": self.session_id,
            "journal": JOURNAL_FILE,
            "durable": True,
            "process": self.process_name,
            "processState": "running",
            "pid": os.getpid(),
            "updatedAt": utc_now(),
        })
        self._write_recovery_state()
        self.append("process_started", {"pid": os.getpid()})
        self._heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop,
            name=f"glimmer-journal-{self.process_name}",
            daemon=True,
        )
        self._heartbeat_thread.start()

    def _create_schema(self) -> None:
        with self._db:
            self._db.executescript(
                """
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS journal (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    process TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    turn INTEGER,
                    request_id TEXT,
                    call_id TEXT,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS conversation (
                    slot INTEGER PRIMARY KEY CHECK (slot = 1),
                    turn INTEGER NOT NULL,
                    phase TEXT NOT NULL,
                    messages_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS model_streams (
                    request_id TEXT PRIMARY KEY,
                    turn INTEGER,
                    status TEXT NOT NULL,
                    content TEXT NOT NULL,
                    tool_calls_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS tool_calls (
                    call_id TEXT PRIMARY KEY,
                    turn INTEGER,
                    tool TEXT NOT NULL,
                    status TEXT NOT NULL,
                    arguments_json TEXT NOT NULL,
                    result_json TEXT,
                    changed INTEGER NOT NULL DEFAULT 0,
                    snapshot_commit TEXT,
                    updated_at TEXT NOT NULL
                );
                """
            )
            self._db.execute(
                "INSERT OR REPLACE INTO metadata(key, value_json) VALUES (?, ?)",
                ("schemaVersion", _json(SCHEMA_VERSION)),
            )
            self._db.execute(
                "INSERT OR REPLACE INTO metadata(key, value_json) VALUES (?, ?)",
                ("sessionId", _json(self.session_id)),
            )

    def _protect_sqlite_files(self) -> None:
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.path) + suffix)
            if candidate.exists():
                try:
                    os.chmod(candidate, 0o600)
                except OSError:
                    pass

    def _read_recovery_state(self) -> dict:
        try:
            parsed = json.loads(self.recovery_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return parsed if isinstance(parsed, dict) else {}

    def _write_recovery_state(self) -> None:
        atomic_write_json(self.recovery_path, self._state)

    def append(self, kind: str, payload=None, *, turn=None, request_id=None, call_id=None) -> None:
        if self._closed:
            return
        with self._lock, self._db:
            self._db.execute(
                """INSERT INTO journal(timestamp, process, kind, turn, request_id, call_id, payload_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (utc_now(), self.process_name, kind, turn, request_id, call_id, _json(payload or {})),
            )
        self._protect_sqlite_files()

    def _heartbeat_loop(self) -> None:
        while not self._stop_heartbeat.wait(2.0):
            try:
                timestamp = utc_now()
                with self._lock, self._db:
                    self._db.execute(
                        "INSERT OR REPLACE INTO metadata(key, value_json) VALUES (?, ?)",
                        (f"heartbeat:{self.process_name}", _json(timestamp)),
                    )
            except Exception:
                # The foreground operation will surface a real persistence
                # failure at its next required checkpoint. A heartbeat alone
                # must never terminate model/tool execution.
                pass

    def checkpoint_conversation(self, messages, turn: int, phase: str) -> None:
        timestamp = utc_now()
        with self._lock, self._db:
            self._db.execute(
                """INSERT INTO conversation(slot, turn, phase, messages_json, updated_at)
                   VALUES (1, ?, ?, ?, ?)
                   ON CONFLICT(slot) DO UPDATE SET turn=excluded.turn, phase=excluded.phase,
                   messages_json=excluded.messages_json, updated_at=excluded.updated_at""",
                (turn, phase, _json(messages), timestamp),
            )
            self._db.execute(
                """INSERT INTO journal(timestamp, process, kind, turn, payload_json)
                   VALUES (?, ?, 'conversation_checkpointed', ?, ?)""",
                (timestamp, self.process_name, turn, _json({"phase": phase, "messages": len(messages)})),
            )
        self._state.update({
            "phase": phase,
            "turn": turn,
            "lastDurableAt": timestamp,
            "durableMessageCount": len(messages),
            "updatedAt": timestamp,
        })
        self._write_recovery_state()

    def begin_model(self, request_id: str, turn: int) -> None:
        timestamp = utc_now()
        with self._lock, self._db:
            self._db.execute(
                """INSERT OR REPLACE INTO model_streams
                   (request_id, turn, status, content, tool_calls_json, updated_at)
                   VALUES (?, ?, 'streaming', '', '[]', ?)""",
                (request_id, turn, timestamp),
            )
        self.append("model_started", {}, turn=turn, request_id=request_id)
        self._state.update({
            "phase": "model_streaming",
            "turn": turn,
            "activeRequestId": request_id,
            "partialModelCharacters": 0,
            "updatedAt": timestamp,
        })
        self._write_recovery_state()

    def update_model(self, request_id: str, turn: int, content: str, tool_calls, *, force=False) -> None:
        now = time.monotonic()
        last = self._last_stream_flush.get(request_id, 0.0)
        if not force and now - last < 0.25:
            return
        self._last_stream_flush[request_id] = now
        timestamp = utc_now()
        with self._lock, self._db:
            self._db.execute(
                """UPDATE model_streams SET content=?, tool_calls_json=?, updated_at=?
                   WHERE request_id=?""",
                (content, _json(tool_calls or []), timestamp, request_id),
            )
        self._state.update({
            "lastDurableAt": timestamp,
            "partialModelCharacters": len(content),
            "updatedAt": timestamp,
        })
        # Avoid an fsync-heavy JSON rewrite per token chunk. SQLite remains
        # authoritative; the gateway summary advances at most four times/s.
        self._write_recovery_state()

    def complete_model(self, request_id: str, turn: int, message) -> None:
        content = str(message.get("content") or "") if isinstance(message, dict) else ""
        tool_calls = message.get("tool_calls") or [] if isinstance(message, dict) else []
        self.update_model(request_id, turn, content, tool_calls, force=True)
        timestamp = utc_now()
        with self._lock, self._db:
            self._db.execute(
                "UPDATE model_streams SET status='completed', updated_at=? WHERE request_id=?",
                (timestamp, request_id),
            )
        self.append(
            "model_completed",
            {"contentCharacters": len(content), "toolCallCount": len(tool_calls)},
            turn=turn,
            request_id=request_id,
        )
        self._state.update({
            "phase": "model_completed",
            "lastDurableAt": timestamp,
            "activeRequestId": None,
            "partialModelCharacters": len(content),
            "updatedAt": timestamp,
        })
        self._write_recovery_state()

    def fail_model(self, request_id: str, turn: int, error_text: str) -> None:
        timestamp = utc_now()
        with self._lock, self._db:
            self._db.execute(
                "UPDATE model_streams SET status='failed', updated_at=? WHERE request_id=?",
                (timestamp, request_id),
            )
        self.append("model_failed", {"error": str(error_text)[:1000]}, turn=turn, request_id=request_id)
        self._state.update({
            "phase": "model_failed",
            "activeRequestId": None,
            "lastDurableAt": timestamp,
            "updatedAt": timestamp,
        })
        self._write_recovery_state()

    def begin_tool(self, call_id: str, turn: int, tool: str, arguments) -> None:
        timestamp = utc_now()
        summary = summarize_tool_arguments(tool, arguments)
        with self._lock, self._db:
            self._db.execute(
                """INSERT OR REPLACE INTO tool_calls
                   (call_id, turn, tool, status, arguments_json, updated_at)
                   VALUES (?, ?, ?, 'started', ?, ?)""",
                (call_id, turn, tool, _json(summary), timestamp),
            )
        self.append("tool_started", {"tool": tool}, turn=turn, call_id=call_id)
        pending = {"callId": call_id, "tool": tool}
        if isinstance(summary.get("path"), str):
            pending["path"] = summary["path"]
        self._state.update({
            "phase": "tool_running",
            "turn": turn,
            "pendingTool": pending,
            "lastDurableAt": timestamp,
            "updatedAt": timestamp,
        })
        self._write_recovery_state()

    def complete_tool(
        self,
        call_id: str,
        turn: int,
        tool: str,
        result,
        *,
        changed=False,
        snapshot=None,
    ) -> None:
        timestamp = utc_now()
        result_summary = _bounded(str(result), 4000)
        snapshot_commit = snapshot.get("commit") if isinstance(snapshot, dict) else None
        with self._lock, self._db:
            self._db.execute(
                """UPDATE tool_calls SET status='completed', result_json=?, changed=?,
                   snapshot_commit=?, updated_at=? WHERE call_id=?""",
                (_json(result_summary), int(bool(changed)), snapshot_commit, timestamp, call_id),
            )
        self.append(
            "tool_completed",
            {"tool": tool, "changed": bool(changed), "snapshotCommit": snapshot_commit},
            turn=turn,
            call_id=call_id,
        )
        self._state.update({
            "phase": "tool_completed",
            "pendingTool": None,
            "lastDurableAt": timestamp,
            "updatedAt": timestamp,
        })
        if snapshot:
            self._state["snapshot"] = snapshot
        self._write_recovery_state()

    def snapshot_worktree(self, workspace: Path, baseline: str, turn: int, call_id: str) -> dict:
        """Create a recovery commit without moving HEAD or the user's index."""
        workspace = Path(workspace).resolve()
        index_path = self.session_dir / "worktree-checkpoint.index"
        env = os.environ.copy()
        env["GIT_INDEX_FILE"] = str(index_path)
        env.update({
            "GIT_AUTHOR_NAME": "Muse Glimmer Recovery",
            "GIT_AUTHOR_EMAIL": "glimmer-recovery@localhost",
            "GIT_COMMITTER_NAME": "Muse Glimmer Recovery",
            "GIT_COMMITTER_EMAIL": "glimmer-recovery@localhost",
        })

        def git(*args):
            completed = subprocess.run(
                ["git", *args], cwd=workspace, env=env, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            if completed.returncode != 0:
                raise RuntimeError((completed.stderr or completed.stdout)[-2000:])
            return completed.stdout.strip()

        if not index_path.exists():
            git("read-tree", baseline)
        git("add", "-A", "--", ".")
        tree = git("write-tree")
        commit = git(
            "commit-tree", tree, "-p", baseline,
            "-m", f"glimmer recovery snapshot {self.session_id} turn {turn} call {call_id}",
        )
        # A raw commit-tree object is eventually pruned by git gc. Anchor the
        # newest snapshot under a non-branch private ref so it remains
        # recoverable without moving HEAD or exposing it as a normal branch.
        ref_name = (
            "refs/glimmer-recovery/"
            + hashlib.sha256(self.session_id.encode("utf-8", errors="replace")).hexdigest()[:20]
        )
        git("update-ref", ref_name, commit)
        changed_output = git("diff-tree", "--no-commit-id", "--name-only", "-r", commit)
        changed_files = [line for line in changed_output.splitlines() if line.strip()]
        snapshot = {
            "commit": commit,
            "ref": ref_name,
            "tree": tree,
            "baseline": baseline,
            "turn": turn,
            "callId": call_id,
            "changedFiles": changed_files,
            "createdAt": utc_now(),
            "headMoved": False,
        }
        self.append("worktree_snapshotted", snapshot, turn=turn, call_id=call_id)
        return snapshot

    def close(self, final_phase="stopped") -> None:
        self._stop_heartbeat.set()
        if (
            hasattr(self, "_heartbeat_thread")
            and threading.current_thread() is not self._heartbeat_thread
        ):
            self._heartbeat_thread.join(timeout=3)
        with self._lock:
            if self._closed:
                return
            try:
                self.append("process_stopped", {"phase": final_phase})
                self._state.update({
                    "phase": final_phase,
                    "processState": "stopped",
                    "pendingTool": None,
                    "activeRequestId": None,
                    "lastDurableAt": utc_now(),
                    "updatedAt": utc_now(),
                })
                self._write_recovery_state()
                self._db.execute("PRAGMA wal_checkpoint(FULL)")
                self._db.commit()
            finally:
                self._closed = True
                self._db.close()

    def latest_conversation(self):
        with self._lock:
            row = self._db.execute(
                "SELECT turn, phase, messages_json, updated_at FROM conversation WHERE slot=1"
            ).fetchone()
        if row is None:
            return None
        return {"turn": row[0], "phase": row[1], "messages": json.loads(row[2]), "updatedAt": row[3]}


def _selfcheck() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        session = root / "session"
        journal = DurableJournal(session, "selfcheck")
        messages = [{"role": "user", "content": "durable"}]
        journal.checkpoint_conversation(messages, 0, "initial")
        journal.begin_model("req-1", 0)
        journal.update_model("req-1", 0, "partial", [], force=True)
        journal.begin_tool("call-1", 0, "write_file", {"path": "x.txt", "content": "secret-ish"})

        db = sqlite3.connect(str(session / JOURNAL_FILE))
        model_row = db.execute(
            "SELECT status, content FROM model_streams WHERE request_id='req-1'"
        ).fetchone()
        tool_row = db.execute(
            "SELECT status, arguments_json FROM tool_calls WHERE call_id='call-1'"
        ).fetchone()
        db.close()
        assert model_row == ("streaming", "partial")
        assert tool_row[0] == "started" and "secret-ish" not in tool_row[1]
        assert journal.latest_conversation()["messages"] == messages
        assert (session.stat().st_mode & 0o077) == 0
        assert ((session / JOURNAL_FILE).stat().st_mode & 0o077) == 0

        workspace = root / "repo"
        workspace.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
        (workspace / "x.txt").write_text("base\n", encoding="utf-8")
        subprocess.run(["git", "add", "x.txt"], cwd=workspace, check=True)
        subprocess.run(
            ["git", "-c", "user.name=test", "-c", "user.email=t@t", "commit", "-q", "-m", "base"],
            cwd=workspace, check=True,
        )
        baseline = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=workspace, text=True).strip()
        original_index = (workspace / ".git" / "index").read_bytes()
        (workspace / "x.txt").write_text("changed\n", encoding="utf-8")
        snapshot = journal.snapshot_worktree(workspace, baseline, 0, "call-1")
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=workspace, text=True).strip()
        assert head == baseline and snapshot["commit"] != baseline
        anchored = subprocess.check_output(
            ["git", "rev-parse", snapshot["ref"]], cwd=workspace, text=True
        ).strip()
        assert anchored == snapshot["commit"]
        assert (workspace / ".git" / "index").read_bytes() == original_index
        snap_content = subprocess.check_output(
            ["git", "show", f"{snapshot['commit']}:x.txt"], cwd=workspace, text=True,
        )
        assert snap_content == "changed\n"

        journal.complete_tool("call-1", 0, "write_file", "ok", changed=True, snapshot=snapshot)
        journal.complete_model("req-1", 0, {"content": "complete", "tool_calls": []})
        journal.close("completed")
        state = json.loads((session / RECOVERY_FILE).read_text(encoding="utf-8"))
        assert state["phase"] == "completed" and state["snapshot"]["commit"] == snapshot["commit"]
        assert state["pendingTool"] is None

        target = root / "atomic.json"
        atomic_write_json(target, {"version": 1})
        assert json.loads(target.read_text(encoding="utf-8")) == {"version": 1}
        assert (target.stat().st_mode & 0o077) == 0
        public_dir = root / "repository-docs"
        public_dir.mkdir(mode=0o755)
        public_target = public_dir / "graph.json"
        atomic_write_json(
            public_target, {"nodes": []}, mode=0o644, private_parent=False
        )
        assert (public_dir.stat().st_mode & 0o777) == 0o755
        assert (public_target.stat().st_mode & 0o777) == 0o644

        # A real SIGKILL bypasses finally/atexit. Every boundary committed
        # before the signal must still reopen cleanly, with the in-flight
        # model/tool explicitly distinguishable from completed work.
        crash_session = root / "crash-session"
        import sys

        child = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--crash-writer", str(crash_session)],
            text=True,
            stdout=subprocess.PIPE,
        )
        assert child.stdout is not None and child.stdout.readline().strip() == "READY"
        child.kill()
        child.wait(timeout=5)
        crash_db = sqlite3.connect(str(crash_session / JOURNAL_FILE))
        assert crash_db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        assert crash_db.execute(
            "SELECT status, content FROM model_streams WHERE request_id='crash-request'"
        ).fetchone() == ("streaming", "durable partial")
        assert crash_db.execute(
            "SELECT status FROM tool_calls WHERE call_id='crash-call'"
        ).fetchone()[0] == "started"
        crash_db.close()
        crash_state = json.loads((crash_session / RECOVERY_FILE).read_text(encoding="utf-8"))
        assert crash_state["pendingTool"]["callId"] == "crash-call"
        assert crash_state["processState"] == "running", "SIGKILL must remain detectable as stale"

    print("durable journal self-check: PASS")


if __name__ == "__main__":
    import sys

    if sys.argv[1:] == ["--selfcheck"]:
        _selfcheck()
    elif len(sys.argv) == 3 and sys.argv[1] == "--crash-writer":
        crash_journal = DurableJournal(Path(sys.argv[2]), "crash-selfcheck")
        crash_journal.checkpoint_conversation(
            [{"role": "user", "content": "crash-safe"}], 0, "initial"
        )
        crash_journal.begin_model("crash-request", 0)
        crash_journal.update_model(
            "crash-request", 0, "durable partial", [], force=True
        )
        crash_journal.begin_tool(
            "crash-call", 0, "edit_file", {"path": "src/app.ts", "content": "private"}
        )
        print("READY", flush=True)
        time.sleep(30)
    else:
        raise SystemExit("usage: glimmer_journal.py --selfcheck")
