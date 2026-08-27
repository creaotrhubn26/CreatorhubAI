import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  LiveDesignDraftJournal,
  LiveDesignDraftUpdate,
  LiveDesignProposalResponse,
  LiveDesignStructureOperationRequest,
} from "@glimmer/shared";
import { sessionsDir } from "../config.js";
import { isValidSessionId, resolveSessionId } from "./sessions.js";
import { LiveDesignBridgeError } from "./liveDesignBridge.js";

const FILE_NAME = "live-design-draft.json";
const MAX_BYTES = 192 * 1024;
const SAFE_CLASS = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const TABS = new Set([
  "structure",
  "content",
  "style",
  "layout",
  "component",
  "responsive",
  "tokens",
  "code",
  "review",
  "variants",
  "history",
]);
const VIEWPORTS = new Set(["auto", "mobile", "tablet", "desktop"]);
const TOOLS = new Set(["comment", "draw", "rectangle", "ellipse", "arrow", "sticky"]);
const BREAKPOINTS = new Set(["mobile", "tablet", "desktop"]);
const RESPONSIVE_PROPERTIES = new Set([
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "line-height",
  "padding",
  "margin",
  "gap",
  "border-width",
  "border-radius",
  "opacity",
  "flex-direction",
  "align-items",
  "justify-content",
]);
const DRAFT_FIELDS = new Set([
  "text",
  "imageSource",
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
  "display",
  "flexWrap",
  "alignItemsValue",
  "alignContent",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "zIndex",
  "gridTemplateColumns",
  "gridTemplateRows",
  "gridAutoFlow",
  "gridColumn",
  "gridRow",
  "order",
  "flex",
  "boxSizing",
]);

const mutationTails = new Map<string, Promise<void>>();

async function withSessionMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationTails.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutationTails.set(sessionId, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(sessionId) === current) mutationTails.delete(sessionId);
  }
}

function sessionIdFor(id: string): string {
  const resolved = resolveSessionId(id);
  if (!isValidSessionId(resolved)) throw new LiveDesignBridgeError("session not found", 404);
  return resolved;
}

function fileFor(sessionId: string): string {
  return path.join(sessionsDir(), sessionId, FILE_NAME);
}

function localRoute(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && !value.includes("\0");
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function selector(value: unknown): value is string {
  return bounded(value, 1_000) && Boolean(value);
}

function draft(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    entries.length <= DRAFT_FIELDS.size &&
    entries.every(
      ([field, fieldValue]) =>
        DRAFT_FIELDS.has(field) && bounded(fieldValue, field === "text" ? 5_000 : 500),
    )
  );
}

function proposal(value: unknown): value is LiveDesignProposalResponse | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    bounded(raw.id, 100) &&
    bounded(raw.prompt, 2_000) &&
    bounded(raw.summary, 500) &&
    (raw.provenance === "model-output" || raw.provenance === "deterministic-fallback") &&
    bounded(raw.createdAt, 100) &&
    Array.isArray(raw.changes) &&
    raw.changes.length <= 20 &&
    raw.changes.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const change = entry as Record<string, unknown>;
      return (
        typeof change.field === "string" &&
        DRAFT_FIELDS.has(change.field) &&
        bounded(change.label, 100) &&
        bounded(change.before, change.field === "text" ? 5_000 : 500) &&
        bounded(change.after, change.field === "text" ? 5_000 : 500) &&
        bounded(change.reason, 500)
      );
    })
  );
}

function structureTarget(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    "selector",
    "tagName",
    "text",
    "attributes",
    "sourcePathHint",
    "framework",
    "componentName",
  ]);
  return (
    Object.keys(raw).every((key) => allowed.has(key)) &&
    selector(raw.selector) &&
    bounded(raw.tagName, 50) &&
    /^[A-Za-z][A-Za-z0-9:-]{0,49}$/.test(raw.tagName) &&
    bounded(raw.text, 5_000) &&
    !!raw.attributes &&
    typeof raw.attributes === "object" &&
    !Array.isArray(raw.attributes) &&
    Object.keys(raw.attributes).length <= 50 &&
    Object.entries(raw.attributes as Record<string, unknown>).every(
      ([key, entry]) => /^[A-Za-z_:][A-Za-z0-9_.:-]{0,99}$/.test(key) && bounded(entry, 1_000),
    ) &&
    (raw.sourcePathHint === undefined || bounded(raw.sourcePathHint, 1_000)) &&
    (raw.framework === undefined ||
      ["react", "vue", "svelte", "html", "unknown"].includes(String(raw.framework))) &&
    (raw.componentName === undefined || bounded(raw.componentName, 200))
  );
}

function structureOperation(
  value: unknown,
): value is LiveDesignStructureOperationRequest | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const changeSetValid = raw.changeSetId === undefined || bounded(raw.changeSetId, 100);
  if (!changeSetValid) return false;
  if (raw.kind === "reorder") {
    return (
      Object.keys(raw).every((key) =>
        ["kind", "moving", "anchor", "placement", "changeSetId"].includes(key),
      ) &&
      structureTarget(raw.moving) &&
      structureTarget(raw.anchor) &&
      (raw.placement === "before" || raw.placement === "after")
    );
  }
  if (raw.kind === "reparent") {
    return (
      Object.keys(raw).every((key) =>
        ["kind", "moving", "target", "placement", "changeSetId"].includes(key),
      ) &&
      structureTarget(raw.moving) &&
      structureTarget(raw.target) &&
      (raw.placement === "inside-start" || raw.placement === "inside-end")
    );
  }
  if (raw.kind === "insert") {
    return (
      Object.keys(raw).every((key) =>
        ["kind", "target", "placement", "preset", "text", "changeSetId"].includes(key),
      ) &&
      structureTarget(raw.target) &&
      ["inside-start", "inside-end", "before", "after"].includes(String(raw.placement)) &&
      ["section", "heading", "paragraph", "button", "divider"].includes(String(raw.preset)) &&
      bounded(raw.text, 5_000)
    );
  }
  return false;
}

function validUpdate(value: unknown): value is LiveDesignDraftUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    "route",
    "sequence",
    "selectedSelector",
    "selectedSelectors",
    "lockedSelectors",
    "hiddenSelectors",
    "activeTab",
    "viewportId",
    "zoom",
    "inspectorWidth",
    "elementPrompt",
    "annotationComment",
    "annotationTool",
    "annotationPoints",
    "annotating",
    "assetPrompt",
    "assetPath",
    "previewMode",
    "resizeMode",
    "responsiveBreakpoint",
    "responsiveProperty",
    "responsiveValue",
    "responsiveOverrides",
    "responsivePreviewed",
    "styleScope",
    "selectedClass",
    "textCandidateId",
    "tokenCandidateId",
    "tokenReplacement",
    "tokenBindingProperty",
    "draft",
    "originalDraft",
    "pendingStructure",
    "proposal",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return false;
  return (
    localRoute(raw.route) &&
    Number.isInteger(raw.sequence) &&
    Number(raw.sequence) >= 0 &&
    Number(raw.sequence) <= Number.MAX_SAFE_INTEGER &&
    (raw.selectedSelector === undefined || selector(raw.selectedSelector)) &&
    Array.isArray(raw.selectedSelectors) &&
    raw.selectedSelectors.length <= 50 &&
    new Set(raw.selectedSelectors).size === raw.selectedSelectors.length &&
    raw.selectedSelectors.every(selector) &&
    Array.isArray(raw.lockedSelectors) &&
    raw.lockedSelectors.length <= 500 &&
    new Set(raw.lockedSelectors).size === raw.lockedSelectors.length &&
    raw.lockedSelectors.every(selector) &&
    Array.isArray(raw.hiddenSelectors) &&
    raw.hiddenSelectors.length <= 500 &&
    new Set(raw.hiddenSelectors).size === raw.hiddenSelectors.length &&
    raw.hiddenSelectors.every(selector) &&
    typeof raw.activeTab === "string" &&
    TABS.has(raw.activeTab) &&
    typeof raw.viewportId === "string" &&
    VIEWPORTS.has(raw.viewportId) &&
    Number.isInteger(raw.zoom) &&
    Number(raw.zoom) >= 25 &&
    Number(raw.zoom) <= 200 &&
    Number.isInteger(raw.inspectorWidth) &&
    Number(raw.inspectorWidth) >= 280 &&
    Number(raw.inspectorWidth) <= 640 &&
    bounded(raw.elementPrompt, 2_000) &&
    bounded(raw.annotationComment, 4_000) &&
    typeof raw.annotationTool === "string" &&
    TOOLS.has(raw.annotationTool) &&
    Array.isArray(raw.annotationPoints) &&
    raw.annotationPoints.length <= 500 &&
    raw.annotationPoints.every(
      (point) =>
        !!point &&
        typeof point === "object" &&
        !Array.isArray(point) &&
        typeof (point as Record<string, unknown>).x === "number" &&
        Number((point as Record<string, unknown>).x) >= 0 &&
        Number((point as Record<string, unknown>).x) <= 1 &&
        typeof (point as Record<string, unknown>).y === "number" &&
        Number((point as Record<string, unknown>).y) >= 0 &&
        Number((point as Record<string, unknown>).y) <= 1,
    ) &&
    optionalBoolean(raw.annotating) &&
    (raw.assetPrompt === undefined || bounded(raw.assetPrompt, 2_000)) &&
    (raw.assetPath === undefined || bounded(raw.assetPath, 1_000)) &&
    optionalBoolean(raw.previewMode) &&
    optionalBoolean(raw.resizeMode) &&
    typeof raw.responsiveBreakpoint === "string" &&
    BREAKPOINTS.has(raw.responsiveBreakpoint) &&
    typeof raw.responsiveProperty === "string" &&
    RESPONSIVE_PROPERTIES.has(raw.responsiveProperty) &&
    bounded(raw.responsiveValue, 200) &&
    !!raw.responsiveOverrides &&
    typeof raw.responsiveOverrides === "object" &&
    !Array.isArray(raw.responsiveOverrides) &&
    Object.keys(raw.responsiveOverrides).length <= 100 &&
    Object.entries(raw.responsiveOverrides as Record<string, unknown>).every(
      ([key, value]) => /^(mobile|tablet|desktop):[a-z-]{1,80}$/.test(key) && bounded(value, 200),
    ) &&
    optionalBoolean(raw.responsivePreviewed) &&
    (raw.styleScope === "instance" || raw.styleScope === "component") &&
    (raw.selectedClass === undefined ||
      (typeof raw.selectedClass === "string" && SAFE_CLASS.test(raw.selectedClass))) &&
    (raw.textCandidateId === undefined || bounded(raw.textCandidateId, 100)) &&
    (raw.tokenCandidateId === undefined || bounded(raw.tokenCandidateId, 100)) &&
    (raw.tokenReplacement === undefined || bounded(raw.tokenReplacement, 500)) &&
    (raw.tokenBindingProperty === undefined ||
      (bounded(raw.tokenBindingProperty, 100) && /^[a-z-]+$/.test(raw.tokenBindingProperty))) &&
    draft(raw.draft) &&
    draft(raw.originalDraft) &&
    structureOperation(raw.pendingStructure) &&
    proposal(raw.proposal) &&
    Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_BYTES
  );
}

async function readFile(sessionId: string): Promise<LiveDesignDraftJournal | null> {
  try {
    const raw = JSON.parse(await fs.readFile(fileFor(sessionId), "utf8")) as LiveDesignDraftJournal;
    const {
      version: _version,
      sessionId: _sessionId,
      updatedAt: _updatedAt,
      ...update
    } = raw ?? {};
    if (
      raw?.version !== 1 ||
      raw.sessionId !== sessionId ||
      !bounded(raw.updatedAt, 100) ||
      !validUpdate(update)
    ) {
      return null;
    }
    return raw;
  } catch (error: any) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeFile(document: LiveDesignDraftJournal): Promise<void> {
  const file = fileFor(document.sessionId);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const handle = await fs.open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function readLiveDesignDraft(id: string): Promise<LiveDesignDraftJournal | null> {
  return readFile(sessionIdFor(id));
}

export function writeLiveDesignDraft(id: string, input: unknown): Promise<LiveDesignDraftJournal> {
  const sessionId = sessionIdFor(id);
  if (!validUpdate(input)) throw new LiveDesignBridgeError("live design draft is invalid", 400);
  return withSessionMutation(sessionId, async () => {
    const existing = await readFile(sessionId);
    if (existing && existing.sequence >= input.sequence) return existing;
    const document: LiveDesignDraftJournal = {
      version: 1,
      sessionId,
      updatedAt: new Date().toISOString(),
      ...input,
    };
    await writeFile(document);
    return document;
  });
}

export function clearLiveDesignDraft(id: string): Promise<void> {
  const sessionId = sessionIdFor(id);
  return withSessionMutation(sessionId, async () => {
    await fs.rm(fileFor(sessionId), { force: true });
  });
}
