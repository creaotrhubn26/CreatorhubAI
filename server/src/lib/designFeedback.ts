import path from "node:path";
import type {
  DesignFeedbackAnnotation,
  DesignFeedbackUpdate,
  DesignInspiration,
  DesignVariantRequest,
} from "@glimmer/shared";
import { normalizeAssetRequests, normalizeElementEdits } from "./designActions.js";
import { normalizeDesignProfiles } from "./designProfiles.js";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const FEEDBACK_TOOLS = new Set([
  "comment",
  "draw",
  "rectangle",
  "ellipse",
  "arrow",
  "sticky",
  "color",
  "typography",
  "layout",
]);
const HEX_COLOR_RE = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;

export type DesignFeedbackValidation =
  { value: DesignFeedbackUpdate; error?: never } | { value?: never; error: string };

function boundedText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}

function coordinate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function workspaceRelativeHint(value: unknown): string | null {
  const candidate = boundedText(value, 4_096);
  if (
    !candidate ||
    path.isAbsolute(candidate) ||
    /^[A-Za-z]:[\\/]/.test(candidate) ||
    candidate.split(/[\\/]/).includes("..")
  ) {
    return null;
  }
  return candidate;
}

function officialMobbinUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.hostname !== "mobbin.com" && !url.hostname.endsWith(".mobbin.com"))
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function inspirations(value: unknown): DesignInspiration[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const result: DesignInspiration[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const raw = item as Record<string, unknown>;
    const screenId = boundedText(raw.screenId, 200);
    const appName = boundedText(raw.appName, 200);
    const query = boundedText(raw.query, 500);
    const notes = raw.notes === undefined ? undefined : boundedText(raw.notes, 1_000);
    const mobbinUrl = officialMobbinUrl(raw.mobbinUrl);
    if (
      raw.source !== "mobbin" ||
      (raw.platform !== "ios" && raw.platform !== "web") ||
      !screenId ||
      !appName ||
      !query ||
      !mobbinUrl ||
      (raw.notes !== undefined && !notes)
    ) {
      return null;
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

function variants(value: unknown, screenshots: Set<string>): DesignVariantRequest[] | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const result: DesignVariantRequest[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const raw = item as Record<string, unknown>;
    const id = boundedText(raw.id, 100);
    const target = boundedText(raw.target, 500);
    const directions = Array.isArray(raw.directions)
      ? raw.directions.map((entry) => boundedText(entry, 500))
      : [];
    if (
      !id ||
      !ID_RE.test(id) ||
      ids.has(id) ||
      !target ||
      ![2, 3, 4].includes(Number(raw.count)) ||
      !directions.length ||
      directions.length > 4 ||
      directions.some((entry) => !entry)
    ) {
      return null;
    }
    ids.add(id);
    const screenshot = raw.screenshot === undefined ? undefined : boundedText(raw.screenshot, 255);
    if (raw.screenshot !== undefined && (!screenshot || !screenshots.has(screenshot))) return null;
    let region: DesignVariantRequest["region"];
    if (raw.region !== undefined) {
      if (!raw.region || typeof raw.region !== "object") return null;
      const candidate = raw.region as Record<string, unknown>;
      const x = coordinate(candidate.x);
      const y = coordinate(candidate.y);
      const width = candidate.width === undefined ? undefined : coordinate(candidate.width);
      const height = candidate.height === undefined ? undefined : coordinate(candidate.height);
      if (x === null || y === null || width === null || height === null) return null;
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
      directions: directions as string[],
      ...(screenshot ? { screenshot } : {}),
      ...(region ? { region } : {}),
    });
  }
  return result;
}

function annotations(value: unknown, screenshots: Set<string>): DesignFeedbackAnnotation[] | null {
  if (!Array.isArray(value) || value.length > 200) return null;
  const result: DesignFeedbackAnnotation[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const raw = item as Record<string, unknown>;
    if (
      Object.keys(raw).some(
        (key) =>
          ![
            "id",
            "screenshot",
            "viewport",
            "state",
            "tool",
            "points",
            "comment",
            "value",
            "strokeColor",
            "fillColor",
            "strokeWidth",
            "selectorHint",
            "sourcePathHint",
            "createdAt",
          ].includes(key),
      )
    ) {
      return null;
    }
    const id = boundedText(raw.id, 100);
    const screenshot = boundedText(raw.screenshot, 255);
    const viewport = boundedText(raw.viewport, 40);
    const state = boundedText(raw.state, 80);
    const comment = boundedText(raw.comment, 2_000);
    const value = raw.value === undefined ? undefined : boundedText(raw.value, 500);
    const strokeColor = raw.strokeColor === undefined ? undefined : boundedText(raw.strokeColor, 9);
    const fillColor = raw.fillColor === undefined ? undefined : boundedText(raw.fillColor, 9);
    const strokeWidth = raw.strokeWidth === undefined ? undefined : Number(raw.strokeWidth);
    const selectorHint =
      raw.selectorHint === undefined ? undefined : boundedText(raw.selectorHint, 1_000);
    const sourcePathHint =
      raw.sourcePathHint === undefined ? undefined : workspaceRelativeHint(raw.sourcePathHint);
    const createdAt = boundedText(raw.createdAt, 64);
    if (
      !id ||
      !ID_RE.test(id) ||
      ids.has(id) ||
      !screenshot ||
      !screenshots.has(screenshot) ||
      !viewport ||
      !state ||
      !comment ||
      !createdAt ||
      Number.isNaN(Date.parse(createdAt)) ||
      !FEEDBACK_TOOLS.has(String(raw.tool)) ||
      (raw.value !== undefined && !value) ||
      (strokeColor !== undefined && (strokeColor === null || !HEX_COLOR_RE.test(strokeColor))) ||
      (fillColor !== undefined && (fillColor === null || !HEX_COLOR_RE.test(fillColor))) ||
      (strokeWidth !== undefined && ![1, 2, 4, 8].includes(strokeWidth)) ||
      (raw.selectorHint !== undefined && !selectorHint) ||
      (raw.sourcePathHint !== undefined && !sourcePathHint) ||
      ((raw.tool === "color" || raw.tool === "typography" || raw.tool === "layout") && !value) ||
      !Array.isArray(raw.points) ||
      !raw.points.length ||
      raw.points.length > 500
    ) {
      return null;
    }
    if (
      (["rectangle", "ellipse", "arrow"].includes(String(raw.tool)) && raw.points.length !== 2) ||
      (["comment", "sticky", "color", "typography", "layout"].includes(String(raw.tool)) &&
        raw.points.length !== 1)
    ) {
      return null;
    }
    const points = raw.points.map((point) => {
      if (!point || typeof point !== "object") return null;
      const candidate = point as Record<string, unknown>;
      const x = coordinate(candidate.x);
      const y = coordinate(candidate.y);
      return x === null || y === null ? null : { x, y };
    });
    if (points.some((point) => !point)) return null;
    ids.add(id);
    result.push({
      id,
      screenshot,
      viewport,
      state,
      tool: raw.tool as DesignFeedbackAnnotation["tool"],
      points: points as DesignFeedbackAnnotation["points"],
      comment,
      ...(value ? { value } : {}),
      ...(typeof strokeColor === "string" ? { strokeColor: strokeColor.toLowerCase() } : {}),
      ...(typeof fillColor === "string" ? { fillColor: fillColor.toLowerCase() } : {}),
      ...(strokeWidth ? { strokeWidth: strokeWidth as 1 | 2 | 4 | 8 } : {}),
      ...(selectorHint ? { selectorHint } : {}),
      ...(sourcePathHint ? { sourcePathHint } : {}),
      createdAt,
    });
  }
  return result;
}

export function validateDesignFeedbackUpdate(
  input: unknown,
  allowedScreenshots: string[],
): DesignFeedbackValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "design feedback must be an object" };
  }
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "annotations",
          "variants",
          "inspirations",
          "designProfiles",
          "elementEdits",
          "assetRequests",
        ].includes(key),
    )
  ) {
    return { error: "design feedback contains unsupported fields" };
  }
  const raw = input as Record<string, unknown>;
  const screenshots = new Set(allowedScreenshots);
  const normalizedAnnotations = annotations(raw.annotations, screenshots);
  const normalizedVariants = variants(raw.variants, screenshots);
  const normalizedInspirations = inspirations(raw.inspirations);
  const normalizedDesignProfiles = normalizeDesignProfiles(raw.designProfiles ?? []);
  const normalizedElementEdits = normalizeElementEdits(raw.elementEdits, { screenshots });
  const normalizedAssetRequests = normalizeAssetRequests(raw.assetRequests, { screenshots });
  if (!normalizedAnnotations) return { error: "design feedback annotations are invalid" };
  if (!normalizedVariants) return { error: "design feedback variants are invalid" };
  if (!normalizedInspirations) return { error: "design feedback inspirations are invalid" };
  if (!normalizedDesignProfiles) return { error: "design feedback design profiles are invalid" };
  if (!normalizedElementEdits) return { error: "design feedback element edits are invalid" };
  if (!normalizedAssetRequests) return { error: "design feedback asset requests are invalid" };
  return {
    value: {
      annotations: normalizedAnnotations,
      variants: normalizedVariants,
      inspirations: normalizedInspirations,
      designProfiles: normalizedDesignProfiles,
      elementEdits: normalizedElementEdits,
      assetRequests: normalizedAssetRequests,
    },
  };
}
