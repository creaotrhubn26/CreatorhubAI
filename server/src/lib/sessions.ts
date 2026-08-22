import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionsDir } from "../config.js";
import { computeDiffHash } from "./git.js";
import type {
  GlimmerSession, GlimmerSessionStatus, ChangedFile,
  VerificationSummary, VerificationCheckResult, VerificationOverall, TaskContract,
  ArchitecturePlan, ArchitectReview, DeliveryReview, GlimmerTask, HumanAcceptance,
  FinalStatus, FinalGateStatus, VisualManifest, VisualFindings,
} from "@glimmer/shared";

// V7 §18: tier defaults to "required" for any manifest written before this
// task existed -- the only tier that ever existed then, and the one
// overallFromManifest/gating has always been computed from.

const TERMINAL_STATUSES = new Set<GlimmerSessionStatus>([
  "verified", "failed", "blocked", "needs_review", "cancelled",
]);

// glimmer-v2.py's real manifest["status"] values: initialized, repo-map-only,
// no-change-verified, no-change-unverified, verified, blocked-<reason>,
// failed-verifier-mutated-repo, failed-repair-budget-exhausted, and (R6/C2)
// cancelled-sigterm, failed-aborted, needs-architect-review(-rejected|-budget-exhausted).
export function mapManifestStatus(raw: string): GlimmerSessionStatus {
  if (raw === "initialized") return "preflight";
  if (raw === "verified" || raw === "no-change-verified") return "verified";
  if (raw === "no-change-unverified") return "needs_review";
  // C2 (glimmer-v7): terminal status when the architect review gate rejects
  // the implementation or the review budget is exhausted — must never be
  // promoted to "verified". Prefix match: Task 1.3 splits the legacy
  // "needs-architect-review" string into "-rejected"/"-budget-exhausted"
  // variants (see glimmer-v2.py's classify_failure); both must hit this
  // explicit branch rather than fall through to the generic unknown-status
  // fallback below (same resulting value today, but only by coincidence).
  if (raw.startsWith("needs-architect-review")) return "needs_review";
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
  const results: VerificationCheckResult[] = (last.verificationResults ?? []).map(toVerificationCheck);
  if (results.length === 0) return "NOT_RUN";
  if (results.some((r) => !r.ok && (r.status === "FAIL" || r.status === "ERROR" || (r.status === "CODE_FAIL" && r.newErrorSignatures.length > 0)))) return "FAILED";
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
function composeFinalStatus(overall: VerificationOverall, gates: GlimmerSession["gates"]): FinalStatus {
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
  const checks: VerificationCheckResult[] = (lastAttempt?.verificationResults ?? []).map(toVerificationCheck);
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
    startedAt: undefined,
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
  try {
    const entries = await fs.readdir(sessionsDir(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
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

export function readArchitecturePlan(id: string): Promise<ArchitecturePlan | null> {
  return readSessionJsonFile<ArchitecturePlan>(id, "architecture-plan.json");
}

export function readDeliveryReview(id: string): Promise<DeliveryReview | null> {
  return readSessionJsonFile<DeliveryReview>(id, "delivery-review.json");
}

export function readSessionTasks(id: string): Promise<GlimmerTask[] | null> {
  return readSessionJsonFile<GlimmerTask[]>(id, "tasks.json");
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
  await fs.writeFile(path.join(sessionsDir(), real, "human-acceptance.json"), JSON.stringify(record), "utf-8");
  return record;
}

async function copyGatewayContract(fromId: string, toId: string): Promise<void> {
  try {
    const raw = await fs.readFile(path.join(sessionsDir(), fromId, "gateway-contract.json"), "utf-8");
    await fs.writeFile(path.join(sessionsDir(), toId, "gateway-contract.json"), raw, "utf-8");
  } catch {
    // No contract to carry over — e.g. glimmer-v2.py was run standalone from a
    // terminal, not through this gateway. Not an error.
  }
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
  opts: { computeStale?: boolean } = {}
): Promise<GlimmerSession | null> {
  const real = resolveSessionId(id);
  const raw = await readManifestRaw(real);
  if (!raw) return null;
  let session = parseManifest(raw, real);
  const taskContract = await readGatewayContract(real);
  if (taskContract) session = { ...session, taskContract };
  const humanAcceptance = await readHumanAcceptance(real);
  if (humanAcceptance) session = { ...session, humanAcceptance };
  // V7 §22.17: the one finalStatus leg that needs I/O -- composeFinalStatus
  // (above) already set every other leg synchronously. No visual/ dir at
  // all (the common case) leaves it "not_run", set by composeFinalStatus.
  const visualFindings = await readVisualFindings(real);
  if (visualFindings) {
    session = { ...session, finalStatus: { ...session.finalStatus, visual: visualFindings.status } };
  }
  // Missing finalDiffHash (manifest predates this task) -> never stale, same
  // honesty rule as currentDiffHash returning null: no fingerprint to
  // compare against, no claim.
  if (opts.computeStale && session.status === "verified" && session.finalDiffHash) {
    const current = await currentDiffHash(session.workspace, session.baselineSha);
    if (current !== null && current !== session.finalDiffHash) {
      session = { ...session, status: "stale" };
    }
  }
  return session;
}

// --- pending-id -> real-session-id aliasing -------------------------------
// The gateway creates `pending-<uuid>` and hands it to the client, but
// glimmer-v2.py creates its OWN `<timestamp>-<branch>` session directory and
// writes manifest.json there. Without an alias the client's id never resolves.
const sessionAliases = new Map<string, string>();

// FIFO of pendingIds currently waiting on adoption, in the order /run spawned
// them. Used only to break ties when multiple real directories show up
// unclaimed at once (see adoptRealSessionDir below).
const pendingSpawnQueue: string[] = [];

export function resolveSessionId(id: string): string {
  return sessionAliases.get(id) ?? id;
}

/**
 * Poll sessionsDir() for a directory that did not exist at spawn time and
 * alias `pendingId` to it. Resolves to the real id, or null on timeout (which
 * honestly means glimmer-v2.py never got as far as creating its session dir).
 */
export async function adoptRealSessionDir(
  pendingId: string,
  before: Set<string>,
  timeoutMs = 10_000,
  intervalMs = 250
): Promise<string | null> {
  if (!pendingSpawnQueue.includes(pendingId)) pendingSpawnQueue.push(pendingId);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ids = await listSessionIds();
      // Computed AFTER the await, synchronously with the filter below: JS
      // callbacks run to completion, so this whole block is atomic relative to
      // any other concurrent adoptRealSessionDir call's own claim-and-set —
      // a claim made while we were awaiting listSessionIds() is visible here.
      const claimed = new Set(sessionAliases.values());
      const candidates = ids.filter(
        (id) => !before.has(id) && !id.startsWith("pending-") && !claimed.has(id)
      );
      if (candidates.length === 1) {
        sessionAliases.set(pendingId, candidates[0]);
        await copyGatewayContract(pendingId, candidates[0]);
        return candidates[0];
      }
      if (candidates.length > 1) {
        // F2: two (or more) sessions started back-to-back can both create
        // their real directory before either poll loop runs, so neither side
        // ever sees exactly one candidate and both pending ids would spin
        // forever. Break the tie by spawn order: if the number of unclaimed
        // candidates matches the number of pending ids still waiting, pair
        // the earliest-created directory with the earliest-spawned pending id
        // (and so on). This is a heuristic, not a true fix — it relies on
        // orchestrator startup order roughly matching directory-creation
        // order. A deterministic fix needs glimmer-v2.py to hand back an
        // explicit session tag (future work, out of scope here).
        // Note: pendingSpawnQueue is global across ALL in-flight adoptions,
        // not scoped to the ones actually racing — a 3rd, unrelated pending
        // id still polling delays this pairing (via the count check below)
        // until it resolves or times out and is spliced out. Self-heals,
        // does not deadlock, but is unbounded-latency by design.
        const waiting = pendingSpawnQueue.filter((id) => !sessionAliases.has(id));
        if (candidates.length === waiting.length) {
          const stamped = await Promise.all(
            candidates.map(async (id) => ({
              id,
              birth: (await fs.stat(path.join(sessionsDir(), id))).birthtime.getTime(),
            }))
          );
          stamped.sort((a, b) => a.birth - b.birth);
          // Re-check: nothing may be claimed and the queue may not have
          // changed while we were stat()-ing (no other await point between
          // here and the alias write below, so this recheck is authoritative).
          const stillClaimed = new Set(sessionAliases.values());
          const stillCandidates = stamped.filter((c) => !stillClaimed.has(c.id));
          const stillWaiting = pendingSpawnQueue.filter((id) => !sessionAliases.has(id));
          if (stillCandidates.length === stillWaiting.length) {
            const myIndex = stillWaiting.indexOf(pendingId);
            const match = myIndex === -1 ? undefined : stillCandidates[myIndex]?.id;
            if (match && !stillClaimed.has(match)) {
              sessionAliases.set(pendingId, match);
              await copyGatewayContract(pendingId, match);
              return match;
            }
          }
        }
      }
      // 0 candidates: nothing new yet that isn't already claimed by another
      // pending adoption — keep polling.
      // count mismatch: genuinely ambiguous this tick — don't guess which is
      // ours. Bail without aliasing; the next tick re-evaluates once counts
      // line up (another adoption claims its directory, or another candidate
      // appears).
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  } finally {
    const idx = pendingSpawnQueue.indexOf(pendingId);
    if (idx !== -1) pendingSpawnQueue.splice(idx, 1);
  }
}
