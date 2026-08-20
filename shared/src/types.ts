
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
  | "cancelled";

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
  checks: VerificationCheckResult[];
}

export interface TaskContract {
  objective: string;
  scope: {
    package: "repository" | "frontend" | "backend" | "directory" | "files";
    area?: string;
    paths?: string[];
  };
  mode: "inspect" | "plan" | "implement" | "debug" | "test" | "review";
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
  repairsUsed: number;
  repairBudget: number;
  // C2/C3 (glimmer-v7): opt-in architect-mode gate/plan summary and the
  // terminal-failure classifier, mirrored from manifest.json's own
  // "gates" / "architectPlan" / "failure" fields when present.
  gates?: { architectureApproved: boolean | null };
  architectPlan?: { used: boolean; risk: string | null };
  failure?: { class: string; detail: string; evidenceIds: string[] };
  // §14 Diff Review — human "accept for review" fact. Written ONLY by the
  // gateway (POST /sessions/:id/accept), never by the orchestrator/model:
  // technical verification and human acceptance must stay two separate
  // facts, or the model could self-approve its own delivered work.
  humanAcceptance?: HumanAcceptance;
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
  area?: string;
  existingPatterns?: ArchitecturePlanPattern[];
  candidateFiles?: ArchitecturePlanCandidateFile[];
  constraints?: string[];
  implementationPlan?: string[];
  verificationPlan?: string[];
  expectedScope?: { minFiles?: number; maxFiles?: number };
  uncertainties?: string[];
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

// C3 (glimmer-v7): flat evidence-driven task list, written to tasks.json.
export interface GlimmerTask {
  id: string;
  description: string;
  kind: "implementation" | "verification";
  dependsOn: string[];
  status: "pending" | "in_progress" | "complete" | "failed";
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
  | SessionCompletedEvent;

const EVENT_TYPES: ReadonlySet<GlimmerEvent["type"]> = new Set([
  "tool_started", "tool_completed", "tool_blocked", "file_changed",
  "verification_started", "verification_completed", "agent_state_changed",
  "candidate_selected", "scope_expanded", "repair_started",
  "parser_recovery", "session_completed",
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
