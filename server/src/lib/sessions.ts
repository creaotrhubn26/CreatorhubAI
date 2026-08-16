import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionsDir } from "../config";
import type {
  GlimmerSession, GlimmerSessionStatus, ChangedFile,
  VerificationSummary, VerificationCheckResult, VerificationOverall,
} from "@glimmer/shared";

const MANIFEST_TO_SESSION_STATUS: Record<string, GlimmerSessionStatus> = {
  initialized: "preflight",
  "repo-map-only": "preflight",
  verified: "verified",
  failed: "failed",
  "needs-review": "needs_review",
  cancelled: "cancelled",
};

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
  if (results.some((r) => !r.ok && r.status === "CODE_FAIL" && r.newErrorSignatures.length > 0)) return "FAILED";
  if (results.every((r) => r.ok)) return manifest.status === "verified" ? "VERIFIED" : "PARTIAL";
  return "PARTIAL";
}

export function parseManifest(raw: unknown, sessionId: string): GlimmerSession {
  const m = raw as any;
  const attempts = m.attempts ?? [];
  const lastAttempt = attempts[attempts.length - 1];
  const checks: VerificationCheckResult[] = (lastAttempt?.verificationResults ?? []).map(toVerificationCheck);
  const verification: VerificationSummary = { overall: overallFromManifest(m), checks };

  return {
    id: sessionId,
    task: m.task,
    status: MANIFEST_TO_SESSION_STATUS[m.status as string] ?? "preflight",
    workspace: m.workspace,
    branch: m.branch,
    baselineSha: m.baseline,
    headSha: m.finalHead ?? lastAttempt?.diffHashAfterVerify,
    startedAt: undefined,
    completedAt: m.status === "verified" || m.status === "failed" ? m.updatedAt : undefined,
    changedFiles: toChangedFiles(m.finalChangedFiles ?? lastAttempt?.changedFiles),
    verification,
    repairsUsed: Math.max(0, attempts.length - 1),
    repairBudget: m.maxRepairs ?? 0,
  };
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
  try {
    const raw = await fs.readFile(path.join(sessionsDir(), id, "manifest.json"), "utf-8");
    return JSON.parse(raw);
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function readSession(id: string): Promise<GlimmerSession | null> {
  const raw = await readManifestRaw(id);
  if (!raw) return null;
  return parseManifest(raw, id);
}
