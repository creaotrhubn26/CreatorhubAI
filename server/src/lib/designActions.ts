import path from "node:path";
import type {
  DesignAssetRequest,
  DesignElementEdit,
  DesignElementStyleEdit,
  DesignReferenceImage,
  DesignRegion,
} from "@glimmer/shared";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const SCREENSHOT_RE = /^[A-Za-z0-9x-]+\.png$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov"]);
const VECTOR_EXTENSIONS = new Set([".svg"]);
const ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4"]);

interface NormalizeOptions {
  screenshots?: Set<string>;
}

function exactKeys(raw: Record<string, unknown>, allowed: string[]): boolean {
  const allow = new Set(allowed);
  return Object.keys(raw).every((key) => allow.has(key));
}

function text(value: unknown, max: number, allowEmpty = false): string | null {
  if (typeof value !== "string" || value.length > max || /\0/.test(value)) return null;
  if (!allowEmpty && !value.trim()) return null;
  return allowEmpty ? value : value.trim();
}

function numberIn(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function relativePath(value: unknown, max = 4_096): string | null {
  const candidate = text(value, max);
  if (!candidate || path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) return null;
  if (candidate.split(/[\\/]/).includes("..")) return null;
  return candidate;
}

function screenshot(value: unknown, options: NormalizeOptions): string | null {
  const candidate = text(value, 255);
  if (!candidate || !SCREENSHOT_RE.test(candidate)) return null;
  if (options.screenshots && !options.screenshots.has(candidate)) return null;
  return candidate;
}

function region(value: unknown): DesignRegion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!exactKeys(raw, ["x", "y", "width", "height"])) return null;
  const x = numberIn(raw.x, 0, 1);
  const y = numberIn(raw.y, 0, 1);
  const width = raw.width === undefined ? undefined : numberIn(raw.width, 0, 1);
  const height = raw.height === undefined ? undefined : numberIn(raw.height, 0, 1);
  if (x === null || y === null || width === null || height === null) return null;
  if (
    (width !== undefined && x + width > 1.000_001) ||
    (height !== undefined && y + height > 1.000_001)
  ) {
    return null;
  }
  return {
    x,
    y,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

function style(value: unknown): DesignElementStyleEdit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const allowed = [
    "textColor",
    "backgroundColor",
    "fontFamily",
    "fontSizePx",
    "fontWeight",
    "lineHeight",
    "paddingPx",
    "marginPx",
    "gapPx",
    "borderColor",
    "borderWidthPx",
    "borderRadiusPx",
    "opacity",
    "direction",
    "align",
  ];
  if (!exactKeys(raw, allowed)) return null;
  const result: DesignElementStyleEdit = {};
  for (const key of ["textColor", "backgroundColor", "borderColor"] as const) {
    if (raw[key] !== undefined) {
      const color = text(raw[key], 9);
      if (!color || !HEX_COLOR_RE.test(color)) return null;
      result[key] = color.toLowerCase();
    }
  }
  if (raw.fontFamily !== undefined) {
    const fontFamily = text(raw.fontFamily, 200);
    if (!fontFamily || /[{};]/.test(fontFamily)) return null;
    result.fontFamily = fontFamily;
  }
  const numericFields: Array<
    [
      keyof Pick<
        DesignElementStyleEdit,
        | "fontSizePx"
        | "fontWeight"
        | "lineHeight"
        | "paddingPx"
        | "marginPx"
        | "gapPx"
        | "borderWidthPx"
        | "borderRadiusPx"
        | "opacity"
      >,
      number,
      number,
    ]
  > = [
    ["fontSizePx", 8, 240],
    ["fontWeight", 100, 900],
    ["lineHeight", 0.5, 4],
    ["paddingPx", 0, 512],
    ["marginPx", -512, 512],
    ["gapPx", 0, 512],
    ["borderWidthPx", 0, 64],
    ["borderRadiusPx", 0, 2_000],
    ["opacity", 0, 1],
  ];
  for (const [key, min, max] of numericFields) {
    if (raw[key] === undefined) continue;
    const normalized = numberIn(raw[key], min, max);
    if (normalized === null) return null;
    (result as Record<string, unknown>)[key] = normalized;
  }
  if (raw.direction !== undefined) {
    if (raw.direction !== "row" && raw.direction !== "column") return null;
    result.direction = raw.direction;
  }
  if (raw.align !== undefined) {
    if (!["start", "center", "end", "space-between"].includes(String(raw.align))) return null;
    result.align = raw.align as DesignElementStyleEdit["align"];
  }
  return result;
}

export function normalizeElementEdits(
  value: unknown,
  options: NormalizeOptions = {},
): DesignElementEdit[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const result: DesignElementEdit[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const raw = item as Record<string, unknown>;
    if (
      !exactKeys(raw, [
        "id",
        "target",
        "screenshot",
        "viewport",
        "state",
        "region",
        "selectorHint",
        "sourcePathHint",
        "expectedText",
        "text",
        "imageSource",
        "style",
        "createdAt",
      ])
    ) {
      return null;
    }
    const id = text(raw.id, 100);
    const target = text(raw.target, 500);
    const capture = screenshot(raw.screenshot, options);
    const viewport = text(raw.viewport, 40);
    const state = text(raw.state, 80);
    const normalizedRegion = region(raw.region);
    const normalizedStyle = style(raw.style);
    const selectorHint = raw.selectorHint === undefined ? undefined : text(raw.selectorHint, 500);
    const sourcePathHint =
      raw.sourcePathHint === undefined ? undefined : relativePath(raw.sourcePathHint);
    const expectedText =
      raw.expectedText === undefined ? undefined : text(raw.expectedText, 5_000, true);
    const replacementText = raw.text === undefined ? undefined : text(raw.text, 5_000, true);
    const imageSource = raw.imageSource === undefined ? undefined : relativePath(raw.imageSource);
    const createdAt = text(raw.createdAt, 64);
    if (
      !id ||
      !ID_RE.test(id) ||
      ids.has(id) ||
      !target ||
      !capture ||
      !viewport ||
      !state ||
      !normalizedRegion ||
      !normalizedStyle ||
      (raw.selectorHint !== undefined && selectorHint === null) ||
      (raw.sourcePathHint !== undefined && sourcePathHint === null) ||
      (raw.expectedText !== undefined && expectedText === null) ||
      (raw.text !== undefined && replacementText === null) ||
      (raw.imageSource !== undefined && imageSource === null) ||
      !createdAt ||
      Number.isNaN(Date.parse(createdAt))
    ) {
      return null;
    }
    if (
      replacementText === undefined &&
      imageSource === undefined &&
      Object.keys(normalizedStyle).length === 0
    ) {
      return null;
    }
    ids.add(id);
    result.push({
      id,
      target,
      screenshot: capture,
      viewport,
      state,
      region: normalizedRegion,
      ...(selectorHint ? { selectorHint } : {}),
      ...(sourcePathHint ? { sourcePathHint } : {}),
      ...(typeof expectedText === "string" ? { expectedText } : {}),
      ...(typeof replacementText === "string" ? { text: replacementText } : {}),
      ...(imageSource ? { imageSource } : {}),
      style: normalizedStyle,
      createdAt,
    });
  }
  return result;
}

function referenceImages(value: unknown): DesignReferenceImage[] | null {
  if (!Array.isArray(value) || value.length > 5) return null;
  const result: DesignReferenceImage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const raw = item as Record<string, unknown>;
    if (!exactKeys(raw, ["path", "label"])) return null;
    const imagePath = relativePath(raw.path);
    const label = raw.label === undefined ? undefined : text(raw.label, 200);
    if (!imagePath || !IMAGE_EXTENSIONS.has(path.extname(imagePath).toLowerCase())) return null;
    if (raw.label !== undefined && !label) return null;
    result.push({ path: imagePath, ...(label ? { label } : {}) });
  }
  return result;
}

function outputPath(kind: DesignAssetRequest["kind"], value: unknown): string | null {
  const candidate = relativePath(value);
  if (!candidate) return null;
  const extension = path.extname(candidate).toLowerCase();
  const allowed =
    kind === "image" ? IMAGE_EXTENSIONS : kind === "video" ? VIDEO_EXTENSIONS : VECTOR_EXTENSIONS;
  return allowed.has(extension) ? candidate : null;
}

export function normalizeAssetRequests(
  value: unknown,
  options: NormalizeOptions = {},
): DesignAssetRequest[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const result: DesignAssetRequest[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const raw = item as Record<string, unknown>;
    if (
      !exactKeys(raw, [
        "id",
        "kind",
        "prompt",
        "outputPath",
        "aspectRatio",
        "size",
        "resolution",
        "durationSeconds",
        "audio",
        "animated",
        "referenceImages",
        "referenceUploadPolicy",
        "screenshot",
        "createdAt",
      ])
    ) {
      return null;
    }
    if (raw.kind !== "image" && raw.kind !== "video" && raw.kind !== "vector") return null;
    const kind = raw.kind;
    const id = text(raw.id, 100);
    const prompt = text(raw.prompt, 2_000);
    const target = outputPath(kind, raw.outputPath);
    const references = referenceImages(raw.referenceImages);
    const capture = raw.screenshot === undefined ? undefined : screenshot(raw.screenshot, options);
    const createdAt = text(raw.createdAt, 64);
    if (
      !id ||
      !ID_RE.test(id) ||
      ids.has(id) ||
      !prompt ||
      !target ||
      !ASPECT_RATIOS.has(String(raw.aspectRatio)) ||
      !references ||
      (raw.referenceUploadPolicy !== "local-only" &&
        raw.referenceUploadPolicy !== "generation-model") ||
      (raw.screenshot !== undefined && !capture) ||
      !createdAt ||
      Number.isNaN(Date.parse(createdAt))
    ) {
      return null;
    }
    if (
      (kind === "image" &&
        (!(["1K", "2K", "4K"] as unknown[]).includes(raw.size) ||
          raw.resolution !== undefined ||
          raw.durationSeconds !== undefined ||
          raw.audio !== undefined ||
          raw.animated !== undefined)) ||
      (kind === "video" &&
        (!(["720p", "1080p"] as unknown[]).includes(raw.resolution) ||
          !([2, 4, 6, 8] as unknown[]).includes(raw.durationSeconds) ||
          typeof raw.audio !== "boolean" ||
          raw.size !== undefined ||
          raw.animated !== undefined)) ||
      (kind === "vector" &&
        (typeof raw.animated !== "boolean" ||
          raw.size !== undefined ||
          raw.resolution !== undefined ||
          raw.durationSeconds !== undefined ||
          raw.audio !== undefined))
    ) {
      return null;
    }
    ids.add(id);
    result.push({
      id,
      kind,
      prompt,
      outputPath: target,
      aspectRatio: raw.aspectRatio as DesignAssetRequest["aspectRatio"],
      ...(kind === "image" ? { size: raw.size as DesignAssetRequest["size"] } : {}),
      ...(kind === "video"
        ? {
            resolution: raw.resolution as DesignAssetRequest["resolution"],
            durationSeconds: raw.durationSeconds as DesignAssetRequest["durationSeconds"],
            audio: raw.audio as boolean,
          }
        : {}),
      ...(kind === "vector" ? { animated: raw.animated as boolean } : {}),
      referenceImages: references,
      referenceUploadPolicy: raw.referenceUploadPolicy,
      ...(capture ? { screenshot: capture } : {}),
      createdAt,
    });
  }
  return result;
}
