import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DesignCatalogCollection,
  DesignCatalogCustomProfileInput,
  DesignCatalogFacets,
  DesignCatalogLibrary,
  DesignCatalogProfile,
  DesignCatalogSearchRequest,
  DesignCatalogSearchResult,
} from "@glimmer/shared";
import { CONFIG } from "../config.js";

const PROFILE = "creatorhub-engineering";
const MAX_CATALOG_BYTES = 12 * 1024 * 1024;
const MAX_PROFILES = 500;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const SAFE_CUSTOM_ID = /^custom-[a-f0-9-]{36}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const PROFILE_TYPES = new Set([
  "brand-derived",
  "visual-archetype",
  "product-domain",
  "layout-pattern",
  "starter",
]);

interface CatalogOptions {
  homeDirectory?: string;
  catalogPath?: string;
  libraryPath?: string;
}

interface RawCatalog {
  schemaVersion?: unknown;
  generatedAt?: unknown;
  count?: unknown;
  facets?: unknown;
  profiles?: unknown;
}

interface LoadedCatalog {
  version: string;
  generatedAt: string;
  profiles: DesignCatalogProfile[];
  searchText: Map<string, string>;
  facets: DesignCatalogFacets;
}

let catalogCache:
  { file: string; modifiedAt: number; size: number; value: LoadedCatalog } | undefined;

export class DesignCatalogError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function bounded(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}

function strings(value: unknown, maxItems = 30, maxChars = 200): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const result: string[] = [];
  for (const item of value) {
    const text = bounded(item, maxChars);
    if (!text) return null;
    result.push(text);
  }
  return [...new Set(result)];
}

function numberScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.round(value)
    : null;
}

function versionParts(value: string): [number, number, number, string] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4]] : null;
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return left.localeCompare(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return Number(a[index]) - Number(b[index]);
  }
  return a[3].localeCompare(b[3]);
}

async function rejectSymlink(file: string) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new DesignCatalogError("Design catalogue source is not a regular file.", 409);
  }
  if (stat.size > MAX_CATALOG_BYTES) {
    throw new DesignCatalogError("Design catalogue exceeds the safe read limit.", 409);
  }
  return stat;
}

async function resolveCatalogPath(
  options: CatalogOptions,
): Promise<{ file: string; version: string }> {
  const configured = options.catalogPath ?? process.env.GLIMMER_DESIGN_CATALOG_PATH;
  if (configured) return { file: path.resolve(configured), version: "configured" };
  const home = options.homeDirectory ?? os.homedir();
  const codexRoot = path.join(home, ".codex", "plugins", "cache", "personal", PROFILE);
  const versions = await fs.readdir(codexRoot, { withFileTypes: true }).catch(() => []);
  const latest = versions
    .filter((entry) => entry.isDirectory() && versionParts(entry.name))
    .map((entry) => entry.name)
    .sort(compareVersions)
    .at(-1);
  if (latest) {
    return {
      file: path.join(codexRoot, latest, "assets", "design-systems", "catalog.json"),
      version: latest,
    };
  }
  const checkout = path.join(home, "plugins", PROFILE);
  const manifestFile = path.join(checkout, ".codex-plugin", "plugin.json");
  const manifest = await fs
    .readFile(manifestFile, "utf8")
    .then((value) => JSON.parse(value) as { version?: unknown })
    .catch((): { version?: unknown } => ({}));
  return {
    file: path.join(checkout, "assets", "design-systems", "catalog.json"),
    version: typeof manifest.version === "string" ? manifest.version : "checkout",
  };
}

function normalizeColors(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 20) return null;
  const result: Record<string, string> = {};
  for (const [role, raw] of entries) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(role) || typeof raw !== "string" || !HEX_COLOR.test(raw)) {
      return null;
    }
    result[role] = raw.toUpperCase();
  }
  return result;
}

function normalizeProfile(
  value: unknown,
): { profile: DesignCatalogProfile; searchText: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, any>;
  const id = bounded(raw.id, 100);
  const title = bounded(raw.title, 200);
  const description = bounded(raw.description, 2_000) ?? "";
  const version = bounded(raw.version, 100);
  const license = bounded(raw.license, 100);
  const category = bounded(raw.category, 120);
  const tags = strings(raw.tags, 40, 100);
  const platforms = strings(raw.platforms, 10, 40);
  const productKinds = strings(raw.productKinds, 20, 80);
  const components = strings(raw.components, 40, 80);
  const layouts = strings(raw.layouts, 30, 80);
  const colors = normalizeColors(raw.colors);
  const designHash = bounded(raw.sha256?.design, 64);
  const tones = strings(raw.characteristics?.tones, 20, 80);
  const modes = strings(raw.characteristics?.modes, 8, 40);
  const adopt = strings(raw.selection?.adopt, 20, 200);
  const verify = strings(raw.selection?.verify, 20, 500);
  const avoid = strings(raw.selection?.avoid, 20, 500);
  const substitutes = strings(raw.typography?.substitutes, 12, 100);
  const completeness = numberScore(raw.quality?.completeness);
  const richness = numberScore(raw.quality?.richness);
  const overall = numberScore(raw.quality?.overall);
  if (
    !id ||
    !SAFE_ID.test(id) ||
    !title ||
    !version ||
    !license ||
    !category ||
    !PROFILE_TYPES.has(raw.profileType) ||
    !tags ||
    !platforms ||
    !platforms.length ||
    !productKinds ||
    !components ||
    !layouts ||
    !colors ||
    !designHash ||
    !/^[a-f0-9]{64}$/i.test(designHash) ||
    !tones ||
    !modes ||
    !adopt ||
    !verify ||
    !avoid ||
    !substitutes ||
    completeness === null ||
    richness === null ||
    overall === null ||
    !["researched", "curated", "generated"].includes(raw.quality?.evidence) ||
    !["low", "medium", "high"].includes(raw.quality?.referenceRisk)
  )
    return null;
  const characteristic = (name: string, max = 80) => bounded(raw.characteristics?.[name], max);
  const density = characteristic("density");
  const contrast = characteristic("contrast");
  const geometry = characteristic("geometry");
  const elevation = characteristic("elevation");
  const motion = characteristic("motion");
  if (!density || !contrast || !geometry || !elevation || !motion) return null;
  const primary = bounded(raw.typography?.primary, 120) ?? "";
  const display = bounded(raw.typography?.display, 120) ?? primary;
  const mono = bounded(raw.typography?.mono, 120) ?? "";
  if (typeof raw.typography?.proprietary !== "boolean") return null;
  const profile: DesignCatalogProfile = {
    source: "creatorhub-catalog",
    id,
    title,
    description,
    version,
    designHash: designHash.toLowerCase(),
    license,
    category,
    profileType: raw.profileType,
    platforms,
    productKinds,
    tags,
    characteristics: { tones, density, contrast, geometry, elevation, modes, motion },
    typography: { primary, display, mono, proprietary: raw.typography.proprietary, substitutes },
    colors,
    components,
    layouts,
    quality: {
      completeness,
      richness,
      overall,
      evidence: raw.quality.evidence,
      referenceRisk: raw.quality.referenceRisk,
    },
    selection: { adopt, verify, avoid },
  };
  const indexed =
    bounded(raw.searchText, 50_000) ??
    [title, description, category, ...tags, ...tones, ...productKinds].join(" ");
  return { profile, searchText: indexed.toLowerCase() };
}

function facet(values: string[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function facets(version: string, profiles: DesignCatalogProfile[]): DesignCatalogFacets {
  return {
    schemaVersion: 2,
    catalogVersion: version,
    count: profiles.length,
    source: "creatorhub-engineering",
    categories: facet(profiles.map((item) => item.category)),
    profileTypes: facet(profiles.map((item) => item.profileType)),
    platforms: facet(profiles.flatMap((item) => item.platforms)),
    productKinds: facet(profiles.flatMap((item) => item.productKinds)),
    tones: facet(profiles.flatMap((item) => item.characteristics.tones)),
    densities: facet(profiles.map((item) => item.characteristics.density)),
    contrasts: facet(profiles.map((item) => item.characteristics.contrast)),
    modes: facet(profiles.flatMap((item) => item.characteristics.modes)),
  };
}

async function loadCatalog(options: CatalogOptions = {}): Promise<LoadedCatalog> {
  const source = await resolveCatalogPath(options);
  try {
    const stat = await rejectSymlink(source.file);
    if (
      catalogCache?.file === source.file &&
      catalogCache.modifiedAt === stat.mtimeMs &&
      catalogCache.size === stat.size
    ) {
      return catalogCache.value;
    }
    const parsed = JSON.parse(await fs.readFile(source.file, "utf8")) as RawCatalog;
    if (
      parsed.schemaVersion !== 2 ||
      !Array.isArray(parsed.profiles) ||
      parsed.profiles.length > MAX_PROFILES ||
      parsed.count !== parsed.profiles.length
    ) {
      throw new DesignCatalogError(
        "CreatorHub design catalogue is not a supported v2 catalogue.",
        409,
      );
    }
    const records = parsed.profiles.map((value, index) => {
      const normalized = normalizeProfile(value);
      if (!normalized) {
        throw new DesignCatalogError(
          `CreatorHub design catalogue contains an invalid profile at index ${index}.`,
          409,
        );
      }
      return normalized;
    });
    if (new Set(records.map((item) => item.profile.id)).size !== records.length) {
      throw new DesignCatalogError(
        "CreatorHub design catalogue contains duplicate profile ids.",
        409,
      );
    }
    const profiles = records.map((item) => item.profile);
    const loaded: LoadedCatalog = {
      version: source.version,
      generatedAt: bounded(parsed.generatedAt, 100) ?? "",
      profiles,
      searchText: new Map(records.map((item) => [item.profile.id, item.searchText])),
      facets: facets(source.version, profiles),
    };
    catalogCache = {
      file: source.file,
      modifiedAt: stat.mtimeMs,
      size: stat.size,
      value: loaded,
    };
    return loaded;
  } catch (error: any) {
    if (error instanceof DesignCatalogError) throw error;
    if (error?.code === "ENOENT") {
      throw new DesignCatalogError(
        "Install CreatorHub Engineering 0.5.0 or newer to use the design library.",
        404,
      );
    }
    if (error instanceof SyntaxError)
      throw new DesignCatalogError("CreatorHub design catalogue JSON is invalid.", 409);
    throw error;
  }
}

function libraryFile(options: CatalogOptions): string {
  return options.libraryPath ?? path.join(CONFIG.stateRoot, "design-catalog", "library.json");
}

const EMPTY_LIBRARY = (): DesignCatalogLibrary => ({
  version: 1,
  updatedAt: new Date(0).toISOString(),
  favorites: [],
  collections: [],
  customProfiles: [],
});

function normalizeCollection(value: unknown): DesignCatalogCollection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = bounded(raw.id, 100);
  const title = bounded(raw.title, 100);
  const profileIds = strings(raw.profileIds, 100, 100);
  return id && SAFE_ID.test(id) && title && profileIds ? { id, title, profileIds } : null;
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
}

export async function readDesignCatalogLibrary(
  options: CatalogOptions = {},
): Promise<DesignCatalogLibrary> {
  const file = libraryFile(options);
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024)
      throw new DesignCatalogError("Design library state is unsafe or too large.", 409);
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    const favorites = strings(raw.favorites, 500, 100);
    const collections = Array.isArray(raw.collections)
      ? raw.collections.map(normalizeCollection)
      : null;
    const customProfiles = Array.isArray(raw.customProfiles)
      ? raw.customProfiles.map((item) => normalizeCustomStoredProfile(item))
      : null;
    if (
      raw.version !== 1 ||
      !favorites ||
      !collections ||
      collections.some((item) => !item) ||
      !customProfiles ||
      customProfiles.some((item) => !item) ||
      customProfiles.length > 50
    ) {
      throw new DesignCatalogError("Design library state is invalid.", 409);
    }
    return {
      version: 1,
      updatedAt: bounded(raw.updatedAt, 100) ?? new Date(0).toISOString(),
      favorites,
      collections: collections as DesignCatalogCollection[],
      customProfiles: customProfiles as DesignCatalogProfile[],
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return EMPTY_LIBRARY();
    if (error instanceof SyntaxError)
      throw new DesignCatalogError("Design library state JSON is invalid.", 409);
    throw error;
  }
}

function normalizeCustomStoredProfile(value: unknown): DesignCatalogProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as DesignCatalogProfile;
  if (
    raw.source !== "custom" ||
    !SAFE_CUSTOM_ID.test(raw.id) ||
    raw.profileType !== "custom" ||
    !/^[a-f0-9]{64}$/.test(raw.designHash)
  )
    return null;
  const colors = normalizeColors(raw.colors);
  const tones = strings(raw.characteristics?.tones, 20, 80);
  const adopt = strings(raw.selection?.adopt, 20, 200);
  const avoid = strings(raw.selection?.avoid, 20, 500);
  const title = bounded(raw.title, 200);
  const description = bounded(raw.description, 2_000) ?? "";
  const category = bounded(raw.category, 120);
  const primary = bounded(raw.typography?.primary, 120) ?? "";
  const display = bounded(raw.typography?.display, 120) ?? primary;
  const mono = bounded(raw.typography?.mono, 120) ?? "";
  if (!colors || !tones || !adopt || !avoid || !title || !category) return null;
  return {
    source: "custom",
    id: raw.id,
    title,
    description,
    version: "1",
    designHash: raw.designHash,
    license: "User supplied",
    category,
    profileType: "custom",
    platforms: ["web"],
    productKinds: [],
    tags: [],
    characteristics: {
      tones,
      density: "balanced",
      contrast: "medium",
      geometry: "neutral",
      elevation: "subtle",
      modes: ["light"],
      motion: "moderate",
    },
    typography: { primary, display, mono, proprietary: false, substitutes: [] },
    colors,
    components: [],
    layouts: [],
    quality: {
      completeness: 60,
      richness: 50,
      overall: 56,
      evidence: "custom",
      referenceRisk: "low",
    },
    selection: {
      adopt,
      verify: ["contrast, responsive states, and repository token compatibility"],
      avoid,
    },
  };
}

function normalizedTokens(value: string): string[] {
  const synonyms: Record<string, string[]> = {
    rolig: ["calm", "quiet", "soft"],
    redaksjonell: ["editorial", "publication"],
    leken: ["playful", "friendly"],
    profesjonell: ["professional", "enterprise"],
    mørk: ["dark", "black"],
    lys: ["light", "bright"],
    oversikt: ["dashboard", "analytics"],
    utvikler: ["developer", "code", "terminal"],
  };
  const base = value
    .toLowerCase()
    .normalize("NFKD")
    .split(/[^a-z0-9#]+/)
    .filter((token) => token.length > 1);
  return [...new Set(base.flatMap((token) => [token, ...(synonyms[token] ?? [])]))];
}

function matchesFilter(
  profile: DesignCatalogProfile,
  filters: NonNullable<DesignCatalogSearchRequest["filters"]>,
): boolean {
  return (
    (!filters.category || profile.category === filters.category) &&
    (!filters.profileType || profile.profileType === filters.profileType) &&
    (!filters.platform || profile.platforms.includes(filters.platform)) &&
    (!filters.productKind || profile.productKinds.includes(filters.productKind)) &&
    (!filters.tone || profile.characteristics.tones.includes(filters.tone)) &&
    (!filters.density || profile.characteristics.density === filters.density) &&
    (!filters.contrast || profile.characteristics.contrast === filters.contrast) &&
    (!filters.mode || profile.characteristics.modes.includes(filters.mode))
  );
}

export async function designCatalogFacets(
  options: CatalogOptions = {},
): Promise<DesignCatalogFacets> {
  return (await loadCatalog(options)).facets;
}

export async function getDesignCatalogProfile(
  id: string,
  options: CatalogOptions = {},
): Promise<DesignCatalogProfile> {
  const catalog = await loadCatalog(options);
  const builtIn = catalog.profiles.find((profile) => profile.id === id);
  if (builtIn) return builtIn;
  const custom = (await readDesignCatalogLibrary(options)).customProfiles.find(
    (profile) => profile.id === id,
  );
  if (!custom) throw new DesignCatalogError("Design profile not found.", 404);
  return custom;
}

export async function searchDesignCatalog(
  input: unknown,
  options: CatalogOptions = {},
): Promise<DesignCatalogSearchResult> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new DesignCatalogError("Design catalogue search request is invalid.");
  const raw = input as Record<string, unknown>;
  const allowed = new Set(["query", "limit", "filters", "exclude", "projectContext"]);
  if (Object.keys(raw).some((key) => !allowed.has(key)))
    throw new DesignCatalogError("Design catalogue search contains unsupported fields.");
  const query = typeof raw.query === "string" && raw.query.length <= 500 ? raw.query.trim() : null;
  const limit = raw.limit === undefined ? 12 : Number(raw.limit);
  if (query === null || !Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new DesignCatalogError("Design catalogue query or limit is invalid.");
  const filters = raw.filters === undefined ? {} : raw.filters;
  if (!filters || typeof filters !== "object" || Array.isArray(filters))
    throw new DesignCatalogError("Design catalogue filters are invalid.");
  const filterKeys = new Set([
    "category",
    "profileType",
    "platform",
    "productKind",
    "tone",
    "density",
    "contrast",
    "mode",
  ]);
  if (
    Object.keys(filters).some((key) => !filterKeys.has(key)) ||
    Object.values(filters).some(
      (value) => typeof value !== "string" || !value.trim() || value.length > 120,
    )
  )
    throw new DesignCatalogError("Design catalogue filters are invalid.");
  const exclude = raw.exclude === undefined ? [] : strings(raw.exclude, 20, 100);
  if (!exclude) throw new DesignCatalogError("Design catalogue exclusions are invalid.");
  const context = raw.projectContext === undefined ? {} : raw.projectContext;
  if (!context || typeof context !== "object" || Array.isArray(context))
    throw new DesignCatalogError("Design catalogue project context is invalid.");
  const contextRaw = context as Record<string, unknown>;
  if (
    Object.keys(contextRaw).some(
      (key) => !["platform", "cms", "requirements", "tokenNames"].includes(key),
    )
  )
    throw new DesignCatalogError("Design catalogue project context is invalid.");
  const requirements =
    contextRaw.requirements === undefined ? [] : strings(contextRaw.requirements, 20, 500);
  const tokenNames =
    contextRaw.tokenNames === undefined ? [] : strings(contextRaw.tokenNames, 100, 120);
  if (!requirements || !tokenNames)
    throw new DesignCatalogError("Design catalogue project context is invalid.");
  const catalog = await loadCatalog(options);
  const library = await readDesignCatalogLibrary(options);
  const all = [...library.customProfiles, ...catalog.profiles];
  const textFor = (profile: DesignCatalogProfile) =>
    catalog.searchText.get(profile.id) ??
    [
      profile.title,
      profile.description,
      profile.category,
      ...profile.tags,
      ...profile.characteristics.tones,
      ...profile.productKinds,
    ]
      .join(" ")
      .toLowerCase();
  const tokens = normalizedTokens(query);
  const contextTokens = normalizedTokens(
    [
      bounded(contextRaw.platform, 80) ?? "",
      bounded(contextRaw.cms, 120) ?? "",
      ...requirements,
      ...tokenNames,
    ].join(" "),
  );
  const exclusions = normalizedTokens(exclude.join(" "));
  const scored = all
    .filter((profile) =>
      matchesFilter(profile, filters as NonNullable<DesignCatalogSearchRequest["filters"]>),
    )
    .filter((profile) => !exclusions.some((token) => textFor(profile).includes(token)))
    .map((profile) => {
      const haystack = textFor(profile);
      let score = profile.quality.overall / 25;
      const reasons: string[] = [];
      const conflicts: string[] = [];
      if (
        profile.id === query.toLowerCase() ||
        profile.title.toLowerCase() === query.toLowerCase()
      ) {
        score += 100;
        reasons.push("exact profile match");
      }
      const matched = tokens.filter((token) => haystack.includes(token));
      for (const token of tokens) {
        if (profile.id === token || profile.title.toLowerCase() === token) score += 24;
        if (profile.productKinds.includes(token)) score += 16;
        if (profile.characteristics.tones.includes(token)) score += 14;
        if (profile.characteristics.modes.includes(token)) score += 12;
        if (profile.tags.some((tag) => tag.toLowerCase() === token)) score += 10;
        if (normalizedTokens(profile.category).includes(token)) score += 9;
        if (
          normalizedTokens(
            [profile.typography.primary, profile.typography.display, profile.typography.mono].join(
              " ",
            ),
          ).includes(token)
        )
          score += 8;
        if (profile.description.toLowerCase().includes(token)) score += 6;
        if (haystack.includes(token)) score += 1;
      }
      score += contextTokens.filter((token) => haystack.includes(token)).length * 1.5;
      if (matched.length) reasons.push(`matched ${matched.slice(0, 5).join(", ")}`);
      if (profile.typography.proprietary)
        conflicts.push("uses a proprietary or licensed reference font");
      if (profile.quality.referenceRisk === "high")
        conflicts.push("brand-derived reference requires strict non-copy boundaries");
      return { ...profile, score: Math.round(score * 100) / 100, reasons, conflicts };
    })
    .filter((profile) => !query || profile.reasons.length)
    .sort(
      (a, b) =>
        (b.score ?? 0) - (a.score ?? 0) ||
        b.quality.overall - a.quality.overall ||
        a.id.localeCompare(b.id),
    );
  const results: DesignCatalogProfile[] = [];
  const categories = new Map<string, number>();
  for (const profile of scored) {
    if ((categories.get(profile.category) ?? 0) >= 3 && scored.length > limit) continue;
    results.push(profile);
    categories.set(profile.category, (categories.get(profile.category) ?? 0) + 1);
    if (results.length === limit) break;
  }
  return { query, total: results.length, catalogVersion: catalog.version, results };
}

export async function updateDesignCatalogLibrary(
  input: unknown,
  options: CatalogOptions = {},
): Promise<DesignCatalogLibrary> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new DesignCatalogError("Design library update is invalid.");
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["favorites", "collections"].includes(key)))
    throw new DesignCatalogError("Design library update contains unsupported fields.");
  const current = await readDesignCatalogLibrary(options);
  const favorites =
    raw.favorites === undefined ? current.favorites : strings(raw.favorites, 500, 100);
  const collections =
    raw.collections === undefined
      ? current.collections
      : Array.isArray(raw.collections)
        ? raw.collections.map(normalizeCollection)
        : null;
  if (!favorites || !collections || collections.some((item) => !item) || collections.length > 50)
    throw new DesignCatalogError("Design library favorites or collections are invalid.");
  const known = new Set([
    ...(await loadCatalog(options)).profiles.map((profile) => profile.id),
    ...current.customProfiles.map((profile) => profile.id),
  ]);
  if (
    favorites.some((id) => !known.has(id)) ||
    collections.some((item) => item!.profileIds.some((id) => !known.has(id)))
  )
    throw new DesignCatalogError("Design library references an unknown profile.");
  const next: DesignCatalogLibrary = {
    ...current,
    updatedAt: new Date().toISOString(),
    favorites,
    collections: collections as DesignCatalogCollection[],
  };
  await atomicJson(libraryFile(options), next);
  return next;
}

function customInput(input: unknown): DesignCatalogCustomProfileInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new DesignCatalogError("Custom design profile is invalid.");
  const raw = input as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) =>
        ![
          "title",
          "description",
          "category",
          "tones",
          "colors",
          "typography",
          "adopt",
          "avoid",
        ].includes(key),
    )
  )
    throw new DesignCatalogError("Custom design profile contains unsupported fields.");
  const title = bounded(raw.title, 200);
  const description = bounded(raw.description, 2_000) ?? "";
  const category = bounded(raw.category, 120);
  const tones = strings(raw.tones, 20, 80);
  const colors = normalizeColors(raw.colors);
  const adopt = strings(raw.adopt, 20, 200);
  const avoid = strings(raw.avoid, 20, 500);
  const typographyRaw = raw.typography === undefined ? {} : raw.typography;
  if (
    !typographyRaw ||
    typeof typographyRaw !== "object" ||
    Array.isArray(typographyRaw) ||
    Object.keys(typographyRaw).some((key) => !["primary", "display", "mono"].includes(key))
  )
    throw new DesignCatalogError("Custom profile typography is invalid.");
  const typography = Object.fromEntries(
    Object.entries(typographyRaw)
      .map(([key, value]) => [key, bounded(value, 120)])
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  if (
    !title ||
    !category ||
    !tones ||
    !tones.length ||
    !colors ||
    !Object.keys(colors).length ||
    !adopt ||
    !adopt.length ||
    !avoid
  )
    throw new DesignCatalogError(
      "Custom profile needs title, category, tone, color, and adopt direction.",
    );
  return { title, description, category, tones, colors, typography, adopt, avoid };
}

export async function createCustomDesignProfile(
  input: unknown,
  options: CatalogOptions = {},
): Promise<DesignCatalogLibrary> {
  const current = await readDesignCatalogLibrary(options);
  if (current.customProfiles.length >= 50)
    throw new DesignCatalogError("Design library may contain at most 50 custom profiles.", 409);
  const value = customInput(input);
  const canonical = JSON.stringify(value);
  const profile: DesignCatalogProfile = {
    source: "custom",
    id: `custom-${randomUUID()}`,
    title: value.title,
    description: value.description,
    version: "1",
    designHash: createHash("sha256").update(canonical).digest("hex"),
    license: "User supplied",
    category: value.category,
    profileType: "custom",
    platforms: ["web"],
    productKinds: [],
    tags: [],
    characteristics: {
      tones: value.tones,
      density: "balanced",
      contrast: "medium",
      geometry: "neutral",
      elevation: "subtle",
      modes: ["light"],
      motion: "moderate",
    },
    typography: {
      primary: value.typography?.primary ?? "",
      display: value.typography?.display ?? value.typography?.primary ?? "",
      mono: value.typography?.mono ?? "",
      proprietary: false,
      substitutes: [],
    },
    colors: value.colors,
    components: [],
    layouts: [],
    quality: {
      completeness: 60,
      richness: 50,
      overall: 56,
      evidence: "custom",
      referenceRisk: "low",
    },
    selection: {
      adopt: value.adopt,
      verify: ["contrast, responsive states, and repository token compatibility"],
      avoid: value.avoid,
    },
  };
  const next = {
    ...current,
    updatedAt: new Date().toISOString(),
    customProfiles: [profile, ...current.customProfiles],
  };
  await atomicJson(libraryFile(options), next);
  return next;
}

export async function deleteCustomDesignProfile(
  id: string,
  options: CatalogOptions = {},
): Promise<DesignCatalogLibrary> {
  if (!SAFE_CUSTOM_ID.test(id))
    throw new DesignCatalogError("Custom design profile id is invalid.");
  const current = await readDesignCatalogLibrary(options);
  if (!current.customProfiles.some((profile) => profile.id === id))
    throw new DesignCatalogError("Custom design profile not found.", 404);
  const next: DesignCatalogLibrary = {
    ...current,
    updatedAt: new Date().toISOString(),
    favorites: current.favorites.filter((profileId) => profileId !== id),
    collections: current.collections.map((collection) => ({
      ...collection,
      profileIds: collection.profileIds.filter((profileId) => profileId !== id),
    })),
    customProfiles: current.customProfiles.filter((profile) => profile.id !== id),
  };
  await atomicJson(libraryFile(options), next);
  return next;
}

function xml(value: string): string {
  return value.replace(
    /[<>&"']/g,
    (character) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]!,
  );
}

export function renderDesignCatalogPreview(profile: DesignCatalogProfile): string {
  const background = profile.colors.surface ?? "#F5F6F8";
  const foreground = profile.colors.text ?? "#17181A";
  const accent = profile.colors.primary ?? Object.values(profile.colors)[0] ?? "#4F46E5";
  const secondary = profile.colors.secondary ?? accent;
  const swatches = Object.entries(profile.colors)
    .slice(0, 6)
    .map(
      ([role, value], index) =>
        `<g transform="translate(${48 + index * 86} 332)"><rect width="70" height="44" rx="10" fill="${xml(value)}"/><text y="61" font-size="11" fill="${xml(foreground)}">${xml(role)}</text></g>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="430" viewBox="0 0 760 430" role="img" aria-labelledby="title desc"><title id="title">${xml(profile.title)} design profile preview</title><desc id="desc">Token and component specimen for ${xml(profile.title)}</desc><rect width="760" height="430" rx="28" fill="${xml(background)}"/><rect x="28" y="28" width="704" height="276" rx="22" fill="${xml(background)}" stroke="${xml(accent)}" stroke-opacity=".22"/><text x="56" y="78" font-size="14" font-family="system-ui" fill="${xml(accent)}">${xml(profile.category)} · ${xml(profile.profileType)}</text><text x="56" y="126" font-size="34" font-weight="700" font-family="system-ui" fill="${xml(foreground)}">${xml(profile.title)}</text><text x="56" y="158" font-size="15" font-family="system-ui" fill="${xml(foreground)}" opacity=".72">${xml(profile.characteristics.tones.slice(0, 4).join(" · ") || profile.description.slice(0, 64))}</text><rect x="56" y="196" width="148" height="48" rx="14" fill="${xml(accent)}"/><text x="130" y="226" text-anchor="middle" font-size="14" font-weight="650" font-family="system-ui" fill="${xml(background)}">Primary action</text><rect x="222" y="196" width="148" height="48" rx="14" fill="none" stroke="${xml(secondary)}"/><text x="296" y="226" text-anchor="middle" font-size="14" font-family="system-ui" fill="${xml(foreground)}">Secondary</text>${swatches}</svg>`;
}
