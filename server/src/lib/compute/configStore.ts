import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ComputeBackend,
  ComputeConfigUpdateV1,
  ComputeConfigV1,
  ComputeProfileUpdateV1,
  ComputeProfileV1,
  RunPodGpuTypeId,
} from "@glimmer/shared";
import { CONFIG } from "../../config.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VOLUME_ID_PATTERN = /^[A-Za-z0-9_-]{1,191}$/;
const REGISTRY_AUTH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/;
const IMAGE_DIGEST_PATTERN = /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_API_KEY_CHARS = 16_384;
const MAX_PROFILES = 8;
export const DEFAULT_RUNPOD_IMAGE_DIGEST =
  "ghcr.io/creaotrhubn26/glimmer-runpod-worker@sha256:27426914e48cc3438a2f88c93b383d73fb6a1776f87874f5c9495e8e3e72b35f";

export const RUNPOD_A100_GPU_IDS: RunPodGpuTypeId[] = [
  "NVIDIA A100 80GB PCIe",
  "NVIDIA A100-SXM4-80GB",
];
export const RUNPOD_H100_GPU_IDS: RunPodGpuTypeId[] = ["NVIDIA H100 PCIe", "NVIDIA H100 80GB HBM3"];
const RUNPOD_GPU_IDS = new Set<RunPodGpuTypeId>([...RUNPOD_A100_GPU_IDS, ...RUNPOD_H100_GPU_IDS]);

type StoredComputeProfile = ComputeProfileUpdateV1;

interface StoredComputeConfig {
  version: 1;
  enabled: boolean;
  defaultBackend: ComputeBackend;
  profiles: StoredComputeProfile[];
  activeProfileId?: string;
  apiKeyFile: string | null;
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
    apiKeyFile: null,
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
    (raw.apiKeyFile !== null &&
      (typeof raw.apiKeyFile !== "string" || !isGatewayOwnedKeyPath(raw.apiKeyFile)))
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
        config: { ...parsed, profiles: parsed.profiles.map(normalizeProfile) },
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
  const profiles: ComputeProfileV1[] = config.profiles.map((profile) => ({
    ...profile,
    hasApiKey,
    // R1 deliberately does not accept a boolean assertion from the UI. A
    // later milestone sets this only after a real watchdog handshake.
    watchdogConfigured: false,
  }));
  return {
    version: 1,
    enabled: config.enabled,
    defaultBackend: config.defaultBackend,
    profiles,
    ...(config.activeProfileId ? { activeProfileId: config.activeProfileId } : {}),
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

function normalizeUpdate(input: unknown, hasExistingKey: boolean): ComputeConfigUpdateV1 {
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
  const willHaveKey = !!apiKey || (hasExistingKey && raw.clearApiKey !== true);
  if (raw.enabled && raw.defaultBackend === "runpod_pod") {
    const active = profiles.find((profile) => profile.id === raw.activeProfileId)!;
    if (!active.imageDigest) invalid("the active RunPod profile requires an immutable imageDigest");
    if (!active.containerRegistryAuthId) {
      invalid("the active RunPod profile requires containerRegistryAuthId for the private image");
    }
    if (!active.networkVolumeId) invalid("the active RunPod profile requires networkVolumeId");
    if (!active.modelArtifacts) {
      invalid("the active RunPod profile requires checksum-bound modelArtifacts");
    }
    if (!willHaveKey) invalid("the active RunPod backend requires an API key");
  }
  return {
    version: 1,
    enabled: raw.enabled,
    defaultBackend: raw.defaultBackend,
    profiles,
    activeProfileId: raw.activeProfileId,
    ...(apiKey ? { apiKey } : {}),
    clearApiKey: raw.clearApiKey === true,
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

export async function saveComputeConfig(input: unknown): Promise<ComputeConfigV1> {
  const { config: current } = await readStoredConfig();
  const hasExistingKey = await exists(current.apiKeyFile);
  const update = normalizeUpdate(input, hasExistingKey);
  const safeKeyPath = gatewayOwnedKeyPath();
  let apiKeyFile = current.apiKeyFile;
  if (update.apiKey) {
    await writeAtomic(safeKeyPath, `${update.apiKey}\n`);
    apiKeyFile = safeKeyPath;
  } else if (update.clearApiKey) {
    apiKeyFile = null;
  }
  const stored: StoredComputeConfig = {
    version: 1,
    enabled: update.enabled,
    defaultBackend: update.defaultBackend,
    profiles: update.profiles,
    activeProfileId: update.activeProfileId,
    apiKeyFile,
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
  return toPublic(stored, "saved");
}
