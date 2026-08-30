#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const BASE_URL = "http://127.0.0.1:4317";
const ORIGIN = "tauri://localhost";
const RUNPOD_BASE_URL = "https://rest.runpod.io/v1";
const APP_BINARY = "/Applications/Glimmer Control Center.app/Contents/MacOS/glimmer-control-center";
const APP_BUNDLE = "/Applications/Glimmer Control Center.app";
const CONFIG_PATH = path.join(os.homedir(), ".muse-glimmer", "compute.json");
const RUNPOD_KEY_PATH = path.join(os.homedir(), ".muse-glimmer", "compute-keys", "runpod.key");
const CONFIRMATION = "CREATE_EXACTLY_ONE_CAPPED_RUNPOD_GPU_POD";
const A100_GPU_TYPES = new Set(["NVIDIA A100 80GB PCIe", "NVIDIA A100-SXM4-80GB"]);

// These are hard safety limits, not caller-tunable defaults.
const EXPECTED_CONTEXT = 65_536;
const MAX_HOURLY_USD = 1.75;
const MAX_ESTIMATED_GPU_USD = 0.35;
// Leave two minutes inside the cost envelope for provider-confirmed cleanup.
const MAX_PAID_RUNTIME_MS = 9 * 60 * 1_000;
const MAX_READY_WAIT_MS = 8 * 60 * 1_000;
const MAX_OVERALL_RUNTIME_MS = 18 * 60 * 1_000;
const MAX_PROVIDER_CLEANUP_MS = 2 * 60 * 1_000;
const MAX_BILLING_WAIT_MS = 60 * 1_000;
const MAX_TIMELINE_ENTRIES = 1_000;

const startedAt = new Date().toISOString();
const monotonicStartedAt = performance.now();
const capability = randomBytes(32).toString("hex");
const instanceId = randomBytes(16).toString("hex");
const podNamePrefix = `glimmer-${instanceId}-`;

let appChild = null;
let runpod = null;
let RunPodApiErrorClass = null;
let configSnapshot = null;
let configMode = null;
let recoveryPath = null;
let configRestored = false;
let startAttempted = false;
let startRequestCount = 0;
let paidStartedAtMs = null;
let paidStoppedAtMs = null;
let startAcceptedAt = null;
let capturedPodId = null;
let capturedPodName = null;
let observedHourlyUsd = null;
let authenticatedReady = false;
let cleanupComplete = false;
let localOfflineConfirmed = false;
let finalProviderPodCount = null;
let usageBefore = null;
let usageAfter = null;
let providerBilledUsd = null;
let providerBillingStatus = "not_applicable";
let shutdownRequested = false;
let paidDeadlineReached = false;
let singlePodInvariantViolated = false;
let failure = null;
const capturedPodIds = new Set();
const capturedPodNames = new Set();
const sensitiveValues = new Set([capability]);
const timeline = [];

function usage() {
  return [
    "Usage:",
    "  GLIMMER_RUNPOD_LIVE_SMOKE=CREATE_EXACTLY_ONE_CAPPED_RUNPOD_GPU_POD \\",
    "    npm run runpod:live-smoke -- --execute --image <oci@sha256:digest> \\",
    "    --build-id <worker-build-id> --template <compute-template.json> [--result <new-file>]",
    "",
    "This command is live and paid. It can create exactly one capped A100 Pod.",
    "Run --self-test for a local, resource-free harness check.",
  ].join("\n");
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--self-test") return { selfTest: true };
  const parsed = { execute: false, selfTest: false };
  const values = new Set(["--image", "--build-id", "--template", "--result"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      if (parsed.execute) throw new Error("--execute may only be supplied once");
      parsed.execute = true;
      continue;
    }
    if (!values.has(argument)) throw new Error(`unsupported argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    const key = argument.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (parsed[key] !== undefined) throw new Error(`${argument} may only be supplied once`);
    parsed[key] = value;
    index += 1;
  }
  if (!parsed.execute) throw new Error("--execute is required for a live smoke run");
  if (!parsed.image || !/^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/.test(parsed.image)) {
    throw new Error("--image must be an immutable sha256 OCI reference");
  }
  if (!parsed.buildId || !/^r2-[a-f0-9]{12}$/.test(parsed.buildId)) {
    throw new Error("--build-id must be an immutable R2 build id");
  }
  if (!parsed.template) throw new Error("--template is required");
  parsed.template = path.resolve(parsed.template);
  parsed.result = parsed.result
    ? path.resolve(parsed.result)
    : path.join("/private/tmp", `glimmer-runpod-live-smoke-${instanceId}.json`);
  if (process.env.GLIMMER_RUNPOD_LIVE_SMOKE !== CONFIRMATION) {
    throw new Error(`set GLIMMER_RUNPOD_LIVE_SMOKE=${CONFIRMATION} to authorize the paid start`);
  }
  return parsed;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sanitizeText(value, maximumLength = 4_096) {
  if (typeof value !== "string") return "";
  let sanitized = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive.length >= 8) sanitized = sanitized.replaceAll(sensitive, "[REDACTED_SECRET]");
  }
  return sanitized
    .replace(/\b(?:rpa|rps)_[A-Za-z0-9_-]+\b/gi, "[REDACTED_CREDENTIAL]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:api_?key|key|token|secret|authorization)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\/Users\/[^/\s]+/g, "/Users/[REDACTED]")
    .slice(0, maximumLength);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value, maximumLength = 256) {
  return typeof value === "string" ? sanitizeText(value, maximumLength) : null;
}

function sanitizeBootstrap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawArtifact =
    value.artifact && typeof value.artifact === "object" && !Array.isArray(value.artifact)
      ? value.artifact
      : null;
  const bootstrap = {
    stage: stringValue(value.stage, 64),
    outcome: stringValue(value.outcome, 32),
    stageStartedAt: stringValue(value.stageStartedAt, 64),
    updatedAt: stringValue(value.updatedAt, 64),
    artifact: rawArtifact
      ? {
          kind: stringValue(rawArtifact.kind, 64),
          phase: stringValue(rawArtifact.phase, 64),
          bytesCompleted: finiteNumber(rawArtifact.bytesCompleted),
          bytesTotal: finiteNumber(rawArtifact.bytesTotal),
        }
      : stringValue(value.artifact, 64),
    completedBytes: finiteNumber(value.completedBytes),
    totalBytes: finiteNumber(value.totalBytes),
    failureCode: stringValue(value.failureCode ?? value.errorCode, 96),
    exitCode: finiteNumber(value.exitCode),
  };
  return Object.fromEntries(Object.entries(bootstrap).filter(([, entry]) => entry !== null));
}

function sanitizeWorker(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const model = value.model && typeof value.model === "object" ? value.model : null;
  const bootstrap = sanitizeBootstrap(value.bootstrap);
  return {
    protocolVersion: finiteNumber(value.protocolVersion),
    buildId: stringValue(value.buildId, 96),
    ready: typeof value.ready === "boolean" ? value.ready : null,
    workerState: stringValue(value.workerState, 64),
    model: model
      ? {
          ready: typeof model.ready === "boolean" ? model.ready : null,
          contextTokens: finiteNumber(model.contextTokens),
        }
      : null,
    ...(bootstrap ? { bootstrap } : {}),
  };
}

function sanitizeLastDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    schemaVersion: finiteNumber(value.schemaVersion),
    leaseId: stringValue(value.leaseId, 191),
    podId: stringValue(value.podId, 191),
    podName: stringValue(value.podName, 191),
    observedAt: stringValue(value.observedAt, 64),
    outcome: stringValue(value.outcome, 64),
    worker: sanitizeWorker(value.worker),
  };
}

function sanitizeComputeStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { malformed: true };
  }
  const pod = value.pod && typeof value.pod === "object" ? value.pod : null;
  const worker = value.worker && typeof value.worker === "object" ? value.worker : null;
  const budget = value.budget && typeof value.budget === "object" ? value.budget : null;
  const sanitizedWorker = sanitizeWorker(worker);
  if (sanitizedWorker && !sanitizedWorker.bootstrap) {
    const topLevelBootstrap = sanitizeBootstrap(value.bootstrap);
    if (topLevelBootstrap) sanitizedWorker.bootstrap = topLevelBootstrap;
  }
  return {
    backend: stringValue(value.backend, 64),
    state: stringValue(value.state, 64),
    checkedAt: stringValue(value.checkedAt, 64),
    profileId: stringValue(value.profileId, 96),
    pod: pod
      ? {
          id: stringValue(pod.id, 191),
          name: stringValue(pod.name, 191),
          desiredStatus: stringValue(pod.desiredStatus, 32),
          gpuTypeId: stringValue(pod.gpuTypeId, 128),
          gpuCount: finiteNumber(pod.gpuCount),
          adjustedCostPerHr: finiteNumber(pod.adjustedCostPerHr),
          lastStartedAt: stringValue(pod.lastStartedAt, 64),
        }
      : null,
    idleDeadlineAt: stringValue(value.idleDeadlineAt, 64),
    hardDeadlineAt: stringValue(value.hardDeadlineAt, 64),
    detail: stringValue(value.detail, 4_096),
    budget: budget
      ? {
          allowed: typeof budget.allowed === "boolean" ? budget.allowed : null,
          hourlyCeilingUsd: finiteNumber(budget.hourlyCeilingUsd),
          currentHourlyUsd: finiteNumber(budget.currentHourlyUsd),
          estimatedTodayUsd: finiteNumber(budget.estimatedTodayUsd),
          estimatedMonthUsd: finiteNumber(budget.estimatedMonthUsd),
          reason: stringValue(budget.reason, 1_024),
        }
      : null,
    worker: sanitizedWorker,
    lastDiagnostic: sanitizeLastDiagnostic(value.lastDiagnostic),
  };
}

function sanitizeEventPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const sanitized = {};
  for (const [key, value] of Object.entries(payload)) {
    if (/token|secret|credential|capability|authorization|api.?key/i.test(key)) continue;
    if (typeof value === "string") sanitized[key] = sanitizeText(value, 1_024);
    else if (typeof value === "number" && Number.isFinite(value)) sanitized[key] = value;
    else if (typeof value === "boolean" || value === null) sanitized[key] = value;
  }
  return sanitized;
}

function addTimeline(event, payload = {}, print = true) {
  if (timeline.length >= MAX_TIMELINE_ENTRIES) {
    throw new Error("sanitized smoke timeline exceeded its safe entry limit");
  }
  const entry = {
    sequence: timeline.length + 1,
    event,
    at: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - monotonicStartedAt),
    ...sanitizeEventPayload(payload),
  };
  timeline.push(entry);
  if (print) process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function addStatus(status, phase) {
  const sanitized = sanitizeComputeStatus(status);
  const entry = {
    sequence: timeline.length + 1,
    event: "compute_status",
    at: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - monotonicStartedAt),
    phase,
    status: sanitized,
  };
  if (timeline.length >= MAX_TIMELINE_ENTRIES) {
    throw new Error("sanitized smoke timeline exceeded its safe entry limit");
  }
  timeline.push(entry);
  process.stdout.write(
    `${JSON.stringify({
      event: entry.event,
      at: entry.at,
      elapsedMs: entry.elapsedMs,
      phase,
      state: sanitized.state,
      podId: sanitized.pod?.id ?? null,
      workerState: sanitized.worker?.workerState ?? null,
      bootstrap: sanitized.worker?.bootstrap ?? null,
      detail: sanitized.detail,
    })}\n`,
  );
  return sanitized;
}

function safeError(error) {
  return sanitizeText(error instanceof Error ? error.message : String(error), 2_048);
}

function elapsedPaidMs() {
  return paidStartedAtMs === null
    ? 0
    : Math.max(0, (paidStoppedAtMs ?? performance.now()) - paidStartedAtMs);
}

function estimatedGpuUsd() {
  if (paidStartedAtMs === null) return 0;
  const rate = Math.max(observedHourlyUsd ?? 0, MAX_HOURLY_USD);
  return (elapsedPaidMs() / 3_600_000) * rate;
}

function assertRuntimeAndCostCaps() {
  const overall = performance.now() - monotonicStartedAt;
  if (overall > MAX_OVERALL_RUNTIME_MS) throw new Error("overall live-smoke deadline elapsed");
  if (paidStartedAtMs === null) return;
  if (elapsedPaidMs() > MAX_PAID_RUNTIME_MS) throw new Error("paid Pod runtime deadline elapsed");
  if (estimatedGpuUsd() > MAX_ESTIMATED_GPU_USD) {
    throw new Error("conservative estimated GPU cost cap was reached");
  }
}

async function readPrivateRegularFile(file, label) {
  const metadata = await fs.lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`${label} must be a regular file`);
  if ((metadata.mode & 0o077) !== 0)
    throw new Error(`${label} permissions must not grant group/other access`);
  return fs.readFile(file);
}

async function writePrivateExclusive(file, bytes) {
  const handle = await fs.open(
    file,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(file, 0o600);
}

async function writePrivateAtomic(file, bytes) {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writePrivateExclusive(temporary, bytes);
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
}

async function loadRunPodClient() {
  const module = await import("../server/dist/lib/compute/runpodClient.js");
  RunPodApiErrorClass = module.RunPodApiError;
  const keyBytes = await readPrivateRegularFile(RUNPOD_KEY_PATH, "RunPod API key file");
  const apiKey = keyBytes.toString("utf8").trim();
  keyBytes.fill(0);
  if (!apiKey) throw new Error("RunPod API key file is empty");
  sensitiveValues.add(apiKey);
  runpod = new module.RunPodClient({ baseUrl: RUNPOD_BASE_URL, apiKey });
}

function remainingOverallMs(maximumRequestMs) {
  const remaining = MAX_OVERALL_RUNTIME_MS - (performance.now() - monotonicStartedAt);
  if (remaining <= 0) throw new Error("overall live-smoke deadline elapsed");
  return Math.max(1, Math.min(maximumRequestMs, Math.floor(remaining)));
}

async function gatewayRequest(route, options = {}) {
  const method = options.method ?? "GET";
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    remainingOverallMs(options.timeoutMs ?? 30_000),
  );
  timeout.unref?.();
  const headers = new Headers({ Accept: "application/json" });
  if (method !== "GET" && method !== "HEAD") {
    headers.set("Origin", ORIGIN);
    headers.set("X-Glimmer-Capability", capability);
  }
  let body;
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }
  try {
    const response = await fetch(`${BASE_URL}${route}`, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: "error",
    });
    const responseText = await response.text();
    let payload = null;
    if (responseText.trim()) {
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new Error(`${method} ${route} returned invalid JSON`);
      }
    }
    if (!(options.allowedStatuses ?? [200]).includes(response.status)) {
      const detail =
        payload && typeof payload.error === "string"
          ? sanitizeText(payload.error)
          : "request failed";
      throw new Error(`${method} ${route} returned HTTP ${response.status}: ${detail}`);
    }
    return { status: response.status, body: payload };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForPortClosed(timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(750) });
    } catch {
      return true;
    }
    await delay(250);
  }
  return false;
}

function spawnControlledApp() {
  appChild = spawn(APP_BINARY, [], {
    cwd: path.dirname(APP_BINARY),
    env: {
      ...process.env,
      GLIMMER_INSTANCE_ID: instanceId,
      GLIMMER_CAPABILITY_TOKEN: capability,
    },
    stdio: "ignore",
  });
  appChild.once("error", (error) =>
    addTimeline("controlled_app_spawn_failed", { message: safeError(error) }),
  );
  addTimeline("controlled_app_started", { pid: appChild.pid });
}

async function waitForControlledGateway() {
  const deadline = performance.now() + 90_000;
  while (performance.now() < deadline) {
    assertRuntimeAndCostCaps();
    try {
      const response = await fetch(`${BASE_URL}/api/health`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(2_000),
      });
      const health = await response.json();
      if (response.ok && health.instanceId === instanceId) return;
      if (response.ok && health.instanceId !== instanceId) {
        throw new Error("gateway port is owned by a different Glimmer instance");
      }
    } catch (error) {
      if (safeError(error).includes("different Glimmer")) throw error;
    }
    await delay(500);
  }
  throw new Error("controlled Glimmer gateway did not become ready in time");
}

function computeUpdateFromTemplate(stored, expectedImage) {
  if (!stored || stored.version !== 1 || !Array.isArray(stored.profiles)) {
    throw new Error("compute template is not a version 1 configuration");
  }
  if (typeof stored.activeProfileId !== "string") throw new Error("template has no active profile");
  const profiles = stored.profiles.map((candidate) => {
    const profile = { ...candidate };
    delete profile.hasApiKey;
    delete profile.watchdogConfigured;
    if (profile.id !== stored.activeProfileId) return profile;
    if (
      profile.provider !== "runpod" ||
      profile.cloudType !== "SECURE" ||
      profile.performance !== "economy" ||
      profile.gpuCount !== 1 ||
      !Array.isArray(profile.gpuTypeIds) ||
      profile.gpuTypeIds.length === 0 ||
      profile.gpuTypeIds.some((gpu) => !A100_GPU_TYPES.has(gpu))
    ) {
      throw new Error("active template profile must be Secure Cloud with exactly one A100 GPU");
    }
    if (profile.contextTokens !== EXPECTED_CONTEXT) {
      throw new Error("active template profile must use 65536 context tokens");
    }
    return {
      ...profile,
      imageDigest: expectedImage,
      maxGpuHourlyUsd: Math.min(profile.maxGpuHourlyUsd, MAX_HOURLY_USD),
      idleTimeoutSeconds: Math.min(profile.idleTimeoutSeconds, MAX_PAID_RUNTIME_MS / 1_000),
      hardSessionLimitSeconds: MAX_PAID_RUNTIME_MS / 1_000,
    };
  });
  return {
    version: 1,
    enabled: true,
    defaultBackend: "runpod_pod",
    profiles,
    activeProfileId: stored.activeProfileId,
    watchdog: { endpointUrl: stored.watchdog?.endpointUrl },
  };
}

function assertPinnedConfig(config, expectedImage) {
  const profile = config?.profiles?.find((candidate) => candidate.id === config.activeProfileId);
  if (!config?.enabled || config.defaultBackend !== "runpod_pod" || !profile) {
    throw new Error("guarded RunPod configuration was not activated");
  }
  if (
    profile.imageDigest !== expectedImage ||
    profile.cloudType !== "SECURE" ||
    profile.performance !== "economy" ||
    profile.gpuCount !== 1 ||
    profile.contextTokens !== EXPECTED_CONTEXT ||
    !profile.gpuTypeIds?.length ||
    profile.gpuTypeIds.some((gpu) => !A100_GPU_TYPES.has(gpu))
  ) {
    throw new Error("saved profile does not preserve the immutable one-A100 contract");
  }
  if (
    !(profile.maxGpuHourlyUsd > 0) ||
    profile.maxGpuHourlyUsd > MAX_HOURLY_USD ||
    profile.hardSessionLimitSeconds > MAX_PAID_RUNTIME_MS / 1_000
  ) {
    throw new Error("saved profile exceeds the hard price or runtime cap");
  }
  if (!profile.hasApiKey || !profile.watchdogConfigured) {
    throw new Error("RunPod credential or independent watchdog is not configured");
  }
  return profile;
}

function rememberPod(pod) {
  if (!pod || typeof pod.id !== "string" || typeof pod.name !== "string") return false;
  if (!pod.name.startsWith(podNamePrefix)) return false;
  capturedPodIds.add(pod.id);
  capturedPodNames.add(pod.name);
  capturedPodId ??= pod.id;
  capturedPodName ??= pod.name;
  return true;
}

function rememberStatusPod(status) {
  if (!status?.pod) return;
  if (!rememberPod(status.pod)) {
    throw new Error("gateway status exposed a Pod outside this smoke run's exact name prefix");
  }
  if (capturedPodId && status.pod.id !== capturedPodId) {
    throw new Error("gateway status changed to a different Pod identity");
  }
}

function observePodPrice(pod) {
  const price = finiteNumber(pod?.adjustedCostPerHr);
  if (price === null) return;
  if (price > MAX_HOURLY_USD) throw new Error("observed Pod price exceeds the hard hourly cap");
  observedHourlyUsd = Math.max(observedHourlyUsd ?? 0, price);
}

async function assertReady(status, expectedBuildId) {
  if (status.state !== "ready") throw new Error(`unexpected ready state ${String(status.state)}`);
  rememberStatusPod(status);
  if (!status.pod || status.pod.id !== capturedPodId || status.pod.name !== capturedPodName) {
    throw new Error("ready status did not preserve the exact captured Pod identity");
  }
  if (
    status.pod.desiredStatus !== "RUNNING" ||
    status.pod.gpuCount !== 1 ||
    !A100_GPU_TYPES.has(status.pod.gpuTypeId)
  ) {
    throw new Error("ready status is not one RUNNING A100 GPU");
  }
  observePodPrice(status.pod);
  if (!status.worker?.ready || !status.worker.model?.ready) {
    throw new Error("authenticated worker/model readiness was not established");
  }
  if (
    status.worker.protocolVersion !== 2 ||
    status.worker.bootstrap?.stage !== "ready" ||
    status.worker.bootstrap?.outcome !== "ready"
  ) {
    throw new Error("worker did not prove the bounded bootstrap diagnostics protocol V2");
  }
  if (status.worker.buildId !== expectedBuildId)
    throw new Error("worker build identity is unexpected");
  if (status.worker.model.contextTokens !== EXPECTED_CONTEXT) {
    throw new Error("worker did not prove 65536 context tokens");
  }
  const providerPods = await runpod.listPods();
  if (
    providerPods.length !== 1 ||
    providerPods[0].id !== capturedPodId ||
    providerPods[0].name !== capturedPodName
  ) {
    throw new Error("provider did not show exactly the captured Pod at readiness");
  }
  observePodPrice(providerPods[0]);
}

async function stopControlledApp() {
  if (!appChild) return;
  if (appChild && appChild.exitCode === null && appChild.signalCode === null) {
    appChild.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise((resolve) => appChild.once("exit", () => resolve(true))),
      delay(12_000).then(() => false),
    ]);
    if (!exited) {
      appChild.kill("SIGKILL");
      await delay(1_000);
    }
  }
  if (!(await waitForPortClosed(20_000)))
    throw new Error("controlled Glimmer gateway did not stop");
}

async function restoreOriginalConfig() {
  if (!configSnapshot || configMode === null)
    throw new Error("original compute config snapshot is unavailable");
  await writePrivateAtomic(CONFIG_PATH, configSnapshot);
  await fs.chmod(CONFIG_PATH, configMode);
  const restored = await fs.readFile(CONFIG_PATH);
  const metadata = await fs.lstat(CONFIG_PATH);
  if (
    sha256(restored) !== sha256(configSnapshot) ||
    (metadata.mode & 0o777) !== configMode ||
    metadata.isSymbolicLink()
  ) {
    throw new Error("original compute config was not restored byte-for-byte");
  }
  configRestored = true;
  if (recoveryPath) {
    await fs.unlink(recoveryPath);
    recoveryPath = null;
  }
}

async function launchNormalAppAndVerifyOffline() {
  const child = spawn("/usr/bin/open", [APP_BUNDLE], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const deadline = performance.now() + 90_000;
  while (performance.now() < deadline) {
    try {
      const health = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (health.ok) {
        const [configResponse, statusResponse] = await Promise.all([
          fetch(`${BASE_URL}/api/compute/config`, { signal: AbortSignal.timeout(3_000) }),
          fetch(`${BASE_URL}/api/compute/status`, { signal: AbortSignal.timeout(3_000) }),
        ]);
        const config = await configResponse.json();
        const status = await statusResponse.json();
        addStatus(status, "restored_local_verification");
        if (
          config.enabled === false &&
          config.defaultBackend === "local_process" &&
          status.backend === "local_process" &&
          status.state === "offline" &&
          !status.pod
        ) {
          localOfflineConfirmed = true;
          return;
        }
      }
    } catch {
      // The normal app is still launching.
    }
    await delay(500);
  }
  throw new Error("restored Glimmer did not return to local offline compute");
}

async function discoverAttemptPods() {
  const pods = await runpod.listPods();
  const matches = pods.filter((pod) => pod.name.startsWith(podNamePrefix));
  for (const pod of matches) rememberPod(pod);
  if (matches.length > 1 || capturedPodIds.size > 1 || capturedPodNames.size > 1) {
    if (!singlePodInvariantViolated) {
      addTimeline("single_pod_invariant_violated", {
        matchingPodCount: matches.length,
        capturedPodIdCount: capturedPodIds.size,
      });
    }
    singlePodInvariantViolated = true;
  }
  return { pods, matches };
}

async function requestExactGatewayTermination(podId) {
  try {
    await gatewayRequest("/api/compute/pod", {
      method: "DELETE",
      body: { podId },
      allowedStatuses: [200],
      timeoutMs: 90_000,
    });
    addTimeline("gateway_exact_termination_completed", { podId });
  } catch (error) {
    addTimeline("gateway_exact_termination_failed", { podId, message: safeError(error) });
  }
}

async function deleteDirectExact(podId) {
  const existing = await runpod.getPod(podId);
  if (!existing) return;
  if (!rememberPod(existing))
    throw new Error("refusing to delete a Pod outside this run's exact name prefix");
  try {
    await runpod.deletePod(podId);
  } catch (error) {
    if (!(RunPodApiErrorClass && error instanceof RunPodApiErrorClass && error.status === 404))
      throw error;
  }
  addTimeline("provider_exact_delete_requested", { podId });
}

async function terminateCapturedPod() {
  if (!startAttempted && capturedPodIds.size === 0) {
    cleanupComplete = true;
    return;
  }
  try {
    const status = (await gatewayRequest("/api/compute/status", { timeoutMs: 10_000 })).body;
    addStatus(status, "cleanup_entry");
    if (status?.pod) rememberPod(status.pod);
  } catch (error) {
    addTimeline("cleanup_status_unavailable", { message: safeError(error) });
  }
  try {
    const initiallyDiscovered = await discoverAttemptPods();
    for (const pod of initiallyDiscovered.matches) rememberPod(pod);
  } catch (error) {
    addTimeline("initial_cleanup_discovery_failed", { message: safeError(error) });
  }

  if (capturedPodIds.size === 0 && startAttempted) {
    // This asks the gateway to reconcile its exact durable lease. It is not a second start.
    try {
      await gatewayRequest("/api/compute/stop", {
        method: "POST",
        allowedStatuses: [200, 409],
        timeoutMs: 90_000,
      });
      addTimeline("ambiguous_start_gateway_reconciliation_completed");
    } catch (error) {
      addTimeline("ambiguous_start_gateway_reconciliation_failed", { message: safeError(error) });
    }
    try {
      const discoveredAfterStop = await discoverAttemptPods();
      for (const pod of discoveredAfterStop.matches) rememberPod(pod);
    } catch (error) {
      addTimeline("post_stop_cleanup_discovery_failed", { message: safeError(error) });
    }
  }

  for (const podId of [...capturedPodIds]) await requestExactGatewayTermination(podId);
  const cleanupDeadline = performance.now() + MAX_PROVIDER_CLEANUP_MS;
  const deletionRequested = new Set();
  while (performance.now() < cleanupDeadline) {
    try {
      const { pods, matches } = await discoverAttemptPods();
      for (const pod of matches) rememberPod(pod);
      for (const podId of [...capturedPodIds]) {
        if (!deletionRequested.has(podId)) {
          await deleteDirectExact(podId);
          deletionRequested.add(podId);
        }
      }
      const exact = await Promise.all(
        [...capturedPodIds].map(async (podId) => ({ podId, pod: await runpod.getPod(podId) })),
      );
      for (const { pod } of exact) {
        if (pod && !rememberPod(pod)) {
          throw new Error("provider reused an exact Pod ID with another name");
        }
      }
      if (matches.length === 0 && exact.every(({ pod }) => pod === null)) {
        cleanupComplete = true;
        paidStoppedAtMs ??= performance.now();
        finalProviderPodCount = pods.length;
        if (pods.length !== 0) {
          addTimeline("provider_global_zero_check_failed", { visiblePodCount: pods.length });
        }
        break;
      }
    } catch (error) {
      addTimeline("provider_cleanup_attempt_failed", { message: safeError(error) });
    }
    await delay(2_000);
  }
  if (!cleanupComplete)
    throw new Error("exact Pod deletion did not converge before cleanup deadline");

  try {
    await gatewayRequest("/api/compute/stop", {
      method: "POST",
      allowedStatuses: [200, 409],
      timeoutMs: 60_000,
    });
  } catch (error) {
    addTimeline("local_finalization_retry_failed", { message: safeError(error) });
  }
  const finalStatus = (await gatewayRequest("/api/compute/status", { timeoutMs: 10_000 })).body;
  addStatus(finalStatus, "provider_cleanup_confirmed");
  if (finalStatus.state !== "offline" || finalStatus.pod) {
    throw new Error("controlled gateway is not offline after exact provider cleanup");
  }
}

async function reconcileBillingSequentially() {
  if (!capturedPodId || !startAcceptedAt) return;
  if (!cleanupComplete || finalProviderPodCount !== 0) {
    throw new Error("billing reconciliation cannot run before exact provider cleanup");
  }
  providerBillingStatus = "pending";
  const deadline = performance.now() + MAX_BILLING_WAIT_MS;
  do {
    const records = await runpod.getPodBilling({
      startTime: startAcceptedAt,
      podId: capturedPodId,
    });
    const matching = records.filter((record) => record.podId === capturedPodId);
    if (matching.length > 0) {
      providerBilledUsd = matching.reduce((sum, record) => sum + record.amount, 0);
      providerBillingStatus = "observed";
      break;
    }
    if (performance.now() < deadline) await delay(5_000);
  } while (performance.now() < deadline);
  usageAfter = (await gatewayRequest("/api/compute/usage/reconcile", { method: "POST" })).body;
  if (providerBilledUsd !== null && providerBilledUsd > MAX_ESTIMATED_GPU_USD) {
    throw new Error("observed provider charge exceeds the live-smoke cost cap");
  }
  if (
    usageBefore &&
    (usageAfter.estimatedTodayUsd < usageBefore.estimatedTodayUsd ||
      (usageAfter.reconciledTodayUsd ?? 0) < (usageBefore.reconciledTodayUsd ?? 0))
  ) {
    throw new Error("post-smoke usage counters regressed");
  }
  addTimeline("billing_reconciliation_completed", {
    status: providerBillingStatus,
    providerBilledUsd,
  });
}

async function captureOriginalConfig() {
  const metadata = await fs.lstat(CONFIG_PATH);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("compute config must be an existing regular file");
  }
  if ((metadata.mode & 0o077) !== 0) throw new Error("compute config permissions are too broad");
  configSnapshot = await fs.readFile(CONFIG_PATH);
  configMode = metadata.mode & 0o777;
  let stored;
  try {
    stored = JSON.parse(configSnapshot.toString("utf8"));
  } catch {
    throw new Error("existing compute config is not valid JSON");
  }
  if (stored.enabled !== false || stored.defaultBackend !== "local_process") {
    throw new Error("existing compute config must be disabled and local before live smoke");
  }
  recoveryPath = `${CONFIG_PATH}.live-smoke-${instanceId}.bak`;
  await writePrivateExclusive(recoveryPath, configSnapshot);
}

async function runLiveSmoke(options) {
  const templateBytes = await readPrivateRegularFile(options.template, "compute template");
  let template;
  try {
    template = JSON.parse(templateBytes.toString("utf8"));
  } catch {
    throw new Error("compute template is not valid JSON");
  }
  const update = computeUpdateFromTemplate(template, options.image);
  try {
    await fs.lstat(options.result);
    throw new Error("result path already exists; choose a new --result path");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!(await waitForPortClosed(1_000))) {
    throw new Error("port 4317 is occupied; quit Glimmer before the isolated live smoke run");
  }
  await fs.access(APP_BINARY, fsConstants.X_OK);
  await captureOriginalConfig();
  await loadRunPodClient();
  const initialPods = await runpod.listPods();
  if (initialPods.length !== 0) throw new Error("RunPod preflight requires zero visible Pods");
  addTimeline("provider_preflight_passed", {
    visiblePodCount: 0,
    image: options.image,
    buildId: options.buildId,
    maxHourlyUsd: MAX_HOURLY_USD,
    maxEstimatedGpuUsd: MAX_ESTIMATED_GPU_USD,
    maxPaidRuntimeSeconds: MAX_PAID_RUNTIME_MS / 1_000,
  });

  spawnControlledApp();
  await waitForControlledGateway();
  await gatewayRequest("/api/ready");
  const saved = await gatewayRequest("/api/compute/config", { method: "PUT", body: update });
  const profile = assertPinnedConfig(saved.body, options.image);
  addTimeline("immutable_capped_config_saved", {
    profileId: profile.id,
    contextTokens: profile.contextTokens,
    maxHourlyUsd: profile.maxGpuHourlyUsd,
    hardSessionLimitSeconds: profile.hardSessionLimitSeconds,
  });

  const credential = await gatewayRequest("/api/compute/test", { method: "POST" });
  if (!credential.body?.authenticated || credential.body.visiblePodCount !== 0) {
    throw new Error("credential preflight did not prove an empty RunPod account");
  }
  const watchdog = await gatewayRequest("/api/compute/watchdog/test", { method: "POST" });
  if (!watchdog.body?.ready || !watchdog.body.lastSweepAt) {
    throw new Error("independent watchdog preflight is not ready");
  }
  const beforeStatus = (await gatewayRequest("/api/compute/status")).body;
  addStatus(beforeStatus, "pre_start");
  if (beforeStatus.state !== "offline" || beforeStatus.pod) {
    throw new Error("local compute preflight is not offline");
  }
  usageBefore = (await gatewayRequest("/api/compute/usage/reconcile", { method: "POST" })).body;
  addTimeline("all_live_preflights_passed", {
    visiblePodCount: 0,
    watchdogReady: true,
    estimatedTodayUsd: usageBefore.estimatedTodayUsd,
    reconciledTodayUsd: usageBefore.reconciledTodayUsd ?? null,
  });

  if (shutdownRequested) throw new Error("shutdown was requested before the paid start");
  if (startRequestCount !== 0)
    throw new Error("single-start invariant was violated before allocation");
  startRequestCount += 1;
  startAttempted = true;
  startAcceptedAt = new Date().toISOString();
  paidStartedAtMs = performance.now();
  const start = await gatewayRequest("/api/compute/start", {
    method: "POST",
    allowedStatuses: [202],
    timeoutMs: 180_000,
  });
  if (startRequestCount !== 1) throw new Error("more than one start request was attempted");
  if (!start.body?.started || !start.body.status?.pod?.id || !start.body.status?.pod?.name) {
    throw new Error("single start did not return a concrete Pod identity");
  }
  if (!rememberPod(start.body.status.pod)) {
    throw new Error("started Pod name does not match this isolated smoke run");
  }
  observePodPrice(start.body.status.pod);
  addStatus(start.body.status, "start_accepted");
  addTimeline("single_pod_start_accepted", {
    podId: capturedPodId,
    podName: capturedPodName,
  });

  const paidTimer = setTimeout(() => {
    paidDeadlineReached = true;
    shutdownRequested = true;
  }, MAX_PAID_RUNTIME_MS);
  paidTimer.unref?.();
  try {
    const readyDeadline = performance.now() + MAX_READY_WAIT_MS;
    while (performance.now() < readyDeadline) {
      assertRuntimeAndCostCaps();
      if (shutdownRequested) {
        throw new Error(
          paidDeadlineReached
            ? "paid Pod runtime deadline requested immediate cleanup"
            : "shutdown was requested during worker bootstrap",
        );
      }
      const status = (await gatewayRequest("/api/compute/status", { timeoutMs: 20_000 })).body;
      rememberStatusPod(status);
      observePodPrice(status.pod);
      addStatus(status, "bootstrap");
      if (status.state === "ready") {
        await assertReady(status, options.buildId);
        authenticatedReady = true;
        addTimeline("authenticated_worker_ready", {
          podId: capturedPodId,
          buildId: options.buildId,
          contextTokens: EXPECTED_CONTEXT,
          conservativeEstimatedGpuUsd: estimatedGpuUsd(),
        });
        return;
      }
      if (
        ["failed", "budget_blocked", "offline", "stopped", "terminating"].includes(status.state)
      ) {
        throw new Error(`compute entered terminal state ${String(status.state)} before readiness`);
      }
      await delay(5_000);
    }
    throw new Error("worker did not prove readiness before the bounded readiness deadline");
  } finally {
    clearTimeout(paidTimer);
  }
}

async function finalize(options) {
  try {
    await terminateCapturedPod();
  } catch (error) {
    const message = safeError(error);
    failure = failure ? `${failure}; cleanup: ${message}` : `cleanup: ${message}`;
    addTimeline("cleanup_failed", { message });
  }
  if (estimatedGpuUsd() > MAX_ESTIMATED_GPU_USD) {
    const message = "conservative estimated GPU cost exceeded the smoke-test cap";
    failure = failure ? `${failure}; ${message}` : message;
  }
  // Billing is deliberately sequential and starts only after provider-zero cleanup.
  if (cleanupComplete && finalProviderPodCount === 0) {
    try {
      await reconcileBillingSequentially();
    } catch (error) {
      const message = safeError(error);
      failure = failure ? `${failure}; billing: ${message}` : `billing: ${message}`;
      addTimeline("billing_reconciliation_failed", { message });
    }
  }
  try {
    await stopControlledApp();
  } catch (error) {
    const message = safeError(error);
    failure = failure ? `${failure}; app stop: ${message}` : `app stop: ${message}`;
  }
  try {
    if (configSnapshot) await restoreOriginalConfig();
    if (appChild) await launchNormalAppAndVerifyOffline();
  } catch (error) {
    const message = safeError(error);
    failure = failure ? `${failure}; restore: ${message}` : `restore: ${message}`;
  }
  if (runpod) {
    try {
      const pods = await runpod.listPods();
      finalProviderPodCount = pods.length;
      if (pods.length !== 0) {
        const message = `provider still lists ${pods.length} Pod(s)`;
        failure = failure ? `${failure}; ${message}` : message;
      }
      for (const podId of capturedPodIds) {
        if ((await runpod.getPod(podId)) !== null) {
          const message = `exact Pod ${podId} is still provider-visible`;
          failure = failure ? `${failure}; ${message}` : message;
        }
      }
    } catch (error) {
      const message = safeError(error);
      failure = failure
        ? `${failure}; final provider check: ${message}`
        : `final provider check: ${message}`;
    }
  }

  const result = {
    schemaVersion: 1,
    success:
      authenticatedReady &&
      startRequestCount === 1 &&
      capturedPodIds.size === 1 &&
      !singlePodInvariantViolated &&
      cleanupComplete &&
      configRestored &&
      localOfflineConfirmed &&
      finalProviderPodCount === 0 &&
      estimatedGpuUsd() <= MAX_ESTIMATED_GPU_USD &&
      !failure,
    startedAt,
    finishedAt: new Date().toISOString(),
    immutableImage: options.image,
    expectedBuildId: options.buildId,
    expectedContextTokens: EXPECTED_CONTEXT,
    safetyCaps: {
      maxGpuCount: 1,
      gpuFamily: "A100 80GB",
      maxHourlyUsd: MAX_HOURLY_USD,
      maxEstimatedGpuUsd: MAX_ESTIMATED_GPU_USD,
      maxPaidRuntimeSeconds: MAX_PAID_RUNTIME_MS / 1_000,
      mainOperationDeadlineSeconds: MAX_OVERALL_RUNTIME_MS / 1_000,
    },
    startRequestCount,
    podId: capturedPodId,
    podName: capturedPodName,
    authenticatedReady,
    observedHourlyUsd,
    conservativeEstimatedGpuUsd: estimatedGpuUsd(),
    cleanupComplete,
    singlePodInvariantViolated,
    exactCapturedPodCount: capturedPodIds.size,
    finalProviderPodCount,
    configRestored,
    localOfflineConfirmed,
    billing: {
      status: providerBillingStatus,
      providerBilledUsd,
      estimatedTodayUsdBefore: usageBefore?.estimatedTodayUsd ?? null,
      estimatedTodayUsdAfter: usageAfter?.estimatedTodayUsd ?? null,
      reconciledTodayUsdAfter: usageAfter?.reconciledTodayUsd ?? null,
    },
    failure,
    timeline,
  };
  const resultBytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`, "utf8");
  try {
    await writePrivateExclusive(options.result, resultBytes);
    addTimeline("result_saved", { path: options.result, success: result.success });
  } catch (error) {
    process.stderr.write(`could not save smoke result: ${safeError(error)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      event: "final_result",
      success: result.success,
      resultPath: sanitizeText(options.result),
      podId: capturedPodId,
      cleanupComplete,
      finalProviderPodCount,
      localOfflineConfirmed,
      billingStatus: providerBillingStatus,
      failure,
    })}\n`,
  );
  if (!result.success) process.exitCode = 1;
}

function runSelfTest() {
  const secret = "rpa_TESTSHOULDNOTSURVIVE123456";
  const sanitized = sanitizeComputeStatus({
    state: "bootstrapping",
    detail: `Authorization: Bearer abcdefghijklmnop ${secret}`,
    worker: {
      protocolVersion: 2,
      buildId: "build-1",
      ready: false,
      workerState: "bootstrapping",
      model: { ready: false, contextTokens: EXPECTED_CONTEXT },
      bootstrap: {
        stage: "artifact_downloading",
        outcome: "in_progress",
        stageStartedAt: "2026-08-30T12:00:00.000Z",
        updatedAt: "2026-08-30T12:00:01.000Z",
        artifact: {
          kind: "model",
          phase: "downloading",
          bytesCompleted: 1,
          bytesTotal: 2,
        },
        ignoredRawText: secret,
      },
    },
  });
  if (JSON.stringify(sanitized).includes(secret))
    throw new Error("self-test detected a credential leak");
  if (sanitized.worker?.bootstrap?.stage !== "artifact_downloading") {
    throw new Error("self-test did not preserve bounded bootstrap evidence");
  }
  if (
    sanitized.worker.bootstrap.artifact?.kind !== "model" ||
    sanitized.worker.bootstrap.artifact?.bytesCompleted !== 1 ||
    sanitized.worker.bootstrap.artifact?.bytesTotal !== 2
  ) {
    throw new Error("self-test did not preserve bounded artifact progress");
  }
  let rejected = false;
  try {
    computeUpdateFromTemplate(
      {
        version: 1,
        activeProfileId: "unsafe",
        profiles: [
          {
            id: "unsafe",
            provider: "runpod",
            cloudType: "SECURE",
            performance: "latency",
            gpuCount: 2,
            gpuTypeIds: ["NVIDIA H100 PCIe"],
            contextTokens: EXPECTED_CONTEXT,
          },
        ],
      },
      `example.invalid/worker@sha256:${"a".repeat(64)}`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("self-test accepted an unsafe GPU profile");
  process.stdout.write(
    "runpod live-smoke harness self-test passed (no network or resource access)\n",
  );
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!shutdownRequested) addTimeline("shutdown_requested", { signal });
    shutdownRequested = true;
  });
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
  } else {
    try {
      await runLiveSmoke(options);
    } catch (error) {
      failure = safeError(error);
      addTimeline("smoke_failed", { message: failure });
    } finally {
      await finalize(options);
    }
  }
} catch (error) {
  process.stderr.write(`${safeError(error)}\n\n${usage()}\n`);
  process.exitCode = 2;
}
