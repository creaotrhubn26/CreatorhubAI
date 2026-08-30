import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ComputeLastDiagnostic, ComputeWorkerStatus } from "@glimmer/shared";
import { CONFIG } from "../../config.js";
import { parseWorkerHealth } from "./workerClient.js";

const SAFE_LEASE_ID = /^[A-Za-z0-9-]{1,80}$/;
const SAFE_POD_ID = /^[A-Za-z0-9_-]{1,191}$/;
const SAFE_POD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const OUTCOMES = new Set<ComputeLastDiagnostic["outcome"]>([
  "bootstrapping",
  "ready",
  "failed",
  "terminated",
]);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored compute diagnostic must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[]): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error("stored compute diagnostic contains unsupported or missing fields");
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseStoredWorker(value: unknown): ComputeWorkerStatus {
  const raw = object(value);
  if (raw.protocolVersion !== 1 && raw.protocolVersion !== 2) {
    throw new Error("stored worker diagnostic protocol is invalid");
  }
  const { protocolVersion, ...health } = raw;
  return parseWorkerHealth({ ...health, schemaVersion: protocolVersion });
}

export function parseComputeDiagnostic(value: unknown): ComputeLastDiagnostic {
  const raw = object(value);
  exactKeys(
    raw,
    ["schemaVersion", "leaseId", "podId", "podName", "observedAt", "outcome"],
    ["worker"],
  );
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.leaseId !== "string" ||
    !SAFE_LEASE_ID.test(raw.leaseId) ||
    typeof raw.podId !== "string" ||
    !SAFE_POD_ID.test(raw.podId) ||
    typeof raw.podName !== "string" ||
    !SAFE_POD_NAME.test(raw.podName) ||
    !validTimestamp(raw.observedAt) ||
    !OUTCOMES.has(raw.outcome as ComputeLastDiagnostic["outcome"])
  ) {
    throw new Error("stored compute diagnostic is invalid");
  }
  return {
    schemaVersion: 1,
    leaseId: raw.leaseId,
    podId: raw.podId,
    podName: raw.podName,
    observedAt: raw.observedAt,
    outcome: raw.outcome as ComputeLastDiagnostic["outcome"],
    ...(raw.worker !== undefined ? { worker: parseStoredWorker(raw.worker) } : {}),
  };
}

async function writeAtomic(file: string, value: ComputeLastDiagnostic): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function readLastComputeDiagnostic(
  file = CONFIG.computeDiagnosticPath,
): Promise<ComputeLastDiagnostic | null> {
  try {
    const metadata = await fs.lstat(file);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_DIAGNOSTIC_BYTES ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error("stored compute diagnostic file is unsafe");
    }
    return parseComputeDiagnostic(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveLastComputeDiagnostic(
  diagnostic: ComputeLastDiagnostic,
  file = CONFIG.computeDiagnosticPath,
): Promise<ComputeLastDiagnostic> {
  const validated = parseComputeDiagnostic(diagnostic);
  await writeAtomic(file, validated);
  return validated;
}
