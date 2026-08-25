#!/usr/bin/env python3
"""glimmer-visual.py -- C4 (glimmer-v7) capture + vision-review script.

This script launches a browser via Playwright, navigates to --url, captures
one screenshot per --viewport, and writes sessions/<id>/visual/
visual-manifest.json + findings.json in the real V7 §22.4 / §22.14 shapes.
Capture always runs. With --vision (opt-in), each captured screenshot is
also sent to the multimodal llama-server (--model-url) for a real V7 §22.2/
22.3 review -- see run_vision_model() below. Without --vision, behavior is
capture-only: findings.json status stays honestly NOT_RUN.

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
from urllib import request

DEFAULT_VIEWPORTS = ("1440x900", "390x844")  # V7 §22.6 desktop+mobile minimum
DEFAULT_MODEL_URL = "http://127.0.0.1:8080"
DEFAULT_MODEL_ID = "muse-glimmer"
DEFAULT_VISION_TIMEOUT_S = 120

# Same convention as glimmer-engineer.py's API_KEY_FILE/api_key() (mirrored,
# not imported -- this script stays standalone, per the module docstring):
# llama-server is started with --api-key reading this same file
# (start-glimmer-agent.sh), so vision calls need the identical
# Authorization: Bearer <key> header engineer's http_json already sends.
DEFAULT_API_KEY_FILE = Path.home() / "AI/muse-glimmer/config/api-key.txt"

# V7 §22.2 basics -- used only when the caller doesn't pass --check at all.
DEFAULT_CHECKS = (
    "no clipped or cut-off elements",
    "no unexpected overlapping elements",
    "all visible text is readable",
    "no elements rendered outside the viewport",
    "no horizontal overflow",
)

SEVERITY_VALUES = ("low", "medium", "high", "critical")

# V7 §22.7 workflow-state verification: --states-file is trusted session-
# artifact config (built by a prior orchestrator step), not model-freeform
# text -- still capped defensively (fail loud beyond the cap) so a
# malformed/runaway config file can't turn one capture run into an
# unbounded number of browser actions.
MAX_STATES = 10
MAX_ACTIONS_PER_STATE = 10
STATE_ACTIONS = ("click", "wait")

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


def load_states_file(path):
    """Parse + strictly validate a --states-file JSON document (V7 §22.7):
    a JSON array of `{"name": str, "actions": [{"action": "click",
    "selector": str} | {"action": "wait", "ms": number}]}` objects,
    executed via Playwright in order before each state's screenshot.

    This is trusted session-artifact config a prior orchestrator step
    built (not model-freeform text), so it fails LOUD (raises ValueError)
    on any structural problem instead of tolerating it -- the opposite
    discipline from _coerce_finding's tolerant handling of the vision
    model's own untrusted JSON output.

    "initial" is always the first state and always capture-only (no
    actions): any user-supplied "initial" entry is dropped rather than
    merged, so the very first capture is always the plain, untouched page
    load no matter what the config file says.

    Fix round 3: every state name is slugified (`re.sub(r"[^a-z0-9]+",
    "-", name.lower()).strip("-")`) before being stored -- the stored
    "name" IS the slug, so manifest.states / capture "state" / finding
    tags / the "{viewport}-{state}.png" filename below all derive from
    this one normalized value and can never disagree. This also closes a
    latent write-side path-traversal: an unslugified name containing "/"
    or ".." would otherwise land straight in a filename under
    --output-dir. Empty-after-slug and duplicate slugs (including a name
    that only slugifies down to the reserved "initial") both raise --
    trusted config, fail loud rather than silently collide/drop.
    """
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("--states-file must contain a JSON array of state objects")

    states = [{"name": "initial", "actions": []}]
    seen_slugs = {"initial"}
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ValueError(f"--states-file[{i}]: each state must be a JSON object")
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"--states-file[{i}]: 'name' must be a non-empty string")
        if name == "initial":
            continue  # always synthesized above, first, action-free

        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        if not slug:
            raise ValueError(f"--states-file[{i}]: 'name' {name!r} has no valid characters after slugifying")
        if slug in seen_slugs:
            raise ValueError(f"--states-file[{i}]: duplicate state slug {slug!r} (from name {name!r})")
        seen_slugs.add(slug)

        actions_raw = entry.get("actions", [])
        if not isinstance(actions_raw, list):
            raise ValueError(f"--states-file[{i}] ({name!r}): 'actions' must be a list")
        if len(actions_raw) > MAX_ACTIONS_PER_STATE:
            raise ValueError(
                f"--states-file[{i}] ({name!r}): at most {MAX_ACTIONS_PER_STATE} "
                f"actions allowed, got {len(actions_raw)}"
            )

        actions = []
        for j, act in enumerate(actions_raw):
            if not isinstance(act, dict):
                raise ValueError(f"--states-file[{i}] ({name!r}).actions[{j}]: must be a JSON object")
            kind = act.get("action")
            if kind not in STATE_ACTIONS:
                raise ValueError(
                    f"--states-file[{i}] ({name!r}).actions[{j}]: 'action' must be one of {STATE_ACTIONS}"
                )
            if kind == "click":
                selector = act.get("selector")
                if not isinstance(selector, str) or not selector.strip():
                    raise ValueError(
                        f"--states-file[{i}] ({name!r}).actions[{j}]: 'click' requires a non-empty 'selector'"
                    )
                actions.append({"action": "click", "selector": selector})
            else:  # "wait"
                ms = act.get("ms")
                if not isinstance(ms, (int, float)) or isinstance(ms, bool) or ms <= 0:
                    raise ValueError(
                        f"--states-file[{i}] ({name!r}).actions[{j}]: 'wait' requires a positive numeric 'ms'"
                    )
                actions.append({"action": "wait", "ms": ms})

        states.append({"name": slug, "actions": actions})
        if len(states) > MAX_STATES:
            raise ValueError(f"--states-file: at most {MAX_STATES} states allowed (including 'initial')")

    return states


def _unique(seq):
    """Order-preserving de-dup -- e.g. a viewport appears once per state in
    a multi-state `captures` list, but a manifest/findings summary field
    should still list each viewport once."""
    return list(dict.fromkeys(seq))


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


def _build_vision_payload(image_b64, route, viewport_slug, checks, state="initial", model_id=DEFAULT_MODEL_ID):
    """Pure request-builder (mirrors glimmer-engineer.py's
    _build_delivery_review_payload split) so a self-check can assert the
    constructed payload has no "tools" key -- omission of that key IS the
    structural, not merely instructed, tool-free guarantee (same
    discipline as C6/the Session Assistant). The image travels as an
    OpenAI-style content part alongside the text contract, per the
    multimodal llama-server's (--mmproj) expected request shape.

    `state` (V7 §22.7 workflow-state verification) defaults to "initial"
    for every pre-3.3 caller -- adding the STATE line is additive text,
    never a behavior change for a single-state capture."""
    checks_text = "\n".join(f"- {c}" for c in checks)
    contract_text = (
        f"ROUTE: {route}\n"
        f"VIEWPORT: {viewport_slug}\n"
        f"STATE: {state}\n"
        f"CHECKS:\n{checks_text}\n\n"
        "Inspect the attached screenshot against the checks above. Report "
        "only what is actually visible in the image."
    )
    return {
        "model": model_id,
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


def _read_api_key(path):
    """Never raises. '' when the file is missing/unreadable/blank -- a
    server started with no --api-key must still work, so a missing key
    file degrades to "send no Authorization header", not a crash."""
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _auth_headers(api_key_text):
    """{'Authorization': 'Bearer <key>'} when api_key_text is non-empty,
    else {} -- same header glimmer-engineer.py's http_json always sends
    (API_KEY_FILE / api_key()), applied here only when a key was actually
    found."""
    if api_key_text:
        return {"Authorization": f"Bearer {api_key_text}"}
    return {}


def _http_post_json(url, payload, timeout_s, headers=None):
    """glimmer-visual's own minimal stdlib POST helper -- mirrors
    glimmer-engineer.py's http_json in spirit but is not imported from it
    (this script stays standalone, per its module docstring)."""
    data = json.dumps(payload).encode("utf-8")
    req_headers = {"Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)
    req = request.Request(url, data=data, headers=req_headers, method="POST")
    with request.urlopen(req, timeout=timeout_s) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw)


def _model_endpoint_url(model_url):
    """Accept both an origin and a standard OpenAI ``.../v1`` base URL."""
    base = model_url.rstrip("/")
    return base + ("/chat/completions" if base.endswith("/v1") else "/v1/chat/completions")


# Round 6 (V7 §16/§31, glimmer-engineer.py's ModelProvider/MODEL_ROLES):
# this is a SEPARATE model-runtime provider from glimmer-engineer.py's, by
# design -- this script stays standalone (see the module docstring above).
# `model_url` here (a plain CLI arg, not looked up in MODEL_ROLES) already
# IS this provider's routing seam: whoever invokes glimmer-visual.py picks
# the vision endpoint per call, same effect as a "vision" role would have.
def call_vision_model(image_bytes, route, viewport_slug, checks, model_url,
                       timeout_s=DEFAULT_VISION_TIMEOUT_S, post_fn=None, api_key_text=None,
                       state="initial", model_id=DEFAULT_MODEL_ID):
    """One chat-completions call for one screenshot. Returns the model's
    raw (untrusted) findings list. Raises on any failure -- network error,
    timeout, non-2xx (401 included -- a missing/wrong Authorization header
    against a --api-key server fails here like any other bad call), unparseable
    JSON, missing/malformed 'findings' key -- so the caller (run_vision_model)
    can mark that one viewport BLOCKED instead of silently treating a
    broken call as "reviewed, nothing found". `state` (V7 §22.7) defaults
    to "initial", same zero-behavior-change default as _build_vision_payload."""
    post_fn = post_fn or _http_post_json
    # ponytail: no size guard on the base64-encoded PNG here -- a
    # pathologically large screenshot just makes a slow/failing HTTP POST,
    # which already degrades honestly to that viewport's report being
    # "blocked" (see the except below), same as any other call failure.
    # Add an explicit size cap before base64-encoding if a real capture
    # ever produces multi-tens-of-MB screenshots in practice.
    image_b64 = base64.b64encode(image_bytes).decode("ascii")
    payload = _build_vision_payload(
        image_b64, route, viewport_slug, checks, state=state, model_id=model_id
    )
    endpoint = _model_endpoint_url(model_url)
    response = post_fn(endpoint, payload, timeout_s, _auth_headers(api_key_text))
    content = response["choices"][0]["message"].get("content") or ""
    data = _extract_json_object(content)
    if not isinstance(data, dict):
        raise ValueError("vision model reply is not a JSON object")
    raw_findings = data.get("findings")
    if not isinstance(raw_findings, list):
        raise ValueError("vision model reply missing a 'findings' list")
    return raw_findings


def _coerce_finding(raw, viewport_slug, state="initial"):
    """Tolerant validation of one raw finding dict (mirrors
    validate_delivery_review's coercion conventions in glimmer-engineer.py):
    unknown/missing severity coerces to "low" (never silently escalate);
    a finding with no real (non-empty string) description is dropped
    entirely -- a finding's only substance IS its description, same "don't
    invent dissatisfaction" principle applied to a live model's own
    output. region is optional and dropped (not defaulted/fabricated)
    unless it is present and well-shaped. Returns None for a finding that
    should be dropped. `state` (V7 §22.7) defaults to "initial" -- every
    pre-3.3 caller gets the exact same finding shape plus one additive key."""
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
        "state": state,
    }
    region = raw.get("region")
    if isinstance(region, dict) and all(
        isinstance(region.get(k), (int, float)) for k in ("x", "y", "width", "height")
    ):
        finding["region"] = {k: region[k] for k in ("x", "y", "width", "height")}
    return finding


def run_vision_model(captures, output_dir, route, checks, model_url,
                      timeout_s=DEFAULT_VISION_TIMEOUT_S, post_fn=None, api_key_text=None,
                      model_id=DEFAULT_MODEL_ID):
    """Real implementation of the extension point C4-plumbing left
    documented-but-stubbed. One chat-completions call per successfully
    captured (viewport, state) pair -- V7 §22.7: a capture entry with no
    "state" key (every pre-3.3 caller, i.e. capture_viewport's plain
    single-state output) defaults to "initial", so this is a zero-
    behavior-change extension for any caller that never uses
    --states-file. A pair that failed to capture has nothing to inspect
    and is skipped here -- its absence already surfaces via
    visual-manifest.json. Never raises and never fabricates findings on
    failure: any call failure (network error, timeout, unparseable
    reply) is caught here and recorded as that pair being "blocked" in
    the returned reports list, with zero findings contributed -- the
    honest alternative to guessing.

    Returns (findings, reports):
      findings -- flat list across all viewports/states, V7 §22.4 shape,
        each tagged with its viewport + state and a sequential
        "visual_NNN" id assigned AFTER aggregation (ids are a property of
        the combined report, not of a single call).
      reports -- one {"viewport", "state", "status": "reviewed"|"blocked",
        ["error"]} per attempted (captured) pair, consumed by
        build_findings to compute the overall status.
    """
    findings = []
    reports = []
    output_dir = Path(output_dir)
    for c in captures:
        if c["status"] != "captured":
            continue
        viewport_slug = c["viewport"]
        state = c.get("state", "initial")
        try:
            image_bytes = (output_dir / c["screenshot"]).read_bytes()
            raw_findings = call_vision_model(
                image_bytes, route, viewport_slug, checks, model_url,
                timeout_s=timeout_s, post_fn=post_fn, api_key_text=api_key_text,
                state=state, model_id=model_id,
            )
        except Exception as exc:  # noqa: BLE001 -- one call must never crash the run or fabricate findings
            reports.append({
                "viewport": viewport_slug,
                "state": state,
                "status": "blocked",
                "error": f"{type(exc).__name__}: {exc}",
            })
            continue
        for raw in raw_findings:
            coerced = _coerce_finding(raw, viewport_slug, state=state)
            if coerced is not None:
                findings.append(coerced)
        reports.append({"viewport": viewport_slug, "state": state, "status": "reviewed"})

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


def _default_capture_states(url, width, height, output_dir, viewport_slug, states, timeout_ms=30000):
    """Real Playwright multi-state capture for one viewport (V7 §22.7):
    navigates once, then walks `states` (as produced by load_states_file)
    in order, replaying each state's actions before screenshotting to
    output_dir/{viewport_slug}-{state name}.png. Imported lazily, same
    reason as _default_capture -- py_compile/--selfcheck never need
    playwright installed.

    Returns (captured, error): `captured` is the list of {"name",
    "screenshot"} dicts actually written to disk, in state order, up to
    (not including) whichever state first failed; `error` is that
    failure's message, or None when every state captured cleanly. A
    per-state action/screenshot failure is caught HERE (not left to
    propagate) specifically so states captured before the failure keep
    their real, already-on-disk screenshots instead of being reported as
    failed alongside the one that actually broke. A failure before any
    state is reached (bad viewport spec, browser launch, navigation) has
    nothing partial to report and is allowed to propagate to the caller
    (capture_viewport_states), which has its own top-level catch."""
    from playwright.sync_api import sync_playwright  # pip install playwright && playwright install

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": width, "height": height})
            page.goto(url, timeout=timeout_ms, wait_until="load")
            captured = []
            for state in states:
                try:
                    for action in state["actions"]:
                        if action["action"] == "click":
                            page.click(action["selector"], timeout=timeout_ms)
                        else:  # "wait"
                            page.wait_for_timeout(action["ms"])
                    filename = f"{viewport_slug}-{state['name']}.png"
                    page.screenshot(path=str(output_dir / filename))
                    captured.append({"name": state["name"], "screenshot": filename})
                except Exception as exc:  # noqa: BLE001 -- one state's action must not lose earlier states' captures
                    return captured, f"{type(exc).__name__}: {exc}"
            return captured, None
        finally:
            browser.close()


def capture_viewport_states(url, viewport_spec, output_dir, states, capture_fn=_default_capture_states):
    """Multi-state capture for one viewport (V7 §22.7 workflow-state
    verification): one browser session walks `states` in order (each
    replaying its own actions before its screenshot), producing one
    capture entry per state. Never raises -- a malformed viewport spec,
    browser/navigation failure, or a mid-run action failure all degrade
    to per-state "failed" entries (states already captured before a
    mid-run failure keep their "captured" entries; every state from the
    failure point on is reported "failed" with that failure's error), so
    one broken interaction can never take down the rest of the run or
    crash the whole script -- same isolation contract as capture_viewport."""
    slug = viewport_spec.replace(" ", "")
    try:
        width, height = parse_viewport(viewport_spec)
        captured, error = capture_fn(url, width, height, output_dir, slug, states)
    except Exception as exc:  # noqa: BLE001 -- malformed viewport / browser launch / pre-first-state navigation failure
        captured, error = [], f"{type(exc).__name__}: {exc}"

    done = {c["name"]: c["screenshot"] for c in captured}
    entries = []
    for state in states:
        name = state["name"]
        if name in done:
            entries.append({"viewport": slug, "state": name, "screenshot": done[name],
                             "status": "captured", "error": None})
        else:
            entries.append({"viewport": slug, "state": name, "screenshot": None,
                             "status": "failed", "error": error})
    return entries


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
        "viewports": _unique(c["viewport"] for c in captures),
        "states": list(states),
        "status": overall,
        "captures": captures,
        "findings": [],
    }


def build_findings(captures, findings=None, reports=None):
    """V7 §22.4 findings.json shape: {status, viewport, findings[]}.

    `reports=None` (the default) is the exact pre-C4-live-vision behavior
    -- --vision was never passed, run_vision_model never ran:
      - "NOT_RUN" when every viewport was captured cleanly. "Capture
        succeeded" and "review passed" are two different facts -- `PASS`
        would tell a downstream reader "this UI was visually inspected,
        found fine," which is false when findings[] is empty because
        nothing looked, not because something looked and found nothing.
      - "BLOCKED" (fix round 3; was "FAIL") when capture failed for every
        viewport -- an infra gap (nothing was even capturable), not a
        confirmed real defect, so it gets the same "couldn't tell" status
        as the reports-ran total-capture-failure case just below, not the
        severity-bearing "FAIL" a real reviewed defect uses. Consumers
        checked: classify_visual_check_result (glimmer-v2.py) never
        reads this literal in the total-capture-failure case -- it
        already short-circuits to INFRA_BLOCKED off visual-manifest.
        json's own status before findings.json is even opened -- and
        the Control Center panel (StatusBadge) already has a color for
        "BLOCKED".

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
        status = "NOT_RUN" if (captures and ok) else "BLOCKED"
        return {
            "status": status,
            "viewport": "multi",
            "viewports": _unique(c["viewport"] for c in captures),
            "findings": findings,
        }

    findings = findings if findings is not None else []
    severities = {f.get("severity") for f in findings}
    # _unique: a multi-state run reports the same viewport once per state
    # (V7 §22.7) -- these are viewport SUMMARY fields, so de-dup rather
    # than repeating a viewport once per state it was reviewed/blocked in.
    blocked_viewports = _unique(r["viewport"] for r in reports if r["status"] == "blocked")
    reviewed_viewports = _unique(r["viewport"] for r in reports if r["status"] == "reviewed")

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
        "viewports": _unique(c["viewport"] for c in captures),
        "reviewed": reviewed_viewports,
        "blocked": blocked_viewports,
        "findings": findings,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Glimmer C4 visual capture + review (capture always runs; --vision opts in a real multimodal model review)"
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
    ap.add_argument("--model-id", default=DEFAULT_MODEL_ID,
                     help=f"OpenAI-compatible model id sent in each vision call. Default {DEFAULT_MODEL_ID}.")
    ap.add_argument("--check", action="append", default=None,
                     help="A V7 §22.3 contract check, e.g. "
                          '"primary button fully visible". Repeatable. Defaults to a small '
                          "set covering V7 §22.2 basics (clipping/overlap/unreadable text/"
                          "off-viewport elements/horizontal overflow) if omitted.")
    ap.add_argument("--vision-timeout", type=float, default=DEFAULT_VISION_TIMEOUT_S,
                     help=f"Per-viewport model call timeout in seconds. Default {DEFAULT_VISION_TIMEOUT_S}.")
    ap.add_argument("--api-key-file", default=str(DEFAULT_API_KEY_FILE),
                     help="Path to the llama-server API key (same convention as "
                          f"glimmer-engineer.py's API_KEY_FILE). Default {DEFAULT_API_KEY_FILE}. "
                          "Missing/unreadable -> vision calls go out with no Authorization "
                          "header (a server started with no --api-key still works).")
    ap.add_argument("--states-file", default=None,
                     help='V7 §22.7: path to a JSON array of {"name": str, "actions": [...]} '
                          'workflow states (each action is {"action": "click", "selector": str} '
                          'or {"action": "wait", "ms": number}), replayed via '
                          "Playwright in order before each state's screenshot. 'initial' is "
                          f"always first and action-free. Capped at {MAX_STATES} states / "
                          f"{MAX_ACTIONS_PER_STATE} actions each; fails loud (nonzero exit) on "
                          "any malformed entry. Omitted -> exactly the pre-3.3 single-state "
                          "capture, byte-for-byte.")
    args = ap.parse_args(argv)

    viewports = args.viewport or list(DEFAULT_VIEWPORTS)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.states_file:
        state_specs = load_states_file(args.states_file)
        state_names = [s["name"] for s in state_specs]
        captures = []
        for vp in viewports:
            captures.extend(capture_viewport_states(args.url, vp, output_dir, state_specs))
    else:
        state_names = ["initial"]
        captures = [capture_viewport(args.url, vp, output_dir) for vp in viewports]

    manifest = build_manifest(args.url, captures, states=state_names)
    (output_dir / "visual-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    if args.vision:
        checks = args.check or list(DEFAULT_CHECKS)
        findings, reports = run_vision_model(
            captures, output_dir, args.url, checks, args.model_url,
            timeout_s=args.vision_timeout,
            api_key_text=_read_api_key(args.api_key_file),
            model_id=args.model_id,
        )
        findings_doc = build_findings(captures, findings, reports)
        findings_doc["modelId"] = args.model_id
    else:
        findings_doc = build_findings(captures)
    (output_dir / "findings.json").write_text(json.dumps(findings_doc, indent=2), encoding="utf-8")

    ok_count = sum(1 for c in captures if c["status"] == "captured")
    unit = "capture(s)" if args.states_file else "viewport(s)"
    print(f"[glimmer-visual] captured {ok_count}/{len(captures)} {unit}")
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
        # Fix round 3: total capture failure with no vision run is an infra
        # gap, not a confirmed defect -- "BLOCKED" (was "FAIL"), aligning
        # with classify_visual_check_result's INFRA_BLOCKED semantics and
        # the reports-ran total-capture-failure case just below.
        assert findings_fail["status"] == "BLOCKED"

        # --- zero-behavior-change proof (for the --vision-absent call shape
        # itself, not the FAIL->BLOCKED status value fix round 3 changes):
        # --vision absent means main() calls build_findings(captures) with
        # no findings/reports args at all, the exact same call shape as
        # findings_pass/findings_fail above. This IS the whole proof -- no
        # other codepath exists for --vision absent.
        assert build_findings([c_ok])["status"] == "NOT_RUN"
        assert build_findings([c_fail])["status"] == "BLOCKED"

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
        routed_payload = _build_vision_payload(
            "QkFTRTY0", "http://x/route", "1440x900", DEFAULT_CHECKS, model_id="vision-frontier"
        )
        assert routed_payload["model"] == "vision-frontier"

        # --- llama-server auth (--api-key): request construction includes
        # Authorization: Bearer <key> when a key file resolves, and omits
        # the header entirely when it doesn't (server with no --api-key
        # must still work; missing/unreadable file must never crash). Same
        # convention as glimmer-engineer.py's API_KEY_FILE/api_key(). ---
        assert str(DEFAULT_API_KEY_FILE).endswith("AI/muse-glimmer/config/api-key.txt")
        assert _read_api_key("/definitely/does/not/exist.txt") == ""
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as kf:
            kf.write("  sekrit-123  \n")
            key_path = kf.name
        assert _read_api_key(key_path) == "sekrit-123"
        Path(key_path).unlink()

        assert _auth_headers("sekrit-123") == {"Authorization": "Bearer sekrit-123"}
        assert _auth_headers("") == {}
        assert _auth_headers(None) == {}

        seen_headers = []
        seen_urls = []

        def fake_post_spy(url, payload, timeout_s, headers=None):
            seen_urls.append(url)
            seen_headers.append(headers)
            return {"choices": [{"message": {"content": '{"findings": []}'}}]}

        call_vision_model(b"png", "http://x/route", "1440x900", DEFAULT_CHECKS,
                           "http://model", post_fn=fake_post_spy, api_key_text="sekrit-123")
        call_vision_model(b"png", "http://x/route", "1440x900", DEFAULT_CHECKS,
                           "https://models.example/v1", post_fn=fake_post_spy, api_key_text=None)
        assert seen_headers[0] == {"Authorization": "Bearer sekrit-123"}
        assert seen_headers[1] == {}, "no key resolved -> no Authorization header, not a crash"
        assert seen_urls == [
            "http://model/v1/chat/completions",
            "https://models.example/v1/chat/completions",
        ], "origin and /v1 base URLs must both produce exactly one /v1 segment"

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
        def fake_post_good(url, payload, timeout_s, headers=None):
            body = json.dumps({"findings": [
                {"severity": "critical", "category": "clipping", "element": "cta",
                 "description": "primary button below the fold"},
                {"severity": "weird", "description": "unknown severity coerces"},
                {"severity": "low", "description": "   "},  # blank -> dropped
            ]})
            return {"choices": [{"message": {"content": body}}]}

        def fake_post_malformed(url, payload, timeout_s, headers=None):
            return {"choices": [{"message": {"content": "not json at all, sorry"}}]}

        def fake_post_error(url, payload, timeout_s, headers=None):
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
        assert all(f["state"] == "initial" for f in findings_good), "absent state -> 'initial' default"
        assert reports_good == [{"viewport": "1440x900", "state": "initial", "status": "reviewed"}]

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

        # --- V7 §22.7 workflow-state verification: --states-file parsing,
        # caps, fail-loud-on-invalid, and multi-state capture. ---
        def _write_states(obj):
            p = out / "states.json"
            p.write_text(json.dumps(obj), encoding="utf-8")
            return p

        # 'initial' is always synthesized first and action-free, even if
        # the file also names it (duplicate is dropped, not merged/kept).
        states_path = _write_states([
            {"name": "initial", "actions": [{"action": "click", "selector": "#ignored"}]},
            {"name": "dialog opened", "actions": [{"action": "click", "selector": "#open"}]},
            {"name": "loading", "actions": [{"action": "wait", "ms": 500}]},
        ])
        states = load_states_file(states_path)
        assert [s["name"] for s in states] == ["initial", "dialog-opened", "loading"], (
            "fix round 3: 'dialog opened' is slugified to 'dialog-opened'"
        )
        assert states[0]["actions"] == [], "a user-supplied 'initial' entry's actions must be dropped"
        assert states[1]["actions"] == [{"action": "click", "selector": "#open"}]
        assert states[2]["actions"] == [{"action": "wait", "ms": 500}]

        # Fail loud, not tolerant: this is trusted orchestrator config, not
        # a live model's untrusted JSON.
        for bad_obj, why in (
            ({"name": "not-a-list"}, "must be an array"),
            ([{"actions": []}], "missing name"),
            ([{"name": "x", "actions": "not-a-list"}], "actions must be a list"),
            ([{"name": "x", "actions": [{"action": "scroll"}]}], "unknown action kind"),
            ([{"name": "x", "actions": [{"action": "click"}]}], "click needs a selector"),
            ([{"name": "x", "actions": [{"action": "wait"}]}], "wait needs ms"),
            ([{"name": "x", "actions": [{"action": "wait", "ms": -1}]}], "wait ms must be positive"),
            ([{"name": "x", "actions": [{"action": "click", "selector": "#a"}] * 11}], "too many actions"),
            ([{"name": "!!!", "actions": []}], "empty after slugifying"),
            ([{"name": "dialog opened", "actions": []},
              {"name": "Dialog--Opened", "actions": []}], "duplicate slug"),
            ([{"name": "Initial!", "actions": []}], "slugifies to the reserved 'initial'"),
        ):
            try:
                load_states_file(_write_states(bad_obj))
                assert False, f"expected ValueError: {why}"
            except ValueError:
                pass

        # Cap: 10 states total including 'initial'.
        too_many = [{"name": f"s{i}", "actions": []} for i in range(10)]  # + synthesized initial = 11
        try:
            load_states_file(_write_states(too_many))
            assert False, "expected ValueError: too many states"
        except ValueError:
            pass
        at_cap = [{"name": f"s{i}", "actions": []} for i in range(9)]  # + initial = 10, exactly at cap
        assert len(load_states_file(_write_states(at_cap))) == 10

        # --- capture_viewport_states: full success, partial (mid-run
        # failure keeps earlier states' real captures), and total failure
        # (bad viewport spec) -- via an injectable (captured, error)-
        # returning capture_fn, no real browser/playwright involved. ---
        # Names here are already slugified, as they would be coming out of
        # load_states_file (the only real caller of capture_viewport_states) --
        # "dialog-opened", not "dialog opened".
        three_states = [
            {"name": "initial", "actions": []},
            {"name": "dialog-opened", "actions": [{"action": "click", "selector": "#open"}]},
            {"name": "loading", "actions": [{"action": "wait", "ms": 100}]},
        ]

        def fake_states_all_ok(url, w, h, out_dir, slug, states):
            captured = []
            for s in states:
                fname = f"{slug}-{s['name']}.png"
                (out_dir / fname).write_bytes(b"PNG-stub")
                captured.append({"name": s["name"], "screenshot": fname})
            return captured, None

        entries_ok = capture_viewport_states("http://x", "1440x900", out, three_states,
                                              capture_fn=fake_states_all_ok)
        assert [e["state"] for e in entries_ok] == ["initial", "dialog-opened", "loading"]
        assert all(e["viewport"] == "1440x900" and e["status"] == "captured" for e in entries_ok)
        assert entries_ok[1]["screenshot"] == "1440x900-dialog-opened.png"
        assert (out / "1440x900-loading.png").exists()

        def fake_states_partial(url, w, h, out_dir, slug, states):
            # Mimics _default_capture_states: state 0 captured for real,
            # state 1 fails, state 2 never attempted.
            fname = f"{slug}-{states[0]['name']}.png"
            (out_dir / fname).write_bytes(b"PNG-stub")
            return [{"name": states[0]["name"], "screenshot": fname}], "Error: click target not found"

        entries_partial = capture_viewport_states("http://x", "390x844", out, three_states,
                                                    capture_fn=fake_states_partial)
        assert entries_partial[0]["status"] == "captured"
        assert (out / "390x844-initial.png").exists(), "the state captured before the failure keeps its real file"
        assert entries_partial[1]["status"] == "failed" and "click target not found" in entries_partial[1]["error"]
        assert entries_partial[2]["status"] == "failed", "a state never reached is still reported, as failed"

        entries_bad_vp = capture_viewport_states("http://x", "not-a-viewport", out, three_states,
                                                  capture_fn=fake_states_all_ok)
        assert all(e["status"] == "failed" and e["screenshot"] is None for e in entries_bad_vp)

        # --- manifest/findings state dimension ---
        multi_manifest = build_manifest("http://x/route", entries_ok, states=["initial", "dialog-opened", "loading"])
        assert multi_manifest["viewports"] == ["1440x900"], "one viewport de-duped across 3 states"
        assert multi_manifest["states"] == ["initial", "dialog-opened", "loading"]
        assert multi_manifest["status"] == "pass"

        def fake_post_state_aware(url, payload, timeout_s, headers=None):
            state_line = next(
                line for line in payload["messages"][1]["content"][0]["text"].splitlines()
                if line.startswith("STATE:")
            )
            return {"choices": [{"message": {"content": json.dumps({
                "findings": [{"severity": "high", "description": f"broken in {state_line}"}]
            })}}]}

        findings_multi, reports_multi = run_vision_model(
            entries_ok, out, "http://x/route", DEFAULT_CHECKS, "http://model",
            post_fn=fake_post_state_aware,
        )
        assert {f["state"] for f in findings_multi} == {"initial", "dialog-opened", "loading"}
        assert {r["state"] for r in reports_multi} == {"initial", "dialog-opened", "loading"}
        assert "dialog-opened" in next(f["description"] for f in findings_multi if f["state"] == "dialog-opened")

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
