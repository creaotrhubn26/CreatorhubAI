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
from pathlib import Path

from glimmer_journal import append_jsonl_durable

EVENT_TYPES = {
    "tool_started", "tool_completed", "tool_blocked", "file_changed",
    "verification_started", "verification_completed", "agent_state_changed",
    "candidate_selected", "scope_expanded", "repair_started",
    "parser_recovery", "session_completed",
    # V7 event vocabulary expansion (Task 1.2 — §5.14, §22.15, task events,
    # §23.13). "architect_replan_started" is emitted by glimmer-v2.py's
    # review loop (Task 2.2, V7 §5.12) right before re-invoking the
    # architect on a REPLAN_REQUIRED decision -- see run_architect_replan.
    "session_created", "skill_loaded", "model_retry", "model_request_started", "context_selected",
    "architect_planning_started", "architect_plan_created",
    "architect_review_requested", "architect_review_completed",
    "architect_replan_started",
    # Task 2.1 (V7 §5.5): emitted by glimmer-v2.py main() only when the
    # deterministic risk score (compute_architect_risk) crosses
    # ARCHITECT_RISK_THRESHOLD and --no-architect was not passed.
    "architect_autotriggered",
    "task_created", "task_status_changed", "task_list_completed",
    # Round-8 re-review NEW-MJ1: emitted by glimmer-v2.py when a HUMAN
    # task-override (task-overrides.json sidecar) is applied -- was in the
    # CC union/Set but missing here, so emit() silently dropped the very
    # event that records a human overriding a gate.
    "task_override_applied",
    "visual_verification_started", "visual_finding_detected",
    "visual_verification_completed",
    "delivery_review_started", "delivery_review_completed",
    # Task 7.1/7.2 (V7 documentation intelligence): emitted by
    # glimmer-v2.py's finally-block doc pass when the TARGET repo has a
    # docs/graph.json -- deterministic node ids/statuses only.
    "documentation_impact_detected", "documentation_stale_detected",
    "documentation_verified",
    # Task 2.4 (V7 §5.5 second half): emitted by glimmer-engineer.py's
    # run_engineer loop -- "architect_consult_advised" for each
    # deterministic mid-implementation trigger that fires (at most once
    # per key per session), "architect_consulted" for each actual
    # consult_architect tool call (budget-limited).
    "architect_consult_advised", "architect_consulted",
    # Task 8.2 (V7 §23.16): emitted once by glimmer-v2.py's `finally`
    # block, right after delivery-packet.json/packet-summary.txt are
    # written, on every exit path (mirrors session_completed's own
    # unconditional emission just after it).
    "delivery_packet_created",
    # Task 8.3 (V7 §14/§35): emitted by glimmer-engineer.py's
    # request_approval_and_wait the moment a YELLOW-classified action
    # (classify_yellow) needs a human decision -- one per approval
    # request, before the poll loop over approvals.json starts.
    "approval_requested",
    # Accuracy v2 facts: deterministic validation/indexing, clarification,
    # adaptive routing and repeated-repair prevention.
    "claim_validation_completed", "repo_index_completed",
    "clarification_requested", "clarification_resolved",
    "model_routing_decision", "repair_strategy_rejected",
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
        # The helper retains O_APPEND single-write atomicity and adds fsync,
        # so a completed event survives an app/process/machine crash instead
        # of lingering only in the OS page cache.
        append_jsonl_durable(Path(events_path), record)
    except Exception as exc:  # noqa: BLE001 - deliberate: event emission must never break the session
        print(f"[glimmer_events] failed to emit {event_type!r}: {exc}", flush=True)


def _selfcheck() -> None:
    import concurrent.futures
    import tempfile

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
        new_type_samples: list[tuple[str, dict[str, object]]] = [
            ("session_created", {"taskSummary": "add widget", "workspace": "/tmp/ws"}),
            ("skill_loaded", {"name": "frontend", "path": "/skills/frontend.md"}),
            ("model_retry", {"attempt": 2, "strategy": "same_turn"}),
            ("model_request_started", {"requestId": "req-1", "role": "engineer",
                                       "providerId": "private", "modelId": "local-30b"}),
            ("model_routing_decision", {"role": "engineer", "risk": "HIGH",
                                         "providerId": "frontier", "modelId": "frontier-1",
                                         "reason": "high-risk-override"}),
            ("claim_validation_completed", {"verified": 2, "partial": 0, "rejected": 1}),
            ("repo_index_completed", {"supportedFiles": 12, "partial": False}),
            ("clarification_requested", {"clarificationId": "clarify-1"}),
            ("clarification_resolved", {"clarificationId": "clarify-1"}),
            ("repair_strategy_rejected", {"strategyId": "repeat", "failureSignature": "sig"}),
            # Fix round 1 (MED): sample updated to the real Task 5.1 shape
            # glimmer-engineer.py actually emits (tier0Chars/tier1Chars/
            # tier2Refs/tier3Note) -- the old systemBytes/taskBytes sample
            # predated that task and was never emitted past it.
            ("context_selected", {"tier0Chars": 1000, "tier1Chars": 200, "tier2Refs": 0, "tier3Note": "cold: n/a"}),
            ("architect_planning_started", {}),
            ("architect_plan_created", {"risk": "low"}),
            ("architect_review_requested", {"iteration": 0, "reviewRound": 1}),
            ("architect_review_completed", {"iteration": 0, "reviewRound": 1, "decision": "APPROVED"}),
            ("architect_replan_started", {"fromVersion": 1, "toVersion": 2, "reviewRound": 1}),
            ("task_created", {"taskId": "t1", "kind": "implementation"}),
            ("task_status_changed", {"taskId": "t1", "status": "complete", "previousStatus": "in_progress"}),
            ("task_list_completed", {"taskCount": 2}),
            ("visual_verification_started", {"command": "glimmer-visual.py"}),
            ("visual_finding_detected", {"severity": "high", "description": "cut off"}),
            ("visual_verification_completed", {"status": "PASS"}),
            ("delivery_review_started", {}),
            ("delivery_review_completed", {"customerReadiness": "ready_to_ship", "confidence": "high"}),
            ("documentation_impact_detected", {"files": ["src/api/u.ts"], "nodeIds": ["api-users"]}),
            ("documentation_stale_detected", {"nodeId": "api-users", "reason": "impacted by change"}),
            ("documentation_verified", {"nodeId": "api-users", "status": "CURRENT"}),
            ("architect_consult_advised", {"trigger": "turns_high_no_writes", "detail": "turn 7/10 (over 60% of the turn budget) with no repository write yet"}),
            ("architect_consulted", {"questionChars": 42, "answerChars": 210}),
            ("delivery_packet_created", {}),
            ("task_override_applied", {"taskId": "t1", "override": "approve", "tasksResolvedBy": "human"}),
            ("approval_requested", {"approvalId": "s2-appr-abc123", "action": "modify_dependencies",
                                     "reason": "engineer requested a dependency-install command: npm install left-pad",
                                     "risk": "medium"}),
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

        # 5. Emitter parity (round-8 re-review NEW-MJ1 root cause: three
        # separate incidents of an emitted type missing from EVENT_TYPES,
        # each silently dropping real events). Scan the sibling emitter
        # sources for every string literal passed as emit/emit_event's
        # type argument and assert each is registered here. Source scan,
        # not import -- the hyphenated filenames can't be imported.
        import re as _re
        here = os.path.dirname(os.path.abspath(__file__))
        emitted = set()
        for fname in ("glimmer-v2.py", "glimmer-engineer.py", "glimmer-visual.py"):
            fpath = os.path.join(here, fname)
            if not os.path.isfile(fpath):
                continue
            with open(fpath, encoding="utf-8") as f:
                src = f.read()
            emitted |= set(_re.findall(r'emit(?:_event)?\(\s*[^,)]+,\s*"([a-z_]+)"', src))
        unregistered = emitted - EVENT_TYPES
        assert not unregistered, (
            f"emitted event types missing from EVENT_TYPES (would be "
            f"silently dropped): {sorted(unregistered)}"
        )

        print("glimmer_events self-check: PASS (5/5)")


if __name__ == "__main__":
    _selfcheck()
