
export type DataProvenance =
  | "deterministic-backend"
  | "git-derived"
  | "verification-derived"
  | "model-output"
  | "user-input"
  | "mock-demo";

export type GlimmerSessionStatus =
  | "created"
  | "preflight"
  | "understanding"
  | "discovery"
  | "candidate_selection"
  | "implementing"
  | "verifying"
  | "repairing"
  | "waiting_for_approval"
  | "blocked"
  | "failed"
  | "verified"
  | "needs_review"
  | "cancelled"
  // V7 §20 verification freeze: never written by the orchestrator. The
  // gateway computes this read-time (readSession's computeStale option) when
  // a "verified" session's workspace picks up uncommitted changes after
  // manifest.verifiedAt -- the freeze itself is enforced per-run inside
  // glimmer-engineer.py (engineer_state), not here; this is the session-level
  // fact that verification no longer covers the workspace's current content.
  | "stale";

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  insertions?: number;
  deletions?: number;
}

export interface VerificationCheckResult {
  command: string;
  status: "PASS" | "PASS_BASELINE" | "CODE_FAIL" | "FAIL" | "ERROR" | "NOT_RUN";
  ok: boolean;
  returncode: number;
  elapsedSeconds: number;
  outputTail: string;
  baselineAware: boolean;
  newErrorSignatures: string[];
  // V7 §18: which tier this check belongs to. Optional -- absent on
  // manifests written before this task, which every reader treats as
  // "required" (the only tier that ever existed then). "recommended"
  // checks are reported here (see VerificationSummary.recommendedChecks)
  // but never gate VERIFIED.
  tier?: "required" | "recommended";
}

export type VerificationOverall =
  | "VERIFIED"
  | "FAILED"
  | "BLOCKED"
  | "PARTIAL"
  | "NOT_RUN"
  | "BASELINE_FAILURE"
  | "NEEDS_REVIEW";

export interface VerificationSummary {
  overall: VerificationOverall;
  // required-tier checks only -- these are what `overall`/VERIFIED gating
  // has always been computed from (see server/src/lib/sessions.ts). A check
  // predating this task carries no `tier` at all and belongs here by the
  // same absent-means-required convention as VerificationCheckResult.tier.
  checks: VerificationCheckResult[];
  // V7 §18: recommended-tier checks -- run, reported, NEVER gating. Absent
  // (not just empty) on manifests predating this task and on any attempt
  // whose recommended set was empty (required failed, so recommended never
  // ran; or the level above had nothing extra to add).
  recommendedChecks?: VerificationCheckResult[];
}

// V7 §22.17 visual verification gate object, composed deterministically by
// readSession (server/src/lib/sessions.ts) on every read -- never written by
// the orchestrator itself, so this is always present (unlike gates/
// architectPlan, which are absent on non-architect-mode sessions).
export type FinalGateStatus = "approved" | "rejected" | "not_run";

export interface FinalStatus {
  // Straight passthrough of verification.overall -- no separate mapping.
  functional: VerificationOverall;
  // From the session's visual/findings.json status when the session ran
  // glimmer-visual.py; "not_run" (not VisualFindingsStatus's own "NOT_RUN")
  // when no visual/ dir exists at all -- the one case genuinely distinct
  // from "captured/reviewed but nothing to report".
  visual: VisualFindingsStatus | "not_run";
  // gates.architectureApproved: true -> "approved", false -> "rejected",
  // null/absent -> "not_run" (never ran / not applicable).
  architecture: FinalGateStatus;
  // gates.documentationCurrent, same true/false/null -> approved/rejected/
  // not_run mapping as architecture above.
  documentation: FinalGateStatus;
}

export interface TaskContract {
  objective: string;
  scope: {
    package: "repository" | "frontend" | "backend" | "directory" | "files";
    area?: string;
    paths?: string[];
  };
  mode: "inspect" | "plan" | "implement" | "debug" | "test" | "review" | "refactor";
  constraints: {
    minimalChange: boolean;
    noCommit: true;
    noPush: true;
    noDeploy: true;
    noDependencyInstall: true;
  };
  verification: string[];
  repairBudget: number;
  maxTurns?: number;
  // Task 1.4 (V7 §6/§40): TaskContract budgets. Only maxChangedFiles today —
  // maxTurns/maxRepairs already have their own top-level fields above.
  // Omitted entirely (or maxChangedFiles omitted) means "unbounded", same
  // contract every other optional field here already follows.
  budgets?: {
    maxChangedFiles?: number;
  };
  // §7 New Task Composer "Advanced controls". Typed-only, closed enum for
  // toolchainMode — no freeform command strings. Omitted entirely (or any
  // individual field omitted) means "use the orchestrator's own default",
  // so an untouched composer produces zero behavior change.
  advanced?: {
    timeoutSeconds?: number;
    toolchainMode?: "path" | "linked" | "none";
    modelReadinessUrl?: string;
    architectFirst?: boolean;
  };
}

// V7 §18: manifest.verificationPlan, command strings (not results) for the
// CURRENT/latest attempt -- required gates VERIFIED, recommended is run but
// never gating. See VerificationCheckResult.tier / VerificationSummary.
// recommendedChecks for the corresponding RESULTS.
export interface VerificationPlan {
  required: string[];
  recommended: string[];
}

export interface GlimmerSession {
  id: string;
  task: string;
  taskContract?: TaskContract;
  status: GlimmerSessionStatus;
  workspace: string;
  branch: string;
  baselineSha: string;
  headSha?: string;
  startedAt?: string;
  completedAt?: string;
  changedFiles: ChangedFile[];
  verification: VerificationSummary;
  // V7 §18: the latest attempt's required/recommended command split.
  // Optional -- absent on manifests predating this task.
  verificationPlan?: VerificationPlan;
  repairsUsed: number;
  repairBudget: number;
  // C2/C3 (glimmer-v7): opt-in architect-mode gate/plan summary and the
  // terminal-failure classifier, mirrored from manifest.json's own
  // "gates" / "architectPlan" / "failure" fields when present.
  gates?: {
    architectureApproved: boolean | null;
    // O2 (glimmer-v7): False when the deterministic change-impact detector
    // found doc-relevant changes (routes/schema/api/config/auth); null when
    // no impact or detector didn't run. Never true — phase 1 cannot verify
    // documentation currency, only flag the need.
    documentationCurrent?: boolean | null;
    // Task 2.3 (V7 §5.11): the remaining two of the five final-acceptance
    // gates. implementationComplete/verificationPassed are always
    // computable once a session reaches the post-verify promotion decision
    // (never optional/absent there — but the field itself is optional on
    // this type for older archived sessions/manifests predating this
    // task). scopeApproved folds the existing contract-scope guard AND the
    // new plan.candidateFiles/expectedScope.maxFiles consistency check —
    // true only when both hold, null when either is indeterminate, false
    // when either found a real violation.
    implementationComplete?: boolean | null;
    verificationPassed?: boolean | null;
    scopeApproved?: boolean | null;
    // Task 4.2 (V7 session completion rule): required_tasks_resolved(tasks)
    // -- true when every priority=="required" task in tasks.json reached a
    // resolved terminal state, false when one didn't (blocks VERIFIED, same
    // as architectureApproved/scopeApproved), null when no tasks.json exists
    // for this session (C3's task graph never ran -- not applicable).
    tasksResolved?: boolean | null;
    // Review round 1 (Important 1): set to "human" ONLY when at least one
    // required task's resolution came from a task-overrides.json skip/
    // approve rather than orchestrator-derived evidence (see glimmer-
    // v2.py's any_task_resolved_by_human_override). Absent when
    // tasksResolved is false/null, or when every required task resolved
    // on real evidence alone -- a human decision must stay visibly
    // distinct from evidence, never blended into a plain "✓".
    tasksResolvedBy?: "human";
  };
  architectPlan?: { used: boolean; risk: string | null };
  // Task 2.1 (V7 §5.5): how architect mode was decided for this run —
  // manual (--architect-first), auto (risk score crossed the threshold),
  // or off. score/signals present only for scored decisions; mirrors
  // manifest.architectTrigger verbatim (deterministic fact).
  architectTrigger?: { mode: "manual" | "auto" | "off"; score?: number; signals?: string[] };
  failure?: { class: string; detail: string; evidenceIds: string[] };
  // §14 Diff Review — human "accept for review" fact. Written ONLY by the
  // gateway (POST /sessions/:id/accept), never by the orchestrator/model:
  // technical verification and human acceptance must stay two separate
  // facts, or the model could self-approve its own delivered work.
  humanAcceptance?: HumanAcceptance;
  // V7 §20: stamped by glimmer-v2.py at the moment a session reached
  // VERIFIED (both the real-diff "verified" path and the empty-diff
  // "no-change-verified" path). Optional -- absent on sessions predating
  // this task and on any non-verified session. An audit fact only -- NOT
  // itself part of the stale computation (see finalDiffHash below).
  verifiedAt?: string;
  // V7 §20: manifest.finalDiffHash, written unconditionally by
  // glimmer-v2.py's `finally` block on EVERY exit path (not just VERIFIED),
  // right after collapse() resets HEAD back to baselineSha and leaves the
  // produced diff as uncommitted working-tree state. It's sha256 of the
  // tracked diff against baselineSha plus untracked file contents (see
  // server/src/lib/git.ts's computeDiffHash for the exact cross-language
  // byte contract). This is the fact readSession's stale detection actually
  // compares against -- not workspace dirtiness (a verified session is
  // EXPECTED to be dirty at verifiedAt time; only a diff that no longer
  // matches finalDiffHash means the workspace changed since verification).
  // Optional -- absent on sessions predating this task; readSession never
  // claims "stale" without it.
  finalDiffHash?: string;
  // V7 §22.17: deterministic gate summary, always present (composed at read
  // time from facts already on this object plus an opt-in visual/ dir read
  // -- see FinalStatus's own field comments for the exact per-field mapping).
  finalStatus: FinalStatus;
}

export interface HumanAcceptance {
  accepted: boolean;
  acceptedAt: string;
}

// V7 §5.3 ArchitecturePlan — opt-in architect-mode output, written to
// architecture-plan.json. validate_architecture_plan (glimmer-engineer.py)
// requires objective/packages/risk and defaults every other field to []
// when the model omits it, so every array here stays optional-tolerant.
export type ArchitecturePlanRisk = "low" | "medium" | "high" | "critical";

export interface ArchitecturePlanPattern {
  name: string;
  evidence: string[];
}

export interface ArchitecturePlanCandidateFile {
  path: string;
  reason: string;
  confidence: number;
}

export interface ArchitecturePlan {
  objective: string;
  packages: string[];
  risk: ArchitecturePlanRisk;
  // Task 2.2 (V7 §5.12): plan version, stamped by glimmer-v2.py (the
  // trusted layer) — 1 for the architect-first plan, N+1 per re-plan.
  // Optional/absent means version 1 (backward compat with plans written
  // before this field existed — validate_architecture_plan defaults the
  // same way on the Python side).
  version?: number;
  area?: string;
  existingPatterns?: ArchitecturePlanPattern[];
  candidateFiles?: ArchitecturePlanCandidateFile[];
  constraints?: string[];
  implementationPlan?: string[];
  verificationPlan?: string[];
  expectedScope?: { minFiles?: number; maxFiles?: number };
  uncertainties?: string[];
  // Task 3.4 (V7 §22.10/22.18): UI-affecting requirements the architect
  // flags, which flow into the visual verification contract (Task 3.3).
  // Same optional-tolerant convention as every array field above --
  // validate_architecture_plan (glimmer-engineer.py) additionally caps this
  // one at 20 entries / 300 chars each, since it feeds an automation
  // contract file rather than just prompt text.
  visualRequirements?: string[];
}

// V7 §5.7 ArchitectReview — pre-verification review decision, written to
// architect-review-NN-MM.json. Same tolerant-but-honest defaulting as
// ArchitecturePlan for the array fields; reviewFailed/reviewFailureReason
// mark _fallback_architect_review's degrade-to-HUMAN_REVIEW_REQUIRED path
// (never a different schema, only these two keys added).
export type ArchitectReviewDecision =
  | "APPROVED"
  | "APPROVED_WITH_CONDITIONS"
  | "REVISE_IMPLEMENTATION"
  | "REPLAN_REQUIRED"
  | "HUMAN_REVIEW_REQUIRED";

export interface ArchitectReview {
  decision: ArchitectReviewDecision;
  confidence: number;
  findings?: string[];
  requiredChanges?: string[];
  constraints?: string[];
  verificationAdjustments?: string[];
  reviewFailed?: true;
  reviewFailureReason?: string;
}

// V7 §23.7 DeliveryReview — structured self-review, written to
// delivery-review.json. reviewFailed/reviewFailureReason mark
// _fallback_delivery_review's degrade path, same convention as
// ArchitectReview.
export type DeliveryReviewCustomerReadiness =
  | "ready_to_ship"
  | "ready_with_known_limitations"
  | "needs_polish"
  | "needs_rework"
  | "not_customer_ready";

export type DeliveryConcernSeverity = "low" | "medium" | "high" | "critical";

export type DeliveryConcernCategory =
  | "architecture"
  | "functionality"
  | "visual"
  | "ux"
  | "performance"
  | "security"
  | "verification"
  | "maintainability";

export interface DeliveryConcern {
  severity: DeliveryConcernSeverity;
  category: DeliveryConcernCategory;
  description: string;
  evidenceIds: string[];
}

export type NextStepPriority = "required_before_ship" | "recommended_next" | "future_opportunity";

export interface DeliveryNextStep {
  priority: NextStepPriority;
  action: string;
}

export interface DeliveryReview {
  summary: string;
  approachRationale?: string[];
  strengths?: string[];
  concerns?: DeliveryConcern[];
  customerReadiness: DeliveryReviewCustomerReadiness;
  unresolvedItems?: string[];
  intentionallyNotChanged?: string[];
  nextSteps?: DeliveryNextStep[];
  confidence: { level: "low" | "medium" | "high"; reason: string };
  reviewFailed?: true;
  reviewFailureReason?: string;
}

// V7 §22.14 visual evidence store — these mirror glimmer-visual.py's real
// on-disk shapes (build_manifest / build_findings) field-for-field rather
// than inventing a new combined shape, so the gateway route can pass the
// parsed JSON straight through with no translation layer.

// build_manifest's per-(viewport[, state]) entry. `state` is absent on a
// pre-3.3 single-state run (capture_viewport's plain output carries no
// "state" key at all); present ("initial" or a named state) whenever
// --states-file drove the run -- V7 §22.7's "no state key -> initial"
// convention.
export interface VisualCapture {
  viewport: string;
  state?: string;
  screenshot: string | null;
  status: "captured" | "failed";
  error: string | null;
}

// visual-manifest.json (build_manifest) -- "pass" only when every requested
// viewport captured; "partial" when some did; "failed" when none did.
export type VisualManifestStatus = "pass" | "partial" | "failed";

export interface VisualManifest {
  route: string;
  viewports: string[];
  states: string[];
  status: VisualManifestStatus;
  captures: VisualCapture[];
}

// findings.json (build_findings). "NOT_RUN" means capture succeeded but
// --vision was never passed (capture succeeded != visually reviewed); the
// other four values only appear once --vision actually ran a review.
export type VisualFindingsStatus = "NOT_RUN" | "PASS" | "FAIL" | "BLOCKED" | "PASS_WITH_WARNINGS";

export type VisualFindingSeverity = "low" | "medium" | "high" | "critical";

// One entry from build_findings/`_coerce_finding`. `state` absent means
// "initial" (V7 §22.7), same convention as VisualCapture.state.
export interface VisualFinding {
  id?: string;
  severity: VisualFindingSeverity;
  category?: string;
  element?: string;
  description: string;
  viewport?: string;
  state?: string;
  region?: { x: number; y: number; width: number; height: number };
}

export interface VisualFindings {
  status: VisualFindingsStatus;
  viewport: string;
  viewports: string[];
  reviewed?: string[];
  blocked?: string[];
  findings: VisualFinding[];
}

// GET /api/sessions/:id/visual/manifest response body -- combines both
// files glimmer-visual.py writes per run. `findings` is null only when
// findings.json itself is unreadable/absent (shouldn't happen once
// manifest exists, since main() always writes both together, but the route
// tolerates it the same honest way every other opt-in artifact read does).
export interface VisualVerification {
  manifest: VisualManifest;
  findings: VisualFindings | null;
}

// Task 5.2 (V7 §26/§46): one node in evidence-index.json's graph-lite
// list, built incrementally by glimmer-engineer.py as evidence persists
// (add_evidence -> _index_evidence_entry). `kind` is a static per-tool
// category ("file"/"search"/"shell"/"symbol"/"test-search"/"retrieval"),
// except exec_shell_command entries are reclassified to "failure" when
// their output looks like a failing command. `relatesTo` is the
// graph-lite edge list -- e.g. a find_related_tests entry pointing at
// {kind: "test"} nodes, or a failing shell entry pointing at
// {kind: "file"} nodes parsed from its own output.
export interface EvidenceIndexRelation {
  path: string;
  kind: string;
}

export interface EvidenceIndexEntry {
  id: string;
  kind: string;
  path?: string;
  toolCall: string;
  relatesTo?: EvidenceIndexRelation[];
}

// GET /api/sessions/:id/evidence response body: the whole index by
// default, or (when ?id= is given) a single resolved entry -- see that
// route's own comment for why both live behind one endpoint.
export interface EvidenceIndexResponse {
  entries: EvidenceIndexEntry[];
}

export interface EvidenceEntryResponse {
  id: string;
  tool?: string;
  arguments?: unknown;
  content?: string;
}

// C3 (glimmer-v7): flat evidence-driven task list, written to tasks.json.
// kind vocabulary: "implementation" and "verification" transition on real
// evidence (engineer return code + changed files / a matched verify()
// result -- see evaluate_implementation_tasks / evaluate_verification_tasks
// in glimmer-v2.py). O2 (glimmer-v7 reconciliation) adds "documentation":
// an honest, permanently-pending kind appended only when the deterministic
// change-impact detector finds routes/schema/api/config/auth touched --
// nothing in glimmer-v2.py's task writers ever flips it to complete/failed,
// because phase 1 has no way to verify documentation currency. A human
// closes it out of band. Task 4.1 (V7 R4) adds "repair": an auto-created
// task per repair round (see create_repair_task in glimmer-v2.py).
//
// Task 4.1: the fields below source/priority/evidenceIds/affectedFiles/
// blockingReason/createdAt/updatedAt/completion/createdBecause are ALL
// optional, so an archived tasks.json written before this task (v1: no
// wrapper, no completion contract) still satisfies this type unchanged --
// same back-compat convention gates/architectPlan already use. tasks.json
// itself is now versioned {"schemaVersion": 2, "tasks": GlimmerTask[]} --
// see readSessionTasks (server/src/lib/sessions.ts), which unwraps that
// AND still tolerates a bare v1 array from an older session.
// Task 4.3: a human skip/approve decision recorded in the gateway-owned
// task-overrides.json sidecar (same trust model as human-acceptance.json --
// glimmer-v2.py never writes it, only the CC gateway route does). "skip"
// means the human decided a required task doesn't need to happen; "approve"
// means the human manually signed off a task's completion (chiefly for
// completion.type=="manual" tasks, which have no automatic evaluator).
// Review round 1 (Important 3): kind/description are captured at write
// time (the task as it existed when the human clicked) so a later reader
// can tell whether "this id" still means the same task -- task ids are
// NOT stable across a replan (merge_replanned_tasks/derive_tasks can
// renumber), so trusting the id alone risks silently applying a stale
// human decision to an unrelated task that happens to reuse the id.
// Absent on an override written before this round (legacy record) --
// treated as "can't check, trust the id" by both applyTaskOverrides and
// glimmer-v2.py's required_tasks_resolved.
export interface TaskOverride {
  action: "skip" | "approve";
  at: string;
  kind?: GlimmerTask["kind"];
  description?: string;
}

export interface GlimmerTask {
  id: string;
  description: string;
  kind: "implementation" | "verification" | "documentation" | "repair";
  dependsOn: string[];
  // "skipped" (Task 4.3) is a DISPLAY-only status the gateway's GET
  // /sessions/:id/tasks route produces when a human skip override exists --
  // glimmer-v2.py itself never writes this value to tasks.json.
  status: "pending" | "in_progress" | "complete" | "failed" | "skipped";
  // Task 4.1: who/what created this task.
  source?: "architect_plan" | "verification" | "repair" | "documentation" | "system";
  // Task 4.1: required tasks block gates.tasksResolved (and therefore
  // VERIFIED) when unresolved; recommended/optional never do -- see
  // required_tasks_resolved in glimmer-v2.py.
  priority?: "required" | "recommended" | "optional";
  evidenceIds?: string[];
  affectedFiles?: string[];
  blockingReason?: string | null;
  createdAt?: string;
  updatedAt?: string;
  // Task 4.1: the completion CONTRACT evaluators dispatch on, instead of a
  // hardcoded per-kind rule. check is only meaningful for type=="check_passed":
  // null means fuzzy-match the task's own description against a verify()
  // result (every plan-derived verification task); a literal command string
  // means exact-match that command (every repair task).
  completion?: {
    type: "files_changed" | "check_passed" | "manual" | "docs";
    check?: string | null;
  };
  // Task 4.1: why a dynamically-created task exists (repair: the failing
  // check's command; documentation: the impacted-areas list) -- see V7's
  // "Dynamic task creation" section.
  createdBecause?: string | null;
  // Task 4.3: present only on the GET /sessions/:id/tasks route's merged
  // response, when a human skip/approve override exists for this task --
  // never written to tasks.json itself. See applyTaskOverrides (server/src/
  // lib/sessions.ts).
  override?: TaskOverride;
  // Review round 1 (Important 3): present instead of `override` when a
  // recorded override's id matched but its kind/description didn't -- the
  // id was reused by a replan for a different task, so the override is
  // honestly ignored rather than silently misapplied. See
  // applyTaskOverrides.
  staleOverride?: TaskOverride;
}

interface GlimmerEventBase {
  id: string;
  sessionId: string;
  timestamp: string;
}

export interface ToolStartedEvent extends GlimmerEventBase {
  type: "tool_started";
  tool: string;
  args: Record<string, unknown>;
}
export interface ToolCompletedEvent extends GlimmerEventBase {
  type: "tool_completed";
  tool: string;
  resultSummary: string;
}
export interface ToolBlockedEvent extends GlimmerEventBase {
  type: "tool_blocked";
  command: string;
  reason: string;
}
export interface FileChangedEvent extends GlimmerEventBase {
  type: "file_changed";
  path: string;
  changeType: ChangedFile["status"];
}
export interface VerificationStartedEvent extends GlimmerEventBase {
  type: "verification_started";
  command: string;
}
export interface VerificationCompletedEvent extends GlimmerEventBase {
  type: "verification_completed";
  check: string;
  status: VerificationCheckResult["status"];
  baselineAware: boolean;
}
export interface AgentStateChangedEvent extends GlimmerEventBase {
  type: "agent_state_changed";
  state: GlimmerSessionStatus;
}
export interface CandidateSelectedEvent extends GlimmerEventBase {
  type: "candidate_selected";
  file: string;
  reasons: string[];
}
export interface ScopeExpandedEvent extends GlimmerEventBase {
  type: "scope_expanded";
  expected: string[];
  actual: string[];
}
export interface RepairStartedEvent extends GlimmerEventBase {
  type: "repair_started";
  iteration: number;
}
export interface ParserRecoveryEvent extends GlimmerEventBase {
  type: "parser_recovery";
  attempt: number;
  payloadPath: string;
}
export interface SessionCompletedEvent extends GlimmerEventBase {
  type: "session_completed";
  status: GlimmerSessionStatus;
}

// V7 event vocabulary expansion (Task 1.2 — §5.14, §22.15, task events,
// §23.13). Mirrors glimmer_events.py's EVENT_TYPES additions one-for-one.
export interface SessionCreatedEvent extends GlimmerEventBase {
  type: "session_created";
  taskSummary: string;
  workspace: string;
}
export interface SkillLoadedEvent extends GlimmerEventBase {
  type: "skill_loaded";
  name: string;
  path: string;
}
export interface ModelRetryEvent extends GlimmerEventBase {
  type: "model_retry";
  attempt: number;
  strategy: string;
}
// context_selected: only systemBytes/taskBytes are cheaply available at
// glimmer-engineer.py's run_engineer start today — skills/evidence arrive
// already merged into `task` by glimmer-v2.py's make_prompt, with no
// separate byte count crossing that subprocess boundary. skillsBytes/
// evidenceBytes are reserved here for Round 5 once that split exists.
export interface ContextSelectedEvent extends GlimmerEventBase {
  type: "context_selected";
  systemBytes: number;
  taskBytes: number;
  skillsBytes?: number;
  evidenceBytes?: number;
}
export interface ArchitectPlanningStartedEvent extends GlimmerEventBase {
  type: "architect_planning_started";
}
export interface ArchitectPlanCreatedEvent extends GlimmerEventBase {
  type: "architect_plan_created";
  risk?: ArchitecturePlanRisk;
  packages?: string[];
  // Task 2.2 fix round 1 (LOW): 1 for the architect-first plan, N+1 per
  // replan — matches ArchitecturePlan.version.
  version?: number;
}
export interface ArchitectReviewRequestedEvent extends GlimmerEventBase {
  type: "architect_review_requested";
  iteration: number;
  reviewRound: number;
}
export interface ArchitectReviewCompletedEvent extends GlimmerEventBase {
  type: "architect_review_completed";
  iteration: number;
  reviewRound: number;
  decision: ArchitectReviewDecision;
}
// architect_replan_started (Task 2.2, V7 §5.12): emitted by glimmer-v2.py's
// review loop right before re-invoking the architect on a REPLAN_REQUIRED
// decision — fromVersion/toVersion are the ArchitecturePlan.version being
// replaced/produced, reviewRound is the review round that triggered it.
export interface ArchitectReplanStartedEvent extends GlimmerEventBase {
  type: "architect_replan_started";
  fromVersion: number;
  toVersion: number;
  reviewRound: number;
}
// architect_autotriggered (V7 §5.5, Task 2.1): emitted by glimmer-v2.py's
// deterministic risk score (compute_architect_risk) only when the score
// crosses the threshold and --no-architect was not passed. score/
// threshold/signals mirror manifest.architectTrigger verbatim.
export interface ArchitectAutotriggeredEvent extends GlimmerEventBase {
  type: "architect_autotriggered";
  score: number;
  threshold: number;
  signals: string[];
}
export interface TaskCreatedEvent extends GlimmerEventBase {
  type: "task_created";
  taskId: string;
  kind: GlimmerTask["kind"];
  description: string;
  // Task 4.1: additive -- absent on an event emitted by a pre-Round-4
  // orchestrator (archived session).
  source?: GlimmerTask["source"];
  priority?: GlimmerTask["priority"];
}
export interface TaskStatusChangedEvent extends GlimmerEventBase {
  type: "task_status_changed";
  taskId: string;
  status: GlimmerTask["status"];
  previousStatus: GlimmerTask["status"];
}
export interface TaskListCompletedEvent extends GlimmerEventBase {
  type: "task_list_completed";
  taskCount: number;
}
// Review round 1 (Important 1): emitted by glimmer-v2.py at gate-
// computation time (both gates["tasksResolved"] call sites in main())
// whenever a required task's resolution actually came from a human's
// task-overrides.json skip/approve, not orchestrator-derived evidence --
// see any_task_resolved_by_human_override. One event per such task.
export interface TaskOverrideAppliedEvent extends GlimmerEventBase {
  type: "task_override_applied";
  taskId: string;
  action: "skip" | "approve";
}
export interface VisualVerificationStartedEvent extends GlimmerEventBase {
  type: "visual_verification_started";
  command: string;
}
export interface VisualFindingDetectedEvent extends GlimmerEventBase {
  type: "visual_finding_detected";
  severity: string;
  category?: string;
  description: string;
}
export interface VisualVerificationCompletedEvent extends GlimmerEventBase {
  type: "visual_verification_completed";
  status: VerificationCheckResult["status"];
}
export interface DeliveryReviewStartedEvent extends GlimmerEventBase {
  type: "delivery_review_started";
}
export interface DeliveryReviewCompletedEvent extends GlimmerEventBase {
  type: "delivery_review_completed";
  customerReadiness: DeliveryReviewCustomerReadiness;
  confidence: "low" | "medium" | "high";
}
// Task 2.4 (V7 §5.5 second half): deterministic mid-implementation
// advisory triggers, emitted by glimmer-engineer.py's run_engineer loop.
// Each trigger key fires at most once per session -- see
// _evaluate_advisory_triggers in glimmer-engineer.py for the three keys
// (new_file_count_exceeds_plan / edit_outside_candidate_files /
// turns_high_no_writes). detail is a capped, deterministic reason string
// (no model text).
export interface ArchitectConsultAdvisedEvent extends GlimmerEventBase {
  type: "architect_consult_advised";
  trigger: string;
  detail: string;
}
// Task 2.4: emitted once per consult_architect tool call (budget-limited
// to 2/session) -- questionChars/answerChars only, never the question or
// answer content itself.
export interface ArchitectConsultedEvent extends GlimmerEventBase {
  type: "architect_consulted";
  questionChars: number;
  answerChars: number;
}

export type GlimmerEvent =
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolBlockedEvent
  | FileChangedEvent
  | VerificationStartedEvent
  | VerificationCompletedEvent
  | AgentStateChangedEvent
  | CandidateSelectedEvent
  | ScopeExpandedEvent
  | RepairStartedEvent
  | ParserRecoveryEvent
  | SessionCompletedEvent
  | SessionCreatedEvent
  | SkillLoadedEvent
  | ModelRetryEvent
  | ContextSelectedEvent
  | ArchitectPlanningStartedEvent
  | ArchitectPlanCreatedEvent
  | ArchitectReviewRequestedEvent
  | ArchitectReviewCompletedEvent
  | ArchitectReplanStartedEvent
  | ArchitectAutotriggeredEvent
  | TaskCreatedEvent
  | TaskStatusChangedEvent
  | TaskListCompletedEvent
  | TaskOverrideAppliedEvent
  | VisualVerificationStartedEvent
  | VisualFindingDetectedEvent
  | VisualVerificationCompletedEvent
  | DeliveryReviewStartedEvent
  | DeliveryReviewCompletedEvent
  | ArchitectConsultAdvisedEvent
  | ArchitectConsultedEvent;

const EVENT_TYPES: ReadonlySet<GlimmerEvent["type"]> = new Set([
  "tool_started", "tool_completed", "tool_blocked", "file_changed",
  "verification_started", "verification_completed", "agent_state_changed",
  "candidate_selected", "scope_expanded", "repair_started",
  "parser_recovery", "session_completed",
  "session_created", "skill_loaded", "model_retry", "context_selected",
  "architect_planning_started", "architect_plan_created",
  "architect_review_requested", "architect_review_completed",
  "architect_replan_started", "architect_autotriggered",
  "task_created", "task_status_changed", "task_list_completed", "task_override_applied",
  "visual_verification_started", "visual_finding_detected",
  "visual_verification_completed",
  "delivery_review_started", "delivery_review_completed",
  "architect_consult_advised", "architect_consulted",
]);

export function isGlimmerEvent(x: unknown): x is GlimmerEvent {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.sessionId === "string" &&
    typeof o.timestamp === "string" &&
    typeof o.type === "string" &&
    EVENT_TYPES.has(o.type as GlimmerEvent["type"])
  );
}

export interface RepoPackage {
  path: string;
  dir: string;
  name: string;
  scripts: Record<string, string>;
  frameworks: string[];
  engines: unknown;
  workspaces: unknown;
}

export interface RepoMap {
  generatedAt: string;
  workspace: string;
  branch: string;
  head: string;
  upstream: string | null;
  packages: RepoPackage[];
}

export interface ModelStatus {
  status: "ONLINE" | "REACHABLE_AUTH" | "OFFLINE" | "UNKNOWN";
  endpoint: string;
  httpStatus?: number;
  provenance: DataProvenance;
  // Best-effort extras from llama.cpp's GET /props (public, no api-key check).
  // Absent whenever /props didn't respond or didn't provide a given field —
  // never fabricated (spec §25: "Unavailable" until the backend provides it).
  contextSize?: number;
  modelPath?: string;
  speculativeDecoding?: boolean;
}

export interface WorkspaceInfo {
  path: string;
  branch: string;
  headSha: string;
  baselineSha: string | null;
  dirty: boolean;
  changedFiles: ChangedFile[];
}

export interface DashboardStatus {
  model: ModelStatus;
  activeSession: Pick<GlimmerSession, "id" | "status" | "changedFiles"> | null;
  latestSession: Pick<GlimmerSession, "id" | "task" | "status" | "completedAt"> | null;
  recentSessions: Array<Pick<GlimmerSession, "id" | "task" | "status" | "changedFiles" | "completedAt">>;
  verification: VerificationSummary | null;
}

export interface TaskIntelligence {
  likelyArea: string | null;
  likelyPackage: string | null;
  suggestedVerification: string[];
  estimatedRisk: RiskLevel | null;
  provenance: DataProvenance;
}

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ScopeGuardResult {
  inScope: boolean;
  expected: string[];
  actual: string[];
  expandedFiles: string[];
  // F5: set when scope type is "directory"/"files" (a scope that CLAIMS to be
  // bounded) but no concrete path was ever given, so nothing could actually be
  // checked. Distinct from the honest, intentional inScope:true/expected:[]
  // case for "repository" scope, which has no boundary by design.
  unbounded?: boolean;
}

export interface SessionAnalysis {
  riskScore: RiskLevel;
  scopeGuard: ScopeGuardResult | null;
  provenance: DataProvenance;
}

export interface SessionAssistantAnswer {
  answer: string;
  provenance: "model-output";
}

// §27/§4.1 workspace creation — POST /api/workspaces response.
export interface CreateWorkspaceResult {
  workspace: string;
  branch: string;
  baselineSha: string;
}
