import {
  RunPodV2Client,
  RunPodV2Error,
  buildCpuCachePodRequest,
  buildGpuWorkerPodRequest,
  selectRunPodV2CpuOffer,
} from "./runpod-v2.js";

const PRIMARY_COORDINATOR = "primary";
const ACTIVE_JOB_KEY = "active-job";
const JOB_PREFIX = "job:";
const CACHE_PREFIX = "cache:";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_WATCHDOG_RESPONSE_BYTES = 16 * 1024;
const AUTH_WINDOW_MS = 120_000;
const POLL_MS = 30_000;
const CREATE_RECOVERY_MS = 5 * 60_000;
const EXIT_CALLBACK_GRACE_MS = 2 * 60_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BUILD_ID = /^r2-[a-f0-9]{12}$/;
const IMAGE = /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43,512}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const PRIVATE_KEY = /^[A-Za-z0-9_-]{64,512}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TERMINAL_STATES = new Set(["terminated", "failed"]);
const ACTIVE_PROVIDER_STATES = new Set(["CREATED", "PROVISIONING", "STARTING", "RUNNING"]);
const TERMINAL_PROVIDER_STATES = new Set(["STOPPED", "EXITED", "ERROR", "TERMINATED"]);

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
  return {
    runpodBaseUrl:
      strictOrigin(
        env.RUNPOD_API_BASE_URL ?? "https://api.runpod.io",
        "INVALID_COORDINATOR_CONFIG",
      ) + "/v2",
    watchdogUrl: strictOrigin(env.WATCHDOG_URL, "INVALID_COORDINATOR_CONFIG"),
    publicUrl: strictOrigin(env.COORDINATOR_PUBLIC_URL, "INVALID_COORDINATOR_CONFIG"),
    cacheKeyId: bytesToHex(await sha256Bytes(publicBytes)),
    cpuMaxHourlyUsd: numberSetting(
      env.CPU_CACHE_MAX_HOURLY_USD,
      0.0225,
      0.001,
      1,
      "INVALID_COORDINATOR_CONFIG",
    ),
    cpuTtlSeconds: numberSetting(
      env.CPU_CACHE_TTL_SECONDS,
      2700,
      300,
      7200,
      "INVALID_COORDINATOR_CONFIG",
    ),
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
  if (!exactKeys(value, required, ["gpuTypeId", "bootstrapToken", "idleTimeoutSeconds"]))
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
  } else if (value.gpuTypeId !== undefined || value.bootstrapToken !== undefined) {
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
    ...(value.bootstrapToken ? { bootstrapToken: value.bootstrapToken } : {}),
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
    ...(job.lastHeartbeatAt ? { lastHeartbeatAt: job.lastHeartbeatAt } : {}),
    maxHourlyUsd: job.maxHourlyUsd,
    cache: { ...job.cache },
    createAttempted: job.createAttempted,
    cleanup: { ...job.cleanup },
    ...(job.repairJobId ? { repairJobId: job.repairJobId } : {}),
    ...(job.failureCode ? { failureCode: job.failureCode } : {}),
  };
}

function randomToken() {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

function runpodClient(env, config) {
  return new RunPodV2Client({ apiKey: env.RUNPOD_API_KEY, baseUrl: config.runpodBaseUrl });
}

async function watchdogRequest(env, config, method, path, body = "") {
  const timestamp = String(Date.now());
  const signature = await hmacHex(
    env.WATCHDOG_INGEST_TOKEN,
    `${method}\n${path}\n${timestamp}\n${body}`,
  );
  const result = await fetch(`${config.watchdogUrl}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      "X-Glimmer-Timestamp": timestamp,
      "X-Glimmer-Signature": `v1=${signature}`,
    },
    ...(body ? { body } : {}),
    redirect: "error",
  });
  if (!result.ok) throw new Error(`WATCHDOG_HTTP_${result.status}`);
  return result.status === 204
    ? null
    : readBoundedJsonResponse(result, MAX_WATCHDOG_RESPONSE_BYTES);
}

function watchdogLease(job, now) {
  const cpu = job.phase === "cache_repair";
  return {
    schemaVersion: 2,
    leaseId: job.currentLeaseId,
    ownerInstanceId: "glimmer-cloud-coordinator",
    jobKind: cpu ? "cpu_cache" : "gpu_worker",
    podName: job.podName,
    ...(job.podId ? { podId: job.podId } : {}),
    hardDeadlineAt: job.currentDeadlineAt,
    lastHeartbeatAt: now,
    maxHourlyUsd: cpu ? job.internal.cpuMaxHourlyUsd : job.maxHourlyUsd,
    expected: {
      cloud: "SECURE",
      gpuCount: cpu ? 0 : 1,
      networkVolumeId: job.internal.request.networkVolumeId,
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
    } catch {
      watchdogReady = false;
    }
    const activeJobId = (await this.storage.get(ACTIVE_JOB_KEY)) ?? null;
    return {
      service: "glimmer-compute-coordinator",
      schemaVersion: 1,
      ready: watchdogReady,
      checkedAt: new Date().toISOString(),
      providerApiVersion: "v2",
      watchdogReady,
      activeJobId,
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
              Math.min(Date.parse(request.hardDeadlineAt), nowMs + config.cpuTtlSeconds * 1000),
            ).toISOString()
          : request.hardDeadlineAt,
      internal: {
        request,
        ...(encryptedBootstrap ? { encryptedBootstrap } : {}),
        cpuMaxHourlyUsd:
          request.kind === "cpu_cache" ? request.maxHourlyUsd : config.cpuMaxHourlyUsd,
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
      } catch {
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
      } catch {
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
    job.cleanup.requested = true;
    if (!job.podId) {
      const matches = (await client.listPods()).filter((pod) => pod.name === job.podName);
      if (matches.length > 1) throw new Error("DUPLICATE_CREATE_OUTCOME");
      if (matches.length === 1) {
        job.podId = matches[0].id;
        await client.deletePod(job.podId).catch(() => undefined);
        if (await client.getPod(job.podId).catch(() => ({ present: true }))) return false;
      }
    } else {
      await client.deletePod(job.podId).catch(() => undefined);
      if (await client.getPod(job.podId).catch(() => ({ present: true }))) return false;
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
      const offer = selectRunPodV2CpuOffer(await client.listCpuTypes(), {
        dataCenterId: volume.dataCenterId,
        maxHourlyUsd: job.internal.cpuMaxHourlyUsd,
      });
      createRequest = buildCpuCachePodRequest({
        podName: job.podName,
        image: request.image,
        registryId: request.containerRegistryAuthId,
        networkVolumeId: request.networkVolumeId,
        dataCenterId: volume.dataCenterId,
        cpuId: offer.id,
        environment: {
          ...commonEnvironment,
          GLIMMER_PREWARM_ONLY: "1",
          GLIMMER_MODEL_URL: request.modelArtifacts.model.url,
          GLIMMER_MMPROJ_URL: request.modelArtifacts.mmproj.url,
          GLIMMER_DFLASH_URL: request.modelArtifacts.draftModel.url,
          GLIMMER_ARTIFACT_HOSTS: request.modelArtifacts.allowedHosts.join(","),
          GLIMMER_CACHE_SIGNING_PUBLIC_KEY: this.env.CACHE_SIGNING_PUBLIC_KEY,
          GLIMMER_PREWARM_EXPECTED_BUILD_ID: request.buildId,
        },
      });
    } else {
      if (job.cache.state !== "ready") throw new Error("CACHE_NOT_READY");
      const bootstrapToken = await decryptToken(
        job.internal.encryptedBootstrap,
        this.env,
        job.jobId,
      );
      createRequest = buildGpuWorkerPodRequest({
        podName: job.podName,
        image: request.image,
        registryId: request.containerRegistryAuthId,
        networkVolumeId: request.networkVolumeId,
        dataCenterId: volume.dataCenterId,
        gpuTypeId: request.gpuTypeId,
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
    job.state = "watchdog_registered";
    job.createAttempted = true;
    job.internal.createIntentAt = new Date().toISOString();
    job.internal.callbackTokenHash = callbackTokenHash;
    await this.putJob(job);
    try {
      const pod = await client.createPod(createRequest, {
        maxHourlyUsd:
          job.phase === "cache_repair" ? job.internal.cpuMaxHourlyUsd : job.maxHourlyUsd,
      });
      job.podId = pod.id;
      job.state = pod.status === "RUNNING" ? "running" : "provisioning";
      await this.upsertWatchdog(job, config);
    } catch (error) {
      if (error?.ambiguousCreate) {
        job.state = "recovering_create";
      } else {
        throw error;
      }
    }
  }

  async recoverCreate(job, client, config) {
    const matches = (await client.listPods()).filter((pod) => pod.name === job.podName);
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
      throw new Error("CREATE_OUTCOME_UNRESOLVED");
    }
  }

  async transitionToGpu(job) {
    job.phase = "gpu_worker";
    job.currentLeaseId = job.jobId;
    job.currentDeadlineAt = job.hardDeadlineAt;
    job.podName = `glimmer-gpu-${job.jobId}`;
    job.podId = undefined;
    job.createAttempted = false;
    job.cleanup = { requested: false, confirmed: false };
    job.internal.createIntentAt = null;
    job.internal.callbackTokenHash = null;
    job.internal.exitObservedAt = null;
    job.internal.workerObservedAt = null;
    job.internal.repairRequested = false;
    job.state = "cache_ready";
  }

  async transitionToRepair(job, config) {
    const repairJobId = crypto.randomUUID();
    job.repairJobId = repairJobId;
    job.phase = "cache_repair";
    job.currentLeaseId = repairJobId;
    job.currentDeadlineAt = new Date(
      Math.min(Date.parse(job.hardDeadlineAt), Date.now() + config.cpuTtlSeconds * 1000),
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
    job.internal.repairRequested = false;
    job.internal.cacheRepairAttempts += 1;
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
    if (!pod) {
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
      job.failureCode =
        error instanceof RunPodV2Error
          ? error.code
          : error instanceof Error
            ? error.message
            : "COORDINATOR_FAILURE";
      job.internal.terminalTarget = "failed";
      job.state = "terminating";
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
