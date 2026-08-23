#!/usr/bin/env python3
"""glimmer-metrics.py -- V7 §41 self-improvement loop (metrics + calibration).

Read-only, deterministic scan over ~/.muse-glimmer/sessions/*/manifest.json
(+ events.jsonl where a fact only lives in the event stream), tolerant of
malformed/legacy session dirs -- a torn manifest.json, one that parses to a
non-object JSON value, or a session dir with no manifest.json at all is
skipped, never fatal to the scan. Never writes to a session dir.

Aggregates, straight from real facts glimmer-v2.py already computed and
persisted (classify_failure's manifest["failure"], compute_statuses'
manifest["statuses"], the describe_blocked_gates contract's
manifest["blockedGates"], and architect_review_completed events):

  - failure taxonomy distribution (manifest["failure"]["class"]; SUCCESS
    only for sessions that actually ended verified; a session with no
    failure.class that never verified lands in its own honest
    "unclassified:<status>" bucket -- never silently counted as SUCCESS --
    with "repo-map-only" split into its own non-failure early-exit bucket)
  - repair success rate (a session with >=2 recorded attempts -- i.e. at
    least one repair iteration ran -- that ended verified)
  - architect-gate outcomes (approved/replan/rejected/revise), read from
    architect_review_completed events via the same decision table
    glimmer-v2.py's classify_architect_review_decision uses
  - gate-block distribution (manifest["blockedGates"] tallied by gate name)
  - statuses.overall distribution (manifest["statuses"]["overall"] tallied)

Also computes the V7 §41 parked PARSER_FAILURE_THRESHOLD calibration item:
counts real parser_recovery events per session and prints the resulting
distribution with a recommended threshold. Per V7 §42 ("what should NOT be
model-driven" -- and the same discipline applies to any deterministic
runtime constant, model or not), this script NEVER writes
PARSER_FAILURE_THRESHOLD anywhere; a human reads the report and edits the
constant in glimmer-v2.py by hand if the recommendation warrants it.

Usage:
    ./glimmer-metrics.py                       # scan ~/.muse-glimmer/sessions, write to --out
    ./glimmer-metrics.py --sessions-dir DIR     # scan an alternate sessions dir
    ./glimmer-metrics.py --out DIR              # override the output directory
    ./glimmer-metrics.py --selfcheck            # synthetic fixture dirs only, never touches real state
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_SESSIONS_DIR = Path.home() / ".muse-glimmer" / "sessions"
DEFAULT_OUT_ROOT = ROOT / "eval-results"

# Quoted here for the report only -- this script never writes it back.
# Keep in sync with glimmer-v2.py's own PARSER_FAILURE_THRESHOLD constant.
CURRENT_PARSER_FAILURE_THRESHOLD = 2


def _classify_review_decision(decision):
    """Mirrors glimmer-v2.py's classify_architect_review_decision (V7
    §5.7/§5.12) exactly -- kept in sync deliberately, not imported: the
    hyphenated glimmer-v2.py filename can't be imported as a module (same
    discipline glimmer_events.py's own selfcheck comment documents), and a
    metrics script reusing runtime internals via importlib would execute
    that whole module's top-level code for no benefit here."""
    if decision in ("APPROVED", "APPROVED_WITH_CONDITIONS"):
        return "approved"
    if decision == "REVISE_IMPLEMENTATION":
        return "revise"
    if decision == "REPLAN_REQUIRED":
        return "replan"
    if decision == "HUMAN_REVIEW_REQUIRED":
        return "rejected"
    return "rejected"  # unrecognized decision -- same fail-closed default as the source


def _read_manifest(path) -> dict | None:
    """None uniformly for every degraded case: missing file, unreadable,
    not valid JSON, or valid JSON that isn't a JSON object (a legacy bug or
    a torn write can leave e.g. a bare array/string on disk) -- callers
    never need to distinguish these, they just skip the session."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _read_events(path) -> list:
    """[] on a missing events.jsonl (most legacy sessions, or one that
    crashed before any event was ever emitted) -- a torn/malformed
    individual line is skipped, not fatal to the rest of the file, same
    tolerant convention as glimmer-v2.py's own read_session_events."""
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except OSError:
        return []
    out = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


def scan_sessions(sessions_dir) -> list:
    """Read every immediate subdirectory of `sessions_dir` into
    {"id", "manifest", "events"}. Never raises: a sessions_dir that
    doesn't exist yields [] (honest empty corpus, see build_metrics/
    render_report), and any one session dir with no manifest.json or a
    malformed one is silently skipped rather than aborting the whole scan."""
    sessions_dir = Path(sessions_dir)
    out = []
    try:
        entries = sorted(p for p in sessions_dir.iterdir() if p.is_dir())
    except OSError:
        return out
    for entry in entries:
        manifest = _read_manifest(entry / "manifest.json")
        if manifest is None:
            continue
        events = _read_events(entry / "events.jsonl")
        out.append({"id": entry.name, "manifest": manifest, "events": events})
    return out


def _tally(items) -> dict:
    counts: dict = {}
    for item in items:
        counts[item] = counts.get(item, 0) + 1
    return counts


def _session_ended_verified(manifest: dict) -> bool:
    """The canonical fact ("state") when present; falls back to the raw
    "status" strings a session predating manifest["state"] (Task 6) still
    carries -- same two-value success set glimmer-v2.py's own
    canonical_session_state maps to "verified"."""
    if manifest.get("state") == "verified":
        return True
    return manifest.get("status") in ("verified", "no-change-verified")


def compute_failure_taxonomy(sessions) -> dict:
    """Round 9 review (M1): SUCCESS used to mean only "classify_failure
    recorded no failure.class", which also swept in every session that
    never actually reached verified -- blocked-infra_blocked, blocked-
    no-changes, no-change-unverified, a bare "initialized" that crashed
    pre-classify, etc. (classify_failure returns None for those too, same
    as it does for a real success.) Measured 16/60 "SUCCESS" sessions on
    the real corpus that were never verified -- a 27% inflated headline
    number for the exact §41 human-review decision this taxonomy exists to
    support. SUCCESS now requires the same ended-verified check the repair-
    rate metric already applies; repo-map-only keeps its own honest
    non-failure bucket (classify_failure treats it as a deliberate early
    exit, not a success); everything else with no failure.class is an
    honest "unclassified:<status>" bucket instead of a silent SUCCESS."""
    classes = []
    for s in sessions:
        manifest = s["manifest"]
        failure = manifest.get("failure")
        if isinstance(failure, dict) and failure.get("class"):
            classes.append(failure["class"])
        elif _session_ended_verified(manifest):
            classes.append("SUCCESS")
        elif manifest.get("status") == "repo-map-only":
            classes.append("EARLY_EXIT:repo-map-only")
        else:
            classes.append(f"unclassified:{manifest.get('status')}")
    return _tally(classes)


def compute_repair_success_rate(sessions) -> dict:
    """"repair attempted" = >=2 recorded attempts (iteration 0 plus at
    least one repair iteration). Rate is None (not 0.0) when zero sessions
    ever attempted a repair -- an honest "nothing to report", not a
    fabricated 0% success rate."""
    attempted = 0
    verified = 0
    for s in sessions:
        attempts = s["manifest"].get("attempts")
        if not isinstance(attempts, list) or len(attempts) < 2:
            continue
        attempted += 1
        if _session_ended_verified(s["manifest"]):
            verified += 1
    rate = (verified / attempted) if attempted else None
    return {"sessionsWithRepairAttempted": attempted, "verifiedAfterRepair": verified, "rate": rate}


def compute_architect_gate_outcomes(sessions) -> dict:
    outcomes = []
    for s in sessions:
        for e in s["events"]:
            if e.get("type") == "architect_review_completed":
                outcomes.append(_classify_review_decision(e.get("decision")))
    return _tally(outcomes)


def compute_gate_block_distribution(sessions) -> dict:
    gates = []
    for s in sessions:
        blocked = s["manifest"].get("blockedGates")
        if isinstance(blocked, list):
            gates.extend(g for g in blocked if isinstance(g, str))
    return _tally(gates)


def compute_overall_status_distribution(sessions) -> dict:
    statuses = []
    for s in sessions:
        overall = (s["manifest"].get("statuses") or {}).get("overall")
        if isinstance(overall, str):
            statuses.append(overall)
    return _tally(statuses)


def compute_parser_recovery_calibration(sessions) -> dict:
    """V7 §41 parked item. Counts real parser_recovery events per session
    (the same events classify_failure counts against the constant) and
    proposes a threshold -- WITH the supporting distribution, so a human
    reviewer can see exactly what produced the number. Never writes
    PARSER_FAILURE_THRESHOLD anywhere (V7 §42): the recommendation is
    printed, the human edits glimmer-v2.py by hand."""
    per_session_counts = []
    for s in sessions:
        n = sum(1 for e in s["events"] if e.get("type") == "parser_recovery")
        if n > 0:
            per_session_counts.append(n)

    if not per_session_counts:
        return {
            "sessionsWithParserRecovery": 0,
            "distribution": {},
            "currentThreshold": CURRENT_PARSER_FAILURE_THRESHOLD,
            "recommendation": None,
            "recommendationBasis": (
                "no session in this corpus ever recorded a parser_recovery event -- "
                "nothing to calibrate against."
            ),
        }

    per_session_counts.sort()
    n = len(per_session_counts)
    median = (
        per_session_counts[n // 2]
        if n % 2
        else (per_session_counts[n // 2 - 1] + per_session_counts[n // 2]) / 2
    )
    # ponytail: a simple, explainable heuristic (one more than the observed
    # median recovery count among sessions that ever recovered at all,
    # floored at 2 -- never below the existing constant's own reasoning,
    # "one recovered parse is transient"), not a statistically fit model.
    # A human reviews this number; this script only ever proposes it.
    recommended = max(2, int(median) + 1)
    return {
        "sessionsWithParserRecovery": n,
        "distribution": _tally(per_session_counts),
        "currentThreshold": CURRENT_PARSER_FAILURE_THRESHOLD,
        "recommendation": recommended,
        "recommendationBasis": (
            f"{n} session(s) with >=1 parser_recovery event; per-session counts "
            f"{per_session_counts}; median={median}. Recommendation = "
            f"max(2, median + 1). A human must edit PARSER_FAILURE_THRESHOLD in "
            f"glimmer-v2.py by hand (V7 §42) -- this script never writes it."
        ),
    }


def build_metrics(sessions: list) -> dict:
    return {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "sessionCount": len(sessions),
        "failureTaxonomy": compute_failure_taxonomy(sessions),
        "repairSuccessRate": compute_repair_success_rate(sessions),
        "architectGateOutcomes": compute_architect_gate_outcomes(sessions),
        "gateBlockDistribution": compute_gate_block_distribution(sessions),
        "overallStatusDistribution": compute_overall_status_distribution(sessions),
        "parserFailureCalibration": compute_parser_recovery_calibration(sessions),
    }


def _table(rows) -> list:
    return [f"| {a} | {b} |" for a, b in rows]


def render_report(metrics: dict) -> str:
    lines = [f"# Glimmer metrics report ({metrics['generatedAt']})", ""]

    if metrics["sessionCount"] == 0:
        lines += [
            "**No sessions found in the scanned directory.**", "",
            "This is an honest empty-corpus report -- every table below is",
            "intentionally omitted rather than showing fabricated zeros as if",
            "they were real data.", "",
        ]
        return "\n".join(lines) + "\n"

    lines.append(f"Sessions scanned: {metrics['sessionCount']}")
    lines.append("")

    lines.append("## Failure taxonomy distribution")
    lines.append("")
    lines.append("| class | count |")
    lines.append("|---|---|")
    lines += _table(sorted(metrics["failureTaxonomy"].items(), key=lambda kv: -kv[1]))
    lines.append("")

    rsr = metrics["repairSuccessRate"]
    lines.append("## Repair success rate")
    lines.append("")
    lines.append(f"- Sessions with a repair attempted: {rsr['sessionsWithRepairAttempted']}")
    lines.append(f"- Verified after repair: {rsr['verifiedAfterRepair']}")
    rate_str = f"{rsr['rate']:.1%}" if rsr["rate"] is not None else "N/A (no sessions attempted a repair)"
    lines.append(f"- Rate: {rate_str}")
    lines.append("")

    lines.append("## Architect-gate outcomes")
    lines.append("")
    if metrics["architectGateOutcomes"]:
        lines.append("| outcome | count |")
        lines.append("|---|---|")
        lines += _table(sorted(metrics["architectGateOutcomes"].items(), key=lambda kv: -kv[1]))
    else:
        lines.append("No architect_review_completed events found in this corpus.")
    lines.append("")

    lines.append("## Gate-block distribution")
    lines.append("")
    if metrics["gateBlockDistribution"]:
        lines.append("| gate | times blocked |")
        lines.append("|---|---|")
        lines += _table(sorted(metrics["gateBlockDistribution"].items(), key=lambda kv: -kv[1]))
    else:
        lines.append("No blockedGates recorded in this corpus.")
    lines.append("")

    lines.append("## statuses.overall distribution")
    lines.append("")
    if metrics["overallStatusDistribution"]:
        lines.append("| overall | count |")
        lines.append("|---|---|")
        lines += _table(sorted(metrics["overallStatusDistribution"].items(), key=lambda kv: -kv[1]))
    else:
        lines.append("No manifest.statuses.overall recorded in this corpus.")
    lines.append("")

    pfc = metrics["parserFailureCalibration"]
    lines.append("## PARSER_FAILURE_THRESHOLD calibration (V7 §41, parked item)")
    lines.append("")
    lines.append(f"- Current constant in glimmer-v2.py: {pfc['currentThreshold']}")
    lines.append(f"- Sessions with >=1 parser_recovery event: {pfc['sessionsWithParserRecovery']}")
    if pfc["distribution"]:
        lines.append("")
        lines.append("| parser_recovery events in session | session count |")
        lines.append("|---|---|")
        lines += _table(sorted(pfc["distribution"].items()))
    lines.append("")
    if pfc["recommendation"] is not None:
        lines.append(f"**Recommendation: {pfc['recommendation']}**")
    else:
        lines.append("**Recommendation: N/A (no data in this corpus)**")
    lines.append("")
    lines.append(pfc["recommendationBasis"])
    lines.append("")
    lines.append(
        "**This script never writes PARSER_FAILURE_THRESHOLD anywhere.** Per V7 "
        "§42, a deterministic runtime constant like this is a human-reviewed "
        "decision -- a human reads this report and edits the constant in "
        "glimmer-v2.py by hand if the recommendation warrants it."
    )
    lines.append("")

    return "\n".join(lines) + "\n"


def write_outputs(metrics: dict, out_dir) -> tuple:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "metrics.json"
    md_path = out_dir / "metrics-report.md"
    json_path.write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    md_path.write_text(render_report(metrics), encoding="utf-8")
    return json_path, md_path


def _selfcheck() -> bool:
    import tempfile

    ok = True

    def check(label, cond):
        nonlocal ok
        if not cond:
            ok = False
            print(f"SELFCHECK FAIL: {label}")

    # ---- 1. Empty corpus: honest "no sessions", never fabricated zeros. ----
    with tempfile.TemporaryDirectory() as td:
        sessions = scan_sessions(Path(td) / "sessions")  # subdir deliberately does not exist
        check("empty corpus: scan_sessions returns []", sessions == [])
        metrics = build_metrics(sessions)
        check("empty corpus: metrics sessionCount == 0", metrics["sessionCount"] == 0)
        report = render_report(metrics)
        check("empty corpus: report says 'No sessions found'", "No sessions found" in report)
        check("empty corpus: report has no failure-taxonomy table", "| class | count |" not in report)

    # ---- 2. Malformed/legacy manifest tolerance + real aggregation. ----
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)

        # a) a stray dir with no manifest.json at all.
        (root / "20260101-000000-stray").mkdir(parents=True)

        # b) genuinely corrupt JSON.
        bad = root / "20260101-000001-corrupt"
        bad.mkdir()
        (bad / "manifest.json").write_text("{not valid json", encoding="utf-8")

        # c) valid JSON but not an object (a torn write, or a future bug).
        wrong_shape = root / "20260101-000002-wrong-shape"
        wrong_shape.mkdir()
        (wrong_shape / "manifest.json").write_text("[]", encoding="utf-8")

        # d) a clean verified session: no repair, no failure, real statuses.overall.
        clean = root / "20260101-000003-clean-verified"
        clean.mkdir()
        (clean / "manifest.json").write_text(json.dumps({
            "status": "verified", "state": "verified", "attempts": [{"iteration": 0}],
            "statuses": {"overall": "ready_to_ship"},
        }), encoding="utf-8")

        # e) repair attempted, ends verified.
        repaired_ok = root / "20260101-000004-repaired-verified"
        repaired_ok.mkdir()
        (repaired_ok / "manifest.json").write_text(json.dumps({
            "status": "verified", "state": "verified",
            "attempts": [{"iteration": 0}, {"iteration": 1}],
        }), encoding="utf-8")

        # f) repair attempted, ends failed, with a classified failure + blockedGates.
        repaired_fail = root / "20260101-000005-repaired-failed"
        repaired_fail.mkdir()
        (repaired_fail / "manifest.json").write_text(json.dumps({
            "status": "failed-repair-budget-exhausted", "state": "failed",
            "attempts": [{"iteration": 0}, {"iteration": 1}, {"iteration": 2}],
            "failure": {"class": "CODE_FAIL", "detail": "x", "evidenceIds": []},
            "blockedGates": ["implementationComplete"],
        }), encoding="utf-8")

        # g) architect review (approved) + parser_recovery events, no repair.
        arch = root / "20260101-000006-architect-events"
        arch.mkdir()
        (arch / "manifest.json").write_text(json.dumps({
            "status": "verified", "state": "verified", "attempts": [{"iteration": 0}],
        }), encoding="utf-8")
        events_g = [
            {"id": "e1", "sessionId": "s", "timestamp": "t", "type": "architect_review_completed",
             "iteration": 0, "reviewRound": 1, "decision": "APPROVED"},
            {"id": "e2", "sessionId": "s", "timestamp": "t", "type": "parser_recovery", "attempt": 1},
            {"id": "e3", "sessionId": "s", "timestamp": "t", "type": "parser_recovery", "attempt": 2},
            {"id": "e4", "sessionId": "s", "timestamp": "t", "type": "parser_recovery", "attempt": 3},
        ]
        (arch / "events.jsonl").write_text(
            "\n".join(json.dumps(e) for e in events_g) + "\ncorrupt-not-json\n", encoding="utf-8"
        )

        # h) a replan then a rejected review round -- proves tallying across
        #    multiple architect_review_completed events in one session.
        arch2 = root / "20260101-000007-architect-events-2"
        arch2.mkdir()
        (arch2 / "manifest.json").write_text(json.dumps({
            "status": "verified", "state": "verified", "attempts": [{"iteration": 0}],
        }), encoding="utf-8")
        events_h = [
            {"id": "f1", "sessionId": "s2", "timestamp": "t", "type": "architect_review_completed",
             "iteration": 0, "reviewRound": 1, "decision": "REPLAN_REQUIRED"},
            {"id": "f2", "sessionId": "s2", "timestamp": "t", "type": "architect_review_completed",
             "iteration": 1, "reviewRound": 2, "decision": "HUMAN_REVIEW_REQUIRED"},
        ]
        (arch2 / "events.jsonl").write_text("\n".join(json.dumps(e) for e in events_h) + "\n", encoding="utf-8")

        # i) legacy session predating manifest["state"] (Task 6) -- only the
        #    raw "status" string exists. Must still be read and classified
        #    as an ended-verified SUCCESS via the status fallback.
        legacy = root / "20260101-000008-legacy-no-state"
        legacy.mkdir()
        (legacy / "manifest.json").write_text(json.dumps({
            "status": "no-change-verified", "attempts": [{"iteration": 0}],
        }), encoding="utf-8")

        # j) Round 9 review (M1): a session with NO failure.class that never
        #    ended verified -- classify_failure returns None for this raw
        #    status (it isn't one of the recognized failure-producing ones),
        #    the exact real-corpus shape (blocked-infra_blocked, blocked-no-
        #    changes, no-change-unverified, a crashed "initialized") that
        #    used to be silently swept into SUCCESS. Must NOT count as
        #    SUCCESS; must land in its own honest unclassified bucket.
        infra_blocked = root / "20260101-000009-infra-blocked-no-failure-class"
        infra_blocked.mkdir()
        (infra_blocked / "manifest.json").write_text(json.dumps({
            "status": "blocked-infra_blocked", "attempts": [{"iteration": 0}],
        }), encoding="utf-8")

        # k) repo-map-only -- classify_failure's deliberate early-exit, no
        #    failure.class, never verified: its own non-failure bucket, not
        #    SUCCESS and not lumped in with genuine unclassified failures.
        repo_map = root / "20260101-000010-repo-map-only"
        repo_map.mkdir()
        (repo_map / "manifest.json").write_text(json.dumps({
            "status": "repo-map-only",
        }), encoding="utf-8")

        sessions = scan_sessions(root)
        # stray (no manifest), corrupt JSON, and wrong-shape (non-dict) must
        # all be silently skipped -- 8 real sessions survive out of 11 dirs.
        check("malformed tolerance: 8 valid sessions found", len(sessions) == 8)

        metrics = build_metrics(sessions)
        check("sessionCount == 8", metrics["sessionCount"] == 8)

        ft = metrics["failureTaxonomy"]
        check("failure taxonomy: 5 SUCCESS", ft.get("SUCCESS") == 5)
        check("failure taxonomy: 1 CODE_FAIL", ft.get("CODE_FAIL") == 1)
        check("failure taxonomy: never-verified session is NOT SUCCESS",
              ft.get("unclassified:blocked-infra_blocked") == 1)
        check("failure taxonomy: repo-map-only gets its own non-failure bucket",
              ft.get("EARLY_EXIT:repo-map-only") == 1)

        rsr = metrics["repairSuccessRate"]
        check("repair: 2 sessions attempted a repair", rsr["sessionsWithRepairAttempted"] == 2)
        check("repair: 1 verified after repair", rsr["verifiedAfterRepair"] == 1)
        check("repair: rate == 0.5", rsr["rate"] == 0.5)

        gates = metrics["architectGateOutcomes"]
        check("architect gates: 1 approved", gates.get("approved") == 1)
        check("architect gates: 1 replan", gates.get("replan") == 1)
        check("architect gates: 1 rejected", gates.get("rejected") == 1)

        blocked = metrics["gateBlockDistribution"]
        check("gate-block: implementationComplete blocked once", blocked.get("implementationComplete") == 1)

        overall = metrics["overallStatusDistribution"]
        check("overall distribution: ready_to_ship once", overall.get("ready_to_ship") == 1)

        pfc = metrics["parserFailureCalibration"]
        check("parser calibration: 1 session with parser_recovery", pfc["sessionsWithParserRecovery"] == 1)
        check("parser calibration: distribution {3: 1}", pfc["distribution"] == {3: 1})
        check("parser calibration: recommendation == 4", pfc["recommendation"] == 4)
        check("parser calibration: basis mentions human review", "human" in pfc["recommendationBasis"].lower())

        report = render_report(metrics)
        check("report renders the failure-taxonomy table", "| class | count |" in report)
        check(
            "report states it never writes the constant",
            "never writes PARSER_FAILURE_THRESHOLD" in report,
        )

        # write_outputs actually persists both files, round-trips via JSON.
        out_dir = Path(td) / "out"
        json_path, md_path = write_outputs(metrics, out_dir)
        check("metrics.json written", json_path.exists())
        check("metrics-report.md written", md_path.exists())
        round_tripped = json.loads(json_path.read_text(encoding="utf-8"))
        check("metrics.json round-trips sessionCount", round_tripped["sessionCount"] == 8)

    return ok


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Muse Glimmer metrics + self-improvement-loop report (V7 §41)"
    )
    ap.add_argument(
        "--sessions-dir", default=str(DEFAULT_SESSIONS_DIR),
        help="Directory of session dirs to scan (default: ~/.muse-glimmer/sessions)",
    )
    ap.add_argument(
        "--out", default=None,
        help="Output directory for metrics.json + metrics-report.md "
             "(default: ./eval-results/metrics-<UTC-ts>)",
    )
    ap.add_argument("--selfcheck", action="store_true")
    args = ap.parse_args()

    if args.selfcheck:
        ok = _selfcheck()
        print("METRICS SELFCHECK " + ("PASS" if ok else "FAIL"))
        return 0 if ok else 1

    sessions = scan_sessions(args.sessions_dir)
    metrics = build_metrics(sessions)
    ts = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = Path(args.out) if args.out else DEFAULT_OUT_ROOT / f"metrics-{ts}"
    json_path, md_path = write_outputs(metrics, out_dir)
    print(f"[glimmer-metrics] scanned {len(sessions)} session(s) under {args.sessions_dir}")
    print(f"[glimmer-metrics] wrote {json_path}")
    print(f"[glimmer-metrics] wrote {md_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
