import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { sessionsDir } from "../config.js";
import { computeDiffHash } from "./git.js";
import { gatewayRunToSession, listGatewayRunIds, readGatewayRun } from "./runState.js";
import type {
  GlimmerSession,
  GlimmerSessionStatus,
  ChangedFile,
  VerificationSummary,
  VerificationCheckResult,
  VerificationOverall,
  TaskContract,
  ArchitecturePlan,
  ArchitectReview,
  DeliveryReview,
  ArchitectEscalation,
  DeliveryPacket,
  GlimmerTask,
  HumanAcceptance,
  FinalStatus,
  FinalGateStatus,
  VisualManifest,
  VisualFindings,
  DesignFeedbackDocument,
  DesignFeedbackUpdate,
  TaskOverride,
  EvidenceIndexEntry,
  EvidenceEntryResponse,
  ApprovalRequest,
  HunkAcceptance,
  TaskReport,
  ClarificationRequest,
  RepoIndexV1,
} from "@glimmer/shared";

// V7 §18: tier defaults to "required" for any manifest written before this
// task existed -- the only tier that ever existed then, and the one
// overallFromManifest/gating has always been computed from.

const TERMINAL_STATUSES = new Set<GlimmerSessionStatus>([
  "verified",
  "completed",
  "no_change",
  "failed",
  "blocked",
  "needs_review",
  "cancelled",
]);

// glimmer-v2.py's real manifest["status"] values: initialized, repo-map-only,
// no-change-verified, no-change-unverified, report completion, verified,
// blocked-<reason>,
// failed-verifier-mutated-repo, failed-repair-budget-exhausted, and (R6/C2)
// cancelled-sigterm, failed-aborted, needs-architect-review(-rejected|-budget-exhausted).
export function mapManifestStatus(raw: string): GlimmerSessionStatus {
  if (raw === "initialized") return "preflight";
  // Task 9.3a (V7 §46): glimmer-v2.py writes this raw string verbatim right
  // after readiness/before architect-first or the first engineer invocation
  // -- identity mapping, kept in sync with glimmer-v2.py's own
  // canonical_session_state.
  if (raw === "understanding") return "understanding";
  if (raw === "verified") return "verified";
  if (raw === "no-change-verified" || raw === "no-change-unverified") return "no_change";
  if (raw === "inspect-completed" || raw === "plan-completed" || raw === "review-completed")
    return "completed";
  // Task 8.3 (V7 §14/§35): glimmer-engineer.py patches this raw string
  // directly into manifest.json while it's blocked polling approvals.json
  // for a YELLOW-classified action, and reverts it as soon as the wait
  // resolves -- see glimmer-v2.py's canonical_session_state, kept in sync.
  if (raw === "waiting-for-approval") return "waiting_for_approval";
  if (raw === "waiting-for-clarification") return "waiting_for_clarification";
  // C2 (glimmer-v7): terminal status when the architect review gate rejects
  // the implementation or the review budget is exhausted — must never be
  // promoted to "verified". Prefix match: Task 1.3 splits the legacy
  // "needs-architect-review" string into "-rejected"/"-budget-exhausted"
  // variants (see glimmer-v2.py's classify_failure); both must hit this
  // explicit branch rather than fall through to the generic unknown-status
  // fallback below (same resulting value today, but only by coincidence).
  if (raw.startsWith("needs-")) return "needs_review";
  if (raw.startsWith("blocked-")) return "blocked";
  if (raw.startsWith("failed-")) return "failed";
  // repo-map-only is TERMINAL (glimmer-v2.py writes it and exits immediately,
  // no engineering work attempted) — must not map to an IN_FLIGHT_STATUSES
  // member or the session shows as the live "Active session" forever.
  if (raw === "repo-map-only") return "cancelled";
  // R6: SIGTERM/Ctrl-C writes "cancelled-sigterm" instead of leaving whatever
  // status was last saved before the interrupt.
  if (raw.startsWith("cancelled")) return "cancelled";
  // Any status this map doesn't recognize: never default to in-flight — an
  // unknown terminal status from a future orchestrator version would be
  // misreported as live. Surface it for a human to look at instead.
  return "needs_review";
}

function toChangedFiles(paths: string[] | undefined): ChangedFile[] {
  return (paths ?? []).map((p) => ({ path: p, status: "modified" as const }));
}

function toVerificationCheck(raw: any): VerificationCheckResult {
  return {
    command: raw.command,
    status: raw.status,
    ok: !!raw.ok,
    returncode: raw.returncode,
    elapsedSeconds: raw.elapsedSeconds ?? 0,
    outputTail: raw.outputTail ?? "",
    baselineAware: raw.baseline !== undefined || raw.baselineAccepted !== undefined,
    newErrorSignatures: raw.newErrorSignatures ?? [],
    tier: raw.tier === "recommended" ? "recommended" : "required",
  };
}

function overallFromManifest(manifest: any): VerificationOverall {
  const attempts = manifest.attempts ?? [];
  if (attempts.length === 0) return "NOT_RUN";
  const last = attempts[attempts.length - 1];
  const results: VerificationCheckResult[] = (last.verificationResults ?? []).map(
    toVerificationCheck,
  );
  if (results.length === 0) return "NOT_RUN";
  if (
    results.some(
      (r) =>
        !r.ok &&
        (r.status === "FAIL" ||
          r.status === "ERROR" ||
          (r.status === "CODE_FAIL" && r.newErrorSignatures.length > 0)),
    )
  )
    return "FAILED";
  if (results.every((r) => r.ok)) return manifest.status === "verified" ? "VERIFIED" : "PARTIAL";
  return "PARTIAL";
}

// V7 §22.17: gates.architectureApproved/documentationCurrent share this
// exact true/false/null -> approved/rejected/not_run mapping.
function gateToFinalStatus(value: boolean | null | undefined): FinalGateStatus {
  if (value === true) return "approved";
  if (value === false) return "rejected";
  return "not_run";
}

// V7 §22.17 finalStatus gate object -- the functional/architecture/
// documentation legs are all synchronously available from the manifest
// (no filesystem read needed), so they're computed here, at parse time.
// `visual` starts as "not_run" and is upgraded by readSession (below) after
// an async read of the session's visual/findings.json, which is the only
// leg that needs I/O.
function composeFinalStatus(
  overall: VerificationOverall,
  gates: GlimmerSession["gates"],
): FinalStatus {
  return {
    functional: overall,
    visual: "not_run",
    architecture: gateToFinalStatus(gates?.architectureApproved),
    documentation: gateToFinalStatus(gates?.documentationCurrent),
  };
}

export function parseManifest(raw: unknown, sessionId: string): GlimmerSession {
  const m = raw as any;
  const attempts = m.attempts ?? [];
  const lastAttempt = attempts[attempts.length - 1];
  const checks: VerificationCheckResult[] = (lastAttempt?.verificationResults ?? []).map(
    toVerificationCheck,
  );
  // V7 §18: recommended-tier results, kept off `checks` entirely -- never
  // consulted by overallFromManifest/gating, only reported. Omitted (not an
  // empty array) when the attempt genuinely never ran a recommended check.
  const recommendedRaw: any[] = lastAttempt?.recommendedResults ?? [];
  const recommendedChecks: VerificationCheckResult[] | undefined =
    recommendedRaw.length > 0 ? recommendedRaw.map(toVerificationCheck) : undefined;
  const verification: VerificationSummary = {
    overall: overallFromManifest(m),
    checks,
    ...(recommendedChecks ? { recommendedChecks } : {}),
  };
  const status = mapManifestStatus(String(m.status ?? ""));

  const session: GlimmerSession = {
    id: sessionId,
    task: m.task,
    status,
    workspace: m.workspace,
    branch: m.branch,
    baselineSha: m.baseline,
    headSha: m.finalHead ?? lastAttempt?.diffHashAfterVerify,
    startedAt: typeof m.startedAt === "string" ? m.startedAt : undefined,
    completedAt: TERMINAL_STATUSES.has(status) ? m.updatedAt : undefined,
    changedFiles: toChangedFiles(m.finalChangedFiles ?? lastAttempt?.changedFiles),
    verification,
    repairsUsed: Math.max(0, attempts.length - 1),
    repairBudget: m.maxRepairs ?? 0,
    // V7 §22.17: architecture/documentation legs need m.gates, which isn't
    // assigned onto `session` until just below -- read the raw manifest
    // field directly rather than reordering the gates assignment above this
    // literal. `visual` is finalized by readSession's async override.
    finalStatus: composeFinalStatus(verification.overall, m.gates),
  };
  if (m.contract) session.taskContract = m.contract as TaskContract;
  // C2/C3 (glimmer-v7): pass these through only when the manifest actually
  // carries them — older sessions predating architect mode have none of these
  // keys, and GlimmerSession leaves them optional for exactly that reason.
  if (m.gates) session.gates = m.gates;
  if (m.verificationPlan) session.verificationPlan = m.verificationPlan;
  if (m.architectPlan) session.architectPlan = m.architectPlan;
  if (m.architectTrigger) session.architectTrigger = m.architectTrigger;
  if (m.failure) session.failure = m.failure;
  // V7 §20: only stamped once a session reaches VERIFIED (both promotion
  // sites in glimmer-v2.py) -- absent everywhere else, same optional-pass-
  // through discipline as gates/architectPlan/failure above.
  if (m.verifiedAt) session.verifiedAt = m.verifiedAt;
  // V7 §20: written unconditionally by glimmer-v2.py's `finally` block on
  // every exit path, right after collapse() -- see the field's own comment
  // on GlimmerSession for what it actually captures and why.
  if (m.finalDiffHash) session.finalDiffHash = m.finalDiffHash;
  // Task 8.1 (V7 §23.11): manifest["statuses"], written once by glimmer-v2.py's
  // `finally` block -- same optional-pass-through discipline as gates/
  // architectPlan/failure above (absent on sessions predating this task).
  if (m.statuses) session.statuses = m.statuses;
  // Task 8.3 (V7 §14/§35): manifest.json's transient pendingApproval field
  // -- present only while glimmer-engineer.py is actually blocked waiting
  // on approvals.json (status is "waiting_for_approval" at the same
  // moment). Same optional-pass-through discipline as gates/architectPlan/
  // failure above.
  if (m.pendingApproval) session.pendingApproval = m.pendingApproval;
  return session;
}

// V7 §20 session-level verification freeze: staleness is a fact the gateway
// DETECTS, read-time, rather than something any daemon enforces -- nothing
// runs after glimmer-v2.py exits.
//
// Review round 1 fix: the original rule ("workspace has uncommitted changes
// now") was wrong -- collapse() (glimmer-v2.py, in the session's `finally`)
// resets HEAD back to baselineSha and DELIBERATELY leaves the produced diff
// sitting as uncommitted working-tree state (that's what View diff/accept
// read). So every successful-with-a-diff session is "dirty" at verifiedAt
// time by construction -- the old rule flagged the entire success path as
// stale immediately.
//
// The real rule: a session is stale iff its CURRENT diff against baselineSha
// no longer matches manifest.finalDiffHash (the fingerprint glimmer-v2.py
// took of that exact diff when the session collapsed) -- i.e. something
// wrote to the workspace after verification finished. Committing the
// accepted diff elsewhere does NOT change this hash (git diff against a
// fixed baseline sha compares content, not HEAD position), so an accepted-
// and-committed session correctly reads back as still-verified, not stale.
//
// Bounded timeout (STALE_CHECK_TIMEOUT_MS): this runs on a route a session
// screen polls every 4s -- a hung mount/filesystem must error out fast, not
// hang the request.
const STALE_CHECK_TIMEOUT_MS = 5_000;

async function currentDiffHash(workspace: string, baselineSha: string): Promise<string | null> {
  try {
    return await computeDiffHash(workspace, baselineSha, { timeoutMs: STALE_CHECK_TIMEOUT_MS });
  } catch {
    // Missing workspace, not a git repo, timed out, permissions, ... -- no
    // evidence either way. Never claim "stale" without proof (the human may
    // have legitimately committed and cleaned up the workspace after
    // accepting the result).
    return null;
  }
}

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

export function isValidSessionId(id: string): boolean {
  if (!SAFE_SESSION_ID.test(id)) return false;
  const resolved = path.resolve(sessionsDir(), id);
  const root = path.resolve(sessionsDir()) + path.sep;
  return resolved.startsWith(root);
}

export async function listSessionIds(): Promise<string[]> {
  let directoryIds: string[] = [];
  try {
    const entries = await fs.readdir(sessionsDir(), { withFileTypes: true });
    directoryIds = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
  const gatewayIds = await listGatewayRunIds();
  return [...new Set([...directoryIds, ...gatewayIds])].sort().reverse();
}

export async function readManifestRaw(id: string): Promise<unknown | null> {
  const real = resolveSessionId(id);
  if (!isValidSessionId(real)) return null; // reject path traversal as not-found, never resolve it
  try {
    const raw = await fs.readFile(path.join(sessionsDir(), real, "manifest.json"), "utf-8");
    return JSON.parse(raw);
  } catch (err: any) {
    // glimmer-v2.py rewrites manifest.json non-atomically, so a poll can read a
    // torn file and JSON.parse throws a SyntaxError with no .code. Any failure
    // here means "no readable manifest" — never let it escape into a route.
    if (err?.code !== "ENOENT") {
      console.warn(`[sessions] unreadable manifest for ${real}: ${err?.message ?? err}`);
    }
    return null;
  }
}

// --- opt-in orchestrator-artifact reads ------------------------------------
// architecture-plan.json / delivery-review.json / tasks.json are each a
// single JSON document, written at most once per session by glimmer-engineer/
// glimmer-v2 when architect mode is on. Absence is normal (most sessions
// never opt in), so ENOENT and malformed JSON both resolve to null — the same
// "no readable artifact" treatment readManifestRaw gives a torn manifest.json.
// Any OTHER read failure (permissions, EISDIR, ...) is a real gateway fault
// and is left to propagate so the calling route can 500 on it.
async function readSessionJsonFile<T>(id: string, filename: string): Promise<T | null> {
  const real = resolveSessionId(id);
  if (!isValidSessionId(real)) return null;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sessionsDir(), real, filename), "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function readTaskReport(id: string): Promise<TaskReport | null> {
  return readSessionJsonFile<TaskReport>(id, "task-report.json");
}

export function readRepoIndex(id: string): Promise<RepoIndexV1 | null> {
  return readSessionJsonFile<RepoIndexV1>(id, "repo-index.json");
}

export function readClarification(id: string): Promise<ClarificationRequest | null> {
  return readSessionJsonFile<ClarificationRequest>(id, "clarification.json");
}

export async function answerClarification(
  id: string,
  clarificationId: string,
  answer: { optionId?: string | null; text?: string | null },
): Promise<ClarificationRequest | null> {
  const real = resolveSessionId(id);
  if (!isValidSessionId(real)) throw new Error(`invalid session id: ${id}`);
  const request = await readClarification(real);
  if (!request || request.id !== clarificationId || request.sessionId !== real) return null;
  if (request.status !== "pending") return request;
  const optionId = typeof answer.optionId === "string" ? answer.optionId : null;
  const text = typeof answer.text === "string" ? answer.text.trim().slice(0, 2_000) : null;
  const validOption = optionId && request.options.some((option) => option.id === optionId);
  if (!validOption && !text) throw new Error("answer must select a listed option or include text");
  const answered: ClarificationRequest = {
    ...request,
    status: "answered",
    answer: {
      optionId: validOption ? optionId : null,
      text: text || null,
      answeredAt: new Date().toISOString(),
    },
  };
  const finalPath = path.join(sessionsDir(), real, "clarification.json");
  const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(answered), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, finalPath);
  return answered;
}

export function readArchitecturePlan(id: string): Promise<ArchitecturePlan | null> {
  return readSessionJsonFile<ArchitecturePlan>(id, "architecture-plan.json");
}

// Task 8.2 (V7 §23.15) -- architect-escalation.json, only ever written
// when glimmer-v2.py's deterministic escalation trigger fired for this
// session. Absence is normal (most sessions never trigger it); merged
// onto the DeliveryReview response below rather than served as its own
// route, since it's always read alongside the review it escalates.
function readArchitectEscalation(id: string): Promise<ArchitectEscalation | null> {
  return readSessionJsonFile<ArchitectEscalation>(id, "architect-escalation.json");
}

export async function readDeliveryReview(id: string): Promise<DeliveryReview | null> {
  const review = await readSessionJsonFile<DeliveryReview>(id, "delivery-review.json");
  if (!review) return null;
  const escalation = await readArchitectEscalation(id);
  return escalation ? { ...review, architectEscalation: escalation } : review;
}

// Task 8.2 (V7 §23.16) -- delivery-packet.json, assembled once by
// glimmer-v2.py at session close-out. Same opt-in-artifact-absence
// convention as the other session-dir reads here.
export function readDeliveryPacket(id: string): Promise<DeliveryPacket | null> {
  return readSessionJsonFile<DeliveryPacket>(id, "delivery-packet.json");
}

// Task 4.1 (V7 R4): glimmer-v2.py's save_tasks now writes a versioned
// wrapper -- {"schemaVersion": 2, "tasks": GlimmerTask[]} -- instead of a
// bare array, so a reader can tell a full-model (Round-4) task list apart
// from an older archived session's flat v1 array. Both shapes resolve to
// the same flat GlimmerTask[] the /sessions/:id/tasks route has always
// returned; a v1 array is returned as-is, a v2 wrapper is unwrapped, and
// anything else (malformed JSON already became null upstream; a valid but
// unrecognized shape) reads back as null, same "no readable artifact"
// convention every other opt-in read here follows.
export async function readSessionTasks(id: string): Promise<GlimmerTask[] | null> {
  const raw = await readSessionJsonFile<
    GlimmerTask[] | { schemaVersion: number; tasks: GlimmerTask[] }
  >(id, "tasks.json");
  if (raw === null) return null;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as { tasks: unknown }).tasks)) {
    return (raw as { tasks: GlimmerTask[] }).tasks;
  }
  return null;
}

// --- task overrides (Task 4.3: human skip/approve) -------------------------
// task-overrides.json is gateway-owned, exactly like human-acceptance.json:
// written ONLY by the /sessions/:id/tasks/:taskId/skip|approve routes below —
// glimmer-v2.py never writes it (it only READS it, to fold a skip into
// required_tasks_resolved — see glimmer-v2.py's load_task_overrides). Shape:
// {taskId: {action, at}}. This keeps "task resolved" (orchestrator-derived
// evidence) and "human decided to skip/approve" two genuinely separate
// facts, same discipline as the accepted/verified split for §14.
export function readTaskOverrides(id: string): Promise<Record<string, TaskOverride> | null> {
  return readSessionJsonFile<Record<string, TaskOverride>>(id, "task-overrides.json");
}

// Read-modify-write over the whole file (there is no per-task file, and
// sessions rarely have more than a handful of tasks) — a second call for the
// same taskId simply replaces its prior override; deliberately no undo/
// toggle, per the brief's "keep simple, one-shot buttons" instruction.
//
// Review round 1 (Important 3): taskFacts (kind/description, captured from
// the task as it exists RIGHT NOW, at the route that already read
// tasks.json to validate taskId) are stamped onto the record so a later
// reader can tell whether "this id" still means the same task -- ids are
// NOT stable across a replan. See TaskOverride's own comment and
// applyTaskOverrides below.
//
// Review round 1 (Moderate 6): write-to-temp-then-rename instead of a
// direct writeFile -- a crash/kill mid-write must never leave a torn/
// truncated task-overrides.json for readTaskOverrides to trip over (it
// would silently read back as {} via its JSON.parse-catch, quietly
// dropping every override recorded so far). rename() is atomic on the
// same filesystem, and the temp file lives in the same directory so it
// always is.
export async function writeTaskOverride(
  id: string,
  taskId: string,
  action: TaskOverride["action"],
  taskFacts: { kind: GlimmerTask["kind"]; description: string },
): Promise<TaskOverride> {
  const real = resolveSessionId(id);
  // Review round 1 (Minor 8b): this function is reachable directly (not
  // only through the route, which already validates the id via
  // readSessionTasks), and it WRITES to a path derived from `real` --
  // same guard every other id-derived filesystem write in this module
  // gets, not inherited implicitly from a caller.
  if (!isValidSessionId(real)) throw new Error(`invalid session id: ${id}`);
  const existing = (await readTaskOverrides(real)) ?? {};
  const record: TaskOverride = { action, at: new Date().toISOString(), ...taskFacts };
  const next = { ...existing, [taskId]: record };
  const finalPath = path.join(sessionsDir(), real, "task-overrides.json");
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(next), "utf-8");
  await fs.rename(tmpPath, finalPath);
  return record;
}

// --- approvals (Task 8.3, V7 §14/§35: YELLOW human-approval boundary) -----
// approvals.json is written by BOTH processes at different, non-
// overlapping times -- glimmer-engineer.py (request_approval_and_wait)
// creates the "pending" entry the moment a YELLOW action needs a human
// decision, THEN only polls (read-only) while it waits; the gateway routes
// below add the resolution (status/resolvedAt/approvedBy) once a human
// clicks Approve/Deny. Same read-modify-write-over-the-whole-file, write-
// to-temp-then-rename discipline as task-overrides.json above -- there is
// at most one pending approval per session in practice.
export function readApprovals(id: string): Promise<Record<string, ApprovalRequest> | null> {
  return readSessionJsonFile<Record<string, ApprovalRequest>>(id, "approvals.json");
}

// Idempotent by design: resolving an approvalId that's already resolved
// (a double-click, or a retried request) returns the EXISTING record
// unchanged rather than overwriting resolvedAt/approvedBy -- a second
// "approve" can't un-resolve a "denied" decision or reset its timestamp.
export async function resolveApproval(
  id: string,
  approvalId: string,
  action: "approve" | "deny",
  approvedBy: string,
): Promise<ApprovalRequest | null> {
  const real = resolveSessionId(id);
  if (!isValidSessionId(real)) throw new Error(`invalid session id: ${id}`);
  const existing = (await readApprovals(real)) ?? {};
  // Minor (8.3 review): plain `existing[approvalId]` walks the prototype
  // chain -- "__proto__"/"constructor"/"toString" would otherwise resolve
  // to an inherited Object.prototype member instead of 404ing like any
  // other unknown id.
  if (!Object.prototype.hasOwnProperty.call(existing, approvalId)) return null;
  const record = existing[approvalId];
  if (!record) return null; // no matching pending request -- 404 at the route
  if (record.status !== "pending") return record; // already resolved -- idempotent no-op
  const resolved: ApprovalRequest = {
    ...record,
    status: action === "approve" ? "approved" : "denied",
    resolvedAt: new Date().toISOString(),
    approvedBy,
  };
  const next = { ...existing, [approvalId]: resolved };
  const finalPath = path.join(sessionsDir(), real, "approvals.json");
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(next), "utf-8");
  await fs.rename(tmpPath, finalPath);
  return resolved;
}

// Review round 1 (Important 3): true when an override's captured
// kind/description (if any -- absent on a legacy pre-round-1 record)
// still match the task currently holding this id. A mismatch means the
// id was recycled (e.g. merge_replanned_tasks renumbering after a
// replan) for an unrelated task -- the override belongs to a task that
// no longer exists under this id.
function overrideMatchesTask(override: TaskOverride, task: GlimmerTask): boolean {
  if (override.kind === undefined && override.description === undefined) return true; // legacy record -- trust the id alone
  return override.kind === task.kind && override.description === task.description;
}

// Pure display transform consumed by GET /sessions/:id/tasks — never mutates
// tasks.json (which glimmer-v2.py alone owns), only the response shape.
// "skip" reads as an honest status="skipped"/priority="optional" (the human
// decided this task doesn't need to happen); "approve" reads as
// status="complete" (the human manually signed off the task's completion,
// chiefly for completion.type=="manual" tasks with no automatic evaluator).
// Either way the raw fact is preserved on `override` so the UI can badge it
// as a human decision rather than orchestrator-derived evidence.
export function applyTaskOverrides(
  tasks: GlimmerTask[],
  overrides: Record<string, TaskOverride> | null,
): GlimmerTask[] {
  if (!overrides) return tasks;
  return tasks.map((t) => {
    const override = overrides[t.id];
    if (!override) return t;
    // Review round 1 (Important 3): id reused by a replan -- ignore the
    // override (never misapply a stale human decision to the wrong
    // task), but keep the raw fact visible via staleOverride so a human
    // can tell why a Skip/Approve they remember seems to have vanished.
    if (!overrideMatchesTask(override, t)) return { ...t, staleOverride: override };
    if (override.action === "skip")
      return { ...t, status: "skipped", priority: "optional", override };
    if (override.action === "approve") return { ...t, status: "complete", override };
    return t; // Review round 1 (Moderate 5): unrecognized action -- fail OPEN to unchanged, never guess a display.
  });
}

// V7 §22.14 visual evidence store -- glimmer-visual.py's --output-dir is
// sessions/<id>/visual/, so these are nested one directory deeper than the
// single-file artifacts above. Same opt-in-artifact absence convention:
// no visual/ dir at all (the common case -- most sessions never run
// glimmer-visual.py) reads back as null, not an error.
export function readVisualManifest(id: string): Promise<VisualManifest | null> {
  return readSessionJsonFile<VisualManifest>(id, path.join("visual", "visual-manifest.json"));
}

export function readVisualFindings(id: string): Promise<VisualFindings | null> {
  return readSessionJsonFile<VisualFindings>(id, path.join("visual", "findings.json"));
}

// Human-authored visual feedback is gateway-owned and crash-safe. The
// orchestrator owns captures/findings; this sidecar owns annotations, element
// edits, variant/asset requests, and selected inspiration. A temp file +
// rename prevents a Force Quit from replacing the last valid document with
// torn JSON.
export function readDesignFeedback(id: string): Promise<DesignFeedbackDocument | null> {
  return readSessionJsonFile<DesignFeedbackDocument>(id, "design-feedback.json");
}

export async function writeDesignFeedback(
  id: string,
  update: DesignFeedbackUpdate,
): Promise<DesignFeedbackDocument> {
  const real = resolveSessionId(id);
  if (!isValidSessionId(real)) throw new Error(`invalid session id: ${id}`);
  const document: DesignFeedbackDocument = {
    version: 1,
    sessionId: real,
    updatedAt: new Date().toISOString(),
    ...update,
  };
  const finalPath = path.join(sessionsDir(), real, "design-feedback.json");
  const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  const handle = await fs.open(temporaryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, finalPath);
  return document;
}

const KNOWN_VISUAL_FINDINGS_STATUSES = new Set([
  "NOT_RUN",
  "PASS",
  "FAIL",
  "BLOCKED",
  "PASS_WITH_WARNINGS",
]);

const ARCHITECT_REVIEW_FILE_RE = /^architect-review-\d+-\d+\.json$/;

// architect-review-NN-MM.json is a collection (one file per review round), so
// this follows readSessionEventsBatch's convention instead: a malformed
// individual file is skipped rather than failing the whole request. Zero
// matching files (dir absent, or present but no reviews written) is still
// "no artifact" -> null, consistent with the single-file reads above.
export async function readArchitectReviews(id: string): Promise<ArchitectReview[] | null> {
  const real = resolveSessionId(id);
  if (!isValidSessionId(real)) return null;
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(sessionsDir(), real));
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const files = entries.filter((f) => ARCHITECT_REVIEW_FILE_RE.test(f)).sort();
  const reviews: ArchitectReview[] = [];
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(sessionsDir(), real, file), "utf-8");
      reviews.push(JSON.parse(raw) as ArchitectReview);
    } catch {
      // Torn/malformed individual review file — skip it, not a request error.
    }
  }
  return reviews.length > 0 ? reviews : null;
}

// Task 5.2 (V7 §26/§46): evidence-index.json -- a single JSON array
// glimmer-engineer.py appends to incrementally, one entry per persisted
// evidence id (same read_candidate_evidence-lite treatment as
// architecture-plan.json/delivery-review.json: absence is normal, a
// malformed file resolves to null via readSessionJsonFile). Never
// iteration-numbered (unlike evidence-NN.jsonl) since it's shared across
// the whole session.
export async function readEvidenceIndex(id: string): Promise<EvidenceIndexEntry[] | null> {
  const raw = await readSessionJsonFile<unknown>(id, "evidence-index.json");
  // Fix round 1 (NIT): readSessionJsonFile only proves valid JSON, not
  // that it's the array shape this file is always written as -- a
  // corrupt/partial write (e.g. truncated mid-`os.replace`) could parse
  // to a non-array value that would otherwise reach a caller expecting
  // .length/.map to exist.
  return Array.isArray(raw) ? (raw as EvidenceIndexEntry[]) : null;
}

// Response body is capped well under evidence-NN.jsonl's own persist-time
// cap (MAX_EVIDENCE_RESULT, 7000 chars in glimmer-engineer.py) -- this is
// a second, independent cap on what the gateway ever sends a browser for
// one entry, same "cap again at the boundary that actually serves it"
// discipline as ARCHITECT_REVIEW_DIFF_MAX_CHARS elsewhere in this file.
// Applied to both `content` and (Fix round 1, MED) `arguments`.
const EVIDENCE_ENTRY_FIELD_MAX_CHARS = 4000;

const EVIDENCE_FILE_RE = /^evidence-\d+\.jsonl$/;

// Fix round 1 (MED): write_file/edit_file arguments carry the ENTIRE
// written/edited file content (glimmer-engineer.py's own new_content/
// old_string fields) -- serving that verbatim through this endpoint would
// leak full file bodies where only "what tool ran, on what path" is
// meant to be visible. Same redaction shape run_engineer's own
// display_args/tool_started event already applies to WRITE_TOOLS.
const EVIDENCE_WRITE_TOOL_NAMES = new Set(["write_file", "edit_file"]);

function cappedEvidenceArguments(tool: string | undefined, args: unknown): unknown {
  if (
    tool &&
    EVIDENCE_WRITE_TOOL_NAMES.has(tool) &&
    args &&
    typeof args === "object" &&
    !Array.isArray(args)
  ) {
    const obj = args as Record<string, unknown>;
    return { path: obj.path, keys: Object.keys(obj) };
  }
  if (args === undefined) return args;
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    return args; // not JSON-serializable (shouldn't happen for parsed JSON) -- pass through as-is
  }
  return json.length > EVIDENCE_ENTRY_FIELD_MAX_CHARS
    ? json.slice(0, EVIDENCE_ENTRY_FIELD_MAX_CHARS) + "...(truncated)"
    : args;
}

// One persisted evidence-NN.jsonl line by id (Task 5.1's get_evidence
// tool reads this same family of files client-side; this is the
// gateway's read-only equivalent for the Control Center panel). Scans
// every evidence-*.jsonl file in the session dir, same collection
// convention as readArchitectReviews above (a torn/malformed line is
// skipped, not a request error) -- returns the FIRST match by id (ids
// are unique within a session by construction, see
// glimmer-engineer.py's _persist_evidence). null when the session dir
// is missing, no evidence file matches, or no line carries this id.
export async function readEvidenceEntry(
  id: string,
  evidenceId: string,
): Promise<EvidenceEntryResponse | null> {
  const real = resolveSessionId(id);
  if (!isValidSessionId(real)) return null;
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(sessionsDir(), real));
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const files = entries.filter((f) => EVIDENCE_FILE_RE.test(f)).sort();
  for (const file of files) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(sessionsDir(), real, file), "utf-8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // torn/partial line -- same tolerant treatment as readSessionEventsBatch
      }
      // Only _persist_evidence's own entries carry a top-level "id" --
      // tool_envelope entries (kind: "tool_envelope") do not, so this can
      // never resolve to the wrong record shape.
      if (record?.id !== evidenceId) continue;
      const tool = typeof record.tool === "string" ? record.tool : undefined;
      const content = typeof record.content === "string" ? record.content : undefined;
      return {
        id: evidenceId,
        tool,
        arguments: cappedEvidenceArguments(tool, record.arguments),
        content:
          content !== undefined && content.length > EVIDENCE_ENTRY_FIELD_MAX_CHARS
            ? content.slice(0, EVIDENCE_ENTRY_FIELD_MAX_CHARS) + "\n\n[truncated]"
            : content,
      };
    }
  }
  return null;
}

export async function writeGatewayContract(dir: string, contract: TaskContract): Promise<void> {
  await fs.writeFile(path.join(dir, "gateway-contract.json"), JSON.stringify(contract), "utf-8");
}

export async function readGatewayContract(id: string): Promise<TaskContract | null> {
  const real = resolveSessionId(id);
  try {
    const raw = await fs.readFile(path.join(sessionsDir(), real, "gateway-contract.json"), "utf-8");
    return JSON.parse(raw) as TaskContract;
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.warn(`[sessions] unreadable gateway-contract for ${real}: ${err?.message ?? err}`);
    }
    return null;
  }
}

// --- human acceptance (§14 Diff Review) ------------------------------------
// human-acceptance.json is gateway-owned, same as gateway-contract.json:
// written ONLY here, from the /sessions/:id/accept route — glimmer-v2.py /
// glimmer-engineer.py never read or write this file. That's what keeps
// "VERIFIED" (technical, orchestrator-derived) and "accepted" (human
// judgment) two genuinely separate facts instead of one the model could
// flip on itself.
export function readHumanAcceptance(id: string): Promise<HumanAcceptance | null> {
  return readSessionJsonFile<HumanAcceptance>(id, "human-acceptance.json");
}

// Idempotent: re-accepting an already-accepted session is a no-op that
// returns the original record untouched, rather than bumping acceptedAt —
// "accepted twice" should still mean one acceptance event, not two.
export async function writeHumanAcceptance(id: string): Promise<HumanAcceptance> {
  const real = resolveSessionId(id);
  const existing = await readHumanAcceptance(real);
  if (existing?.accepted) return existing;
  const record: HumanAcceptance = { accepted: true, acceptedAt: new Date().toISOString() };
  await fs.writeFile(
    path.join(sessionsDir(), real, "human-acceptance.json"),
    JSON.stringify(record),
    "utf-8",
  );
  return record;
}

// Any content mutation after the human's click invalidates that judgment.
// Removing the gateway-owned sidecar makes readSession report the honest
// state again without changing the orchestrator's independent verification.
export async function clearHumanAcceptance(id: string): Promise<void> {
  const real = resolveSessionId(id);
  if (!isValidSessionId(real)) throw new Error(`invalid session id: ${id}`);
  await fs.rm(path.join(sessionsDir(), real, "human-acceptance.json"), { force: true });
}

// --- per-hunk acceptance (C2 Diff Review) ---------------------------------
// Only accepted hunks need persistence: rejecting a hunk removes it from the
// working-tree diff. IDs come from the canonical server-side git diff, so an
// edit to that hunk naturally makes an older acceptance irrelevant.
interface HunkAcceptanceFile {
  version: 1;
  acceptances: Record<string, HunkAcceptance>;
}

const HUNK_ID_RE = /^[a-f0-9]{64}$/;

export async function readHunkAcceptances(id: string): Promise<Record<string, HunkAcceptance>> {
  const raw = await readSessionJsonFile<Partial<HunkAcceptanceFile>>(id, "hunk-acceptances.json");
  if (!raw || raw.version !== 1 || !raw.acceptances || typeof raw.acceptances !== "object")
    return {};
  const valid: Record<string, HunkAcceptance> = {};
  for (const [hunkId, record] of Object.entries(raw.acceptances)) {
    if (
      HUNK_ID_RE.test(hunkId) &&
      record &&
      record.hunkId === hunkId &&
      typeof record.path === "string" &&
      typeof record.acceptedAt === "string"
    )
      valid[hunkId] = record;
  }
  return valid;
}

async function writeHunkAcceptances(
  id: string,
  acceptances: Record<string, HunkAcceptance>,
): Promise<void> {
  const real = resolveSessionId(id);
  if (!isValidSessionId(real)) throw new Error(`invalid session id: ${id}`);
  const finalPath = path.join(sessionsDir(), real, "hunk-acceptances.json");
  const tempPath = `${finalPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify({ version: 1, acceptances }), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, finalPath);
}

export async function writeHunkAcceptance(
  id: string,
  hunkId: string,
  filePath: string,
): Promise<HunkAcceptance> {
  if (!HUNK_ID_RE.test(hunkId) || !filePath) throw new Error("invalid hunk acceptance");
  const existing = await readHunkAcceptances(id);
  const prior = existing[hunkId];
  if (prior?.path === filePath) return prior;
  const record: HunkAcceptance = { hunkId, path: filePath, acceptedAt: new Date().toISOString() };
  await writeHunkAcceptances(id, { ...existing, [hunkId]: record });
  return record;
}

export async function clearHunkAcceptance(id: string, hunkId: string): Promise<void> {
  const existing = await readHunkAcceptances(id);
  if (!Object.prototype.hasOwnProperty.call(existing, hunkId)) return;
  const next = { ...existing };
  delete next[hunkId];
  await writeHunkAcceptances(id, next);
}

export async function clearHunkAcceptancesForPath(id: string, filePath: string): Promise<void> {
  const existing = await readHunkAcceptances(id);
  const next = Object.fromEntries(
    Object.entries(existing).filter(([, record]) => record.path !== filePath),
  );
  if (Object.keys(next).length === Object.keys(existing).length) return;
  await writeHunkAcceptances(id, next);
}

// computeStale defaults to false: staleness detection spawns git (see
// currentDiffHash above), and this function backs BOTH the session-list
// endpoint (polled every few seconds by the sidebar) and the single-session
// endpoint. Running a git spawn per session on every list poll would fork-
// bomb the server (N sessions x one poll every 4s) for a fact only the one
// open session screen actually needs -- so only GET /sessions/:id opts in.
// GET /sessions (the list) deliberately leaves this false; sessions there
// just read back as "verified" until someone opens them.
export async function readSession(
  id: string,
  opts: { computeStale?: boolean } = {},
): Promise<GlimmerSession | null> {
  const real = resolveSessionId(id);
  const raw = await readManifestRaw(real);
  if (!raw) {
    const gatewayRun = await readGatewayRun(real);
    return gatewayRun ? gatewayRunToSession(gatewayRun) : null;
  }
  let session = parseManifest(raw, real);
  const taskContract = await readGatewayContract(real);
  if (!session.taskContract && taskContract) session = { ...session, taskContract };
  const gatewayRun = await readGatewayRun(real);
  // The gateway-owned interruption record is newer than an in-flight
  // manifest left behind by a killed orchestrator. Merge it instead of
  // returning the stale pre-crash status with no recovery controls.
  if (gatewayRun?.state === "interrupted" && gatewayRun.recovery) {
    session = {
      ...session,
      status: "needs_review",
      completedAt: gatewayRun.completedAt ?? session.completedAt,
      changedFiles: gatewayRun.recovery.changedFiles,
      recovery: gatewayRun.recovery,
      verification: { ...session.verification, overall: "NEEDS_REVIEW" },
      finalStatus: { ...session.finalStatus, functional: "NEEDS_REVIEW" },
    };
  }
  const humanAcceptance = await readHumanAcceptance(real);
  if (humanAcceptance) session = { ...session, humanAcceptance };
  // V7 §22.17: the one finalStatus leg that needs I/O -- composeFinalStatus
  // (above) already set every other leg synchronously. No visual/ dir at
  // all (the common case) leaves it "not_run", set by composeFinalStatus.
  const visualFindings = await readVisualFindings(real);
  // NIT (fix round 3): findings.json is read straight off disk with no
  // runtime schema check -- an unrecognized status value degrades to the
  // same honest "not_run" fallback composeFinalStatus already uses, rather
  // than passing an untrusted/malformed string straight into finalStatus.
  if (visualFindings && KNOWN_VISUAL_FINDINGS_STATUSES.has(visualFindings.status)) {
    session = {
      ...session,
      finalStatus: { ...session.finalStatus, visual: visualFindings.status },
    };
  }
  // Missing finalDiffHash (manifest predates this task) -> never stale, same
  // honesty rule as currentDiffHash returning null: no fingerprint to
  // compare against, no claim.
  if (opts.computeStale && session.status === "verified" && session.finalDiffHash) {
    const current = await currentDiffHash(session.workspace, session.baselineSha);
    if (current !== null && current !== session.finalDiffHash) {
      // V7 §22.17: keep the finalStatus gate object in agreement with §20
      // staleness -- a stale session's workspace no longer matches what was
      // verified, so the gate object's `functional` leg (composeFinalStatus
      // set it to the manifest's VERIFIED overall) must not still claim
      // VERIFIED alongside status: "stale".
      session = {
        ...session,
        status: "stale",
        finalStatus: { ...session.finalStatus, functional: "NEEDS_REVIEW" },
      };
    }
  }
  return session;
}

export function resolveSessionId(id: string): string {
  return id;
}
