# V7 Full Closure Implementation Plan (campaign)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development, round by round. Each round = its own branch → PR → merge. Rounds 1-3, 5-7 land on the orchestrator repo (`~/AI/muse-glimmer`, branch base `main` tracking `origin/glimmer-orchestrator-main` — NEVER plain `git pull`); rounds touching Control Center land on `~/AI/muse-glimmer/control-center` `main`.

**Goal:** Close every real ABSENT/PARTIAL gap from the 2026-08-22 four-part audit of `GLIMMER_AGENT_OS_ARCHITECTURE_V7.md` — everything except sections the doc itself marks as later/aspirational (§30 multi-agent roster, §37 module layout rewrite, §22.20 future multimodal, north-star prose).

**Spec:** /Users/danielqazi/AI/GLIMMER_AGENT_OS_ARCHITECTURE_V7.md (audit tables from this session are the gap inventory).

## Global Constraints (all rounds)

- Orchestrator: Python 3 stdlib only (no pip deps — existing convention); verification via `--<name>-selfcheck` flags + `python3 -m py_compile` on all touched .py files. Control Center: no new npm deps; `npm run build && npm run test` green from repo root.
- Backward compatible: existing sessions/manifests/events must still parse. New manifest/event fields additive. Events remain append-only JSONL via glimmer_events.py.
- Honesty rules: NOT_RUN over false PASS; deterministic facts vs model output provenance-labeled; "Unavailable" over fabrication; gates fail closed.
- Chain-of-thought never emitted in events or artifacts (reuse existing redacted/truncated variables at emit sites).
- Never weaken: commit/push/deploy/install blocks, `--auto-approve` gateway line, architect write-block, scope guard.
- Model-driven vs deterministic split per §42/§43: gates, budgets, state, diffs, ranking = deterministic code; plans, repairs, reviews = model.
- Every round: branch → implement (SDD per task) → per-task review → whole-round Opus review → live checkpoint where the round touches a runtime path (real orchestrator run and/or real UI run) → PR → merge.

## Round 1 — Structural foundations (orchestrator branch `v7-r1-foundations`)

### Task 1.1: Tool result contract (§12)
`execute_tool` in glimmer-engineer.py returns a structured envelope `{ok, tool, durationMs, data, evidence[], warnings[], error{code,message}}` internally; the model-facing message is rendered FROM the envelope (existing compaction preserved byte-compatible where feasible); blocked calls become `ok:false, error.code:"POLICY_BLOCK"` envelopes plus the existing tool_blocked event. Envelope logged to evidence-NN.jsonl. Selfcheck: `--tool-envelope-selfcheck`.

### Task 1.2: Event vocabulary (§5.14, §22.15, task events, §23.13, missing core)
Extend `EVENT_TYPES` in glimmer_events.py + add emit sites for: `session_created`, `skill_loaded`, `model_retry`, `context_selected`; architect: `architect_planning_started/architect_plan_created/architect_review_requested/architect_review_completed/architect_replan_started` (emitted from glimmer-v2.py where those phases already run); task: `task_created/task_status_changed/task_list_completed`; visual: `visual_verification_started/visual_finding_detected/visual_verification_completed`; self-review: `delivery_review_started/delivery_review_completed`. Each event carries only deterministic fields already available at the site. Update shared/src/types.ts GlimmerEvent union + AgentTimeline rendering (generic fallback OK). Selfcheck extension in glimmer_events.py.

### Task 1.3: Failure taxonomy expansion (§40)
Add deterministic classes to `classify_failure`: `VERIFICATION_FAILURE` (verify() ok=false terminal), `BUDGET_EXHAUSTED` (turns/repairs/architect-review budget hit), `TOOL_EXECUTION_FAILURE` (envelope ok=false non-policy terminal cause), `MODEL_UNAVAILABLE` (readiness/HTTP hard-fail — maps doc's infra intent). Keep existing 9. Only classify from deterministic signals; no model judgment. Update shared types + failure banner humanizer already generic.

### Task 1.4: Manifest completion (§38) + contract budgets (§6)
Manifest gains `model{endpoint,name?}`, `permissions{noCommit,noPush,noDeploy,noDependencyInstall}`, `budgets{maxTurns,maxRepairs,architectReviews}`, `eventsFile`. TaskContract + gateway: `budgets.maxChangedFiles` (validated int 1-500, enforced deterministically post-diff → SCOPE_FAILURE if exceeded). Types + composer advanced field + runner flag `--max-changed-files`.

## Round 2 — Architect in the loop (orchestrator branch `v7-r2-architect-loop`)

### Task 2.1: Risk-triggered architect (§5.5)
Deterministic risk score in glimmer-v2.py (signals: contract mode=refactor|multi-package scope|candidateFiles>N|protected-area keywords|verification level full). Score ≥ threshold → architect-first auto-ON unless `--no-architect` explicitly passed. `--architect-first` stays as manual force. Emit `architect_autotriggered` with signal breakdown. Composer shows the deterministic pre-run signal.

### Task 2.2: Re-planning loop + plan versions (§5.12)
`ArchitecturePlan.version` (int, from 1). REPLAN_REQUIRED decision → orchestrator re-invokes architect with review findings appended → plan v2 → engineer continues with delta prompt. Bounded by existing ARCHITECT_REVIEW_BUDGET (shared budget — replans consume it). Manifest stores plan history array. UI: plan panel shows version.

### Task 2.3: Post-verification consistency check (§5.10) + 4-flag acceptance (§5.11)
After verify() ok: cheap deterministic consistency check (did files outside plan.candidateFiles change? → architect review if plan exists) + `gates` object completed to `{implementationComplete, architectureApproved, verificationPassed, scopeApproved, documentationCurrent}` — all deterministic, all required non-false for VERIFIED (null = not-applicable stays allowed per existing semantics). Update canonical_session_state + UI gates rendering.

### Task 2.4: Mid-implementation consultation triggers (§5.5 second half)
Deterministic triggers in engineer loop: new file count > plan estimate, edit outside candidateFiles, turn count > 60% budget with no write yet → inject a single system nudge advising consult; if architect enabled, expose read-only `consult_architect(question)` tool (routes one toolless model call with plan+question, budget 2/session, emits `architect_consulted`). No auto-block — advisory only, fail-open.

## Round 3 — Verification, repair, vision (orchestrator branch `v7-r3-verify-vision`)

### Task 3.1: Session-level verification freeze (§20)
Manifest `verifiedAt` + post-VERIFIED write detection: any later write in the same session flips status to `stale` (new status) and requires a repair cycle to re-verify. Gateway/UI surface staleness.

### Task 3.2: Structured repair contract (§21) + verification plan split (§18)
Repair prompt built from `{attempt, failedCheck, newFailures[], allowedFiles[]}` (allowedFiles = changed files + failing-test files, deterministic); scope-guard warns on repair writes outside allowedFiles. Verification plan becomes `{required[], recommended[]}` — required from contract+level, recommended derived (e.g. tests for changed areas); only required gate VERIFIED, recommended run+reported.

### Task 3.3: Vision multi-state + requiredness (§22.7, §22.10, §22.18)
glimmer-visual.py: `--states` (initial + named interactions via simple Playwright action list in the visual contract file: click selector, wait) capturing per-state screenshots; ArchitecturePlan gains optional `visualRequirements[]` which flow into the visual contract; deterministic requiredness: UI-area sessions (scope.area/paths match web/frontend patterns) at standard+ level auto-add visual to required[] when `--visual-url` provided; absent URL → NOT_RUN honest status (existing convention).

### Task 3.4: Visual UI + gate (§22.16, §22.17) [control-center]
Session screen visual panel: per-viewport/per-state screenshots (served via gateway static route under session dir), findings with severity chips, NOT_RUN honesty. Gate object `finalStatus{functional, visual, architecture, documentation}` composed deterministically in session read path.
(§22.11 baseline pixel-diff: implement simple deterministic pixel-compare (stdlib-adjacent: Pillow already used? if no dep allowed → compare via PNG bytes + dimension/sample grid in pure Python) — if too weak, document as parked with reason.)

## Round 4 — Task system (both repos, branch `v7-r4-tasks`)

### Task 4.1: Full task model + repair/dynamic tasks + completion contracts
GlimmerTask gains `source, priority(required|recommended|optional), evidenceIds[], affectedFiles[], blockingReason?, createdAt, updatedAt, completion{type,...}` — evaluators consume completion contracts instead of hardcoded rules; failed verification auto-creates repair task; dynamic tasks carry createdBecause. tasks.json schema versioned.

### Task 4.2: Session completion rule + task focus
`requiredTasksResolved` computed deterministically; VERIFIED additionally requires it. Engineer prompt includes single active task (first pending required, by dependency order) as focus block.

### Task 4.3: Task UX + human interaction [control-center]
TasksPanel: grouped by kind/phase, priority badges, blockingReason, evidence links; graph view (simple dependency columns, no lib); gateway endpoints: POST task skip/approve (human-owned sidecar like human-acceptance), rendered in panel. Architect task-list review (§ Architect task-list review): when architect enabled, one review pass of derived tasks (budgeted, reuses review machinery).

## Round 5 — Context Engine + evidence (orchestrator branch `v7-r5-context`)

### Task 5.1: Context tiers + budget (§7)
Explicit tier model in engineer prompt assembly: Tier0 permanent (contract, plan, skills), Tier1 active evidence (recent tool envelopes), Tier2 retrievable (grep-able, referenced by id), Tier3 cold (evidence files on disk). Char-based budget accounting per tier with percentages, `context_selected` event emitting per-tier byte counts. Compaction moves Tier1→Tier2 by evidence id reference instead of raw truncation where an envelope exists.

### Task 5.2: Evidence store + graph-lite (§26, §46)
Evidence as first-class: `evidence-NN.jsonl` entries get stable ids (already), plus `evidence-index.json` with `{id, kind, path?, toolCall?, relatesTo[]}` — relatesTo edges (file→test via find_related_tests, failure→file via signatures) built deterministically. Consumed by delivery-review evidence validation and Control Center evidence view (simple list + links).

### Task 5.3: Candidate ranking (§27)
Deterministic scoring for candidate files (signals: symbol match, import proximity from repo map, path/area match, recent-change) with weights in one table; emits the existing-but-never-fired `candidate_selected` event with score breakdown; used to order plan evidence and architect prompt candidates.

## Round 6 — Model Runtime (orchestrator branch `v7-r6-model-runtime`)

### Task 6.1: ModelProvider abstraction (§16)
`ModelProvider` class wrapping http_json: generate(request)→response, health(), capabilities() (probe /v1/models once, cached), per-call timeout param, generic network retry (1 retry, backoff, idempotent-only), request ids (uuid per call, in events + logs), usage metrics captured from response `usage` into manifest totals. glimmer-visual.py reuses it for the vision endpoint (separate instance = §31 routing seam; config table maps role→endpoint: implement, vision, architect?).

### Task 6.2: Recovery ladder tier 3 (§17)
Add reduced-context retry between thinking-disabled and final_synthesis: rebuild messages with Tier0+failure only. `model_recovery` event gains reason+strategy fields (rename/alias parser_recovery additively).

## Round 7 — Documentation Intelligence (branch `v7-r7-docs`, both repos — LARGEST; sub-phased)

### Task 7.1: Doc graph + status core
`docs/graph.json` (machine-readable: nodes {id,type(system|service|route|schema|config),path,title,status,confidence,provenance{evidence[],sha,updatedAt}}, edges {from,to,kind}) + doc status model (CURRENT/STALE/UNVERIFIED/MISSING/DEPRECATED/GENERATED) + deterministic doc verification pass (paths exist, symbols exist via find_symbol, routes exist via repo map) run at session end → statuses updated, `documentationCurrent` gate becomes real tri-state (true when impacted nodes verified CURRENT).

### Task 7.2: Drift detection + impact via graph
Post-diff: map changed files→graph nodes (path prefix + keyword table from existing detector), flag impacted docs STALE, extend documentation_task with node ids; drift check comparing doc-referenced symbols/routes vs code (deterministic, using semantic tools).

### Task 7.3: ADR store + consultation
`docs/decisions/ADR-NNNN.md` with frontmatter (id,status,areas[],decision) + index in graph; architect prompt includes matching-area ADR summaries (deterministic area match, capped); deviations noted in review request. ADR creation = human/manual (documented), orchestrator only consumes — no model-generated ADRs (hallucination guard).

### Task 7.4: Doc tools + events + bootstrap
Engineer/architect read-only tools: `docs_search(query)`, `docs_get_node(id)`, `docs_impact(files[])` (served in-process from graph.json). Events: `documentation_impact_detected/documentation_stale_detected/documentation_verified`. Bootstrap command `--docs-bootstrap` builds initial graph skeleton from repo map (GENERATED provenance, UNVERIFIED status — honest).

### Task 7.5: System Explorer [control-center]
New screen: graph nodes grouped by type, status/confidence chips, provenance display, search, edge navigation, session-to-doc linkage (sessions that touched node). Read-only.

## Round 8 — Delivery governance + approval (branch `v7-r8-governance`, both repos)

### Task 8.1: Quality gates (§23.10, §23.11)
Contract-level optional `qualityGates{customerReadinessRequired?, minimumCustomerReadiness?}` → deterministic comparison against DeliveryReview.customerReadiness → gate + status. Combined `statuses{technical, architecture, visual, documentation, delivery, overall}` object in manifest/session (deterministic composition rules, overall = worst-of).

### Task 8.2: Delivery packet + panel completion + escalation (§23.14-23.16)
Final delivery packet JSON assembled at session end (task, plan ref, changed files, verification, visual, readiness, limitations, forward plan, confidence, human-review status) + rendered summary; DeliveryReviewPanel renders approachRationale/unresolvedItems/intentionallyNotChanged + "convert next step to task" action (creates draft composer state — no auto-run); high/critical concern + architect enabled → one budgeted architect consultation appended to review artifacts.

### Task 8.3: YELLOW approval boundary (§14, §35)
Deterministic YELLOW classification (dependency-install request, migration keywords, scope expansion beyond contract) → session enters `waiting_for_approval` (status finally emitted!) with structured `{action, reason, proposedChanges, risk}` in manifest; gateway exposes approve/deny endpoints (human-owned sidecar); engineer waits via file-based poll with timeout→POLICY_BLOCK fail-closed. UI approval card. (Gateway has no stdin — file-based approval matches the auto-approve lesson.)

## Round 9 — Evaluation + self-improvement (branch `v7-r9-eval`, orchestrator)

### Task 9.1: Eval harness (O5/§39)
`glimmer-eval.py`: fixture repos (existing smoke-test-r1 pattern), task suite JSON (categories: create/modify/repair/refuse), runs sessions headless, scores deterministically (task success, false-VERIFIED via independent re-verify, budget adherence, honesty checks NOT_RUN), writes `eval-results/<ts>.json` + markdown report. Selfcheck with a stub model.

### Task 9.2: Metrics + self-improvement loop (§41)
Session-corpus metrics script: aggregates failure taxonomy distribution, repair success rate, architect-gate outcomes from all manifests; PARSER_FAILURE_THRESHOLD calibration from real data (the parked item); outputs trend report; documented human-review loop (no auto-tuning — §42).

### Task 9.3: Remaining crumbs
`understanding` status emitted at session start pre-discovery; task-intelligence estimatedRisk populated from the Round 2 risk score (deterministic); Control Center endpoints `/sessions/:id/evidence` + `/context` (read manifests/evidence-index); AST-lite upgrade of semantic tools where stdlib allows (python `ast` for .py targets; TS stays regex, ceiling documented).
