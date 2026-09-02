#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const RUNPOD_ORIGIN = "https://api.runpod.io";
const CONFIRMATION = "CREATE_EXACTLY_ONE_CAPPED_RUNPOD_CPU_POD";
const RESULT_FILE = "runpod-cpu-prewarm-result.json";
const LOCK_FILE = ".runpod-cpu-prewarm.lock";
const VCPU_COUNT = 2;
const CONTAINER_DISK_GB = 20;
const VOLUME_MOUNT_PATH = "/workspace";

const MIN_HARD_DEADLINE_SECONDS = 60;
const MAX_HARD_DEADLINE_SECONDS = 3_600;
const MAX_CPU_HOURLY_USD = 1;
const MAX_AUTHORIZED_RUN_USD = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const CREATE_REQUEST_TIMEOUT_MS = 60_000;
const LOG_REQUEST_TIMEOUT_MS = 20_000;
const CLEANUP_DEADLINE_MS = 150_000;
const RECOVERY_STABLE_EMPTY_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;
const POD_POLL_INTERVAL_MS = 5_000;
const POD_POLL_TRANSPORT_RETRY_DELAY_MS = 250;
const POD_POLL_MAX_CONSECUTIVE_TRANSPORT_FAILURES = 3;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PROBLEM_BYTES = 16 * 1024;
const MAX_PROBLEM_TITLE_LENGTH = 256;
const MAX_PROBLEM_DETAIL_LENGTH = 2_048;
const MAX_PROBLEM_ERRORS = 16;
const MAX_PROBLEM_ERROR_LENGTH = 512;
const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_KEY_BYTES = 16 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_TIMELINE_ENTRIES = 256;
const MAX_RESULT_BYTES = 512 * 1024;
const MAX_PODS = 1_000;
const MAX_CPUS = 256;

const IMAGE_PATTERN = /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/;
const BUILD_ID_PATTERN = /^r2-[a-f0-9]{12}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,191}$/;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REGISTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/;
const DATA_CENTER_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,31}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ACTIVE_STATUSES = new Set(["PROVISIONING", "STARTING", "RUNNING"]);
const POD_STATUSES = new Set([...ACTIVE_STATUSES, "EXITED", "ERROR", "TERMINATED"]);
const AVAILABLE = new Set(["LOW", "MEDIUM", "HIGH"]);
const AVAILABILITY_RANK = Object.freeze({ HIGH: 0, MEDIUM: 1, LOW: 2 });

export class PrewarmError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "PrewarmError";
    this.code = code;
  }
}

export class ProviderHttpError extends PrewarmError {
  constructor(operation, status, providerProblem = null) {
    super("provider_http_error", `${operation} returned HTTP ${status}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.providerProblem = providerProblem;
  }
}

export class ProviderTransportError extends PrewarmError {
  constructor(operation, ambiguous = false) {
    super("provider_transport_error", `${operation} did not return a usable response`);
    this.name = "ProviderTransportError";
    this.ambiguous = ambiguous;
  }
}

function fail(code, message) {
  throw new PrewarmError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_schema", `${label} must be an object`);
  }
  return value;
}

function text(value, label, maximum = 1_024) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    fail("invalid_schema", `${label} must be a bounded string`);
  }
  return value;
}

function finiteNumber(value, label, minimum = 0) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    fail("invalid_schema", `${label} must be a finite number`);
  }
  return value;
}

function integer(value, label, minimum = 0) {
  const parsed = finiteNumber(value, label, minimum);
  if (!Number.isInteger(parsed)) fail("invalid_schema", `${label} must be an integer`);
  return parsed;
}

function exactStringMap(value, label) {
  const raw = object(value, label);
  const result = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry !== "string") fail("invalid_schema", `${label} values must be strings`);
    result[key] = entry;
  }
  return result;
}

function redactProviderText(value, maximum, sensitiveValues) {
  let sanitized = value;
  const secrets = [
    ...new Set(sensitiveValues.filter((entry) => typeof entry === "string" && entry)),
  ].sort((left, right) => right.length - left.length);
  for (const secret of secrets) sanitized = sanitized.split(secret).join("[REDACTED_CREDENTIAL]");
  return redactText(sanitized, maximum);
}

export function parseProviderProblemDetails(value, expectedStatus, sensitiveValues = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowedKeys = new Set(["title", "status", "detail", "errors"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
  if (
    typeof value.title !== "string" ||
    value.title.length < 1 ||
    value.title.length > MAX_PROBLEM_TITLE_LENGTH ||
    !Number.isInteger(value.status) ||
    value.status !== expectedStatus ||
    typeof value.detail !== "string" ||
    value.detail.length < 1 ||
    value.detail.length > MAX_PROBLEM_DETAIL_LENGTH
  ) {
    return null;
  }
  if (
    value.errors !== undefined &&
    (!Array.isArray(value.errors) ||
      value.errors.length > MAX_PROBLEM_ERRORS ||
      value.errors.some(
        (entry) =>
          typeof entry !== "string" || entry.length < 1 || entry.length > MAX_PROBLEM_ERROR_LENGTH,
      ))
  ) {
    return null;
  }
  return {
    title: redactProviderText(value.title, MAX_PROBLEM_TITLE_LENGTH, sensitiveValues),
    detail: redactProviderText(value.detail, MAX_PROBLEM_DETAIL_LENGTH, sensitiveValues),
    errors: (value.errors ?? []).map((entry) =>
      redactProviderText(entry, MAX_PROBLEM_ERROR_LENGTH, sensitiveValues),
    ),
  };
}

export function usage() {
  return [
    "Usage:",
    "  GLIMMER_RUNPOD_CPU_PREWARM=CREATE_EXACTLY_ONE_CAPPED_RUNPOD_CPU_POD \\",
    "    node scripts/runpod-cpu-prewarm.mjs --execute \\",
    "    --image <registry/repository@sha256:digest> --build-id <r2-12hex> \\",
    "    --max-hourly-usd <ceiling> --hard-deadline-seconds <60..3600>",
    "  node scripts/runpod-cpu-prewarm.mjs --preflight \\",
    "    --image <registry/repository@sha256:digest> --build-id <r2-12hex> \\",
    "    --max-hourly-usd <ceiling> --hard-deadline-seconds <60..3600>",
    "",
    "The command reads only the fixed compute configuration and RunPod key under the state root.",
    "--preflight performs authenticated GETs only; it never sends POST or DELETE.",
    "--execute can create at most one Secure Cloud CPU Pod and always performs exact-id cleanup.",
    "",
    "Canary mode (add to either mode):",
    "  --canary-artifact-url <https URL on an allowlisted artifact host> \\",
    "  --canary-artifact-sha256 <64 hex>",
    "Runs the identical lifecycle with one tiny checksum-bound artifact substituted",
    "for all three model artifacts, so nothing multi-GB is downloaded.",
  ].join("\n");
}

export function parseArguments(argv, environment = process.env) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { help: true };
  }
  const parsed = { execute: false, preflight: false, help: false };
  const valueArguments = new Set([
    "--image",
    "--build-id",
    "--max-hourly-usd",
    "--hard-deadline-seconds",
    "--canary-artifact-url",
    "--canary-artifact-sha256",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      if (parsed.execute) fail("invalid_arguments", "--execute may only be supplied once");
      parsed.execute = true;
      continue;
    }
    if (argument === "--preflight") {
      if (parsed.preflight) fail("invalid_arguments", "--preflight may only be supplied once");
      parsed.preflight = true;
      continue;
    }
    if (!valueArguments.has(argument)) {
      fail("invalid_arguments", "an unsupported argument was supplied");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("invalid_arguments", `${argument} requires a value`);
    }
    const key = argument.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (parsed[key] !== undefined)
      fail("invalid_arguments", `${argument} may only be supplied once`);
    parsed[key] = value;
    index += 1;
  }
  if (parsed.execute === parsed.preflight) {
    fail("invalid_mode", "exactly one of --execute or --preflight is required");
  }
  if (!IMAGE_PATTERN.test(parsed.image ?? "")) {
    fail("invalid_image", "--image must be an immutable sha256 OCI reference");
  }
  if (!BUILD_ID_PATTERN.test(parsed.buildId ?? "")) {
    fail("invalid_build_id", "--build-id must match r2- followed by 12 lowercase hex characters");
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(parsed.maxHourlyUsd ?? "")) {
    fail("invalid_ceiling", "--max-hourly-usd must be an explicit decimal value");
  }
  const maxHourlyUsd = Number(parsed.maxHourlyUsd);
  if (maxHourlyUsd <= 0 || maxHourlyUsd > MAX_CPU_HOURLY_USD) {
    fail(
      "invalid_ceiling",
      `--max-hourly-usd must be greater than 0 and at most ${MAX_CPU_HOURLY_USD}`,
    );
  }
  if (!/^\d+$/.test(parsed.hardDeadlineSeconds ?? "")) {
    fail("invalid_deadline", "--hard-deadline-seconds must be an integer");
  }
  const hardDeadlineSeconds = Number(parsed.hardDeadlineSeconds);
  if (
    hardDeadlineSeconds < MIN_HARD_DEADLINE_SECONDS ||
    hardDeadlineSeconds > MAX_HARD_DEADLINE_SECONDS
  ) {
    fail(
      "invalid_deadline",
      `--hard-deadline-seconds must be between ${MIN_HARD_DEADLINE_SECONDS} and ${MAX_HARD_DEADLINE_SECONDS}`,
    );
  }
  if (
    (maxHourlyUsd * (hardDeadlineSeconds + CLEANUP_DEADLINE_MS / 1_000)) / 3_600 >
    MAX_AUTHORIZED_RUN_USD
  ) {
    fail("invalid_cost_cap", "the requested ceiling and deadline exceed the hard maximum cost");
  }
  if (parsed.execute && environment.GLIMMER_RUNPOD_CPU_PREWARM !== CONFIRMATION) {
    fail("authorization_required", "the exact paid-run confirmation environment value is required");
  }
  const canarySupplied =
    parsed.canaryArtifactUrl !== undefined || parsed.canaryArtifactSha256 !== undefined;
  if (canarySupplied) {
    if (parsed.canaryArtifactUrl === undefined || parsed.canaryArtifactSha256 === undefined) {
      fail(
        "invalid_canary",
        "--canary-artifact-url and --canary-artifact-sha256 must be supplied together",
      );
    }
    let canaryUrl;
    try {
      canaryUrl = new URL(parsed.canaryArtifactUrl);
    } catch {
      fail("invalid_canary", "--canary-artifact-url must be an absolute URL");
    }
    if (canaryUrl.protocol !== "https:" || canaryUrl.username || canaryUrl.password) {
      fail("invalid_canary", "--canary-artifact-url must be a plain HTTPS URL");
    }
    if (!SHA256_PATTERN.test(parsed.canaryArtifactSha256)) {
      fail("invalid_canary", "--canary-artifact-sha256 must be 64 lowercase hex characters");
    }
  }
  return {
    canary: canarySupplied
      ? { url: parsed.canaryArtifactUrl, sha256: parsed.canaryArtifactSha256 }
      : null,
    mode: parsed.execute ? "execute" : "preflight",
    execute: parsed.execute,
    preflight: parsed.preflight,
    help: false,
    image: parsed.image,
    buildId: parsed.buildId,
    maxHourlyUsd,
    hardDeadlineSeconds,
  };
}

export function resolveStatePaths(environment = process.env, homeDirectory = os.homedir()) {
  const configuredRoot =
    environment.GLIMMER_STATE_ROOT ?? path.join(homeDirectory, ".muse-glimmer");
  if (!path.isAbsolute(configuredRoot)) {
    fail("invalid_state_root", "GLIMMER_STATE_ROOT must be absolute when set");
  }
  const stateRoot = path.normalize(configuredRoot);
  return {
    stateRoot,
    configPath: path.join(stateRoot, "compute.json"),
    keyDirectory: path.join(stateRoot, "compute-keys"),
    keyPath: path.join(stateRoot, "compute-keys", "runpod.key"),
    resultPath: path.join(stateRoot, RESULT_FILE),
    lockPath: path.join(stateRoot, LOCK_FILE),
  };
}

function normalizeArtifact(value, label, allowedHosts) {
  const raw = object(value, `${label} artifact`);
  const url = text(raw.url, `${label} artifact URL`, 4_096);
  const sha256 = text(raw.sha256, `${label} artifact SHA-256`, 64);
  if (!SHA256_PATTERN.test(sha256)) {
    fail("invalid_config", `${label} artifact SHA-256 is invalid`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail("invalid_config", `${label} artifact URL is invalid`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !allowedHosts.includes(parsed.hostname.toLowerCase())
  ) {
    fail("invalid_config", `${label} artifact does not satisfy the HTTPS host policy`);
  }
  return { url, sha256 };
}

export function parseComputeConfig(value, expectedKeyPath) {
  const raw = object(value, "compute configuration");
  if (raw.version !== 1) fail("invalid_config", "compute configuration version must be 1");
  if (!Array.isArray(raw.profiles) || raw.profiles.length < 1 || raw.profiles.length > 8) {
    fail("invalid_config", "compute configuration must contain 1..8 profiles");
  }
  const activeProfileId = text(raw.activeProfileId, "active profile id", 64);
  if (!PROFILE_ID_PATTERN.test(activeProfileId)) {
    fail("invalid_config", "active profile id is invalid");
  }
  const ids = raw.profiles.map((candidate) =>
    text(object(candidate, "profile").id, "profile id", 64),
  );
  if (new Set(ids).size !== ids.length)
    fail("invalid_config", "compute profile ids must be unique");
  const profileRaw = raw.profiles.find((candidate) => candidate.id === activeProfileId);
  if (!profileRaw) fail("invalid_config", "active profile does not exist");
  if (
    raw.apiKeyFile !== null &&
    raw.apiKeyFile !== undefined &&
    raw.apiKeyFile !== expectedKeyPath
  ) {
    fail("invalid_config", "compute configuration API key path is not gateway-owned");
  }

  const profile = object(profileRaw, "active profile");
  if (profile.provider !== "runpod" || profile.cloudType !== "SECURE") {
    fail("invalid_config", "active profile must use RunPod Secure Cloud");
  }
  const id = text(profile.id, "profile id", 64);
  const configuredImage = text(profile.imageDigest, "profile image digest", 512);
  if (!IMAGE_PATTERN.test(configuredImage)) {
    fail("invalid_config", "profile image digest is not immutable");
  }
  const registry = text(profile.containerRegistryAuthId, "container registry credential id", 191);
  if (!REGISTRY_ID_PATTERN.test(registry)) {
    fail("invalid_config", "container registry credential id is invalid");
  }
  const networkVolumeId = text(profile.networkVolumeId, "network volume id", 191);
  if (!ID_PATTERN.test(networkVolumeId)) fail("invalid_config", "network volume id is invalid");
  if (profile.contextTokens !== 65_536 && profile.contextTokens !== 131_072) {
    fail("invalid_config", "profile contextTokens is unsupported");
  }

  const artifactsRaw = object(profile.modelArtifacts, "model artifacts");
  if (
    !Array.isArray(artifactsRaw.allowedHosts) ||
    artifactsRaw.allowedHosts.length < 1 ||
    artifactsRaw.allowedHosts.length > 12
  ) {
    fail("invalid_config", "artifact host allowlist must contain 1..12 hosts");
  }
  const allowedHosts = artifactsRaw.allowedHosts.map((host) =>
    typeof host === "string" ? host.trim().toLowerCase() : "",
  );
  if (
    allowedHosts.some((host) => !HOST_PATTERN.test(host)) ||
    new Set(allowedHosts).size !== allowedHosts.length
  ) {
    fail("invalid_config", "artifact host allowlist is invalid");
  }
  return {
    id,
    configuredImage,
    registry,
    networkVolumeId,
    contextTokens: profile.contextTokens,
    artifacts: {
      model: normalizeArtifact(artifactsRaw.model, "model", allowedHosts),
      mmproj: normalizeArtifact(artifactsRaw.mmproj, "mmproj", allowedHosts),
      draftModel: normalizeArtifact(artifactsRaw.draftModel, "draft model", allowedHosts),
      allowedHosts,
    },
  };
}

// Canary mode: identical lifecycle (image pull, registry, volume, log proof,
// exact-id deletion) but with one tiny checksum-bound artifact substituted for
// all three model artifacts, so the run never downloads the multi-GB cache.
export function applyCanaryArtifacts(profile, canary) {
  const url = new URL(canary.url);
  const host = url.hostname.toLowerCase();
  if (!profile.artifacts.allowedHosts.includes(host)) {
    fail("invalid_canary", "canary artifact host is not in the profile artifact host allowlist");
  }
  const artifact = { url: canary.url, sha256: canary.sha256 };
  return {
    ...profile,
    artifacts: {
      model: artifact,
      mmproj: artifact,
      draftModel: artifact,
      allowedHosts: profile.artifacts.allowedHosts,
    },
  };
}

export function parseNetworkVolume(value, expectedId) {
  const raw = object(value, "network volume");
  const id = text(raw.id, "network volume id", 191);
  if (!ID_PATTERN.test(id) || id !== expectedId) {
    fail("invalid_volume", "provider returned an unexpected network volume identity");
  }
  const dataCenter = text(raw.dataCenter, "network volume data center", 32);
  if (!DATA_CENTER_PATTERN.test(dataCenter)) {
    fail("invalid_volume", "network volume data center is invalid");
  }
  const size = integer(raw.size, "network volume size", 10);
  const type = text(raw.type, "network volume type", 64);
  return { id, dataCenter, size, type };
}

export function parseRegistryIdentity(value, expectedId) {
  const raw = object(value, "container registry credential");
  if (Object.keys(raw).some((key) => key !== "id" && key !== "name")) {
    fail("invalid_registry", "provider returned unexpected registry credential fields");
  }
  const id = text(raw.id, "container registry credential id", 191);
  const name = text(raw.name, "container registry credential name", 191);
  if (!REGISTRY_ID_PATTERN.test(id) || id !== expectedId) {
    fail("invalid_registry", "provider returned an unexpected registry credential identity");
  }
  return { id, name };
}

export function parseCpuCatalog(value) {
  const raw = object(value, "CPU catalog response");
  if (!Array.isArray(raw.cpus) || raw.cpus.length > MAX_CPUS) {
    fail("invalid_cpu_catalog", "CPU catalog has an invalid size");
  }
  return raw.cpus.map((entry) => {
    const cpu = object(entry, "CPU catalog entry");
    const id = text(cpu.id, "CPU flavor id", 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      fail("invalid_cpu_catalog", "CPU flavor id is invalid");
    }
    const vcpu = object(cpu.vcpu, "CPU vCPU range");
    const price = object(cpu.price, "CPU price");
    const dataCenters = cpu.dataCenters;
    if (dataCenters !== undefined && (!Array.isArray(dataCenters) || dataCenters.length > 256)) {
      fail("invalid_cpu_catalog", "CPU data center availability is invalid");
    }
    const parsedDataCenters = (dataCenters ?? []).map((candidate) => {
      const dc = object(candidate, "CPU data center availability");
      const idValue = text(dc.id, "CPU data center id", 32);
      const availability = text(dc.availability, "CPU availability", 16);
      if (!DATA_CENTER_PATTERN.test(idValue)) {
        fail("invalid_cpu_catalog", "CPU data center id is invalid");
      }
      return { id: idValue, availability };
    });
    if (
      new Set(parsedDataCenters.map((candidate) => candidate.id)).size !== parsedDataCenters.length
    ) {
      fail("invalid_cpu_catalog", "CPU data center availability contains duplicate identities");
    }
    return {
      id,
      minimumVcpu: integer(vcpu.min, "CPU minimum vCPU", 1),
      maximumVcpu: integer(vcpu.max, "CPU maximum vCPU", 1),
      securePerVcpu: finiteNumber(price.securePerVcpu, "CPU Secure price", 0),
      availability: typeof cpu.availability === "string" ? cpu.availability : null,
      dataCenters: parsedDataCenters,
    };
  });
}

export function selectCpuOffer(cpus, dataCenter, maxHourlyUsd) {
  const candidates = cpus
    .flatMap((cpu) => {
      if (
        cpu.minimumVcpu > VCPU_COUNT ||
        cpu.maximumVcpu < VCPU_COUNT ||
        !AVAILABLE.has(cpu.availability)
      ) {
        return [];
      }
      const exactDataCenter = cpu.dataCenters.find((candidate) => candidate.id === dataCenter);
      if (!exactDataCenter || !AVAILABLE.has(exactDataCenter.availability)) return [];
      return [
        {
          ...cpu,
          hourlyUsd: cpu.securePerVcpu * VCPU_COUNT,
          dataCenterAvailability: exactDataCenter.availability,
        },
      ];
    })
    .filter(
      (cpu) => Number.isFinite(cpu.hourlyUsd) && cpu.hourlyUsd > 0 && cpu.hourlyUsd <= maxHourlyUsd,
    )
    .sort(
      (left, right) =>
        AVAILABILITY_RANK[left.dataCenterAvailability] -
          AVAILABILITY_RANK[right.dataCenterAvailability] ||
        left.hourlyUsd - right.hourlyUsd ||
        AVAILABILITY_RANK[left.availability] - AVAILABILITY_RANK[right.availability] ||
        left.id.localeCompare(right.id),
    );
  if (!candidates.length) {
    fail(
      "cpu_unavailable",
      "no two-vCPU Secure CPU offer is available within the explicit ceiling",
    );
  }
  return candidates[0];
}

export function parsePod(value) {
  const raw = object(value, "Pod");
  const id = text(raw.id, "Pod id", 191);
  const name = text(raw.name, "Pod name", 191);
  const status = text(raw.status, "Pod status", 32);
  if (!ID_PATTERN.test(id) || !POD_STATUSES.has(status)) {
    fail("invalid_pod", "provider returned an invalid Pod identity or status");
  }
  const cpuRaw = raw.cpu === undefined ? null : object(raw.cpu, "Pod CPU");
  const mountsRaw = object(raw.mounts, "Pod mounts");
  const globalNetworkingRaw = object(raw.globalNetworking, "Pod global networking");
  if (typeof globalNetworkingRaw.enabled !== "boolean") {
    fail("invalid_pod", "provider returned invalid Pod global networking");
  }
  const sshRaw = object(raw.ssh, "Pod SSH state");
  if (!("proxy" in sshRaw) || !("direct" in sshRaw)) {
    fail("invalid_pod", "provider returned invalid Pod SSH state");
  }
  if (sshRaw.proxy !== null) object(sshRaw.proxy, "Pod proxy SSH endpoint");
  if (sshRaw.direct !== null) object(sshRaw.direct, "Pod direct SSH endpoint");
  const networkMounts = mountsRaw.network ?? [];
  if (!Array.isArray(networkMounts) || networkMounts.length > 1) {
    fail("invalid_pod", "provider returned invalid Pod network mounts");
  }
  if (!Array.isArray(raw.ports) || raw.ports.some((port) => typeof port !== "string")) {
    fail("invalid_pod", "provider returned invalid Pod ports");
  }
  if (raw.image !== undefined && raw.imageName !== undefined && raw.image !== raw.imageName) {
    fail("invalid_pod", "provider returned conflicting Pod image fields");
  }
  return {
    id,
    name,
    status,
    image: text(raw.image ?? raw.imageName, "Pod image", 512),
    args: typeof raw.args === "string" ? raw.args : fail("invalid_pod", "Pod args are invalid"),
    disk: integer(raw.disk, "Pod disk", 1),
    ports: [...raw.ports],
    env: exactStringMap(raw.env, "Pod environment"),
    registry: raw.registry === null ? null : text(raw.registry, "Pod registry", 191),
    cloud: text(raw.cloud, "Pod cloud", 32),
    dataCenterId: raw.dataCenterId === null ? null : text(raw.dataCenterId, "Pod data center", 32),
    cost: finiteNumber(raw.cost, "Pod hourly cost", 0),
    cpu: cpuRaw
      ? {
          id: text(cpuRaw.id, "Pod CPU id", 128),
          vcpuCount: integer(cpuRaw.vcpuCount, "Pod vCPU count", 1),
          memory: integer(cpuRaw.memory, "Pod memory", 1),
        }
      : null,
    gpuPresent: raw.gpu !== undefined && raw.gpu !== null,
    globalNetworkingEnabled: globalNetworkingRaw.enabled,
    sshProxyPresent: sshRaw.proxy !== null,
    sshDirectPresent: sshRaw.direct !== null,
    networkMounts: networkMounts.map((mount) => {
      const parsed = object(mount, "Pod network mount");
      return {
        volumeId: text(parsed.volumeId, "Pod network volume id", 191),
        path: text(parsed.path, "Pod network mount path", 512),
      };
    }),
  };
}

export function parseExactPod(value, expectedId) {
  const pod = parsePod(value);
  if (pod.id !== expectedId) {
    fail("pod_identity_mismatch", "provider returned a Pod other than the requested exact ID");
  }
  return pod;
}

export function parsePodList(value) {
  const raw = object(value, "Pod list response");
  if (!Array.isArray(raw.pods) || raw.pods.length > MAX_PODS) {
    fail("invalid_pod_list", "provider returned an invalid Pod list size");
  }
  return raw.pods.map(parsePod);
}

export function extractExactNameIdentity(value, expectedName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.name !== expectedName || typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
    return null;
  }
  return { id: value.id, name: value.name };
}

export function buildCreatePodRequest({ profile, image, buildId, leaseId, podName, cpu, volume }) {
  return {
    name: podName,
    image,
    args: "",
    disk: CONTAINER_DISK_GB,
    ports: [],
    env: {
      GLIMMER_PREWARM_ONLY: "1",
      GLIMMER_PREWARM_EXPECTED_BUILD_ID: buildId,
      GLIMMER_LEASE_ID: leaseId,
      GLIMMER_CONTEXT_TOKENS: String(profile.contextTokens),
      GLIMMER_MODEL_URL: profile.artifacts.model.url,
      GLIMMER_MODEL_SHA256: profile.artifacts.model.sha256,
      GLIMMER_MMPROJ_URL: profile.artifacts.mmproj.url,
      GLIMMER_MMPROJ_SHA256: profile.artifacts.mmproj.sha256,
      GLIMMER_DFLASH_URL: profile.artifacts.draftModel.url,
      GLIMMER_DFLASH_SHA256: profile.artifacts.draftModel.sha256,
      GLIMMER_ARTIFACT_HOSTS: profile.artifacts.allowedHosts.join(","),
    },
    registry: profile.registry,
    cloud: "SECURE",
    cpu: { id: cpu.id, vcpuCount: VCPU_COUNT },
    dataCenterIds: [volume.dataCenter],
    mounts: {
      network: [{ volumeId: profile.networkVolumeId, path: VOLUME_MOUNT_PATH }],
    },
    startJupyter: false,
    startSsh: false,
  };
}

export function validateOwnedPod(pod, expected, requireDataCenter = false) {
  // RunPod may report proxy routing metadata even when startSsh is false. The
  // no-access contract is the create flag plus no PUBLIC_KEY, no 22/tcp port,
  // and no direct SSH endpoint; those are all verified here.
  if (
    pod.name !== expected.podName ||
    pod.image !== expected.request.image ||
    pod.args !== expected.request.args ||
    pod.disk !== expected.request.disk ||
    pod.registry !== expected.request.registry ||
    pod.cloud !== "SECURE" ||
    pod.cpu?.id !== expected.request.cpu.id ||
    pod.cpu?.vcpuCount !== VCPU_COUNT ||
    pod.gpuPresent ||
    pod.globalNetworkingEnabled ||
    pod.sshDirectPresent ||
    pod.ports.length !== 0 ||
    pod.networkMounts.length !== 1 ||
    pod.networkMounts[0].volumeId !== expected.profile.networkVolumeId ||
    pod.networkMounts[0].path !== VOLUME_MOUNT_PATH
  ) {
    fail("pod_contract_mismatch", "allocated Pod does not match the prewarm request");
  }
  const expectedEnvironment = Object.entries(expected.request.env);
  if (Object.keys(pod.env).length !== expectedEnvironment.length) {
    fail("pod_contract_mismatch", "allocated Pod environment has unexpected entries");
  }
  for (const [key, value] of expectedEnvironment) {
    if (pod.env[key] !== value) {
      fail("pod_contract_mismatch", "allocated Pod environment does not match the prewarm request");
    }
  }
  if (pod.dataCenterId !== null && pod.dataCenterId !== expected.volume.dataCenter) {
    fail("pod_contract_mismatch", "allocated Pod is in the wrong data center");
  }
  if (requireDataCenter && pod.dataCenterId !== expected.volume.dataCenter) {
    fail("pod_contract_mismatch", "allocated Pod never proved its data center");
  }
  if (pod.cost > expected.maxHourlyUsd) {
    fail("price_ceiling_exceeded", "allocated Pod cost exceeds the explicit ceiling");
  }
  return pod;
}

function parseSseFrame(frame) {
  let id = null;
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  let parsed;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    fail("invalid_sse", "provider returned malformed log SSE data");
  }
  const raw = object(parsed, "log event");
  const source = text(raw.source, "log source", 32);
  const line = text(raw.line, "log line", 65_536);
  const timestamp = text(raw.ts, "log timestamp", 128);
  if (id !== null && id.length > 256) fail("invalid_sse", "provider returned an oversized SSE id");
  return { id, source, line, timestamp };
}

export function extractSseLogEvents(buffer, final = false) {
  if (typeof buffer !== "string" || buffer.length > MAX_LOG_BYTES) {
    fail("invalid_sse", "provider log buffer exceeded its safe limit");
  }
  const events = [];
  let cursor = 0;
  const boundary = /\r?\n\r?\n/g;
  for (;;) {
    boundary.lastIndex = cursor;
    const match = boundary.exec(buffer);
    if (!match) break;
    const frame = buffer.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const event = parseSseFrame(frame);
    if (event) events.push(event);
  }
  let remainder = buffer.slice(cursor);
  if (final && remainder.trim()) {
    const event = parseSseFrame(remainder);
    if (event) events.push(event);
    remainder = "";
  }
  return { events, remainder };
}

export function containsExactContainerLogLine(events, expectedLine) {
  return events.some((event) => event.source === "container" && event.line === expectedLine);
}

async function readResponseBytes(response, maximumBytes) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    fail("response_too_large", "provider response exceeds the safe size limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      fail("response_too_large", "provider response exceeds the safe size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readProviderProblem(response, sensitiveValues) {
  if (!/^application\/problem\+json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
    return null;
  }
  try {
    const bytes = await readResponseBytes(response, MAX_PROBLEM_BYTES);
    if (!bytes.byteLength) return null;
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return parseProviderProblemDetails(value, response.status, sensitiveValues);
  } catch {
    return null;
  }
}

function linkedAbortController(signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

export class RunPodV2Client {
  constructor({ apiKey, fetchImpl = fetch }) {
    if (typeof apiKey !== "string" || !apiKey || /\s/.test(apiKey)) {
      fail("invalid_api_key", "RunPod API key is empty or malformed");
    }
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async requestJson(operation, requestPath, options = {}) {
    const method = options.method ?? "GET";
    const timeout = linkedAbortController(
      options.signal,
      options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    try {
      let response;
      try {
        response = await this.fetchImpl(`${RUNPOD_ORIGIN}${requestPath}`, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: timeout.signal,
          redirect: "error",
        });
      } catch {
        throw new ProviderTransportError(operation, method === "POST");
      }
      const expectedStatuses = options.expectedStatuses ?? [200];
      if (options.nullOn404 && response.status === 404) return null;
      if (!expectedStatuses.includes(response.status)) {
        const providerProblem = await readProviderProblem(response, [this.apiKey]);
        throw new ProviderHttpError(operation, response.status, providerProblem);
      }
      if (response.status === 204) return null;
      let bytes;
      try {
        bytes = await readResponseBytes(response, MAX_JSON_BYTES);
      } catch (error) {
        if (method === "POST") throw new ProviderTransportError(operation, true);
        throw error;
      }
      const responseText = new TextDecoder().decode(bytes);
      try {
        return JSON.parse(responseText);
      } catch {
        if (method === "POST") throw new ProviderTransportError(operation, true);
        fail("invalid_provider_json", `${operation} returned invalid JSON`);
      }
    } finally {
      timeout.dispose();
    }
  }

  async listPods(options = {}) {
    return parsePodList(
      await this.requestJson("list Pods", "/v2/pods?includeClusterPods=true", {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      }),
    );
  }

  async getNetworkVolume(volumeId, options = {}) {
    return parseNetworkVolume(
      await this.requestJson(
        "get network volume",
        `/v2/network-volumes/${encodeURIComponent(volumeId)}`,
        options,
      ),
      volumeId,
    );
  }

  async getRegistry(registryId, options = {}) {
    return parseRegistryIdentity(
      await this.requestJson(
        "get container registry credential",
        `/v2/registries/${encodeURIComponent(registryId)}`,
        options,
      ),
      registryId,
    );
  }

  async listCpuTypes(options = {}) {
    return parseCpuCatalog(
      await this.requestJson(
        "list CPU types",
        "/v2/catalog/cpus?include=AVAILABILITY&product=POD&vcpuCount=2",
        options,
      ),
    );
  }

  async createPodRaw(body, options = {}) {
    return this.requestJson("create Pod", "/v2/pods", {
      method: "POST",
      body,
      expectedStatuses: [201],
      timeoutMs: CREATE_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    });
  }

  async getPod(podId, options = {}) {
    const response = await this.requestJson("get Pod", `/v2/pods/${encodeURIComponent(podId)}`, {
      ...options,
      nullOn404: true,
    });
    return response === null ? null : parseExactPod(response, podId);
  }

  async deletePod(podId, options = {}) {
    await this.requestJson("delete Pod", `/v2/pods/${encodeURIComponent(podId)}`, {
      method: "DELETE",
      expectedStatuses: [204],
      nullOn404: true,
      ...options,
    });
  }

  async hasExactContainerMarker(podId, marker, options = {}) {
    const timeout = linkedAbortController(
      options.signal,
      options.timeoutMs ?? LOG_REQUEST_TIMEOUT_MS,
    );
    try {
      let response;
      try {
        response = await this.fetchImpl(
          `${RUNPOD_ORIGIN}/v2/pods/${encodeURIComponent(podId)}/logs?source=container&tail=5000`,
          {
            method: "GET",
            headers: {
              Accept: "text/event-stream",
              Authorization: `Bearer ${this.apiKey}`,
            },
            signal: timeout.signal,
            redirect: "error",
          },
        );
      } catch {
        throw new ProviderTransportError("stream Pod logs");
      }
      if (response.status !== 200) throw new ProviderHttpError("stream Pod logs", response.status);
      if (!/^text\/event-stream(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
        fail("invalid_sse", "Pod logs did not return an SSE stream");
      }
      if (!response.body) fail("invalid_sse", "Pod log SSE response has no body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let totalBytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          const final = extractSseLogEvents(buffer, true);
          return containsExactContainerLogLine(final.events, marker);
        }
        totalBytes += value.byteLength;
        if (totalBytes > MAX_LOG_BYTES) {
          await reader.cancel().catch(() => undefined);
          fail("log_limit_exceeded", "Pod log stream exceeded the safe byte limit");
        }
        buffer += decoder.decode(value, { stream: true });
        const parsed = extractSseLogEvents(buffer);
        buffer = parsed.remainder;
        if (containsExactContainerLogLine(parsed.events, marker)) {
          await reader.cancel().catch(() => undefined);
          return true;
        }
      }
    } catch (error) {
      if (error instanceof PrewarmError) throw error;
      throw new ProviderTransportError("stream Pod logs");
    } finally {
      timeout.dispose();
    }
  }
}

function redactText(value, maximum = 1_024) {
  const raw = typeof value === "string" ? value : String(value ?? "");
  return raw
    .replace(/\b(?:rpa|rps)_[A-Za-z0-9_-]+\b/gi, "[REDACTED_CREDENTIAL]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:https?|s3):\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/([?&](?:api_?key|key|token|secret|authorization)=)[^&#\s]+/gi, "$1[REDACTED]")
    .slice(0, maximum);
}

export function sanitizeTimelinePayload(payload) {
  const result = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (/url|token|secret|credential|authorization|api.?key/i.test(key)) continue;
    if (typeof value === "string") result[key] = redactText(value, 512);
    else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "boolean" || value === null) result[key] = value;
  }
  return result;
}

function safeFailure(error) {
  return {
    code: error instanceof PrewarmError ? error.code : "unexpected_failure",
    message: redactText(error instanceof Error ? error.message : "unexpected failure", 512),
    ...(error instanceof ProviderHttpError ? { httpStatus: error.status } : {}),
    ...(error instanceof ProviderHttpError && error.providerProblem
      ? {
          providerTitle: error.providerProblem.title,
          providerDetail: error.providerProblem.detail,
          providerErrors: error.providerProblem.errors,
        }
      : {}),
  };
}

function createTimeline(startedAtMs) {
  const entries = [];
  let dropped = 0;
  return {
    entries,
    get dropped() {
      return dropped;
    },
    add(event, payload = {}, print = true) {
      if (entries.length >= MAX_TIMELINE_ENTRIES) {
        dropped += 1;
        return null;
      }
      const entry = {
        sequence: entries.length + 1,
        event,
        at: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - startedAtMs),
        ...sanitizeTimelinePayload(payload),
      };
      entries.push(entry);
      if (print) process.stdout.write(`${JSON.stringify(entry)}\n`);
      return entry;
    },
  };
}

async function validatePrivateDirectory(directory, label) {
  const metadata = await fs.lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("unsafe_filesystem", `${label} must be a real directory`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    fail("unsafe_permissions", `${label} must not grant group or other access`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    fail("unsafe_owner", `${label} must be owned by the current user`);
  }
}

export async function readPrivateRegularFile(file, label, maximumBytes) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await fs.open(file, flags);
  } catch {
    fail("unsafe_filesystem", `${label} could not be opened safely`);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      fail("unsafe_filesystem", `${label} must be a single-link regular file`);
    }
    if ((metadata.mode & 0o077) !== 0) {
      fail("unsafe_permissions", `${label} permissions must be private`);
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      fail("unsafe_owner", `${label} must be owned by the current user`);
    }
    if (metadata.size < 1 || metadata.size > maximumBytes) {
      fail("unsafe_file_size", `${label} has an invalid size`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function acquireExclusiveLock(lockPath, leaseId) {
  const flags =
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await fs.open(lockPath, flags, 0o600);
  } catch {
    fail("prewarm_locked", "another CPU prewarm process may already own the local lock");
  }
  let identity;
  let setupFailure = null;
  try {
    identity = await handle.stat();
    await handle.writeFile(
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid, leaseId, createdAt: new Date().toISOString() })}\n`,
    );
    await handle.sync();
  } catch (error) {
    setupFailure = error;
  } finally {
    await handle.close();
  }
  if (setupFailure) {
    try {
      const current = await fs.lstat(lockPath);
      if (identity && current.dev === identity.dev && current.ino === identity.ino) {
        await fs.unlink(lockPath);
      }
    } catch {
      // Best effort only; never unlink a lock whose inode identity was not captured.
    }
    throw setupFailure;
  }
  return async () => {
    try {
      const current = await fs.lstat(lockPath);
      if (current.dev === identity.dev && current.ino === identity.ino && current.nlink === 1) {
        await fs.unlink(lockPath);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
}

async function writePrivateAtomic(file, bytes) {
  if (bytes.byteLength > MAX_RESULT_BYTES) {
    fail("result_limit_exceeded", "sanitized result exceeds its safe byte limit");
  }
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const flags =
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let identity;
  try {
    const handle = await fs.open(temporary, flags, 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      identity = await handle.stat();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
    try {
      const directory = await fs.open(path.dirname(file), fsConstants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // File fsync + atomic same-directory rename is the portable minimum.
    }
  } catch (error) {
    try {
      const current = await fs.lstat(temporary);
      if (identity && current.dev === identity.dev && current.ino === identity.ino) {
        await fs.unlink(temporary);
      }
    } catch {
      // Best effort only; never unlink an inode whose identity was not captured.
    }
    throw error;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function boundedDelay(milliseconds, signal) {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error) {
    if (error?.name === "AbortError") fail("hard_deadline", "prewarm hard deadline elapsed");
    throw error;
  }
}

async function findExactNamePods(client, podName, options = {}) {
  return (await client.listPods(options)).filter((pod) => pod.name === podName);
}

async function recoverLostCreate(client, podName, deadlineAtMs, signal) {
  let stableEmptyAt = null;
  while (performance.now() < deadlineAtMs) {
    const matches = await findExactNamePods(client, podName, { signal });
    if (matches.length) return matches;
    stableEmptyAt ??= performance.now();
    if (performance.now() - stableEmptyAt >= RECOVERY_STABLE_EMPTY_MS) return [];
    await boundedDelay(POLL_INTERVAL_MS, signal);
  }
  fail(
    "create_outcome_unknown",
    "lost create response could not be reconciled before the deadline",
  );
}

export async function pollUntilExited(client, podId, expected, deadlineAtMs, signal, timeline) {
  let previousStatus = null;
  let consecutiveTransportFailures = 0;
  for (;;) {
    if (performance.now() >= deadlineAtMs) fail("hard_deadline", "prewarm hard deadline elapsed");
    let pod;
    try {
      pod = await client.getPod(podId, { signal });
      consecutiveTransportFailures = 0;
    } catch (error) {
      if (!(error instanceof ProviderTransportError) || error.ambiguous || signal?.aborted) {
        throw error;
      }
      consecutiveTransportFailures += 1;
      if (consecutiveTransportFailures >= POD_POLL_MAX_CONSECUTIVE_TRANSPORT_FAILURES) {
        throw error;
      }
      timeline.add("pod_poll_transport_retry", {
        podId,
        consecutiveFailure: consecutiveTransportFailures,
      });
      await boundedDelay(POD_POLL_TRANSPORT_RETRY_DELAY_MS * consecutiveTransportFailures, signal);
      continue;
    }
    if (!pod) fail("pod_disappeared", "prewarm Pod disappeared before success proof");
    validateOwnedPod(pod, expected, pod.status === "EXITED");
    if (pod.status !== previousStatus) {
      timeline.add("pod_status", { podId, status: pod.status, hourlyUsd: pod.cost });
      previousStatus = pod.status;
    }
    if (pod.status === "EXITED") return pod;
    if (pod.status === "ERROR" || pod.status === "TERMINATED") {
      fail("prewarm_failed", `prewarm Pod reached ${pod.status} before success proof`);
    }
    await boundedDelay(POD_POLL_INTERVAL_MS, signal);
  }
}

async function cleanupOwnedPods({ client, podName, ownedIds, createAttempted, timeline }) {
  const deadlineAtMs = performance.now() + CLEANUP_DEADLINE_MS;
  const requestOptions = () => {
    const remainingMs = Math.floor(deadlineAtMs - performance.now());
    return remainingMs > 0
      ? { timeoutMs: Math.max(1, Math.min(DEFAULT_REQUEST_TIMEOUT_MS, remainingMs)) }
      : null;
  };
  let stableEmptyAt = createAttempted ? null : performance.now() - RECOVERY_STABLE_EMPTY_MS;
  let deleteAttempts = 0;
  let providerPodCount = null;
  let lastError = null;
  const confirmedAbsentIds = new Set();
  cleanupLoop: while (performance.now() < deadlineAtMs) {
    const directlyAttemptedThisPass = new Set();
    // Captured IDs are already proven to belong to this single create attempt.
    // Do not gate their required cleanup on list/get availability.
    for (const podId of ownedIds) {
      if (confirmedAbsentIds.has(podId)) continue;
      directlyAttemptedThisPass.add(podId);
      const options = requestOptions();
      if (!options) break cleanupLoop;
      try {
        deleteAttempts += 1;
        timeline.add("delete_exact_id_attempted", { podId, attempt: deleteAttempts });
        await client.deletePod(podId, options);
      } catch (error) {
        lastError = error;
      }
    }
    let pods;
    try {
      const options = requestOptions();
      if (!options) break cleanupLoop;
      pods = await client.listPods(options);
      providerPodCount = pods.length;
      const exactMatches = createAttempted ? pods.filter((pod) => pod.name === podName) : [];
      for (const pod of exactMatches) ownedIds.add(pod.id);
      if (exactMatches.length > 1) {
        timeline.add("single_pod_invariant_violated", { exactNameMatches: exactMatches.length });
      }
      // A name recovered after the single create attempt gets an immediate exact-ID
      // delete; it is never gated on a subsequent GET succeeding.
      for (const pod of exactMatches) {
        if (directlyAttemptedThisPass.has(pod.id) || confirmedAbsentIds.has(pod.id)) continue;
        directlyAttemptedThisPass.add(pod.id);
        const options = requestOptions();
        if (!options) break cleanupLoop;
        try {
          deleteAttempts += 1;
          timeline.add("delete_exact_id_attempted", { podId: pod.id, attempt: deleteAttempts });
          await client.deletePod(pod.id, options);
        } catch (error) {
          lastError = error;
        }
      }
      let allAbsent = true;
      for (const podId of ownedIds) {
        let current = null;
        const options = requestOptions();
        if (!options) break cleanupLoop;
        try {
          current = await client.getPod(podId, options);
        } catch (error) {
          lastError = error;
          allAbsent = false;
          continue;
        }
        if (current) {
          confirmedAbsentIds.delete(podId);
          allAbsent = false;
        } else confirmedAbsentIds.add(podId);
      }
      if (allAbsent && exactMatches.length === 0) {
        stableEmptyAt ??= performance.now();
        if (performance.now() - stableEmptyAt >= RECOVERY_STABLE_EMPTY_MS) {
          return {
            complete: providerPodCount === 0,
            exactIdsAbsent: true,
            providerPodCount,
            deleteAttempts,
            ...(providerPodCount === 0 ? {} : { failure: "provider Pod list is not empty" }),
          };
        }
      } else {
        stableEmptyAt = null;
      }
    } catch (error) {
      lastError = error;
      stableEmptyAt = null;
    }
    const remainingMs = Math.floor(deadlineAtMs - performance.now());
    if (remainingMs <= 0) break;
    await delay(Math.min(POLL_INTERVAL_MS, remainingMs));
  }
  return {
    complete: false,
    exactIdsAbsent: false,
    providerPodCount,
    deleteAttempts,
    failure: safeFailure(
      lastError ?? new PrewarmError("cleanup_timeout", "cleanup deadline elapsed"),
    ).message,
  };
}

async function verifyProviderEmptyReadOnly(client) {
  try {
    const pods = await client.listPods({ timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS });
    return {
      complete: pods.length === 0,
      exactIdsAbsent: true,
      providerPodCount: pods.length,
      deleteAttempts: 0,
      readOnly: true,
      ...(pods.length === 0 ? {} : { failure: "provider Pod list is not empty" }),
    };
  } catch (error) {
    return {
      complete: false,
      exactIdsAbsent: true,
      providerPodCount: null,
      deleteAttempts: 0,
      readOnly: true,
      failure: safeFailure(error).message,
    };
  }
}

function resultFingerprint(profile, image, buildId) {
  return sha256(
    Buffer.from(
      JSON.stringify({
        profileId: profile.id,
        image,
        buildId,
        registry: profile.registry,
        volume: profile.networkVolumeId,
        artifacts: profile.artifacts,
      }),
      "utf8",
    ),
  );
}

async function executePrewarm(args, dependencies = {}) {
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  const leaseId = dependencies.randomUUID?.() ?? randomUUID();
  const podName = `glimmer-cpu-prewarm-${leaseId}`;
  const paths = resolveStatePaths(
    dependencies.environment ?? process.env,
    dependencies.homeDirectory,
  );
  const timeline = createTimeline(startedAtMs);
  const runAbort = new AbortController();
  const hardDeadlineAtMs = startedAtMs + args.hardDeadlineSeconds * 1_000;
  const hardDeadlineAt = new Date(Date.now() + args.hardDeadlineSeconds * 1_000).toISOString();
  const hardTimer = setTimeout(() => runAbort.abort(), args.hardDeadlineSeconds * 1_000);
  hardTimer.unref?.();
  let releaseLock = null;
  let client = null;
  let profile = null;
  let volume = null;
  let cpu = null;
  let podId = null;
  let createAttempted = false;
  let markerObserved = false;
  let exitedObserved = false;
  let preflightValidated = false;
  let requestFingerprint = null;
  let mainFailure = null;
  let cleanup = {
    complete: true,
    exactIdsAbsent: true,
    providerPodCount: null,
    deleteAttempts: 0,
    noExternalMutation: true,
  };
  const ownedIds = new Set();

  const onSignal = () => runAbort.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.umask(0o077);

  try {
    await validatePrivateDirectory(paths.stateRoot, "state root");
    await validatePrivateDirectory(paths.keyDirectory, "compute key directory");
    releaseLock = await acquireExclusiveLock(paths.lockPath, leaseId);
    timeline.add("prewarm_started", {
      mode: args.mode,
      canary: Boolean(args.canary),
      leaseId,
      podName,
      buildId: args.buildId,
      maxHourlyUsd: args.maxHourlyUsd,
      hardDeadlineAt,
    });

    const configBytes = await readPrivateRegularFile(
      paths.configPath,
      "compute configuration",
      MAX_CONFIG_BYTES,
    );
    let configValue;
    try {
      configValue = JSON.parse(configBytes.toString("utf8"));
    } catch {
      fail("invalid_config", "compute configuration is not valid JSON");
    }
    profile = parseComputeConfig(configValue, paths.keyPath);
    if (args.canary) {
      profile = applyCanaryArtifacts(profile, args.canary);
      timeline.add("canary_artifacts_applied", {
        artifactSha256: args.canary.sha256,
      });
    }
    const configHash = sha256(configBytes);
    const keyBytes = await readPrivateRegularFile(paths.keyPath, "RunPod API key", MAX_KEY_BYTES);
    const apiKey = keyBytes.toString("utf8").trim();
    keyBytes.fill(0);
    if (!apiKey || /\s/.test(apiKey))
      fail("invalid_api_key", "RunPod API key is empty or malformed");
    client = new RunPodV2Client({ apiKey, fetchImpl: dependencies.fetchImpl ?? fetch });
    timeline.add("configuration_loaded", {
      profileId: profile.id,
      profileFingerprint: resultFingerprint(profile, args.image, args.buildId),
    });

    const initialPods = await client.listPods({ signal: runAbort.signal });
    if (initialPods.length !== 0) {
      fail("provider_not_empty", "RunPod account must have zero Pods before prewarm");
    }
    timeline.add("v2_auth_and_empty_provider_confirmed");

    const registry = await client.getRegistry(profile.registry, {
      signal: runAbort.signal,
    });
    timeline.add("container_registry_verified", { registryId: registry.id });

    volume = await client.getNetworkVolume(profile.networkVolumeId, {
      signal: runAbort.signal,
    });
    timeline.add("network_volume_verified", {
      volumeId: volume.id,
      dataCenter: volume.dataCenter,
      sizeGb: volume.size,
    });

    const cpus = await client.listCpuTypes({ signal: runAbort.signal });
    cpu = selectCpuOffer(cpus, volume.dataCenter, args.maxHourlyUsd);
    timeline.add("cpu_offer_selected", {
      cpuId: cpu.id,
      vcpuCount: VCPU_COUNT,
      hourlyUsd: cpu.hourlyUsd,
      availability: cpu.availability,
      dataCenterAvailability: cpu.dataCenterAvailability,
    });

    const recheckedConfig = await readPrivateRegularFile(
      paths.configPath,
      "compute configuration",
      MAX_CONFIG_BYTES,
    );
    if (sha256(recheckedConfig) !== configHash) {
      fail("config_changed", "compute configuration changed during preflight");
    }
    const finalPreflightPods = await client.listPods({ signal: runAbort.signal });
    if (finalPreflightPods.length !== 0) {
      fail("provider_not_empty", "RunPod account changed during preflight");
    }

    const request = buildCreatePodRequest({
      profile,
      image: args.image,
      buildId: args.buildId,
      leaseId,
      podName,
      cpu,
      volume,
    });
    requestFingerprint = sha256(Buffer.from(JSON.stringify(request), "utf8"));
    const expected = {
      podName,
      request,
      profile,
      volume,
      maxHourlyUsd: args.maxHourlyUsd,
    };
    if (args.mode === "preflight") {
      preflightValidated = true;
      timeline.add("preflight_request_validated", {
        requestFingerprint,
        estimatedMaximumUsd:
          (cpu.hourlyUsd * (args.hardDeadlineSeconds + CLEANUP_DEADLINE_MS / 1_000)) / 3_600,
      });
    } else {
      if (createAttempted) fail("single_create_violation", "Pod create was already attempted");
      createAttempted = true;
      timeline.add("create_attempted", { attempt: 1 });

      let createdPod = null;
      try {
        const rawCreated = await client.createPodRaw(request, { signal: runAbort.signal });
        const identity = extractExactNameIdentity(rawCreated, podName);
        if (identity) {
          podId = identity.id;
          ownedIds.add(identity.id);
        }
        createdPod = parsePod(rawCreated);
        if (!podId || createdPod.id !== podId) {
          fail("pod_identity_mismatch", "create response did not prove the exact Pod identity");
        }
        validateOwnedPod(createdPod, expected);
      } catch (error) {
        if (!(error instanceof ProviderTransportError) || !error.ambiguous) throw error;
        timeline.add("create_response_lost", { recoveredBy: "exact_name_only" });
        const matches = await recoverLostCreate(client, podName, hardDeadlineAtMs, runAbort.signal);
        if (matches.length !== 1) {
          if (matches.length > 1) {
            for (const match of matches) ownedIds.add(match.id);
            fail(
              "single_pod_invariant_violated",
              "multiple exact-name Pods followed one create attempt",
            );
          }
          fail("create_outcome_absent", "no exact-name Pod appeared after the lost response");
        }
        createdPod = matches[0];
        podId = createdPod.id;
        ownedIds.add(podId);
        validateOwnedPod(createdPod, expected);
      }
      timeline.add("pod_identity_captured", { podId, podName });

      const postCreatePods = await client.listPods({ signal: runAbort.signal });
      if (
        postCreatePods.length !== 1 ||
        postCreatePods[0].id !== podId ||
        postCreatePods[0].name !== podName
      ) {
        fail("single_pod_invariant_violated", "provider did not contain exactly the captured Pod");
      }

      await pollUntilExited(client, podId, expected, hardDeadlineAtMs, runAbort.signal, timeline);
      exitedObserved = true;
      const marker = `GLIMMER_PREWARM_READY ${leaseId}`;
      markerObserved = await client.hasExactContainerMarker(podId, marker, {
        signal: runAbort.signal,
        timeoutMs: Math.min(
          LOG_REQUEST_TIMEOUT_MS,
          Math.max(1, Math.floor(hardDeadlineAtMs - performance.now())),
        ),
      });
      if (!markerObserved) {
        fail(
          "prewarm_marker_missing",
          "EXITED Pod did not emit the exact lease-bound readiness marker",
        );
      }
      timeline.add("prewarm_proof_observed", { podId, status: "EXITED", markerObserved: true });
    }
  } catch (error) {
    mainFailure = safeFailure(error);
    timeline.add("prewarm_failed", mainFailure);
  } finally {
    clearTimeout(hardTimer);
    if (client) {
      try {
        cleanup =
          args.mode === "preflight"
            ? await verifyProviderEmptyReadOnly(client)
            : await cleanupOwnedPods({
                client,
                podName,
                ownedIds,
                createAttempted,
                timeline,
              });
      } catch (error) {
        cleanup = {
          complete: false,
          exactIdsAbsent: false,
          providerPodCount: null,
          deleteAttempts: cleanup.deleteAttempts,
          ...(args.mode === "preflight" ? { readOnly: true } : {}),
          failure: safeFailure(error).message,
        };
        mainFailure ??= safeFailure(error);
      }
      timeline.add(args.mode === "preflight" ? "preflight_final_check" : "cleanup_finished", {
        complete: cleanup.complete,
        exactIdsAbsent: cleanup.exactIdsAbsent,
        providerPodCount: cleanup.providerPodCount,
        deleteAttempts: cleanup.deleteAttempts,
      });
    }
    if (!cleanup.complete && !mainFailure) {
      mainFailure = {
        code: args.mode === "preflight" ? "preflight_final_check_failed" : "cleanup_incomplete",
        message: redactText(cleanup.failure ?? "final provider verification did not complete", 512),
      };
    }

    const proofComplete =
      args.mode === "preflight" ? preflightValidated : exitedObserved && markerObserved;
    const succeeded =
      !mainFailure && proofComplete && cleanup.complete && cleanup.providerPodCount === 0;
    const result = {
      schemaVersion: 1,
      kind: "runpod_cpu_prewarm",
      mode: args.mode,
      outcome: succeeded
        ? "succeeded"
        : args.mode === "execute" && createAttempted && !cleanup.complete
          ? "cleanup_incomplete"
          : "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      leaseId,
      podName,
      podId,
      profileId: profile?.id ?? null,
      buildId: args.buildId,
      imageFingerprint: sha256(Buffer.from(args.image, "utf8")),
      volumeId: volume?.id ?? profile?.networkVolumeId ?? null,
      dataCenter: volume?.dataCenter ?? null,
      cpu: cpu
        ? {
            id: cpu.id,
            vcpuCount: VCPU_COUNT,
            hourlyUsd: cpu.hourlyUsd,
            availability: cpu.availability,
            dataCenterAvailability: cpu.dataCenterAvailability,
          }
        : null,
      maxHourlyUsd: args.maxHourlyUsd,
      hardDeadlineAt,
      preflightValidated,
      requestFingerprint,
      exitedObserved,
      markerObserved,
      cleanup,
      failure: mainFailure,
      timelineDropped: timeline.dropped,
      timeline: timeline.entries,
    };
    if (releaseLock) {
      try {
        const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`, "utf8");
        await writePrivateAtomic(paths.resultPath, bytes);
        process.stdout.write(
          `${JSON.stringify({ event: "prewarm_result_written", outcome: result.outcome, cleanupComplete: cleanup.complete })}\n`,
        );
      } catch (error) {
        mainFailure ??= safeFailure(error);
        process.stderr.write(
          `${JSON.stringify({ event: "prewarm_result_write_failed", ...safeFailure(error) })}\n`,
        );
      }
    } else {
      process.stderr.write(
        `${JSON.stringify({ event: "prewarm_result_not_written", reason: "lock_not_owned" })}\n`,
      );
    }
    if (releaseLock) {
      try {
        await releaseLock();
      } catch (error) {
        mainFailure ??= safeFailure(error);
      }
    }
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  const proofComplete =
    args.mode === "preflight" ? preflightValidated : exitedObserved && markerObserved;
  return mainFailure || !cleanup.complete || cleanup.providerPodCount !== 0 || !proofComplete
    ? 1
    : 0;
}

export async function runReadOnlyPreflight(argv, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const args = parseArguments(argv, environment);
  if (args.mode !== "preflight") {
    fail("invalid_mode", "runReadOnlyPreflight accepts --preflight only");
  }
  return executePrewarm(args, { ...dependencies, environment });
}

async function main() {
  let args;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: "argument_error", ...safeFailure(error) })}\n`);
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  try {
    return await executePrewarm(args);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: "prewarm_fatal", ...safeFailure(error) })}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = await main();
}
