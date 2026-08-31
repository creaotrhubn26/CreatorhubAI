import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  ComputeBootstrapArtifact,
  ComputeBootstrapFailureCode,
  ComputeBootstrapStage,
  ComputeBootstrapStatus,
  ComputeWorkerStatus,
  RemoteJobManifestV1,
  RemoteJobStatusV1,
} from "@glimmer/shared";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const SAFE_POD_ID = /^[A-Za-z0-9_-]{1,191}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const SAFE_IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class WorkerProtocolError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface WorkerHandshakeV1 {
  schemaVersion: 1;
  buildId: string;
  capability: string;
  checkpointKey: string;
  contextTokens: 65_536 | 131_072;
}

export interface WorkerCheckpointDownload {
  bytes: Uint8Array;
  sha256: string;
}

export interface WorkerCheckpointMetadataV1 {
  schemaVersion: 1;
  jobId: string;
  sessionId: string;
  sequence: number;
  kind: "progress" | "result";
  final: boolean;
  plaintextSha256: string;
}

export interface WorkerClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Only tests may opt into plain HTTP loopback. */
  allowLoopbackHttp?: boolean;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new WorkerProtocolError(`${label} contains unsupported or missing fields`);
  }
}

function boundedKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new WorkerProtocolError(`${label} contains unsupported or missing fields`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkerProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new WorkerProtocolError(`${label} is invalid`);
  }
  return value;
}

function utcTimestamp(value: unknown, label: string): string {
  const parsed = timestamp(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(parsed) ||
    new Date(parsed).toISOString().slice(0, 19) !== parsed.slice(0, 19)
  ) {
    throw new WorkerProtocolError(`${label} must be an RFC 3339 UTC timestamp`);
  }
  return parsed;
}

function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new WorkerProtocolError(`${label} is invalid`);
  }
  return Number(value);
}

function signedInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isInteger(value) || Math.abs(Number(value)) > maximum) {
    throw new WorkerProtocolError(`${label} is invalid`);
  }
  return Number(value);
}

function text(value: unknown, label: string, maximum = 512): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new WorkerProtocolError(`${label} is invalid`);
  }
  return value;
}

function contextTokens(value: unknown): 65_536 | 131_072 {
  if (value !== 65_536 && value !== 131_072) {
    throw new WorkerProtocolError("worker context is invalid");
  }
  return value;
}

const BOOTSTRAP_STAGES = new Set<ComputeBootstrapStage>([
  "initializing",
  "worker_starting",
  "worker_listening",
  "cache_checking",
  "cache_publishing",
  "artifact_preparing",
  "artifact_downloading",
  "artifact_verifying",
  "model_starting",
  "model_healthcheck",
  "ready",
  "failed",
]);
const BOOTSTRAP_ARTIFACTS = new Set<ComputeBootstrapArtifact>(["model", "mmproj", "draft"]);
const BOOTSTRAP_PHASES = new Set<NonNullable<ComputeBootstrapStatus["artifact"]>["phase"]>([
  "locking",
  "cached",
  "resuming",
  "downloading",
  "verifying",
  "complete",
]);
const BOOTSTRAP_FAILURE_CODES = new Set<ComputeBootstrapFailureCode>([
  "configuration_invalid",
  "status_persistence_failed",
  "worker_start_failed",
  "artifact_download_failed",
  "artifact_checksum_failed",
  "cache_not_ready",
  "cache_publish_failed",
  "coordinator_callback_failed",
  "model_start_failed",
  "model_healthcheck_failed",
  "bootstrap_interrupted",
  "unexpected_failure",
]);

function parseBootstrapStatus(value: unknown): ComputeBootstrapStatus {
  const raw = object(value, "worker bootstrap health");
  boundedKeys(
    raw,
    ["stage", "outcome", "stageStartedAt", "updatedAt"],
    ["artifact", "failureCode", "exitCode"],
    "worker bootstrap health",
  );
  if (!BOOTSTRAP_STAGES.has(raw.stage as ComputeBootstrapStage)) {
    throw new WorkerProtocolError("worker bootstrap stage is invalid");
  }
  if (!new Set(["in_progress", "ready", "failed"]).has(String(raw.outcome))) {
    throw new WorkerProtocolError("worker bootstrap outcome is invalid");
  }
  const stage = raw.stage as ComputeBootstrapStage;
  const outcome = raw.outcome as ComputeBootstrapStatus["outcome"];
  if (
    (outcome === "ready" && stage !== "ready") ||
    (outcome === "failed" && stage !== "failed") ||
    (outcome === "in_progress" && (stage === "ready" || stage === "failed"))
  ) {
    throw new WorkerProtocolError("worker bootstrap stage and outcome conflict");
  }
  const stageStartedAt = utcTimestamp(raw.stageStartedAt, "worker bootstrap stage start");
  const updatedAt = utcTimestamp(raw.updatedAt, "worker bootstrap update");
  if (Date.parse(updatedAt) < Date.parse(stageStartedAt)) {
    throw new WorkerProtocolError("worker bootstrap timestamps are inconsistent");
  }
  const parsed: ComputeBootstrapStatus = {
    stage,
    outcome,
    stageStartedAt,
    updatedAt,
  };
  if (raw.artifact !== undefined) {
    if (
      !new Set(["artifact_preparing", "artifact_downloading", "artifact_verifying", "failed"]).has(
        stage,
      )
    ) {
      throw new WorkerProtocolError("worker bootstrap artifact is out of stage");
    }
    const artifact = object(raw.artifact, "worker bootstrap artifact");
    boundedKeys(
      artifact,
      ["kind", "phase"],
      ["bytesCompleted", "bytesTotal"],
      "worker bootstrap artifact",
    );
    if (!BOOTSTRAP_ARTIFACTS.has(artifact.kind as ComputeBootstrapArtifact)) {
      throw new WorkerProtocolError("worker bootstrap artifact kind is invalid");
    }
    if (
      !BOOTSTRAP_PHASES.has(
        artifact.phase as NonNullable<ComputeBootstrapStatus["artifact"]>["phase"],
      )
    ) {
      throw new WorkerProtocolError("worker bootstrap artifact phase is invalid");
    }
    const bytesCompleted =
      artifact.bytesCompleted === undefined
        ? undefined
        : integer(artifact.bytesCompleted, "worker bootstrap completed bytes");
    const bytesTotal =
      artifact.bytesTotal === undefined
        ? undefined
        : integer(artifact.bytesTotal, "worker bootstrap total bytes");
    if (bytesCompleted !== undefined && bytesTotal !== undefined && bytesCompleted > bytesTotal) {
      throw new WorkerProtocolError("worker bootstrap byte progress is invalid");
    }
    parsed.artifact = {
      kind: artifact.kind as ComputeBootstrapArtifact,
      phase: artifact.phase as NonNullable<ComputeBootstrapStatus["artifact"]>["phase"],
      ...(bytesCompleted !== undefined ? { bytesCompleted } : {}),
      ...(bytesTotal !== undefined ? { bytesTotal } : {}),
    };
  } else if (
    stage === "artifact_preparing" ||
    stage === "artifact_downloading" ||
    stage === "artifact_verifying"
  ) {
    throw new WorkerProtocolError("worker bootstrap artifact is missing");
  }
  if (raw.failureCode !== undefined) {
    if (
      outcome !== "failed" ||
      !BOOTSTRAP_FAILURE_CODES.has(raw.failureCode as ComputeBootstrapFailureCode)
    ) {
      throw new WorkerProtocolError("worker bootstrap failure code is invalid");
    }
    parsed.failureCode = raw.failureCode as ComputeBootstrapFailureCode;
  }
  if (outcome === "failed" && parsed.failureCode === undefined) {
    throw new WorkerProtocolError("worker bootstrap failure code is missing");
  }
  if (raw.exitCode !== undefined) {
    if (outcome !== "failed") {
      throw new WorkerProtocolError("worker bootstrap exit code is invalid");
    }
    parsed.exitCode = integer(raw.exitCode, "worker bootstrap exit code", 255);
  }
  if (outcome === "failed" && parsed.exitCode === undefined) {
    throw new WorkerProtocolError("worker bootstrap exit code is missing");
  }
  return parsed;
}

function normalizedBaseUrl(value: string, allowLoopbackHttp = false): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WorkerProtocolError("worker base URL is invalid");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" &&
      !(allowLoopbackHttp && parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new WorkerProtocolError("worker base URL must be an origin-only HTTPS URL");
  }
  return parsed.origin;
}

export function workerBaseUrlForPod(podId: string): string {
  if (!SAFE_POD_ID.test(podId)) throw new WorkerProtocolError("RunPod Pod id is invalid");
  return `https://${podId}-4318.proxy.runpod.net`;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return value;
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalValue(value)));
}

export function workerRequestSignature(
  capability: string,
  method: string,
  requestPath: string,
  idempotencyKey: string,
  body: Uint8Array,
): string {
  if (!SAFE_SECRET.test(capability)) throw new WorkerProtocolError("worker capability is invalid");
  if (!SAFE_IDEMPOTENCY.test(idempotencyKey)) {
    throw new WorkerProtocolError("worker idempotency key is invalid");
  }
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const signed = `${method.toUpperCase()}\n${requestPath}\n${idempotencyKey}\n${bodyHash}`;
  return createHmac("sha256", Buffer.from(capability, "utf8")).update(signed).digest("hex");
}

export function decryptWorkerCheckpoint(
  checkpointKey: string,
  envelope: Uint8Array,
  metadata: WorkerCheckpointMetadataV1,
): Uint8Array {
  let key: Buffer;
  try {
    key = Buffer.from(checkpointKey, "base64url");
  } catch {
    throw new WorkerProtocolError("worker checkpoint key is invalid");
  }
  if (key.byteLength !== 32 || !SHA256.test(metadata.plaintextSha256)) {
    throw new WorkerProtocolError("worker checkpoint metadata is invalid");
  }
  const bytes = Buffer.from(envelope);
  if (bytes.byteLength < 53 || bytes.subarray(0, 5).toString("ascii") !== "GLMR1") {
    throw new WorkerProtocolError("encrypted worker checkpoint is invalid");
  }
  const aadLength = bytes.readUInt32BE(17);
  const ciphertextStart = 21 + aadLength;
  if (aadLength > 128 * 1024 || ciphertextStart + 16 > bytes.byteLength) {
    throw new WorkerProtocolError("encrypted worker checkpoint is invalid");
  }
  const expectedAad = Buffer.from(canonicalJsonBytes(metadata));
  const storedAad = bytes.subarray(21, ciphertextStart);
  if (storedAad.byteLength !== expectedAad.byteLength || !timingSafeEqual(storedAad, expectedAad)) {
    throw new WorkerProtocolError("worker checkpoint metadata does not match");
  }
  const nonce = bytes.subarray(5, 17);
  const authTag = bytes.subarray(bytes.byteLength - 16);
  const ciphertext = bytes.subarray(ciphertextStart, bytes.byteLength - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(storedAad);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const digest = createHash("sha256").update(plaintext).digest("hex");
    if (
      !timingSafeEqual(Buffer.from(digest, "ascii"), Buffer.from(metadata.plaintextSha256, "ascii"))
    ) {
      throw new WorkerProtocolError("worker checkpoint plaintext checksum does not match");
    }
    return plaintext;
  } catch (error) {
    if (error instanceof WorkerProtocolError) throw error;
    throw new WorkerProtocolError("worker checkpoint authentication failed");
  }
}

export function parseWorkerHealth(value: unknown): ComputeWorkerStatus {
  const raw = object(value, "worker health");
  const schemaVersion = raw.schemaVersion;
  exactKeys(
    raw,
    schemaVersion === 2
      ? ["schemaVersion", "buildId", "ready", "model", "workerState", "bootstrap"]
      : ["schemaVersion", "buildId", "ready", "model", "workerState"],
    "worker health",
  );
  if ((schemaVersion !== 1 && schemaVersion !== 2) || typeof raw.ready !== "boolean") {
    throw new WorkerProtocolError("worker health schema is invalid");
  }
  const model = object(raw.model, "worker model health");
  exactKeys(model, ["ready", "contextTokens"], "worker model health");
  if (typeof model.ready !== "boolean") {
    throw new WorkerProtocolError("worker model readiness is invalid");
  }
  if (!(["bootstrapping", "ready", "busy"] as unknown[]).includes(raw.workerState)) {
    throw new WorkerProtocolError("worker state is invalid");
  }
  if (
    (raw.ready && (!model.ready || raw.workerState === "bootstrapping")) ||
    (!raw.ready && raw.workerState !== "bootstrapping")
  ) {
    throw new WorkerProtocolError("worker readiness and state conflict");
  }
  const parsed: ComputeWorkerStatus = {
    protocolVersion: schemaVersion,
    buildId: text(raw.buildId, "worker build id", 128),
    ready: raw.ready,
    workerState: raw.workerState as ComputeWorkerStatus["workerState"],
    model: { ready: model.ready, contextTokens: contextTokens(model.contextTokens) },
  };
  if (schemaVersion === 2) {
    parsed.bootstrap = parseBootstrapStatus(raw.bootstrap);
    if (
      (parsed.ready && parsed.bootstrap.outcome !== "ready") ||
      (parsed.bootstrap.outcome === "failed" && parsed.ready)
    ) {
      throw new WorkerProtocolError("worker readiness conflicts with bootstrap outcome");
    }
  }
  return parsed;
}

export function parseWorkerHandshake(value: unknown): WorkerHandshakeV1 {
  const raw = object(value, "worker handshake");
  exactKeys(
    raw,
    ["schemaVersion", "buildId", "capability", "checkpointKey", "contextTokens"],
    "worker handshake",
  );
  if (raw.schemaVersion !== 1) throw new WorkerProtocolError("worker handshake schema is invalid");
  const capability = text(raw.capability, "worker capability", 256);
  const checkpointKey = text(raw.checkpointKey, "worker checkpoint key", 256);
  if (!SAFE_SECRET.test(capability) || !SAFE_SECRET.test(checkpointKey)) {
    throw new WorkerProtocolError("worker handshake secrets are invalid");
  }
  return {
    schemaVersion: 1,
    buildId: text(raw.buildId, "worker build id", 128),
    capability,
    checkpointKey,
    contextTokens: contextTokens(raw.contextTokens),
  };
}

function parseCheckpoint(value: unknown) {
  const raw = object(value, "remote checkpoint");
  exactKeys(
    raw,
    ["sequence", "bytes", "sha256", "plaintextSha256", "kind", "final", "acknowledged"],
    "remote checkpoint",
  );
  if (
    !SHA256.test(String(raw.sha256)) ||
    !SHA256.test(String(raw.plaintextSha256)) ||
    (raw.kind !== "progress" && raw.kind !== "result")
  ) {
    throw new WorkerProtocolError("remote checkpoint is invalid");
  }
  if (typeof raw.final !== "boolean" || typeof raw.acknowledged !== "boolean") {
    throw new WorkerProtocolError("remote checkpoint flags are invalid");
  }
  return {
    sequence: integer(raw.sequence, "checkpoint sequence", 1_000_000),
    bytes: integer(raw.bytes, "checkpoint size", MAX_CHECKPOINT_BYTES),
    sha256: String(raw.sha256),
    plaintextSha256: String(raw.plaintextSha256),
    kind: raw.kind,
    final: raw.final,
    acknowledged: raw.acknowledged,
  } as const;
}

export function parseRemoteJobStatus(value: unknown): RemoteJobStatusV1 {
  const raw = object(value, "remote job status");
  const allowed = [
    "schemaVersion",
    "jobId",
    "sessionId",
    "state",
    "receivedParts",
    "expectedParts",
    "receivedBytes",
    "expectedBytes",
    "createdAt",
    "updatedAt",
    "checkpoints",
    ...(raw.exitCode === undefined ? [] : ["exitCode"]),
    ...(raw.detail === undefined ? [] : ["detail"]),
  ];
  exactKeys(raw, allowed, "remote job status");
  const states = [
    "created",
    "uploading",
    "running",
    "cancelling",
    "cancelled",
    "succeeded",
    "failed",
    "interrupted",
  ];
  if (raw.schemaVersion !== 1 || !states.includes(String(raw.state))) {
    throw new WorkerProtocolError("remote job status schema is invalid");
  }
  if (!Array.isArray(raw.checkpoints) || raw.checkpoints.length > 512) {
    throw new WorkerProtocolError("remote job checkpoints are invalid");
  }
  return {
    schemaVersion: 1,
    jobId: text(raw.jobId, "remote job id", 128),
    sessionId: text(raw.sessionId, "remote session id", 128),
    state: raw.state as RemoteJobStatusV1["state"],
    receivedParts: integer(raw.receivedParts, "received parts", 256),
    expectedParts: integer(raw.expectedParts, "expected parts", 256),
    receivedBytes: integer(raw.receivedBytes, "received bytes", 1024 ** 3),
    expectedBytes: integer(raw.expectedBytes, "expected bytes", 1024 ** 3),
    createdAt: timestamp(raw.createdAt, "remote job createdAt"),
    updatedAt: timestamp(raw.updatedAt, "remote job updatedAt"),
    checkpoints: raw.checkpoints.map(parseCheckpoint),
    ...(raw.exitCode === undefined
      ? {}
      : { exitCode: signedInteger(raw.exitCode, "remote exit code", 255) }),
    ...(raw.detail === undefined ? {} : { detail: text(raw.detail, "remote job detail", 2_000) }),
  };
}

function validJobId(value: string): string {
  if (!SAFE_ID.test(value)) throw new WorkerProtocolError("remote job id is invalid");
  return encodeURIComponent(value);
}

export class WorkerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: WorkerClientOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl, options.allowLoopbackHttp);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request(
    requestPath: string,
    init: RequestInit,
    maximum = MAX_JSON_BYTES,
    requestedTimeoutMs?: number,
  ): Promise<{ response: Response; bytes: Uint8Array }> {
    if (
      requestedTimeoutMs !== undefined &&
      (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0)
    ) {
      throw new WorkerProtocolError("worker request timeout must be positive");
    }
    const timeoutMs =
      requestedTimeoutMs === undefined
        ? this.timeoutMs
        : Math.max(1, Math.min(this.timeoutMs, Math.floor(requestedTimeoutMs)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${requestPath}`, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > maximum) {
        throw new WorkerProtocolError(
          "worker response exceeds the safe size limit",
          response.status,
        );
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maximum) {
            await reader.cancel();
            throw new WorkerProtocolError(
              "worker response exceeds the safe size limit",
              response.status,
            );
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
      if (!response.ok) {
        throw new WorkerProtocolError(
          `worker request failed with HTTP ${response.status}`,
          response.status,
        );
      }
      return { response, bytes };
    } catch (error) {
      if (error instanceof WorkerProtocolError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new WorkerProtocolError("worker request timed out");
      }
      throw new WorkerProtocolError(
        `worker request failed: ${error instanceof Error ? error.message : "unknown network error"}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private json(bytes: Uint8Array): unknown {
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new WorkerProtocolError("worker returned invalid JSON");
    }
  }

  private signedHeaders(
    capability: string,
    method: string,
    requestPath: string,
    idempotencyKey: string,
    body: Uint8Array,
    contentType: string,
  ): Headers {
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${capability}`,
      "Content-Type": contentType,
      "Idempotency-Key": idempotencyKey,
    });
    headers.set(
      "X-Glimmer-Signature",
      `sha256=${workerRequestSignature(capability, method, requestPath, idempotencyKey, body)}`,
    );
    return headers;
  }

  async health(
    capability?: string,
    options: { timeoutMs?: number } = {},
  ): Promise<ComputeWorkerStatus> {
    const headers = new Headers({ Accept: "application/json" });
    if (capability) headers.set("Authorization", `Bearer ${capability}`);
    const { bytes } = await this.request(
      "/v1/health",
      { method: "GET", headers },
      MAX_JSON_BYTES,
      options.timeoutMs,
    );
    return parseWorkerHealth(this.json(bytes));
  }

  async handshake(
    input: {
      bootstrapToken: string;
      controllerInstanceId: string;
      nonce: string;
      idempotencyKey: string;
    },
    options: { timeoutMs?: number } = {},
  ): Promise<WorkerHandshakeV1> {
    if (!SAFE_SECRET.test(input.bootstrapToken) || !SAFE_IDEMPOTENCY.test(input.idempotencyKey)) {
      throw new WorkerProtocolError("worker bootstrap input is invalid");
    }
    const body = canonicalJsonBytes({
      controllerInstanceId: input.controllerInstanceId,
      nonce: input.nonce,
    });
    const { bytes } = await this.request(
      "/v1/handshake",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.bootstrapToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: Buffer.from(body),
      },
      MAX_JSON_BYTES,
      options.timeoutMs,
    );
    return parseWorkerHandshake(this.json(bytes));
  }

  private async mutateJson(
    requestPath: string,
    method: "POST" | "PUT",
    value: unknown,
    capability: string,
    idempotencyKey: string,
    expected: number[],
  ): Promise<RemoteJobStatusV1> {
    const body = canonicalJsonBytes(value);
    const { response, bytes } = await this.request(requestPath, {
      method,
      headers: this.signedHeaders(
        capability,
        method,
        requestPath,
        idempotencyKey,
        body,
        "application/json",
      ),
      body: Buffer.from(body),
    });
    if (!expected.includes(response.status)) {
      throw new WorkerProtocolError(
        `worker returned unexpected HTTP ${response.status}`,
        response.status,
      );
    }
    return parseRemoteJobStatus(this.json(bytes));
  }

  createJob(manifest: RemoteJobManifestV1, capability: string, idempotencyKey: string) {
    return this.mutateJson("/v1/jobs", "POST", manifest, capability, idempotencyKey, [201]);
  }

  async uploadPart(input: {
    jobId: string;
    part: number;
    bytes: Uint8Array;
    sha256: string;
    capability: string;
    idempotencyKey: string;
  }): Promise<RemoteJobStatusV1> {
    if (
      !Number.isInteger(input.part) ||
      input.part < 0 ||
      input.part > 255 ||
      !SHA256.test(input.sha256)
    ) {
      throw new WorkerProtocolError("worker upload metadata is invalid");
    }
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > 8 * 1024 * 1024) {
      throw new WorkerProtocolError("worker upload part has an invalid size");
    }
    const requestPath = `/v1/jobs/${validJobId(input.jobId)}/input/${input.part}`;
    const { bytes } = await this.request(requestPath, {
      method: "PUT",
      headers: new Headers({
        ...Object.fromEntries(
          this.signedHeaders(
            input.capability,
            "PUT",
            requestPath,
            input.idempotencyKey,
            input.bytes,
            "application/octet-stream",
          ),
        ),
        "X-Chunk-SHA256": input.sha256,
      }),
      body: Buffer.from(input.bytes),
    });
    return parseRemoteJobStatus(this.json(bytes));
  }

  startJob(jobId: string, capability: string, idempotencyKey: string) {
    return this.mutateJson(
      `/v1/jobs/${validJobId(jobId)}/start`,
      "POST",
      {},
      capability,
      idempotencyKey,
      [202],
    );
  }

  cancelJob(jobId: string, capability: string, idempotencyKey: string) {
    return this.mutateJson(
      `/v1/jobs/${validJobId(jobId)}/cancel`,
      "POST",
      {},
      capability,
      idempotencyKey,
      [202],
    );
  }

  async jobStatus(jobId: string, capability: string): Promise<RemoteJobStatusV1> {
    const { bytes } = await this.request(`/v1/jobs/${validJobId(jobId)}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${capability}` },
    });
    return parseRemoteJobStatus(this.json(bytes));
  }

  async checkpoint(
    jobId: string,
    sequence: number,
    capability: string,
  ): Promise<WorkerCheckpointDownload> {
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 1_000_000) {
      throw new WorkerProtocolError("checkpoint sequence is invalid");
    }
    const { response, bytes } = await this.request(
      `/v1/jobs/${validJobId(jobId)}/checkpoints/${sequence}`,
      { method: "GET", headers: { Authorization: `Bearer ${capability}` } },
      MAX_CHECKPOINT_BYTES,
    );
    const digest = response.headers.get("x-checkpoint-sha256") ?? "";
    if (!SHA256.test(digest)) throw new WorkerProtocolError("checkpoint digest header is invalid");
    const actual = createHash("sha256").update(bytes).digest("hex");
    const matches = timingSafeEqual(Buffer.from(actual, "ascii"), Buffer.from(digest, "ascii"));
    if (!matches) throw new WorkerProtocolError("checkpoint digest does not match");
    return { bytes, sha256: digest };
  }

  acknowledgeCheckpoint(
    jobId: string,
    sequence: number,
    sha256: string,
    capability: string,
    idempotencyKey: string,
  ) {
    if (
      !Number.isInteger(sequence) ||
      sequence < 0 ||
      sequence > 1_000_000 ||
      !SHA256.test(sha256)
    ) {
      throw new WorkerProtocolError("checkpoint acknowledgement is invalid");
    }
    return this.mutateJson(
      `/v1/jobs/${validJobId(jobId)}/checkpoints/${sequence}/ack`,
      "POST",
      { sha256 },
      capability,
      idempotencyKey,
      [200],
    );
  }
}
