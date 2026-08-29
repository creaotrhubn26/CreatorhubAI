#!/usr/bin/env python3
"""Deterministic claim validation and quality aggregation for Glimmer."""
from __future__ import annotations

import json
from pathlib import Path

CLAIM_TYPES = {"presence", "absence", "behavior", "risk"}
SEVERITIES = {"critical", "high", "medium", "low", "info"}
VERIFICATION_STATUSES = {"verified", "partial", "rejected"}


def load_evidence(session_dir: Path) -> tuple[dict[str, dict], dict[str, dict]]:
    session_dir = Path(session_dir)
    indexed = {}
    records = {}
    try:
        raw_index = json.loads((session_dir / "evidence-index.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw_index = []
    if isinstance(raw_index, list):
        for entry in raw_index:
            if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                indexed[entry["id"]] = entry
    for path in sorted(session_dir.glob("evidence-*.jsonl")):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                records[entry["id"]] = entry
    return indexed, records


def _safe_evidence_path(workspace: Path, raw_path: object, line: object) -> tuple[dict | None, str | None]:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None, "evidence_path_missing"
    candidate = Path(raw_path.strip())
    target = candidate if candidate.is_absolute() else workspace / candidate
    try:
        resolved = target.resolve(strict=True)
        relative = resolved.relative_to(workspace)
    except (OSError, ValueError):
        return None, "evidence_path_outside_or_missing"
    if not resolved.is_file():
        return None, "evidence_path_not_file"
    normalized_line = None
    if line is not None:
        if not isinstance(line, int) or isinstance(line, bool) or line < 1:
            return None, "evidence_line_invalid"
        try:
            line_count = sum(1 for _ in resolved.open("r", encoding="utf-8", errors="replace"))
        except OSError:
            return None, "evidence_path_unreadable"
        if line > line_count:
            return None, "evidence_line_out_of_range"
        normalized_line = line
    result = {"path": relative.as_posix()}
    if normalized_line is not None:
        result["line"] = normalized_line
    return result, None


def _normalize_decision_points(value: object) -> list[dict]:
    if not isinstance(value, list):
        return []
    points = []
    for index, item in enumerate(value[:10]):
        if not isinstance(item, dict):
            continue
        question = item.get("question")
        impact = item.get("impact")
        options = item.get("options")
        if not isinstance(question, str) or not question.strip() or impact not in {"low", "medium", "high"}:
            continue
        normalized_options = []
        if isinstance(options, list):
            for option_index, option in enumerate(options[:3]):
                if isinstance(option, str) and option.strip():
                    normalized_options.append({"id": f"option-{option_index + 1}", "label": option.strip()[:300]})
                elif isinstance(option, dict) and isinstance(option.get("label"), str) and option["label"].strip():
                    normalized_options.append({
                        "id": str(option.get("id") or f"option-{option_index + 1}")[:80],
                        "label": option["label"].strip()[:300],
                    })
        if len(normalized_options) >= 2:
            points.append({
                "id": str(item.get("id") or f"decision-{index + 1}")[:80],
                "question": question.strip()[:1000],
                "impact": impact,
                "options": normalized_options,
            })
    return points


def _is_repository_wide_search(
    evidence_id: str,
    indexed: dict[str, dict],
    records: dict[str, dict],
    workspace: Path,
) -> bool:
    index_entry = indexed.get(evidence_id) or {}
    record = records.get(evidence_id) or {}
    tool = index_entry.get("toolCall") or record.get("tool")
    if tool not in {"grep_search", "file_glob_search"}:
        return False
    arguments = record.get("arguments") if isinstance(record.get("arguments"), dict) else {}
    raw_path = arguments.get("path", ".")
    if raw_path in {None, "", "."}:
        return True
    if not isinstance(raw_path, str):
        return False
    candidate = Path(raw_path)
    target = candidate if candidate.is_absolute() else workspace / candidate
    try:
        return target.resolve(strict=False) == workspace
    except OSError:
        return False


def validate_task_report_v2(raw: object, mode: str, objective: str, workspace: Path,
                            session_dir: Path, critic: dict | None = None,
                            repo_index: dict | None = None) -> tuple[bool, dict | str]:
    if mode not in {"inspect", "plan", "review"}:
        return False, "invalid task report mode"
    if not isinstance(raw, dict):
        return False, "response is not a JSON object"
    summary = raw.get("summary")
    findings_raw = raw.get("findings")
    plan_raw = raw.get("implementationPlan")
    if not isinstance(summary, str) or not summary.strip():
        return False, "missing/invalid summary"
    if not isinstance(findings_raw, list) or not isinstance(plan_raw, list):
        return False, "findings and implementationPlan must be arrays"

    workspace = Path(workspace).expanduser().resolve()
    indexed, records = load_evidence(session_dir)
    known_ids = set(indexed) & set(records)
    critic_accepted = set()
    critic_reasons = {}
    independence = "unavailable"
    require_independent = False
    if isinstance(critic, dict):
        critic_accepted = {
            value for value in critic.get("acceptedFindingIndexes", [])
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0
        }
        critic_reasons = {
            int(key): str(value)[:1000] for key, value in (critic.get("reasons") or {}).items()
            if str(key).isdigit()
        }
        independence = critic.get("independence") if critic.get("independence") in {"independent", "same-model", "unavailable"} else "unavailable"
        require_independent = critic.get("requireIndependent") is True

    accepted = []
    rejected = []
    cited_ids = set()
    cited_paths = set()
    searches = set()
    for index, finding in enumerate(findings_raw[:100]):
        if not isinstance(finding, dict):
            continue
        reasons = []
        claim_type = finding.get("claimType")
        if claim_type not in CLAIM_TYPES:
            reasons.append("claim_type_missing_or_invalid")
            claim_type = "risk"
        evidence_ids = finding.get("evidenceIds")
        if not isinstance(evidence_ids, list):
            evidence_ids = []
            reasons.append("evidence_ids_missing")
        normalized_ids = []
        for evidence_id in evidence_ids[:50]:
            if isinstance(evidence_id, str) and evidence_id in known_ids:
                normalized_ids.append(evidence_id)
                cited_ids.add(evidence_id)
                if indexed[evidence_id].get("kind") == "search":
                    searches.add(evidence_id)
            else:
                reasons.append("unknown_evidence_id")

        evidence = []
        for item in finding.get("evidence", [])[:20] if isinstance(finding.get("evidence"), list) else []:
            if not isinstance(item, dict):
                continue
            normalized, path_error = _safe_evidence_path(workspace, item.get("path"), item.get("line"))
            if path_error:
                reasons.append(path_error)
                continue
            detail = item.get("detail")
            if not isinstance(detail, str) or not detail.strip():
                reasons.append("evidence_detail_missing")
                continue
            normalized["detail"] = detail.strip()[:2000]
            evidence.append(normalized)
            cited_paths.add(normalized["path"])

        required_text = [finding.get(key) for key in ("category", "title", "description", "recommendedFix")]
        if not all(isinstance(value, str) and value.strip() for value in required_text):
            reasons.append("required_text_missing")
        if not normalized_ids:
            reasons.append("no_valid_evidence_ids")
        if claim_type in {"presence", "behavior", "risk"} and not evidence:
            reasons.append("no_valid_file_evidence")
        if claim_type == "absence":
            if not any(
                _is_repository_wide_search(evidence_id, indexed, records, workspace)
                for evidence_id in normalized_ids
            ):
                reasons.append("absence_without_root_search")
            if index not in critic_accepted:
                reasons.append("absence_not_accepted_by_critic")
        if require_independent and independence != "independent":
            reasons.append("critic_independence_required")

        hard_failures = {
            "claim_type_missing_or_invalid", "evidence_ids_missing", "unknown_evidence_id",
            "evidence_path_outside_or_missing", "evidence_path_not_file", "evidence_line_invalid",
            "evidence_line_out_of_range", "required_text_missing", "no_valid_evidence_ids",
            "no_valid_file_evidence", "absence_without_root_search", "absence_not_accepted_by_critic",
            "critic_independence_required",
        }
        status = "rejected" if any(reason in hard_failures for reason in reasons) else "verified"
        if status == "verified" and index not in critic_accepted and critic is not None:
            status = "partial"
            reasons.append("critic_did_not_accept")
        normalized_finding = {
            "severity": finding.get("severity") if finding.get("severity") in SEVERITIES else "info",
            "category": str(finding.get("category") or "unknown").strip()[:200],
            "title": str(finding.get("title") or "Rejected finding").strip()[:500],
            "description": str(finding.get("description") or "").strip()[:4000],
            "claimType": claim_type,
            "evidenceIds": normalized_ids,
            "evidence": evidence,
            "recommendedFix": str(finding.get("recommendedFix") or "").strip()[:4000],
            "verification": {
                "status": status,
                "reasons": sorted(set(reasons)),
                **({"criticReason": critic_reasons[index]} if index in critic_reasons else {}),
            },
        }
        (rejected if status == "rejected" else accepted).append(normalized_finding)

    repo_coverage = (repo_index or {}).get("coverage") or {}
    coverage = {
        "filesInspected": len(cited_paths),
        "searchesRun": len(searches),
        "graphCoverage": repo_coverage.get("ratio"),
        "unsupportedLanguages": list(repo_coverage.get("unsupportedLanguages") or []),
        "evidenceRecords": len(known_ids),
    }
    verified_count = sum(1 for finding in accepted if finding["verification"]["status"] == "verified")
    if accepted and verified_count == len(accepted) and not rejected and (len(cited_paths) >= 2 or coverage["graphCoverage"] == 1.0):
        confidence = "high"
    elif accepted:
        confidence = "medium"
    else:
        confidence = "low"
    report = {
        "schemaVersion": 2,
        "mode": mode,
        "objective": objective,
        "summary": summary.strip()[:8000],
        "findings": accepted,
        "rejectedFindings": rejected,
        "implementationPlan": [step.strip()[:2000] for step in plan_raw[:100] if isinstance(step, str) and step.strip()],
        "confidence": confidence,
        "coverage": coverage,
        "decisionPoints": _normalize_decision_points(raw.get("decisionPoints")),
        "critic": {
            "status": "completed" if critic is not None else "unavailable",
            "independence": independence,
        },
    }
    return True, report


def build_critic_request(report: dict, session_dir: Path, model_identity: dict | None = None) -> dict:
    _indexed, records = load_evidence(session_dir)
    cited = []
    for finding in report.get("findings", [])[:100]:
        for evidence_id in finding.get("evidenceIds", [])[:20]:
            if evidence_id in records:
                record = records[evidence_id]
                cited.append({
                    "id": evidence_id,
                    "tool": record.get("tool"),
                    "arguments": record.get("arguments"),
                    "content": str(record.get("content") or "")[:4000],
                })
    prompt = (
        "You are Glimmer's read-only claim critic. Inspect only the candidate report and cited evidence below. "
        "Accept a finding only when its exact repository claim follows from the evidence. Absence claims require "
        "repository-wide search evidence. Return exactly one JSON object: "
        '{"acceptedFindingIndexes":[0],"reasons":{"0":"short reason"}}.\n\n'
        + json.dumps({"report": report, "evidence": cited[:100]}, ensure_ascii=False)
    )
    return {
        "messages": [
            {"role": "system", "content": "No tools. Do not add facts. Judge only supplied evidence."},
            {"role": "user", "content": prompt[:60_000]},
        ],
        "max_tokens": 2048,
        "modelIdentity": model_identity or {},
    }


def parse_critic_response(value: object, finding_count: int, independence: str,
                          require_independent: bool = False) -> dict:
    if not isinstance(value, dict):
        value = {}
    accepted = [
        item for item in value.get("acceptedFindingIndexes", [])
        if isinstance(item, int) and not isinstance(item, bool) and 0 <= item < finding_count
    ] if isinstance(value.get("acceptedFindingIndexes"), list) else []
    reasons = value.get("reasons") if isinstance(value.get("reasons"), dict) else {}
    return {
        "acceptedFindingIndexes": sorted(set(accepted)),
        "reasons": {str(key): str(text)[:1000] for key, text in reasons.items() if str(key).isdigit()},
        "independence": independence if independence in {"independent", "same-model", "unavailable"} else "unavailable",
        "requireIndependent": require_independent,
    }


def quality_summary(reports: list[dict], eval_summary: dict | None = None) -> dict:
    findings = [finding for report in reports for finding in report.get("findings", [])]
    rejected = [finding for report in reports for finding in report.get("rejectedFindings", [])]
    verified = sum(1 for finding in findings if finding.get("verification", {}).get("status") == "verified")
    denominator = len(findings) + len(rejected)
    return {
        "schemaVersion": 1,
        "reports": len(reports),
        "claimPrecision": round(verified / denominator, 4) if denominator else None,
        "verifiedClaims": verified,
        "partialClaims": sum(1 for finding in findings if finding.get("verification", {}).get("status") == "partial"),
        "rejectedClaims": len(rejected),
        "evaluation": eval_summary or {"live": None, "stub": None},
    }


def _selfcheck() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp) / "repo"
        session = Path(temp) / "session"
        root.mkdir()
        session.mkdir()
        (root / "src.py").write_text("value = 1\n", encoding="utf-8")
        evidence_id = "s-ev-1"
        (session / "evidence-index.json").write_text(json.dumps([
            {"id": evidence_id, "kind": "file", "path": "src.py", "toolCall": "read_file"}
        ]), encoding="utf-8")
        (session / "evidence-00.jsonl").write_text(json.dumps({
            "id": evidence_id, "tool": "read_file", "arguments": {"path": "src.py"}, "content": "value = 1"
        }) + "\n", encoding="utf-8")
        raw = {
            "summary": "Verified value.",
            "findings": [{
                "severity": "low", "category": "correctness", "title": "Value exists",
                "description": "The source defines a value.", "claimType": "presence",
                "evidenceIds": [evidence_id],
                "evidence": [{"path": "src.py", "line": 1, "detail": "definition"}],
                "recommendedFix": "No change.",
            }],
            "implementationPlan": [], "confidence": "high",
        }
        ok, report = validate_task_report_v2(raw, "inspect", "inspect", root, session,
                                             {"acceptedFindingIndexes": [0], "reasons": {}, "independence": "independent"})
        assert ok and report["schemaVersion"] == 2 and report["findings"][0]["verification"]["status"] == "verified"
        raw["findings"][0]["evidence"][0]["line"] = 99
        _ok, rejected = validate_task_report_v2(raw, "inspect", "inspect", root, session)
        assert not rejected["findings"] and rejected["rejectedFindings"]

        forged = json.loads(json.dumps(raw))
        forged["findings"][0]["evidenceIds"] = ["invented-evidence-id"]
        forged["findings"][0]["evidence"][0] = {
            "path": "../outside.py", "line": 1, "detail": "forged",
        }
        _ok, forged_report = validate_task_report_v2(
            forged, "inspect", "inspect", root, session,
        )
        forged_reasons = forged_report["rejectedFindings"][0]["verification"]["reasons"]
        assert "unknown_evidence_id" in forged_reasons
        assert "evidence_path_outside_or_missing" in forged_reasons

        search_id = "s-ev-search"
        with (session / "evidence-00.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({
                "id": search_id, "tool": "grep_search",
                "arguments": {"path": ".", "query": "subprocess"}, "content": "no matches",
            }) + "\n")
        (session / "evidence-index.json").write_text(json.dumps([
            {"id": evidence_id, "kind": "file", "path": "src.py", "toolCall": "read_file"},
            {"id": search_id, "kind": "search", "path": ".", "toolCall": "grep_search"},
        ]), encoding="utf-8")
        absence = {
            "summary": "No subprocess calls were found.",
            "findings": [{
                "severity": "info", "category": "security", "title": "No subprocess calls",
                "description": "Repository-wide search found no subprocess usage.",
                "claimType": "absence", "evidenceIds": [search_id], "evidence": [],
                "recommendedFix": "No change.",
            }],
            "implementationPlan": [], "confidence": "high",
        }
        _ok, accepted_absence = validate_task_report_v2(
            absence, "inspect", "inspect", root, session,
            {"acceptedFindingIndexes": [0], "reasons": {}, "independence": "same-model"},
        )
        assert accepted_absence["findings"][0]["verification"]["status"] == "verified"
        absence["findings"][0]["evidenceIds"] = [evidence_id]
        _ok, rejected_absence = validate_task_report_v2(
            absence, "inspect", "inspect", root, session,
            {"acceptedFindingIndexes": [0], "reasons": {}, "independence": "independent"},
        )
        assert "absence_without_root_search" in (
            rejected_absence["rejectedFindings"][0]["verification"]["reasons"]
        )
    print("claim validation self-check: PASS")


if __name__ == "__main__":
    _selfcheck()
