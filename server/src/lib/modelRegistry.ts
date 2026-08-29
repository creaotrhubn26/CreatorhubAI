import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  ModelRegistry,
  ModelRegistryEntry,
  ModelRegistryUpdate,
  ModelRegistryUpdateEntry,
  ModelRole,
  AdaptiveRoutingConfig,
} from "@glimmer/shared";
import { CONFIG } from "../config.js";

const ROLES: ModelRole[] = ["engineer", "architect", "consult", "vision"];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_MODELS = 20;
const MAX_API_KEY_CHARS = 16_384;

export class ModelRegistryValidationError extends Error {}

function invalid(message: string): never {
  throw new ModelRegistryValidationError(message);
}

interface StoredModel {
  id: string;
  label: string;
  baseUrl: string;
  modelId: string;
  apiKeyFile: string | null;
}

interface StoredRegistry {
  version: 1;
  models: StoredModel[];
  roles: Record<ModelRole, string>;
  routing?: AdaptiveRoutingConfig;
}

function defaultRouting(): AdaptiveRoutingConfig {
  return {
    enabled: false,
    highRisk: {},
    criticProviderId: null,
    requireIndependentCritic: false,
  };
}

function defaultStoredRegistry(): StoredRegistry {
  return {
    version: 1,
    models: [
      {
        id: "local",
        label: "Local Glimmer",
        baseUrl: CONFIG.modelBaseUrl.replace(/\/+$/, ""),
        modelId: "muse-glimmer",
        apiKeyFile: CONFIG.modelApiKeyFile,
      },
    ],
    roles: { engineer: "local", architect: "local", consult: "local", vision: "local" },
    routing: defaultRouting(),
  };
}

function validBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !!parsed.host &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function isStoredRegistry(value: unknown): value is StoredRegistry {
  if (!value || typeof value !== "object") return false;
  const raw = value as Partial<StoredRegistry>;
  if (raw.version !== 1 || !Array.isArray(raw.models) || !raw.models.length || !raw.roles)
    return false;
  const ids = new Set<string>();
  for (const model of raw.models) {
    if (!model || typeof model !== "object") return false;
    if (!ID_PATTERN.test(model.id) || ids.has(model.id)) return false;
    ids.add(model.id);
    if (!model.label?.trim() || !validBaseUrl(model.baseUrl) || !model.modelId?.trim())
      return false;
    if (model.apiKeyFile !== null && typeof model.apiKeyFile !== "string") return false;
  }
  if (!ROLES.every((role) => typeof raw.roles![role] === "string" && ids.has(raw.roles![role])))
    return false;
  if (raw.routing !== undefined) {
    if (
      typeof raw.routing !== "object" ||
      typeof raw.routing.enabled !== "boolean" ||
      typeof raw.routing.requireIndependentCritic !== "boolean" ||
      (raw.routing.criticProviderId !== null && !ids.has(raw.routing.criticProviderId)) ||
      !raw.routing.highRisk ||
      typeof raw.routing.highRisk !== "object" ||
      Object.entries(raw.routing.highRisk).some(
        ([role, provider]) =>
          !ROLES.includes(role as ModelRole) || typeof provider !== "string" || !ids.has(provider),
      )
    )
      return false;
  }
  return true;
}

async function readStoredRegistry(): Promise<{
  registry: StoredRegistry;
  source: "default" | "saved";
}> {
  try {
    const parsed = JSON.parse(await fs.readFile(CONFIG.modelConfigPath, "utf8"));
    if (isStoredRegistry(parsed)) return { registry: parsed, source: "saved" };
  } catch (err: any) {
    if (err?.code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
  }
  return { registry: defaultStoredRegistry(), source: "default" };
}

async function exists(file: string | null): Promise<boolean> {
  if (!file) return false;
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function toPublic(
  registry: StoredRegistry,
  source: "default" | "saved",
): Promise<ModelRegistry> {
  const models: ModelRegistryEntry[] = await Promise.all(
    registry.models.map(async (model) => ({
      id: model.id,
      label: model.label,
      baseUrl: model.baseUrl,
      modelId: model.modelId,
      hasApiKey: await exists(model.apiKeyFile),
    })),
  );
  return {
    version: 1,
    models,
    roles: registry.roles,
    routing: registry.routing ?? defaultRouting(),
    source,
  };
}

export async function readModelRegistry(): Promise<ModelRegistry> {
  const { registry, source } = await readStoredRegistry();
  return toPublic(registry, source);
}

function normalizeUpdate(input: unknown): ModelRegistryUpdate {
  if (!input || typeof input !== "object") invalid("a model registry is required");
  const raw = input as Partial<ModelRegistryUpdate>;
  if (!Array.isArray(raw.models) || raw.models.length < 1 || raw.models.length > MAX_MODELS) {
    invalid(`models must contain between 1 and ${MAX_MODELS} entries`);
  }
  const ids = new Set<string>();
  const models: ModelRegistryUpdateEntry[] = raw.models.map((model) => {
    if (
      !model ||
      typeof model !== "object" ||
      !ID_PATTERN.test(model.id ?? "") ||
      ids.has(model.id)
    ) {
      invalid(
        "each model id must be unique and contain only letters, numbers, dot, underscore, or dash",
      );
    }
    ids.add(model.id);
    const label = typeof model.label === "string" ? model.label.trim() : "";
    const baseUrl =
      typeof model.baseUrl === "string" ? model.baseUrl.trim().replace(/\/+$/, "") : "";
    const modelId = typeof model.modelId === "string" ? model.modelId.trim() : "";
    if (!label || label.length > 120)
      invalid(`model ${model.id}: label is required and must be at most 120 characters`);
    if (!validBaseUrl(baseUrl))
      invalid(
        `model ${model.id}: baseUrl must be an http(s) URL without credentials, query, or fragment`,
      );
    if (!modelId || modelId.length > 200)
      invalid(`model ${model.id}: modelId is required and must be at most 200 characters`);
    const apiKey = typeof model.apiKey === "string" ? model.apiKey.trim() : undefined;
    if (apiKey && apiKey.length > MAX_API_KEY_CHARS)
      invalid(`model ${model.id}: apiKey is too long`);
    if (apiKey && model.clearApiKey)
      invalid(`model ${model.id}: cannot set and clear an API key together`);
    return {
      id: model.id,
      label,
      baseUrl,
      modelId,
      ...(apiKey ? { apiKey } : {}),
      clearApiKey: model.clearApiKey === true,
    };
  });
  if (!raw.roles || typeof raw.roles !== "object") invalid("all model roles are required");
  const roles = {} as Record<ModelRole, string>;
  for (const role of ROLES) {
    const providerId = raw.roles[role];
    if (typeof providerId !== "string" || !ids.has(providerId)) {
      invalid(`role ${role} must reference a configured model`);
    }
    roles[role] = providerId;
  }
  let routing: AdaptiveRoutingConfig | undefined;
  if (raw.routing !== undefined) {
    if (!raw.routing || typeof raw.routing !== "object") invalid("routing must be an object");
    const highRisk: Partial<Record<ModelRole, string>> = {};
    for (const [role, provider] of Object.entries(raw.routing.highRisk ?? {})) {
      if (!ROLES.includes(role as ModelRole) || typeof provider !== "string" || !ids.has(provider))
        invalid(`high-risk role ${role} must reference a configured model`);
      highRisk[role as ModelRole] = provider;
    }
    const criticProviderId = raw.routing.criticProviderId ?? null;
    if (criticProviderId !== null && !ids.has(criticProviderId))
      invalid("criticProviderId must reference a configured model");
    routing = {
      enabled: raw.routing.enabled === true,
      highRisk,
      criticProviderId,
      requireIndependentCritic: raw.routing.requireIndependentCritic === true,
    };
  }
  return { models, roles, ...(routing ? { routing } : {}) };
}

async function writeAtomic(file: string, text: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, text, { encoding: "utf8", mode });
  await fs.rename(temporary, file);
  await fs.chmod(file, mode);
}

function gatewayOwnedKeyPath(modelId: string): string {
  // A digest keeps distinct case-sensitive registry ids distinct even on
  // the case-insensitive filesystems common on macOS.
  const fileId = createHash("sha256").update(modelId).digest("hex").slice(0, 24);
  return path.join(CONFIG.modelKeysDir, `${fileId}.key`);
}

function isGatewayOwnedKeyPath(file: string | null): boolean {
  if (!file) return false;
  const root = path.resolve(CONFIG.modelKeysDir);
  const target = path.resolve(file);
  return target.startsWith(root + path.sep);
}

export async function saveModelRegistry(input: unknown): Promise<ModelRegistry> {
  const update = normalizeUpdate(input);
  const { registry: current } = await readStoredRegistry();
  const currentById = new Map(current.models.map((model) => [model.id, model]));
  const storedModels: StoredModel[] = [];

  for (const model of update.models) {
    const safeKeyPath = gatewayOwnedKeyPath(model.id);
    let apiKeyFile = currentById.get(model.id)?.apiKeyFile ?? null;
    if (model.apiKey) {
      await writeAtomic(safeKeyPath, `${model.apiKey}\n`, 0o600);
      apiKeyFile = safeKeyPath;
    } else if (model.clearApiKey) {
      apiKeyFile = null;
    }
    storedModels.push({
      id: model.id,
      label: model.label,
      baseUrl: model.baseUrl,
      modelId: model.modelId,
      apiKeyFile,
    });
  }

  const stored: StoredRegistry = {
    version: 1,
    models: storedModels,
    roles: update.roles,
    routing: update.routing ?? current.routing ?? defaultRouting(),
  };
  await writeAtomic(CONFIG.modelConfigPath, `${JSON.stringify(stored, null, 2)}\n`, 0o600);

  // Delete only key files the gateway itself owns. A legacy/manual key path
  // may be detached from the registry, but this API never deletes arbitrary
  // user files outside its dedicated key directory.
  const kept = new Set(storedModels.map((model) => model.id));
  const referencedKeyFiles = new Set(
    storedModels.flatMap((model) => (model.apiKeyFile ? [path.resolve(model.apiKeyFile)] : [])),
  );
  for (const old of current.models) {
    const replacement = update.models.find((model) => model.id === old.id);
    if (
      (!kept.has(old.id) || replacement?.clearApiKey) &&
      isGatewayOwnedKeyPath(old.apiKeyFile) &&
      !referencedKeyFiles.has(path.resolve(old.apiKeyFile!))
    ) {
      await fs.unlink(old.apiKeyFile!).catch((err: any) => {
        if (err?.code !== "ENOENT") throw err;
      });
    }
  }

  return toPublic(stored, "saved");
}
