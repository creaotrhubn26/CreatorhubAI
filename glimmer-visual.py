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
import json
import sys
import traceback
from pathlib import Path

DEFAULT_VIEWPORTS = ("1440x900", "390x844")  # V7 §22.6 desktop+mobile minimum


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


def run_vision_model(screenshot_names, viewports, contract=None):
    """Extension point for a future pass, deliberately NOT implemented here
    (out of scope for C4-plumbing-only, per the reconciliation doc: no live
    model call in this pass). A future pass would send the captured
    screenshots in `screenshot_names` (filenames under --output-dir) to the
    existing multimodal llama-server, using `contract` (V7 §22.3's
    visual_verification contract -- route/state/viewport/checks) to scope
    the review, and return a findings[] list in the exact V7 §22.4 shape
    (id/severity/category/element/description/region), severity classified
    per V7 §22.5. Always returns [] today -- this is what makes today's
    findings.json honestly say "nothing was inspected" rather than
    fabricating a clean bill of health."""
    return []


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


def build_findings(captures, findings=None):
    """V7 §22.4 findings.json shape: {status, viewport, findings[]}.

    `status` here reflects ONLY capture success/failure, since no model
    inspection ran in this pass (run_vision_model is not wired up yet):
      - "NOT_RUN" when every viewport was captured cleanly. "Capture
        succeeded" and "review passed" are two different facts -- `PASS`
        would tell a downstream reader "this UI was visually inspected,
        found fine," which is false: findings[] is always [] because no
        semantic review ever ran, not because one ran and found nothing.
        "Capture succeeded" already has its own honest home in
        visual-manifest.json's status; NOT_RUN is the real, V7
        §22.4-sanctioned value for "not reviewed" as distinct from
        "reviewed, fine." PASS/FAIL are reserved for once run_vision_model
        is actually wired up and produces real findings.
      - "FAIL" when capture failed for every viewport -- there is nothing
        for even a future model step to inspect, so this cannot honestly
        be anything else.
    `viewport` is "multi" (rather than V7 §22.4's single-viewport string
    example) because this script captures the full requested viewport set
    per run; `viewports` carries the real list.
    `findings` is always [] in this pass -- see run_vision_model.
    """
    findings = findings if findings is not None else []
    ok = [c for c in captures if c["status"] == "captured"]
    status = "NOT_RUN" if (captures and ok) else "FAIL"
    return {
        "status": status,
        "viewport": "multi",
        "viewports": [c["viewport"] for c in captures],
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
    args = ap.parse_args(argv)

    viewports = args.viewport or list(DEFAULT_VIEWPORTS)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    captures = [capture_viewport(args.url, vp, output_dir) for vp in viewports]

    manifest = build_manifest(args.url, captures)
    (output_dir / "visual-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    shot_names = [c["screenshot"] for c in captures if c["screenshot"]]
    findings_doc = build_findings(captures, run_vision_model(shot_names, viewports))
    (output_dir / "findings.json").write_text(json.dumps(findings_doc, indent=2), encoding="utf-8")

    ok_count = sum(1 for c in captures if c["status"] == "captured")
    print(f"[glimmer-visual] captured {ok_count}/{len(captures)} viewport(s)")
    print(f"[glimmer-visual] manifest: {output_dir / 'visual-manifest.json'}")
    print(f"[glimmer-visual] findings: {output_dir / 'findings.json'}")
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

        assert run_vision_model(["1440x900.png"], ["1440x900"]) == []

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
