import path from "node:path";
import type {
  DesignContextStrategy,
  DesignContract,
  DesignInspiration,
  DesignReferenceImage,
  DesignState,
  DesignVariantRequest,
} from "@glimmer/shared";
import { normalizeAssetRequests, normalizeElementEdits } from "./designActions.js";
import { normalizeDesignProfiles } from "./designProfiles.js";

const DESIGN_KINDS = new Set(["build", "improve", "audit", "reference-match"]);
const STRATEGIES = new Set<DesignContextStrategy>(["detect", "existing", "required", "none"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const REFERENCE_IMAGE_POLICIES = new Set(["local-only", "vision-model"]);

export type DesignContractValidation =
  { value: DesignContract | undefined; error?: never } | { value?: never; error: string };

function safeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096) return false;
  const normalized = value.trim();
  if (path.isAbsolute(normalized) || /^[A-Za-z]:[\\/]/.test(normalized)) return false;
  return !normalized.split(/[\\/]/).includes("..");
}

function normalizeStrings(
  value: unknown,
  field: string,
  maxItems = 20,
  maxChars = 500,
): { value?: string[]; error?: string } {
  if (!Array.isArray(value) || value.length > maxItems) {
    return { error: `${field} must be an array with at most ${maxItems} entries` };
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim() || entry.length > maxChars) {
      return {
        error: `${field} entries must be non-empty strings of at most ${maxChars} characters`,
      };
    }
    result.push(entry.trim());
  }
  return { value: result };
}

function optionalText(value: unknown, field: string, maxChars = 500): string | undefined | Error {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > maxChars) {
    return new Error(`${field} must be a non-empty string of at most ${maxChars} characters`);
  }
  return value.trim();
}

function localTargetUrl(value: unknown): string | undefined | Error {
  const normalized = optionalText(value, "design.targetUrl", 2_048);
  if (normalized === undefined || normalized instanceof Error) return normalized;
  try {
    const url = new URL(normalized);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
    ) {
      return new Error("design.targetUrl must be an http(s) loopback URL without credentials");
    }
    return url.toString();
  } catch {
    return new Error("design.targetUrl must be a valid URL");
  }
}

function normalizePaths(value: unknown, field: string, maxItems = 20): string[] | Error {
  const strings = normalizeStrings(value, field, maxItems, 4_096);
  if (strings.error) return new Error(strings.error);
  if (!strings.value!.every(safeRelativePath)) {
    return new Error(`${field} entries must be workspace-relative paths without '..'`);
  }
  return strings.value!;
}

function normalizeReferences(value: unknown): DesignReferenceImage[] | Error {
  if (!Array.isArray(value) || value.length > 5) {
    return new Error("design.referenceImages must contain at most 5 entries");
  }
  const result: DesignReferenceImage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      return new Error("design.referenceImages entries must be objects");
    }
    const raw = entry as Record<string, unknown>;
    if (
      !safeRelativePath(raw.path) ||
      !IMAGE_EXTENSIONS.has(path.extname(raw.path).toLowerCase())
    ) {
      return new Error(
        "design reference images must be workspace-relative PNG, JPG, or WEBP files",
      );
    }
    const label = optionalText(raw.label, "design.referenceImages.label", 200);
    if (label instanceof Error) return label;
    result.push({ path: raw.path.trim(), ...(label ? { label } : {}) });
  }
  return result;
}

function normalizeStates(value: unknown): DesignState[] | Error {
  if (!Array.isArray(value) || value.length > 10) {
    return new Error("design.states must contain at most 10 states");
  }
  const result: DesignState[] = [];
  const names = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return new Error("design state must be an object");
    const raw = entry as Record<string, unknown>;
    const name = optionalText(raw.name, "design.states.name", 80);
    if (!name || name instanceof Error || names.has(name.toLowerCase())) {
      return new Error("design state names must be non-empty and unique");
    }
    names.add(name.toLowerCase());
    if (!Array.isArray(raw.actions) || raw.actions.length > 10) {
      return new Error("each design state may contain at most 10 actions");
    }
    const actions: DesignState["actions"] = [];
    for (const action of raw.actions) {
      if (!action || typeof action !== "object")
        return new Error("design action must be an object");
      const item = action as Record<string, unknown>;
      if (item.action === "click") {
        const selector = optionalText(item.selector, "design click selector", 500);
        if (!selector || selector instanceof Error)
          return new Error("design click selector is invalid");
        actions.push({ action: "click", selector });
      } else if (
        item.action === "wait" &&
        Number.isInteger(item.ms) &&
        Number(item.ms) >= 1 &&
        Number(item.ms) <= 30_000
      ) {
        actions.push({ action: "wait", ms: Number(item.ms) });
      } else {
        return new Error("design actions are limited to click and wait (1..30000 ms)");
      }
    }
    const expectations = normalizeStrings(raw.expectations, "design.states.expectations", 10, 500);
    if (expectations.error) return new Error(expectations.error);
    result.push({ name, actions, expectations: expectations.value! });
  }
  return result;
}

function officialMobbinUrl(value: unknown): string | Error {
  const text = optionalText(value, "design.inspirations.mobbinUrl", 2_048);
  if (!text || text instanceof Error) return new Error("Mobbin URL is invalid");
  try {
    const url = new URL(text);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.hostname !== "mobbin.com" && !url.hostname.endsWith(".mobbin.com"))
    ) {
      return new Error("Mobbin URL must use official Mobbin HTTPS hosts without credentials");
    }
    return url.toString();
  } catch {
    return new Error("Mobbin URL is invalid");
  }
}

function normalizeInspirations(value: unknown): DesignInspiration[] | Error {
  if (!Array.isArray(value) || value.length > 20) {
    return new Error("design.inspirations must contain at most 20 entries");
  }
  const result: DesignInspiration[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      return new Error("design.inspirations entries must be objects");
    }
    const raw = entry as Record<string, unknown>;
    if (raw.source !== "mobbin" || (raw.platform !== "ios" && raw.platform !== "web")) {
      return new Error("design inspirations must use the supported Mobbin source and platform");
    }
    const screenId = optionalText(raw.screenId, "design.inspirations.screenId", 200);
    const appName = optionalText(raw.appName, "design.inspirations.appName", 200);
    const query = optionalText(raw.query, "design.inspirations.query", 500);
    const notes = optionalText(raw.notes, "design.inspirations.notes", 1_000);
    const mobbinUrl = officialMobbinUrl(raw.mobbinUrl);
    if (mobbinUrl instanceof Error) return mobbinUrl;
    if (
      !screenId ||
      screenId instanceof Error ||
      !appName ||
      appName instanceof Error ||
      !query ||
      query instanceof Error ||
      notes instanceof Error
    ) {
      return new Error("design inspiration contains invalid or oversized fields");
    }
    result.push({
      source: "mobbin",
      screenId,
      appName,
      platform: raw.platform,
      mobbinUrl,
      query,
      ...(notes ? { notes } : {}),
    });
  }
  return result;
}

function normalizedCoordinate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function normalizeVariants(value: unknown): DesignVariantRequest[] | Error {
  if (!Array.isArray(value) || value.length > 10) {
    return new Error("design.variants must contain at most 10 entries");
  }
  const result: DesignVariantRequest[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return new Error("design variant must be an object");
    const raw = entry as Record<string, unknown>;
    const id = optionalText(raw.id, "design.variants.id", 100);
    const target = optionalText(raw.target, "design.variants.target", 500);
    const directions = normalizeStrings(raw.directions, "design.variants.directions", 4, 500);
    if (
      !id ||
      id instanceof Error ||
      ids.has(id) ||
      !target ||
      target instanceof Error ||
      ![2, 3, 4].includes(Number(raw.count)) ||
      directions.error ||
      !directions.value?.length
    ) {
      return new Error("design variant id, target, count, or directions is invalid");
    }
    ids.add(id);
    const screenshot = optionalText(raw.screenshot, "design.variants.screenshot", 255);
    if (screenshot instanceof Error) return screenshot;
    let region: DesignVariantRequest["region"];
    if (raw.region !== undefined) {
      if (!raw.region || typeof raw.region !== "object") {
        return new Error("design variant region is invalid");
      }
      const candidate = raw.region as Record<string, unknown>;
      const x = normalizedCoordinate(candidate.x);
      const y = normalizedCoordinate(candidate.y);
      const width =
        candidate.width === undefined ? undefined : normalizedCoordinate(candidate.width);
      const height =
        candidate.height === undefined ? undefined : normalizedCoordinate(candidate.height);
      if (x === null || y === null || width === null || height === null) {
        return new Error("design variant region coordinates must be normalized from 0 to 1");
      }
      region = {
        x,
        y,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      };
    }
    result.push({
      id,
      target,
      count: raw.count as 2 | 3 | 4,
      directions: directions.value!,
      ...(screenshot ? { screenshot } : {}),
      ...(region ? { region } : {}),
    });
  }
  return result;
}

export function validateDesignContract(input: unknown): DesignContractValidation {
  if (input === undefined) return { value: undefined };
  if (!input || typeof input !== "object") return { error: "design must be an object" };
  const raw = input as Record<string, unknown>;
  if (!DESIGN_KINDS.has(String(raw.kind))) return { error: "design.kind is invalid" };

  const targetUrl = localTargetUrl(raw.targetUrl);
  if (targetUrl instanceof Error) return { error: targetUrl.message };
  const audience = optionalText(raw.audience, "design.audience");
  if (audience instanceof Error) return { error: audience.message };
  const primaryAction = optionalText(raw.primaryAction, "design.primaryAction");
  if (primaryAction instanceof Error) return { error: primaryAction.message };
  const requirements = normalizeStrings(raw.requirements, "design.requirements");
  if (requirements.error) return { error: requirements.error };
  const referenceImages = normalizeReferences(raw.referenceImages);
  if (referenceImages instanceof Error) return { error: referenceImages.message };
  if (!REFERENCE_IMAGE_POLICIES.has(String(raw.referenceImagePolicy))) {
    return { error: "design.referenceImagePolicy must be local-only or vision-model" };
  }
  const states = normalizeStates(raw.states);
  if (states instanceof Error) return { error: states.message };
  const viewports = normalizeStrings(raw.viewports, "design.viewports", 6, 20);
  if (viewports.error) return { error: viewports.error };
  if (
    !viewports.value!.length ||
    viewports.value!.some((viewport) => {
      const match = /^(\d{3,4})x(\d{3,4})$/.exec(viewport);
      return (
        !match ||
        Number(match[1]) < 240 ||
        Number(match[1]) > 3_840 ||
        Number(match[2]) < 240 ||
        Number(match[2]) > 3_840
      );
    })
  ) {
    return { error: "design.viewports must contain WxH values between 240 and 3840 pixels" };
  }
  const inspirations = normalizeInspirations(raw.inspirations);
  if (inspirations instanceof Error) return { error: inspirations.message };
  const designProfiles = normalizeDesignProfiles(raw.designProfiles ?? []);
  if (!designProfiles) return { error: "design.designProfiles are invalid" };
  const variants = normalizeVariants(raw.variants);
  if (variants instanceof Error) return { error: variants.message };
  const elementEdits = normalizeElementEdits(raw.elementEdits ?? []);
  if (!elementEdits) return { error: "design.elementEdits are invalid" };
  const assetRequests = normalizeAssetRequests(raw.assetRequests ?? []);
  if (!assetRequests) return { error: "design.assetRequests are invalid" };

  const cms = raw.cms as Record<string, unknown> | undefined;
  const tokens = raw.designTokens as Record<string, unknown> | undefined;
  if (!cms || !STRATEGIES.has(cms.strategy as DesignContextStrategy)) {
    return { error: "design.cms.strategy is invalid" };
  }
  if (!tokens || !STRATEGIES.has(tokens.strategy as DesignContextStrategy)) {
    return { error: "design.designTokens.strategy is invalid" };
  }
  const cmsProvider = optionalText(cms.providerHint, "design.cms.providerHint");
  if (cmsProvider instanceof Error) return { error: cmsProvider.message };
  const cmsPaths = normalizePaths(cms.schemaPaths, "design.cms.schemaPaths");
  if (cmsPaths instanceof Error) return { error: cmsPaths.message };
  const cmsRequirements = normalizeStrings(cms.requirements, "design.cms.requirements");
  if (cmsRequirements.error) return { error: cmsRequirements.error };
  if (typeof cms.localizationRequired !== "boolean") {
    return { error: "design.cms.localizationRequired must be a boolean" };
  }
  const tokenPaths = normalizePaths(tokens.sourcePaths, "design.designTokens.sourcePaths");
  if (tokenPaths instanceof Error) return { error: tokenPaths.message };
  const tokenRequirements = normalizeStrings(
    tokens.requirements,
    "design.designTokens.requirements",
  );
  if (tokenRequirements.error) return { error: tokenRequirements.error };
  if (typeof tokens.allowNewTokens !== "boolean") {
    return { error: "design.designTokens.allowNewTokens must be a boolean" };
  }

  return {
    value: {
      kind: raw.kind as DesignContract["kind"],
      ...(targetUrl ? { targetUrl } : {}),
      ...(audience ? { audience } : {}),
      ...(primaryAction ? { primaryAction } : {}),
      requirements: requirements.value!,
      referenceImages,
      referenceImagePolicy: raw.referenceImagePolicy as DesignContract["referenceImagePolicy"],
      states,
      viewports: viewports.value!,
      inspirations,
      designProfiles,
      variants,
      elementEdits,
      assetRequests,
      cms: {
        strategy: cms.strategy as DesignContextStrategy,
        ...(cmsProvider ? { providerHint: cmsProvider } : {}),
        schemaPaths: cmsPaths,
        requirements: cmsRequirements.value!,
        localizationRequired: cms.localizationRequired,
      },
      designTokens: {
        strategy: tokens.strategy as DesignContextStrategy,
        sourcePaths: tokenPaths,
        requirements: tokenRequirements.value!,
        allowNewTokens: tokens.allowNewTokens,
      },
    },
  };
}
