import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionsDir } from "../config.js";
import type {
  GlimmerSession, GlimmerSessionStatus, ChangedFile,
  VerificationSummary, VerificationCheckResult, VerificationOverall, TaskContract,
  ArchitecturePlan, ArchitectReview, DeliveryReview, GlimmerTask, HumanAcceptance,
} from "@glimmer/shared";

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

export function parseManifest(raw: unknown, sessionId: string): GlimmerSession {
  const m = raw as any;
  const attempts = m.attempts ?? [];
  const lastAttempt = attempts[attempts.length - 1];
  const checks: VerificationCheckResult[] = (lastAttempt?.verificationResults ?? []).map(toVerificationCheck);
  const verification: VerificationSummary = { overall: overallFromManifest(m), checks };
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
  };
  // C2/C3 (glimmer-v7): pass these through only when the manifest actually
  // carries them — older sessions predating architect mode have none of these
  // keys, and GlimmerSession leaves them optional for exactly that reason.
  if (m.gates) session.gates = m.gates;
  if (m.architectPlan) session.architectPlan = m.architectPlan;
  if (m.architectTrigger) session.architectTrigger = m.architectTrigger;
  if (m.failure) session.failure = m.failure;
  return session;
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

export async function readSession(id: string): Promise<GlimmerSession | null> {
  const real = resolveSessionId(id);
  const raw = await readManifestRaw(real);
  if (!raw) return null;
  let session = parseManifest(raw, real);
  const taskContract = await readGatewayContract(real);
  if (taskContract) session = { ...session, taskContract };
  const humanAcceptance = await readHumanAcceptance(real);
  if (humanAcceptance) session = { ...session, humanAcceptance };
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
