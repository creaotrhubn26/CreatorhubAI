import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ComputeBackend,
  ComputeCoordinatorTestResult,
  ComputeCoordinatorUpdateV1,
  ComputeConfigUpdateV1,
  ComputeConfigV1,
  ComputeProfileUpdateV1,
  ComputeProfileV1,
  ComputeWatchdogTestResult,
  ComputeWatchdogUpdateV1,
  RunPodGpuTypeId,
} from "@glimmer/shared";
import { CONFIG } from "../../config.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VOLUME_ID_PATTERN = /^[A-Za-z0-9_-]{1,191}$/;
const REGISTRY_AUTH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/;
const IMAGE_DIGEST_PATTERN = /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const WORKER_BUILD_ID_PATTERN = /^r2-[a-f0-9]{12}$/;
const HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_API_KEY_CHARS = 16_384;
const WATCHDOG_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
const MAX_PROFILES = 8;
export const DEFAULT_RUNPOD_IMAGE_DIGEST =
  "ghcr.io/creaotrhubn26/glimmer-runpod-worker@sha256:a64c27bed47cff5025292bf9eb3f31f5bf4c342509f8480abec3ee9f0a3c5745";

export const RUNPOD_A100_GPU_IDS: RunPodGpuTypeId[] = [
  "NVIDIA A100 80GB PCIe",
  "NVIDIA A100-SXM4-80GB",
];
export const RUNPOD_H100_GPU_IDS: RunPodGpuTypeId[] = ["NVIDIA H100 PCIe", "NVIDIA H100 80GB HBM3"];
export const RUNPOD_RTX_PRO_GPU_IDS: RunPodGpuTypeId[] = [
  "NVIDIA RTX PRO 6000 Blackwell Server Edition",
];
const RUNPOD_GPU_IDS = new Set<RunPodGpuTypeId>([
  ...RUNPOD_A100_GPU_IDS,
  ...RUNPOD_H100_GPU_IDS,
  ...RUNPOD_RTX_PRO_GPU_IDS,
]);

type StoredComputeProfile = ComputeProfileUpdateV1;

interface StoredWatchdogConfig {
  endpointUrl: string;
  tokenFile: string | null;
  verifiedAt?: string;
  lastSweepAt?: string;
}

interface StoredCoordinatorConfig {
  endpointUrl: string;
  tokenFile: string | null;
  verifiedAt?: string;
  cacheSigningKeyId?: string;
}

interface StoredComputeConfig {
  version: 1;
  enabled: boolean;
  defaultBackend: ComputeBackend;
  profiles: StoredComputeProfile[];
  activeProfileId?: string;
  orchestrationMode?: "local_gateway" | "cloud_coordinator";
  apiKeyFile: string | null;
  watchdog?: StoredWatchdogConfig | null;
  coordinator?: StoredCoordinatorConfig | null;
}

export class ComputeConfigValidationError extends Error {}

function invalid(message: string): never {
  throw new ComputeConfigValidationError(message);
}

function defaultProfile(
  id: string,
  label: string,
  performance: "economy" | "latency",
  gpuTypeIds: RunPodGpuTypeId[],
  maxGpuHourlyUsd: number,
): StoredComputeProfile {
  return {
    id,
    label,
    provider: "runpod",
    cloudType: "SECURE",
    performance,
    gpuTypeIds,
    gpuCount: 1,
    contextTokens: 65_536,
    imageDigest: DEFAULT_RUNPOD_IMAGE_DIGEST,
    workerBuildId: "r2-7ac9646ae7ea",
    maxGpuHourlyUsd,
    idleTimeoutSeconds: 300,
    clarificationTimeoutSeconds: 120,
    hardSessionLimitSeconds: 7_200,
    dailyBudgetUsd: 10,
    monthlyBudgetUsd: 50,
  };
}

function defaultStoredConfig(): StoredComputeConfig {
  return {
    version: 1,
    enabled: false,
    defaultBackend: "local_process",
    profiles: [
      defaultProfile("runpod-a100", "RunPod A100 80 GB", "economy", [...RUNPOD_A100_GPU_IDS], 1.75),
      defaultProfile(
        "runpod-h100-latency",
        "RunPod H100 latency",
        "latency",
        [...RUNPOD_H100_GPU_IDS],
        3.75,
      ),
    ],
    activeProfileId: "runpod-a100",
    orchestrationMode: "local_gateway",
    apiKeyFile: null,
    watchdog: null,
    coordinator: null,
  };
}

async function exists(file: string | null): Promise<boolean> {
  if (!file) return false;
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

function normalizedWatchdogEndpoint(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") invalid("watchdog endpointUrl must be a URL");
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    invalid("watchdog endpointUrl is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    invalid("watchdog endpointUrl must be an origin-only HTTPS URL");
  }
  return parsed.origin;
}

function normalizedCoordinatorEndpoint(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") invalid("coordinator endpointUrl must be a URL");
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    invalid("coordinator endpointUrl is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    invalid("coordinator endpointUrl must be an origin-only HTTPS URL");
  }
  return parsed.origin;
}

function isStoredWatchdog(value: unknown): value is StoredWatchdogConfig {
  if (!value || typeof value !== "object") return false;
  const raw = value as Partial<StoredWatchdogConfig>;
  try {
    if (normalizedWatchdogEndpoint(raw.endpointUrl) !== raw.endpointUrl) return false;
  } catch {
    return false;
  }
  return (
    (raw.tokenFile === null ||
      (typeof raw.tokenFile === "string" && isGatewayOwnedWatchdogPath(raw.tokenFile))) &&
    (raw.verifiedAt === undefined || Number.isFinite(Date.parse(raw.verifiedAt))) &&
    (raw.lastSweepAt === undefined || Number.isFinite(Date.parse(raw.lastSweepAt)))
  );
}

function isStoredCoordinator(value: unknown): value is StoredCoordinatorConfig {
  if (!value || typeof value !== "object") return false;
  const raw = value as Partial<StoredCoordinatorConfig>;
  try {
    if (normalizedCoordinatorEndpoint(raw.endpointUrl) !== raw.endpointUrl) return false;
  } catch {
    return false;
  }
  return (
    (raw.tokenFile === null ||
      (typeof raw.tokenFile === "string" && isGatewayOwnedCoordinatorPath(raw.tokenFile))) &&
    (raw.verifiedAt === undefined || Number.isFinite(Date.parse(raw.verifiedAt))) &&
    (raw.cacheSigningKeyId === undefined || /^[a-f0-9]{64}$/.test(raw.cacheSigningKeyId))
  );
}

function isStoredProfile(value: unknown): value is StoredComputeProfile {
  try {
    normalizeProfile(value);
    return true;
  } catch (error) {
    if (error instanceof ComputeConfigValidationError) return false;
    throw error;
  }
}

function isStoredConfig(value: unknown): value is StoredComputeConfig {
  if (!value || typeof value !== "object") return false;
  const raw = value as Partial<StoredComputeConfig>;
  if (
    raw.version !== 1 ||
    typeof raw.enabled !== "boolean" ||
    (raw.defaultBackend !== "local_process" && raw.defaultBackend !== "runpod_pod") ||
    !Array.isArray(raw.profiles) ||
    raw.profiles.length < 1 ||
    raw.profiles.length > MAX_PROFILES ||
    !raw.profiles.every(isStoredProfile) ||
    (raw.orchestrationMode !== undefined &&
      raw.orchestrationMode !== "local_gateway" &&
      raw.orchestrationMode !== "cloud_coordinator") ||
    (raw.apiKeyFile !== null &&
      (typeof raw.apiKeyFile !== "string" || !isGatewayOwnedKeyPath(raw.apiKeyFile)))
  ) {
    return false;
  }
  if (raw.watchdog !== undefined && raw.watchdog !== null && !isStoredWatchdog(raw.watchdog)) {
    return false;
  }
  if (
    raw.coordinator !== undefined &&
    raw.coordinator !== null &&
    !isStoredCoordinator(raw.coordinator)
  ) {
    return false;
  }
  const ids = new Set(raw.profiles.map((profile) => profile.id));
  return !raw.activeProfileId || ids.has(raw.activeProfileId);
}

async function readStoredConfig(): Promise<{
  config: StoredComputeConfig;
  source: "default" | "saved";
}> {
  try {
    const parsed = JSON.parse(await fs.readFile(CONFIG.computeConfigPath, "utf8"));
    if (isStoredConfig(parsed)) {
      return {
        config: {
          ...parsed,
          orchestrationMode: parsed.orchestrationMode ?? "local_gateway",
          profiles: parsed.profiles.map(normalizeProfile),
          watchdog: parsed.watchdog ?? null,
          coordinator: parsed.coordinator ?? null,
        },
        source: "saved",
      };
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return { config: defaultStoredConfig(), source: "default" };
}

async function toPublic(
  config: StoredComputeConfig,
  source: "default" | "saved",
): Promise<ComputeConfigV1> {
  const hasApiKey = await exists(config.apiKeyFile);
  const hasIngestToken = await exists(config.watchdog?.tokenFile ?? null);
  const hasCoordinatorToken = await exists(config.coordinator?.tokenFile ?? null);
  const watchdogConfigured = Boolean(
    config.watchdog?.endpointUrl && hasIngestToken && config.watchdog.verifiedAt,
  );
  const profiles: ComputeProfileV1[] = config.profiles.map((profile) => ({
    ...profile,
    hasApiKey,
    watchdogConfigured,
  }));
  return {
    version: 1,
    enabled: config.enabled,
    defaultBackend: config.defaultBackend,
    profiles,
    ...(config.activeProfileId ? { activeProfileId: config.activeProfileId } : {}),
    orchestrationMode: config.orchestrationMode ?? "local_gateway",
    watchdog: {
      ...(config.watchdog?.endpointUrl ? { endpointUrl: config.watchdog.endpointUrl } : {}),
      hasIngestToken,
      ...(config.watchdog?.verifiedAt ? { verifiedAt: config.watchdog.verifiedAt } : {}),
      ...(config.watchdog?.lastSweepAt ? { lastSweepAt: config.watchdog.lastSweepAt } : {}),
    },
    coordinator: {
      ...(config.coordinator?.endpointUrl ? { endpointUrl: config.coordinator.endpointUrl } : {}),
      hasIngestToken: hasCoordinatorToken,
      ...(config.coordinator?.verifiedAt ? { verifiedAt: config.coordinator.verifiedAt } : {}),
      ...(config.coordinator?.cacheSigningKeyId
        ? { cacheSigningKeyId: config.coordinator.cacheSigningKeyId }
        : {}),
    },
    source,
  };
}

function boundedNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalBudget(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return boundedNumber(value, label, 1, 100_000);
}

function normalizeModelArtifacts(
  value: ComputeProfileUpdateV1["modelArtifacts"],
  profileId: string,
): ComputeProfileUpdateV1["modelArtifacts"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    invalid(`profile ${profileId}: modelArtifacts must be an object`);
  }
  if (
    !Array.isArray(value.allowedHosts) ||
    value.allowedHosts.length < 1 ||
    value.allowedHosts.length > 12
  ) {
    invalid(`profile ${profileId}: model artifact allowedHosts must contain 1..12 hosts`);
  }
  const allowedHosts = value.allowedHosts.map((host) =>
    typeof host === "string" ? host.trim().toLowerCase() : "",
  );
  if (
    allowedHosts.some((host) => !HOST_PATTERN.test(host)) ||
    new Set(allowedHosts).size !== allowedHosts.length
  ) {
    invalid(`profile ${profileId}: model artifact allowedHosts contains an invalid host`);
  }
  const normalizeArtifact = (
    artifact: { url: string; sha256: string } | undefined,
    label: string,
  ) => {
    if (!artifact || typeof artifact !== "object") {
      invalid(`profile ${profileId}: ${label} artifact is required`);
    }
    const url = typeof artifact.url === "string" ? artifact.url.trim() : "";
    const sha256 = typeof artifact.sha256 === "string" ? artifact.sha256.trim() : "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      invalid(`profile ${profileId}: ${label} artifact URL is invalid`);
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !allowedHosts.includes(parsed.hostname.toLowerCase())
    ) {
      invalid(`profile ${profileId}: ${label} artifact must use an allowlisted HTTPS host`);
    }
    if (!SHA256_PATTERN.test(sha256)) {
      invalid(`profile ${profileId}: ${label} artifact SHA-256 is invalid`);
    }
    return { url, sha256 };
  };
  return {
    model: normalizeArtifact(value.model, "model"),
    mmproj: normalizeArtifact(value.mmproj, "mmproj"),
    draftModel: normalizeArtifact(value.draftModel, "draft model"),
    allowedHosts,
  };
}

function normalizeProfile(value: unknown): StoredComputeProfile {
  if (!value || typeof value !== "object") invalid("each compute profile must be an object");
  const raw = value as Partial<ComputeProfileUpdateV1>;
  if (!ID_PATTERN.test(raw.id ?? "")) {
    invalid("profile id must contain only letters, numbers, dot, underscore, or dash");
  }
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label || label.length > 120) invalid(`profile ${raw.id}: label is required`);
  if (raw.provider !== "runpod") invalid(`profile ${raw.id}: provider must be runpod`);
  if (raw.cloudType !== "SECURE") invalid(`profile ${raw.id}: only Secure Cloud is allowed`);
  if (raw.performance !== "economy" && raw.performance !== "latency") {
    invalid(`profile ${raw.id}: performance must be economy or latency`);
  }
  if (
    !Array.isArray(raw.gpuTypeIds) ||
    raw.gpuTypeIds.length < 1 ||
    raw.gpuTypeIds.length > 4 ||
    raw.gpuTypeIds.some((id) => !RUNPOD_GPU_IDS.has(id)) ||
    new Set(raw.gpuTypeIds).size !== raw.gpuTypeIds.length
  ) {
    invalid(`profile ${raw.id}: GPU list contains an unsupported or duplicate GPU type`);
  }
  const hasH100 = raw.gpuTypeIds.some((id) => RUNPOD_H100_GPU_IDS.includes(id));
  const hasA100 = raw.gpuTypeIds.some((id) => RUNPOD_A100_GPU_IDS.includes(id));
  if (raw.performance === "economy" && hasH100) {
    invalid(`profile ${raw.id}: H100 GPUs require an explicit latency profile`);
  }
  if (raw.performance === "latency" && hasA100) {
    invalid(`profile ${raw.id}: latency profiles cannot silently fall back to A100`);
  }
  if (raw.gpuCount !== 1) invalid(`profile ${raw.id}: gpuCount must be exactly 1`);
  if (raw.contextTokens !== 65_536 && raw.contextTokens !== 131_072) {
    invalid(`profile ${raw.id}: contextTokens must be 65536 or 131072`);
  }
  const imageDigest = typeof raw.imageDigest === "string" ? raw.imageDigest.trim() : "";
  if (imageDigest && !IMAGE_DIGEST_PATTERN.test(imageDigest)) {
    invalid(`profile ${raw.id}: imageDigest must be an immutable sha256 OCI reference`);
  }
  const workerBuildId =
    typeof raw.workerBuildId === "string" ? raw.workerBuildId.trim() : undefined;
  if (workerBuildId && !WORKER_BUILD_ID_PATTERN.test(workerBuildId)) {
    invalid(`profile ${raw.id}: workerBuildId must match r2-<12 lowercase hex>`);
  }
  const containerRegistryAuthId =
    typeof raw.containerRegistryAuthId === "string"
      ? raw.containerRegistryAuthId.trim()
      : undefined;
  if (containerRegistryAuthId && !REGISTRY_AUTH_ID_PATTERN.test(containerRegistryAuthId)) {
    invalid(`profile ${raw.id}: containerRegistryAuthId is invalid`);
  }
  const networkVolumeId =
    typeof raw.networkVolumeId === "string" ? raw.networkVolumeId.trim() : undefined;
  if (networkVolumeId && !VOLUME_ID_PATTERN.test(networkVolumeId)) {
    invalid(`profile ${raw.id}: networkVolumeId is invalid`);
  }
  const dailyBudgetUsd = optionalBudget(raw.dailyBudgetUsd, `profile ${raw.id}: dailyBudgetUsd`);
  const monthlyBudgetUsd = optionalBudget(
    raw.monthlyBudgetUsd,
    `profile ${raw.id}: monthlyBudgetUsd`,
  );
  const modelArtifacts = normalizeModelArtifacts(raw.modelArtifacts, raw.id!);
  if (
    dailyBudgetUsd !== undefined &&
    monthlyBudgetUsd !== undefined &&
    dailyBudgetUsd > monthlyBudgetUsd
  ) {
    invalid(`profile ${raw.id}: daily budget cannot exceed monthly budget`);
  }
  return {
    id: raw.id!,
    label,
    provider: "runpod",
    cloudType: "SECURE",
    performance: raw.performance,
    gpuTypeIds: [...raw.gpuTypeIds],
    gpuCount: 1,
    contextTokens: raw.contextTokens,
    imageDigest,
    ...(workerBuildId ? { workerBuildId } : {}),
    ...(containerRegistryAuthId ? { containerRegistryAuthId } : {}),
    ...(networkVolumeId ? { networkVolumeId } : {}),
    ...(modelArtifacts ? { modelArtifacts } : {}),
    maxGpuHourlyUsd: boundedNumber(
      raw.maxGpuHourlyUsd,
      `profile ${raw.id}: maxGpuHourlyUsd`,
      0.1,
      100,
    ),
    idleTimeoutSeconds: boundedNumber(
      raw.idleTimeoutSeconds,
      `profile ${raw.id}: idleTimeoutSeconds`,
      60,
      3_600,
    ),
    clarificationTimeoutSeconds: boundedNumber(
      raw.clarificationTimeoutSeconds,
      `profile ${raw.id}: clarificationTimeoutSeconds`,
      60,
      900,
    ),
    hardSessionLimitSeconds: boundedNumber(
      raw.hardSessionLimitSeconds,
      `profile ${raw.id}: hardSessionLimitSeconds`,
      600,
      86_400,
    ),
    ...(dailyBudgetUsd !== undefined ? { dailyBudgetUsd } : {}),
    ...(monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd } : {}),
  };
}

function normalizeUpdate(
  input: unknown,
  hasExistingKey: boolean,
  hasExistingCoordinatorToken: boolean,
  existingCoordinatorEndpoint?: string,
): ComputeConfigUpdateV1 {
  if (!input || typeof input !== "object") invalid("a compute configuration is required");
  const raw = input as Partial<ComputeConfigUpdateV1>;
  if (raw.version !== 1) invalid("compute configuration version must be 1");
  if (typeof raw.enabled !== "boolean") invalid("enabled must be boolean");
  if (raw.defaultBackend !== "local_process" && raw.defaultBackend !== "runpod_pod") {
    invalid("defaultBackend must be local_process or runpod_pod");
  }
  if (
    !Array.isArray(raw.profiles) ||
    raw.profiles.length < 1 ||
    raw.profiles.length > MAX_PROFILES
  ) {
    invalid(`profiles must contain between 1 and ${MAX_PROFILES} entries`);
  }
  const profiles = raw.profiles.map(normalizeProfile);
  const ids = new Set(profiles.map((profile) => profile.id));
  if (ids.size !== profiles.length) invalid("compute profile ids must be unique");
  if (typeof raw.activeProfileId !== "string" || !ids.has(raw.activeProfileId)) {
    invalid("activeProfileId must reference a configured profile");
  }
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : undefined;
  if (apiKey && apiKey.length > MAX_API_KEY_CHARS) invalid("RunPod API key is too long");
  if (apiKey && raw.clearApiKey) invalid("cannot set and clear the RunPod API key together");
  const watchdog = normalizeWatchdogUpdate(raw.watchdog);
  const coordinator = normalizeCoordinatorUpdate(raw.coordinator);
  const orchestrationMode = raw.orchestrationMode ?? "local_gateway";
  if (orchestrationMode !== "local_gateway" && orchestrationMode !== "cloud_coordinator") {
    invalid("orchestrationMode must be local_gateway or cloud_coordinator");
  }
  const willHaveKey = !!apiKey || (hasExistingKey && raw.clearApiKey !== true);
  const coordinatorEndpoint = coordinator?.endpointUrl ?? existingCoordinatorEndpoint;
  const willHaveCoordinatorToken =
    !!coordinator?.ingestToken ||
    (hasExistingCoordinatorToken && coordinator?.clearIngestToken !== true);
  if (raw.enabled && raw.defaultBackend === "runpod_pod") {
    const active = profiles.find((profile) => profile.id === raw.activeProfileId)!;
    if (!active.imageDigest) invalid("the active RunPod profile requires an immutable imageDigest");
    if (orchestrationMode === "cloud_coordinator" && !active.workerBuildId) {
      invalid("cloud coordinator mode requires the worker image build id");
    }
    if (!active.containerRegistryAuthId) {
      invalid("the active RunPod profile requires containerRegistryAuthId for the private image");
    }
    if (!active.networkVolumeId) invalid("the active RunPod profile requires networkVolumeId");
    if (!active.modelArtifacts) {
      invalid("the active RunPod profile requires checksum-bound modelArtifacts");
    }
    if (orchestrationMode === "local_gateway" && !willHaveKey) {
      invalid("the local RunPod gateway requires an API key");
    }
    if (orchestrationMode === "cloud_coordinator" && !coordinatorEndpoint) {
      invalid("cloud coordinator mode requires a coordinator endpointUrl");
    }
    if (orchestrationMode === "cloud_coordinator" && !willHaveCoordinatorToken) {
      invalid("cloud coordinator mode requires a coordinator ingest token");
    }
  }
  return {
    version: 1,
    enabled: raw.enabled,
    defaultBackend: raw.defaultBackend,
    profiles,
    activeProfileId: raw.activeProfileId,
    orchestrationMode,
    ...(apiKey ? { apiKey } : {}),
    clearApiKey: raw.clearApiKey === true,
    ...(watchdog ? { watchdog } : {}),
    ...(coordinator ? { coordinator } : {}),
  };
}

function normalizeCoordinatorUpdate(
  value: ComputeCoordinatorUpdateV1 | undefined,
): ComputeCoordinatorUpdateV1 | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") invalid("coordinator must be an object");
  const endpointUrl = normalizedCoordinatorEndpoint(value.endpointUrl);
  const ingestToken = typeof value.ingestToken === "string" ? value.ingestToken.trim() : undefined;
  if (ingestToken && !endpointUrl) {
    invalid("coordinator endpointUrl is required when setting an ingest token");
  }
  if (ingestToken && !WATCHDOG_TOKEN_PATTERN.test(ingestToken)) {
    invalid("coordinator ingestToken must be 32..512 base64url characters");
  }
  if (ingestToken && value.clearIngestToken) {
    invalid("cannot set and clear the coordinator ingest token together");
  }
  return {
    ...(endpointUrl ? { endpointUrl } : {}),
    ...(ingestToken ? { ingestToken } : {}),
    clearIngestToken: value.clearIngestToken === true,
  };
}

function normalizeWatchdogUpdate(
  value: ComputeWatchdogUpdateV1 | undefined,
): ComputeWatchdogUpdateV1 | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") invalid("watchdog must be an object");
  const endpointUrl = normalizedWatchdogEndpoint(value.endpointUrl);
  const ingestToken = typeof value.ingestToken === "string" ? value.ingestToken.trim() : undefined;
  if (ingestToken && !endpointUrl) {
    invalid("watchdog endpointUrl is required when setting an ingest token");
  }
  if (ingestToken && !WATCHDOG_TOKEN_PATTERN.test(ingestToken)) {
    invalid("watchdog ingestToken must be 32..512 base64url characters");
  }
  if (ingestToken && value.clearIngestToken) {
    invalid("cannot set and clear the watchdog ingest token together");
  }
  return {
    ...(endpointUrl ? { endpointUrl } : {}),
    ...(ingestToken ? { ingestToken } : {}),
    clearIngestToken: value.clearIngestToken === true,
  };
}

async function writeAtomic(file: string, text: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, text, { encoding: "utf8", mode });
  await fs.rename(temporary, file);
  await fs.chmod(file, mode);
}

function gatewayOwnedKeyPath(): string {
  return path.join(CONFIG.computeKeysDir, "runpod.key");
}

function isGatewayOwnedKeyPath(file: string | null): boolean {
  if (!file) return false;
  return path.resolve(file) === path.resolve(gatewayOwnedKeyPath());
}

function gatewayOwnedWatchdogPath(): string {
  return path.join(CONFIG.computeKeysDir, "watchdog-ingest.key");
}

function gatewayOwnedCoordinatorPath(): string {
  return path.join(CONFIG.computeKeysDir, "coordinator-ingest.key");
}

function isGatewayOwnedCoordinatorPath(file: string | null): boolean {
  if (!file) return false;
  return path.resolve(file) === path.resolve(gatewayOwnedCoordinatorPath());
}

function isGatewayOwnedWatchdogPath(file: string | null): boolean {
  if (!file) return false;
  return path.resolve(file) === path.resolve(gatewayOwnedWatchdogPath());
}

export async function readComputeConfig(): Promise<ComputeConfigV1> {
  const { config, source } = await readStoredConfig();
  return toPublic(config, source);
}

export async function readRunPodApiKey(): Promise<string | null> {
  const { config } = await readStoredConfig();
  const file = config.apiKeyFile ?? gatewayOwnedKeyPath();
  try {
    const key = (await fs.readFile(file, "utf8")).trim();
    return key || null;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export interface ComputeWatchdogAccess {
  endpointUrl: string;
  ingestToken: string;
}

export interface ComputeCoordinatorAccess {
  endpointUrl: string;
  ingestToken: string;
}

export async function readComputeCoordinatorAccess(): Promise<ComputeCoordinatorAccess | null> {
  const { config } = await readStoredConfig();
  if (!config.coordinator?.endpointUrl || !config.coordinator.tokenFile) return null;
  try {
    const ingestToken = (await fs.readFile(config.coordinator.tokenFile, "utf8")).trim();
    if (!WATCHDOG_TOKEN_PATTERN.test(ingestToken)) {
      throw new Error("stored coordinator ingest token is invalid");
    }
    return { endpointUrl: config.coordinator.endpointUrl, ingestToken };
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function markComputeCoordinatorVerified(
  result: ComputeCoordinatorTestResult,
): Promise<ComputeConfigV1> {
  const { config } = await readStoredConfig();
  if (!config.coordinator?.endpointUrl || !(await exists(config.coordinator.tokenFile))) {
    throw new ComputeConfigValidationError(
      "coordinator endpoint and ingest token must be saved before verification",
    );
  }
  const stored: StoredComputeConfig = {
    ...config,
    coordinator: {
      ...config.coordinator,
      verifiedAt: result.checkedAt,
      cacheSigningKeyId: result.cacheSigning.keyId,
    },
  };
  await writeAtomic(CONFIG.computeConfigPath, `${JSON.stringify(stored, null, 2)}\n`);
  return toPublic(stored, "saved");
}

export async function readComputeWatchdogAccess(): Promise<ComputeWatchdogAccess | null> {
  const { config } = await readStoredConfig();
  if (!config.watchdog?.endpointUrl || !config.watchdog.tokenFile) return null;
  try {
    const ingestToken = (await fs.readFile(config.watchdog.tokenFile, "utf8")).trim();
    if (!WATCHDOG_TOKEN_PATTERN.test(ingestToken)) {
      throw new Error("stored watchdog ingest token is invalid");
    }
    return { endpointUrl: config.watchdog.endpointUrl, ingestToken };
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function markComputeWatchdogVerified(
  result: ComputeWatchdogTestResult,
): Promise<ComputeConfigV1> {
  const { config } = await readStoredConfig();
  if (!config.watchdog?.endpointUrl || !(await exists(config.watchdog.tokenFile))) {
    throw new ComputeConfigValidationError(
      "watchdog endpoint and ingest token must be saved before verification",
    );
  }
  const stored: StoredComputeConfig = {
    ...config,
    watchdog: {
      ...config.watchdog,
      verifiedAt: result.checkedAt,
      ...(result.lastSweepAt ? { lastSweepAt: result.lastSweepAt } : {}),
    },
  };
  await writeAtomic(CONFIG.computeConfigPath, `${JSON.stringify(stored, null, 2)}\n`);
  return toPublic(stored, "saved");
}

export async function saveComputeConfig(input: unknown): Promise<ComputeConfigV1> {
  const { config: current } = await readStoredConfig();
  const hasExistingKey = await exists(current.apiKeyFile);
  const hasExistingCoordinatorToken = await exists(current.coordinator?.tokenFile ?? null);
  const update = normalizeUpdate(
    input,
    hasExistingKey,
    hasExistingCoordinatorToken,
    current.coordinator?.endpointUrl,
  );
  const safeKeyPath = gatewayOwnedKeyPath();
  let apiKeyFile = current.apiKeyFile;
  if (update.apiKey) {
    await writeAtomic(safeKeyPath, `${update.apiKey}\n`);
    apiKeyFile = safeKeyPath;
  } else if (update.clearApiKey) {
    apiKeyFile = null;
  }
  const safeWatchdogPath = gatewayOwnedWatchdogPath();
  let watchdog = current.watchdog ?? null;
  if (update.watchdog) {
    const endpointUrl = update.watchdog.endpointUrl;
    let tokenFile = watchdog?.tokenFile ?? null;
    if (update.watchdog.ingestToken) {
      await writeAtomic(safeWatchdogPath, `${update.watchdog.ingestToken}\n`);
      tokenFile = safeWatchdogPath;
    } else if (update.watchdog.clearIngestToken) {
      tokenFile = null;
    }
    const endpointChanged = endpointUrl !== watchdog?.endpointUrl;
    const tokenChanged = Boolean(update.watchdog.ingestToken || update.watchdog.clearIngestToken);
    watchdog = endpointUrl
      ? {
          endpointUrl,
          tokenFile,
          ...(!endpointChanged && !tokenChanged && watchdog?.verifiedAt
            ? { verifiedAt: watchdog.verifiedAt }
            : {}),
          ...(!endpointChanged && !tokenChanged && watchdog?.lastSweepAt
            ? { lastSweepAt: watchdog.lastSweepAt }
            : {}),
        }
      : null;
  }
  const safeCoordinatorPath = gatewayOwnedCoordinatorPath();
  let coordinator = current.coordinator ?? null;
  if (update.coordinator) {
    const endpointUrl = update.coordinator.endpointUrl;
    let tokenFile = coordinator?.tokenFile ?? null;
    if (update.coordinator.ingestToken) {
      await writeAtomic(safeCoordinatorPath, `${update.coordinator.ingestToken}\n`);
      tokenFile = safeCoordinatorPath;
    } else if (update.coordinator.clearIngestToken) {
      tokenFile = null;
    }
    const endpointChanged = endpointUrl !== coordinator?.endpointUrl;
    const tokenChanged = Boolean(
      update.coordinator.ingestToken || update.coordinator.clearIngestToken,
    );
    coordinator = endpointUrl
      ? {
          endpointUrl,
          tokenFile,
          ...(!endpointChanged && !tokenChanged && coordinator?.verifiedAt
            ? { verifiedAt: coordinator.verifiedAt }
            : {}),
          ...(!endpointChanged && !tokenChanged && coordinator?.cacheSigningKeyId
            ? { cacheSigningKeyId: coordinator.cacheSigningKeyId }
            : {}),
        }
      : null;
  }
  const stored: StoredComputeConfig = {
    version: 1,
    enabled: update.enabled,
    defaultBackend: update.defaultBackend,
    profiles: update.profiles,
    activeProfileId: update.activeProfileId,
    orchestrationMode: update.orchestrationMode ?? "local_gateway",
    apiKeyFile,
    watchdog,
    coordinator,
  };
  await writeAtomic(CONFIG.computeConfigPath, `${JSON.stringify(stored, null, 2)}\n`);
  if (
    update.clearApiKey &&
    isGatewayOwnedKeyPath(current.apiKeyFile) &&
    current.apiKeyFile !== apiKeyFile
  ) {
    await fs.unlink(current.apiKeyFile!).catch((error: any) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  if (
    (update.watchdog?.clearIngestToken || (update.watchdog !== undefined && watchdog === null)) &&
    isGatewayOwnedWatchdogPath(current.watchdog?.tokenFile ?? null) &&
    current.watchdog?.tokenFile !== watchdog?.tokenFile
  ) {
    await fs.unlink(current.watchdog!.tokenFile!).catch((error: any) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  if (
    (update.coordinator?.clearIngestToken ||
      (update.coordinator !== undefined && coordinator === null)) &&
    isGatewayOwnedCoordinatorPath(current.coordinator?.tokenFile ?? null) &&
    current.coordinator?.tokenFile !== coordinator?.tokenFile
  ) {
    await fs.unlink(current.coordinator!.tokenFile!).catch((error: any) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return toPublic(stored, "saved");
}
