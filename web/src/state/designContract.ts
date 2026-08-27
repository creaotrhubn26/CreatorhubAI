import type {
  DesignContextStrategy,
  DesignContract,
  DesignAssetRequest,
  DesignElementEdit,
  DesignInspiration,
  DesignReferenceImage,
  DesignState,
  DesignTaskKind,
  DesignVariantRequest,
} from "@glimmer/shared";

export interface DesignComposerFields {
  designEnabled: boolean;
  designKind: DesignTaskKind;
  designTargetUrl: string;
  designAudience: string;
  designPrimaryAction: string;
  designRequirements: string;
  designReferenceImages: string;
  allowReferenceImageModelUpload: boolean;
  designStates: string;
  designViewports: string;
  designInspirations: DesignInspiration[];
  designVariants: DesignVariantRequest[];
  designElementEdits: DesignElementEdit[];
  designAssetRequests: DesignAssetRequest[];
  cmsStrategy: DesignContextStrategy;
  cmsProviderHint: string;
  cmsSchemaPaths: string;
  cmsRequirements: string;
  cmsLocalizationRequired: boolean;
  designTokenStrategy: DesignContextStrategy;
  designTokenSourcePaths: string;
  designTokenRequirements: string;
  allowNewDesignTokens: boolean;
}

export const DEFAULT_DESIGN_FORM: DesignComposerFields = {
  designEnabled: false,
  designKind: "improve",
  designTargetUrl: "",
  designAudience: "",
  designPrimaryAction: "",
  designRequirements: "",
  designReferenceImages: "",
  allowReferenceImageModelUpload: false,
  designStates: "",
  designViewports: "1440x900, 390x844",
  designInspirations: [],
  designVariants: [],
  designElementEdits: [],
  designAssetRequests: [],
  cmsStrategy: "detect",
  cmsProviderHint: "",
  cmsSchemaPaths: "",
  cmsRequirements: "",
  cmsLocalizationRequired: false,
  designTokenStrategy: "detect",
  designTokenSourcePaths: "",
  designTokenRequirements: "",
  allowNewDesignTokens: false,
};

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function paths(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function references(value: string): DesignReferenceImage[] {
  return lines(value).map((entry) => {
    const parts = entry.split("|").map((part) => part.trim());
    return parts.length > 1
      ? { label: parts.slice(0, -1).join(" | "), path: parts.at(-1)! }
      : { path: entry };
  });
}

export function parseDesignStates(value: string): { states: DesignState[]; errors: string[] } {
  const byName = new Map<string, DesignState>();
  const errors: string[] = [];
  for (const [index, entry] of lines(value).entries()) {
    const [rawName, rawAction, rawValue, ...rawExpectation] = entry
      .split("|")
      .map((part) => part.trim());
    const lineNumber = index + 1;
    if (!rawName || !rawAction || !rawValue) {
      errors.push(`State line ${lineNumber} must be: name | click/wait | value | expectation.`);
      continue;
    }
    const state = byName.get(rawName) ?? { name: rawName, actions: [], expectations: [] };
    if (rawAction === "click") {
      state.actions.push({ action: "click", selector: rawValue });
    } else if (rawAction === "wait") {
      const ms = Number(rawValue);
      if (!Number.isInteger(ms) || ms < 1 || ms > 30_000) {
        errors.push(`State line ${lineNumber} wait must be an integer from 1 to 30000 ms.`);
        continue;
      }
      state.actions.push({ action: "wait", ms });
    } else {
      errors.push(`State line ${lineNumber} action must be click or wait.`);
      continue;
    }
    const expectation = rawExpectation.join(" | ").trim();
    if (expectation) state.expectations.push(expectation);
    byName.set(rawName, state);
  }
  return { states: [...byName.values()], errors };
}

export function buildDesignContract(form: DesignComposerFields): DesignContract | undefined {
  if (!form.designEnabled) return undefined;
  const { states } = parseDesignStates(form.designStates);
  return {
    kind: form.designKind,
    ...(form.designTargetUrl.trim() ? { targetUrl: form.designTargetUrl.trim() } : {}),
    ...(form.designAudience.trim() ? { audience: form.designAudience.trim() } : {}),
    ...(form.designPrimaryAction.trim() ? { primaryAction: form.designPrimaryAction.trim() } : {}),
    requirements: lines(form.designRequirements),
    referenceImages: references(form.designReferenceImages),
    referenceImagePolicy: form.allowReferenceImageModelUpload ? "vision-model" : "local-only",
    states,
    viewports: paths(form.designViewports),
    inspirations: form.designInspirations,
    variants: form.designVariants,
    elementEdits: form.designElementEdits,
    assetRequests: form.designAssetRequests,
    cms: {
      strategy: form.cmsStrategy,
      ...(form.cmsProviderHint.trim() ? { providerHint: form.cmsProviderHint.trim() } : {}),
      schemaPaths: paths(form.cmsSchemaPaths),
      requirements: lines(form.cmsRequirements),
      localizationRequired: form.cmsLocalizationRequired,
    },
    designTokens: {
      strategy: form.designTokenStrategy,
      sourcePaths: paths(form.designTokenSourcePaths),
      requirements: lines(form.designTokenRequirements),
      allowNewTokens: form.allowNewDesignTokens,
    },
  };
}

function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function isOfficialMobbinUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "mobbin.com" || url.hostname.endsWith(".mobbin.com"))
    );
  } catch {
    return false;
  }
}

const DESIGN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const SCREENSHOT_RE = /^[A-Za-z0-9x-]+\.png$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;

function validElementEdit(item: DesignElementEdit): boolean {
  const { region, style } = item;
  const normalizedRegion =
    Number.isFinite(region.x) &&
    Number.isFinite(region.y) &&
    region.x >= 0 &&
    region.x <= 1 &&
    region.y >= 0 &&
    region.y <= 1 &&
    (region.width === undefined ||
      (Number.isFinite(region.width) &&
        region.width >= 0 &&
        region.width <= 1 &&
        region.x + region.width <= 1.000_001)) &&
    (region.height === undefined ||
      (Number.isFinite(region.height) &&
        region.height >= 0 &&
        region.height <= 1 &&
        region.y + region.height <= 1.000_001));
  const numericBounds: Array<[number | undefined, number, number]> = [
    [style.fontSizePx, 8, 240],
    [style.fontWeight, 100, 900],
    [style.lineHeight, 0.5, 4],
    [style.paddingPx, 0, 512],
    [style.marginPx, -512, 512],
    [style.gapPx, 0, 512],
    [style.borderWidthPx, 0, 64],
    [style.borderRadiusPx, 0, 2_000],
    [style.opacity, 0, 1],
  ];
  const colors = [style.textColor, style.backgroundColor, style.borderColor].filter(
    (value): value is string => value !== undefined,
  );
  return (
    DESIGN_ID_RE.test(item.id) &&
    !!item.target.trim() &&
    SCREENSHOT_RE.test(item.screenshot) &&
    !!item.viewport.trim() &&
    !!item.state.trim() &&
    normalizedRegion &&
    (!item.sourcePathHint || safeRelativePath(item.sourcePathHint)) &&
    (!item.imageSource || safeRelativePath(item.imageSource)) &&
    colors.every((color) => HEX_COLOR_RE.test(color)) &&
    (!style.fontFamily || !/[{};]/.test(style.fontFamily)) &&
    numericBounds.every(
      ([value, minimum, maximum]) =>
        value === undefined || (Number.isFinite(value) && value >= minimum && value <= maximum),
    ) &&
    (item.text !== undefined || !!item.imageSource || Object.keys(style).length > 0) &&
    !Number.isNaN(Date.parse(item.createdAt))
  );
}

function validAssetRequest(item: DesignAssetRequest): boolean {
  const extension = item.outputPath.slice(item.outputPath.lastIndexOf(".")).toLowerCase();
  const extensions =
    item.kind === "image"
      ? [".png", ".jpg", ".jpeg", ".webp"]
      : item.kind === "video"
        ? [".mp4", ".webm", ".mov"]
        : [".svg"];
  return (
    DESIGN_ID_RE.test(item.id) &&
    !!item.prompt.trim() &&
    item.prompt.length <= 2_000 &&
    safeRelativePath(item.outputPath) &&
    extensions.includes(extension) &&
    ["1:1", "16:9", "9:16", "4:3", "3:4"].includes(item.aspectRatio) &&
    (item.kind === "image"
      ? item.size !== undefined && ["1K", "2K", "4K"].includes(item.size)
      : item.kind === "video"
        ? item.resolution !== undefined &&
          ["720p", "1080p"].includes(item.resolution) &&
          item.durationSeconds !== undefined &&
          [2, 4, 6, 8].includes(item.durationSeconds) &&
          typeof item.audio === "boolean"
        : typeof item.animated === "boolean") &&
    item.referenceImages.length <= 5 &&
    item.referenceImages.every(
      (reference) =>
        safeRelativePath(reference.path) && /\.(?:png|jpe?g|webp)$/i.test(reference.path),
    ) &&
    ["local-only", "generation-model"].includes(item.referenceUploadPolicy) &&
    (!item.screenshot || SCREENSHOT_RE.test(item.screenshot)) &&
    !Number.isNaN(Date.parse(item.createdAt))
  );
}

export function designComposerError(form: DesignComposerFields): string | null {
  if (!form.designEnabled) return null;
  if (form.designTargetUrl.trim() && !isLoopbackUrl(form.designTargetUrl.trim())) {
    return "Design target URL must use http(s) on localhost, 127.0.0.1, or ::1.";
  }
  const stateError = parseDesignStates(form.designStates).errors[0];
  if (stateError) return stateError;
  const allPaths = [
    ...references(form.designReferenceImages).map((entry) => entry.path),
    ...paths(form.cmsSchemaPaths),
    ...paths(form.designTokenSourcePaths),
  ];
  if (allPaths.some((entry) => !safeRelativePath(entry))) {
    return "Design references, CMS schemas, and token sources must be workspace-relative paths without '..'.";
  }
  if (
    form.designInspirations.length > 20 ||
    form.designInspirations.some(
      (item) =>
        !item.screenId.trim() ||
        !item.appName.trim() ||
        !item.query.trim() ||
        !isOfficialMobbinUrl(item.mobbinUrl),
    )
  ) {
    return "Mobbin inspiration must come from an official HTTPS Mobbin screen URL.";
  }
  if (
    form.designVariants.length > 10 ||
    form.designVariants.some(
      (item) =>
        !item.id.trim() ||
        !item.target.trim() ||
        ![2, 3, 4].includes(item.count) ||
        !item.directions.length ||
        item.directions.length > 4 ||
        item.directions.some((direction) => !direction.trim()),
    )
  ) {
    return "Each variant request needs a target, 2–4 variants, and at least one direction.";
  }
  if (
    form.designElementEdits.length > 50 ||
    form.designElementEdits.some((item) => !validElementEdit(item))
  ) {
    return "Visual element edits must target a captured area and use safe, bounded source/style values.";
  }
  if (
    form.designAssetRequests.length > 20 ||
    form.designAssetRequests.some((item) => !validAssetRequest(item))
  ) {
    return "Asset requests need a prompt, matching media extension, and safe workspace-relative output/reference paths.";
  }
  const viewports = paths(form.designViewports);
  if (!viewports.length || viewports.some((entry) => !/^\d{3,4}x\d{3,4}$/.test(entry))) {
    return "Design viewports must use WxH, for example 1440x900, 390x844.";
  }
  return null;
}
