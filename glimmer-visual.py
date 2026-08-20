#!/usr/bin/env python3
"""glimmer-visual.py -- C4 (glimmer-v7) capture script for Vision Verification.

Plumbing-only pass (V7 §22; reconciliation doc §9 C4): this script launches a
browser via Playwright, navigates to --url, captures one screenshot per
--viewport, and writes sessions/<id>/visual/visual-manifest.json +
findings.json in the real V7 §22.4 / §22.14 shapes. It does NOT call a
multimodal model in this pass -- see run_vision_model() below for the
documented extension point a future pass wires up.

Read-only w.r.t. the target application/workspace (V7 §22.19 -- Vision
Verifier must be read-only: observe, classify, report; never edit). This
script takes no workspace/repo path at all -- only a network --url (which a
browser merely navigates to) and --output-dir, and it never writes anywhere
outside --output-dir.

glimmer-v2.py invokes this as just another verifier command (see
build_visual_verify_command / classify_visual_check_result in glimmer-v2.py)
when the literal token "visual" is in contract.verification / --verify. It
is not a second pipeline; the existing repair loop drives repairs the same
way it does for typecheck/test/build failures.

REAL PREREQUISITE TO ACTUALLY RUN THIS (not required to import or
py_compile it, and not installed in this environment as of this pass):

    pip install playwright && playwright install

Exit code: 0 whenever the script runs its capture mechanics to completion,
even if every individual viewport capture failed -- per-viewport failures
are recorded in visual-manifest.json (status "partial"/"failed"), not
surfaced as a nonzero exit, because a single flaky viewport is data, not a
process crash. Nonzero exit is reserved for a genuine fatal failure of the
script itself (bad arguments, can't create --output-dir, an exception
escaping the top-level driver). glimmer-v2.py deliberately does not try to
infer INFRA_BLOCKED vs a real finding from this exit code alone -- see
classify_visual_check_result in glimmer-v2.py, which reads this script's
JSON output instead.
"""
import argparse
import base64
import json
import re
import sys
import traceback
from pathlib import Path
from urllib import error, request

DEFAULT_VIEWPORTS = ("1440x900", "390x844")  # V7 §22.6 desktop+mobile minimum
DEFAULT_MODEL_URL = "http://127.0.0.1:8080"
DEFAULT_VISION_TIMEOUT_S = 120

# V7 §22.2 basics -- used only when the caller doesn't pass --check at all.
DEFAULT_CHECKS = (
    "no clipped or cut-off elements",
    "no unexpected overlapping elements",
    "all visible text is readable",
    "no elements rendered outside the viewport",
    "no horizontal overflow",
)

SEVERITY_VALUES = ("low", "medium", "high", "critical")

VISION_SYSTEM_PROMPT = (
    "You are a read-only visual verifier for a web UI screenshot. You "
    "observe; you never edit, and you never invent implementation defects "
    "that are not visible in the image (V7 §22.2). Judge only what is "
    "actually visible in the screenshot: clipping, overflow, overlapping "
    "elements, unreadable/illegible text, elements rendered outside the "
    "viewport, broken layout, hidden or obscured primary actions. Do not "
    "speculate about code, data, or behavior you cannot see.\n\n"
    "Respond with ONLY a single JSON object, no prose, no markdown fence:\n"
    '{"findings": [{"severity": "low|medium|high|critical", "category": '
    '"<short category>", "element": "<what>", "description": "<what is '
    'wrong, in one sentence>"}]}\n\n'
    "findings MUST be [] when every check passes and nothing else is "
    "visibly wrong -- an empty list is a valid, common, correct answer. "
    "Never pad findings to have something to say."
)


def parse_viewport(spec):
    """'1440x900' -> (1440, 900). Raises ValueError on malformed input."""
    w, _, h = spec.lower().partition("x")
    return int(w), int(h)


def _default_capture(url, width, height, out_path, timeout_ms=30000):
    """Real Playwright capture -- launches a browser, sets the viewport,
    navigates to `url`, and screenshots to `out_path`. Imported lazily
    (rather than at module scope) so that argument parsing, manifest/
    findings-shape logic, and this module's own --selfcheck all work
    without playwright installed; only actually calling this function
    requires the dependency. `capture_viewport` injects a different
    `capture_fn` in the self-check to prove the surrounding logic without
    a real browser."""
    from playwright.sync_api import sync_playwright  # pip install playwright && playwright install

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": width, "height": height})
            page.goto(url, timeout=timeout_ms, wait_until="load")
            page.screenshot(path=str(out_path))
        finally:
            browser.close()


def _extract_json_object(text):
    """Best-effort extraction of a single JSON object from the model's
    reply text. Mirrors glimmer-engineer.py's _extract_json_object (not
    imported -- this script is standalone/zero-heavy-deps by design, see
    module docstring): the system prompt asks for bare JSON, but models
    sometimes wrap it in prose or a ```json fence anyway."""
    text = (text or "").strip()
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        pass
    fence_match = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if fence_match:
        try:
            return json.loads(fence_match.group(1))
        except ValueError:
            pass
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except ValueError:
            pass
    raise ValueError("no parseable JSON object found in vision model reply")


def _build_vision_payload(image_b64, route, viewport_slug, checks):
    """Pure request-builder (mirrors glimmer-engineer.py's
    _build_delivery_review_payload split) so a self-check can assert the
    constructed payload has no "tools" key -- omission of that key IS the
    structural, not merely instructed, tool-free guarantee (same
    discipline as C6/the Session Assistant). The image travels as an
    OpenAI-style content part alongside the text contract, per the
    multimodal llama-server's (--mmproj) expected request shape."""
    checks_text = "\n".join(f"- {c}" for c in checks)
    contract_text = (
        f"ROUTE: {route}\n"
        f"VIEWPORT: {viewport_slug}\n"
        f"CHECKS:\n{checks_text}\n\n"
        "Inspect the attached screenshot against the checks above. Report "
        "only what is actually visible in the image."
    )
    return {
        "model": "muse-glimmer",
        "messages": [
            {"role": "system", "content": VISION_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": contract_text},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{image_b64}"},
                    },
                ],
            },
        ],
        "max_tokens": 1024,
    }
    # No "tools"/"tool_choice"/"parallel_tool_calls" key is ever added above.


def _http_post_json(url, payload, timeout_s):
    """glimmer-visual's own minimal stdlib POST helper -- mirrors
    glimmer-engineer.py's http_json in spirit but is not imported from it
    (this script stays standalone, per its module docstring)."""
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with request.urlopen(req, timeout=timeout_s) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw)


def call_vision_model(image_bytes, route, viewport_slug, checks, model_url,
                       timeout_s=DEFAULT_VISION_TIMEOUT_S, post_fn=None):
    """One chat-completions call for one screenshot. Returns the model's
    raw (untrusted) findings list. Raises on any failure -- network error,
    timeout, non-2xx, unparseable JSON, missing/malformed 'findings' key --
    so the caller (run_vision_model) can mark that one viewport BLOCKED
    instead of silently treating a broken call as "reviewed, nothing
    found"."""
    post_fn = post_fn or _http_post_json
    image_b64 = base64.b64encode(image_bytes).decode("ascii")
    payload = _build_vision_payload(image_b64, route, viewport_slug, checks)
    endpoint = model_url.rstrip("/") + "/v1/chat/completions"
    response = post_fn(endpoint, payload, timeout_s)
    content = response["choices"][0]["message"].get("content") or ""
    data = _extract_json_object(content)
    if not isinstance(data, dict):
        raise ValueError("vision model reply is not a JSON object")
    raw_findings = data.get("findings")
    if not isinstance(raw_findings, list):
        raise ValueError("vision model reply missing a 'findings' list")
    return raw_findings


def _coerce_finding(raw, viewport_slug):
    """Tolerant validation of one raw finding dict (mirrors
    validate_delivery_review's coercion conventions in glimmer-engineer.py):
    unknown/missing severity coerces to "low" (never silently escalate);
    a finding with no real (non-empty string) description is dropped
    entirely -- a finding's only substance IS its description, same "don't
    invent dissatisfaction" principle applied to a live model's own
    output. region is optional and dropped (not defaulted/fabricated)
    unless it is present and well-shaped. Returns None for a finding that
    should be dropped."""
    if not isinstance(raw, dict):
        return None
    description = raw.get("description")
    if not isinstance(description, str) or not description.strip():
        return None
    severity = raw.get("severity")
    severity = severity.lower() if isinstance(severity, str) else ""
    if severity not in SEVERITY_VALUES:
        severity = "low"
    category = raw.get("category")
    category = category if isinstance(category, str) and category.strip() else "general"
    element = raw.get("element")
    element = element if isinstance(element, str) else ""
    finding = {
        "severity": severity,
        "category": category,
        "element": element,
        "description": description.strip(),
        "viewport": viewport_slug,
    }
    region = raw.get("region")
    if isinstance(region, dict) and all(
        isinstance(region.get(k), (int, float)) for k in ("x", "y", "width", "height")
    ):
        finding["region"] = {k: region[k] for k in ("x", "y", "width", "height")}
    return finding


def run_vision_model(captures, output_dir, route, checks, model_url,
                      timeout_s=DEFAULT_VISION_TIMEOUT_S, post_fn=None):
    """Real implementation of the extension point C4-plumbing left
    documented-but-stubbed. One chat-completions call per successfully
    captured viewport (a viewport that failed to capture has nothing to
    inspect and is skipped here -- its absence already surfaces via
    visual-manifest.json). Never raises and never fabricates findings on
    failure: any call failure for a viewport (network error, timeout,
    unparseable reply) is caught here and recorded as that viewport being
    "blocked" in the returned reports list, with zero findings contributed
    -- the honest alternative to guessing.

    Returns (findings, reports):
      findings -- flat list across all viewports, V7 §22.4 shape, each
        tagged with its viewport and a sequential "visual_NNN" id assigned
        AFTER aggregation (ids are a property of the combined report, not
        of a single viewport's call).
      reports -- one {"viewport", "status": "reviewed"|"blocked", ["error"]}
        per attempted (captured) viewport, consumed by build_findings to
        compute the overall status.
    """
    findings = []
    reports = []
    output_dir = Path(output_dir)
    for c in captures:
        if c["status"] != "captured":
            continue
        viewport_slug = c["viewport"]
        try:
            image_bytes = (output_dir / c["screenshot"]).read_bytes()
            raw_findings = call_vision_model(
                image_bytes, route, viewport_slug, checks, model_url,
                timeout_s=timeout_s, post_fn=post_fn,
            )
        except Exception as exc:  # noqa: BLE001 -- one viewport's model call must never crash the run or fabricate findings
            reports.append({
                "viewport": viewport_slug,
                "status": "blocked",
                "error": f"{type(exc).__name__}: {exc}",
            })
            continue
        for raw in raw_findings:
            coerced = _coerce_finding(raw, viewport_slug)
            if coerced is not None:
                findings.append(coerced)
        reports.append({"viewport": viewport_slug, "status": "reviewed"})

    for i, f in enumerate(findings, start=1):
        f["id"] = f"visual_{i:03d}"

    return findings, reports


def capture_viewport(url, viewport_spec, output_dir, capture_fn=_default_capture):
    """Capture one viewport. Never raises -- any failure (malformed
    viewport, browser launch failure, navigation timeout, page error) is
    caught here and reported back as a per-viewport failure, so one bad
    viewport can never take down the rest of the run (required: "on ANY
    failure... do not crash the whole script")."""
    slug = viewport_spec.replace(" ", "")
    entry = {"viewport": slug, "screenshot": None, "status": "failed", "error": None}
    try:
        width, height = parse_viewport(viewport_spec)
        out_path = output_dir / f"{slug}.png"
        capture_fn(url, width, height, out_path)
        entry["screenshot"] = out_path.name
        entry["status"] = "captured"
    except Exception as exc:  # noqa: BLE001 -- deliberately broad: one viewport must never crash the run
        entry["error"] = f"{type(exc).__name__}: {exc}"
    return entry


def build_manifest(url, captures, states=("initial",)):
    """V7 §22.14 visual-manifest.json shape (route/viewports/states/status),
    extended with a `captures` array carrying per-viewport success/failure
    (required: "summarizing what was captured, including per-viewport
    success/failure"). status is "pass" only when every requested viewport
    was captured; "partial" when some were; "failed" when none were (or
    none were requested)."""
    ok = [c for c in captures if c["status"] == "captured"]
    if captures and len(ok) == len(captures):
        overall = "pass"
    elif ok:
        overall = "partial"
    else:
        overall = "failed"
    return {
        "route": url,
        "viewports": [c["viewport"] for c in captures],
        "states": list(states),
        "status": overall,
        "captures": captures,
        "findings": [],
    }


def build_findings(captures, findings=None, reports=None):
    """V7 §22.4 findings.json shape: {status, viewport, findings[]}.

    `reports=None` (the default) is the exact pre-C4-live-vision behavior
    -- --vision was never passed, run_vision_model never ran, and this
    function's logic is byte-for-byte what it was before this pass:
      - "NOT_RUN" when every viewport was captured cleanly. "Capture
        succeeded" and "review passed" are two different facts -- `PASS`
        would tell a downstream reader "this UI was visually inspected,
        found fine," which is false when findings[] is empty because
        nothing looked, not because something looked and found nothing.
      - "FAIL" when capture failed for every viewport -- there is nothing
        for even a model step to inspect, so this cannot honestly be
        anything else.
    This is the zero-behavior-change guarantee for every existing caller
    that doesn't pass --vision: identical inputs, identical output.

    `reports` (a list from run_vision_model, one entry per attempted
    viewport) means vision WAS run; status is now real, per V7 §22.4/22.5:
      - no reports at all (vision opted in, but nothing was even
        capture-successful enough to attempt) -> "BLOCKED": nothing was
        reviewed, which is not the same fact as "reviewed, clean."
      - any critical/high finding -> "FAIL" (checked first: a confirmed
        real defect is more actionable than an infra gap elsewhere).
      - else, any viewport whose model call itself failed -> "BLOCKED"
        (honest "couldn't tell," never silently dropped).
      - else, any low/medium finding -> "PASS_WITH_WARNINGS".
      - else (every viewport reviewed, no findings at all) -> "PASS".

    `viewport` is "multi" (rather than V7 §22.4's single-viewport string
    example) because this script captures the full requested viewport set
    per run; `viewports` carries the real list.
    """
    if reports is None:
        findings = findings if findings is not None else []
        ok = [c for c in captures if c["status"] == "captured"]
        status = "NOT_RUN" if (captures and ok) else "FAIL"
        return {
            "status": status,
            "viewport": "multi",
            "viewports": [c["viewport"] for c in captures],
            "findings": findings,
        }

    findings = findings if findings is not None else []
    severities = {f.get("severity") for f in findings}
    blocked_viewports = [r["viewport"] for r in reports if r["status"] == "blocked"]
    reviewed_viewports = [r["viewport"] for r in reports if r["status"] == "reviewed"]

    if not reports:
        status = "BLOCKED"
    elif severities & {"critical", "high"}:
        status = "FAIL"
    elif blocked_viewports:
        status = "BLOCKED"
    elif severities & {"low", "medium"}:
        status = "PASS_WITH_WARNINGS"
    else:
        status = "PASS"

    return {
        "status": status,
        "viewport": "multi",
        "viewports": [c["viewport"] for c in captures],
        "reviewed": reviewed_viewports,
        "blocked": blocked_viewports,
        "findings": findings,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Glimmer C4 visual capture (plumbing-only: capture + manifest, no live model call yet)"
    )
    ap.add_argument("--url", required=True, help="URL Playwright navigates to")
    ap.add_argument("--viewport", action="append", default=None,
                     help="WxH, e.g. 1440x900. Repeatable. Defaults to "
                          f"{'+'.join(DEFAULT_VIEWPORTS)} (V7 §22.6 desktop+mobile minimum) if omitted.")
    ap.add_argument("--output-dir", required=True,
                     help="Directory this script writes to. Never reads or writes anything outside it.")
    ap.add_argument("--vision", action="store_true",
                     help="Opt-in: after capture, send each screenshot to the multimodal "
                          "model for real review. Without this flag, behavior is exactly "
                          "as before -- capture-only, findings.json status NOT_RUN.")
    ap.add_argument("--model-url", default=DEFAULT_MODEL_URL,
                     help=f"Base URL of the multimodal llama-server. Default {DEFAULT_MODEL_URL}.")
    ap.add_argument("--check", action="append", default=None,
                     help="A V7 §22.3 contract check, e.g. "
                          '"primary button fully visible". Repeatable. Defaults to a small '
                          "set covering V7 §22.2 basics (clipping/overlap/unreadable text/"
                          "off-viewport elements/horizontal overflow) if omitted.")
    ap.add_argument("--vision-timeout", type=float, default=DEFAULT_VISION_TIMEOUT_S,
                     help=f"Per-viewport model call timeout in seconds. Default {DEFAULT_VISION_TIMEOUT_S}.")
    args = ap.parse_args(argv)

    viewports = args.viewport or list(DEFAULT_VIEWPORTS)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    captures = [capture_viewport(args.url, vp, output_dir) for vp in viewports]

    manifest = build_manifest(args.url, captures)
    (output_dir / "visual-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    if args.vision:
        checks = args.check or list(DEFAULT_CHECKS)
        findings, reports = run_vision_model(
            captures, output_dir, args.url, checks, args.model_url,
            timeout_s=args.vision_timeout,
        )
        findings_doc = build_findings(captures, findings, reports)
    else:
        findings_doc = build_findings(captures)
    (output_dir / "findings.json").write_text(json.dumps(findings_doc, indent=2), encoding="utf-8")

    ok_count = sum(1 for c in captures if c["status"] == "captured")
    print(f"[glimmer-visual] captured {ok_count}/{len(captures)} viewport(s)")
    print(f"[glimmer-visual] manifest: {output_dir / 'visual-manifest.json'}")
    print(f"[glimmer-visual] findings ({findings_doc['status']}): {output_dir / 'findings.json'}")
    return 0


def _selfcheck() -> None:
    """python3 glimmer-visual.py --selfcheck

    Proves argument parsing, manifest/findings shape, and per-viewport
    failure isolation without requiring playwright or a real browser --
    `capture_viewport` takes an injectable `capture_fn`, and this exercises
    the same code `main()` composes (capture_viewport / build_manifest /
    build_findings) with fake success/failure capture functions."""
    import tempfile

    assert parse_viewport("1440x900") == (1440, 900)
    assert parse_viewport("390X844") == (390, 844)
    try:
        parse_viewport("bogus")
        assert False, "expected ValueError"
    except ValueError:
        pass

    with tempfile.TemporaryDirectory() as td:
        out = Path(td)

        def fake_ok(url, w, h, out_path):
            out_path.write_bytes(b"PNG-stub")

        def fake_fail(url, w, h, out_path):
            raise RuntimeError("navigation timeout")

        c_ok = capture_viewport("http://x", "1440x900", out, capture_fn=fake_ok)
        c_fail = capture_viewport("http://x", "390x844", out, capture_fn=fake_fail)
        assert c_ok["status"] == "captured" and c_ok["screenshot"] == "1440x900.png"
        assert c_fail["status"] == "failed" and "navigation timeout" in c_fail["error"]
        assert (out / "1440x900.png").exists()
        assert not (out / "390x844.png").exists(), "a failed viewport must not leave a screenshot file"

        # A malformed viewport spec must also be isolated, not crash the run.
        c_bad = capture_viewport("http://x", "not-a-viewport", out, capture_fn=fake_ok)
        assert c_bad["status"] == "failed" and c_bad["screenshot"] is None

        manifest = build_manifest("http://x/route", [c_ok, c_fail])
        assert manifest["status"] == "partial"
        assert manifest["route"] == "http://x/route"
        assert manifest["viewports"] == ["1440x900", "390x844"]
        assert manifest["captures"][0]["status"] == "captured"
        assert manifest["captures"][1]["status"] == "failed"
        assert set(manifest.keys()) >= {"route", "viewports", "states", "status", "findings"}

        assert build_manifest("http://x", [c_ok])["status"] == "pass"
        assert build_manifest("http://x", [c_fail])["status"] == "failed"
        assert build_manifest("http://x", [])["status"] == "failed"

        # findings.json shape (V7 §22.4): status/viewport/findings, empty
        # findings in this pass regardless of capture outcome (no model call).
        findings_pass = build_findings([c_ok])
        # Fix round 1: capture succeeding is NOT the same fact as "reviewed,
        # fine" -- status must be NOT_RUN (not PASS) since no semantic
        # review ran (findings[] is empty because nothing looked, not
        # because something looked and found nothing).
        assert findings_pass["status"] == "NOT_RUN"
        assert findings_pass["findings"] == []
        assert set(findings_pass.keys()) >= {"status", "viewport", "findings"}

        findings_fail = build_findings([c_fail])
        assert findings_fail["status"] == "FAIL"

        # --- zero-behavior-change proof: --vision absent means main() calls
        # build_findings(captures) with no findings/reports args at all, the
        # exact same call shape as findings_pass/findings_fail above. This
        # IS the whole proof -- no other codepath exists for --vision absent.
        assert build_findings([c_ok])["status"] == "NOT_RUN"
        assert build_findings([c_fail])["status"] == "FAIL"

        # --- request construction: toolless, image part + checks text present ---
        payload = _build_vision_payload("QkFTRTY0", "http://x/route", "1440x900", DEFAULT_CHECKS)
        assert "tools" not in payload and "tool_choice" not in payload
        user_content = payload["messages"][1]["content"]
        assert user_content[0]["type"] == "text"
        assert "1440x900" in user_content[0]["text"]
        assert all(c in user_content[0]["text"] for c in DEFAULT_CHECKS)
        assert user_content[1] == {
            "type": "image_url",
            "image_url": {"url": "data:image/png;base64,QkFTRTY0"},
        }
        assert payload["messages"][0]["role"] == "system"

        # --- finding coercion (mirrors validate_delivery_review's tolerant
        # conventions): unknown severity -> "low", missing/blank description
        # dropped, well-shaped region kept, malformed region dropped. ---
        good = _coerce_finding(
            {"severity": "high", "category": "clipping", "element": "btn", "description": "cut off"},
            "1440x900",
        )
        assert good["severity"] == "high" and good["viewport"] == "1440x900" and "id" not in good

        unknown_sev = _coerce_finding({"severity": "nonsense", "description": "weird"}, "1440x900")
        assert unknown_sev["severity"] == "low"

        assert _coerce_finding({"severity": "high"}, "1440x900") is None, "no description -> dropped"
        assert _coerce_finding({"severity": "high", "description": "   "}, "1440x900") is None
        assert _coerce_finding("not-a-dict", "1440x900") is None

        with_region = _coerce_finding(
            {"description": "x", "region": {"x": 1, "y": 2, "width": 3, "height": 4}}, "1440x900"
        )
        assert with_region["region"] == {"x": 1, "y": 2, "width": 3, "height": 4}

        bad_region = _coerce_finding(
            {"description": "x", "region": {"x": 1, "y": "not-a-number"}}, "1440x900"
        )
        assert "region" not in bad_region, "malformed region must be dropped, not fabricated"

        # --- run_vision_model: good reply, malformed reply, call failure --
        # (synthetic post_fn, no live model / network call).
        def fake_post_good(url, payload, timeout_s):
            body = json.dumps({"findings": [
                {"severity": "critical", "category": "clipping", "element": "cta",
                 "description": "primary button below the fold"},
                {"severity": "weird", "description": "unknown severity coerces"},
                {"severity": "low", "description": "   "},  # blank -> dropped
            ]})
            return {"choices": [{"message": {"content": body}}]}

        def fake_post_malformed(url, payload, timeout_s):
            return {"choices": [{"message": {"content": "not json at all, sorry"}}]}

        def fake_post_error(url, payload, timeout_s):
            raise TimeoutError("simulated model call timeout")

        findings_good, reports_good = run_vision_model(
            [c_ok], out, "http://x/route", DEFAULT_CHECKS, "http://model",
            post_fn=fake_post_good,
        )
        assert len(findings_good) == 2, "the blank-description finding must be dropped"
        assert findings_good[0]["id"] == "visual_001" and findings_good[1]["id"] == "visual_002"
        assert findings_good[0]["severity"] == "critical"
        assert findings_good[1]["severity"] == "low", "unknown severity coerces to low"
        assert all(f["viewport"] == "1440x900" for f in findings_good)
        assert reports_good == [{"viewport": "1440x900", "status": "reviewed"}]

        findings_bad, reports_bad = run_vision_model(
            [c_ok], out, "http://x/route", DEFAULT_CHECKS, "http://model",
            post_fn=fake_post_malformed,
        )
        assert findings_bad == [], "an unparseable reply must never fabricate findings"
        assert reports_bad[0]["status"] == "blocked" and "error" in reports_bad[0]

        findings_err, reports_err = run_vision_model(
            [c_ok], out, "http://x/route", DEFAULT_CHECKS, "http://model",
            post_fn=fake_post_error,
        )
        assert findings_err == []
        assert reports_err[0]["status"] == "blocked"
        assert "TimeoutError" in reports_err[0]["error"]

        # A viewport that never captured is skipped entirely (nothing to
        # send the model), never reported as blocked.
        findings_skip, reports_skip = run_vision_model(
            [c_fail], out, "http://x/route", DEFAULT_CHECKS, "http://model",
            post_fn=fake_post_good,
        )
        assert findings_skip == [] and reports_skip == []

        # --- status aggregation (build_findings with reports=vision-ran) --
        reviewed = [{"viewport": "1440x900", "status": "reviewed"}]
        blocked = [{"viewport": "390x844", "status": "blocked", "error": "x"}]

        assert build_findings([c_ok], [], reviewed)["status"] == "PASS"
        assert build_findings([c_ok], [{"severity": "low", "description": "x", "viewport": "1440x900"}], reviewed)["status"] == "PASS_WITH_WARNINGS"
        assert build_findings([c_ok], [{"severity": "medium", "description": "x", "viewport": "1440x900"}], reviewed)["status"] == "PASS_WITH_WARNINGS"
        assert build_findings([c_ok], [{"severity": "high", "description": "x", "viewport": "1440x900"}], reviewed)["status"] == "FAIL"
        assert build_findings([c_ok], [{"severity": "critical", "description": "x", "viewport": "1440x900"}], reviewed)["status"] == "FAIL"
        assert build_findings([c_ok, c_fail], [], reviewed + blocked)["status"] == "BLOCKED"
        assert build_findings(
            [c_ok, c_fail],
            [{"severity": "critical", "description": "x", "viewport": "1440x900"}],
            reviewed + blocked,
        )["status"] == "FAIL", "a confirmed real defect outranks an unrelated infra gap"
        assert build_findings([], [], [])["status"] == "BLOCKED", "vision opted in but nothing reviewable"

    print("glimmer-visual.py self-check: PASS")


if __name__ == "__main__":
    if sys.argv[1:] == ["--selfcheck"]:
        _selfcheck()
        sys.exit(0)
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)
