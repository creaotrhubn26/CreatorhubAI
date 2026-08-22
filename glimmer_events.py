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
    # V7 event vocabulary expansion (Task 1.2 — §5.14, §22.15, task events,
    # §23.13). "architect_replan_started" has no emit site yet: no replan
    # path exists in glimmer-v2.py today (see run_architect_review), so the
    # type is defined here for Round 5 to wire up, not emitted anywhere.
    "session_created", "skill_loaded", "model_retry", "context_selected",
    "architect_planning_started", "architect_plan_created",
    "architect_review_requested", "architect_review_completed",
    "architect_replan_started",
    # Task 2.1 (V7 §5.5): emitted by glimmer-v2.py main() only when the
    # deterministic risk score (compute_architect_risk) crosses
    # ARCHITECT_RISK_THRESHOLD and --no-architect was not passed.
    "architect_autotriggered",
    "task_created", "task_status_changed", "task_list_completed",
    "visual_verification_started", "visual_finding_detected",
    "visual_verification_completed",
    "delivery_review_started", "delivery_review_completed",
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

        # 4. V7 event vocabulary expansion (Task 1.2): a representative new
        # type from each family (core/architect/task/visual/self-review)
        # emits successfully and round-trips with its fields intact.
        new_type_samples = [
            ("session_created", {"taskSummary": "add widget", "workspace": "/tmp/ws"}),
            ("skill_loaded", {"name": "frontend", "path": "/skills/frontend.md"}),
            ("model_retry", {"attempt": 2, "strategy": "same_turn"}),
            ("context_selected", {"systemBytes": 100, "taskBytes": 200}),
            ("architect_planning_started", {}),
            ("architect_plan_created", {"risk": "low"}),
            ("architect_review_requested", {"iteration": 0, "reviewRound": 1}),
            ("architect_review_completed", {"iteration": 0, "reviewRound": 1, "decision": "APPROVED"}),
            ("task_created", {"taskId": "t1", "kind": "implementation"}),
            ("task_status_changed", {"taskId": "t1", "status": "complete", "previousStatus": "in_progress"}),
            ("task_list_completed", {"taskCount": 2}),
            ("visual_verification_started", {"command": "glimmer-visual.py"}),
            ("visual_finding_detected", {"severity": "high", "description": "cut off"}),
            ("visual_verification_completed", {"status": "PASS"}),
            ("delivery_review_started", {}),
            ("delivery_review_completed", {"customerReadiness": "ready_to_ship", "confidence": "high"}),
        ]
        for t, fields in new_type_samples:
            emit(path, t, "s2", **fields)
        with open(path) as f:
            new_lines = f.readlines()[-len(new_type_samples):]
        for (t, fields), line in zip(new_type_samples, new_lines):
            rec = json.loads(line)
            assert rec["type"] == t, f"expected {t!r}, got {rec['type']!r}"
            for k, v in fields.items():
                assert rec[k] == v, f"{t}: field {k!r} mismatch"
        # architect_replan_started has no emit site yet (no replan path
        # exists) but must still be a valid, emittable type.
        emit(path, "architect_replan_started", "s2")
        with open(path) as f:
            assert json.loads(f.readlines()[-1])["type"] == "architect_replan_started"

        print("glimmer_events self-check: PASS (4/4)")


if __name__ == "__main__":
    _selfcheck()
