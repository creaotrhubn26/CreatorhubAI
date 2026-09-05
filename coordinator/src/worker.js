import {
  RunPodV2Client,
  RunPodV2Error,
  RunPodV2HttpError,
  buildCpuCachePodRequest,
  buildGpuCachePodRequest,
  buildGpuWorkerPodRequest,
  selectRunPodV2CpuOffer,
  selectRunPodV2GpuOffer,
} from "./runpod-v2.js";

const PRIMARY_COORDINATOR = "primary";
const ACTIVE_JOB_KEY = "active-job";
const LAST_JOB_KEY = "last-job";
const JOB_PREFIX = "job:";
const CACHE_PREFIX = "cache:";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_WATCHDOG_RESPONSE_BYTES = 16 * 1024;
const AUTH_WINDOW_MS = 120_000;
const POLL_MS = 30_000;
const CREATE_RECOVERY_MS = 5 * 60_000;
const EXIT_CALLBACK_GRACE_MS = 2 * 60_000;
const WATCHDOG_DELETE_SAFETY_SECONDS = 120;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BUILD_ID = /^r2-[a-f0-9]{12}$/;
const IMAGE = /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/;
const GPU_TYPE = /^[A-Za-z0-9][A-Za-z0-9 ._()+/-]{0,127}$/;
const CACHE_REPAIR_GPU_FALLBACKS = new Set(["NVIDIA L4"]);
const TOKEN = /^[A-Za-z0-9_-]{43,512}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const PRIVATE_KEY = /^[A-Za-z0-9_-]{64,512}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TERMINAL_STATES = new Set(["terminated", "failed"]);
const ACTIVE_PROVIDER_STATES = new Set(["CREATED", "PROVISIONING", "STARTING", "RUNNING"]);
const TERMINAL_PROVIDER_STATES = new Set(["STOPPED", "EXITED", "ERROR", "TERMINATED"]);
const CACHE_PROGRESS_STAGES = new Set([
  "initializing",
  "worker_starting",
  "worker_listening",
  "artifact_preparing",
  "artifact_downloading",
  "artifact_verifying",
  "cache_publishing",
]);
const ARTIFACT_KINDS = new Set(["model", "mmproj", "draft"]);
const ARTIFACT_PHASES = new Set([
  "locking",
  "cached",
  "resuming",
  "downloading",
  "verifying",
  "complete",
]);
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024 * 1024;
const CACHE_FAILURE_CODES = new Map([
  ["configuration_invalid", "CACHE_BOOTSTRAP_CONFIGURATION_INVALID"],
  ["status_persistence_failed", "CACHE_BOOTSTRAP_STATUS_PERSISTENCE_FAILED"],
  ["worker_start_failed", "CACHE_BOOTSTRAP_WORKER_START_FAILED"],
  ["artifact_download_failed", "CACHE_BOOTSTRAP_ARTIFACT_DOWNLOAD_FAILED"],
  ["artifact_checksum_failed", "CACHE_BOOTSTRAP_ARTIFACT_CHECKSUM_FAILED"],
  ["cache_not_ready", "CACHE_BOOTSTRAP_NOT_READY"],
  ["cache_publish_failed", "CACHE_BOOTSTRAP_PUBLISH_FAILED"],
  ["coordinator_callback_failed", "CACHE_BOOTSTRAP_CALLBACK_FAILED"],
  ["model_start_failed", "CACHE_BOOTSTRAP_MODEL_START_FAILED"],
  ["model_healthcheck_failed", "CACHE_BOOTSTRAP_MODEL_HEALTHCHECK_FAILED"],
  ["bootstrap_interrupted", "CACHE_BOOTSTRAP_INTERRUPTED"],
  ["unexpected_failure", "CACHE_BOOTSTRAP_UNEXPECTED_FAILURE"],
]);

function response(value, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(status, code) {
  return response({ error: code }, status);
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseCacheProgress(value) {
  if (
    !exactKeys(value, ["stage", "outcome", "stageStartedAt", "updatedAt"], ["artifact"]) ||
    !CACHE_PROGRESS_STAGES.has(value.stage) ||
    value.outcome !== "in_progress" ||
    !validTimestamp(value.stageStartedAt) ||
    !validTimestamp(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.stageStartedAt)
  ) {
    throw new Error("INVALID_CACHE_PROGRESS");
  }
  const progress = {
    stage: value.stage,
    outcome: value.outcome,
    stageStartedAt: value.stageStartedAt,
    updatedAt: value.updatedAt,
  };
  if (value.artifact !== undefined) {
    const artifact = value.artifact;
    if (
      !exactKeys(artifact, ["kind", "phase"], ["bytesCompleted", "bytesTotal"]) ||
      !ARTIFACT_KINDS.has(artifact.kind) ||
      !ARTIFACT_PHASES.has(artifact.phase)
    ) {
      throw new Error("INVALID_CACHE_PROGRESS");
    }
    for (const key of ["bytesCompleted", "bytesTotal"]) {
      if (
        artifact[key] !== undefined &&
        (!Number.isInteger(artifact[key]) ||
          artifact[key] < 0 ||
          artifact[key] > MAX_ARTIFACT_BYTES)
      ) {
        throw new Error("INVALID_CACHE_PROGRESS");
      }
    }
    if ((artifact.bytesCompleted ?? 0) > (artifact.bytesTotal ?? MAX_ARTIFACT_BYTES)) {
      throw new Error("INVALID_CACHE_PROGRESS");
    }
    progress.artifact = { ...artifact };
  }
  return progress;
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64url(bytes) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlToBytes(value, expectedLength, label) {
  if (typeof value !== "string" || value.length > 512) throw new Error(label);
  let binary;
  try {
    binary = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4),
    );
  } catch {
    throw new Error(label);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== expectedLength || bytesToBase64url(bytes) !== value)
    throw new Error(label);
  return bytes;
}

function base64urlBytes(value, minimumLength, maximumLength, label) {
  if (typeof value !== "string" || value.length > 1024) throw new Error(label);
  let binary;
  try {
    binary = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4),
    );
  } catch {
    throw new Error(label);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    bytes.byteLength < minimumLength ||
    bytes.byteLength > maximumLength ||
    bytesToBase64url(bytes) !== value
  )
    throw new Error(label);
  return bytes;
}

async function sha256Bytes(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", value));
}

async function sha256Text(value) {
  return bytesToHex(await sha256Bytes(new TextEncoder().encode(value)));
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))),
  );
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1)
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

async function readBody(request) {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new Error("BODY_TOO_LARGE");
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readBoundedJsonResponse(result, maximumBytes) {
  const declared = result.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new Error("RESPONSE_TOO_LARGE");
  }
  if (!result.body) return {};
  const reader = result.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : {};
  } catch {
    throw new Error("INVALID_JSON_RESPONSE");
  }
}

async function requestAuthorized(request, env, body, nowMs) {
  if (typeof env.INGEST_TOKEN !== "string" || !TOKEN.test(env.INGEST_TOKEN)) return false;
  const timestamp = request.headers.get("X-Glimmer-Timestamp") ?? "";
  const supplied = request.headers.get("X-Glimmer-Signature") ?? "";
  if (!/^\d{13}$/.test(timestamp) || !/^v1=[a-f0-9]{64}$/.test(supplied)) return false;
  if (Math.abs(nowMs - Number(timestamp)) > AUTH_WINDOW_MS) return false;
  const url = new URL(request.url);
  if (url.search || url.hash) return false;
  const expected = await hmacHex(
    env.INGEST_TOKEN,
    `${request.method}\n${url.pathname}\n${timestamp}\n${body}`,
  );
  return constantTimeEqual(supplied, `v1=${expected}`);
}

function strictOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(label);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(label);
  }
  return parsed.origin;
}

function numberSetting(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new Error(label);
  return parsed;
}

async function configuration(env) {
  if (
    typeof env.RUNPOD_API_KEY !== "string" ||
    env.RUNPOD_API_KEY.length < 16 ||
    typeof env.WATCHDOG_INGEST_TOKEN !== "string" ||
    !TOKEN.test(env.WATCHDOG_INGEST_TOKEN) ||
    typeof env.CACHE_SIGNING_PRIVATE_KEY !== "string" ||
    !PRIVATE_KEY.test(env.CACHE_SIGNING_PRIVATE_KEY) ||
    typeof env.CACHE_SIGNING_PUBLIC_KEY !== "string" ||
    !PUBLIC_KEY.test(env.CACHE_SIGNING_PUBLIC_KEY) ||
    typeof env.JOB_ENCRYPTION_KEY !== "string" ||
    !PUBLIC_KEY.test(env.JOB_ENCRYPTION_KEY)
  ) {
    throw new Error("INVALID_COORDINATOR_CONFIG");
  }
  const publicBytes = base64urlToBytes(
    env.CACHE_SIGNING_PUBLIC_KEY,
    32,
    "INVALID_COORDINATOR_CONFIG",
  );
  const privateBytes = base64urlBytes(
    env.CACHE_SIGNING_PRIVATE_KEY,
    48,
    256,
    "INVALID_COORDINATOR_CONFIG",
  );
  base64urlToBytes(env.JOB_ENCRYPTION_KEY, 32, "INVALID_COORDINATOR_CONFIG");
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    privateBytes,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const publicKey = await crypto.subtle.importKey("raw", publicBytes, { name: "Ed25519" }, false, [
    "verify",
  ]);
  const challenge = new TextEncoder().encode("glimmer-cache-signing-key-pair-v1");
  const challengeSignature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, challenge);
  if (
    !(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, challengeSignature, challenge))
  ) {
    throw new Error("INVALID_COORDINATOR_CONFIG");
  }
  const cpuMaxHourlyUsd = numberSetting(
    env.CPU_CACHE_MAX_HOURLY_USD,
    0.0225,
    0.001,
    1,
    "INVALID_COORDINATOR_CONFIG",
  );
  const cacheRepairTtlSeconds = numberSetting(
    env.CPU_CACHE_TTL_SECONDS,
    1680,
    300,
    7200,
    "INVALID_COORDINATOR_CONFIG",
  );
  const cacheRepairMaxTotalUsd = numberSetting(
    env.CACHE_REPAIR_MAX_TOTAL_USD,
    0.25,
    0.01,
    10,
    "INVALID_COORDINATOR_CONFIG",
  );
  const fallbackGpuId = env.CACHE_REPAIR_GPU_FALLBACK_ID?.trim() || null;
  if (
    fallbackGpuId !== null &&
    (!GPU_TYPE.test(fallbackGpuId) || !CACHE_REPAIR_GPU_FALLBACKS.has(fallbackGpuId))
  ) {
    throw new Error("INVALID_COORDINATOR_CONFIG");
  }
  const fallbackGpuMaxHourlyUsd =
    fallbackGpuId === null
      ? null
      : numberSetting(
          env.CACHE_REPAIR_GPU_MAX_HOURLY_USD,
          0.49,
          0.1,
          10,
          "INVALID_COORDINATOR_CONFIG",
        );
  const maximumRepairHourlyUsd = Math.max(cpuMaxHourlyUsd, fallbackGpuMaxHourlyUsd ?? 0);
  if (
    (maximumRepairHourlyUsd * (cacheRepairTtlSeconds + WATCHDOG_DELETE_SAFETY_SECONDS)) / 3600 >
    cacheRepairMaxTotalUsd
  ) {
    throw new Error("INVALID_COORDINATOR_CONFIG");
  }
  return {
    runpodBaseUrl:
      strictOrigin(
        env.RUNPOD_API_BASE_URL ?? "https://rest.runpod.io",
        "INVALID_COORDINATOR_CONFIG",
      ) + "/v1",
    runpodCatalogBaseUrl:
      strictOrigin(
        env.RUNPOD_CATALOG_API_BASE_URL ?? "https://api.runpod.io",
        "INVALID_COORDINATOR_CONFIG",
      ) + "/v2",
    watchdogUrl: strictOrigin(env.WATCHDOG_URL, "INVALID_COORDINATOR_CONFIG"),
    publicUrl: strictOrigin(env.COORDINATOR_PUBLIC_URL, "INVALID_COORDINATOR_CONFIG"),
    cacheKeyId: bytesToHex(await sha256Bytes(publicBytes)),
    cpuMaxHourlyUsd,
    cacheRepairTtlSeconds,
    cacheRepairMaxTotalUsd,
    cacheRepairGpuFallback:
      fallbackGpuId === null
        ? null
        : { gpuTypeId: fallbackGpuId, maxHourlyUsd: fallbackGpuMaxHourlyUsd },
  };
}

function artifact(value, allowedHosts, label) {
  if (
    !exactKeys(value, ["url", "sha256"]) ||
    typeof value.url !== "string" ||
    !SHA256.test(value.sha256)
  ) {
    throw new Error(`INVALID_${label.toUpperCase()}_ARTIFACT`);
  }
  let parsed;
  try {
    parsed = new URL(value.url);
  } catch {
    throw new Error(`INVALID_${label.toUpperCase()}_ARTIFACT`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !allowedHosts.includes(parsed.hostname.toLowerCase())
  )
    throw new Error(`INVALID_${label.toUpperCase()}_ARTIFACT`);
  return { url: parsed.toString(), sha256: value.sha256 };
}

function parseJobRequest(value, jobId, nowMs) {
  const required = [
    "schemaVersion",
    "jobId",
    "ownerInstanceId",
    "kind",
    "image",
    "buildId",
    "containerRegistryAuthId",
    "networkVolumeId",
    "contextTokens",
    "modelArtifacts",
    "maxHourlyUsd",
    "hardDeadlineAt",
  ];
  if (
    !exactKeys(value, required, [
      "gpuTypeId",
      "gpuTypeIds",
      "bootstrapToken",
      "idleTimeoutSeconds",
      "gpuMaxRuntimeSeconds",
      "maxTotalUsd",
    ])
  )
    throw new Error("INVALID_JOB_SHAPE");
  if (
    value.schemaVersion !== 1 ||
    value.jobId !== jobId ||
    !UUID.test(jobId) ||
    !SAFE_ID.test(value.ownerInstanceId) ||
    !["cpu_cache", "gpu_worker"].includes(value.kind) ||
    !IMAGE.test(value.image) ||
    !BUILD_ID.test(value.buildId) ||
    !SAFE_ID.test(value.containerRegistryAuthId) ||
    !SAFE_ID.test(value.networkVolumeId) ||
    ![65_536, 131_072].includes(value.contextTokens) ||
    typeof value.maxHourlyUsd !== "number" ||
    !Number.isFinite(value.maxHourlyUsd) ||
    value.maxHourlyUsd <= 0 ||
    value.maxHourlyUsd > 100 ||
    !validTimestamp(value.hardDeadlineAt)
  )
    throw new Error("INVALID_JOB_VALUE");
  const deadline = Date.parse(value.hardDeadlineAt);
  if (deadline <= nowMs + 60_000 || deadline > nowMs + 86_400_000)
    throw new Error("INVALID_JOB_DEADLINE");
  if (!exactKeys(value.modelArtifacts, ["model", "mmproj", "draftModel", "allowedHosts"]))
    throw new Error("INVALID_MODEL_ARTIFACTS");
  const allowedHosts = value.modelArtifacts.allowedHosts;
  if (
    !Array.isArray(allowedHosts) ||
    allowedHosts.length < 1 ||
    allowedHosts.length > 12 ||
    allowedHosts.some(
      (host) => typeof host !== "string" || host !== host.toLowerCase() || !HOST.test(host),
    ) ||
    new Set(allowedHosts).size !== allowedHosts.length
  )
    throw new Error("INVALID_ARTIFACT_HOSTS");
  if (value.kind === "gpu_worker") {
    if (
      typeof value.gpuTypeId !== "string" ||
      value.gpuTypeId.length > 128 ||
      !TOKEN.test(value.bootstrapToken ?? "")
    ) {
      throw new Error("INVALID_GPU_JOB");
    }
    if (
      value.gpuTypeIds !== undefined &&
      (!Array.isArray(value.gpuTypeIds) ||
        value.gpuTypeIds.length < 1 ||
        value.gpuTypeIds.length > 4 ||
        value.gpuTypeIds.some((id) => typeof id !== "string" || !id || id.length > 128) ||
        new Set(value.gpuTypeIds).size !== value.gpuTypeIds.length)
    ) {
      throw new Error("INVALID_GPU_JOB");
    }
    const hasPhaseBudget =
      value.gpuMaxRuntimeSeconds !== undefined || value.maxTotalUsd !== undefined;
    if (
      hasPhaseBudget &&
      (!Number.isInteger(value.gpuMaxRuntimeSeconds) ||
        value.gpuMaxRuntimeSeconds < 60 ||
        value.gpuMaxRuntimeSeconds > 86_400 ||
        typeof value.maxTotalUsd !== "number" ||
        !Number.isFinite(value.maxTotalUsd) ||
        value.maxTotalUsd <= 0 ||
        value.maxTotalUsd > 100 ||
        (value.maxHourlyUsd * (value.gpuMaxRuntimeSeconds + WATCHDOG_DELETE_SAFETY_SECONDS)) /
          3600 >
          value.maxTotalUsd)
    ) {
      throw new Error("INVALID_GPU_BUDGET");
    }
  } else if (
    value.gpuTypeId !== undefined ||
    value.bootstrapToken !== undefined ||
    value.gpuMaxRuntimeSeconds !== undefined ||
    value.maxTotalUsd !== undefined
  ) {
    throw new Error("INVALID_CPU_JOB");
  }
  const idleTimeoutSeconds = value.idleTimeoutSeconds ?? 300;
  if (
    !Number.isInteger(idleTimeoutSeconds) ||
    idleTimeoutSeconds < 60 ||
    idleTimeoutSeconds > 3600
  ) {
    throw new Error("INVALID_IDLE_TIMEOUT");
  }
  return {
    schemaVersion: 1,
    jobId,
    ownerInstanceId: value.ownerInstanceId,
    kind: value.kind,
    image: value.image,
    buildId: value.buildId,
    containerRegistryAuthId: value.containerRegistryAuthId,
    networkVolumeId: value.networkVolumeId,
    contextTokens: value.contextTokens,
    modelArtifacts: {
      model: artifact(value.modelArtifacts.model, allowedHosts, "model"),
      mmproj: artifact(value.modelArtifacts.mmproj, allowedHosts, "mmproj"),
      draftModel: artifact(value.modelArtifacts.draftModel, allowedHosts, "draft"),
      allowedHosts: [...allowedHosts],
    },
    maxHourlyUsd: value.maxHourlyUsd,
    hardDeadlineAt: new Date(deadline).toISOString(),
    idleTimeoutSeconds,
    ...(value.gpuTypeId ? { gpuTypeId: value.gpuTypeId } : {}),
    ...(value.gpuTypeIds ? { gpuTypeIds: [...value.gpuTypeIds] } : {}),
    ...(value.bootstrapToken ? { bootstrapToken: value.bootstrapToken } : {}),
    ...(value.gpuMaxRuntimeSeconds !== undefined
      ? { gpuMaxRuntimeSeconds: value.gpuMaxRuntimeSeconds }
      : {}),
    ...(value.maxTotalUsd !== undefined ? { maxTotalUsd: value.maxTotalUsd } : {}),
  };
}

async function cacheKeyFor(request) {
  return sha256Text(
    canonicalize({
      schemaVersion: 1,
      volumeId: request.networkVolumeId,
      artifacts: {
        model: request.modelArtifacts.model.sha256,
        mmproj: request.modelArtifacts.mmproj.sha256,
        draft: request.modelArtifacts.draftModel.sha256,
      },
    }),
  );
}

async function encryptToken(value, env, jobId) {
  const key = await crypto.subtle.importKey(
    "raw",
    base64urlToBytes(env.JOB_ENCRYPTION_KEY, 32, "INVALID_COORDINATOR_CONFIG"),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(`glimmer-bootstrap-v1:${jobId}`);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData },
      key,
      new TextEncoder().encode(value),
    ),
  );
  return { iv: bytesToBase64url(iv), ciphertext: bytesToBase64url(ciphertext) };
}

async function decryptToken(value, env, jobId) {
  const key = await crypto.subtle.importKey(
    "raw",
    base64urlToBytes(env.JOB_ENCRYPTION_KEY, 32, "INVALID_COORDINATOR_CONFIG"),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64urlToBytes(value.iv, 12, "INVALID_STORED_SECRET"),
      additionalData: new TextEncoder().encode(`glimmer-bootstrap-v1:${jobId}`),
    },
    key,
    base64urlToBytes(value.ciphertext, 59, "INVALID_STORED_SECRET"),
  );
  return new TextDecoder().decode(plaintext);
}

function publicJob(job) {
  return {
    schemaVersion: 1,
    jobId: job.jobId,
    kind: job.kind,
    state: job.state,
    phase: job.phase,
    cacheKey: job.cacheKey,
    requestFingerprint: job.requestFingerprint,
    podName: job.podName,
    ...(job.podId ? { podId: job.podId } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    hardDeadlineAt: job.hardDeadlineAt,
    phaseDeadlineAt: job.currentDeadlineAt,
    ...(job.lastHeartbeatAt ? { lastHeartbeatAt: job.lastHeartbeatAt } : {}),
    ...(job.cacheProgress ? { cacheProgress: { ...job.cacheProgress } } : {}),
    maxHourlyUsd: job.maxHourlyUsd,
    ...(job.internal.request.maxTotalUsd !== undefined
      ? { maxTotalUsd: job.internal.request.maxTotalUsd }
      : {}),
    cache: { ...job.cache },
    createAttempted: job.createAttempted,
    cleanup: { ...job.cleanup },
    ...(job.repairJobId ? { repairJobId: job.repairJobId } : {}),
    ...(job.failureDetail ? { failureDetail: [...job.failureDetail] } : {}),
    ...(job.waitingReason ? { waitingReason: job.waitingReason } : {}),
    ...(job.failureCode ? { failureCode: job.failureCode } : {}),
  };
}

function randomToken() {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

// Best-effort diagnostic used only when a cache Pod reports a bootstrap
// failure: reads the container log through the provider API and logs the
// structured event lines (bounded, secret-free by construction — the
// entrypoint only prints fixed-shape JSON events) before the Pod is deleted.
async function sampleFailedPodLog(env, config, podId) {
  try {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(podId)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let text = "";
    try {
      const response = await fetch(
        `${config.runpodCatalogBaseUrl.replace(/\/v2$/, "")}/v2/pods/${encodeURIComponent(podId)}/logs?source=container&tail=2000`,
        {
          headers: { Accept: "text/event-stream", Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (text.length < 500_000) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      await reader.cancel().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
    const events = [...new Set(text.match(/\{"event":[^\n]{0,280}\}/g) ?? [])].map((event) =>
      event.slice(0, 300),
    );
    for (const event of events.slice(-12)) {
      console.warn("[coordinator] failed pod log", podId, event);
    }
    return events;
  } catch {
    // Diagnostics only; never block failure handling.
    return [];
  }
}

function runpodClient(env, config) {
  return new RunPodV2Client({
    apiKey: env.RUNPOD_API_KEY,
    baseUrl: config.runpodBaseUrl,
    catalogBaseUrl: config.runpodCatalogBaseUrl,
  });
}

async function watchdogRequest(env, config, method, path, body = "") {
  const timestamp = String(Date.now());
  const signature = await hmacHex(
    env.WATCHDOG_INGEST_TOKEN,
    `${method}\n${path}\n${timestamp}\n${body}`,
  );
  const target = `${config.watchdogUrl}${path}`;
  const init = {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      "X-Glimmer-Timestamp": timestamp,
      "X-Glimmer-Signature": `v1=${signature}`,
    },
    ...(body ? { body } : {}),
    // Cloudflare's edge Request implementation does not support `error`.
    // `manual` still fails closed below because every redirect is non-2xx.
    redirect: "manual",
  };
  const result =
    env.WATCHDOG && typeof env.WATCHDOG.fetch === "function"
      ? await env.WATCHDOG.fetch(new Request(target, init))
      : await fetch(target, init);
  if (!result.ok) throw new Error(`WATCHDOG_HTTP_${result.status}`);
  return result.status === 204
    ? null
    : readBoundedJsonResponse(result, MAX_WATCHDOG_RESPONSE_BYTES);
}

export function watchdogLease(job, now) {
  const repair = job.phase === "cache_repair";
  const gpuRepair = repair && job.internal.repairAllocation?.kind === "gpu";
  return {
    schemaVersion: 2,
    leaseId: job.currentLeaseId,
    ownerInstanceId: "glimmer-cloud-coordinator",
    jobKind: repair ? (gpuRepair ? "gpu_cache" : "cpu_cache") : "gpu_worker",
    podName: job.podName,
    ...(job.podId ? { podId: job.podId } : {}),
    hardDeadlineAt: job.currentDeadlineAt,
    lastHeartbeatAt: now,
    maxHourlyUsd: repair
      ? (job.internal.repairAllocation?.maxHourlyUsd ?? job.internal.cpuMaxHourlyUsd)
      : job.maxHourlyUsd,
    expected: {
      cloud: "SECURE",
      gpuCount: repair ? (gpuRepair ? 1 : 0) : 1,
      networkVolumeId: job.internal.request.networkVolumeId,
      ...(gpuRepair
        ? { gpuTypeId: job.internal.repairAllocation.resourceId }
        : repair
          ? {}
          : { gpuTypeId: job.internal.selectedGpuTypeId ?? job.internal.request.gpuTypeId }),
    },
  };
}

function validateCachePayload(signed, request) {
  if (!exactKeys(signed, ["schemaVersion", "volumeId", "buildId", "createdAt", "artifacts"])) {
    throw new Error("INVALID_CACHE_MANIFEST");
  }
  if (
    signed.schemaVersion !== 1 ||
    signed.volumeId !== request.networkVolumeId ||
    !BUILD_ID.test(signed.buildId) ||
    !validTimestamp(signed.createdAt) ||
    !Array.isArray(signed.artifacts) ||
    signed.artifacts.length !== 3
  )
    throw new Error("INVALID_CACHE_MANIFEST");
  const expected = [
    ["model", request.modelArtifacts.model.sha256, "model"],
    ["mmproj", request.modelArtifacts.mmproj.sha256, "mmproj"],
    ["draft", request.modelArtifacts.draftModel.sha256, "dflash"],
  ];
  for (let index = 0; index < expected.length; index += 1) {
    const entry = signed.artifacts[index];
    const [kind, digest, prefix] = expected[index];
    if (
      !exactKeys(entry, ["kind", "path", "sha256", "bytes"]) ||
      entry.kind !== kind ||
      entry.sha256 !== digest ||
      entry.path !== `${prefix}.${digest}.gguf` ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      entry.bytes > 32 * 1024 ** 3
    )
      throw new Error("INVALID_CACHE_MANIFEST");
  }
  return signed;
}

async function signCachePayload(signed, request, env, config) {
  validateCachePayload(signed, request);
  if (
    signed.buildId !== request.buildId ||
    Math.abs(Date.now() - Date.parse(signed.createdAt)) > 5 * 60_000
  ) {
    throw new Error("INVALID_CACHE_ATTESTATION");
  }
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    base64urlBytes(env.CACHE_SIGNING_PRIVATE_KEY, 48, 256, "INVALID_COORDINATOR_CONFIG"),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      privateKey,
      new TextEncoder().encode(canonicalize(signed)),
    ),
  );
  return {
    signed,
    signature: {
      algorithm: "ed25519",
      keyId: config.cacheKeyId,
      value: bytesToBase64url(signature),
    },
  };
}

async function verifyCacheManifest(manifest, request, env, config) {
  if (
    !exactKeys(manifest, ["signed", "signature"]) ||
    !exactKeys(manifest.signature, ["algorithm", "keyId", "value"])
  ) {
    throw new Error("INVALID_CACHE_MANIFEST");
  }
  const signed = validateCachePayload(manifest.signed, request);
  if (
    manifest.signature.algorithm !== "ed25519" ||
    manifest.signature.keyId !== config.cacheKeyId ||
    !SIGNATURE.test(manifest.signature.value)
  )
    throw new Error("INVALID_CACHE_MANIFEST");
  const publicKey = await crypto.subtle.importKey(
    "raw",
    base64urlToBytes(env.CACHE_SIGNING_PUBLIC_KEY, 32, "INVALID_COORDINATOR_CONFIG"),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    base64urlToBytes(manifest.signature.value, 64, "INVALID_CACHE_MANIFEST"),
    new TextEncoder().encode(canonicalize(signed)),
  );
  if (!verified) throw new Error("INVALID_CACHE_SIGNATURE");
  return {
    state: "ready",
    manifestSha256: await sha256Text(canonicalize(manifest)),
    verifiedAt: new Date().toISOString(),
    buildId: signed.buildId,
    volumeId: signed.volumeId,
    manifest,
  };
}

export class ComputeCoordinator {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.operation = Promise.resolve();
  }

  exclusive(operation) {
    const next = this.operation.catch(() => undefined).then(operation);
    this.operation = next;
    return next;
  }

  async schedule(delay = 1) {
    await this.storage.setAlarm(Date.now() + delay);
  }

  async getJob(jobId) {
    return (await this.storage.get(`${JOB_PREFIX}${jobId}`)) ?? null;
  }

  async putJob(job) {
    job.updatedAt = new Date().toISOString();
    await this.storage.put(`${JOB_PREFIX}${job.jobId}`, job);
  }

  async status(config) {
    let watchdogReady;
    try {
      const watchdog = await watchdogRequest(this.env, config, "GET", "/v1/status");
      watchdogReady = Boolean(
        watchdog?.service === "glimmer-compute-watchdog" &&
        watchdog.schemaVersion === 1 &&
        watchdog.ready === true &&
        validTimestamp(watchdog.checkedAt) &&
        validTimestamp(watchdog.lastSweepAt),
      );
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z0-9_]{1,120}$/.test(error.message)
          ? error.message
          : "WATCHDOG_STATUS_UNAVAILABLE";
      const diagnostic =
        error instanceof Error
          ? `${error.name}:${error.message}`
              .replace(/rpa_[A-Za-z0-9_-]+/g, "rpa_[redacted]")
              .replace(/[A-Za-z0-9_-]{43,}/g, "[redacted]")
              .slice(0, 240)
          : "unknown";
      console.warn("[coordinator] watchdog status check failed", code, diagnostic);
      watchdogReady = false;
    }
    const activeJobId = (await this.storage.get(ACTIVE_JOB_KEY)) ?? null;
    const lastJobId = (await this.storage.get(LAST_JOB_KEY)) ?? null;
    return {
      service: "glimmer-compute-coordinator",
      schemaVersion: 1,
      ready: watchdogReady,
      checkedAt: new Date().toISOString(),
      providerApiVersion: "rest-v1+catalog-v2",
      watchdogReady,
      activeJobId,
      // Most recently created job, terminal ones included, so an operator can
      // fetch its failure diagnostics after the gateway clears its lease.
      lastJobId,
      // Hostname only (no path/token): lets an operator confirm which callback
      // origin live Pods are actually configured with, since a Durable Object
      // can outlive a secret rotation on an older deployment version.
      callbackHost: new URL(config.publicUrl).hostname,
      cacheSigning: {
        algorithm: "Ed25519",
        keyId: config.cacheKeyId,
        publicKey: this.env.CACHE_SIGNING_PUBLIC_KEY,
      },
    };
  }

  async createJob(body, jobId, config, nowMs) {
    const request = parseJobRequest(JSON.parse(body), jobId, nowMs);
    const requestFingerprint = await sha256Text(canonicalize(request));
    const existing = await this.getJob(jobId);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint)
        return errorResponse(409, "JOB_FINGERPRINT_CONFLICT");
      return response(publicJob(existing), 200);
    }
    const activeJobId = await this.storage.get(ACTIVE_JOB_KEY);
    if (typeof activeJobId === "string") {
      const active = await this.getJob(activeJobId);
      if (active && !TERMINAL_STATES.has(active.state))
        return errorResponse(409, "ACTIVE_JOB_EXISTS");
    }
    const cacheKey = await cacheKeyFor(request);
    const cached = await this.storage.get(`${CACHE_PREFIX}${cacheKey}`);
    const now = new Date(nowMs).toISOString();
    const repairJobId = request.kind === "gpu_worker" && !cached ? crypto.randomUUID() : undefined;
    const encryptedBootstrap = request.bootstrapToken
      ? await encryptToken(request.bootstrapToken, this.env, jobId)
      : undefined;
    delete request.bootstrapToken;
    const job = {
      schemaVersion: 1,
      jobId,
      kind: request.kind,
      state: "accepted",
      phase: request.kind === "gpu_worker" && cached ? "gpu_worker" : "cache_repair",
      cacheKey,
      requestFingerprint,
      podName:
        request.kind === "gpu_worker" && cached
          ? `glimmer-gpu-${jobId}`
          : `glimmer-cache-${repairJobId ?? jobId}`,
      createdAt: now,
      updatedAt: now,
      hardDeadlineAt: request.hardDeadlineAt,
      maxHourlyUsd: request.maxHourlyUsd,
      cache: cached ? { ...cached, manifest: undefined } : { state: "missing" },
      createAttempted: false,
      cleanup: { requested: false, confirmed: false },
      ...(repairJobId ? { repairJobId } : {}),
      currentLeaseId: repairJobId ?? jobId,
      currentDeadlineAt:
        request.kind === "gpu_worker" && !cached
          ? new Date(
              Math.min(
                Date.parse(request.hardDeadlineAt),
                nowMs + config.cacheRepairTtlSeconds * 1000,
              ),
            ).toISOString()
          : request.hardDeadlineAt,
      internal: {
        request,
        ...(encryptedBootstrap ? { encryptedBootstrap } : {}),
        cpuMaxHourlyUsd:
          request.kind === "cpu_cache" ? request.maxHourlyUsd : config.cpuMaxHourlyUsd,
        repairAllocation: null,
        createIntentAt: null,
        callbackTokenHash: null,
        workerState: null,
        workerObservedAt: null,
        terminalTarget: null,
        exitObservedAt: null,
        cacheRepairAttempts: request.kind === "gpu_worker" && cached ? 0 : 1,
        repairRequested: false,
      },
    };
    await this.storage.put(ACTIVE_JOB_KEY, jobId);
    await this.storage.put(LAST_JOB_KEY, jobId);
    await this.putJob(job);
    await this.schedule();
    return response(publicJob(job), 202);
  }

  async callback(request, body, jobId, config) {
    const job = await this.getJob(jobId);
    if (!job || !job.internal.callbackTokenHash) return errorResponse(404, "JOB_NOT_FOUND");
    const authorization = request.headers.get("Authorization") ?? "";
    const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
    if (!match || !constantTimeEqual(await sha256Text(match[1]), job.internal.callbackTokenHash)) {
      return errorResponse(401, "UNAUTHORIZED");
    }
    if (job.internal.terminalTarget || TERMINAL_STATES.has(job.state)) {
      return errorResponse(409, "JOB_TERMINATING");
    }
    let value;
    try {
      value = JSON.parse(body);
    } catch {
      return errorResponse(400, "INVALID_CALLBACK_JSON");
    }
    if (!validTimestamp(value?.observedAt) || value.schemaVersion !== 1)
      return errorResponse(400, "INVALID_CALLBACK");
    if (Math.abs(Date.now() - Date.parse(value.observedAt)) > 5 * 60_000)
      return errorResponse(400, "STALE_CALLBACK");
    if (value.type === "heartbeat") {
      if (
        !exactKeys(value, ["schemaVersion", "type", "observedAt", "workerState"]) ||
        !["bootstrapping", "ready", "busy"].includes(value.workerState) ||
        job.phase !== "gpu_worker"
      ) {
        return errorResponse(400, "INVALID_HEARTBEAT");
      }
      job.internal.workerState = value.workerState;
      job.internal.workerObservedAt = value.observedAt;
      job.lastHeartbeatAt = value.observedAt;
      if (value.workerState === "ready" || value.workerState === "busy") job.state = "ready";
      await this.putJob(job);
      await this.schedule();
      return response({ accepted: true, job: publicJob(job) });
    }
    if (value.type === "cache_progress") {
      if (
        !exactKeys(value, ["schemaVersion", "type", "observedAt", "cacheKey", "progress"]) ||
        value.cacheKey !== job.cacheKey ||
        job.phase !== "cache_repair"
      ) {
        return errorResponse(400, "INVALID_CACHE_PROGRESS");
      }
      let progress;
      try {
        progress = parseCacheProgress(value.progress);
      } catch {
        return errorResponse(400, "INVALID_CACHE_PROGRESS");
      }
      if (
        job.cacheProgress &&
        Date.parse(value.observedAt) < Date.parse(job.cacheProgress.observedAt)
      ) {
        return errorResponse(409, "STALE_CACHE_PROGRESS");
      }
      job.cacheProgress = { ...progress, observedAt: value.observedAt };
      job.lastHeartbeatAt = value.observedAt;
      await this.putJob(job);
      return response({ accepted: true, job: publicJob(job) });
    }
    if (value.type === "cache_failed") {
      if (
        !exactKeys(value, ["schemaVersion", "type", "observedAt", "cacheKey", "failureCode"]) ||
        value.cacheKey !== job.cacheKey ||
        job.phase !== "cache_repair" ||
        !CACHE_FAILURE_CODES.has(value.failureCode)
      ) {
        return errorResponse(400, "INVALID_CACHE_FAILURE");
      }
      job.cache = { state: "repair_required" };
      job.failureCode = CACHE_FAILURE_CODES.get(value.failureCode);
      job.lastHeartbeatAt = value.observedAt;
      job.internal.terminalTarget = "failed";
      job.state = "terminating";
      job.cleanup.requested = true;
      await this.putJob(job);
      // The Pod is deleted moments after this report, faster than the
      // provider's log ingestion becomes readable elsewhere. Sample its
      // structured log events now and persist them on the job itself.
      if (job.podId) {
        const events = await sampleFailedPodLog(this.env, config, job.podId);
        // Whether the coordinator ever signed this attempt's attestation
        // splits a publish failure between the prepare step (before signing)
        // and the install step (after signing).
        job.failureDetail = [
          `attestation_signed:${Boolean(job.internal.pendingManifestSha256)}`,
          ...events.slice(-5),
        ];
        await this.putJob(job);
      }
      await this.schedule();
      return response({ accepted: true, job: publicJob(job) });
    }
    if (value.type === "cache_attestation") {
      if (
        !exactKeys(value, ["schemaVersion", "type", "observedAt", "cacheKey", "signed"]) ||
        value.cacheKey !== job.cacheKey ||
        job.phase !== "cache_repair"
      ) {
        return errorResponse(400, "INVALID_CACHE_ATTESTATION");
      }
      try {
        const document = await signCachePayload(
          value.signed,
          job.internal.request,
          this.env,
          config,
        );
        job.internal.pendingManifestSha256 = await sha256Text(canonicalize(document));
        job.cache = { state: "preparing" };
        job.failureCode = undefined;
        job.lastHeartbeatAt = value.observedAt;
        await this.putJob(job);
        return response({ accepted: true, document, job: publicJob(job) });
      } catch (error) {
        console.warn(
          "[coordinator] cache attestation rejected",
          error instanceof Error ? error.message.slice(0, 120) : "unknown",
        );
        job.cache = { state: "repair_required" };
        job.failureCode = "CACHE_ATTESTATION_INVALID";
        await this.putJob(job);
        return errorResponse(409, "CACHE_ATTESTATION_INVALID");
      }
    }
    if (value.type === "cache_published") {
      if (
        !exactKeys(value, ["schemaVersion", "type", "observedAt", "cacheKey", "manifest"]) ||
        value.cacheKey !== job.cacheKey ||
        job.phase !== "cache_repair"
      ) {
        return errorResponse(400, "INVALID_CACHE_PUBLICATION");
      }
      try {
        const verified = await verifyCacheManifest(
          value.manifest,
          job.internal.request,
          this.env,
          config,
        );
        if (
          !job.internal.pendingManifestSha256 ||
          job.internal.pendingManifestSha256 !== (await sha256Text(canonicalize(value.manifest)))
        )
          throw new Error("CACHE_DOCUMENT_CHANGED");
        const persisted = { ...verified };
        delete persisted.manifest;
        await this.storage.put(`${CACHE_PREFIX}${job.cacheKey}`, persisted);
        job.cache = persisted;
        job.failureCode = undefined;
        job.internal.pendingManifestSha256 = null;
        job.state = "cache_ready";
        job.lastHeartbeatAt = value.observedAt;
        await this.putJob(job);
        await this.schedule();
        return response({ accepted: true, job: publicJob(job) });
      } catch (error) {
        console.warn(
          "[coordinator] cache publication rejected",
          error instanceof Error ? error.message.slice(0, 120) : "unknown",
        );
        job.cache = { state: "repair_required" };
        job.failureCode = "CACHE_PUBLICATION_INVALID";
        await this.putJob(job);
        return errorResponse(409, "CACHE_PUBLICATION_INVALID");
      }
    }
    if (value.type === "cache_invalid") {
      if (
        !exactKeys(value, ["schemaVersion", "type", "observedAt", "cacheKey"]) ||
        value.cacheKey !== job.cacheKey ||
        job.phase !== "gpu_worker"
      ) {
        return errorResponse(400, "INVALID_CACHE_FAILURE");
      }
      await this.storage.delete(`${CACHE_PREFIX}${job.cacheKey}`);
      job.cache = { state: "repair_required" };
      if (job.internal.cacheRepairAttempts >= 2) {
        job.failureCode = "CACHE_REPAIR_EXHAUSTED";
        job.internal.terminalTarget = "failed";
      } else {
        job.internal.repairRequested = true;
      }
      job.state = "terminating";
      job.cleanup.requested = true;
      await this.putJob(job);
      await this.schedule();
      return response({ accepted: true, job: publicJob(job) });
    }
    return errorResponse(400, "INVALID_CALLBACK_TYPE");
  }

  async fetch(request) {
    const nowMs = Date.now();
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      return errorResponse(413, error instanceof Error ? error.message : "BODY_TOO_LARGE");
    }
    let config;
    try {
      config = await configuration(this.env);
    } catch {
      return errorResponse(503, "COORDINATOR_NOT_CONFIGURED");
    }
    const url = new URL(request.url);
    const callbackMatch = url.pathname.match(/^\/v1\/jobs\/([a-f0-9-]{36})\/callback$/);
    if (callbackMatch && request.method === "POST") {
      return this.exclusive(() => this.callback(request, body, callbackMatch[1], config));
    }
    if (!(await requestAuthorized(request, this.env, body, nowMs)))
      return errorResponse(401, "UNAUTHORIZED");
    if (request.method === "GET" && url.pathname === "/v1/status")
      return response(await this.status(config));
    const match = url.pathname.match(/^\/v1\/jobs\/([a-f0-9-]{36})$/);
    if (!match || !UUID.test(match[1])) return errorResponse(404, "NOT_FOUND");
    if (request.method === "PUT") {
      try {
        return await this.exclusive(() => this.createJob(body, match[1], config, nowMs));
      } catch (error) {
        return errorResponse(400, error instanceof Error ? error.message : "INVALID_JOB");
      }
    }
    const job = await this.getJob(match[1]);
    if (!job) return errorResponse(404, "JOB_NOT_FOUND");
    if (request.method === "GET") return response(publicJob(job));
    if (request.method === "DELETE") {
      return this.exclusive(async () => {
        const current = await this.getJob(match[1]);
        if (!current) return errorResponse(404, "JOB_NOT_FOUND");
        if (!TERMINAL_STATES.has(current.state)) {
          current.cleanup.requested = true;
          current.internal.terminalTarget = "terminated";
          current.state = "terminating";
          await this.putJob(current);
          await this.schedule();
        }
        return response(publicJob(current), TERMINAL_STATES.has(current.state) ? 200 : 202);
      });
    }
    return errorResponse(405, "METHOD_NOT_ALLOWED");
  }

  async upsertWatchdog(job, config) {
    const now = new Date().toISOString();
    const lease = watchdogLease(job, now);
    const accepted = await watchdogRequest(
      this.env,
      config,
      "PUT",
      `/v1/leases/${encodeURIComponent(lease.leaseId)}`,
      JSON.stringify(lease),
    );
    if (accepted?.accepted !== true || accepted.leaseId !== lease.leaseId) {
      throw new Error("WATCHDOG_REJECTED_LEASE");
    }
  }

  async cleanupCurrent(job, client, config) {
    // Cleanup deletions must be attributable when diagnosing vanished Pods.
    console.warn("[coordinator] cleanup deleting pod", job.jobId, job.podId ?? job.podName);
    job.cleanup.requested = true;
    if (!job.podId && job.createAttempted === false) {
      // No provider mutation was attempted, so a Pod cannot exist. Avoid
      // making cleanup depend on a provider that may currently be unreachable.
    } else if (!job.podId) {
      const matches = await client.listPodsByExactName(job.podName);
      if (matches.length > 1) throw new Error("DUPLICATE_CREATE_OUTCOME");
      if (matches.length === 1) {
        job.podId = matches[0].id;
        await client.deletePod(job.podId).catch(() => undefined);
        if (await client.getPodIdentity(job.podId).catch(() => ({ present: true }))) return false;
      }
    } else {
      await client.deletePod(job.podId).catch(() => undefined);
      if (await client.getPodIdentity(job.podId).catch(() => ({ present: true }))) return false;
    }
    await watchdogRequest(
      this.env,
      config,
      "DELETE",
      `/v1/leases/${encodeURIComponent(job.currentLeaseId)}`,
    ).catch(() => undefined);
    job.cleanup.confirmed = true;
    job.podId = undefined;
    return true;
  }

  async startCurrent(job, client, config) {
    const request = job.internal.request;
    const volume = await client.getNetworkVolume(request.networkVolumeId);
    await client.getRegistry(request.containerRegistryAuthId);
    const callbackToken = randomToken();
    const callbackTokenHash = await sha256Text(callbackToken);
    const commonEnvironment = {
      // Native crashes (SIGSEGV) in the orchestrator are otherwise
      // untraceable; faulthandler writes the stack to the job log.
      PYTHONFAULTHANDLER: "1",
      GLIMMER_LEASE_ID: job.currentLeaseId,
      GLIMMER_CONTEXT_TOKENS: String(request.contextTokens),
      GLIMMER_MODEL_SHA256: request.modelArtifacts.model.sha256,
      GLIMMER_MMPROJ_SHA256: request.modelArtifacts.mmproj.sha256,
      GLIMMER_DFLASH_SHA256: request.modelArtifacts.draftModel.sha256,
      GLIMMER_CACHE_VOLUME_ID: request.networkVolumeId,
      GLIMMER_REQUIRE_READY_CACHE: "1",
      GLIMMER_COORDINATOR_CALLBACK_URL: `${config.publicUrl}/v1/jobs/${job.jobId}/callback`,
      GLIMMER_COORDINATOR_CALLBACK_TOKEN: callbackToken,
      GLIMMER_CACHE_KEY: job.cacheKey,
      GLIMMER_REQUIRE_COORDINATOR_CALLBACK: "1",
    };
    let createRequest;
    if (job.phase === "cache_repair") {
      const repairEnvironment = {
        ...commonEnvironment,
        GLIMMER_PREWARM_ONLY: "1",
        GLIMMER_MODEL_URL: request.modelArtifacts.model.url,
        GLIMMER_MMPROJ_URL: request.modelArtifacts.mmproj.url,
        GLIMMER_DFLASH_URL: request.modelArtifacts.draftModel.url,
        GLIMMER_ARTIFACT_HOSTS: request.modelArtifacts.allowedHosts.join(","),
        GLIMMER_CACHE_SIGNING_PUBLIC_KEY: this.env.CACHE_SIGNING_PUBLIC_KEY,
        GLIMMER_PREWARM_EXPECTED_BUILD_ID: request.buildId,
      };
      try {
        const offer = selectRunPodV2CpuOffer(await client.listCpuTypes(), {
          dataCenterId: volume.dataCenterId,
          maxHourlyUsd: job.internal.cpuMaxHourlyUsd,
        });
        job.internal.repairAllocation = {
          kind: "cpu",
          resourceId: offer.id,
          maxHourlyUsd: job.internal.cpuMaxHourlyUsd,
          observedHourlyUsd: offer.hourlyUsd,
        };
        createRequest = buildCpuCachePodRequest({
          podName: job.podName,
          image: request.image,
          registryId: request.containerRegistryAuthId,
          networkVolumeId: request.networkVolumeId,
          dataCenterId: volume.dataCenterId,
          cpuId: offer.id,
          environment: repairEnvironment,
        });
      } catch (error) {
        if (
          !(error instanceof RunPodV2Error) ||
          error.code !== "CPU_UNAVAILABLE" ||
          request.kind !== "gpu_worker" ||
          !config.cacheRepairGpuFallback
        ) {
          throw error;
        }
        const fallback = config.cacheRepairGpuFallback;
        const offer = selectRunPodV2GpuOffer(await client.listGpuTypes(), {
          gpuTypeId: fallback.gpuTypeId,
          dataCenterId: volume.dataCenterId,
          maxHourlyUsd: fallback.maxHourlyUsd,
        });
        job.internal.repairAllocation = {
          kind: "gpu",
          resourceId: offer.id,
          maxHourlyUsd: fallback.maxHourlyUsd,
          observedHourlyUsd: offer.hourlyUsd,
        };
        createRequest = buildGpuCachePodRequest({
          podName: job.podName,
          image: request.image,
          registryId: request.containerRegistryAuthId,
          networkVolumeId: request.networkVolumeId,
          dataCenterId: volume.dataCenterId,
          gpuTypeId: offer.id,
          environment: repairEnvironment,
        });
      }
    } else {
      if (job.cache.state !== "ready") throw new Error("CACHE_NOT_READY");
      const bootstrapToken = await decryptToken(
        job.internal.encryptedBootstrap,
        this.env,
        job.jobId,
      );
      // Choose among the allowed GPU types by live catalog capacity at the
      // volume's data center; availability differs per variant and flaps.
      const gpuCandidates = request.gpuTypeIds ?? [request.gpuTypeId];
      const gpuCatalog = await client.listGpuTypes();
      let chosenGpu = null;
      for (const candidate of gpuCandidates) {
        try {
          const offer = selectRunPodV2GpuOffer(gpuCatalog, {
            gpuTypeId: candidate,
            dataCenterId: volume.dataCenterId,
            maxHourlyUsd: job.maxHourlyUsd,
          });
          if (
            chosenGpu === null ||
            offer.hourlyUsd < chosenGpu.hourlyUsd ||
            (offer.hourlyUsd === chosenGpu.hourlyUsd && offer.id < chosenGpu.id)
          ) {
            chosenGpu = offer;
          }
        } catch (error) {
          if (!(error instanceof RunPodV2Error) || error.code !== "GPU_UNAVAILABLE") throw error;
        }
      }
      if (chosenGpu !== null) job.internal.selectedGpuTypeId = chosenGpu.id;
      if (chosenGpu === null) {
        throw new RunPodV2Error(
          "GPU_UNAVAILABLE",
          "no allowed Secure GPU type is available at the volume data center within the ceiling",
        );
      }
      createRequest = buildGpuWorkerPodRequest({
        podName: job.podName,
        image: request.image,
        registryId: request.containerRegistryAuthId,
        networkVolumeId: request.networkVolumeId,
        dataCenterId: volume.dataCenterId,
        gpuTypeId: chosenGpu.id,
        environment: {
          ...commonEnvironment,
          GLIMMER_PREWARM_ONLY: "0",
          GLIMMER_CACHE_BUILD_ID: job.cache.buildId,
          GLIMMER_CACHE_SIGNING_PUBLIC_KEY: this.env.CACHE_SIGNING_PUBLIC_KEY,
          GLIMMER_WORKER_BOOTSTRAP_TOKEN: bootstrapToken,
        },
      });
    }
    await this.upsertWatchdog(job, config);
    job.waitingReason = undefined;
    job.state = "watchdog_registered";
    job.createAttempted = true;
    job.internal.createIntentAt = new Date().toISOString();
    job.internal.callbackTokenHash = callbackTokenHash;
    await this.putJob(job);
    try {
      const pod = await client.createPod(createRequest, {
        maxHourlyUsd:
          job.phase === "cache_repair"
            ? (job.internal.repairAllocation?.maxHourlyUsd ?? job.internal.cpuMaxHourlyUsd)
            : job.maxHourlyUsd,
      });
      job.podId = pod.id;
      job.state = pod.status === "RUNNING" ? "running" : "provisioning";
      await this.upsertWatchdog(job, config);
    } catch (error) {
      if (error?.ambiguousCreate) {
        job.state = "recovering_create";
      } else if (error instanceof RunPodV2HttpError && error.status === 500) {
        // The provider returns HTTP 500 for "no instances currently
        // available". A 500 does not prove the create failed, so recover by
        // exact name first; if no Pod appears, recoverCreate waits for
        // capacity instead of failing terminally.
        job.internal.capacityRetry = true;
        job.state = "recovering_create";
      } else {
        throw error;
      }
    }
  }

  async recoverCreate(job, client, config) {
    const matches = await client.listPodsByExactName(job.podName);
    if (matches.length > 1) {
      throw new Error("DUPLICATE_CREATE_OUTCOME");
    }
    if (matches.length === 1) {
      job.podId = matches[0].id;
      job.state = matches[0].status === "RUNNING" ? "running" : "provisioning";
      await this.upsertWatchdog(job, config);
      return;
    }
    if (Date.now() - Date.parse(job.internal.createIntentAt) >= CREATE_RECOVERY_MS) {
      if (job.internal.capacityRetry && Date.now() < Date.parse(job.currentDeadlineAt)) {
        // The provider rejected the create for lack of capacity and no Pod
        // materialized: safe to retry on the normal cadence, bounded by the
        // phase deadline. Never widen the GPU type, data center, or ceiling.
        job.internal.capacityRetry = null;
        job.createAttempted = false;
        job.waitingReason = "PROVIDER_NO_CAPACITY";
        job.state = "waiting_for_capacity";
        return;
      }
      throw new Error("CREATE_OUTCOME_UNRESOLVED");
    }
  }

  async transitionToGpu(job) {
    job.phase = "gpu_worker";
    job.currentLeaseId = job.jobId;
    job.currentDeadlineAt = new Date(
      Math.min(
        Date.parse(job.hardDeadlineAt),
        job.internal.request.gpuMaxRuntimeSeconds
          ? Date.now() + job.internal.request.gpuMaxRuntimeSeconds * 1000
          : Date.parse(job.hardDeadlineAt),
      ),
    ).toISOString();
    job.podName = `glimmer-gpu-${job.jobId}`;
    job.podId = undefined;
    job.createAttempted = false;
    job.cleanup = { requested: false, confirmed: false };
    job.internal.createIntentAt = null;
    job.internal.callbackTokenHash = null;
    job.internal.exitObservedAt = null;
    job.internal.workerObservedAt = null;
    job.internal.repairRequested = false;
    job.cacheProgress = undefined;
    job.state = "cache_ready";
  }

  async transitionToRepair(job, config) {
    const repairJobId = crypto.randomUUID();
    job.repairJobId = repairJobId;
    job.phase = "cache_repair";
    job.currentLeaseId = repairJobId;
    job.currentDeadlineAt = new Date(
      Math.min(Date.parse(job.hardDeadlineAt), Date.now() + config.cacheRepairTtlSeconds * 1000),
    ).toISOString();
    job.podName = `glimmer-cache-${repairJobId}`;
    job.podId = undefined;
    job.createAttempted = false;
    job.cleanup = { requested: false, confirmed: false };
    job.cache = { state: "preparing" };
    job.internal.createIntentAt = null;
    job.internal.callbackTokenHash = null;
    job.internal.workerState = null;
    job.internal.workerObservedAt = null;
    job.internal.exitObservedAt = null;
    job.internal.repairAllocation = null;
    job.internal.repairRequested = false;
    job.internal.cacheRepairAttempts += 1;
    job.cacheProgress = undefined;
    job.state = "awaiting_cache_attestation";
  }

  async finishCachePhase(job) {
    if (job.kind === "cpu_cache") {
      job.state = "ready";
      job.cleanup.confirmed = true;
      await this.storage.delete(ACTIVE_JOB_KEY);
      return;
    }
    await this.transitionToGpu(job);
  }

  async advance(job, config) {
    const client = runpodClient(this.env, config);
    if (job.internal.repairRequested) {
      if (await this.cleanupCurrent(job, client, config)) {
        await this.transitionToRepair(job, config);
      }
      return;
    }
    if (Date.now() >= Date.parse(job.currentDeadlineAt) && !job.internal.terminalTarget) {
      if (job.phase === "cache_repair") {
        job.failureCode = "CACHE_REPAIR_DEADLINE";
        job.internal.terminalTarget = "failed";
      } else {
        job.internal.terminalTarget = "terminated";
      }
    }
    if (job.internal.terminalTarget) {
      const cleaned = await this.cleanupCurrent(job, client, config);
      if (cleaned) {
        job.state = job.internal.terminalTarget === "failed" ? "failed" : "terminated";
        await this.storage.delete(ACTIVE_JOB_KEY);
      }
      return;
    }
    if (!job.createAttempted) {
      await this.startCurrent(job, client, config);
      return;
    }
    if (job.state === "recovering_create") {
      await this.recoverCreate(job, client, config);
      return;
    }
    if (!job.podId) throw new Error("POD_ID_MISSING");
    const pod = await client.getPod(job.podId);
    console.warn("[coordinator] poll", job.jobId, job.podId, pod ? pod.status : "ABSENT");
    if (pod) {
      job.internal.absentPolls = 0;
    }
    if (!pod) {
      // A single provider 404 can be an API hiccup; only consecutive absent
      // polls prove the Pod is gone (deletion is confirmed elsewhere).
      job.internal.absentPolls = (job.internal.absentPolls ?? 0) + 1;
      if (
        job.internal.absentPolls < 3 &&
        !(job.phase === "cache_repair" && job.cache.state === "ready")
      ) {
        return;
      }
      if (job.phase === "cache_repair" && job.cache.state === "ready") {
        await watchdogRequest(
          this.env,
          config,
          "DELETE",
          `/v1/leases/${encodeURIComponent(job.currentLeaseId)}`,
        ).catch(() => undefined);
        await this.finishCachePhase(job);
        return;
      }
      throw new Error("POD_DISAPPEARED");
    }
    if (pod.name !== job.podName) throw new Error("POD_IDENTITY_MISMATCH");
    if (ACTIVE_PROVIDER_STATES.has(pod.status)) {
      await this.upsertWatchdog(job, config);
      if (job.phase === "cache_repair" && job.cache.state === "ready") {
        if (await this.cleanupCurrent(job, client, config)) await this.finishCachePhase(job);
      } else if (job.phase === "gpu_worker") {
        job.state =
          job.internal.workerState === "ready" || job.internal.workerState === "busy"
            ? "ready"
            : pod.status === "RUNNING"
              ? "running"
              : "provisioning";
        if (
          job.internal.workerState === "ready" &&
          job.internal.workerObservedAt &&
          Date.now() - Date.parse(job.internal.workerObservedAt) >=
            job.internal.request.idleTimeoutSeconds * 1000
        ) {
          job.internal.terminalTarget = "terminated";
          job.state = "terminating";
        }
      }
      return;
    }
    if (TERMINAL_PROVIDER_STATES.has(pod.status)) {
      if (job.phase === "cache_repair" && job.cache.state === "ready") {
        if (await this.cleanupCurrent(job, client, config)) await this.finishCachePhase(job);
        return;
      }
      if (job.phase === "cache_repair") {
        job.internal.exitObservedAt ??= new Date().toISOString();
        if (Date.now() - Date.parse(job.internal.exitObservedAt) < EXIT_CALLBACK_GRACE_MS) return;
      }
      throw new Error(
        job.phase === "cache_repair" ? "CACHE_REPAIR_DID_NOT_ATTEST" : "GPU_WORKER_EXITED",
      );
    }
    throw new Error("UNSUPPORTED_PROVIDER_STATE");
  }

  async runAlarm() {
    const activeJobId = await this.storage.get(ACTIVE_JOB_KEY);
    if (typeof activeJobId !== "string") return;
    const job = await this.getJob(activeJobId);
    if (!job || TERMINAL_STATES.has(job.state)) {
      await this.storage.delete(ACTIVE_JOB_KEY);
      return;
    }
    try {
      const config = await configuration(this.env);
      await this.advance(job, config);
    } catch (error) {
      const waitingForBoundedRepairCapacity =
        error instanceof RunPodV2Error &&
        (error.code === "GPU_UNAVAILABLE" || error.code === "RUNPOD_TRANSPORT_ERROR") &&
        job.kind === "gpu_worker" &&
        (job.phase === "cache_repair" || job.phase === "gpu_worker") &&
        job.createAttempted === false &&
        !job.internal.terminalTarget &&
        Date.now() < Date.parse(job.currentDeadlineAt);
      if (waitingForBoundedRepairCapacity) {
        // Availability is transient. Keep this cloud-owned job cost-free and
        // retry on the normal alarm cadence; never widen the GPU, DC, or cap.
        job.state = "waiting_for_capacity";
        job.waitingReason = error.code;
        job.failureCode = undefined;
        job.internal.repairAllocation = null;
      } else {
        job.waitingReason = undefined;
        job.failureCode =
          error instanceof RunPodV2Error
            ? error.code
            : error instanceof Error
              ? error.message
              : "COORDINATOR_FAILURE";
        // Name the failing provider operation and HTTP status; the generic
        // code alone (for example RUNPOD_HTTP_ERROR) is undiagnosable.
        if (error instanceof RunPodV2HttpError) {
          job.failureDetail = [`${error.operation}:HTTP_${error.status}`];
        }
        job.internal.terminalTarget = "failed";
        job.state = "terminating";
      }
    }
    await this.putJob(job);
    if (!TERMINAL_STATES.has(job.state)) await this.schedule(POLL_MS);
  }

  alarm() {
    return this.exclusive(() => this.runAlarm());
  }
}

export default {
  fetch(request, env) {
    const id =
      typeof env.COORDINATOR.getByName === "function"
        ? env.COORDINATOR.getByName(PRIMARY_COORDINATOR)
        : env.COORDINATOR.get(env.COORDINATOR.idFromName(PRIMARY_COORDINATOR));
    return id.fetch(request);
  },
};
