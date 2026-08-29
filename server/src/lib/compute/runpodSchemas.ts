export type RunPodDesiredStatus = "RUNNING" | "EXITED" | "TERMINATED";

export interface RunPodPod {
  id: string;
  name: string;
  desiredStatus: RunPodDesiredStatus;
  adjustedCostPerHr?: number;
  costPerHr?: number;
  publicIp?: string;
  lastStartedAt?: string;
  gpu?: {
    id?: string;
    count?: number;
    displayName?: string;
  };
}

export interface RunPodCreatePodInput {
  name: string;
  imageName: string;
  cloudType: "SECURE";
  computeType: "GPU";
  gpuTypeIds: string[];
  gpuTypePriority: "availability";
  gpuCount: 1;
  containerDiskInGb: number;
  networkVolumeId: string;
  volumeMountPath: "/workspace";
  ports: ["4318/http"];
  interruptible: false;
  locked: false;
  env: Record<string, string>;
}

export interface RunPodBillingRecord {
  amount: number;
  diskSpaceBilledGb?: number;
  gpuTypeId?: string;
  podId?: string;
  time: string;
  timeBilledMs?: number;
}

export class RunPodSchemaError extends Error {}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RunPodSchemaError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) {
    throw new RunPodSchemaError(`${label} must be a non-negative number`);
  }
  return parsed;
}

export function parseRunPodPod(value: unknown): RunPodPod {
  const raw = object(value, "RunPod Pod");
  if (typeof raw.id !== "string" || !raw.id.trim()) {
    throw new RunPodSchemaError("RunPod Pod id is required");
  }
  if (typeof raw.name !== "string") {
    throw new RunPodSchemaError("RunPod Pod name is required");
  }
  if (!new Set(["RUNNING", "EXITED", "TERMINATED"]).has(String(raw.desiredStatus))) {
    throw new RunPodSchemaError("RunPod Pod desiredStatus is unsupported");
  }
  const pod: RunPodPod = {
    id: raw.id,
    name: raw.name,
    desiredStatus: raw.desiredStatus as RunPodDesiredStatus,
  };
  const adjustedCostPerHr = optionalFiniteNumber(raw.adjustedCostPerHr, "RunPod adjustedCostPerHr");
  const costPerHr = optionalFiniteNumber(raw.costPerHr, "RunPod costPerHr");
  if (adjustedCostPerHr !== undefined) pod.adjustedCostPerHr = adjustedCostPerHr;
  if (costPerHr !== undefined) pod.costPerHr = costPerHr;
  if (typeof raw.publicIp === "string" && raw.publicIp) pod.publicIp = raw.publicIp;
  if (typeof raw.lastStartedAt === "string" && raw.lastStartedAt) {
    pod.lastStartedAt = raw.lastStartedAt;
  }
  if (raw.gpu !== undefined && raw.gpu !== null) {
    const gpuRaw = object(raw.gpu, "RunPod Pod gpu");
    const count = optionalFiniteNumber(gpuRaw.count, "RunPod gpu.count");
    pod.gpu = {
      ...(typeof gpuRaw.id === "string" ? { id: gpuRaw.id } : {}),
      ...(count !== undefined ? { count } : {}),
      ...(typeof gpuRaw.displayName === "string" ? { displayName: gpuRaw.displayName } : {}),
    };
  }
  return pod;
}

export function parseRunPodPodList(value: unknown): RunPodPod[] {
  if (!Array.isArray(value)) throw new RunPodSchemaError("RunPod Pod list must be an array");
  if (value.length > 1_000) throw new RunPodSchemaError("RunPod Pod list exceeds the safe limit");
  return value.map(parseRunPodPod);
}

export function parseRunPodBillingRecords(value: unknown): RunPodBillingRecord[] {
  if (!Array.isArray(value))
    throw new RunPodSchemaError("RunPod billing response must be an array");
  if (value.length > 10_000) {
    throw new RunPodSchemaError("RunPod billing response exceeds the safe limit");
  }
  return value.map((entry) => {
    const raw = object(entry, "RunPod billing record");
    const amount = optionalFiniteNumber(raw.amount, "RunPod billing amount");
    if (
      amount === undefined ||
      typeof raw.time !== "string" ||
      !Number.isFinite(Date.parse(raw.time))
    ) {
      throw new RunPodSchemaError("RunPod billing record requires amount and RFC3339 time");
    }
    const diskSpaceBilledGb = optionalFiniteNumber(
      raw.diskSpaceBilledGb,
      "RunPod diskSpaceBilledGb",
    );
    const timeBilledMs = optionalFiniteNumber(raw.timeBilledMs, "RunPod timeBilledMs");
    return {
      amount,
      time: raw.time,
      ...(diskSpaceBilledGb !== undefined ? { diskSpaceBilledGb } : {}),
      ...(timeBilledMs !== undefined ? { timeBilledMs } : {}),
      ...(typeof raw.gpuTypeId === "string" ? { gpuTypeId: raw.gpuTypeId } : {}),
      ...(typeof raw.podId === "string" ? { podId: raw.podId } : {}),
    };
  });
}
