import { createHmac } from "node:crypto";
import type {
  ComputeCacheProgressV1,
  ComputeCoordinatorJobState,
  ComputeCoordinatorJobV1,
  ComputeCoordinatorTestResult,
} from "@glimmer/shared";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{32,512}$/;
const SAFE_KEY_ID = /^[a-f0-9]{64}$/;
const SAFE_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
const SAFE_JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_FINGERPRINT = /^[a-f0-9]{64}$/;
const JOB_STATES = new Set<ComputeCoordinatorJobState>([
  "accepted",
  "waiting_for_capacity",
  "watchdog_registered",
  "recovering_create",
  "provisioning",
  "running",
  "awaiting_cache_attestation",
  "cache_ready",
  "ready",
  "terminating",
  "terminated",
  "failed",
]);
const CACHE_PROGRESS_STAGES = new Set<ComputeCacheProgressV1["stage"]>([
  "initializing",
  "worker_starting",
  "worker_listening",
  "artifact_preparing",
  "artifact_downloading",
  "artifact_verifying",
  "cache_publishing",
]);
const CACHE_PROGRESS_KINDS = new Set<NonNullable<ComputeCacheProgressV1["artifact"]>["kind"]>([
  "model",
  "mmproj",
  "draft",
]);
const CACHE_PROGRESS_PHASES = new Set<NonNullable<ComputeCacheProgressV1["artifact"]>["phase"]>([
  "locking",
  "cached",
  "resuming",
  "downloading",
  "verifying",
  "complete",
]);
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024 * 1024;

export interface CoordinatorJobRequestV1 {
  schemaVersion: 1;
  jobId: string;
  ownerInstanceId: string;
  kind: "gpu_worker";
  image: string;
  buildId: string;
  containerRegistryAuthId: string;
  networkVolumeId: string;
  contextTokens: 65_536 | 131_072;
  modelArtifacts: {
    model: { url: string; sha256: string };
    mmproj: { url: string; sha256: string };
    draftModel: { url: string; sha256: string };
    allowedHosts: string[];
  };
  maxHourlyUsd: number;
  hardDeadlineAt: string;
  gpuMaxRuntimeSeconds?: number;
  maxTotalUsd?: number;
  idleTimeoutSeconds: number;
  gpuTypeId: string;
  // Every allowed GPU variant; the coordinator picks the one with live
  // capacity at the volume's data center.
  gpuTypeIds?: string[];
  bootstrapToken: string;
}

export interface CoordinatorClientOptions {
  baseUrl: string;
  ingestToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export class CoordinatorProtocolError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function normalizedBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CoordinatorProtocolError("coordinator endpoint is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new CoordinatorProtocolError("coordinator endpoint must be an origin-only HTTPS URL");
  }
  return parsed.origin;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoordinatorProtocolError("coordinator returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new CoordinatorProtocolError(
      "coordinator response contains unsupported or missing fields",
    );
  }
}

function exactOptionalKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new CoordinatorProtocolError(
      "coordinator response contains unsupported or missing fields",
    );
  }
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new CoordinatorProtocolError(`${label} is invalid`);
  }
  return value;
}

function parseCacheProgress(value: unknown): ComputeCacheProgressV1 {
  const raw = object(value);
  exactOptionalKeys(
    raw,
    ["stage", "outcome", "stageStartedAt", "updatedAt", "observedAt"],
    ["artifact"],
  );
  if (
    !CACHE_PROGRESS_STAGES.has(raw.stage as ComputeCacheProgressV1["stage"]) ||
    raw.outcome !== "in_progress"
  ) {
    throw new CoordinatorProtocolError("coordinator cache progress schema is invalid");
  }
  const stageStartedAt = timestamp(raw.stageStartedAt, "cache progress stageStartedAt");
  const updatedAt = timestamp(raw.updatedAt, "cache progress updatedAt");
  const observedAt = timestamp(raw.observedAt, "cache progress observedAt");
  if (Date.parse(updatedAt) < Date.parse(stageStartedAt)) {
    throw new CoordinatorProtocolError("coordinator cache progress timestamps are invalid");
  }
  const parsed: ComputeCacheProgressV1 = {
    stage: raw.stage as ComputeCacheProgressV1["stage"],
    outcome: "in_progress",
    stageStartedAt,
    updatedAt,
    observedAt,
  };
  if (raw.artifact !== undefined) {
    const artifact = object(raw.artifact);
    exactOptionalKeys(artifact, ["kind", "phase"], ["bytesCompleted", "bytesTotal"]);
    if (
      !CACHE_PROGRESS_KINDS.has(
        artifact.kind as NonNullable<ComputeCacheProgressV1["artifact"]>["kind"],
      ) ||
      !CACHE_PROGRESS_PHASES.has(
        artifact.phase as NonNullable<ComputeCacheProgressV1["artifact"]>["phase"],
      )
    ) {
      throw new CoordinatorProtocolError("coordinator cache progress artifact is invalid");
    }
    for (const key of ["bytesCompleted", "bytesTotal"] as const) {
      if (
        artifact[key] !== undefined &&
        (!Number.isInteger(artifact[key]) ||
          (artifact[key] as number) < 0 ||
          (artifact[key] as number) > MAX_ARTIFACT_BYTES)
      ) {
        throw new CoordinatorProtocolError("coordinator cache progress bytes are invalid");
      }
    }
    if (
      ((artifact.bytesCompleted as number | undefined) ?? 0) >
      ((artifact.bytesTotal as number | undefined) ?? MAX_ARTIFACT_BYTES)
    ) {
      throw new CoordinatorProtocolError("coordinator cache progress bytes are inconsistent");
    }
    parsed.artifact = {
      kind: artifact.kind as NonNullable<ComputeCacheProgressV1["artifact"]>["kind"],
      phase: artifact.phase as NonNullable<ComputeCacheProgressV1["artifact"]>["phase"],
      ...(typeof artifact.bytesCompleted === "number"
        ? { bytesCompleted: artifact.bytesCompleted }
        : {}),
      ...(typeof artifact.bytesTotal === "number" ? { bytesTotal: artifact.bytesTotal } : {}),
    };
  }
  return parsed;
}

export function coordinatorRequestSignature(
  ingestToken: string,
  method: string,
  requestPath: string,
  timestampMs: number,
  body: string,
): string {
  if (!SAFE_TOKEN.test(ingestToken)) {
    throw new CoordinatorProtocolError("coordinator ingest token is invalid");
  }
  const message = `${method.toUpperCase()}\n${requestPath}\n${timestampMs}\n${body}`;
  return createHmac("sha256", ingestToken).update(message).digest("hex");
}

export function parseCoordinatorStatus(value: unknown): ComputeCoordinatorTestResult {
  const raw = object(value);
  exactOptionalKeys(
    raw,
    [
      "service",
      "schemaVersion",
      "ready",
      "checkedAt",
      "providerApiVersion",
      "watchdogReady",
      "activeJobId",
      "cacheSigning",
    ],
    // Operator diagnostic added 2026-09-04: the callback hostname live Pods
    // are configured with.
    ["callbackHost"],
  );
  const signing = object(raw.cacheSigning);
  exactKeys(signing, ["algorithm", "keyId", "publicKey"]);
  if (
    raw.service !== "glimmer-compute-coordinator" ||
    raw.schemaVersion !== 1 ||
    typeof raw.ready !== "boolean" ||
    (raw.providerApiVersion !== "v2" && raw.providerApiVersion !== "rest-v1+catalog-v2") ||
    typeof raw.watchdogReady !== "boolean" ||
    (raw.activeJobId !== null &&
      (typeof raw.activeJobId !== "string" || !SAFE_JOB_ID.test(raw.activeJobId))) ||
    signing.algorithm !== "Ed25519" ||
    typeof signing.keyId !== "string" ||
    !SAFE_KEY_ID.test(signing.keyId) ||
    typeof signing.publicKey !== "string" ||
    !SAFE_PUBLIC_KEY.test(signing.publicKey)
  ) {
    throw new CoordinatorProtocolError("coordinator status schema is invalid");
  }
  return {
    service: "glimmer-compute-coordinator",
    schemaVersion: 1,
    ready: raw.ready,
    checkedAt: timestamp(raw.checkedAt, "coordinator checkedAt"),
    providerApiVersion: raw.providerApiVersion,
    watchdogReady: raw.watchdogReady,
    activeJobId: raw.activeJobId as string | null,
    cacheSigning: {
      algorithm: "Ed25519",
      keyId: signing.keyId,
      publicKey: signing.publicKey,
    },
  };
}

export function parseCoordinatorJob(value: unknown): ComputeCoordinatorJobV1 {
  const raw = object(value);
  const required = [
    "schemaVersion",
    "jobId",
    "kind",
    "state",
    "phase",
    "cacheKey",
    "requestFingerprint",
    "podName",
    "createdAt",
    "updatedAt",
    "hardDeadlineAt",
    "maxHourlyUsd",
    "cache",
    "createAttempted",
    "cleanup",
  ];
  exactOptionalKeys(raw, required, [
    "podId",
    "phaseDeadlineAt",
    "lastHeartbeatAt",
    "cacheProgress",
    "maxTotalUsd",
    "repairJobId",
    "waitingReason",
    "failureCode",
    // Bounded diagnostic event lines sampled from a failed cache Pod.
    "failureDetail",
  ]);
  const cache = object(raw.cache);
  const cacheProgress =
    raw.cacheProgress === undefined ? undefined : parseCacheProgress(raw.cacheProgress);
  exactOptionalKeys(cache, ["state"], ["manifestSha256", "verifiedAt", "buildId", "volumeId"]);
  const cleanup = object(raw.cleanup);
  exactKeys(cleanup, ["requested", "confirmed"]);
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.jobId !== "string" ||
    !SAFE_JOB_ID.test(raw.jobId) ||
    (raw.kind !== "cpu_cache" && raw.kind !== "gpu_worker") ||
    typeof raw.state !== "string" ||
    !JOB_STATES.has(raw.state as ComputeCoordinatorJobState) ||
    (raw.phase !== "cache_repair" && raw.phase !== "gpu_worker") ||
    typeof raw.cacheKey !== "string" ||
    !SAFE_FINGERPRINT.test(raw.cacheKey) ||
    typeof raw.requestFingerprint !== "string" ||
    !SAFE_FINGERPRINT.test(raw.requestFingerprint) ||
    typeof raw.podName !== "string" ||
    !SAFE_ID.test(raw.podName) ||
    (raw.podId !== undefined && (typeof raw.podId !== "string" || !SAFE_ID.test(raw.podId))) ||
    (raw.repairJobId !== undefined &&
      (typeof raw.repairJobId !== "string" || !SAFE_JOB_ID.test(raw.repairJobId))) ||
    (raw.waitingReason !== undefined &&
      raw.waitingReason !== "GPU_UNAVAILABLE" &&
      raw.waitingReason !== "RUNPOD_TRANSPORT_ERROR") ||
    typeof raw.maxHourlyUsd !== "number" ||
    !Number.isFinite(raw.maxHourlyUsd) ||
    raw.maxHourlyUsd <= 0 ||
    (raw.maxTotalUsd !== undefined &&
      (typeof raw.maxTotalUsd !== "number" ||
        !Number.isFinite(raw.maxTotalUsd) ||
        raw.maxTotalUsd <= 0 ||
        raw.maxTotalUsd > 100)) ||
    typeof raw.createAttempted !== "boolean" ||
    typeof cleanup.requested !== "boolean" ||
    typeof cleanup.confirmed !== "boolean" ||
    !new Set(["missing", "preparing", "ready", "repair_required"]).has(String(cache.state)) ||
    (cache.manifestSha256 !== undefined &&
      (typeof cache.manifestSha256 !== "string" || !SAFE_FINGERPRINT.test(cache.manifestSha256))) ||
    (cache.buildId !== undefined &&
      (typeof cache.buildId !== "string" || !/^r2-[a-f0-9]{12}$/.test(cache.buildId))) ||
    (cache.volumeId !== undefined &&
      (typeof cache.volumeId !== "string" || !SAFE_ID.test(cache.volumeId))) ||
    (raw.failureCode !== undefined &&
      (typeof raw.failureCode !== "string" || !/^[A-Z0-9_]{1,120}$/.test(raw.failureCode)))
  ) {
    throw new CoordinatorProtocolError("coordinator job schema is invalid");
  }
  const parsed: ComputeCoordinatorJobV1 = {
    schemaVersion: 1,
    jobId: raw.jobId,
    kind: raw.kind,
    state: raw.state as ComputeCoordinatorJobState,
    phase: raw.phase,
    cacheKey: raw.cacheKey,
    requestFingerprint: raw.requestFingerprint,
    podName: raw.podName,
    ...(typeof raw.podId === "string" ? { podId: raw.podId } : {}),
    createdAt: timestamp(raw.createdAt, "coordinator job createdAt"),
    updatedAt: timestamp(raw.updatedAt, "coordinator job updatedAt"),
    hardDeadlineAt: timestamp(raw.hardDeadlineAt, "coordinator job hardDeadlineAt"),
    ...(raw.phaseDeadlineAt !== undefined
      ? { phaseDeadlineAt: timestamp(raw.phaseDeadlineAt, "coordinator job phaseDeadlineAt") }
      : {}),
    ...(raw.lastHeartbeatAt !== undefined
      ? { lastHeartbeatAt: timestamp(raw.lastHeartbeatAt, "coordinator job lastHeartbeatAt") }
      : {}),
    ...(cacheProgress ? { cacheProgress } : {}),
    maxHourlyUsd: raw.maxHourlyUsd,
    ...(typeof raw.maxTotalUsd === "number" ? { maxTotalUsd: raw.maxTotalUsd } : {}),
    cache: {
      state: cache.state as ComputeCoordinatorJobV1["cache"]["state"],
      ...(typeof cache.manifestSha256 === "string" ? { manifestSha256: cache.manifestSha256 } : {}),
      ...(cache.verifiedAt !== undefined
        ? { verifiedAt: timestamp(cache.verifiedAt, "cache verifiedAt") }
        : {}),
      ...(typeof cache.buildId === "string" ? { buildId: cache.buildId } : {}),
      ...(typeof cache.volumeId === "string" ? { volumeId: cache.volumeId } : {}),
    },
    createAttempted: raw.createAttempted,
    cleanup: { requested: cleanup.requested, confirmed: cleanup.confirmed },
    ...(typeof raw.repairJobId === "string" ? { repairJobId: raw.repairJobId } : {}),
    ...(raw.waitingReason === "GPU_UNAVAILABLE" || raw.waitingReason === "RUNPOD_TRANSPORT_ERROR"
      ? { waitingReason: raw.waitingReason }
      : {}),
    ...(typeof raw.failureCode === "string" ? { failureCode: raw.failureCode } : {}),
  };
  return parsed;
}

export class CoordinatorClient {
  private readonly baseUrl: string;
  private readonly ingestToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: CoordinatorClientOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    this.ingestToken = options.ingestToken.trim();
    if (!SAFE_TOKEN.test(this.ingestToken)) {
      throw new CoordinatorProtocolError("coordinator ingest token is invalid");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  private async request(method: string, requestPath: string, body = ""): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    const timestampMs = this.now().getTime();
    const signature = coordinatorRequestSignature(
      this.ingestToken,
      method,
      requestPath,
      timestampMs,
      body,
    );
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${requestPath}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          "X-Glimmer-Timestamp": String(timestampMs),
          "X-Glimmer-Signature": `v1=${signature}`,
        },
        ...(body ? { body } : {}),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new CoordinatorProtocolError(
          `coordinator request failed with HTTP ${response.status}`,
          response.status,
        );
      }
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new CoordinatorProtocolError("coordinator response exceeds the safe size limit");
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new CoordinatorProtocolError("coordinator response exceeds the safe size limit");
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new CoordinatorProtocolError("coordinator returned invalid JSON");
      }
    } catch (error) {
      if (error instanceof CoordinatorProtocolError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new CoordinatorProtocolError("coordinator request timed out");
      }
      throw new CoordinatorProtocolError(
        `coordinator request failed: ${error instanceof Error ? error.message : "unknown network error"}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async status(): Promise<ComputeCoordinatorTestResult> {
    return parseCoordinatorStatus(await this.request("GET", "/v1/status"));
  }

  async putJob(input: CoordinatorJobRequestV1): Promise<ComputeCoordinatorJobV1> {
    if (!SAFE_JOB_ID.test(input.jobId)) {
      throw new CoordinatorProtocolError("coordinator job id is invalid");
    }
    const path = `/v1/jobs/${encodeURIComponent(input.jobId)}`;
    return parseCoordinatorJob(await this.request("PUT", path, JSON.stringify(input)));
  }

  async getJob(jobId: string): Promise<ComputeCoordinatorJobV1> {
    if (!SAFE_JOB_ID.test(jobId)) {
      throw new CoordinatorProtocolError("coordinator job id is invalid");
    }
    return parseCoordinatorJob(await this.request("GET", `/v1/jobs/${encodeURIComponent(jobId)}`));
  }

  async deleteJob(jobId: string): Promise<ComputeCoordinatorJobV1> {
    if (!SAFE_JOB_ID.test(jobId)) {
      throw new CoordinatorProtocolError("coordinator job id is invalid");
    }
    return parseCoordinatorJob(
      await this.request("DELETE", `/v1/jobs/${encodeURIComponent(jobId)}`),
    );
  }
}
