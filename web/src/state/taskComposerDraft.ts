import type { TaskComposerFormState } from "./buildTaskContract";
import { DEFAULT_DESIGN_FORM } from "./designContract";

const STORAGE_KEY = "glimmer.task-composer-draft.v1";
const INTENTS = new Set(["auto", "direct", "improvement-assessment"]);
const SCOPES = new Set(["repository", "frontend", "backend", "directory", "files"]);
const MODES = new Set(["inspect", "plan", "implement", "debug", "test", "review", "refactor"]);
const TOOLCHAINS = new Set(["path", "linked", "none"]);
const VERIFICATION = new Set(["frontend-typecheck", "targeted-test", "visual"]);
const DESIGN_KINDS = new Set(["build", "improve", "audit", "reference-match"]);
const DESIGN_STRATEGIES = new Set(["detect", "existing", "required", "none"]);

export interface TaskComposerDraft {
  form: TaskComposerFormState;
  workspace: string;
  newTaskName: string;
  savedAt: string;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function optionalInteger(value: unknown, min: number, max: number): value is number | undefined {
  return (
    value === undefined || (Number.isInteger(value) && Number(value) >= min && Number(value) <= max)
  );
}

function officialMobbinUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2_048) return false;
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

function validInspirations(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every(
      (item: any) =>
        item?.source === "mobbin" &&
        boundedString(item.screenId, 200) &&
        boundedString(item.appName, 200) &&
        (item.platform === "ios" || item.platform === "web") &&
        boundedString(item.query, 500) &&
        officialMobbinUrl(item.mobbinUrl) &&
        (item.notes === undefined || boundedString(item.notes, 1_000)),
    )
  );
}

function validVariants(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 10 &&
    value.every(
      (item: any) =>
        boundedString(item?.id, 100) &&
        boundedString(item.target, 500) &&
        [2, 3, 4].includes(item.count) &&
        Array.isArray(item.directions) &&
        item.directions.length >= 1 &&
        item.directions.length <= 4 &&
        item.directions.every((direction: unknown) => boundedString(direction, 500)),
    )
  );
}

function normalizedPoint(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as any).x === "number" &&
    (value as any).x >= 0 &&
    (value as any).x <= 1 &&
    typeof (value as any).y === "number" &&
    (value as any).y >= 0 &&
    (value as any).y <= 1
  );
}

function validElementEdits(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 50 &&
    value.every(
      (item: any) =>
        boundedString(item?.id, 100) &&
        boundedString(item.target, 500) &&
        boundedString(item.screenshot, 255) &&
        boundedString(item.viewport, 40) &&
        boundedString(item.state, 80) &&
        normalizedPoint(item.region) &&
        item.style &&
        typeof item.style === "object" &&
        boundedString(item.createdAt, 64),
    )
  );
}

function validAssetRequests(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every(
      (item: any) =>
        boundedString(item?.id, 100) &&
        ["image", "video", "vector"].includes(item.kind) &&
        boundedString(item.prompt, 2_000) &&
        boundedString(item.outputPath, 4_096) &&
        ["1:1", "16:9", "9:16", "4:3", "3:4"].includes(item.aspectRatio) &&
        Array.isArray(item.referenceImages) &&
        item.referenceImages.length <= 5 &&
        (item.referenceUploadPolicy === "local-only" ||
          item.referenceUploadPolicy === "generation-model") &&
        boundedString(item.createdAt, 64),
    )
  );
}

function parseDraft(value: unknown): TaskComposerDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Record<string, unknown>;
  const rawForm = draft.form as Record<string, unknown> | undefined;
  const form = rawForm
    ? ({ ...DEFAULT_DESIGN_FORM, ...rawForm } as Record<string, unknown>)
    : undefined;
  if (
    (draft.version !== 1 && draft.version !== 2 && draft.version !== 3) ||
    !form ||
    !boundedString(form.objective, 20_000) ||
    !INTENTS.has(String(form.intentKind)) ||
    !SCOPES.has(String(form.scopePackage)) ||
    !boundedString(form.scopeArea, 4_096) ||
    !MODES.has(String(form.mode)) ||
    !Array.isArray(form.verification) ||
    !form.verification.every((item) => typeof item === "string" && VERIFICATION.has(item)) ||
    !Number.isInteger(form.repairBudget) ||
    Number(form.repairBudget) < 0 ||
    Number(form.repairBudget) > 5 ||
    !optionalInteger(form.maxTurns, 1, 64) ||
    !optionalInteger(form.maxChangedFiles, 1, 500) ||
    !optionalInteger(form.timeoutSeconds, 60, 3_600) ||
    (form.toolchainMode !== undefined && !TOOLCHAINS.has(String(form.toolchainMode))) ||
    !boundedString(form.modelReadinessUrl, 2_048) ||
    (form.architectFirst !== undefined && typeof form.architectFirst !== "boolean") ||
    typeof form.designEnabled !== "boolean" ||
    !DESIGN_KINDS.has(String(form.designKind)) ||
    !boundedString(form.designTargetUrl, 2_048) ||
    !boundedString(form.designAudience, 500) ||
    !boundedString(form.designPrimaryAction, 500) ||
    !boundedString(form.designRequirements, 20_000) ||
    !boundedString(form.designReferenceImages, 20_000) ||
    typeof form.allowReferenceImageModelUpload !== "boolean" ||
    !boundedString(form.designStates, 20_000) ||
    !boundedString(form.designViewports, 1_000) ||
    !validInspirations(form.designInspirations) ||
    !validVariants(form.designVariants) ||
    !validElementEdits(form.designElementEdits) ||
    !validAssetRequests(form.designAssetRequests) ||
    !DESIGN_STRATEGIES.has(String(form.cmsStrategy)) ||
    !boundedString(form.cmsProviderHint, 500) ||
    !boundedString(form.cmsSchemaPaths, 20_000) ||
    !boundedString(form.cmsRequirements, 20_000) ||
    typeof form.cmsLocalizationRequired !== "boolean" ||
    !DESIGN_STRATEGIES.has(String(form.designTokenStrategy)) ||
    !boundedString(form.designTokenSourcePaths, 20_000) ||
    !boundedString(form.designTokenRequirements, 20_000) ||
    typeof form.allowNewDesignTokens !== "boolean" ||
    !boundedString(draft.workspace, 4_096) ||
    !boundedString(draft.newTaskName, 256) ||
    typeof draft.savedAt !== "string"
  ) {
    return null;
  }
  return {
    form: form as unknown as TaskComposerFormState,
    workspace: draft.workspace,
    newTaskName: draft.newTaskName,
    savedAt: draft.savedAt,
  };
}

export function loadTaskComposerDraft(): TaskComposerDraft | null {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = parseDraft(JSON.parse(raw));
    if (!parsed) window.localStorage?.removeItem(STORAGE_KEY);
    return parsed;
  } catch {
    return null;
  }
}

export function saveTaskComposerDraft(
  form: TaskComposerFormState,
  workspace: string,
  newTaskName: string,
): void {
  try {
    window.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 3,
        form,
        workspace,
        newTaskName,
        savedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // Local storage may be disabled or full; the composer remains fully usable.
  }
}

export function clearTaskComposerDraft(): void {
  try {
    window.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort cleanup only.
  }
}
