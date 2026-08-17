#!/usr/bin/env python3
"""Shared append-only JSONL event emitter for glimmer-v2.py and glimmer-engineer.py.

Two processes append to the same file (v2 is the parent, engineer is a
subprocess it spawns) — every write is a single O_APPEND write() of one
complete JSON line, so concurrent appends interleave at line granularity,
never mid-line. This is the only correctness property that matters here;
there is no lock, because POSIX guarantees that a single write() to a
regular local file opened with O_APPEND is atomic with respect to the file
offset even under concurrent writers (the implicit seek-to-end-of-file and
the write happen as one indivisible operation, so concurrent writers can
never interleave mid-write or clobber each other's bytes) — a property of
O_APPEND on regular files, distinct from (and not to be confused with)
PIPE_BUF, which is a separate POSIX guarantee about atomic writes to pipes.
"""
import json
import os
import uuid
from datetime import datetime, timezone

EVENT_TYPES = {
    "tool_started", "tool_completed", "tool_blocked", "file_changed",
    "verification_started", "verification_completed", "agent_state_changed",
    "candidate_selected", "scope_expanded", "repair_started",
    "parser_recovery", "session_completed",
}


def emit(events_path: str, event_type: str, session_id: str, **fields) -> None:
    """Append one event line. Never raises on a fields bug — a malformed
    event must not crash the trusted orchestrator or the engineer loop; log
    to stderr and drop instead."""
    if event_type not in EVENT_TYPES:
        print(f"[glimmer_events] unknown event type {event_type!r}, dropping", flush=True)
        return
    try:
        record = {
            "id": f"{session_id}-{uuid.uuid4().hex[:12]}",
            "sessionId": session_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "type": event_type,
            **fields,
        }
        line = json.dumps(record, ensure_ascii=False) + "\n"
        # O_APPEND write() atomicity is the guarantee described in the module docstring.
        fd = os.open(events_path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o644)
        try:
            os.write(fd, line.encode("utf-8"))
        finally:
            os.close(fd)
    except Exception as exc:  # noqa: BLE001 - deliberate: event emission must never break the session
        print(f"[glimmer_events] failed to emit {event_type!r}: {exc}", flush=True)


def _selfcheck() -> None:
    import tempfile
    import concurrent.futures

    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "events.jsonl")

        # 1. Basic shape.
        emit(path, "tool_started", "s1", tool="read_file", args={"path": "x.py"})
        with open(path) as f:
            lines = f.readlines()
        assert len(lines) == 1
        rec = json.loads(lines[0])
        assert rec["type"] == "tool_started" and rec["sessionId"] == "s1"
        assert rec["tool"] == "read_file"
        assert "id" in rec and "timestamp" in rec

        # 2. Unknown type is dropped, not written.
        emit(path, "not_a_real_type", "s1")
        with open(path) as f:
            assert len(f.readlines()) == 1, "unknown event type must not be written"

        # 3. Concurrent appends from multiple threads: every line must be
        # complete, valid JSON — the property O_APPEND is supposed to buy us.
        def _writer(i):
            emit(path, "file_changed", "s1", path=f"file{i}.py", changeType="modified")

        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as ex:
            list(ex.map(_writer, range(200)))

        with open(path) as f:
            all_lines = f.readlines()
        assert len(all_lines) == 1 + 200, f"expected 201 lines, got {len(all_lines)}"
        seen_ids = set()
        for line in all_lines:
            rec = json.loads(line)  # raises if a line is torn/interleaved
            assert rec["id"] not in seen_ids, "duplicate/colliding event id"
            seen_ids.add(rec["id"])

        print("glimmer_events self-check: PASS (3/3)")


if __name__ == "__main__":
    _selfcheck()
