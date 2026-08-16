
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
