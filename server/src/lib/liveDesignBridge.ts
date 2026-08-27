import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  LiveDesignApplyResponse,
  LiveDesignAuditFinding,
  LiveDesignBridgeInstallResponse,
  LiveDesignCmsReference,
  LiveDesignElement,
  LiveDesignHistoryResponse,
  LiveDesignRevision,
  LiveDesignRollbackResponse,
  LiveDesignResponsiveOverrideResponse,
  LiveDesignResponsiveProperty,
  LiveDesignSourceCandidate,
  LiveDesignSourceCandidateKind,
  LiveDesignStyleOverrideResponse,
  LiveDesignStyleProperty,
  LiveDesignStyleSource,
  LiveDesignStyleScope,
  LiveDesignStructureOperationResponse,
  LiveDesignStructureTarget,
  LiveDesignTokenNode,
  LiveDesignTransactionResponse,
} from "@glimmer/shared";
import { sessionsDir } from "../config.js";

const SOURCE_EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js", ".vue", ".svelte", ".html"]);
const STYLE_EXTENSIONS = new Set([".css", ".scss", ".less"]);
const EMBEDDED_STYLE_EXTENSIONS = new Set([".vue", ".svelte"]);
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".svelte-kit",
  ".cache",
  "coverage",
  "target",
  "vendor",
]);
const MAX_FILES = 5_000;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 50;
const HASH_RE = /^[a-f0-9]{64}$/;
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SAFE_REVISION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const SAFE_TOKEN_RE = /^--[A-Za-z0-9_-]{1,100}$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const CSS_VALUE_RE = /^-?[0-9]+(?:\.[0-9]+)?(?:px|rem|em|%|vh|vw)?$/i;
const FRAMEWORKS = new Set(["html", "react", "vue", "svelte", "unknown"]);
const EDITABLE_CSS_PROPERTIES = new Set([
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "padding",
  "margin",
  "gap",
  "border-color",
  "border-width",
  "border-radius",
  "opacity",
  "flex-direction",
  "flex-wrap",
  "align-items",
  "align-content",
  "justify-content",
  "display",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "z-index",
  "grid-template-columns",
  "grid-template-rows",
  "grid-auto-flow",
  "grid-column",
  "grid-row",
  "order",
  "flex",
  "box-sizing",
]);
const RESPONSIVE_PROPERTIES = new Set<LiveDesignResponsiveProperty>([
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
const STYLE_OVERRIDE_PROPERTIES = new Set<LiveDesignStyleProperty>([
  "display",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "z-index",
  "grid-template-columns",
  "grid-template-rows",
  "grid-auto-flow",
  "grid-column",
  "grid-row",
  "flex-direction",
  "flex-wrap",
  "align-items",
  "align-content",
  "justify-content",
  "order",
  "flex",
  "gap",
  "padding",
  "margin",
  "box-sizing",
]);
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const STYLE_KEYS = [
  "color",
  "backgroundColor",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "padding",
  "margin",
  "gap",
  "borderColor",
  "borderWidth",
  "borderRadius",
  "opacity",
  "display",
  "flexDirection",
  "flexWrap",
  "alignItems",
  "alignContent",
  "justifyContent",
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
] as const;
const ATTRIBUTE_KEYS = new Set([
  "id",
  "class",
  "data-testid",
  "aria-label",
  "role",
  "src",
  "alt",
  "href",
  "name",
  "type",
]);
const sessionMutationTails = new Map<string, Promise<void>>();

async function withSessionMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionMutationTails.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  sessionMutationTails.set(sessionId, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (sessionMutationTails.get(sessionId) === tail) sessionMutationTails.delete(sessionId);
  }
}

export class LiveDesignBridgeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
  }
}

function exactKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(raw).every((key) => accepted.has(key));
}

function boundedString(value: unknown, max: number, allowEmpty = false): string | null {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) return null;
  if (!allowEmpty && !value.trim()) return null;
  return allowEmpty ? value : value.trim();
}

function finiteNumber(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

export function normalizeLiveDesignElement(input: unknown): LiveDesignElement | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (
    !exactKeys(raw, [
      "selector",
      "tagName",
      "text",
      "attributes",
      "styles",
      "rect",
      "sourcePathHint",
      "tokens",
      "framework",
      "componentName",
      "stableId",
      "breadcrumbs",
      "styleSources",
    ])
  ) {
    return null;
  }
  const selector = boundedString(raw.selector, 1_000);
  const tagName = boundedString(raw.tagName, 50);
  const text = boundedString(raw.text, 2_000, true);
  const sourcePathHint =
    raw.sourcePathHint === undefined ? undefined : boundedString(raw.sourcePathHint, 4_096);
  const framework = raw.framework === undefined ? undefined : boundedString(raw.framework, 20);
  const componentName =
    raw.componentName === undefined ? undefined : boundedString(raw.componentName, 200);
  const stableId = raw.stableId === undefined ? undefined : boundedString(raw.stableId, 1_000);
  if (
    !selector ||
    !tagName ||
    !/^[a-z][a-z0-9-]*$/i.test(tagName) ||
    text === null ||
    (raw.sourcePathHint !== undefined && !sourcePathHint) ||
    (raw.framework !== undefined && (!framework || !FRAMEWORKS.has(framework))) ||
    (raw.componentName !== undefined && !componentName) ||
    (raw.stableId !== undefined && !stableId)
  ) {
    return null;
  }

  if (!raw.attributes || typeof raw.attributes !== "object" || Array.isArray(raw.attributes)) {
    return null;
  }
  const attributes: Record<string, string> = {};
  const rawAttributes = raw.attributes as Record<string, unknown>;
  if (Object.keys(rawAttributes).length > ATTRIBUTE_KEYS.size) return null;
  for (const [key, value] of Object.entries(rawAttributes)) {
    const normalized = boundedString(value, 500, true);
    if (!ATTRIBUTE_KEYS.has(key) || normalized === null) return null;
    attributes[key] = normalized;
  }

  if (!raw.styles || typeof raw.styles !== "object" || Array.isArray(raw.styles)) return null;
  const rawStyles = raw.styles as Record<string, unknown>;
  if (!exactKeys(rawStyles, STYLE_KEYS)) return null;
  const styles = {} as LiveDesignElement["styles"];
  for (const key of STYLE_KEYS) {
    const value = boundedString(rawStyles[key], 500, true);
    if (value === null) return null;
    styles[key] = value;
  }

  if (!raw.rect || typeof raw.rect !== "object" || Array.isArray(raw.rect)) return null;
  const rawRect = raw.rect as Record<string, unknown>;
  if (!exactKeys(rawRect, ["x", "y", "width", "height", "viewportWidth", "viewportHeight"])) {
    return null;
  }
  const viewportWidth = finiteNumber(rawRect.viewportWidth, 1, 16_384);
  const viewportHeight = finiteNumber(rawRect.viewportHeight, 1, 16_384);
  if (viewportWidth === null || viewportHeight === null) return null;
  const x = finiteNumber(rawRect.x, 0, viewportWidth);
  const y = finiteNumber(rawRect.y, 0, viewportHeight);
  const width = finiteNumber(rawRect.width, 0, viewportWidth);
  const height = finiteNumber(rawRect.height, 0, viewportHeight);
  if (x === null || y === null || width === null || height === null) return null;

  if (!Array.isArray(raw.tokens) || raw.tokens.length > 50) return null;
  const tokens: LiveDesignElement["tokens"] = [];
  const seenTokens = new Set<string>();
  for (const entry of raw.tokens) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const token = entry as Record<string, unknown>;
    if (!exactKeys(token, ["name", "value", "property"])) return null;
    const name = boundedString(token.name, 102);
    const value = boundedString(token.value, 200);
    const property = boundedString(token.property, 80);
    if (
      !name ||
      !SAFE_TOKEN_RE.test(name) ||
      !value ||
      !property ||
      !/^[a-z-]+$/.test(property) ||
      seenTokens.has(`${name}\0${property}`)
    ) {
      return null;
    }
    seenTokens.add(`${name}\0${property}`);
    tokens.push({ name, value, property });
  }

  const breadcrumbs: NonNullable<LiveDesignElement["breadcrumbs"]> = [];
  if (raw.breadcrumbs !== undefined) {
    if (!Array.isArray(raw.breadcrumbs) || raw.breadcrumbs.length > 8) return null;
    for (const entry of raw.breadcrumbs) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const breadcrumb = entry as Record<string, unknown>;
      if (!exactKeys(breadcrumb, ["tagName", "selector", "label"])) return null;
      const breadcrumbTag = boundedString(breadcrumb.tagName, 50);
      const breadcrumbSelector = boundedString(breadcrumb.selector, 1_000);
      const label = boundedString(breadcrumb.label, 200);
      if (
        !breadcrumbTag ||
        !/^[a-z][a-z0-9-]*$/i.test(breadcrumbTag) ||
        !breadcrumbSelector ||
        !label
      )
        return null;
      breadcrumbs.push({
        tagName: breadcrumbTag.toLowerCase(),
        selector: breadcrumbSelector,
        label,
      });
    }
  }

  const styleSources: LiveDesignStyleSource[] = [];
  if (raw.styleSources !== undefined) {
    if (!Array.isArray(raw.styleSources) || raw.styleSources.length > 30) return null;
    for (const entry of raw.styleSources) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const styleSource = entry as Record<string, unknown>;
      if (
        !exactKeys(styleSource, [
          "selector",
          "source",
          "specificity",
          "inherited",
          "declarations",
        ]) ||
        typeof styleSource.inherited !== "boolean" ||
        !Array.isArray(styleSource.declarations) ||
        styleSource.declarations.length > 80
      ) {
        return null;
      }
      const styleSelector = boundedString(styleSource.selector, 1_000);
      const styleSourceName = boundedString(styleSource.source, 500);
      const specificity = boundedString(styleSource.specificity, 50);
      if (!styleSelector || !styleSourceName || !specificity) return null;
      const declarations: LiveDesignStyleSource["declarations"] = [];
      for (const declarationEntry of styleSource.declarations) {
        if (
          !declarationEntry ||
          typeof declarationEntry !== "object" ||
          Array.isArray(declarationEntry)
        ) {
          return null;
        }
        const declaration = declarationEntry as Record<string, unknown>;
        if (
          !exactKeys(declaration, ["property", "value", "important"]) ||
          typeof declaration.important !== "boolean"
        ) {
          return null;
        }
        const property = boundedString(declaration.property, 100);
        const value = boundedString(declaration.value, 500, true);
        if (!property || value === null || !/^[a-z-]+$/.test(property)) return null;
        declarations.push({ property, value, important: declaration.important });
      }
      styleSources.push({
        selector: styleSelector,
        source: styleSourceName,
        specificity,
        inherited: styleSource.inherited,
        declarations,
      });
    }
  }

  return {
    selector,
    tagName: tagName.toLowerCase(),
    text,
    attributes,
    styles,
    rect: { x, y, width, height, viewportWidth, viewportHeight },
    ...(sourcePathHint ? { sourcePathHint } : {}),
    tokens,
    ...(framework ? { framework: framework as LiveDesignElement["framework"] } : {}),
    ...(componentName ? { componentName } : {}),
    ...(stableId ? { stableId } : {}),
    ...(raw.breadcrumbs !== undefined ? { breadcrumbs } : {}),
    ...(raw.styleSources !== undefined ? { styleSources } : {}),
  };
}

function normalizeStructureTarget(input: unknown): LiveDesignStructureTarget | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (
    !exactKeys(raw, [
      "selector",
      "tagName",
      "text",
      "attributes",
      "sourcePathHint",
      "framework",
      "componentName",
    ])
  ) {
    return null;
  }
  const selector = boundedString(raw.selector, 1_000);
  const tagName = boundedString(raw.tagName, 50);
  const text = boundedString(raw.text, 500, true);
  const sourcePathHint =
    raw.sourcePathHint === undefined ? undefined : boundedString(raw.sourcePathHint, 4_096);
  const framework = raw.framework === undefined ? undefined : boundedString(raw.framework, 20);
  const componentName =
    raw.componentName === undefined ? undefined : boundedString(raw.componentName, 200);
  if (
    !selector ||
    !tagName ||
    !/^[a-z][a-z0-9-]*$/i.test(tagName) ||
    text === null ||
    (raw.sourcePathHint !== undefined && !sourcePathHint) ||
    (raw.framework !== undefined && (!framework || !FRAMEWORKS.has(framework))) ||
    (raw.componentName !== undefined && !componentName) ||
    !raw.attributes ||
    typeof raw.attributes !== "object" ||
    Array.isArray(raw.attributes)
  ) {
    return null;
  }
  const attributes: Record<string, string> = {};
  const rawAttributes = raw.attributes as Record<string, unknown>;
  if (Object.keys(rawAttributes).length > ATTRIBUTE_KEYS.size) return null;
  for (const [key, value] of Object.entries(rawAttributes)) {
    const normalized = boundedString(value, 500, true);
    if (!ATTRIBUTE_KEYS.has(key) || normalized === null) return null;
    attributes[key] = normalized;
  }
  return {
    selector,
    tagName: tagName.toLowerCase(),
    text,
    attributes,
    ...(sourcePathHint ? { sourcePathHint } : {}),
    ...(framework ? { framework: framework as LiveDesignStructureTarget["framework"] } : {}),
    ...(componentName ? { componentName } : {}),
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function contains(root: string, target: string): boolean {
  const base = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(base);
}

function safeRelativePath(value: string): boolean {
  return (
    !!value &&
    value.length <= 4_096 &&
    !path.isAbsolute(value) &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !value.split(/[\\/]/).includes("..") &&
    !value.split(/[\\/]/).includes(".git")
  );
}

async function resolveWorkspaceFile(workspace: string, relativePath: string) {
  if (!safeRelativePath(relativePath)) {
    throw new LiveDesignBridgeError("source path must stay inside the session workspace", 403);
  }
  const root = await fs.realpath(workspace);
  const lexical = path.resolve(root, relativePath);
  if (!contains(root, lexical)) {
    throw new LiveDesignBridgeError("source path escapes the session workspace", 403);
  }
  let linkStat;
  try {
    linkStat = await fs.lstat(lexical);
  } catch (error: any) {
    if (error?.code === "ENOENT")
      throw new LiveDesignBridgeError("source file no longer exists", 409);
    throw error;
  }
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new LiveDesignBridgeError("source target must be a regular non-symlink file", 403);
  }
  const real = await fs.realpath(lexical);
  if (!contains(root, real)) {
    throw new LiveDesignBridgeError("source path resolves outside the session workspace", 403);
  }
  if (linkStat.size > MAX_FILE_BYTES) {
    throw new LiveDesignBridgeError("source file is too large for direct visual editing", 409);
  }
  return {
    root,
    file: real,
    relative: path.relative(root, real).split(path.sep).join("/"),
    stat: linkStat,
  };
}

function sourceHintPath(workspace: string, hint: string | undefined): string | null {
  if (!hint) return null;
  let candidate = hint.trim();
  try {
    const url = new URL(candidate);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
    ) {
      candidate = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    } else if (url.protocol === "file:") {
      candidate = decodeURIComponent(url.pathname);
    }
  } catch {
    candidate = candidate.replace(/^file:\/\//, "");
  }
  candidate = candidate.replace(/[?#].*$/, "").replace(/:\d+(?::\d+)?$/, "");
  const root = path.resolve(workspace);
  if (path.isAbsolute(candidate)) {
    const resolved = path.resolve(candidate);
    if (!contains(root, resolved)) return null;
    candidate = path.relative(root, resolved);
  }
  const normalized = candidate.split(path.sep).join("/");
  return safeRelativePath(normalized) ? normalized : null;
}

async function collectSourceFiles(workspace: string, preferredPaths: string[]) {
  const root = await fs.realpath(workspace);
  const files: string[] = [];
  const stack = [root];
  let truncated = false;
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(target);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(extension) || STYLE_EXTENSIONS.has(extension)) files.push(target);
    }
    if (truncated) break;
  }
  const preferred = new Set(
    preferredPaths
      .filter(safeRelativePath)
      .map((item) => path.resolve(root, item))
      .filter((item) => contains(root, item)),
  );
  files.sort((a, b) => Number(preferred.has(b)) - Number(preferred.has(a)) || a.localeCompare(b));
  return { root, files, truncated };
}

interface MarkupBlock {
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  opening: string;
  selfClosing: boolean;
}

interface SourceStructureBlock extends MarkupBlock {
  path: string;
  file: string;
  content: string;
  fileHash: string;
  mode: number;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function supportsBoundStyles(extension: string): boolean {
  return STYLE_EXTENSIONS.has(extension) || EMBEDDED_STYLE_EXTENSIONS.has(extension);
}

function appendBoundStyle(content: string, extension: string, block: string): string {
  if (!EMBEDDED_STYLE_EXTENSIONS.has(extension)) {
    return `${content.trimEnd()}\n\n${block}\n`;
  }
  const closing = content.toLowerCase().lastIndexOf("</style>");
  if (closing < 0) {
    throw new LiveDesignBridgeError(
      "the component needs a source-owned <style> block before adding visual overrides",
      409,
    );
  }
  const before = content.slice(0, closing).trimEnd();
  return `${before}\n\n${block}\n${content.slice(closing)}`;
}

function markupTagEnd(content: string, start: number): number {
  let quote = "";
  let braces = 0;
  for (let index = start + 1; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === quote && content[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") braces += 1;
    else if (character === "}" && braces > 0) braces -= 1;
    else if (character === ">" && braces === 0) return index + 1;
  }
  return -1;
}

function markupBlocks(content: string, tagName: string): MarkupBlock[] {
  const starts = new RegExp(`<\\/?${regexEscape(tagName)}\\b`, "gi");
  const stack: Array<{ start: number; openEnd: number; opening: string }> = [];
  const blocks: MarkupBlock[] = [];
  for (const match of content.matchAll(starts)) {
    if (match.index === undefined) continue;
    const commentStart = content.lastIndexOf("<!--", match.index);
    const commentEnd = content.lastIndexOf("-->", match.index);
    if (commentStart > commentEnd) continue;
    const end = markupTagEnd(content, match.index);
    if (end < 0) continue;
    const raw = content.slice(match.index, end);
    const closing = /^<\s*\//.test(raw);
    const selfClosing = /\/\s*>$/.test(raw) || VOID_ELEMENTS.has(tagName);
    if (closing) {
      const opening = stack.pop();
      if (!opening) continue;
      blocks.push({
        start: opening.start,
        openEnd: opening.openEnd,
        closeStart: match.index,
        end,
        opening: opening.opening,
        selfClosing: false,
      });
    } else if (selfClosing) {
      blocks.push({
        start: match.index,
        openEnd: end,
        closeStart: end,
        end,
        opening: raw,
        selfClosing: true,
      });
    } else {
      stack.push({ start: match.index, openEnd: end, opening: raw });
    }
  }
  return blocks;
}

function normalizedMarkupText(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\{[^{}]{0,500}\}/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function literalAttribute(opening: string, name: string): string | null {
  const match = opening.match(
    new RegExp(`(?:^|\\s)${regexEscape(name)}\\s*=\\s*(["'])([^"']*)\\1`, "i"),
  );
  return match?.[2] ?? null;
}

function blockMatchesTarget(
  content: string,
  block: MarkupBlock,
  target: LiveDesignStructureTarget,
): boolean {
  const id = target.attributes.id;
  if (id) return literalAttribute(block.opening, "id") === id;
  const testId = target.attributes["data-testid"];
  if (testId) return literalAttribute(block.opening, "data-testid") === testId;
  const classes = (target.attributes.class ?? "").split(/\s+/).filter(Boolean);
  if (classes.length) {
    const sourceClasses =
      literalAttribute(block.opening, target.framework === "react" ? "className" : "class") ??
      literalAttribute(block.opening, "class") ??
      literalAttribute(block.opening, "className");
    if (sourceClasses) {
      const available = new Set(sourceClasses.split(/\s+/).filter(Boolean));
      if (classes.every((className) => available.has(className))) return true;
    }
  }
  if (target.text && !block.selfClosing) {
    const sourceText = normalizedMarkupText(content.slice(block.openEnd, block.closeStart));
    const targetText = target.text.replace(/\s+/g, " ").trim();
    if (sourceText === targetText || sourceText.includes(targetText)) return true;
  }
  return false;
}

async function findStructureBlock(
  workspace: string,
  target: LiveDesignStructureTarget,
): Promise<SourceStructureBlock> {
  if (target.tagName === "body" || target.tagName === "html") {
    throw new LiveDesignBridgeError(
      "select a source-owned element inside the page before changing structure",
      409,
    );
  }
  const hint = sourceHintPath(workspace, target.sourcePathHint);
  const { root, files } = await collectSourceFiles(workspace, hint ? [hint] : []);
  const matches: SourceStructureBlock[] = [];
  let scannedBytes = 0;
  for (const file of files) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (hint && relative !== hint && matches.length) break;
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) continue;
    scannedBytes += stat.size;
    if (scannedBytes > MAX_TOTAL_BYTES) break;
    const bytes = await fs.readFile(file);
    if (bytes.includes(0)) continue;
    const content = bytes.toString("utf8");
    for (const block of markupBlocks(content, target.tagName)) {
      if (!blockMatchesTarget(content, block, target)) continue;
      matches.push({
        ...block,
        path: relative,
        file,
        content,
        fileHash: sha256(bytes),
        mode: stat.mode & 0o777,
      });
      if (matches.length > 10) break;
    }
    if (matches.length > 10) break;
  }
  if (!matches.length) {
    throw new LiveDesignBridgeError(
      "the selected DOM node could not be bound to one source element",
      409,
    );
  }
  if (matches.length > 1) {
    throw new LiveDesignBridgeError(
      "the selected DOM node matches multiple source elements; add an id or data-testid first",
      409,
    );
  }
  return matches[0];
}

function lineFacts(content: string, offset: number) {
  const before = content.slice(0, offset);
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEnd = content.indexOf("\n", offset);
  const excerpt = content
    .slice(lineStart, lineEnd === -1 ? content.length : lineEnd)
    .trim()
    .slice(0, 240);
  return { line, column: offset - lineStart + 1, excerpt };
}

function isTextNodeAt(content: string, offset: number, expected: string): boolean {
  if (!expected || content.slice(offset, offset + expected.length) !== expected) return false;
  let before = offset - 1;
  while (before >= 0 && /\s/.test(content[before])) before -= 1;
  let after = offset + expected.length;
  while (after < content.length && /\s/.test(content[after])) after += 1;
  return content[before] === ">" && content[after] === "<";
}

function candidateId(input: {
  path: string;
  offset: number;
  kind: LiveDesignSourceCandidateKind;
  expected: string;
  fileHash: string;
  tokenName?: string;
  property?: string;
}): string {
  return sha256(
    [
      input.path,
      input.offset,
      input.kind,
      input.expected,
      input.fileHash,
      input.tokenName ?? "",
      input.property ?? "",
    ].join("\0"),
  );
}

function makeCandidate(
  relativePath: string,
  content: string,
  fileHash: string,
  offset: number,
  kind: LiveDesignSourceCandidateKind,
  expected: string,
  options: {
    tokenName?: string;
    property?: string;
    confidence?: LiveDesignSourceCandidate["confidence"];
    reason?: string;
  } = {},
): LiveDesignSourceCandidate {
  const facts = lineFacts(content, offset);
  const identity = {
    path: relativePath,
    offset,
    kind,
    expected,
    fileHash,
    ...(options.tokenName ? { tokenName: options.tokenName } : {}),
    ...(options.property ? { property: options.property } : {}),
  };
  return {
    id: candidateId(identity),
    ...identity,
    ...facts,
    ...(options.confidence ? { confidence: options.confidence } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
  };
}

function selectorMatchesElement(selectorList: string, element: LiveDesignElement): boolean {
  const id = element.attributes.id;
  const classes = (element.attributes.class ?? "").split(/\s+/).filter(Boolean);
  const containsSelectorAtom = (selector: string, prefix: "#" | ".", value: string) => {
    const offset = selector.indexOf(`${prefix}${value}`);
    if (offset < 0) return false;
    const next = selector[offset + value.length + 1];
    return !next || !/[A-Za-z0-9_-]/.test(next);
  };
  return selectorList.split(",").some((rawSelector) => {
    const selector = rawSelector.trim();
    if (!selector || selector.startsWith("@")) return false;
    if (selector === element.selector || selector === element.tagName) return true;
    if (id && /^[A-Za-z0-9_-]+$/.test(id) && containsSelectorAtom(selector, "#", id)) {
      return true;
    }
    return classes.some(
      (className) =>
        /^[A-Za-z0-9_-]+$/.test(className) && containsSelectorAtom(selector, ".", className),
    );
  });
}

function selectorExactlyBindsElement(selector: string, element: LiveDesignElement): boolean {
  const normalized = selector.trim();
  if (normalized === element.selector || normalized === element.tagName) return true;
  const id = element.attributes.id;
  if (id && /^[A-Za-z0-9_-]+$/.test(id) && normalized === `#${id}`) return true;
  if (!/^(?:\.[A-Za-z0-9_-]+)+$/.test(normalized)) return false;
  const classes = new Set((element.attributes.class ?? "").split(/\s+/).filter(Boolean));
  const required = normalized
    .split(".")
    .filter(Boolean)
    .filter((className) => /^[A-Za-z0-9_-]+$/.test(className));
  return required.length > 0 && required.every((className) => classes.has(className));
}

function collectCssDeclarationCandidates(
  relativePath: string,
  content: string,
  fileHash: string,
  element: LiveDesignElement,
  hinted: boolean,
  candidates: LiveDesignSourceCandidate[],
) {
  const blockPattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const block of content.matchAll(blockPattern)) {
    if (
      candidates.length >= MAX_CANDIDATES ||
      block.index === undefined ||
      !selectorMatchesElement(block[1], element)
    ) {
      continue;
    }
    const body = block[2];
    const bodyOffset = block.index + block[0].indexOf(body);
    const declarationPattern = /([a-zA-Z-]+)\s*:\s*([^;{}]+);/g;
    for (const declaration of body.matchAll(declarationPattern)) {
      if (candidates.length >= MAX_CANDIDATES || declaration.index === undefined) break;
      const property = declaration[1].toLowerCase();
      const expected = declaration[2].trim();
      if (
        !EDITABLE_CSS_PROPERTIES.has(property) ||
        !expected ||
        expected.length > 500 ||
        expected.includes("var(")
      ) {
        continue;
      }
      const offset = bodyOffset + declaration.index + declaration[0].indexOf(expected);
      const exactSelector = block[1]
        .split(",")
        .some((selector) => selectorExactlyBindsElement(selector, element));
      candidates.push(
        makeCandidate(relativePath, content, fileHash, offset, "css-declaration", expected, {
          property,
          confidence: exactSelector ? "exact" : hinted ? "hint" : "ambiguous",
          reason: exactSelector
            ? `The stylesheet rule exactly matches ${element.selector}.`
            : hinted
              ? "The framework source hint prioritised this stylesheet."
              : "Matched an id, class, or tag used by the selected element.",
        }),
      );
    }
  }
}

function tokenNodesFromStyles(
  styleFiles: Array<{ path: string; content: string }>,
  requestedTokens: Set<string>,
): LiveDesignTokenNode[] {
  const nodes = new Map<string, LiveDesignTokenNode>();
  for (const file of styleFiles) {
    const pattern = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]{1,500});/g;
    for (const match of file.content.matchAll(pattern)) {
      if (match.index === undefined || nodes.has(match[1])) continue;
      const aliases = [...match[2].matchAll(/var\((--[A-Za-z0-9_-]+)/g)].map((alias) => alias[1]);
      nodes.set(match[1], {
        name: match[1],
        value: match[2].trim(),
        path: file.path,
        line: lineFacts(file.content, match.index).line,
        aliases,
        referencedBy: [],
      });
    }
  }
  for (const node of nodes.values()) {
    for (const alias of node.aliases) nodes.get(alias)?.referencedBy.push(node.name);
  }
  const included = new Set(requestedTokens);
  const queue = [...included];
  while (queue.length) {
    const node = nodes.get(queue.shift()!);
    for (const alias of node?.aliases ?? []) {
      if (included.has(alias)) continue;
      included.add(alias);
      queue.push(alias);
    }
  }
  return [...nodes.values()]
    .sort((left, right) => {
      const leftSelected = included.has(left.name) ? 0 : 1;
      const rightSelected = included.has(right.name) ? 0 : 1;
      return leftSelected - rightSelected || left.name.localeCompare(right.name);
    })
    .slice(0, 100);
}

async function cmsReferencesFor(
  workspace: string,
  text: string,
  preferredCmsPaths: string[],
): Promise<LiveDesignCmsReference[]> {
  if (!text) return [];
  const references: LiveDesignCmsReference[] = [];
  for (const cmsPath of preferredCmsPaths.filter(safeRelativePath).slice(0, 50)) {
    if (path.extname(cmsPath).toLowerCase() !== ".json") continue;
    let resolved: Awaited<ReturnType<typeof resolveWorkspaceFile>>;
    try {
      resolved = await resolveWorkspaceFile(workspace, cmsPath);
    } catch {
      continue;
    }
    const content = await fs.readFile(resolved.file, "utf8");
    let document: unknown;
    try {
      document = JSON.parse(content);
    } catch {
      continue;
    }
    let searchOffset = 0;
    function walk(value: unknown, field: string) {
      if (references.length >= 50) return;
      if (typeof value === "string" && value === text) {
        const encoded = JSON.stringify(value);
        const offset = content.indexOf(encoded, searchOffset);
        if (offset >= 0) searchOffset = offset + encoded.length;
        references.push({
          path: resolved.relative,
          field: field || "$",
          line: offset >= 0 ? lineFacts(content, offset).line : 1,
          value,
        });
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${field}[${index}]`));
      } else if (value && typeof value === "object") {
        for (const [key, entry] of Object.entries(value))
          walk(entry, field ? `${field}.${key}` : key);
      }
    }
    walk(document, "");
  }
  return references;
}

function rgb(value: string): [number, number, number, number] | null {
  const match = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 1)];
}

function contrastRatio(foreground: [number, number, number], background: [number, number, number]) {
  const luminance = (color: [number, number, number]) => {
    const channels = color.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function auditElement(element: LiveDesignElement): LiveDesignAuditFinding[] {
  const findings: LiveDesignAuditFinding[] = [];
  const foreground = rgb(element.styles.color);
  const background = rgb(element.styles.backgroundColor);
  if (foreground && background && background[3] > 0) {
    const ratio = contrastRatio(
      foreground.slice(0, 3) as [number, number, number],
      background.slice(0, 3) as [number, number, number],
    );
    if (ratio < 4.5) {
      findings.push({
        id: "contrast",
        severity: ratio < 3 ? "error" : "warning",
        category: "accessibility",
        message: `Text contrast is ${ratio.toFixed(2)}:1; normal text should reach 4.5:1.`,
        suggestion: "Use semantic foreground/background tokens with stronger contrast.",
      });
    }
  }
  const interactive =
    ["button", "a", "input", "select", "textarea"].includes(element.tagName) ||
    element.attributes.role === "button";
  if (interactive && (element.rect.width < 44 || element.rect.height < 44)) {
    findings.push({
      id: "touch-target",
      severity: "warning",
      category: "accessibility",
      message: `Interactive target is ${Math.round(element.rect.width)}×${Math.round(element.rect.height)}px.`,
      suggestion: "Increase its hit area to at least 44×44px.",
    });
  }
  if (element.rect.x + element.rect.width > element.rect.viewportWidth + 1) {
    findings.push({
      id: "viewport-overflow",
      severity: "error",
      category: "responsive",
      message: "The selected element extends beyond the current viewport.",
      suggestion: "Use responsive sizing or wrapping at this breakpoint.",
    });
  }
  if (!element.tokens.length && (foreground || background)) {
    findings.push({
      id: "raw-color",
      severity: "info",
      category: "design-system",
      message: "No semantic color token was detected for this element.",
      suggestion: "Bind visual colors to the repository's design-token source of truth.",
    });
  }
  if (
    interactive &&
    !element.text &&
    !element.attributes["aria-label"] &&
    !element.attributes.alt
  ) {
    findings.push({
      id: "accessible-name",
      severity: "error",
      category: "accessibility",
      message: "The interactive element has no detectable accessible name.",
      suggestion: "Add visible text or an aria-label tied to the element's purpose.",
    });
  }
  if (element.tagName === "img" && !element.attributes.alt) {
    findings.push({
      id: "image-alt",
      severity: "error",
      category: "accessibility",
      message: "The selected image has no alternative text.",
      suggestion: 'Add meaningful alt text, or alt="" when the image is purely decorative.',
    });
  }
  const spacing = [
    ["padding", element.styles.padding],
    ["gap", element.styles.gap],
  ] as const;
  for (const [property, value] of spacing) {
    const numeric = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
    if (numeric && Math.abs(Number(numeric[1])) % 4 !== 0) {
      findings.push({
        id: `${property}-rhythm`,
        severity: "info",
        category: "design-system",
        message: `${property} uses ${value}, outside the common 4px spacing rhythm.`,
        suggestion: "Round the value to a nearby design-system spacing step when appropriate.",
      });
    }
  }
  const fontSize = Number.parseFloat(element.styles.fontSize);
  if (Number.isFinite(fontSize) && fontSize < 12 && element.text) {
    findings.push({
      id: "small-text",
      severity: "warning",
      category: "accessibility",
      message: `Text is ${fontSize}px and may be difficult to read.`,
      suggestion: "Use at least 12px for supporting text and 16px for primary body copy.",
    });
  }
  if (
    element.styleSources?.some((source) =>
      source.declarations.some((declaration) => declaration.important),
    )
  ) {
    findings.push({
      id: "important-cascade",
      severity: "warning",
      category: "design-system",
      message: "The selected element is affected by an !important declaration.",
      suggestion:
        "Resolve the cascade at the owning class or token instead of adding another override.",
    });
  }
  return findings;
}

export async function resolveLiveDesignSources(
  workspace: string,
  element: LiveDesignElement,
  preferredTokenPaths: string[] = [],
  preferredCmsPaths: string[] = [],
): Promise<{
  candidates: LiveDesignSourceCandidate[];
  scannedFiles: number;
  truncated: boolean;
  tokenGraph: LiveDesignTokenNode[];
  cmsReferences: LiveDesignCmsReference[];
  auditFindings: LiveDesignAuditFinding[];
}> {
  const hint = sourceHintPath(workspace, element.sourcePathHint);
  const preferred = [...(hint ? [hint] : []), ...preferredTokenPaths];
  const {
    root,
    files,
    truncated: fileLimitReached,
  } = await collectSourceFiles(workspace, preferred);
  const tokenNames = new Set(element.tokens.map((token) => token.name));
  const candidates: LiveDesignSourceCandidate[] = [];
  let scannedFiles = 0;
  let totalBytes = 0;
  let truncated = fileLimitReached;
  const styleFiles: Array<{ path: string; content: string }> = [];

  for (const file of files) {
    if (candidates.length >= MAX_CANDIDATES || totalBytes >= MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) continue;
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    const bytes = await fs.readFile(file);
    if (bytes.includes(0)) continue;
    const content = bytes.toString("utf8");
    const fileHash = sha256(bytes);
    const relativePath = path.relative(root, file).split(path.sep).join("/");
    const extension = path.extname(file).toLowerCase();
    const hinted = relativePath === hint;
    scannedFiles += 1;

    if (element.text && SOURCE_EXTENSIONS.has(extension)) {
      let offset = content.indexOf(element.text);
      while (offset !== -1 && candidates.length < MAX_CANDIDATES) {
        if (isTextNodeAt(content, offset, element.text)) {
          candidates.push(
            makeCandidate(relativePath, content, fileHash, offset, "text-node", element.text, {
              confidence: hinted ? "exact" : "ambiguous",
              reason: hinted
                ? "The framework supplied this source file for the selected component."
                : "Exact JSX/HTML text-node match.",
            }),
          );
        }
        offset = content.indexOf(element.text, offset + Math.max(1, element.text.length));
      }
    }

    if (tokenNames.size && supportsBoundStyles(extension)) {
      styleFiles.push({ path: relativePath, content });
      const tokenPattern = /(--[A-Za-z0-9_-]+)\s*:\s*(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)\s*;/g;
      for (const match of content.matchAll(tokenPattern)) {
        if (candidates.length >= MAX_CANDIDATES) break;
        const name = match[1];
        const expected = match[2];
        if (!tokenNames.has(name) || match.index === undefined) continue;
        const offset = match.index + match[0].indexOf(expected);
        candidates.push(
          makeCandidate(relativePath, content, fileHash, offset, "css-token", expected, {
            tokenName: name,
            confidence: "exact",
            reason: `The selected element consumes ${name}.`,
          }),
        );
      }
    }
    if (supportsBoundStyles(extension)) {
      if (!tokenNames.size) styleFiles.push({ path: relativePath, content });
      collectCssDeclarationCandidates(relativePath, content, fileHash, element, hinted, candidates);
    }
  }
  const duplicateTextCandidates = candidates.filter((candidate) => candidate.kind === "text-node");
  if (duplicateTextCandidates.length === 1) duplicateTextCandidates[0].confidence = "exact";
  return {
    candidates,
    scannedFiles,
    truncated,
    tokenGraph: tokenNodesFromStyles(styleFiles, tokenNames),
    cmsReferences: await cmsReferencesFor(workspace, element.text, preferredCmsPaths),
    auditFindings: auditElement(element),
  };
}

function normalizeCandidate(input: unknown): LiveDesignSourceCandidate | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (
    !exactKeys(raw, [
      "id",
      "path",
      "line",
      "column",
      "offset",
      "kind",
      "expected",
      "fileHash",
      "excerpt",
      "tokenName",
      "property",
      "confidence",
      "reason",
    ])
  ) {
    return null;
  }
  const id = boundedString(raw.id, 64);
  const sourcePath = boundedString(raw.path, 4_096);
  const expected = boundedString(raw.expected, 2_000, true);
  const fileHash = boundedString(raw.fileHash, 64);
  const excerpt = boundedString(raw.excerpt, 240, true);
  const tokenName = raw.tokenName === undefined ? undefined : boundedString(raw.tokenName, 102);
  const property = raw.property === undefined ? undefined : boundedString(raw.property, 80);
  const confidence = raw.confidence === undefined ? undefined : boundedString(raw.confidence, 20);
  const reason = raw.reason === undefined ? undefined : boundedString(raw.reason, 500);
  if (
    !id ||
    !HASH_RE.test(id) ||
    !sourcePath ||
    !safeRelativePath(sourcePath) ||
    expected === null ||
    !fileHash ||
    !HASH_RE.test(fileHash) ||
    excerpt === null ||
    !Number.isInteger(raw.line) ||
    Number(raw.line) < 1 ||
    !Number.isInteger(raw.column) ||
    Number(raw.column) < 1 ||
    !Number.isInteger(raw.offset) ||
    Number(raw.offset) < 0 ||
    (raw.kind !== "text-node" && raw.kind !== "css-token" && raw.kind !== "css-declaration") ||
    (raw.kind === "css-token" && (!tokenName || !SAFE_TOKEN_RE.test(tokenName))) ||
    (raw.kind !== "css-token" && raw.tokenName !== undefined) ||
    (raw.kind === "css-declaration" && (!property || !EDITABLE_CSS_PROPERTIES.has(property))) ||
    (raw.kind !== "css-declaration" && raw.property !== undefined) ||
    (raw.confidence !== undefined &&
      (!confidence || !["exact", "hint", "ambiguous"].includes(confidence))) ||
    (raw.reason !== undefined && !reason)
  ) {
    return null;
  }
  return {
    id,
    path: sourcePath,
    line: Number(raw.line),
    column: Number(raw.column),
    offset: Number(raw.offset),
    kind: raw.kind,
    expected,
    fileHash,
    excerpt,
    ...(tokenName ? { tokenName } : {}),
    ...(property ? { property } : {}),
    ...(confidence ? { confidence: confidence as LiveDesignSourceCandidate["confidence"] } : {}),
    ...(reason ? { reason } : {}),
  };
}

interface StoredRevision extends LiveDesignRevision {
  version: 1 | 2;
  sessionId: string;
  offset: number;
  beforeHash: string;
  afterHash: string;
  status: "prepared" | "applied" | "rolled-back";
  snapshotBefore?: string;
}

function publicRevision(revision: StoredRevision): LiveDesignRevision {
  return {
    id: revision.id,
    path: revision.path,
    kind: revision.kind,
    before: revision.before,
    after: revision.after,
    createdAt: revision.createdAt,
    ...(revision.rolledBackAt ? { rolledBackAt: revision.rolledBackAt } : {}),
    ...(revision.changeCount !== undefined ? { changeCount: revision.changeCount } : {}),
    ...(revision.changeSetId ? { changeSetId: revision.changeSetId } : {}),
  };
}

async function atomicText(file: string, content: string, mode: number): Promise<void> {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.glimmer-${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode });
    const handle = await fs.open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    try {
      const directory = await fs.open(path.dirname(file), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Some filesystems do not permit fsync on directories. The file itself
      // was still synced before the atomic rename.
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function revisionPath(sessionId: string, revisionId: string): string {
  if (!SAFE_SESSION_ID_RE.test(sessionId) || !SAFE_REVISION_ID_RE.test(revisionId)) {
    throw new LiveDesignBridgeError("revision id is invalid", 400);
  }
  return path.join(sessionsDir(), sessionId, "design-bridge", "revisions", `${revisionId}.json`);
}

async function writeRevision(file: string, revision: StoredRevision): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicText(file, `${JSON.stringify(revision, null, 2)}\n`, 0o600);
}

function replacementError(
  candidate: LiveDesignSourceCandidate,
  replacement: string,
): string | null {
  if (replacement.length > 2_000 || replacement.includes("\0")) return "replacement is too large";
  if (candidate.kind === "text-node") {
    if (/[\n\r<>{}]/.test(replacement)) {
      return "direct text edits must be a single JSX/HTML text node without markup";
    }
    return null;
  }
  if (candidate.kind === "css-token") {
    return HEX_COLOR_RE.test(replacement)
      ? null
      : "direct token edits currently require a hex color";
  }
  const property = candidate.property!;
  if (/^var\(--[A-Za-z0-9_-]{1,100}\)$/.test(replacement)) return null;
  if (["color", "background-color", "border-color"].includes(property)) {
    return HEX_COLOR_RE.test(replacement) ? null : `${property} requires a hex color`;
  }
  if (["flex-direction"].includes(property)) {
    return ["row", "row-reverse", "column", "column-reverse"].includes(replacement)
      ? null
      : `${property} has an unsupported value`;
  }
  if (["align-items", "justify-content"].includes(property)) {
    return [
      "start",
      "end",
      "flex-start",
      "flex-end",
      "center",
      "stretch",
      "space-between",
      "space-around",
      "space-evenly",
    ].includes(replacement)
      ? null
      : `${property} has an unsupported value`;
  }
  if (property === "font-family") {
    return replacement && replacement.length <= 200 && !/[{};\r\n]/.test(replacement)
      ? null
      : "font-family contains unsupported syntax";
  }
  if (property === "font-weight") {
    return /^(?:normal|bold|[1-9]00)$/.test(replacement)
      ? null
      : "font-weight must be normal, bold, or 100 through 900";
  }
  return CSS_VALUE_RE.test(replacement)
    ? null
    : `${property} requires one bounded numeric CSS value`;
}

function validateCandidateBinding(
  content: string,
  currentHash: string,
  candidate: LiveDesignSourceCandidate,
) {
  if (currentHash !== candidate.fileHash) {
    throw new LiveDesignBridgeError("source file changed; resolve the element again", 409);
  }
  if (
    content.slice(candidate.offset, candidate.offset + candidate.expected.length) !==
    candidate.expected
  ) {
    throw new LiveDesignBridgeError("source binding is stale; resolve the element again", 409);
  }
  if (
    candidate.kind === "text-node" &&
    !isTextNodeAt(content, candidate.offset, candidate.expected)
  ) {
    throw new LiveDesignBridgeError("source binding is no longer a safe text node", 409);
  }
  if (candidate.kind === "css-token") {
    const declarationStart = content.lastIndexOf(candidate.tokenName!, candidate.offset);
    const declaration =
      declarationStart >= Math.max(0, candidate.offset - 220)
        ? content.slice(
            declarationStart,
            Math.min(content.length, candidate.offset + candidate.expected.length + 32),
          )
        : "";
    const match = declaration.match(
      /^(--[A-Za-z0-9_-]+)\s*:\s*(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)\s*;/,
    );
    const matchedValueOffset = match ? declarationStart + declaration.indexOf(match[2]) : -1;
    if (
      !match ||
      match[1] !== candidate.tokenName ||
      match[2] !== candidate.expected ||
      matchedValueOffset !== candidate.offset ||
      !HEX_COLOR_RE.test(candidate.expected)
    ) {
      throw new LiveDesignBridgeError("source binding is no longer a safe CSS token", 409);
    }
  }
  if (candidate.kind === "css-declaration") {
    const declarationStart = content.lastIndexOf(candidate.property!, candidate.offset);
    const declaration =
      declarationStart >= Math.max(0, candidate.offset - 120)
        ? content.slice(
            declarationStart,
            Math.min(content.length, candidate.offset + candidate.expected.length + 32),
          )
        : "";
    const match = declaration.match(/^([a-zA-Z-]+)\s*:\s*([^;{}]+);/);
    const expectedOffset = match ? declarationStart + declaration.indexOf(match[2].trim()) : -1;
    if (
      !match ||
      match[1].toLowerCase() !== candidate.property ||
      match[2].trim() !== candidate.expected ||
      expectedOffset !== candidate.offset
    ) {
      throw new LiveDesignBridgeError("source binding is no longer a safe CSS declaration", 409);
    }
  }
  if (candidate.id !== candidateId(candidate)) {
    throw new LiveDesignBridgeError("source candidate identity is invalid", 409);
  }
}

async function applyLiveDesignSourceUnlocked(
  sessionId: string,
  workspace: string,
  input: unknown,
): Promise<LiveDesignApplyResponse> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LiveDesignBridgeError("live design apply request is invalid", 400);
  }
  const raw = input as Record<string, unknown>;
  if (!exactKeys(raw, ["candidate", "replacement", "changeSetId"])) {
    throw new LiveDesignBridgeError("live design apply request contains unsupported fields", 400);
  }
  const candidate = normalizeCandidate(raw.candidate);
  const replacement = boundedString(raw.replacement, 2_000, true);
  const changeSetId =
    raw.changeSetId === undefined ? undefined : boundedString(raw.changeSetId, 100);
  if (!candidate || replacement === null || (raw.changeSetId !== undefined && !changeSetId)) {
    throw new LiveDesignBridgeError("live design source candidate is invalid", 400);
  }
  const replacementProblem = replacementError(candidate, replacement);
  if (replacementProblem) throw new LiveDesignBridgeError(replacementProblem, 400);

  const resolved = await resolveWorkspaceFile(workspace, candidate.path);
  const bytes = await fs.readFile(resolved.file);
  if (bytes.includes(0)) throw new LiveDesignBridgeError("source file is not text", 409);
  const content = bytes.toString("utf8");
  const currentHash = sha256(bytes);
  validateCandidateBinding(content, currentHash, candidate);

  const updated =
    content.slice(0, candidate.offset) +
    replacement +
    content.slice(candidate.offset + candidate.expected.length);
  const revisionId = randomUUID();
  const createdAt = new Date().toISOString();
  const stored: StoredRevision = {
    version: 1,
    sessionId,
    id: revisionId,
    path: candidate.path,
    kind: candidate.kind,
    before: candidate.expected,
    after: replacement,
    createdAt,
    offset: candidate.offset,
    beforeHash: currentHash,
    afterHash: sha256(updated),
    status: "prepared",
    ...(changeSetId ? { changeSetId } : {}),
  };
  const storedPath = revisionPath(sessionId, revisionId);
  await writeRevision(storedPath, stored);
  await atomicText(resolved.file, updated, resolved.stat.mode & 0o777);
  stored.status = "applied";
  await writeRevision(storedPath, stored);
  return { applied: true, revision: publicRevision(stored) };
}

export function applyLiveDesignSource(
  sessionId: string,
  workspace: string,
  input: unknown,
): Promise<LiveDesignApplyResponse> {
  return withSessionMutation(sessionId, () =>
    applyLiveDesignSourceUnlocked(sessionId, workspace, input),
  );
}

async function applyLiveDesignTransactionUnlocked(
  sessionId: string,
  workspace: string,
  input: unknown,
): Promise<LiveDesignTransactionResponse> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LiveDesignBridgeError("live design transaction is invalid", 400);
  }
  const raw = input as Record<string, unknown>;
  if (
    !exactKeys(raw, ["edits", "changeSetId"]) ||
    !Array.isArray(raw.edits) ||
    !raw.edits.length ||
    raw.edits.length > 20
  ) {
    throw new LiveDesignBridgeError("transaction must contain 1 through 20 edits", 400);
  }
  const changeSetId =
    raw.changeSetId === undefined ? undefined : boundedString(raw.changeSetId, 100);
  if (raw.changeSetId !== undefined && !changeSetId) {
    throw new LiveDesignBridgeError("transaction change set is invalid", 400);
  }
  const edits = raw.edits.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new LiveDesignBridgeError("transaction edit is invalid", 400);
    }
    const candidateInput = entry as Record<string, unknown>;
    if (!exactKeys(candidateInput, ["candidate", "replacement"])) {
      throw new LiveDesignBridgeError("transaction edit contains unsupported fields", 400);
    }
    const candidate = normalizeCandidate(candidateInput.candidate);
    const replacement = boundedString(candidateInput.replacement, 2_000, true);
    if (!candidate || replacement === null) {
      throw new LiveDesignBridgeError("transaction source candidate is invalid", 400);
    }
    const problem = replacementError(candidate, replacement);
    if (problem) throw new LiveDesignBridgeError(problem, 400);
    return { candidate, replacement };
  });
  const sourcePath = edits[0].candidate.path;
  if (edits.some((edit) => edit.candidate.path !== sourcePath)) {
    throw new LiveDesignBridgeError("one transaction may only edit one source file", 400);
  }
  const resolved = await resolveWorkspaceFile(workspace, sourcePath);
  const bytes = await fs.readFile(resolved.file);
  if (bytes.includes(0)) throw new LiveDesignBridgeError("source file is not text", 409);
  const content = bytes.toString("utf8");
  const currentHash = sha256(bytes);
  for (const edit of edits) validateCandidateBinding(content, currentHash, edit.candidate);
  const ordered = [...edits].sort((left, right) => right.candidate.offset - left.candidate.offset);
  for (let index = 1; index < ordered.length; index += 1) {
    const higher = ordered[index - 1].candidate;
    const lower = ordered[index].candidate;
    if (lower.offset + lower.expected.length > higher.offset) {
      throw new LiveDesignBridgeError("transaction source bindings overlap", 409);
    }
  }
  let updated = content;
  for (const edit of ordered) {
    updated =
      updated.slice(0, edit.candidate.offset) +
      edit.replacement +
      updated.slice(edit.candidate.offset + edit.candidate.expected.length);
  }
  const revisionId = randomUUID();
  const stored: StoredRevision = {
    version: 2,
    sessionId,
    id: revisionId,
    path: sourcePath,
    kind: "transaction",
    before: `${edits.length} source value${edits.length === 1 ? "" : "s"}`,
    after: `${edits.length} updated value${edits.length === 1 ? "" : "s"}`,
    createdAt: new Date().toISOString(),
    changeCount: edits.length,
    offset: 0,
    beforeHash: currentHash,
    afterHash: sha256(updated),
    status: "prepared",
    snapshotBefore: content,
    ...(changeSetId ? { changeSetId } : {}),
  };
  const storedPath = revisionPath(sessionId, revisionId);
  await writeRevision(storedPath, stored);
  await atomicText(resolved.file, updated, resolved.stat.mode & 0o777);
  stored.status = "applied";
  await writeRevision(storedPath, stored);
  return { applied: true, revision: publicRevision(stored) };
}

export function applyLiveDesignTransaction(
  sessionId: string,
  workspace: string,
  input: unknown,
): Promise<LiveDesignTransactionResponse> {
  return withSessionMutation(sessionId, () =>
    applyLiveDesignTransactionUnlocked(sessionId, workspace, input),
  );
}

async function persistSnapshotRevision(input: {
  sessionId: string;
  path: string;
  file: string;
  mode: number;
  beforeContent: string;
  afterContent: string;
  kind: Extract<
    LiveDesignRevision["kind"],
    | "structure-insert"
    | "structure-reorder"
    | "structure-reparent"
    | "responsive-override"
    | "style-override"
  >;
  beforeLabel: string;
  afterLabel: string;
  changeCount?: number;
  changeSetId?: string;
}): Promise<LiveDesignRevision> {
  if (input.beforeContent === input.afterContent) {
    throw new LiveDesignBridgeError("the requested visual change is already applied", 409);
  }
  const revisionId = randomUUID();
  const stored: StoredRevision = {
    version: 2,
    sessionId: input.sessionId,
    id: revisionId,
    path: input.path,
    kind: input.kind,
    before: input.beforeLabel,
    after: input.afterLabel,
    createdAt: new Date().toISOString(),
    changeCount: input.changeCount ?? 1,
    offset: 0,
    beforeHash: sha256(input.beforeContent),
    afterHash: sha256(input.afterContent),
    status: "prepared",
    snapshotBefore: input.beforeContent,
    ...(input.changeSetId ? { changeSetId: input.changeSetId } : {}),
  };
  const storedPath = revisionPath(input.sessionId, revisionId);
  await writeRevision(storedPath, stored);
  await atomicText(input.file, input.afterContent, input.mode);
  stored.status = "applied";
  await writeRevision(storedPath, stored);
  return publicRevision(stored);
}

function sourceIndent(content: string, offset: number): string {
  const lineStart = content.lastIndexOf("\n", offset - 1) + 1;
  return content.slice(lineStart, offset).match(/^[\t ]*/)?.[0] ?? "";
}

function indentMarkup(markup: string, indent: string): string {
  return markup
    .split("\n")
    .map((line, index) => (index === 0 ? line.trimStart() : `${indent}${line.trimStart()}`))
    .join("\n");
}

function insertAtStructureTarget(
  content: string,
  target: MarkupBlock,
  placement: "inside-start" | "inside-end" | "before" | "after",
  markup: string,
): string {
  if ((placement === "inside-start" || placement === "inside-end") && target.selfClosing) {
    throw new LiveDesignBridgeError("the selected source element cannot contain children", 409);
  }
  const parentIndent = sourceIndent(content, target.start);
  const childIndent = `${parentIndent}  `;
  if (placement === "before") {
    return `${content.slice(0, target.start)}${indentMarkup(markup, parentIndent)}\n${parentIndent}${content.slice(target.start)}`;
  }
  if (placement === "after") {
    return `${content.slice(0, target.end)}\n${parentIndent}${indentMarkup(markup, parentIndent)}${content.slice(target.end)}`;
  }
  if (placement === "inside-start") {
    return `${content.slice(0, target.openEnd)}\n${childIndent}${indentMarkup(markup, childIndent)}${content.slice(target.openEnd)}`;
  }
  return `${content.slice(0, target.closeStart)}\n${childIndent}${indentMarkup(markup, childIndent)}\n${parentIndent}${content.slice(target.closeStart)}`;
}

function escapeMarkupText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function insertedMarkup(
  preset: unknown,
  textValue: unknown,
  framework: LiveDesignStructureTarget["framework"],
): { markup: string; label: string } {
  const text = boundedString(textValue, 500, true);
  if (text === null) throw new LiveDesignBridgeError("inserted text is invalid", 400);
  const escaped = escapeMarkupText(text);
  if (preset === "section") {
    const heading = escaped || "New section";
    return { markup: `<section>\n  <h2>${heading}</h2>\n</section>`, label: "section" };
  }
  if (preset === "heading") {
    return { markup: `<h2>${escaped || "New heading"}</h2>`, label: "heading" };
  }
  if (preset === "paragraph") {
    return { markup: `<p>${escaped || "New paragraph"}</p>`, label: "paragraph" };
  }
  if (preset === "button") {
    const attribute = framework === "react" ? ' type="button"' : ' type="button"';
    return { markup: `<button${attribute}>${escaped || "Button"}</button>`, label: "button" };
  }
  if (preset === "divider") return { markup: "<hr />", label: "divider" };
  throw new LiveDesignBridgeError("structure insert preset is invalid", 400);
}

async function applyLiveDesignStructureUnlocked(
  sessionId: string,
  workspace: string,
  input: unknown,
): Promise<LiveDesignStructureOperationResponse> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LiveDesignBridgeError("structure operation is invalid", 400);
  }
  const raw = input as Record<string, unknown>;
  const changeSetId =
    raw.changeSetId === undefined ? undefined : boundedString(raw.changeSetId, 100);
  if (raw.changeSetId !== undefined && !changeSetId) {
    throw new LiveDesignBridgeError("structure change set is invalid", 400);
  }
  if (raw.kind === "insert") {
    if (
      !exactKeys(raw, ["kind", "target", "placement", "preset", "text", "changeSetId"]) ||
      !["inside-start", "inside-end", "before", "after"].includes(String(raw.placement))
    ) {
      throw new LiveDesignBridgeError("structure insert request is invalid", 400);
    }
    const target = normalizeStructureTarget(raw.target);
    if (!target) throw new LiveDesignBridgeError("structure target is invalid", 400);
    const block = await findStructureBlock(workspace, target);
    const inserted = insertedMarkup(raw.preset, raw.text, target.framework);
    const updated = insertAtStructureTarget(
      block.content,
      block,
      raw.placement as "inside-start" | "inside-end" | "before" | "after",
      inserted.markup,
    );
    const revision = await persistSnapshotRevision({
      sessionId,
      path: block.path,
      file: block.file,
      mode: block.mode,
      beforeContent: block.content,
      afterContent: updated,
      kind: "structure-insert",
      beforeLabel: `No inserted ${inserted.label}`,
      afterLabel: `Inserted ${inserted.label}`,
      ...(changeSetId ? { changeSetId } : {}),
    });
    return { applied: true, revision };
  }

  if (raw.kind === "reorder") {
    if (
      !exactKeys(raw, ["kind", "moving", "anchor", "placement", "changeSetId"]) ||
      (raw.placement !== "before" && raw.placement !== "after")
    ) {
      throw new LiveDesignBridgeError("structure reorder request is invalid", 400);
    }
    const movingTarget = normalizeStructureTarget(raw.moving);
    const anchorTarget = normalizeStructureTarget(raw.anchor);
    if (!movingTarget || !anchorTarget) {
      throw new LiveDesignBridgeError("structure reorder targets are invalid", 400);
    }
    const moving = await findStructureBlock(workspace, movingTarget);
    const anchor = await findStructureBlock(workspace, anchorTarget);
    if (moving.path !== anchor.path || moving.fileHash !== anchor.fileHash) {
      throw new LiveDesignBridgeError(
        "sibling reordering requires two elements in one source file",
        409,
      );
    }
    const movingFirst = moving.start < anchor.start;
    if (
      (movingFirst && raw.placement === "before") ||
      (!movingFirst && raw.placement === "after")
    ) {
      throw new LiveDesignBridgeError("the selected element is already in that position", 409);
    }
    const first = movingFirst ? moving : anchor;
    const second = movingFirst ? anchor : moving;
    const between = moving.content.slice(first.end, second.start);
    if (between.trim()) {
      throw new LiveDesignBridgeError(
        "source elements are not adjacent siblings; reorder was refused",
        409,
      );
    }
    const firstRaw = moving.content.slice(first.start, first.end);
    const secondRaw = moving.content.slice(second.start, second.end);
    const updated =
      moving.content.slice(0, first.start) +
      secondRaw +
      between +
      firstRaw +
      moving.content.slice(second.end);
    const revision = await persistSnapshotRevision({
      sessionId,
      path: moving.path,
      file: moving.file,
      mode: moving.mode,
      beforeContent: moving.content,
      afterContent: updated,
      kind: "structure-reorder",
      beforeLabel: `${movingTarget.tagName} before reorder`,
      afterLabel: `${movingTarget.tagName} moved ${raw.placement}`,
      ...(changeSetId ? { changeSetId } : {}),
    });
    return { applied: true, revision };
  }

  if (raw.kind === "reparent") {
    if (
      !exactKeys(raw, ["kind", "moving", "target", "placement", "changeSetId"]) ||
      (raw.placement !== "inside-start" && raw.placement !== "inside-end")
    ) {
      throw new LiveDesignBridgeError("structure reparent request is invalid", 400);
    }
    const movingTarget = normalizeStructureTarget(raw.moving);
    const parentTarget = normalizeStructureTarget(raw.target);
    if (!movingTarget || !parentTarget) {
      throw new LiveDesignBridgeError("structure reparent targets are invalid", 400);
    }
    const moving = await findStructureBlock(workspace, movingTarget);
    const target = await findStructureBlock(workspace, parentTarget);
    if (moving.path !== target.path || moving.fileHash !== target.fileHash) {
      throw new LiveDesignBridgeError("reparenting requires two elements in one source file", 409);
    }
    if (
      target.selfClosing ||
      (target.start <= moving.start && target.end >= moving.end) ||
      (moving.start <= target.start && moving.end >= target.end)
    ) {
      throw new LiveDesignBridgeError("the selected destination cannot contain this element", 409);
    }
    const movingRaw = moving.content.slice(moving.start, moving.end);
    const withoutMoving = moving.content.slice(0, moving.start) + moving.content.slice(moving.end);
    const removed = moving.end - moving.start;
    const adjust = (offset: number) => (offset > moving.start ? offset - removed : offset);
    const adjustedTarget: MarkupBlock = {
      ...target,
      start: adjust(target.start),
      openEnd: adjust(target.openEnd),
      closeStart: adjust(target.closeStart),
      end: adjust(target.end),
    };
    const updated = insertAtStructureTarget(
      withoutMoving,
      adjustedTarget,
      raw.placement,
      movingRaw,
    );
    const revision = await persistSnapshotRevision({
      sessionId,
      path: moving.path,
      file: moving.file,
      mode: moving.mode,
      beforeContent: moving.content,
      afterContent: updated,
      kind: "structure-reparent",
      beforeLabel: `${movingTarget.tagName} in original parent`,
      afterLabel: `${movingTarget.tagName} moved into ${parentTarget.tagName}`,
      ...(changeSetId ? { changeSetId } : {}),
    });
    return { applied: true, revision };
  }
  throw new LiveDesignBridgeError("structure operation kind is invalid", 400);
}

export function applyLiveDesignStructure(
  sessionId: string,
  workspace: string,
  input: unknown,
): Promise<LiveDesignStructureOperationResponse> {
  return withSessionMutation(sessionId, () =>
    applyLiveDesignStructureUnlocked(sessionId, workspace, input),
  );
}

function responsiveSelector(element: LiveDesignElement): string | null {
  const id = element.attributes.id;
  if (id && /^[A-Za-z0-9_-]{1,100}$/.test(id)) return `#${id}`;
  const testId = element.attributes["data-testid"];
  if (testId && /^[A-Za-z0-9_-]{1,100}$/.test(testId)) return `[data-testid="${testId}"]`;
  const classes = (element.attributes.class ?? "")
    .split(/\s+/)
    .filter((className) => /^[A-Za-z0-9_-]{1,100}$/.test(className))
    .slice(0, 4);
  if (classes.length) return classes.map((className) => `.${className}`).join("");
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(element.selector)) return element.selector;
  return null;
}

async function applyLiveDesignResponsiveOverrideUnlocked(
  sessionId: string,
  workspace: string,
  input: unknown,
): Promise<LiveDesignResponsiveOverrideResponse> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LiveDesignBridgeError("responsive override request is invalid", 400);
  }
  const raw = input as Record<string, unknown>;
  if (!exactKeys(raw, ["element", "source", "breakpoint", "property", "value", "changeSetId"])) {
    throw new LiveDesignBridgeError("responsive override contains unsupported fields", 400);
  }
  const element = normalizeLiveDesignElement(raw.element);
  const source = normalizeCandidate(raw.source);
  const property = boundedString(raw.property, 80) as LiveDesignResponsiveProperty | null;
  const value = boundedString(raw.value, 200);
  const changeSetId =
    raw.changeSetId === undefined ? undefined : boundedString(raw.changeSetId, 100);
  if (
    !element ||
    !source ||
    !property ||
    !RESPONSIVE_PROPERTIES.has(property) ||
    !value ||
    !["mobile", "tablet", "desktop"].includes(String(raw.breakpoint)) ||
    (raw.changeSetId !== undefined && !changeSetId)
  ) {
    throw new LiveDesignBridgeError("responsive override values are invalid", 400);
  }
  const extension = path.extname(source.path).toLowerCase();
  if (!supportsBoundStyles(extension)) {
    throw new LiveDesignBridgeError("responsive overrides require a bound stylesheet", 409);
  }
  const problem = replacementError({ ...source, kind: "css-declaration", property }, value);
  if (problem) throw new LiveDesignBridgeError(problem, 400);
  const selector = responsiveSelector(element);
  if (!selector) {
    throw new LiveDesignBridgeError(
      "add a stable id, data-testid, or class before creating a responsive override",
      409,
    );
  }
  const resolved = await resolveWorkspaceFile(workspace, source.path);
  const bytes = await fs.readFile(resolved.file);
  const content = bytes.toString("utf8");
  if (sha256(bytes) !== source.fileHash) {
    throw new LiveDesignBridgeError("stylesheet changed; resolve the element again", 409);
  }
  const media = {
    mobile: "(max-width: 479px)",
    tablet: "(min-width: 480px) and (max-width: 991px)",
    desktop: "(min-width: 992px)",
  }[raw.breakpoint as "mobile" | "tablet" | "desktop"];
  const marker = sha256(`${selector}\0${raw.breakpoint}\0${property}`).slice(0, 16);
  const start = `/* glimmer-responsive:${marker}:start */`;
  const end = `/* glimmer-responsive:${marker}:end */`;
  const block = `${start}\n@media ${media} {\n  ${selector} {\n    ${property}: ${value};\n  }\n}\n${end}`;
  const existing = new RegExp(`${regexEscape(start)}[\\s\\S]*?${regexEscape(end)}`, "g");
  const updated = existing.test(content)
    ? content.replace(existing, block)
    : appendBoundStyle(content, extension, block);
  const revision = await persistSnapshotRevision({
    sessionId,
    path: resolved.relative,
    file: resolved.file,
    mode: resolved.stat.mode & 0o777,
    beforeContent: content,
    afterContent: updated,
    kind: "responsive-override",
    beforeLabel: `${property} before ${raw.breakpoint} override`,
    afterLabel: `${property}: ${value} at ${raw.breakpoint}`,
    ...(changeSetId ? { changeSetId } : {}),
  });
  return { applied: true, revision };
}

export function applyLiveDesignResponsiveOverride(
  sessionId: string,
  workspace: string,
  input: unknown,
): Promise<LiveDesignResponsiveOverrideResponse> {
  return withSessionMutation(sessionId, () =>
    applyLiveDesignResponsiveOverrideUnlocked(sessionId, workspace, input),
  );
}

function styleOverrideSelector(
  element: LiveDesignElement,
  scope: LiveDesignStyleScope,
  className?: string,
): string | null {
  if (scope === "instance") {
    const id = element.attributes.id;
    if (id && /^[A-Za-z0-9_-]{1,100}$/.test(id)) return `#${id}`;
    const testId = element.attributes["data-testid"];
    if (testId && /^[A-Za-z0-9_-]{1,100}$/.test(testId)) {
      return `[data-testid="${testId}"]`;
    }
    return null;
  }
  const classes = (element.attributes.class ?? "")
    .split(/\s+/)
    .filter((className) => /^[A-Za-z0-9_-]{1,100}$/.test(className))
    .slice(0, 4);
  if (className) return classes.includes(className) ? `.${className}` : null;
  return classes.length ? classes.map((className) => `.${className}`).join("") : null;
}

function validStyleOverrideValue(property: LiveDesignStyleProperty, value: string): boolean {
  if (
    !value ||
    value.length > 200 ||
    /[{};]/.test(value) ||
    Array.from(value).some((character) => character.charCodeAt(0) <= 31) ||
    value.includes("/*") ||
    value.includes("*/") ||
    /(?:url|expression)\s*\(/i.test(value) ||
    /(?:@import|!important)/i.test(value) ||
    !/^[A-Za-z0-9_#.,%()+\-*/\s]+$/.test(value)
  ) {
    return false;
  }
  if (property === "display") {
    return [
      "block",
      "inline",
      "inline-block",
      "flex",
      "inline-flex",
      "grid",
      "inline-grid",
      "none",
    ].includes(value);
  }
  if (property === "position") {
    return ["static", "relative", "absolute", "fixed", "sticky"].includes(value);
  }
  if (property === "flex-direction") {
    return ["row", "row-reverse", "column", "column-reverse"].includes(value);
  }
  if (property === "flex-wrap") {
    return ["nowrap", "wrap", "wrap-reverse"].includes(value);
  }
  if (["align-items", "align-content", "justify-content"].includes(property)) {
    return [
      "normal",
      "start",
      "end",
      "flex-start",
      "flex-end",
      "center",
      "stretch",
      "space-between",
      "space-around",
      "space-evenly",
      "baseline",
    ].includes(value);
  }
  if (property === "grid-auto-flow") {
    return ["row", "column", "dense", "row dense", "column dense"].includes(value);
  }
  if (property === "box-sizing") return value === "border-box" || value === "content-box";
  if (property === "z-index" || property === "order")
    return value === "auto" || /^-?\d{1,6}$/.test(value);
  return true;
}

async function applyLiveDesignStyleOverrideUnlocked(
  sessionId: string,
  workspace: string,
  input: unknown,
): Promise<LiveDesignStyleOverrideResponse> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LiveDesignBridgeError("style override request is invalid", 400);
  }
  const raw = input as Record<string, unknown>;
  if (!exactKeys(raw, ["element", "source", "scope", "className", "declarations", "changeSetId"])) {
    throw new LiveDesignBridgeError("style override contains unsupported fields", 400);
  }
  const element = normalizeLiveDesignElement(raw.element);
  const source = normalizeCandidate(raw.source);
  const scope = raw.scope as LiveDesignStyleScope;
  const className = raw.className === undefined ? undefined : boundedString(raw.className, 100);
  const changeSetId =
    raw.changeSetId === undefined ? undefined : boundedString(raw.changeSetId, 100);
  if (
    !element ||
    !source ||
    (scope !== "instance" && scope !== "component") ||
    (raw.className !== undefined &&
      (!className || scope !== "component" || !/^[A-Za-z0-9_-]{1,100}$/.test(className))) ||
    (raw.changeSetId !== undefined && !changeSetId) ||
    !raw.declarations ||
    typeof raw.declarations !== "object" ||
    Array.isArray(raw.declarations)
  ) {
    throw new LiveDesignBridgeError("style override values are invalid", 400);
  }
  const extension = path.extname(source.path).toLowerCase();
  if (!supportsBoundStyles(extension)) {
    throw new LiveDesignBridgeError("style overrides require a bound stylesheet", 409);
  }
  const entries = Object.entries(raw.declarations as Record<string, unknown>);
  if (!entries.length || entries.length > 30) {
    throw new LiveDesignBridgeError("style override must contain 1 through 30 declarations", 400);
  }
  const declarations: Array<[LiveDesignStyleProperty, string]> = [];
  for (const [rawProperty, rawValue] of entries) {
    const property = rawProperty as LiveDesignStyleProperty;
    const value = boundedString(rawValue, 200);
    if (
      !STYLE_OVERRIDE_PROPERTIES.has(property) ||
      !value ||
      !validStyleOverrideValue(property, value)
    ) {
      throw new LiveDesignBridgeError(`style override for ${rawProperty} is invalid`, 400);
    }
    declarations.push([property, value]);
  }
  declarations.sort(([left], [right]) => left.localeCompare(right));
  const selector = styleOverrideSelector(element, scope, className ?? undefined);
  if (!selector) {
    throw new LiveDesignBridgeError(
      scope === "instance"
        ? "add a stable id or data-testid before styling one component instance"
        : "add a stable class before styling all component instances",
      409,
    );
  }
  const resolved = await resolveWorkspaceFile(workspace, source.path);
  const bytes = await fs.readFile(resolved.file);
  if (bytes.includes(0)) throw new LiveDesignBridgeError("stylesheet is not text", 409);
  if (sha256(bytes) !== source.fileHash) {
    throw new LiveDesignBridgeError("stylesheet changed; resolve the element again", 409);
  }
  const content = bytes.toString("utf8");
  let updated = content;
  const additions: string[] = [];
  for (const [property, value] of declarations) {
    const marker = sha256(`${scope}\0${selector}\0${property}`).slice(0, 16);
    const start = `/* glimmer-style:${marker}:start */`;
    const end = `/* glimmer-style:${marker}:end */`;
    const block = `${start}\n${selector} {\n  ${property}: ${value};\n}\n${end}`;
    const existing = new RegExp(`${regexEscape(start)}[\\s\\S]*?${regexEscape(end)}`, "g");
    if (existing.test(updated)) updated = updated.replace(existing, block);
    else additions.push(block);
  }
  if (additions.length) {
    updated = appendBoundStyle(updated, extension, additions.join("\n\n"));
  }
  const revision = await persistSnapshotRevision({
    sessionId,
    path: resolved.relative,
    file: resolved.file,
    mode: resolved.stat.mode & 0o777,
    beforeContent: content,
    afterContent: updated,
    kind: "style-override",
    beforeLabel: `${scope} layout before override`,
    afterLabel: `${declarations.length} ${scope} layout declaration${declarations.length === 1 ? "" : "s"}`,
    changeCount: declarations.length,
    ...(changeSetId ? { changeSetId } : {}),
  });
  return { applied: true, revision, selector };
}

export function applyLiveDesignStyleOverride(
  sessionId: string,
  workspace: string,
  input: unknown,
): Promise<LiveDesignStyleOverrideResponse> {
  return withSessionMutation(sessionId, () =>
    applyLiveDesignStyleOverrideUnlocked(sessionId, workspace, input),
  );
}

function loopbackScriptUrl(value: unknown): string | null {
  const textValue = boundedString(value, 2_048);
  if (!textValue) return null;
  try {
    const url = new URL(textValue);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/api/design-bridge/client.js" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function trustedParentOrigin(value: unknown): string | null {
  const textValue = boundedString(value, 500);
  if (!textValue) return null;
  if (["tauri://localhost", "https://tauri.localhost"].includes(textValue)) return textValue;
  try {
    const url = new URL(textValue);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

async function installLiveDesignBridgeUnlocked(
  sessionId: string,
  workspace: string,
  input: unknown,
): Promise<LiveDesignBridgeInstallResponse> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LiveDesignBridgeError("bridge install request is invalid", 400);
  }
  const raw = input as Record<string, unknown>;
  if (!exactKeys(raw, ["scriptUrl", "parentOrigin"])) {
    throw new LiveDesignBridgeError("bridge install request contains unsupported fields", 400);
  }
  const scriptUrl = loopbackScriptUrl(raw.scriptUrl);
  const parentOrigin = trustedParentOrigin(raw.parentOrigin);
  if (!scriptUrl || !parentOrigin) {
    throw new LiveDesignBridgeError("bridge install URLs must use trusted loopback origins", 400);
  }
  const { root, files } = await collectSourceFiles(workspace, ["index.html"]);
  const htmlCandidates = files
    .filter((file) => path.extname(file).toLowerCase() === ".html")
    .sort((left, right) => {
      const leftRelative = path.relative(root, left);
      const rightRelative = path.relative(root, right);
      return (
        Number(path.basename(right) === "index.html") -
          Number(path.basename(left) === "index.html") ||
        leftRelative.split(path.sep).length - rightRelative.split(path.sep).length ||
        leftRelative.localeCompare(rightRelative)
      );
    });
  if (!htmlCandidates[0]) {
    throw new LiveDesignBridgeError("no HTML entrypoint was found for automatic bridge setup", 409);
  }
  const relativePath = path.relative(root, htmlCandidates[0]).split(path.sep).join("/");
  const resolved = await resolveWorkspaceFile(workspace, relativePath);
  const bytes = await fs.readFile(resolved.file);
  const content = bytes.toString("utf8");
  if (content.includes("/api/design-bridge/client.js")) {
    throw new LiveDesignBridgeError("the development bridge is already installed", 409);
  }
  const lower = content.toLowerCase();
  const headEnd = lower.indexOf("</head>");
  const bodyEnd = lower.indexOf("</body>");
  const offset = headEnd >= 0 ? headEnd : bodyEnd >= 0 ? bodyEnd : content.length;
  const indent = headEnd >= 0 ? "  " : "";
  const injection = `${indent}<!-- Glimmer dev-only bridge; remove or undo before merging. -->\n${indent}<script data-glimmer-dev-only="true">if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname)) { const bridge = document.createElement("script"); bridge.src = ${JSON.stringify(scriptUrl)}; bridge.dataset.glimmerParent = ${JSON.stringify(parentOrigin)}; document.head.appendChild(bridge); }</script>\n`;
  const updated = content.slice(0, offset) + injection + content.slice(offset);
  const revisionId = randomUUID();
  const stored: StoredRevision = {
    version: 1,
    sessionId,
    id: revisionId,
    path: relativePath,
    kind: "bridge-install",
    before: "",
    after: injection,
    createdAt: new Date().toISOString(),
    offset,
    beforeHash: sha256(bytes),
    afterHash: sha256(updated),
    status: "prepared",
  };
  const storedPath = revisionPath(sessionId, revisionId);
  await writeRevision(storedPath, stored);
  await atomicText(resolved.file, updated, resolved.stat.mode & 0o777);
  stored.status = "applied";
  await writeRevision(storedPath, stored);
  return { installed: true, path: relativePath, revision: publicRevision(stored) };
}

export function installLiveDesignBridge(
  sessionId: string,
  workspace: string,
  input: unknown,
): Promise<LiveDesignBridgeInstallResponse> {
  return withSessionMutation(sessionId, () =>
    installLiveDesignBridgeUnlocked(sessionId, workspace, input),
  );
}

export async function listLiveDesignRevisions(
  sessionId: string,
): Promise<LiveDesignHistoryResponse> {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) {
    throw new LiveDesignBridgeError("session not found", 404);
  }
  const directory = path.dirname(revisionPath(sessionId, "history"));
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return { revisions: [] };
    throw error;
  }
  const revisions: LiveDesignRevision[] = [];
  for (const entry of entries
    .filter((item) => item.isFile() && item.name.endsWith(".json"))
    .slice(0, 100)) {
    try {
      const file = path.join(directory, entry.name);
      if ((await fs.stat(file)).size > 2 * MAX_FILE_BYTES) continue;
      const stored: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (isStoredRevision(stored, sessionId)) revisions.push(publicRevision(stored));
    } catch {
      // One torn or manually edited revision must not hide the usable history.
    }
  }
  revisions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { revisions };
}

function isStoredRevision(value: unknown, sessionId: string): value is StoredRevision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    (raw.version === 1 || raw.version === 2) &&
    raw.sessionId === sessionId &&
    typeof raw.id === "string" &&
    SAFE_REVISION_ID_RE.test(raw.id) &&
    typeof raw.path === "string" &&
    safeRelativePath(raw.path) &&
    ((raw.version === 1 &&
      (raw.kind === "text-node" ||
        raw.kind === "css-token" ||
        raw.kind === "css-declaration" ||
        raw.kind === "bridge-install")) ||
      (raw.version === 2 &&
        (raw.kind === "transaction" ||
          raw.kind === "structure-insert" ||
          raw.kind === "structure-reorder" ||
          raw.kind === "structure-reparent" ||
          raw.kind === "responsive-override" ||
          raw.kind === "style-override"))) &&
    typeof raw.before === "string" &&
    typeof raw.after === "string" &&
    typeof raw.createdAt === "string" &&
    Number.isInteger(raw.offset) &&
    Number(raw.offset) >= 0 &&
    typeof raw.beforeHash === "string" &&
    HASH_RE.test(raw.beforeHash) &&
    typeof raw.afterHash === "string" &&
    HASH_RE.test(raw.afterHash) &&
    (raw.status === "prepared" || raw.status === "applied" || raw.status === "rolled-back") &&
    (raw.rolledBackAt === undefined || typeof raw.rolledBackAt === "string") &&
    (raw.changeCount === undefined ||
      (Number.isInteger(raw.changeCount) &&
        Number(raw.changeCount) >= 1 &&
        Number(raw.changeCount) <= 30)) &&
    (raw.changeSetId === undefined ||
      (typeof raw.changeSetId === "string" && SAFE_REVISION_ID_RE.test(raw.changeSetId))) &&
    (raw.version !== 2 ||
      ((raw.kind === "transaction" ||
        raw.kind === "structure-insert" ||
        raw.kind === "structure-reorder" ||
        raw.kind === "structure-reparent" ||
        raw.kind === "responsive-override" ||
        raw.kind === "style-override") &&
        typeof raw.snapshotBefore === "string" &&
        raw.snapshotBefore.length <= MAX_FILE_BYTES))
  );
}

async function rollbackLiveDesignRevisionUnlocked(
  sessionId: string,
  workspace: string,
  revisionId: string,
): Promise<LiveDesignRollbackResponse> {
  const storedPath = revisionPath(sessionId, revisionId);
  let revision: unknown;
  try {
    revision = JSON.parse(await fs.readFile(storedPath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new LiveDesignBridgeError("revision not found", 404);
    throw new LiveDesignBridgeError("revision record is unreadable", 409);
  }
  if (!isStoredRevision(revision, sessionId)) {
    throw new LiveDesignBridgeError("revision record is invalid", 409);
  }
  const resolved = await resolveWorkspaceFile(workspace, revision.path);
  const bytes = await fs.readFile(resolved.file);
  const currentHash = sha256(bytes);
  if (revision.status === "rolled-back" && currentHash === revision.beforeHash) {
    return { rolledBack: true, revision: publicRevision(revision) };
  }
  if (currentHash === revision.beforeHash && revision.status === "prepared") {
    revision.status = "rolled-back";
    revision.rolledBackAt = new Date().toISOString();
    await writeRevision(storedPath, revision);
    return { rolledBack: true, revision: publicRevision(revision) };
  }
  if (currentHash !== revision.afterHash) {
    throw new LiveDesignBridgeError(
      "source changed after this live edit; rollback was refused to preserve newer work",
      409,
    );
  }
  if (revision.version === 2) {
    const restored = revision.snapshotBefore!;
    if (sha256(restored) !== revision.beforeHash) {
      throw new LiveDesignBridgeError("transaction snapshot failed its integrity check", 409);
    }
    await atomicText(resolved.file, restored, resolved.stat.mode & 0o777);
    revision.status = "rolled-back";
    revision.rolledBackAt = new Date().toISOString();
    await writeRevision(storedPath, revision);
    return { rolledBack: true, revision: publicRevision(revision) };
  }
  const content = bytes.toString("utf8");
  if (content.slice(revision.offset, revision.offset + revision.after.length) !== revision.after) {
    throw new LiveDesignBridgeError("revision no longer matches the source file", 409);
  }
  const restored =
    content.slice(0, revision.offset) +
    revision.before +
    content.slice(revision.offset + revision.after.length);
  if (sha256(restored) !== revision.beforeHash) {
    throw new LiveDesignBridgeError("rollback would not restore the recorded source version", 409);
  }
  await atomicText(resolved.file, restored, resolved.stat.mode & 0o777);
  revision.status = "rolled-back";
  revision.rolledBackAt = new Date().toISOString();
  await writeRevision(storedPath, revision);
  return { rolledBack: true, revision: publicRevision(revision) };
}

export function rollbackLiveDesignRevision(
  sessionId: string,
  workspace: string,
  revisionId: string,
): Promise<LiveDesignRollbackResponse> {
  return withSessionMutation(sessionId, () =>
    rollbackLiveDesignRevisionUnlocked(sessionId, workspace, revisionId),
  );
}
