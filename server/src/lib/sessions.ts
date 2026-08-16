import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionsDir } from "../config.js";
import type {
  GlimmerSession, GlimmerSessionStatus, ChangedFile,
  VerificationSummary, VerificationCheckResult, VerificationOverall, TaskContract,
} from "@glimmer/shared";

const TERMINAL_STATUSES = new Set<GlimmerSessionStatus>([
  "verified", "failed", "blocked", "needs_review", "cancelled",
]);

// glimmer-v2.py's real manifest["status"] values: initialized, repo-map-only,
// no-change-verified, no-change-unverified, verified, blocked-<reason>,
// failed-verifier-mutated-repo, failed-repair-budget-exhausted.
export function mapManifestStatus(raw: string): GlimmerSessionStatus {
  if (raw === "initialized") return "preflight";
  if (raw === "verified" || raw === "no-change-verified") return "verified";
  if (raw === "no-change-unverified") return "needs_review";
  if (raw.startsWith("blocked-")) return "blocked";
  if (raw.startsWith("failed-")) return "failed";
  // repo-map-only is TERMINAL (glimmer-v2.py writes it and exits immediately,
  // no engineering work attempted) — must not map to an IN_FLIGHT_STATUSES
  // member or the session shows as the live "Active session" forever.
  if (raw === "repo-map-only") return "cancelled";
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

  return {
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
  const session = parseManifest(raw, real);
  const taskContract = await readGatewayContract(real);
  return taskContract ? { ...session, taskContract } : session;
}

// --- pending-id -> real-session-id aliasing -------------------------------
// The gateway creates `pending-<uuid>` and hands it to the client, but
// glimmer-v2.py creates its OWN `<timestamp>-<branch>` session directory and
// writes manifest.json there. Without an alias the client's id never resolves.
const sessionAliases = new Map<string, string>();

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
    // 0 candidates: nothing new yet that isn't already claimed by another
    // pending adoption — keep polling.
    // >1 candidates: genuinely ambiguous this tick (e.g. two orchestrators
    // started around the same time) — don't guess which is ours. Bail
    // without aliasing; the next tick re-evaluates once the other adoption
    // claims its directory.
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}
