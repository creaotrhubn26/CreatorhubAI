import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  MobbinCredentialUpdate,
  MobbinIntegrationStatus,
  MobbinScreen,
  MobbinSearchRequest,
  MobbinSearchResult,
} from "@glimmer/shared";
import { CONFIG } from "../config.js";

const MOBBIN_ORIGIN = "https://api.mobbin.com" as const;
const MOBBIN_SEARCH_URL = `${MOBBIN_ORIGIN}/v1/screens/search`;
const IMAGE_TOKEN_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const IMAGE_PROXY_TTL_MS = 15 * 60 * 1_000;
const IMAGE_PROXY_MAX_ENTRIES = 160;
const IMAGE_PROXY_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

interface CachedImageSource {
  url: string;
  expiresAt: number;
}

type NormalizedMobbinScreen = Omit<MobbinScreen, "imageToken"> & { remoteImageUrl: string };

const imageSources = new Map<string, CachedImageSource>();

export class MobbinIntegrationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

async function readApiKey(file = CONFIG.mobbinApiKeyFile): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size < 8 || stat.size > 4_096) return null;
    const key = (await fs.readFile(file, "utf8")).trim();
    return key.length >= 8 && key.length <= 4_096 ? key : null;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function mobbinStatus(
  keyPath = CONFIG.mobbinApiKeyFile,
): Promise<MobbinIntegrationStatus> {
  return {
    configured: !!(await readApiKey(keyPath)),
    keyPath,
    docsUrl: "https://docs.mobbin.com/api/quickstart",
    availability: "team-enterprise-api",
    policy: {
      credentialsReturnedByApi: false,
      fixedApiOrigin: MOBBIN_ORIGIN,
      imageUrlsAreRemoteAndExpiring: true,
      imagesProxiedThroughGateway: true,
    },
  };
}

export async function saveMobbinApiKey(
  input: unknown,
  keyPath = CONFIG.mobbinApiKeyFile,
): Promise<void> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "apiKey")
  ) {
    throw new MobbinIntegrationError("only apiKey is accepted");
  }
  const apiKey = (input as Partial<MobbinCredentialUpdate>).apiKey;
  if (typeof apiKey !== "string" || apiKey.trim().length < 8 || apiKey.trim().length > 4_096) {
    throw new MobbinIntegrationError("apiKey must contain 8 to 4096 characters");
  }
  await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const temporary = `${keyPath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${apiKey.trim()}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, keyPath);
  await fs.chmod(keyPath, 0o600);
}

function normalizeSearch(input: unknown): Required<MobbinSearchRequest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new MobbinIntegrationError("Mobbin search must be an object");
  }
  if (Object.keys(input).some((key) => !["query", "platform", "mode", "limit"].includes(key))) {
    throw new MobbinIntegrationError("Mobbin search contains unsupported fields");
  }
  const raw = input as Partial<MobbinSearchRequest>;
  const query = typeof raw.query === "string" ? raw.query.trim() : "";
  if (!query || query.length > 500) {
    throw new MobbinIntegrationError("query must contain 1 to 500 characters");
  }
  if (raw.platform !== "ios" && raw.platform !== "web") {
    throw new MobbinIntegrationError("platform must be ios or web");
  }
  const mode = raw.mode ?? "standard";
  if (mode !== "standard" && mode !== "deep") {
    throw new MobbinIntegrationError("mode must be standard or deep");
  }
  const limit = raw.limit ?? 8;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new MobbinIntegrationError("limit must be an integer from 1 to 20");
  }
  return { query, platform: raw.platform, mode, limit };
}

function httpsUrl(value: unknown, officialMobbin = false): string | null {
  if (typeof value !== "string" || !value || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (officialMobbin && url.hostname !== "mobbin.com" && !url.hostname.endsWith(".mobbin.com")) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 20_000
    ? Number(value)
    : undefined;
}

function normalizeScreen(value: unknown): NormalizedMobbinScreen | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, any>;
  const id = typeof raw.id === "string" && raw.id.length <= 200 ? raw.id : null;
  const imageUrl = httpsUrl(raw.image?.url ?? raw.image_url);
  const mobbinUrl = httpsUrl(raw.mobbin_url, true);
  const appName =
    typeof raw.app_name === "string" && raw.app_name.trim() && raw.app_name.length <= 200
      ? raw.app_name.trim()
      : null;
  if (
    !id ||
    !imageUrl ||
    !mobbinUrl ||
    !appName ||
    (raw.platform !== "ios" && raw.platform !== "web")
  ) {
    return null;
  }
  const imageWidth = positiveInteger(raw.image?.width);
  const imageHeight = positiveInteger(raw.image?.height);
  const imageExpiresAt =
    typeof raw.image?.url_expires_at === "string" && raw.image.url_expires_at.length <= 64
      ? raw.image.url_expires_at
      : undefined;
  return {
    id,
    remoteImageUrl: imageUrl,
    ...(imageWidth ? { imageWidth } : {}),
    ...(imageHeight ? { imageHeight } : {}),
    ...(imageExpiresAt ? { imageExpiresAt } : {}),
    mobbinUrl,
    appName,
    platform: raw.platform,
  };
}

function cacheImageSource(screen: NormalizedMobbinScreen): MobbinScreen {
  const now = Date.now();
  for (const [token, source] of imageSources) {
    if (source.expiresAt <= now) imageSources.delete(token);
  }
  while (imageSources.size >= IMAGE_PROXY_MAX_ENTRIES) {
    const oldest = imageSources.keys().next().value;
    if (!oldest) break;
    imageSources.delete(oldest);
  }
  const upstreamExpiry = screen.imageExpiresAt ? Date.parse(screen.imageExpiresAt) : Number.NaN;
  const expiresAt = Number.isFinite(upstreamExpiry)
    ? Math.min(now + IMAGE_PROXY_TTL_MS, Math.max(now + 1_000, upstreamExpiry))
    : now + IMAGE_PROXY_TTL_MS;
  const imageToken = randomUUID();
  imageSources.set(imageToken, { url: screen.remoteImageUrl, expiresAt });
  const { remoteImageUrl: _privateUrl, ...safe } = screen;
  return { ...safe, imageToken };
}

async function boundedImageBody(response: Response): Promise<Buffer> {
  if (!response.body) throw new MobbinIntegrationError("Mobbin image response was empty", 502);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > IMAGE_PROXY_MAX_BYTES) {
    throw new MobbinIntegrationError("Mobbin image exceeded the 10 MiB limit", 502);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > IMAGE_PROXY_MAX_BYTES) {
      await reader.cancel();
      throw new MobbinIntegrationError("Mobbin image exceeded the 10 MiB limit", 502);
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

export async function readMobbinImage(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<{ bytes: Buffer; contentType: string }> {
  if (!IMAGE_TOKEN_RE.test(token)) {
    throw new MobbinIntegrationError("Mobbin image was not found", 404);
  }
  const source = imageSources.get(token);
  if (!source || source.expiresAt <= Date.now()) {
    imageSources.delete(token);
    throw new MobbinIntegrationError("Mobbin image preview expired; search again", 404);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetcher(source.url, {
      signal: controller.signal,
      redirect: "error",
      headers: { Accept: "image/png,image/jpeg,image/webp" },
    });
  } catch {
    throw new MobbinIntegrationError("Could not load the Mobbin image preview", 502);
  } finally {
    clearTimeout(timeout);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim() ?? "";
  if (!response.ok || !IMAGE_CONTENT_TYPES.has(contentType)) {
    throw new MobbinIntegrationError("Mobbin returned an invalid image preview", 502);
  }
  return { bytes: await boundedImageBody(response), contentType };
}

export async function searchMobbin(
  input: unknown,
  options: { keyPath?: string; fetcher?: typeof fetch } = {},
): Promise<MobbinSearchResult> {
  const request = normalizeSearch(input);
  const apiKey = await readApiKey(options.keyPath ?? CONFIG.mobbinApiKeyFile);
  if (!apiKey) {
    throw new MobbinIntegrationError("Connect a Mobbin Team or Enterprise API key first", 409);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(MOBBIN_SEARCH_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: request.query,
        platform: request.platform,
        mode: request.mode,
        limit: request.limit,
        image_quality: "optimized",
        exclude_screen_ids: [],
      }),
    });
  } catch (error) {
    throw new MobbinIntegrationError(
      error instanceof Error && error.name === "AbortError"
        ? "Mobbin search timed out"
        : "Could not reach Mobbin",
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
  const body = (await response.json().catch(() => null)) as any;
  if (!response.ok) {
    const upstreamMessage =
      typeof body?.error?.message === "string" ? body.error.message.slice(0, 300) : null;
    throw new MobbinIntegrationError(
      response.status === 401 || response.status === 403
        ? "Mobbin rejected the configured API key or plan"
        : upstreamMessage || `Mobbin search failed with status ${response.status}`,
      502,
    );
  }
  if (!body || !Array.isArray(body.screens)) {
    throw new MobbinIntegrationError("Mobbin returned an invalid search response", 502);
  }
  return {
    query: request.query,
    platform: request.platform,
    screens: body.screens.flatMap((screen: unknown) => {
      const normalized = normalizeScreen(screen);
      return normalized ? [cacheImageSource(normalized)] : [];
    }),
  };
}
