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
  | "waiting_for_clarification"
  | "blocked"
  | "failed"
  | "verified"
  // A read-only inspect/plan/review run finished and produced its report.
  // This deliberately makes no verification claim.
  | "completed"
  // An implementation-capable run finished without changing the workspace.
  // Kept separate from VERIFIED so "nothing changed" cannot masquerade as
  // verified delivery.
  | "no_change"
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
  "VERIFIED" | "FAILED" | "BLOCKED" | "PARTIAL" | "NOT_RUN" | "BASELINE_FAILURE" | "NEEDS_REVIEW";

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

export type DesignTaskKind = "build" | "improve" | "audit" | "reference-match";
export type DesignContextStrategy = "detect" | "existing" | "required" | "none";

export interface DesignReferenceImage {
  /** Workspace-relative path. The orchestrator resolves it symlink-safely. */
  path: string;
  label?: string;
}

export type DesignStateAction =
  { action: "click"; selector: string } | { action: "wait"; ms: number };

export interface DesignState {
  name: string;
  actions: DesignStateAction[];
  expectations: string[];
}

export interface CmsDesignContext {
  strategy: DesignContextStrategy;
  providerHint?: string;
  /** Workspace-relative schema/model/content paths to inspect and preserve. */
  schemaPaths: string[];
  requirements: string[];
  localizationRequired: boolean;
}

export interface DesignTokenContext {
  strategy: DesignContextStrategy;
  /** Workspace-relative token/theme/config paths that remain the source of truth. */
  sourcePaths: string[];
  requirements: string[];
  allowNewTokens: boolean;
}

export interface DesignInspiration {
  source: "mobbin";
  screenId: string;
  appName: string;
  platform: "ios" | "web";
  mobbinUrl: string;
  /** The human's search intent is durable even when Mobbin's signed image URL expires. */
  query: string;
  notes?: string;
}

export type DesignProfileSource = "creatorhub-catalog" | "custom";

/** Durable design direction. It records what to adopt and reject, never executable style/code. */
export interface DesignProfileReference {
  source: DesignProfileSource;
  profileId: string;
  profileVersion: string;
  designHash: string;
  title: string;
  adoptedQualities: string[];
  rejectedQualities: string[];
}

export type DesignCatalogProfileType =
  "brand-derived" | "visual-archetype" | "product-domain" | "layout-pattern" | "starter" | "custom";

export interface DesignCatalogProfile {
  source: DesignProfileSource;
  id: string;
  title: string;
  description: string;
  version: string;
  designHash: string;
  license: string;
  category: string;
  profileType: DesignCatalogProfileType;
  platforms: string[];
  productKinds: string[];
  tags: string[];
  characteristics: {
    tones: string[];
    density: string;
    contrast: string;
    geometry: string;
    elevation: string;
    modes: string[];
    motion: string;
  };
  typography: {
    primary: string;
    display: string;
    mono: string;
    proprietary: boolean;
    substitutes: string[];
  };
  colors: Record<string, string>;
  components: string[];
  layouts: string[];
  quality: {
    completeness: number;
    richness: number;
    overall: number;
    evidence: "researched" | "curated" | "generated" | "custom";
    referenceRisk: "low" | "medium" | "high";
  };
  selection: {
    adopt: string[];
    verify: string[];
    avoid: string[];
  };
  score?: number;
  reasons?: string[];
  conflicts?: string[];
}

export interface DesignCatalogFacets {
  schemaVersion: 2;
  catalogVersion: string;
  count: number;
  source: "creatorhub-engineering";
  categories: Array<{ value: string; count: number }>;
  profileTypes: Array<{ value: string; count: number }>;
  platforms: Array<{ value: string; count: number }>;
  productKinds: Array<{ value: string; count: number }>;
  tones: Array<{ value: string; count: number }>;
  densities: Array<{ value: string; count: number }>;
  contrasts: Array<{ value: string; count: number }>;
  modes: Array<{ value: string; count: number }>;
}

export interface DesignCatalogSearchRequest {
  query: string;
  limit?: number;
  filters?: Partial<{
    category: string;
    profileType: string;
    platform: string;
    productKind: string;
    tone: string;
    density: string;
    contrast: string;
    mode: string;
  }>;
  exclude?: string[];
  projectContext?: {
    platform?: string;
    cms?: string;
    requirements?: string[];
    tokenNames?: string[];
  };
}

export interface DesignCatalogSearchResult {
  query: string;
  total: number;
  catalogVersion: string;
  results: DesignCatalogProfile[];
}

export interface DesignCatalogCustomProfileInput {
  title: string;
  description: string;
  category: string;
  tones: string[];
  colors: Record<string, string>;
  typography?: { primary?: string; display?: string; mono?: string };
  adopt: string[];
  avoid: string[];
}

export interface DesignCatalogCollection {
  id: string;
  title: string;
  profileIds: string[];
}

export interface DesignCatalogLibrary {
  version: 1;
  updatedAt: string;
  favorites: string[];
  collections: DesignCatalogCollection[];
  customProfiles: DesignCatalogProfile[];
}

export interface DesignRegion {
  /** Coordinates are normalized to the captured image, from 0 through 1. */
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface DesignVariantRequest {
  id: string;
  target: string;
  count: 2 | 3 | 4;
  directions: string[];
  screenshot?: string;
  region?: DesignRegion;
}

export interface DesignElementStyleEdit {
  textColor?: string;
  backgroundColor?: string;
  fontFamily?: string;
  fontSizePx?: number;
  fontWeight?: number;
  lineHeight?: number;
  paddingPx?: number;
  marginPx?: number;
  gapPx?: number;
  borderColor?: string;
  borderWidthPx?: number;
  borderRadiusPx?: number;
  opacity?: number;
  direction?: "row" | "column";
  align?: "start" | "center" | "end" | "space-between";
}

/** A visual, element-scoped edit request. It contains intent, never executable CSS or JS. */
export interface DesignElementEdit {
  id: string;
  target: string;
  screenshot: string;
  viewport: string;
  state: string;
  region: DesignRegion;
  selectorHint?: string;
  sourcePathHint?: string;
  expectedText?: string;
  text?: string;
  imageSource?: string;
  style: DesignElementStyleEdit;
  createdAt: string;
}

export type DesignAssetKind = "image" | "video" | "vector";
export type DesignAssetAspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";

/** A bounded generation request. Glimmer must report BLOCKED if no real media tool is available. */
export interface DesignAssetRequest {
  id: string;
  kind: DesignAssetKind;
  prompt: string;
  outputPath: string;
  aspectRatio: DesignAssetAspectRatio;
  size?: "1K" | "2K" | "4K";
  resolution?: "720p" | "1080p";
  durationSeconds?: 2 | 4 | 6 | 8;
  audio?: boolean;
  animated?: boolean;
  referenceImages: DesignReferenceImage[];
  referenceUploadPolicy: "local-only" | "generation-model";
  screenshot?: string;
  createdAt: string;
}

/**
 * Optional design/UX extension of TaskContract. It is deliberately declarative:
 * no arbitrary commands or JavaScript can travel from the composer to Playwright.
 */
export interface DesignContract {
  kind: DesignTaskKind;
  /** Local preview URL only; the gateway rejects non-loopback hosts. */
  targetUrl?: string;
  audience?: string;
  primaryAction?: string;
  requirements: string[];
  referenceImages: DesignReferenceImage[];
  /** Explicit per-task consent boundary; local-only is the safe default. */
  referenceImagePolicy: "local-only" | "vision-model";
  states: DesignState[];
  viewports: string[];
  inspirations: DesignInspiration[];
  /** Curated design directions remain distinct from imported screen inspiration. */
  designProfiles?: DesignProfileReference[];
  variants: DesignVariantRequest[];
  elementEdits: DesignElementEdit[];
  assetRequests: DesignAssetRequest[];
  cms: CmsDesignContext;
  designTokens: DesignTokenContext;
}

export interface TaskContract {
  objective: string;
  // The human's objective above is immutable source text. intent records a
  // narrow, deterministic semantic interpretation without replacing it.
  intent?: TaskIntent;
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
  design?: DesignContract;
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
  // Task 8.1 (V7 §23.10): "would I send this to a customer?" quality gate.
  // Omitted entirely (or customerReadinessRequired omitted/false) means the
  // gate is never applicable for this task -- same omit-when-unset contract
  // as budgets/advanced above. minimumCustomerReadiness is meaningful only
  // alongside customerReadinessRequired: true; DeliveryReviewCustomerReadiness
  // is the same ordered vocabulary glimmer-v2.py's CUSTOMER_READINESS_ORDER
  // compares against (best to worst: ready_to_ship, ready_with_known_
  // limitations, needs_polish, needs_rework, not_customer_ready).
  qualityGates?: {
    customerReadinessRequired?: boolean;
    minimumCustomerReadiness?: DeliveryReviewCustomerReadiness;
  };
}

export type TaskMode = TaskContract["mode"];
export type ReadOnlyTaskMode = Extract<TaskMode, "inspect" | "plan" | "review">;

export interface TaskIntent {
  kind: "direct" | "improvement-assessment";
  source: "explicit" | "deterministic-inference";
}

export type TaskReportSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface TaskReportFinding {
  severity: TaskReportSeverity;
  category: string;
  title: string;
  description: string;
  evidence: Array<{
    path: string;
    line?: number;
    detail: string;
  }>;
  recommendedFix: string;
}

export interface TaskReportV1 {
  schemaVersion: 1;
  mode: ReadOnlyTaskMode;
  objective: string;
  summary: string;
  findings: TaskReportFinding[];
  implementationPlan: string[];
  confidence: "high" | "medium" | "low";
  reportFailed?: boolean;
  reportFailureReason?: string;
}

export type ClaimType = "presence" | "absence" | "behavior" | "risk";
export type ClaimVerificationStatus = "verified" | "partial" | "rejected";

export interface ClaimVerification {
  status: ClaimVerificationStatus;
  reasons: string[];
  criticReason?: string;
}

export interface ReportCoverage {
  filesInspected: number;
  searchesRun: number;
  graphCoverage: number | null;
  unsupportedLanguages: string[];
  evidenceRecords: number;
}

export interface TaskReportFindingV2 extends TaskReportFinding {
  claimType: ClaimType;
  evidenceIds: string[];
  verification: ClaimVerification;
}

export interface ClarificationDecisionPoint {
  id: string;
  question: string;
  impact: "low" | "medium" | "high";
  options: Array<{ id: string; label: string }>;
}

export interface TaskReportV2 {
  schemaVersion: 2;
  mode: ReadOnlyTaskMode;
  objective: string;
  summary: string;
  findings: TaskReportFindingV2[];
  rejectedFindings: TaskReportFindingV2[];
  implementationPlan: string[];
  confidence: "high" | "medium" | "low";
  coverage: ReportCoverage;
  decisionPoints: ClarificationDecisionPoint[];
  critic: {
    status: "completed" | "unavailable";
    independence: "independent" | "same-model" | "unavailable";
  };
  reportFailed?: boolean;
  reportFailureReason?: string;
}

export type TaskReport = TaskReportV1 | TaskReportV2;

export interface ClarificationRequest {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  status: "pending" | "answered" | "expired";
  createdAt: string;
  expiresAt: string;
  question: string;
  impact: "high";
  options: Array<{ id: string; label: string }>;
  allowFreeform: true;
  answer?: { optionId?: string | null; text?: string | null; answeredAt?: string };
  expiredAt?: string;
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
  /** Durable Force Quit recovery facts from the gateway-owned run record. */
  recovery?: {
    detectedAt: string;
    reason: string;
    progressPreserved: boolean;
    progressLocation?: "worktree" | "checkpoint" | "durable_snapshot" | "session_artifacts";
    changedFiles: ChangedFile[];
    /** Transactional model/tool state written by glimmer_journal.py. */
    durableCheckpoint?: {
      lastDurableAt: string;
      phase: string;
      turn?: number;
      durableMessageCount?: number;
      partialModelCharacters?: number;
      pendingTool?: { callId: string; tool: string; path?: string };
      snapshotCommit?: string;
      snapshotChangedFiles?: string[];
    };
    acknowledgedAt?: string;
  };
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
    // Task 8.1 (V7 §23.10): compute_customer_readiness_gate's result --
    // same True/False/None contract as the other optional gates above.
    // null when contract.qualityGates.customerReadinessRequired was never
    // set (gate not requested — not applicable); false when required but
    // the session's DeliveryReview is missing, unparseable, or doesn't meet
    // qualityGates.minimumCustomerReadiness.
    customerReadinessApproved?: boolean | null;
  };
  // Task 8.1 (V7 §23.11): combined statuses, written once by glimmer-v2.py's
  // `finally` block (every exit path, not just VERIFIED-reaching ones) —
  // mirrored from manifest["statuses"] verbatim, same "additive, optional,
  // absent on sessions predating this task" convention as gates/
  // architectPlan/failure above. Distinct from this type's own finalStatus
  // (V7 §22.17, composed at READ time by control-center itself) — this one
  // is the orchestrator's own self-report. technical/architecture/
  // documentation/visual/delivery each keep their own natural vocabulary
  // (see glimmer-v2.py's compute_statuses docstring); overall is expressed
  // in DeliveryReviewCustomerReadiness's 5-level vocabulary (plus "not_run"),
  // the only one granular enough to rank every other leg against.
  statuses?: {
    technical: "VERIFIED" | "FAILED" | "NOT_RUN";
    architecture: "approved" | "rejected" | "not_run";
    documentation: "approved" | "rejected" | "not_run";
    visual: VisualFindingsStatus | "not_run";
    delivery: DeliveryReviewCustomerReadiness | "not_run";
    overall: DeliveryReviewCustomerReadiness | "not_run";
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
  // Task 8.3 (V7 §14/§35): mirrored from manifest.json's own transient
  // "pendingApproval" field -- present ONLY while glimmer-engineer.py is
  // actually blocked polling approvals.json for a YELLOW action (status is
  // "waiting_for_approval" at the same time). Cleared the moment the wait
  // resolves (approved/denied/timeout), when the engineer process patches
  // manifest.json back to its prior status/state.
  pendingApproval?: ApprovalRequest & { approvalId: string };
}

/** Cursor-paginated, registry-backed session list. */
export interface SessionPage {
  sessions: GlimmerSession[];
  nextCursor: string | null;
}

export interface HumanAcceptance {
  accepted: boolean;
  acceptedAt: string;
}

// C2 per-hunk review. Hunk ids are derived by the gateway from the current
// canonical git diff; the browser never supplies patch text to a write route.
export interface DiffReviewHunk {
  id: string;
  path: string;
  header: string;
  added: number;
  removed: number;
  status: "pending" | "accepted";
  acceptedAt?: string;
}

export interface SessionDiff {
  diff: string;
  hunks: DiffReviewHunk[];
}

export interface HunkAcceptance {
  hunkId: string;
  path: string;
  acceptedAt: string;
}

export interface HunkReviewResult {
  hunkId: string;
  path: string;
  decision: "accepted" | "rejected";
  decidedAt: string;
}

// Task 8.3 (V7 §14/§35) -- YELLOW human-approval boundary. Written by
// glimmer-engineer.py (request_approval_and_wait) the moment a YELLOW-
// classified action (classify_yellow: dependency install, migration
// keyword, large scope expansion) needs a human decision -- status starts
// "pending". Resolved by the gateway's own POST /sessions/:id/approvals/
// :approvalId/approve|deny (adds status/resolvedAt/approvedBy), same "two
// processes, one sidecar file, each writes only its own half" discipline
// as task-overrides.json/TaskOverride. proposedChanges/risk/reason are
// deterministic fields only -- no chain-of-thought, no model text.
export interface ApprovalRequest {
  action: string;
  reason: string;
  proposedChanges: string[];
  risk: "low" | "medium" | "high" | "critical";
  requestedAt: string;
  status: "pending" | "approved" | "denied";
  resolvedAt?: string;
  approvedBy?: string;
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
  /** Interaction, state, accessibility, and responsive behavior requirements. */
  uxRequirements?: string[];
  /** CMS/content-model/editorial workflow requirements grounded in repository evidence. */
  cmsRequirements?: string[];
  /** Existing-token reuse and any explicitly justified new-token requirements. */
  designTokenRequirements?: string[];
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

// Task 8.2 (V7 §23.15) -- architect-escalation.json, written by
// glimmer-engineer.py's `--mode consult` ONLY when glimmer-v2.py's
// deterministic trigger fires (a high/critical DeliveryConcern AND
// architect mode enabled for the session). Merged onto DeliveryReview at
// read time (see server/src/lib/sessions.ts readDeliveryReview) rather
// than served as its own route -- it is always read alongside the review
// it escalates, never independently. consultationFailed marks a
// model-down/spawn-failure degrade path (same convention as
// DeliveryReview.reviewFailed) -- the session outcome is never affected
// either way (§23.15: a second opinion, not a second gate).
export interface ArchitectEscalation {
  question?: string;
  answer?: string;
  consultationFailed?: true;
  reason?: string;
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
  architectEscalation?: ArchitectEscalation;
}

// V7 §23.16 -- delivery-packet.json, assembled once by glimmer-v2.py at
// session close-out (main()'s unconditional `finally` block, right after
// manifest.statuses). Deliberately NOT a duplicate of every full artifact
// (architecture-plan.json/delivery-review.json/visual findings remain
// their own routes) -- this is the concise handoff summary V7 §23.16
// asks for. Fields derived from the session's own DeliveryReview
// (customerReadiness/limitations/forwardPlan/confidence) carry an
// explicit provenance tag (same DataProvenance union every other
// model-derived API field already uses) and are null whenever no
// delivery-review.json exists for the session at all -- never
// fabricated. planRef is null whenever architect mode was never engaged
// for this session.
export interface DeliveryPacket {
  task: string | null;
  planRef: { architectUsed: boolean; architectureApproved: boolean | null } | null;
  changedFiles: string[];
  orchestratorUpdatedFiles: string[];
  verification: { status: "VERIFIED" | "FAILED" | "NOT_RUN"; results: unknown };
  visual: VisualFindingsStatus | "not_run";
  statuses: GlimmerSession["statuses"];
  customerReadiness: {
    value: DeliveryReviewCustomerReadiness | null;
    provenance: DataProvenance;
    reviewFailed?: true;
  } | null;
  limitations: {
    unresolvedItems: string[];
    intentionallyNotChanged: string[];
    concerns: DeliveryConcern[];
    provenance: DataProvenance;
    reviewFailed?: true;
  } | null;
  forwardPlan: {
    nextSteps: DeliveryNextStep[];
    provenance: DataProvenance;
    reviewFailed?: true;
  } | null;
  confidence: {
    level: "low" | "medium" | "high";
    reason: string;
    provenance: DataProvenance;
    reviewFailed?: true;
  } | null;
  humanReviewStatus: string;
  // Round-8 re-review NEW-MN2/NEW-MN1: written by glimmer-v2.py since
  // MJ4/MN1 fixes -- optional so pre-fix packets still parse.
  blockedGates?: string[];
  architectEscalation?:
    { question: string; answer: string } | { consultationFailed: true; reason: string } | null;
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

export interface VisualReference {
  file: string;
  label: string;
  sourcePath?: string | null;
  modelReviewed: boolean;
}

export interface VisualManifest {
  route: string;
  viewports: string[];
  states: string[];
  status: VisualManifestStatus;
  captures: VisualCapture[];
  checks?: string[];
  references?: VisualReference[];
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
  modelId?: string;
  references?: VisualReference[];
  referenceImagePolicy?: "local-only" | "vision-model";
  referencesSentToModel?: string[];
  referencesReviewedByModel?: string[];
}

export type VisualRegressionComparisonStatus =
  "passed" | "failed" | "missing-current" | "stale-current" | "dimension-mismatch";

export interface VisualRegressionBaselineCapture {
  viewport: string;
  state: string;
  sourceScreenshot: string;
  baselineScreenshot: string;
  sha256: string;
  width: number;
  height: number;
}

/** Immutable screenshot baseline captured when a Live Design change set starts. */
export interface VisualRegressionBaseline {
  version: 1;
  id: string;
  sessionId: string;
  changeSetId: string;
  route: string;
  createdAt: string;
  differenceThreshold: number;
  pixelTolerance: number;
  captures: VisualRegressionBaselineCapture[];
}

export interface VisualRegressionComparison {
  viewport: string;
  state: string;
  currentScreenshot: string | null;
  baselineScreenshot: string;
  diffScreenshot: string | null;
  status: VisualRegressionComparisonStatus;
  width: number;
  height: number;
  changedPixels: number;
  totalPixels: number;
  differenceRatio: number;
  differenceThreshold: number;
  message?: string;
}

/** Pixel-level comparison persisted beside the session's visual evidence. */
export interface VisualRegressionReport {
  version: 1;
  sessionId: string;
  changeSetId: string;
  route: string;
  baselineId: string;
  baselineCreatedAt: string;
  createdAt: string;
  status: "passed" | "failed";
  differenceThreshold: number;
  pixelTolerance: number;
  comparisons: VisualRegressionComparison[];
  summary: string;
}

export interface VisualRegressionEvidence {
  baseline: VisualRegressionBaseline | null;
  report: VisualRegressionReport | null;
}

// GET /api/sessions/:id/visual/manifest response body -- combines both
// files glimmer-visual.py writes per run. `findings` is null only when
// findings.json itself is unreadable/absent (shouldn't happen once
// manifest exists, since main() always writes both together, but the route
// tolerates it the same honest way every other opt-in artifact read does).
export interface VisualVerification {
  manifest: VisualManifest;
  findings: VisualFindings | null;
  /** Present for Live Design change sets that opted into a screenshot baseline. */
  regression?: VisualRegressionReport | null;
}

export interface DesignFeedbackPoint {
  x: number;
  y: number;
}

export type DesignFeedbackTool =
  | "comment"
  | "draw"
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "sticky"
  | "color"
  | "typography"
  | "layout";

export interface DesignFeedbackAnnotation {
  id: string;
  screenshot: string;
  viewport: string;
  state: string;
  tool: DesignFeedbackTool;
  points: DesignFeedbackPoint[];
  comment: string;
  /** Structured design intent, never executable CSS or script. */
  value?: string;
  strokeColor?: string;
  fillColor?: string;
  strokeWidth?: 1 | 2 | 4 | 8;
  /** Stable live-preview binding when the annotation was created on the running app. */
  selectorHint?: string;
  sourcePathHint?: string;
  createdAt: string;
}

export interface DesignFeedbackDocument {
  version: 1;
  sessionId: string;
  updatedAt: string;
  annotations: DesignFeedbackAnnotation[];
  variants: DesignVariantRequest[];
  inspirations: DesignInspiration[];
  designProfiles: DesignProfileReference[];
  elementEdits: DesignElementEdit[];
  assetRequests: DesignAssetRequest[];
}

export interface DesignFeedbackUpdate {
  annotations: DesignFeedbackAnnotation[];
  variants: DesignVariantRequest[];
  inspirations: DesignInspiration[];
  designProfiles: DesignProfileReference[];
  elementEdits: DesignElementEdit[];
  assetRequests: DesignAssetRequest[];
}

export type DesignChangeSetStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "implementing"
  | "verifying"
  | "verified"
  | "blocked"
  | "delivered"
  | "rejected";

export type DesignWorkflowTransitionAction =
  "submit_review" | "approve" | "reject" | "return_to_draft" | "deliver" | "reopen";

export interface DesignChangeSetFeedbackRefs {
  annotationIds: string[];
  variantIds: string[];
  inspirationIds: string[];
  elementEditIds: string[];
  assetRequestIds: string[];
}

export interface DesignChangeSetDecision {
  outcome: "approved" | "rejected";
  decidedAt: string;
  note?: string;
}

export interface DesignChangeSetVerificationViewport {
  viewport: string;
  state: string;
  status: "passed" | "warning" | "failed";
  findingCount: number;
  message?: string;
  visualDifferenceRatio?: number;
  visualDifferenceThreshold?: number;
  visualDiffScreenshot?: string;
}

export interface DesignChangeSetVerification {
  status: "not_run" | "passed" | "passed_with_warnings" | "failed";
  checkedAt?: string;
  manifestStatus?: VisualManifestStatus;
  findingsStatus?: VisualFindingsStatus;
  regressionStatus?: "not_configured" | "passed" | "failed";
  viewports: DesignChangeSetVerificationViewport[];
  summary?: string;
}

export interface DesignChangeSetEvent {
  id: string;
  type:
    | "created"
    | "updated"
    | "feedback_linked"
    | "feedback_unlinked"
    | "submitted_for_review"
    | "approved"
    | "rejected"
    | "returned_to_draft"
    | "source_applied"
    | "verification_completed"
    | "rollback_completed"
    | "rollback_blocked"
    | "delivered"
    | "reopened";
  at: string;
  note?: string;
}

/** Durable, resumable unit of work for the Live Design workflow. */
export interface DesignChangeSet {
  id: string;
  title: string;
  goal: string;
  route: string;
  status: DesignChangeSetStatus;
  createdAt: string;
  updatedAt: string;
  componentName?: string;
  selector?: string;
  sourcePath?: string;
  viewport?: string;
  decision?: DesignChangeSetDecision;
  feedbackRefs: DesignChangeSetFeedbackRefs;
  revisionIds: string[];
  rolledBackRevisionIds: string[];
  verification: DesignChangeSetVerification;
  events: DesignChangeSetEvent[];
}

export interface DesignWorkflowDocument {
  version: 1;
  revision: number;
  sessionId: string;
  updatedAt: string;
  activeChangeSetId?: string;
  changeSets: DesignChangeSet[];
}

export interface DesignChangeSetCreateRequest {
  expectedRevision: number;
  title: string;
  goal: string;
  route: string;
  componentName?: string;
  selector?: string;
  sourcePath?: string;
  viewport?: string;
}

export interface DesignChangeSetUpdateRequest {
  expectedRevision: number;
  title?: string;
  goal?: string;
  componentName?: string;
  selector?: string;
  sourcePath?: string;
  viewport?: string;
}

export interface DesignWorkflowTransitionRequest {
  expectedRevision: number;
  action: DesignWorkflowTransitionAction;
  note?: string;
}

export interface DesignWorkflowLinkRequest {
  expectedRevision: number;
  refs: Partial<DesignChangeSetFeedbackRefs>;
}

export interface DesignWorkflowMutationRequest {
  expectedRevision: number;
}

export interface DesignWorkflowRollbackResponse {
  workflow: DesignWorkflowDocument;
  rolledBackRevisionIds: string[];
  skippedRevisionIds: string[];
}

export interface LiveDesignRect {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface LiveDesignTokenReference {
  name: string;
  value: string;
  property: string;
}

export type LiveDesignFramework = "html" | "react" | "vue" | "svelte" | "unknown";

export interface LiveDesignBreadcrumb {
  tagName: string;
  selector: string;
  label: string;
}

export interface LiveDesignStyleDeclarationSource {
  property: string;
  value: string;
  important: boolean;
}

/** One matched cascade layer reported by the isolated localhost preview. */
export interface LiveDesignStyleSource {
  selector: string;
  source: string;
  specificity: string;
  inherited: boolean;
  declarations: LiveDesignStyleDeclarationSource[];
}

/** Metadata selected inside a local preview. Values are descriptive and never executable. */
export interface LiveDesignElement {
  selector: string;
  tagName: string;
  text: string;
  attributes: Record<string, string>;
  styles: {
    color: string;
    backgroundColor: string;
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
    padding: string;
    margin: string;
    gap: string;
    borderColor: string;
    borderWidth: string;
    borderRadius: string;
    opacity: string;
    display: string;
    flexDirection: string;
    flexWrap: string;
    alignItems: string;
    alignContent: string;
    justifyContent: string;
    width: string;
    height: string;
    minWidth: string;
    maxWidth: string;
    minHeight: string;
    maxHeight: string;
    position: string;
    top: string;
    right: string;
    bottom: string;
    left: string;
    zIndex: string;
    gridTemplateColumns: string;
    gridTemplateRows: string;
    gridAutoFlow: string;
    gridColumn: string;
    gridRow: string;
    order: string;
    flex: string;
    boxSizing: string;
  };
  rect: LiveDesignRect;
  sourcePathHint?: string;
  tokens: LiveDesignTokenReference[];
  framework?: LiveDesignFramework;
  componentName?: string;
  stableId?: string;
  breadcrumbs?: LiveDesignBreadcrumb[];
  styleSources?: LiveDesignStyleSource[];
}

export type LiveDesignProposalField =
  | "text"
  | "imageSource"
  | "textColor"
  | "backgroundColor"
  | "fontFamily"
  | "fontSizePx"
  | "fontWeight"
  | "lineHeight"
  | "paddingPx"
  | "marginPx"
  | "gapPx"
  | "borderColor"
  | "borderWidthPx"
  | "borderRadiusPx"
  | "opacity"
  | "direction"
  | "align"
  | "display"
  | "flexWrap"
  | "alignItemsValue"
  | "alignContent"
  | "width"
  | "height"
  | "minWidth"
  | "maxWidth"
  | "minHeight"
  | "maxHeight"
  | "position"
  | "top"
  | "right"
  | "bottom"
  | "left"
  | "zIndex"
  | "gridTemplateColumns"
  | "gridTemplateRows"
  | "gridAutoFlow"
  | "gridColumn"
  | "gridRow"
  | "order"
  | "flex"
  | "boxSizing";

export interface LiveDesignProposalChange {
  field: LiveDesignProposalField;
  label: string;
  before: string;
  after: string;
  reason: string;
}

export interface LiveDesignProposalRequest {
  element: LiveDesignElement;
  prompt: string;
}

export interface LiveDesignProposalResponse {
  id: string;
  prompt: string;
  summary: string;
  changes: LiveDesignProposalChange[];
  provenance: "model-output" | "deterministic-fallback";
  createdAt: string;
}

export interface LiveDesignStructureTarget {
  selector: string;
  tagName: string;
  text: string;
  attributes: Record<string, string>;
  sourcePathHint?: string;
  framework?: LiveDesignFramework;
  componentName?: string;
}

export interface LiveDesignStructureNode extends LiveDesignStructureTarget {
  label: string;
  canHaveChildren: boolean;
  hidden: boolean;
  children: LiveDesignStructureNode[];
}

export interface LiveDesignStructureSnapshot {
  roots: LiveDesignStructureNode[];
  total: number;
  truncated: boolean;
}

export type LiveDesignInsertPreset = "section" | "heading" | "paragraph" | "button" | "divider";

export type LiveDesignStructureOperationRequest =
  | {
      kind: "reorder";
      moving: LiveDesignStructureTarget;
      anchor: LiveDesignStructureTarget;
      placement: "before" | "after";
      changeSetId?: string;
    }
  | {
      kind: "reparent";
      moving: LiveDesignStructureTarget;
      target: LiveDesignStructureTarget;
      placement: "inside-start" | "inside-end";
      changeSetId?: string;
    }
  | {
      kind: "insert";
      target: LiveDesignStructureTarget;
      placement: "inside-start" | "inside-end" | "before" | "after";
      preset: LiveDesignInsertPreset;
      text: string;
      changeSetId?: string;
    };

export type LiveDesignBreakpoint = "mobile" | "tablet" | "desktop";

export type LiveDesignResponsiveProperty =
  | "color"
  | "background-color"
  | "font-size"
  | "font-weight"
  | "line-height"
  | "padding"
  | "margin"
  | "gap"
  | "border-width"
  | "border-radius"
  | "opacity"
  | "flex-direction"
  | "align-items"
  | "justify-content";

export interface LiveDesignResponsiveOverrideRequest {
  element: LiveDesignElement;
  source: LiveDesignSourceCandidate;
  breakpoint: LiveDesignBreakpoint;
  property: LiveDesignResponsiveProperty;
  value: string;
  changeSetId?: string;
}

export type LiveDesignStyleScope = "instance" | "component";

export type LiveDesignStyleProperty =
  | "display"
  | "width"
  | "height"
  | "min-width"
  | "max-width"
  | "min-height"
  | "max-height"
  | "position"
  | "top"
  | "right"
  | "bottom"
  | "left"
  | "z-index"
  | "grid-template-columns"
  | "grid-template-rows"
  | "grid-auto-flow"
  | "grid-column"
  | "grid-row"
  | "flex-direction"
  | "flex-wrap"
  | "align-items"
  | "align-content"
  | "justify-content"
  | "order"
  | "flex"
  | "gap"
  | "padding"
  | "margin"
  | "box-sizing";

export interface LiveDesignStyleOverrideRequest {
  element: LiveDesignElement;
  source: LiveDesignSourceCandidate;
  scope: LiveDesignStyleScope;
  /** Optional existing class chosen from element.attributes.class. */
  className?: string;
  declarations: Partial<Record<LiveDesignStyleProperty, string>>;
  changeSetId?: string;
}

export type LiveDesignSourceCandidateKind = "text-node" | "css-token" | "css-declaration";

/** Versioned source binding returned by the gateway and revalidated before every write. */
export interface LiveDesignSourceCandidate {
  id: string;
  path: string;
  line: number;
  column: number;
  offset: number;
  kind: LiveDesignSourceCandidateKind;
  expected: string;
  fileHash: string;
  excerpt: string;
  tokenName?: string;
  property?: string;
  confidence?: "exact" | "hint" | "ambiguous";
  reason?: string;
}

export interface LiveDesignTokenNode {
  name: string;
  value: string;
  path: string;
  line: number;
  aliases: string[];
  referencedBy: string[];
}

export interface LiveDesignCmsReference {
  path: string;
  field: string;
  line: number;
  value: string;
}

export interface LiveDesignAuditFinding {
  id: string;
  severity: "info" | "warning" | "error";
  category: "accessibility" | "responsive" | "design-system" | "content";
  message: string;
  suggestion: string;
}

export interface LiveDesignResolveRequest {
  element: LiveDesignElement;
}

export interface LiveDesignResolveResponse {
  candidates: LiveDesignSourceCandidate[];
  branch: string;
  directApplyAllowed: boolean;
  directApplyReason?: string;
  scannedFiles: number;
  truncated: boolean;
  tokenGraph?: LiveDesignTokenNode[];
  cmsReferences?: LiveDesignCmsReference[];
  auditFindings?: LiveDesignAuditFinding[];
}

export interface LiveDesignApplyRequest {
  candidate: LiveDesignSourceCandidate;
  replacement: string;
  changeSetId?: string;
}

export type LiveDesignRevisionKind =
  | LiveDesignSourceCandidateKind
  | "bridge-install"
  | "transaction"
  | "structure-insert"
  | "structure-reorder"
  | "structure-reparent"
  | "responsive-override"
  | "style-override";

export interface LiveDesignRevision {
  id: string;
  path: string;
  kind: LiveDesignRevisionKind;
  before: string;
  after: string;
  createdAt: string;
  rolledBackAt?: string;
  changeCount?: number;
  changeSetId?: string;
}

export interface LiveDesignApplyResponse {
  applied: true;
  revision: LiveDesignRevision;
}

export interface LiveDesignRollbackResponse {
  rolledBack: true;
  revision: LiveDesignRevision;
}

export interface LiveDesignTransactionEdit {
  candidate: LiveDesignSourceCandidate;
  replacement: string;
}

export interface LiveDesignTransactionRequest {
  edits: LiveDesignTransactionEdit[];
  changeSetId?: string;
}

export interface LiveDesignTransactionResponse {
  applied: true;
  revision: LiveDesignRevision;
}

export interface LiveDesignStructureOperationResponse {
  applied: true;
  revision: LiveDesignRevision;
}

export interface LiveDesignResponsiveOverrideResponse {
  applied: true;
  revision: LiveDesignRevision;
}

export interface LiveDesignStyleOverrideResponse {
  applied: true;
  revision: LiveDesignRevision;
  selector: string;
}

export interface LiveDesignHistoryResponse {
  revisions: LiveDesignRevision[];
}

export interface LiveDesignBridgeInstallRequest {
  scriptUrl: string;
  parentOrigin: string;
}

export interface LiveDesignBridgeInstallResponse {
  installed: true;
  path: string;
  revision: LiveDesignRevision;
}

/** Crash-recovery journal for unsaved Live Design UI and preview state. */
export interface LiveDesignDraftJournal {
  version: 1;
  sessionId: string;
  route: string;
  updatedAt: string;
  sequence: number;
  selectedSelector?: string;
  selectedSelectors: string[];
  lockedSelectors: string[];
  hiddenSelectors: string[];
  activeTab: string;
  viewportId: string;
  zoom: number;
  inspectorWidth: number;
  elementPrompt: string;
  annotationComment: string;
  annotationTool: DesignFeedbackTool;
  annotationPoints: DesignFeedbackPoint[];
  annotating?: boolean;
  assetPrompt?: string;
  assetPath?: string;
  previewMode?: boolean;
  resizeMode?: boolean;
  responsiveBreakpoint: LiveDesignBreakpoint;
  responsiveProperty: LiveDesignResponsiveProperty;
  responsiveValue: string;
  responsiveOverrides: Record<string, string>;
  responsivePreviewed?: boolean;
  styleScope: LiveDesignStyleScope;
  selectedClass?: string;
  textCandidateId?: string;
  tokenCandidateId?: string;
  tokenReplacement?: string;
  tokenBindingProperty?: string;
  draft?: Partial<Record<LiveDesignProposalField, string>>;
  originalDraft?: Partial<Record<LiveDesignProposalField, string>>;
  pendingStructure?: LiveDesignStructureOperationRequest;
  proposal?: LiveDesignProposalResponse;
}

export type LiveDesignDraftUpdate = Omit<
  LiveDesignDraftJournal,
  "version" | "sessionId" | "updatedAt"
>;

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
  // followup-1-2 review (M3): V7 §15 write-time scope-expansion approval
  // (glimmer-engineer.py's _enforce_scope_expansion_approval) emits this
  // SAME event type for an out-of-scope write a human explicitly approved
  // -- additive/optional so an older emitter (or v2.py's own unrelated
  // post-hoc scope_expanded, which never sets these) keeps working
  // unchanged. approved is only ever present+true on a human-authorized
  // expansion; absent means "not approved" (either denied/timed out, or
  // this is the pre-existing unapproved-expansion event shape).
  approved?: boolean;
  approvedBy?: string;
  approvalId?: string;
}
export interface RepairStartedEvent extends GlimmerEventBase {
  type: "repair_started";
  iteration: number;
}
export interface ParserRecoveryEvent extends GlimmerEventBase {
  type: "parser_recovery";
  attempt: number;
  payloadPath: string;
  // Round 6 (V7 §17 recovery ladder): which recovery tier this attempt's
  // failure was running under -- "thinking_disabled" (attempts 2+) or
  // "reduced_context" (the tier-3 attempt); omitted for the plain first
  // attempt. requestId correlates this event with the ModelProvider
  // request-id logged for the same call. Both additive/optional so older
  // emitters/consumers with neither field keep working.
  strategy?: string;
  requestId?: string;
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
  // Round 6 (V7 §16 Model Runtime): the ModelProvider request id for the
  // call this retry announces -- optional/additive, see ParserRecoveryEvent.
  requestId?: string;
}
export interface ModelRequestStartedEvent extends GlimmerEventBase {
  type: "model_request_started";
  requestId: string;
  role: "engineer" | "architect" | "consult";
  providerId: string;
  modelId: string;
}
// context_selected (Task 5.1, V7 §7 context tiers): tier0Chars (system +
// task -- permanent, never compacted), tier1Chars (active tool-result
// history live in the conversation), tier2Refs (how many Tier1 messages
// have been pushed out to Tier2 "retrievable via get_evidence" stubs so
// far), tier3Note (a static description of what's cold/on-disk -- never
// a byte count, Tier3 is never loaded). Emitted once at run start and
// again only when compaction actually moves something to Tier2 (never
// per-turn). Fix round 1 (MED): replaces the Round-1 systemBytes/
// taskBytes/skillsBytes/evidenceBytes shape, which glimmer-engineer.py
// never actually emits past Task 5.1.
export interface ContextSelectedEvent extends GlimmerEventBase {
  type: "context_selected";
  tier0Chars: number;
  tier1Chars: number;
  tier2Refs: number;
  tier3Note: string;
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
// Task 7.1/7.2 (V7 documentation intelligence): emitted by glimmer-v2.py's
// finally-block doc pass when the TARGET repo carries a docs/graph.json.
// Deterministic node ids/statuses/file lists only -- never model text.
export interface DocumentationImpactDetectedEvent extends GlimmerEventBase {
  type: "documentation_impact_detected";
  files: string[];
  nodeIds: string[];
}
export interface DocumentationStaleDetectedEvent extends GlimmerEventBase {
  type: "documentation_stale_detected";
  nodeId: string;
  reason: string;
}
export interface DocumentationVerifiedEvent extends GlimmerEventBase {
  type: "documentation_verified";
  nodeId: string;
  status: string;
}

// Task 8.3 (V7 §14/§35): emitted by glimmer-engineer.py's
// request_approval_and_wait, once per approval request, right before the
// poll loop over approvals.json starts. Deterministic fields only.
export interface ApprovalRequestedEvent extends GlimmerEventBase {
  type: "approval_requested";
  approvalId: string;
  action: string;
  reason: string;
  risk: ApprovalRequest["risk"];
}

// Task 8.2 (V7 §23.16): emitted once by glimmer-v2.py's `finally` block,
// right after delivery-packet.json/packet-summary.txt are written, on
// every exit path. No fields -- mirrors glimmer_events.py's own
// unconditional `emit(..., "delivery_packet_created")` call exactly (no
// payload there either). This was a confirmed gap from the 8.3 review:
// present in glimmer_events.EVENT_TYPES since 8.2, but absent here, so
// isGlimmerEvent silently dropped it at the gateway.
export interface DeliveryPacketCreatedEvent extends GlimmerEventBase {
  type: "delivery_packet_created";
}

export interface ClaimValidationCompletedEvent extends GlimmerEventBase {
  type: "claim_validation_completed";
  verified: number;
  partial: number;
  rejected: number;
  confidence: "high" | "medium" | "low";
}

export interface RepoIndexCompletedEvent extends GlimmerEventBase {
  type: "repo_index_completed";
  supportedFiles: number;
  treeSitterFiles: number;
  partial: boolean;
  unsupportedLanguages: string[];
}

export interface ClarificationRequestedEvent extends GlimmerEventBase {
  type: "clarification_requested";
  clarificationId: string;
  question: string;
}

export interface ClarificationResolvedEvent extends GlimmerEventBase {
  type: "clarification_resolved";
  clarificationId: string;
  optionId?: string | null;
}

export interface ModelRoutingDecisionEvent extends GlimmerEventBase {
  type: "model_routing_decision";
  role: "engineer" | "architect" | "consult";
  risk: string;
  providerId: string;
  modelId: string;
  reason: "high-risk-override" | "configured-role";
  criticIndependence?: "independent" | "same-model" | "unavailable";
}

export interface RepairStrategyRejectedEvent extends GlimmerEventBase {
  type: "repair_strategy_rejected";
  strategyId: string;
  failureSignature: string;
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
  | ModelRequestStartedEvent
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
  | ArchitectConsultedEvent
  | DocumentationImpactDetectedEvent
  | DocumentationStaleDetectedEvent
  | DocumentationVerifiedEvent
  | ApprovalRequestedEvent
  | DeliveryPacketCreatedEvent
  | ClaimValidationCompletedEvent
  | RepoIndexCompletedEvent
  | ClarificationRequestedEvent
  | ClarificationResolvedEvent
  | ModelRoutingDecisionEvent
  | RepairStrategyRejectedEvent;

const EVENT_TYPES: ReadonlySet<GlimmerEvent["type"]> = new Set([
  "tool_started",
  "tool_completed",
  "tool_blocked",
  "file_changed",
  "verification_started",
  "verification_completed",
  "agent_state_changed",
  "candidate_selected",
  "scope_expanded",
  "repair_started",
  "parser_recovery",
  "session_completed",
  "session_created",
  "skill_loaded",
  "model_retry",
  "model_request_started",
  "context_selected",
  "architect_planning_started",
  "architect_plan_created",
  "architect_review_requested",
  "architect_review_completed",
  "architect_replan_started",
  "architect_autotriggered",
  "task_created",
  "task_status_changed",
  "task_list_completed",
  "task_override_applied",
  "visual_verification_started",
  "visual_finding_detected",
  "visual_verification_completed",
  "delivery_review_started",
  "delivery_review_completed",
  "architect_consult_advised",
  "architect_consulted",
  "approval_requested",
  "delivery_packet_created",
  "documentation_impact_detected",
  "documentation_stale_detected",
  "documentation_verified",
  "claim_validation_completed",
  "repo_index_completed",
  "clarification_requested",
  "clarification_resolved",
  "model_routing_decision",
  "repair_strategy_rejected",
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

// Task 7.5 (V7 "System Explorer"): docs/graph.json is written by glimmer-v2.py's
// doc pass into the TARGET repo's workspace (see server/src/lib/sessions.ts
// readDocGraph), never by the gateway itself -- these types describe that
// on-disk shape verbatim, so the Control Center only ever displays what the
// orchestrator actually wrote (id/status/confidence/provenance), never a
// fabricated title or status.
export type DocNodeType = "system" | "service" | "route" | "schema" | "config" | "doc";
export type DocNodeStatus =
  "CURRENT" | "STALE" | "UNVERIFIED" | "MISSING" | "DEPRECATED" | "GENERATED";
// glimmer-v2.py's verify_doc_nodes/build_docs_bootstrap_graph never write a
// numeric confidence -- always one of these three strings (see DOC_STATUS_*
// -> confidence mapping in glimmer-v2.py). `string` (not a narrower union)
// so a hand-edited docs/graph.json with an unrecognized value still displays
// verbatim instead of failing to parse.
export type DocNodeConfidence = "high" | "low" | "unknown" | (string & {});

export interface DocProvenance {
  evidence: string[];
  sha: string | null;
  updatedAt?: string;
}

export interface DocNode {
  id: string;
  type: DocNodeType;
  path: string;
  title: string;
  status: DocNodeStatus;
  confidence: DocNodeConfidence;
  provenance: DocProvenance;
}

export interface DocEdge {
  from: string;
  to: string;
  kind: string;
}

export interface DocGraph {
  schemaVersion: number;
  nodes: DocNode[];
  edges: DocEdge[];
}

// M6 fix (round-7 review): findDocGraph walks every session's workspace and
// returns the first docs/graph.json it finds -- with two sessions pointed at
// different repos, "first found" must never be silently ambiguous. The API
// response always carries where the graph came from so the UI can label it.
export interface DocGraphSource {
  workspace: string;
  sessionId: string;
}

// Lifecycle of the local llama-server process, as far as the gateway can
// honestly tell. Deliberately separate from ModelStatus.status, which stays
// purely probe-derived: spawning a process is never evidence that the model
// is ONLINE — only a 200 from /health is.
//   OFFLINE  nothing listening, nothing spawned by us still alive
//   STARTING we spawned the start script and the port is not accepting yet
//   LOADING  the port answers but /health isn't 200 yet (llama-server replies
//            503 "Loading model" for the ~1-2 min it takes to load the GGUF)
//   ONLINE   /health said so (or 401/403 — reachable, auth-gated)
//   FAILED   the process we spawned exited without ever coming up
export type ModelRunState = "OFFLINE" | "STARTING" | "LOADING" | "ONLINE" | "FAILED";

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
  // Process-control facts, served by /api/model/{status,start,stop} only —
  // absent from the dashboard's /api/status payload, which probes and nothing
  // more. exitCode/logTail are present only for FAILED.
  runState?: ModelRunState;
  exitCode?: number | null;
  logTail?: string;
}

export type CliIntegrationId =
  | "github_cli"
  | "git"
  | "node"
  | "npm"
  | "python"
  | "cargo"
  | "pnpm"
  | "yarn"
  | "homebrew"
  | "orchestrator";

export type CliIntegrationState = "ready" | "authentication_required" | "missing" | "blocked";

export type CliAgentAccess =
  "runtime" | "read_only" | "validation_only" | "approval_required" | "blocked";

export interface CliIntegration {
  id: CliIntegrationId;
  name: string;
  executable: string;
  required: boolean;
  state: CliIntegrationState;
  installed: boolean;
  authenticated?: boolean;
  version?: string;
  path?: string;
  source: "bundled" | "path" | "configured";
  agentAccess: CliAgentAccess;
  detail: string;
  installCommand?: string;
  authCommand?: string;
}

export interface CliIntegrationsStatus {
  checkedAt: string;
  platform: string;
  integrations: CliIntegration[];
  policy: {
    automaticSystemInstall: false;
    externalWritesRequireApproval: true;
    gitPushAllowed: false;
  };
}

export type DeveloperClientId = "cursor" | "vscode" | "warp" | "claude_code" | "codex" | "opencode";

export type WorkspaceHandoffClientId = Extract<DeveloperClientId, "cursor" | "vscode" | "warp">;

export type WorkspaceHandoffMethod = "cli" | "application" | "uri";

export type DeveloperClientState = "ready" | "app_only" | "missing";

export interface DeveloperClient {
  id: DeveloperClientId;
  name: string;
  kind: "editor" | "terminal" | "agent";
  state: DeveloperClientState;
  installed: boolean;
  workspaceHandoff: boolean;
  appPath?: string;
  executable?: string;
  executablePath?: string;
  version?: string;
  detail: string;
  installCommand?: string;
  mcp: {
    supported: true;
    setupMethod: "file" | "command_palette" | "settings" | "cli";
    setupHint: string;
    configPath?: string;
    configPresent?: boolean;
    inspectCommand?: string;
    docsUrl: string;
  };
}

export interface WorkspaceHandoffResult {
  clientId: WorkspaceHandoffClientId;
  workspace: string;
  opened: true;
  method: WorkspaceHandoffMethod;
}

export interface DeveloperClientsStatus {
  checkedAt: string;
  platform: string;
  clients: DeveloperClient[];
  policy: {
    automaticInstall: false;
    automaticConfigWrites: false;
    credentialContentsInspected: false;
    agentNestingAllowed: false;
  };
}

export type IntegrationProfileTargetId = "codex" | "claude" | "glimmer";
export type IntegrationProfileTargetState = "in_sync" | "drift" | "missing";

export interface IntegrationProfilePreview {
  profile: "creatorhub-engineering";
  checkedAt: string;
  desiredVersion: string | null;
  sourcePath?: string;
  canApply: boolean;
  latestRollbackId?: string;
  targets: Array<{
    id: IntegrationProfileTargetId;
    name: string;
    state: IntegrationProfileTargetState;
    currentVersion?: string;
    desiredVersion?: string;
    path: string;
    action: string;
  }>;
  policy: {
    previewRequired: true;
    backupBeforeApply: true;
    credentialsInspected: false;
    arbitraryCommandsExecuted: false;
  };
}

export interface IntegrationProfileApplyResult {
  backupId: string | null;
  appliedTargets: IntegrationProfileTargetId[];
  preview: IntegrationProfilePreview;
}

export interface IntegrationProfileRollbackResult {
  backupId: string;
  rolledBack: true;
  preview: IntegrationProfilePreview;
}

export type McpIntegrationId = "context7" | "playwright" | "github";

export type McpIntegrationState =
  | "active"
  | "configured_restart_required"
  | "available"
  | "missing_requirement"
  | "authentication_required";

export interface McpIntegration {
  id: McpIntegrationId;
  name: string;
  description: string;
  version: string;
  adoption: "very_high" | "high";
  recommended: boolean;
  configured: boolean;
  active: boolean;
  state: McpIntegrationState;
  agentAccess: "read_only" | "approval_required";
  detail: string;
  requirement?: string;
  toolCount: number;
}

export interface McpIntegrationsStatus {
  checkedAt: string;
  configPath: string;
  configExists: boolean;
  configError?: string;
  restartRequired: boolean;
  customServerCount: number;
  runtime: {
    reachable: boolean;
    totalToolCount: number;
    mcpToolCount: number;
  };
  integrations: McpIntegration[];
  policy: {
    arbitraryServerCommandsFromUi: false;
    credentialsReturnedByApi: false;
    unclassifiedToolsRequireApproval: true;
  };
}

export interface McpConfigUpdate {
  enabled: McpIntegrationId[];
}

export type MobbinPlatform = "ios" | "web";
export type MobbinSearchMode = "standard" | "deep";

export interface MobbinIntegrationStatus {
  configured: boolean;
  keyPath: string;
  docsUrl: string;
  availability: "team-enterprise-api";
  policy: {
    credentialsReturnedByApi: false;
    fixedApiOrigin: "https://api.mobbin.com";
    imageUrlsAreRemoteAndExpiring: true;
    imagesProxiedThroughGateway: true;
  };
}

export interface MobbinCredentialUpdate {
  apiKey: string;
}

export interface MobbinSearchRequest {
  query: string;
  platform: MobbinPlatform;
  mode?: MobbinSearchMode;
  limit?: number;
}

export interface MobbinScreen {
  id: string;
  /** Opaque, short-lived handle for the gateway's validated image proxy. */
  imageToken: string;
  imageWidth?: number;
  imageHeight?: number;
  imageExpiresAt?: string;
  mobbinUrl: string;
  appName: string;
  platform: MobbinPlatform;
}

export interface MobbinSearchResult {
  query: string;
  platform: MobbinPlatform;
  screens: MobbinScreen[];
}

export type RuntimeComponentId = "gateway" | "python" | "orchestrator" | "model";
export type RuntimeComponentState = "ready" | "degraded" | "unavailable";

export interface RuntimeComponentCheck {
  id: RuntimeComponentId;
  label: string;
  state: RuntimeComponentState;
  required: boolean;
  detail: string;
  version?: string;
  source?: "bundled" | "configured" | "local";
}

/** Cheap liveness contract used by the native gateway supervisor. */
export interface GatewayHealth {
  service: "glimmer-gateway";
  status: "ok";
  version: string;
  instanceId: string;
  parentPid?: number;
  timestamp: string;
  uptimeSeconds: number;
}

/** Deep runtime readiness. An offline optional model degrades but does not block coreReady. */
export interface GatewayReadiness {
  status: RuntimeComponentState;
  coreReady: boolean;
  checkedAt: string;
  components: RuntimeComponentCheck[];
}

export interface DiagnosticsStatus {
  health: GatewayHealth;
  readiness: GatewayReadiness;
  cli: CliIntegrationsStatus;
  mcp: McpIntegrationsStatus;
}

export interface RepairCheck extends RuntimeComponentCheck {
  repaired: boolean;
}

export interface RepairResult {
  checkedAt: string;
  repaired: boolean;
  reinstallRequired: boolean;
  checks: RepairCheck[];
  actions: string[];
  backupPath?: string;
  recovery?: { reattached: number; interrupted: number; completed: number };
}

export interface RecoverySmokeResult {
  status: "passed" | "failed";
  checkedAt: string;
  checks: Array<{
    id: "runtime" | "state-write" | "session-index" | "workspace-leases";
    ok: boolean;
    detail: string;
  }>;
}

export type ModelRole = "engineer" | "architect" | "consult" | "vision";

export interface ModelRegistryEntry {
  id: string;
  label: string;
  baseUrl: string;
  modelId: string;
  hasApiKey: boolean;
}

export interface ModelRegistry {
  version: 1;
  models: ModelRegistryEntry[];
  roles: Record<ModelRole, string>;
  routing?: AdaptiveRoutingConfig;
  source: "default" | "saved";
}

export interface AdaptiveRoutingConfig {
  enabled: boolean;
  highRisk: Partial<Record<ModelRole, string>>;
  criticProviderId: string | null;
  requireIndependentCritic: boolean;
}

export interface ModelRegistryUpdateEntry {
  id: string;
  label: string;
  baseUrl: string;
  modelId: string;
  /** Omit/blank to preserve an existing key; never returned by the API. */
  apiKey?: string;
  /** Removes this registry entry's safe, gateway-owned key file. */
  clearApiKey?: boolean;
}

export interface ModelRegistryUpdate {
  models: ModelRegistryUpdateEntry[];
  roles: Record<ModelRole, string>;
  routing?: AdaptiveRoutingConfig;
}

export interface RepoIndexFile {
  path: string;
  language: string;
  bytes: number;
  sha256: string;
  parser: "tree-sitter" | "lexical";
  parseStatus: string;
  package: string | null;
  owners: string[];
  isTest: boolean;
}

export interface RepoIndexSymbol {
  id: string;
  name: string;
  kind: string;
  path: string;
  line: number;
  provenance: "tree-sitter" | "lexical";
}

export interface RepoIndexV1 {
  schemaVersion: 1;
  generatedAt: string;
  workspace: string;
  head: string;
  dirtyHash: string;
  cacheKey: string;
  parserVersions: Record<string, string>;
  coverage: {
    supportedFiles: number;
    candidateFiles: number;
    treeSitterFiles: number;
    lexicalFallbackFiles: number;
    skippedLargeFiles: number;
    unsupportedLanguages?: string[];
    unsupportedOrLexicalLanguages?: string[];
    partial: boolean;
    ratio: number;
    limits: { maxFiles: number; maxFileBytes: number; maxSeconds: number };
  };
  files: RepoIndexFile[];
  symbols: RepoIndexSymbol[];
  edges: Array<Record<string, unknown>>;
  routes: Array<Record<string, unknown>>;
  tests: Array<{ source: string; tests: string[]; provenance: string }>;
  diagnostics: string[];
}

export interface VerificationCandidate {
  command: string;
  package: string;
  type: "typecheck" | "unit" | "lint" | "build" | "cargo" | "python" | "make" | "visual";
  level: "required" | "recommended";
  reason: string;
  provenance: "package-script" | "cargo" | "python" | "makefile" | "semantic-index" | "fallback";
  /** Temporary compatibility aliases written by pre-V2 orchestrators. */
  kind?: string;
  tier?: string;
}

// Task 4c(2/3): one page of the gateway's read-only directory browser
// (GET /api/fs/dirs). Names only — no file contents, sizes, or permissions.
// `root` and `path` are the REALPATH-resolved absolute paths the server
// actually listed (not the caller's spelling), `parent` is null at the root
// so the UI can never navigate above it, and `truncated` is true only when
// entries were genuinely dropped by the result cap.
export interface FsListing {
  root: string;
  path: string;
  parent: string | null;
  entries: { name: string; isDir: boolean }[];
  truncated: boolean;
}

// Round A / Task A1: one file's text for the read-only code viewer
// (GET /api/fs/file). Same containment as FsListing above.
//
// The three fields the UI must never blur together:
//   * `size` is always the REAL on-disk byte size, `bytesReturned` is what
//     this response actually carries, and `truncated` is true only when bytes
//     past the ceiling exist — so a capped file can never render as complete.
//   * `content` is null, never "", when nothing was decoded (binary): an
//     empty string would be indistinguishable from a genuinely empty file.
//   * `binary` true means the bytes were refused, not shown as garbage.
// `path` is the realpath-resolved path the server actually read, not the
// caller's spelling.
export interface FsFile {
  path: string;
  size: number;
  bytesReturned: number;
  truncated: boolean;
  binary: boolean;
  content: string | null;
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
  recentSessions: Array<
    Pick<GlimmerSession, "id" | "task" | "status" | "changedFiles" | "completedAt">
  >;
  verification: VerificationSummary | null;
}

export interface TaskIntelligence {
  likelyArea: string | null;
  likelyPackage: string | null;
  suggestedVerification: string[];
  verificationCandidates?: VerificationCandidate[];
  estimatedRisk: RiskLevel | null;
  provenance: DataProvenance;
  // Task 4c(b): which repo map the fields above were (or were not) derived
  // from -- a null likelyArea means something different in each case, and the
  // UI must be able to say which:
  //   workspace-matched   the caller named a workspace and a session for THAT
  //                       workspace had a repo-map.json (the only case where
  //                       the fields describe the user's own repository)
  //   unmatched-workspace the caller named a workspace and no session for it
  //                       has a repo map yet -- fields are null because
  //                       nothing is known, never because a different repo's
  //                       map was substituted
  //   first-found         no workspace was named, so the first repo map found
  //                       across all sessions was used (the pre-existing
  //                       repository-screen behavior) -- it may belong to a
  //                       different repo, so it is labeled, never implied
  //   none                no workspace named and no repo map exists anywhere
  repoMapStatus: "workspace-matched" | "unmatched-workspace" | "first-found" | "none";
}

export interface LocalQualityMetrics {
  schemaVersion: 1;
  sessionsScanned: number;
  reports: number;
  verifiedClaims: number;
  partialClaims: number;
  rejectedClaims: number;
  claimPrecision: number | null;
  averageGraphCoverage: number | null;
  candidateRecallAt5: number | null;
  evaluation: { live: unknown | null; stub: unknown | null };
  routing: {
    decisions: number;
    highRiskOverrides: number;
    criticIndependence: Record<"independent" | "same-model" | "unavailable", number>;
  };
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

// Round B / Task B1: a line range selected in the read-only code viewer.
// The client sends only this pointer, never arbitrary evidence text; the
// gateway re-reads the file through the same workspace-confined boundary as
// GET /api/fs/file and labels the resulting excerpt before it reaches the
// tool-less assistant request.
export interface RepositorySelection {
  path: string;
  startLine: number;
  endLine: number;
}

// §27/§4.1 workspace creation — POST /api/workspaces response.
export interface CreateWorkspaceResult {
  workspace: string;
  branch: string;
  baselineSha: string;
}

const OPEN_ENDED_IMPROVEMENT_PATTERNS = [
  /^(?:kan du\s+)?(?:(?:se(?:\s+på)?|sjekk|vurder|analyser|gjennomgå)\s+)?(?:hva|hvilke)\b.*\b(?:bedre|forbedres|forbedringer|fikses|rettes)\b/i,
  /^(?:kan du\s+)?(?:finn|identifiser|kartlegg)\b.*\b(?:forbedring(?:er|smuligheter)?|svakheter|problemer)\b/i,
  /^(?:can you\s+)?(?:(?:look at|check|assess|analy[sz]e|review)\s+)?(?:what|which)\b.*\b(?:better|improved|improvement|fixed)\b/i,
  /^(?:can you\s+)?(?:find|identify|map)\b.*\b(?:improvements?|weaknesses|issues)\b/i,
];

/** Narrow deterministic inference shared by every TaskContract producer. */
export function inferTaskIntent(objective: string): TaskIntent {
  const normalized = objective.normalize("NFKC").trim().replace(/\s+/g, " ");
  const improvementAssessment =
    normalized.length > 0 &&
    normalized.length <= 240 &&
    OPEN_ENDED_IMPROVEMENT_PATTERNS.some((pattern) => pattern.test(normalized));
  return {
    kind: improvementAssessment ? "improvement-assessment" : "direct",
    source: "deterministic-inference",
  };
}

export function taskModeAllowsWrites(mode: TaskMode): boolean {
  return mode !== "inspect" && mode !== "plan" && mode !== "review";
}
