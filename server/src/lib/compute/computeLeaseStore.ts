import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ComputeRunState } from "@glimmer/shared";
import { CONFIG } from "../../config.js";

export interface ComputeLeaseV1 {
  version: 1;
  id: string;
  profileId: string;
  podName: string;
  podId?: string;
  state: ComputeRunState;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  idleDeadlineAt: string;
  hardDeadlineAt: string;
  observedHourlyUsd?: number;
  workerProtocolVersion?: 1;
  workerBuildId?: string;
  workerReadyAt?: string;
  providerTerminationConfirmedAt?: string;
  error?: string;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isLease(value: unknown): value is ComputeLeaseV1 {
  if (!value || typeof value !== "object") return false;
  const raw = value as Partial<ComputeLeaseV1>;
  return (
    raw.version === 1 &&
    typeof raw.id === "string" &&
    /^[A-Za-z0-9-]{1,80}$/.test(raw.id) &&
    typeof raw.profileId === "string" &&
    typeof raw.podName === "string" &&
    (!raw.podId || /^[A-Za-z0-9_-]{1,191}$/.test(raw.podId)) &&
    typeof raw.state === "string" &&
    validTimestamp(raw.createdAt) &&
    validTimestamp(raw.updatedAt) &&
    validTimestamp(raw.lastActivityAt) &&
    validTimestamp(raw.idleDeadlineAt) &&
    validTimestamp(raw.hardDeadlineAt) &&
    (raw.observedHourlyUsd === undefined ||
      (typeof raw.observedHourlyUsd === "number" &&
        Number.isFinite(raw.observedHourlyUsd) &&
        raw.observedHourlyUsd >= 0)) &&
    (raw.workerProtocolVersion === undefined || raw.workerProtocolVersion === 1) &&
    (raw.workerBuildId === undefined ||
      (typeof raw.workerBuildId === "string" &&
        raw.workerBuildId.length >= 1 &&
        raw.workerBuildId.length <= 128)) &&
    (raw.workerReadyAt === undefined || validTimestamp(raw.workerReadyAt)) &&
    (raw.providerTerminationConfirmedAt === undefined ||
      validTimestamp(raw.providerTerminationConfirmedAt)) &&
    (raw.error === undefined || typeof raw.error === "string")
  );
}

async function writeAtomic(lease: ComputeLeaseV1): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG.computeStatePath), { recursive: true, mode: 0o700 });
  const temporary = `${CONFIG.computeStatePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(lease, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporary, CONFIG.computeStatePath);
  await fs.chmod(CONFIG.computeStatePath, 0o600);
}

export async function readComputeLease(): Promise<ComputeLeaseV1 | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(CONFIG.computeStatePath, "utf8"));
    if (!isLease(parsed)) throw new Error("stored compute lease is invalid");
    return parsed;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveComputeLease(lease: ComputeLeaseV1): Promise<ComputeLeaseV1> {
  const updated = { ...lease, updatedAt: new Date().toISOString() };
  await writeAtomic(updated);
  return updated;
}

export async function updateComputeLease(
  mutate: (lease: ComputeLeaseV1) => ComputeLeaseV1,
): Promise<ComputeLeaseV1 | null> {
  const current = await readComputeLease();
  if (!current) return null;
  return saveComputeLease(mutate(current));
}

export async function clearComputeLease(expectedId: string): Promise<boolean> {
  const current = await readComputeLease();
  if (!current || current.id !== expectedId) return false;
  await fs.unlink(CONFIG.computeStatePath).catch((error: any) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return true;
}
