import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DesignAssetRequest,
  DesignElementEdit,
  DesignElementStyleEdit,
  DesignFeedbackAnnotation,
  DesignFeedbackDocument,
  DesignFeedbackPoint,
  DesignFeedbackTool,
  DesignFeedbackUpdate,
  DesignProfileReference,
  DesignChangeSetCreateRequest,
  DesignChangeSetFeedbackRefs,
  DesignWorkflowTransitionAction,
  DesignWorkflowDocument,
  DesignVariantRequest,
  LiveDesignElement,
  LiveDesignBreakpoint,
  LiveDesignDraftJournal,
  LiveDesignDraftUpdate,
  LiveDesignProposalField,
  LiveDesignProposalResponse,
  LiveDesignResolveResponse,
  LiveDesignResponsiveProperty,
  LiveDesignRevision,
  LiveDesignSourceCandidate,
  LiveDesignStructureNode,
  LiveDesignStructureOperationRequest,
  LiveDesignStructureSnapshot,
  LiveDesignStyleProperty,
  LiveDesignStyleScope,
  LiveDesignTokenNode,
  LiveDesignCmsReference,
  LiveDesignAuditFinding,
  VisualCapture,
  VisualRegressionEvidence,
} from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { DesignWorkflowPanel } from "./DesignWorkflowPanel";
import { LiveDesignStructurePanel } from "./LiveDesignStructurePanel";
import { DesignCatalogExplorer } from "../design/DesignCatalogExplorer";

const BRIDGE_NAMESPACE = "glimmer-live-design";

interface Props {
  sessionId: string;
  route: string;
  capture?: VisualCapture;
  initialDesignProfiles?: DesignProfileReference[];
}

interface EditorDraft {
  text: string;
  imageSource: string;
  textColor: string;
  backgroundColor: string;
  fontFamily: string;
  fontSizePx: string;
  fontWeight: string;
  lineHeight: string;
  paddingPx: string;
  marginPx: string;
  gapPx: string;
  borderColor: string;
  borderWidthPx: string;
  borderRadiusPx: string;
  opacity: string;
  direction: "row" | "column";
  align: "start" | "center" | "end" | "space-between";
  display: string;
  flexWrap: string;
  alignItemsValue: string;
  alignContent: string;
  width: string;
  height: string;
  minWidth: string;
  maxWidth: string;
  minHeight: string;
  maxHeight: string;
  position: string;
  top: string;
  right: string;
  bottom: string;
  left: string;
  zIndex: string;
  gridTemplateColumns: string;
  gridTemplateRows: string;
  gridAutoFlow: string;
  gridColumn: string;
  gridRow: string;
  order: string;
  flex: string;
  boxSizing: string;
}

const EDITOR_DRAFT_FIELDS: LiveDesignProposalField[] = [
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
];

function editorDraftFromJournal(
  value: LiveDesignDraftJournal["draft"] | LiveDesignDraftJournal["originalDraft"],
): EditorDraft | null {
  if (!value || !EDITOR_DRAFT_FIELDS.every((field) => typeof value[field] === "string")) {
    return null;
  }
  if (!(["row", "column"] as string[]).includes(value.direction ?? "")) return null;
  if (!(["start", "center", "end", "space-between"] as string[]).includes(value.align ?? "")) {
    return null;
  }
  return value as EditorDraft;
}

type ConnectionState = "connecting" | "ready" | "missing";
type HierarchyDirection = "parent" | "child" | "previous" | "next";
type InspectorTab =
  | "structure"
  | "content"
  | "style"
  | "layout"
  | "component"
  | "responsive"
  | "library"
  | "tokens"
  | "code"
  | "review"
  | "variants"
  | "history";

const INSPECTOR_TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: "structure", label: "Structure" },
  { id: "content", label: "Content" },
  { id: "style", label: "Style" },
  { id: "layout", label: "Layout" },
  { id: "component", label: "Component" },
  { id: "responsive", label: "Responsive" },
  { id: "library", label: "Library" },
  { id: "tokens", label: "Tokens" },
  { id: "code", label: "Code" },
  { id: "review", label: "Review" },
  { id: "variants", label: "Variants" },
  { id: "history", label: "History" },
];

const VIEWPORTS = [
  { id: "auto", label: "Fit", width: 0 },
  { id: "mobile", label: "390", width: 390 },
  { id: "tablet", label: "768", width: 768 },
  { id: "desktop", label: "1280", width: 1280 },
] as const;

const STYLE_MESSAGE_KEYS = [
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

const RESPONSIVE_PROPERTIES: Array<{
  id: LiveDesignResponsiveProperty;
  label: string;
  styleKey: (typeof STYLE_MESSAGE_KEYS)[number];
}> = [
  { id: "font-size", label: "Font size", styleKey: "fontSize" },
  { id: "padding", label: "Padding", styleKey: "padding" },
  { id: "margin", label: "Margin", styleKey: "margin" },
  { id: "gap", label: "Gap", styleKey: "gap" },
  { id: "color", label: "Text color", styleKey: "color" },
  { id: "background-color", label: "Background", styleKey: "backgroundColor" },
  { id: "font-weight", label: "Font weight", styleKey: "fontWeight" },
  { id: "line-height", label: "Line height", styleKey: "lineHeight" },
  { id: "border-width", label: "Border width", styleKey: "borderWidth" },
  { id: "border-radius", label: "Border radius", styleKey: "borderRadius" },
  { id: "opacity", label: "Opacity", styleKey: "opacity" },
  { id: "flex-direction", label: "Flex direction", styleKey: "flexDirection" },
  { id: "align-items", label: "Align items", styleKey: "alignItems" },
  { id: "justify-content", label: "Justify content", styleKey: "justifyContent" },
];

type DraftStyleKey = Exclude<keyof EditorDraft, "text" | "imageSource">;

interface SourceStyleBinding {
  key: DraftStyleKey;
  property: string;
  replacement: (value: string) => string;
}

const SOURCE_STYLE_BINDINGS: SourceStyleBinding[] = [
  { key: "textColor", property: "color", replacement: String },
  { key: "backgroundColor", property: "background-color", replacement: String },
  { key: "fontFamily", property: "font-family", replacement: String },
  { key: "fontSizePx", property: "font-size", replacement: (value) => `${value}px` },
  { key: "fontWeight", property: "font-weight", replacement: String },
  { key: "lineHeight", property: "line-height", replacement: String },
  { key: "paddingPx", property: "padding", replacement: (value) => `${value}px` },
  { key: "marginPx", property: "margin", replacement: (value) => `${value}px` },
  { key: "gapPx", property: "gap", replacement: (value) => `${value}px` },
  { key: "borderColor", property: "border-color", replacement: String },
  { key: "borderWidthPx", property: "border-width", replacement: (value) => `${value}px` },
  { key: "borderRadiusPx", property: "border-radius", replacement: (value) => `${value}px` },
  { key: "opacity", property: "opacity", replacement: String },
  { key: "direction", property: "flex-direction", replacement: String },
  {
    key: "align",
    property: "justify-content",
    replacement: (value) =>
      value === "start" ? "flex-start" : value === "end" ? "flex-end" : value,
  },
];

const VARIANT_PRESETS: Array<{
  name: string;
  description: string;
  patch: Partial<EditorDraft>;
}> = [
  {
    name: "Compact",
    description: "Tighter spacing and a restrained radius.",
    patch: { paddingPx: "6", gapPx: "6", borderRadiusPx: "6" },
  },
  {
    name: "Balanced",
    description: "Comfortable spacing with a neutral hierarchy.",
    patch: { paddingPx: "12", gapPx: "12", borderRadiusPx: "10" },
  },
  {
    name: "Expressive",
    description: "Larger type, generous spacing and a soft shape.",
    patch: { fontSizePx: "20", paddingPx: "18", gapPx: "16", borderRadiusPx: "18" },
  },
];

const LIVE_ANNOTATION_TOOLS: Array<{
  id: Extract<
    DesignFeedbackTool,
    "comment" | "draw" | "rectangle" | "ellipse" | "arrow" | "sticky"
  >;
  label: string;
}> = [
  { id: "comment", label: "Add note" },
  { id: "draw", label: "Draw" },
  { id: "rectangle", label: "Box" },
  { id: "ellipse", label: "Ellipse" },
  { id: "arrow", label: "Arrow" },
  { id: "sticky", label: "Sticky" },
];

function AnnotationPreview({
  tool,
  points,
}: {
  tool: DesignFeedbackTool;
  points: DesignFeedbackPoint[];
}) {
  if (!points.length) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (tool === "comment" || tool === "sticky") {
    return (
      <span
        className={`live-design-bridge__annotation-pin live-design-bridge__annotation-pin--${tool}`}
        style={{ left: `${first.x * 100}%`, top: `${first.y * 100}%` }}
      >
        {tool === "sticky" ? "▰" : "1"}
      </span>
    );
  }
  return (
    <svg
      className="live-design-bridge__annotation-svg"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      {tool === "draw" && (
        <polyline points={points.map((point) => `${point.x * 100},${point.y * 100}`).join(" ")} />
      )}
      {tool === "rectangle" && (
        <rect
          x={Math.min(first.x, last.x) * 100}
          y={Math.min(first.y, last.y) * 100}
          width={Math.abs(last.x - first.x) * 100}
          height={Math.abs(last.y - first.y) * 100}
        />
      )}
      {tool === "ellipse" && (
        <ellipse
          cx={((first.x + last.x) / 2) * 100}
          cy={((first.y + last.y) / 2) * 100}
          rx={(Math.abs(last.x - first.x) / 2) * 100}
          ry={(Math.abs(last.y - first.y) / 2) * 100}
        />
      )}
      {tool === "arrow" && (
        <>
          <line x1={first.x * 100} y1={first.y * 100} x2={last.x * 100} y2={last.y * 100} />
          <circle cx={last.x * 100} cy={last.y * 100} r="1.5" />
        </>
      )}
    </svg>
  );
}

function LayoutSection({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="live-design-layout__section" open={defaultOpen || undefined}>
      <summary>
        <span>{title}</span>
        <small>{summary}</small>
      </summary>
      <div className="live-design-layout__section-content">{children}</div>
    </details>
  );
}

function MetricStepper({
  label,
  value,
  minimum,
  maximum,
  onChange,
}: {
  label: string;
  value: string;
  minimum: number;
  maximum: number;
  onChange: (value: string) => void;
}) {
  const step = (delta: number) => {
    const current = Number(value);
    const next = Math.max(
      minimum,
      Math.min(maximum, (Number.isFinite(current) ? current : 0) + delta),
    );
    onChange(String(next));
  };
  return (
    <div className="live-design-metric">
      <span>{label}</span>
      <div>
        <button type="button" aria-label={`Decrease ${label}`} onClick={() => step(-1)}>
          −
        </button>
        <label>
          <span className="sr-only">{label} all sides</span>
          <input
            type="number"
            min={minimum}
            max={maximum}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
        <span>px</span>
        <button type="button" aria-label={`Increase ${label}`} onClick={() => step(1)}>
          +
        </button>
      </div>
    </div>
  );
}

function AlignmentPicker({
  direction,
  justify,
  alignItems,
  onChange,
}: {
  direction: EditorDraft["direction"];
  justify: EditorDraft["align"];
  alignItems: string;
  onChange: (justify: EditorDraft["align"], alignItems: string) => void;
}) {
  const axis = ["start", "center", "end"] as const;
  const normalizedCross =
    alignItems === "flex-end" ? "end" : alignItems === "center" ? "center" : "start";
  const normalizedMain = justify === "space-between" ? null : justify;
  return (
    <div className="live-design-alignment">
      <div>
        <strong>Visual alignment</strong>
        <small>Place children on both axes.</small>
      </div>
      <div className="live-design-alignment__grid" role="group" aria-label="Child alignment">
        {axis.flatMap((vertical) =>
          axis.map((horizontal) => {
            const main = direction === "row" ? horizontal : vertical;
            const cross = direction === "row" ? vertical : horizontal;
            const pressed = normalizedMain === main && normalizedCross === cross;
            return (
              <button
                key={`${vertical}-${horizontal}`}
                type="button"
                aria-label={`Align ${vertical} ${horizontal}`}
                aria-pressed={pressed}
                onClick={() =>
                  onChange(
                    main,
                    cross === "start" ? "flex-start" : cross === "end" ? "flex-end" : cross,
                  )
                }
              >
                <span />
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}

function localPreviewUrl(route: string): URL | null {
  try {
    const url = new URL(route);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function cssColorToHex(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const match = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!match) return "";
  return `#${match
    .slice(1, 4)
    .map((part) =>
      Math.max(0, Math.min(255, Number(part)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function numericText(value: string): string {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? String(parsed) : "";
}

function enumAlign(value: string): EditorDraft["align"] {
  if (value === "center" || value === "space-between") return value;
  if (value === "end" || value === "flex-end") return "end";
  return "start";
}

function draftFor(element: LiveDesignElement): EditorDraft {
  const fontSize = Number.parseFloat(element.styles.fontSize);
  const rawLineHeight = Number.parseFloat(element.styles.lineHeight);
  const lineHeight =
    element.styles.lineHeight.endsWith("px") && Number.isFinite(fontSize) && fontSize > 0
      ? String(Math.round((rawLineHeight / fontSize) * 100) / 100)
      : numericText(element.styles.lineHeight);
  return {
    text: element.text,
    imageSource: element.tagName === "img" ? (element.attributes.src ?? "") : "",
    textColor: cssColorToHex(element.styles.color),
    backgroundColor: cssColorToHex(element.styles.backgroundColor),
    fontFamily: element.styles.fontFamily,
    fontSizePx: numericText(element.styles.fontSize),
    fontWeight: numericText(element.styles.fontWeight),
    lineHeight,
    paddingPx: numericText(element.styles.padding),
    marginPx: numericText(element.styles.margin),
    gapPx: numericText(element.styles.gap),
    borderColor: cssColorToHex(element.styles.borderColor),
    borderWidthPx: numericText(element.styles.borderWidth),
    borderRadiusPx: numericText(element.styles.borderRadius),
    opacity: numericText(element.styles.opacity),
    direction: element.styles.flexDirection === "column" ? "column" : "row",
    align: enumAlign(element.styles.justifyContent),
    display: element.styles.display,
    flexWrap: element.styles.flexWrap,
    alignItemsValue: element.styles.alignItems,
    alignContent: element.styles.alignContent,
    width: element.styles.width,
    height: element.styles.height,
    minWidth: element.styles.minWidth,
    maxWidth: element.styles.maxWidth,
    minHeight: element.styles.minHeight,
    maxHeight: element.styles.maxHeight,
    position: element.styles.position,
    top: element.styles.top,
    right: element.styles.right,
    bottom: element.styles.bottom,
    left: element.styles.left,
    zIndex: element.styles.zIndex,
    gridTemplateColumns: element.styles.gridTemplateColumns,
    gridTemplateRows: element.styles.gridTemplateRows,
    gridAutoFlow: element.styles.gridAutoFlow,
    gridColumn: element.styles.gridColumn,
    gridRow: element.styles.gridRow,
    order: element.styles.order,
    flex: element.styles.flex,
    boxSizing: element.styles.boxSizing,
  };
}

function boundedOptional(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length <= max ? value : null;
}

function normalizeElementMessage(value: unknown): LiveDesignElement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const element = value as Record<string, unknown>;
  const sourcePathHint = boundedOptional(element.sourcePathHint, 4_096);
  const componentName = boundedOptional(element.componentName, 200);
  const stableId = boundedOptional(element.stableId, 500);
  if (
    typeof element.selector !== "string" ||
    !element.selector ||
    element.selector.length > 1_000 ||
    typeof element.tagName !== "string" ||
    !/^[a-z][a-z0-9-]*$/i.test(element.tagName) ||
    typeof element.text !== "string" ||
    element.text.length > 2_000 ||
    sourcePathHint === null ||
    componentName === null ||
    stableId === null ||
    (element.framework !== undefined &&
      !["html", "react", "vue", "svelte", "unknown"].includes(String(element.framework))) ||
    !element.attributes ||
    typeof element.attributes !== "object" ||
    Array.isArray(element.attributes) ||
    !element.styles ||
    typeof element.styles !== "object" ||
    Array.isArray(element.styles) ||
    !element.rect ||
    typeof element.rect !== "object" ||
    Array.isArray(element.rect) ||
    !Array.isArray(element.tokens) ||
    element.tokens.length > 50
  ) {
    return null;
  }
  const attributes = element.attributes as Record<string, unknown>;
  if (
    Object.keys(attributes).length > 10 ||
    Object.values(attributes).some((item) => typeof item !== "string" || item.length > 500)
  ) {
    return null;
  }
  const rawStyles = element.styles as Record<string, unknown>;
  if (STYLE_MESSAGE_KEYS.some((key) => typeof rawStyles[key] !== "string")) return null;
  const rawRect = element.rect as Record<string, unknown>;
  if (
    ["x", "y", "width", "height", "viewportWidth", "viewportHeight"].some(
      (key) => typeof rawRect[key] !== "number" || !Number.isFinite(rawRect[key]),
    )
  ) {
    return null;
  }
  const tokens = element.tokens as Array<Record<string, unknown>>;
  if (
    tokens.some(
      (token) =>
        !token ||
        typeof token !== "object" ||
        typeof token.name !== "string" ||
        typeof token.value !== "string" ||
        typeof token.property !== "string",
    )
  ) {
    return null;
  }
  let breadcrumbs: LiveDesignElement["breadcrumbs"];
  if (element.breadcrumbs !== undefined) {
    if (!Array.isArray(element.breadcrumbs) || element.breadcrumbs.length > 8) return null;
    breadcrumbs = [];
    for (const item of element.breadcrumbs) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const raw = item as Record<string, unknown>;
      if (
        typeof raw.tagName !== "string" ||
        !/^[a-z][a-z0-9-]*$/i.test(raw.tagName) ||
        typeof raw.selector !== "string" ||
        !raw.selector ||
        raw.selector.length > 1_000 ||
        typeof raw.label !== "string" ||
        !raw.label ||
        raw.label.length > 120
      ) {
        return null;
      }
      breadcrumbs.push({ tagName: raw.tagName, selector: raw.selector, label: raw.label });
    }
  }
  let styleSources: LiveDesignElement["styleSources"];
  if (element.styleSources !== undefined) {
    if (!Array.isArray(element.styleSources) || element.styleSources.length > 30) return null;
    styleSources = [];
    for (const item of element.styleSources) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const raw = item as Record<string, unknown>;
      if (
        typeof raw.selector !== "string" ||
        !raw.selector ||
        raw.selector.length > 1_000 ||
        typeof raw.source !== "string" ||
        !raw.source ||
        raw.source.length > 500 ||
        typeof raw.specificity !== "string" ||
        !raw.specificity ||
        raw.specificity.length > 50 ||
        typeof raw.inherited !== "boolean" ||
        !Array.isArray(raw.declarations) ||
        raw.declarations.length > 80
      ) {
        return null;
      }
      const declarations = [];
      for (const entry of raw.declarations) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const declaration = entry as Record<string, unknown>;
        if (
          typeof declaration.property !== "string" ||
          !/^[a-z-]+$/.test(declaration.property) ||
          declaration.property.length > 100 ||
          typeof declaration.value !== "string" ||
          declaration.value.length > 500 ||
          typeof declaration.important !== "boolean"
        ) {
          return null;
        }
        declarations.push({
          property: declaration.property,
          value: declaration.value,
          important: declaration.important,
        });
      }
      styleSources.push({
        selector: raw.selector,
        source: raw.source,
        specificity: raw.specificity,
        inherited: raw.inherited,
        declarations,
      });
    }
  }
  return {
    selector: element.selector,
    tagName: element.tagName.toLowerCase(),
    text: element.text,
    attributes: attributes as Record<string, string>,
    styles: Object.fromEntries(
      STYLE_MESSAGE_KEYS.map((key) => [key, rawStyles[key]]),
    ) as unknown as LiveDesignElement["styles"],
    rect: rawRect as unknown as LiveDesignElement["rect"],
    tokens: tokens as unknown as LiveDesignElement["tokens"],
    ...(sourcePathHint !== undefined ? { sourcePathHint } : {}),
    ...(typeof element.framework === "string"
      ? { framework: element.framework as LiveDesignElement["framework"] }
      : {}),
    ...(componentName !== undefined ? { componentName } : {}),
    ...(stableId !== undefined ? { stableId } : {}),
    ...(breadcrumbs ? { breadcrumbs } : {}),
    ...(styleSources ? { styleSources } : {}),
  };
}

function normalizeStructureMessage(value: unknown): LiveDesignStructureSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    !Array.isArray(raw.roots) ||
    raw.roots.length > 20 ||
    !Number.isInteger(raw.total) ||
    Number(raw.total) < 0 ||
    Number(raw.total) > 500 ||
    typeof raw.truncated !== "boolean"
  ) {
    return null;
  }
  let count = 0;
  function nodeFor(input: unknown, depth: number): LiveDesignStructureNode | null {
    if (depth > 12 || count >= 500 || !input || typeof input !== "object" || Array.isArray(input)) {
      return null;
    }
    const node = input as Record<string, unknown>;
    const sourcePathHint = boundedOptional(node.sourcePathHint, 4_096);
    const componentName = boundedOptional(node.componentName, 200);
    if (
      typeof node.selector !== "string" ||
      !node.selector ||
      node.selector.length > 1_000 ||
      typeof node.tagName !== "string" ||
      !/^[a-z][a-z0-9-]*$/i.test(node.tagName) ||
      typeof node.label !== "string" ||
      !node.label ||
      node.label.length > 200 ||
      typeof node.text !== "string" ||
      node.text.length > 500 ||
      sourcePathHint === null ||
      componentName === null ||
      (node.framework !== undefined &&
        !["html", "react", "vue", "svelte", "unknown"].includes(String(node.framework))) ||
      !node.attributes ||
      typeof node.attributes !== "object" ||
      Array.isArray(node.attributes) ||
      typeof node.canHaveChildren !== "boolean" ||
      typeof node.hidden !== "boolean" ||
      !Array.isArray(node.children) ||
      node.children.length > 200
    ) {
      return null;
    }
    const attributes = node.attributes as Record<string, unknown>;
    if (
      Object.keys(attributes).length > 10 ||
      Object.values(attributes).some((item) => typeof item !== "string" || item.length > 500)
    ) {
      return null;
    }
    count += 1;
    const children: LiveDesignStructureNode[] = [];
    for (const child of node.children) {
      const normalized = nodeFor(child, depth + 1);
      if (!normalized) return null;
      children.push(normalized);
    }
    return {
      selector: node.selector,
      tagName: node.tagName.toLowerCase(),
      label: node.label,
      text: node.text,
      attributes: attributes as Record<string, string>,
      canHaveChildren: node.canHaveChildren,
      hidden: node.hidden,
      children,
      ...(sourcePathHint !== undefined ? { sourcePathHint } : {}),
      ...(typeof node.framework === "string"
        ? { framework: node.framework as LiveDesignStructureNode["framework"] }
        : {}),
      ...(componentName !== undefined ? { componentName } : {}),
    };
  }
  const roots: LiveDesignStructureNode[] = [];
  for (const root of raw.roots) {
    const normalized = nodeFor(root, 0);
    if (!normalized) return null;
    roots.push(normalized);
  }
  if (count !== raw.total) return null;
  return { roots, total: Number(raw.total), truncated: raw.truncated };
}

function responsivePreviewSelector(element: LiveDesignElement): string {
  const id = element.attributes.id;
  if (id && /^[A-Za-z0-9_-]{1,100}$/.test(id)) return `#${id}`;
  const testId = element.attributes["data-testid"];
  if (testId && /^[A-Za-z0-9_-]{1,100}$/.test(testId)) {
    return `[data-testid="${testId}"]`;
  }
  const classes = (element.attributes.class ?? "")
    .split(/\s+/)
    .filter((className) => /^[A-Za-z0-9_-]{1,100}$/.test(className))
    .slice(0, 4);
  return classes.length ? classes.map((className) => `.${className}`).join("") : element.selector;
}

function styleScopeSelector(
  element: LiveDesignElement,
  scope: LiveDesignStyleScope,
  selectedClass?: string,
): string | null {
  if (scope === "instance") {
    const id = element.attributes.id;
    if (id && /^[A-Za-z0-9_-]{1,100}$/.test(id)) return `#${id}`;
    const testId = element.attributes["data-testid"];
    return testId && /^[A-Za-z0-9_-]{1,100}$/.test(testId) ? `[data-testid="${testId}"]` : null;
  }
  const classes = (element.attributes.class ?? "")
    .split(/\s+/)
    .filter((className) => /^[A-Za-z0-9_-]{1,100}$/.test(className))
    .slice(0, 4);
  if (selectedClass) return classes.includes(selectedClass) ? `.${selectedClass}` : null;
  return classes.length ? classes.map((className) => `.${className}`).join("") : null;
}

function matchingStructureNodes(
  snapshot: LiveDesignStructureSnapshot | null,
  selector: string | null,
): number {
  if (!snapshot || !selector) return 0;
  const stableSelector = selector;
  let count = 0;
  function visit(nodes: LiveDesignStructureNode[]) {
    for (const node of nodes) {
      if (stableSelector.startsWith("#") && node.attributes.id === stableSelector.slice(1)) {
        count += 1;
      } else if (stableSelector.startsWith("[data-testid=")) {
        const testId = stableSelector.match(/^\[data-testid="([A-Za-z0-9_-]+)"\]$/)?.[1];
        if (testId && node.attributes["data-testid"] === testId) count += 1;
      } else if (stableSelector.startsWith(".")) {
        const needed = stableSelector.slice(1).split(".").filter(Boolean);
        const available = new Set((node.attributes.class ?? "").split(/\s+/).filter(Boolean));
        if (needed.length && needed.every((className) => available.has(className))) count += 1;
      }
      visit(node.children);
    }
  }
  visit(snapshot.roots);
  return count;
}

function hierarchyNeighbor(
  snapshot: LiveDesignStructureSnapshot | null,
  selector: string,
  direction: HierarchyDirection,
): string | null {
  if (!snapshot || !selector) return null;
  let match: {
    node: LiveDesignStructureNode;
    parent: LiveDesignStructureNode | null;
    siblings: LiveDesignStructureNode[];
    index: number;
  } | null = null;
  function visit(
    nodes: LiveDesignStructureNode[],
    parent: LiveDesignStructureNode | null,
  ): boolean {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node.selector === selector) {
        match = { node, parent, siblings: nodes, index };
        return true;
      }
      if (visit(node.children, node)) return true;
    }
    return false;
  }
  visit(snapshot.roots, null);
  if (!match) return null;
  const found = match as {
    node: LiveDesignStructureNode;
    parent: LiveDesignStructureNode | null;
    siblings: LiveDesignStructureNode[];
    index: number;
  };
  if (direction === "parent") return found.parent?.selector ?? null;
  if (direction === "child") return found.node.children[0]?.selector ?? null;
  if (direction === "previous") return found.siblings[found.index - 1]?.selector ?? null;
  return found.siblings[found.index + 1]?.selector ?? null;
}

function layoutDeclarations(
  draft: EditorDraft,
  original: EditorDraft,
): Partial<Record<LiveDesignStyleProperty, string>> {
  const declarations: Partial<Record<LiveDesignStyleProperty, string>> = {};
  const add = (property: LiveDesignStyleProperty, value: string, originalValue: string) => {
    if (value !== originalValue && value.trim()) declarations[property] = value.trim();
  };
  add("display", draft.display, original.display);
  add("flex-direction", draft.direction, original.direction);
  add("flex-wrap", draft.flexWrap, original.flexWrap);
  add("align-items", draft.alignItemsValue, original.alignItemsValue);
  add("align-content", draft.alignContent, original.alignContent);
  add(
    "justify-content",
    draft.align === "start" ? "flex-start" : draft.align === "end" ? "flex-end" : draft.align,
    original.align === "start"
      ? "flex-start"
      : original.align === "end"
        ? "flex-end"
        : original.align,
  );
  add("width", draft.width, original.width);
  add("height", draft.height, original.height);
  add("min-width", draft.minWidth, original.minWidth);
  add("max-width", draft.maxWidth, original.maxWidth);
  add("min-height", draft.minHeight, original.minHeight);
  add("max-height", draft.maxHeight, original.maxHeight);
  add("position", draft.position, original.position);
  add("top", draft.top, original.top);
  add("right", draft.right, original.right);
  add("bottom", draft.bottom, original.bottom);
  add("left", draft.left, original.left);
  add("z-index", draft.zIndex, original.zIndex);
  add("grid-template-columns", draft.gridTemplateColumns, original.gridTemplateColumns);
  add("grid-template-rows", draft.gridTemplateRows, original.gridTemplateRows);
  add("grid-auto-flow", draft.gridAutoFlow, original.gridAutoFlow);
  add("grid-column", draft.gridColumn, original.gridColumn);
  add("grid-row", draft.gridRow, original.gridRow);
  add("order", draft.order, original.order);
  add("flex", draft.flex, original.flex);
  add("box-sizing", draft.boxSizing, original.boxSizing);
  if (draft.gapPx !== original.gapPx && draft.gapPx.trim()) declarations.gap = `${draft.gapPx}px`;
  if (draft.paddingPx !== original.paddingPx && draft.paddingPx.trim()) {
    declarations.padding = `${draft.paddingPx}px`;
  }
  if (draft.marginPx !== original.marginPx && draft.marginPx.trim()) {
    declarations.margin = `${draft.marginPx}px`;
  }
  return declarations;
}

function numberOrUndefined(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function baseFeedback(
  current: DesignFeedbackDocument | null | undefined,
  initialDesignProfiles: DesignProfileReference[] = [],
): DesignFeedbackUpdate {
  return {
    annotations: current?.annotations ?? [],
    variants: current?.variants ?? [],
    inspirations: current?.inspirations ?? [],
    designProfiles: current?.designProfiles?.length
      ? current.designProfiles
      : initialDesignProfiles,
    elementEdits: current?.elementEdits ?? [],
    assetRequests: current?.assetRequests ?? [],
  };
}

function regionFor(element: LiveDesignElement) {
  const viewportWidth = Math.max(1, element.rect.viewportWidth);
  const viewportHeight = Math.max(1, element.rect.viewportHeight);
  const x = Math.max(0, Math.min(1, element.rect.x / viewportWidth));
  const y = Math.max(0, Math.min(1, element.rect.y / viewportHeight));
  return {
    x,
    y,
    width: Math.max(0, Math.min(1 - x, element.rect.width / viewportWidth)),
    height: Math.max(0, Math.min(1 - y, element.rect.height / viewportHeight)),
  };
}

function styleFeedback(draft: EditorDraft, original: EditorDraft): DesignElementStyleEdit {
  const style: DesignElementStyleEdit = {};
  if (draft.textColor !== original.textColor && draft.textColor) style.textColor = draft.textColor;
  if (draft.backgroundColor !== original.backgroundColor && draft.backgroundColor)
    style.backgroundColor = draft.backgroundColor;
  if (draft.fontFamily !== original.fontFamily && draft.fontFamily)
    style.fontFamily = draft.fontFamily;
  const numbers: Array<[keyof DesignElementStyleEdit, keyof EditorDraft]> = [
    ["fontSizePx", "fontSizePx"],
    ["fontWeight", "fontWeight"],
    ["lineHeight", "lineHeight"],
    ["paddingPx", "paddingPx"],
    ["marginPx", "marginPx"],
    ["gapPx", "gapPx"],
    ["borderWidthPx", "borderWidthPx"],
    ["borderRadiusPx", "borderRadiusPx"],
    ["opacity", "opacity"],
  ];
  for (const [styleKey, draftKey] of numbers) {
    if (draft[draftKey] !== original[draftKey]) {
      const value = numberOrUndefined(draft[draftKey]);
      if (value !== undefined) (style as Record<string, unknown>)[styleKey] = value;
    }
  }
  if (draft.borderColor !== original.borderColor && draft.borderColor)
    style.borderColor = draft.borderColor;
  if (draft.direction !== original.direction) style.direction = draft.direction;
  if (draft.align !== original.align) style.align = draft.align;
  return style;
}

function auditDraft(draft: EditorDraft): LiveDesignAuditFinding[] {
  const findings: LiveDesignAuditFinding[] = [];
  for (const [field, label] of [
    ["paddingPx", "Padding"],
    ["gapPx", "Gap"],
  ] as const) {
    const value = Number(draft[field]);
    if (Number.isFinite(value) && Math.abs(value) % 4 !== 0) {
      findings.push({
        id: `preview-${field}-rhythm`,
        severity: "info",
        category: "design-system",
        message: `${label} preview uses ${value}px, outside the 4px spacing rhythm.`,
        suggestion: `Round ${label.toLowerCase()} to the nearest 4px step before saving.`,
      });
    }
  }
  const fontSize = Number(draft.fontSizePx);
  if (Number.isFinite(fontSize) && fontSize < 12 && draft.text) {
    findings.push({
      id: "preview-small-text",
      severity: "warning",
      category: "accessibility",
      message: `Preview text is ${fontSize}px and may be difficult to read.`,
      suggestion: "Increase it to at least 12px before saving.",
    });
  }
  const opacity = Number(draft.opacity);
  if (Number.isFinite(opacity) && opacity < 0.5 && draft.text) {
    findings.push({
      id: "preview-low-opacity",
      severity: "warning",
      category: "accessibility",
      message: `Preview opacity is ${opacity}; text may lose effective contrast.`,
      suggestion: "Increase opacity or verify the resulting contrast before saving.",
    });
  }
  const foreground = colorChannels(draft.textColor);
  const background = colorChannels(draft.backgroundColor);
  if (foreground && background && background[3] > 0) {
    const ratio = colorContrast(foreground, background);
    if (ratio < 4.5) {
      findings.push({
        id: "preview-contrast",
        severity: ratio < 3 ? "error" : "warning",
        category: "accessibility",
        message: `Preview contrast is ${ratio.toFixed(2)}:1; normal text should reach 4.5:1.`,
        suggestion: "Choose foreground and background tokens with stronger contrast before saving.",
      });
    }
  }
  return findings;
}

function colorChannels(value: string): [number, number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (hex) {
    const expanded =
      hex[1].length === 3
        ? hex[1]
            .split("")
            .map((channel) => channel + channel)
            .join("")
        : hex[1];
    return [
      Number.parseInt(expanded.slice(0, 2), 16),
      Number.parseInt(expanded.slice(2, 4), 16),
      Number.parseInt(expanded.slice(4, 6), 16),
      expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    ];
  }
  const rgb =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(\d?(?:\.\d+)?))?\s*\)$/i.exec(
      value.trim(),
    );
  if (!rgb) return null;
  const channels = rgb.slice(1, 4).map(Number);
  if (channels.some((channel) => channel < 0 || channel > 255)) return null;
  const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
  return [channels[0], channels[1], channels[2], alpha];
}

function colorContrast(
  foreground: [number, number, number, number],
  background: [number, number, number, number],
): number {
  const luminance = (channels: [number, number, number, number]) => {
    const linear = channels.slice(0, 3).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function previewPatch(draft: EditorDraft, original: EditorDraft) {
  return {
    ...(draft.text !== original.text ? { text: draft.text } : {}),
    ...(draft.imageSource !== original.imageSource ? { imageSource: draft.imageSource } : {}),
    ...(draft.textColor !== original.textColor && draft.textColor
      ? { textColor: draft.textColor }
      : {}),
    ...(draft.backgroundColor !== original.backgroundColor && draft.backgroundColor
      ? { backgroundColor: draft.backgroundColor }
      : {}),
    ...(draft.fontFamily !== original.fontFamily && draft.fontFamily
      ? { fontFamily: draft.fontFamily }
      : {}),
    ...(draft.fontSizePx !== original.fontSizePx &&
    numberOrUndefined(draft.fontSizePx) !== undefined
      ? { fontSizePx: numberOrUndefined(draft.fontSizePx) }
      : {}),
    ...(draft.fontWeight !== original.fontWeight &&
    numberOrUndefined(draft.fontWeight) !== undefined
      ? { fontWeight: numberOrUndefined(draft.fontWeight) }
      : {}),
    ...(draft.lineHeight !== original.lineHeight &&
    numberOrUndefined(draft.lineHeight) !== undefined
      ? { lineHeight: numberOrUndefined(draft.lineHeight) }
      : {}),
    ...(draft.paddingPx !== original.paddingPx && numberOrUndefined(draft.paddingPx) !== undefined
      ? { paddingPx: numberOrUndefined(draft.paddingPx) }
      : {}),
    ...(draft.marginPx !== original.marginPx && numberOrUndefined(draft.marginPx) !== undefined
      ? { marginPx: numberOrUndefined(draft.marginPx) }
      : {}),
    ...(draft.gapPx !== original.gapPx && numberOrUndefined(draft.gapPx) !== undefined
      ? { gapPx: numberOrUndefined(draft.gapPx) }
      : {}),
    ...(draft.borderColor !== original.borderColor && draft.borderColor
      ? { borderColor: draft.borderColor }
      : {}),
    ...(draft.borderWidthPx !== original.borderWidthPx &&
    numberOrUndefined(draft.borderWidthPx) !== undefined
      ? { borderWidthPx: numberOrUndefined(draft.borderWidthPx) }
      : {}),
    ...(draft.borderRadiusPx !== original.borderRadiusPx &&
    numberOrUndefined(draft.borderRadiusPx) !== undefined
      ? { borderRadiusPx: numberOrUndefined(draft.borderRadiusPx) }
      : {}),
    ...(draft.opacity !== original.opacity && numberOrUndefined(draft.opacity) !== undefined
      ? { opacity: numberOrUndefined(draft.opacity) }
      : {}),
    ...(draft.direction !== original.direction ? { direction: draft.direction } : {}),
    ...(draft.align !== original.align ? { align: draft.align } : {}),
    ...(draft.display !== original.display ? { display: draft.display } : {}),
    ...(draft.flexWrap !== original.flexWrap ? { flexWrap: draft.flexWrap } : {}),
    ...(draft.alignItemsValue !== original.alignItemsValue
      ? { alignItemsValue: draft.alignItemsValue }
      : {}),
    ...(draft.alignContent !== original.alignContent ? { alignContent: draft.alignContent } : {}),
    ...(draft.width !== original.width ? { width: draft.width } : {}),
    ...(draft.height !== original.height ? { height: draft.height } : {}),
    ...(draft.minWidth !== original.minWidth ? { minWidth: draft.minWidth } : {}),
    ...(draft.maxWidth !== original.maxWidth ? { maxWidth: draft.maxWidth } : {}),
    ...(draft.minHeight !== original.minHeight ? { minHeight: draft.minHeight } : {}),
    ...(draft.maxHeight !== original.maxHeight ? { maxHeight: draft.maxHeight } : {}),
    ...(draft.position !== original.position ? { position: draft.position } : {}),
    ...(draft.top !== original.top ? { top: draft.top } : {}),
    ...(draft.right !== original.right ? { right: draft.right } : {}),
    ...(draft.bottom !== original.bottom ? { bottom: draft.bottom } : {}),
    ...(draft.left !== original.left ? { left: draft.left } : {}),
    ...(draft.zIndex !== original.zIndex ? { zIndex: draft.zIndex } : {}),
    ...(draft.gridTemplateColumns !== original.gridTemplateColumns
      ? { gridTemplateColumns: draft.gridTemplateColumns }
      : {}),
    ...(draft.gridTemplateRows !== original.gridTemplateRows
      ? { gridTemplateRows: draft.gridTemplateRows }
      : {}),
    ...(draft.gridAutoFlow !== original.gridAutoFlow ? { gridAutoFlow: draft.gridAutoFlow } : {}),
    ...(draft.gridColumn !== original.gridColumn ? { gridColumn: draft.gridColumn } : {}),
    ...(draft.gridRow !== original.gridRow ? { gridRow: draft.gridRow } : {}),
    ...(draft.order !== original.order ? { order: draft.order } : {}),
    ...(draft.flex !== original.flex ? { flex: draft.flex } : {}),
    ...(draft.boxSizing !== original.boxSizing ? { boxSizing: draft.boxSizing } : {}),
  };
}

function chooseCandidate(
  candidates: LiveDesignSourceCandidate[],
  property: string,
): LiveDesignSourceCandidate | undefined {
  const matches = candidates.filter(
    (candidate) => candidate.kind === "css-declaration" && candidate.property === property,
  );
  return matches.find((candidate) => candidate.confidence === "exact");
}

function sourceStyleEdits(
  draft: EditorDraft,
  original: EditorDraft,
  resolution: LiveDesignResolveResponse | null,
) {
  if (!resolution) return [];
  const edits: Array<{ candidate: LiveDesignSourceCandidate; replacement: string }> = [];
  for (const binding of SOURCE_STYLE_BINDINGS) {
    if (draft[binding.key] === original[binding.key] || !draft[binding.key]) continue;
    const candidate = chooseCandidate(resolution.candidates, binding.property);
    if (candidate) edits.push({ candidate, replacement: binding.replacement(draft[binding.key]) });
  }
  if (!edits.length) return [];
  const path = edits[0].candidate.path;
  const hash = edits[0].candidate.fileHash;
  return edits.every((edit) => edit.candidate.path === path && edit.candidate.fileHash === hash)
    ? edits
    : [];
}

function revisionLabel(revision: LiveDesignRevision): string {
  if (revision.kind === "transaction") {
    const count = revision.changeCount ?? 0;
    return `${count} style change${count === 1 ? "" : "s"}`;
  }
  if (revision.kind === "bridge-install") return "Development bridge";
  if (revision.kind === "text-node") return "Text change";
  if (revision.kind === "css-token") return "Token change";
  if (revision.kind === "structure-insert") return "Inserted element";
  if (revision.kind === "structure-reorder") return "Reordered element";
  if (revision.kind === "structure-reparent") return "Moved element";
  if (revision.kind === "responsive-override") return "Responsive override";
  if (revision.kind === "style-override") return "Visual layout override";
  return "Style change";
}

export function LiveDesignBridge({ sessionId, route, capture, initialDesignProfiles = [] }: Props) {
  const target = useMemo(() => localPreviewUrl(route), [route]);
  const designerRoot = useRef<HTMLDivElement>(null);
  const designerHovered = useRef(false);
  const iframe = useRef<HTMLIFrameElement>(null);
  const channel = useRef(crypto.randomUUID());
  const selectedSelector = useRef("");
  const reselectTimer = useRef<number | null>(null);
  const handshakeTimer = useRef<number | null>(null);
  const journalTimer = useRef<number | null>(null);
  const journalSequence = useRef(0);
  const journalHydrated = useRef(false);
  const recoveredDraft = useRef<EditorDraft | null>(null);
  const recoveredOriginalDraft = useRef<EditorDraft | null>(null);
  const journalSelectedSelectors = useRef<string[]>([]);
  const latestJournalUpdate = useRef<LiveDesignDraftUpdate | null>(null);
  const saveJournalRef = useRef<(update: LiveDesignDraftUpdate) => void>(() => undefined);
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [selecting, setSelecting] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const drawing = useRef(false);
  const [annotationTool, setAnnotationTool] =
    useState<
      Extract<DesignFeedbackTool, "comment" | "draw" | "rectangle" | "ellipse" | "arrow" | "sticky">
    >("comment");
  const [annotationPoints, setAnnotationPoints] = useState<DesignFeedbackPoint[]>([]);
  const [annotationComment, setAnnotationComment] = useState("");
  const [elementPrompt, setElementPrompt] = useState("");
  const [selected, setSelected] = useState<LiveDesignElement | null>(null);
  const [selectedElements, setSelectedElements] = useState<LiveDesignElement[]>([]);
  const [lockedSelectors, setLockedSelectors] = useState<Set<string>>(() => new Set());
  const [hiddenSelectors, setHiddenSelectors] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [originalDraft, setOriginalDraft] = useState<EditorDraft | null>(null);
  const [resolution, setResolution] = useState<LiveDesignResolveResponse | null>(null);
  const [textCandidateId, setTextCandidateId] = useState("");
  const [tokenCandidateId, setTokenCandidateId] = useState("");
  const [tokenReplacement, setTokenReplacement] = useState("");
  const [tokenBindingProperty, setTokenBindingProperty] = useState("color");
  const [revision, setRevision] = useState<LiveDesignRevision | null>(null);
  const [savedText, setSavedText] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [activeTab, setActiveTab] = useState<InspectorTab>("content");
  const [viewportId, setViewportId] = useState<(typeof VIEWPORTS)[number]["id"]>("auto");
  const [zoom, setZoom] = useState(100);
  const [inspectorWidth, setInspectorWidth] = useState(360);
  const [assetPrompt, setAssetPrompt] = useState("");
  const [assetPath, setAssetPath] = useState("public/generated/live-design.png");
  const [workflowError, setWorkflowError] = useState("");
  const [structure, setStructure] = useState<LiveDesignStructureSnapshot | null>(null);
  const [pendingStructure, setPendingStructure] =
    useState<LiveDesignStructureOperationRequest | null>(null);
  const [responsiveBreakpoint, setResponsiveBreakpoint] = useState<LiveDesignBreakpoint>("mobile");
  const [responsiveProperty, setResponsiveProperty] =
    useState<LiveDesignResponsiveProperty>("font-size");
  const [responsiveValue, setResponsiveValue] = useState("");
  const [responsiveOverrides, setResponsiveOverrides] = useState<Record<string, string>>({});
  const [responsivePreviewed, setResponsivePreviewed] = useState(false);
  const [styleScope, setStyleScope] = useState<LiveDesignStyleScope>("component");
  const [selectedClass, setSelectedClass] = useState("");
  const [resizeMode, setResizeMode] = useState(false);
  const [styleRulePreviewed, setStyleRulePreviewed] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [proposal, setProposal] = useState<LiveDesignProposalResponse | null>(null);
  const [proposalDecision, setProposalDecision] = useState<"previewing" | "accepted" | null>(null);
  const [journalSavedAt, setJournalSavedAt] = useState("");
  const [journalError, setJournalError] = useState("");

  const feedback = useQuery({
    queryKey: ["design-feedback", sessionId],
    queryFn: () => glimmerApi.getDesignFeedback(sessionId),
    retry: false,
  });
  const history = useQuery({
    queryKey: ["live-design-history", sessionId],
    queryFn: () => glimmerApi.getLiveDesignHistory(sessionId),
    retry: false,
  });
  const workflow = useQuery({
    queryKey: ["design-workflow", sessionId],
    queryFn: () => glimmerApi.getDesignWorkflow(sessionId),
    retry: false,
  });
  const journal = useQuery({
    queryKey: ["live-design-draft", sessionId],
    queryFn: async () => {
      const durable = await glimmerApi.getLiveDesignDraft(sessionId);
      if (durable) return durable;
      try {
        const local = window.localStorage?.getItem(`glimmer.live-design-draft.${sessionId}`);
        if (!local) return null;
        const parsed = JSON.parse(local) as LiveDesignDraftJournal;
        if (
          parsed?.version !== 1 ||
          parsed.sessionId !== sessionId ||
          parsed.route !== route ||
          typeof parsed.updatedAt !== "string"
        ) {
          return null;
        }
        const {
          version: _version,
          sessionId: _sessionId,
          updatedAt: _updatedAt,
          ...update
        } = parsed;
        return await glimmerApi.saveLiveDesignDraft(sessionId, update);
      } catch {
        return null;
      }
    },
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const activeChangeSet = workflow.data?.changeSets.find(
    (item) => item.id === workflow.data?.activeChangeSetId,
  );
  const visualRegression = useQuery<VisualRegressionEvidence>({
    queryKey: ["visual-regression", sessionId, activeChangeSet?.id],
    queryFn: () => glimmerApi.getVisualRegression(sessionId, activeChangeSet!.id),
    enabled: Boolean(activeChangeSet?.id),
    retry: false,
  });
  const setWorkflow = useCallback(
    (document: DesignWorkflowDocument) => {
      queryClient.setQueryData(["design-workflow", sessionId], document);
      setWorkflowError("");
    },
    [queryClient, sessionId],
  );
  const refreshWorkflow = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["design-workflow", sessionId] });
  }, [queryClient, sessionId]);
  const refreshHistory = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["live-design-history", sessionId] });
  }, [queryClient, sessionId]);

  const resolveMutation = useMutation({
    mutationFn: (element: LiveDesignElement) =>
      glimmerApi.resolveLiveDesignElement(sessionId, { element }),
    onSuccess: (result) => {
      setResolution(result);
      const textCandidates = result.candidates.filter(
        (candidate) => candidate.kind === "text-node",
      );
      const tokenCandidates = result.candidates.filter(
        (candidate) => candidate.kind === "css-token",
      );
      setTextCandidateId((current) =>
        textCandidates.some((candidate) => candidate.id === current)
          ? current
          : textCandidates.length === 1
            ? textCandidates[0].id
            : "",
      );
      setTokenCandidateId((current) =>
        tokenCandidates.some((candidate) => candidate.id === current)
          ? current
          : tokenCandidates.length === 1
            ? tokenCandidates[0].id
            : "",
      );
      setTokenReplacement(
        (current) => current || (tokenCandidates.length === 1 ? tokenCandidates[0].expected : ""),
      );
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const proposalMutation = useMutation({
    mutationFn: ({ element, prompt }: { element: LiveDesignElement; prompt: string }) =>
      glimmerApi.proposeLiveDesignChange(sessionId, { element, prompt }),
    onSuccess: (result, input) => {
      setProposal(result);
      setProposalDecision("previewing");
      setElementPrompt("");
      if (!selected || selected.selector !== input.element.selector || !draft) {
        setNotice("Proposal is ready. Reselect the original element to preview it.");
        return;
      }
      const next = { ...draft } as Record<LiveDesignProposalField, string>;
      for (const change of result.changes) next[change.field] = change.after;
      setDraft(next as EditorDraft);
      setNotice(
        result.provenance === "model-output"
          ? "Glimmer proposal is live on the canvas. Review the diff before accepting."
          : "A safe local proposal is live on the canvas while the model is unavailable.",
      );
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const journalMutation = useMutation({
    mutationFn: (update: LiveDesignDraftUpdate) =>
      glimmerApi.saveLiveDesignDraft(sessionId, update),
    onSuccess: (document) => {
      setJournalSavedAt(document.updatedAt);
      setJournalError("");
      queryClient.setQueryData(["live-design-draft", sessionId], document);
    },
    onError: (error: Error) => setJournalError(error.message),
  });
  saveJournalRef.current = journalMutation.mutate;
  const applyMutation = useMutation({
    mutationFn: (input: { candidate: LiveDesignSourceCandidate; replacement: string }) =>
      glimmerApi.applyLiveDesignEdit(sessionId, {
        ...input,
        ...(activeChangeSet ? { changeSetId: activeChangeSet.id } : {}),
      }),
    onSuccess: (result) => {
      setRevision(result.revision);
      if (result.revision.kind === "text-node") setSavedText(result.revision.after);
      setNotice(`Saved ${result.revision.path} to disk. The selection will follow HMR.`);
      refreshHistory();
      refreshWorkflow();
      if (selected) resolveMutation.mutate(selected);
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const transactionMutation = useMutation({
    mutationFn: (edits: Array<{ candidate: LiveDesignSourceCandidate; replacement: string }>) =>
      glimmerApi.applyLiveDesignTransaction(sessionId, {
        edits,
        ...(activeChangeSet ? { changeSetId: activeChangeSet.id } : {}),
      }),
    onSuccess: (result, edits) => {
      setRevision(result.revision);
      setNotice(
        `Saved ${result.revision.changeCount ?? 0} style changes to ${result.revision.path}.`,
      );
      const savedProperties = new Set(edits.map((edit) => edit.candidate.property));
      setOriginalDraft((current) => {
        if (!current || !draft) return current;
        const saved = Object.fromEntries(
          SOURCE_STYLE_BINDINGS.filter((binding) => savedProperties.has(binding.property)).map(
            (binding) => [binding.key, draft[binding.key]],
          ),
        ) as Partial<EditorDraft>;
        return { ...current, ...saved };
      });
      refreshHistory();
      refreshWorkflow();
      if (selected) resolveMutation.mutate(selected);
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const structureMutation = useMutation({
    mutationFn: (operation: LiveDesignStructureOperationRequest) =>
      glimmerApi.applyLiveDesignStructure(sessionId, {
        ...operation,
        ...(activeChangeSet ? { changeSetId: activeChangeSet.id } : {}),
      }),
    onSuccess: (result) => {
      setRevision(result.revision);
      setPendingStructure(null);
      setNotice(`Saved the staged structure to ${result.revision.path}.`);
      refreshHistory();
      refreshWorkflow();
      window.setTimeout(() => setReloadKey((current) => current + 1), 150);
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const responsiveMutation = useMutation({
    mutationFn: (source: LiveDesignSourceCandidate) => {
      if (!selected) throw new Error("Select an element before saving a responsive override.");
      return glimmerApi.applyLiveDesignResponsiveOverride(sessionId, {
        element: selected,
        source,
        breakpoint: responsiveBreakpoint,
        property: responsiveProperty,
        value: responsiveValue,
        ...(activeChangeSet ? { changeSetId: activeChangeSet.id } : {}),
      });
    },
    onSuccess: (result) => {
      setRevision(result.revision);
      setResponsivePreviewed(false);
      setResponsiveOverrides((current) => ({
        ...current,
        [`${responsiveBreakpoint}:${responsiveProperty}`]: responsiveValue,
      }));
      setNotice(`Saved the ${responsiveBreakpoint} override to ${result.revision.path}.`);
      refreshHistory();
      refreshWorkflow();
      window.setTimeout(() => setReloadKey((current) => current + 1), 150);
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const styleOverrideMutation = useMutation({
    mutationFn: ({
      source,
      declarations,
    }: {
      source: LiveDesignSourceCandidate;
      declarations: Partial<Record<LiveDesignStyleProperty, string>>;
    }) => {
      if (!selected) throw new Error("Select an element before saving layout changes.");
      return glimmerApi.applyLiveDesignStyleOverride(sessionId, {
        element: selected,
        source,
        scope: styleScope,
        ...(styleScope === "component" && selectedClass ? { className: selectedClass } : {}),
        declarations,
        ...(activeChangeSet ? { changeSetId: activeChangeSet.id } : {}),
      });
    },
    onSuccess: (result) => {
      setRevision(result.revision);
      setStyleRulePreviewed(false);
      setResizeMode(false);
      setNotice(`Saved ${result.revision.changeCount ?? 1} layout rules for ${result.selector}.`);
      refreshHistory();
      refreshWorkflow();
      window.setTimeout(() => setReloadKey((current) => current + 1), 150);
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const rollbackMutation = useMutation({
    mutationFn: (revisionId: string) => glimmerApi.rollbackLiveDesignEdit(sessionId, revisionId),
    onSuccess: (result) => {
      setRevision(result.revision);
      if (result.revision.kind === "text-node") setSavedText(null);
      setNotice(`Rolled back ${result.revision.path}.`);
      refreshHistory();
      refreshWorkflow();
      if (selected) resolveMutation.mutate(selected);
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const installMutation = useMutation({
    mutationFn: (input: { scriptUrl: string; parentOrigin: string }) =>
      glimmerApi.installLiveDesignBridge(sessionId, input),
    onSuccess: (result) => {
      setRevision(result.revision);
      setNotice(`Installed the dev-only bridge in ${result.path}. Reloading the preview…`);
      refreshHistory();
      window.setTimeout(() => setReloadKey((current) => current + 1), 150);
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const feedbackMutation = useMutation({
    mutationFn: async ({
      update,
      refs,
    }: {
      update: DesignFeedbackUpdate;
      refs?: Partial<DesignChangeSetFeedbackRefs>;
    }) => {
      const document = await glimmerApi.saveDesignFeedback(sessionId, update);
      if (!activeChangeSet || !refs || !workflow.data) return { document };
      try {
        const nextWorkflow = await glimmerApi.linkDesignWorkflowFeedback(
          sessionId,
          activeChangeSet.id,
          { expectedRevision: workflow.data.revision, refs },
        );
        return { document, workflow: nextWorkflow };
      } catch (error) {
        try {
          if (!(error instanceof Error) || !error.message.includes("refresh")) throw error;
          const latest = await glimmerApi.getDesignWorkflow(sessionId);
          if (latest.activeChangeSetId !== activeChangeSet.id) throw error;
          const nextWorkflow = await glimmerApi.linkDesignWorkflowFeedback(
            sessionId,
            activeChangeSet.id,
            { expectedRevision: latest.revision, refs },
          );
          return { document, workflow: nextWorkflow };
        } catch (linkError) {
          return {
            document,
            linkError:
              linkError instanceof Error ? linkError.message : "workflow link could not be saved",
          };
        }
      }
    },
    onSuccess: (result) => {
      queryClient.setQueryData(["design-feedback", sessionId], result.document);
      if (result.workflow) setWorkflow(result.workflow);
      if (result.linkError) {
        setNotice(`Feedback was saved. Refresh the workflow link: ${result.linkError}`);
        refreshWorkflow();
      } else {
        setNotice("Saved as structured Glimmer design work.");
      }
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const createWorkflowMutation = useMutation({
    mutationFn: (input: Omit<DesignChangeSetCreateRequest, "expectedRevision">) =>
      glimmerApi.createDesignChangeSet(sessionId, {
        ...input,
        expectedRevision: workflow.data?.revision ?? 0,
      }),
    onSuccess: (document) => {
      setWorkflow(document);
      setNotice("Workflow started and saved to disk.");
    },
    onError: (error: Error) => setWorkflowError(error.message),
  });
  const activateWorkflowMutation = useMutation({
    mutationFn: (changeSetId: string) =>
      glimmerApi.activateDesignChangeSet(sessionId, changeSetId, {
        expectedRevision: workflow.data?.revision ?? 0,
      }),
    onSuccess: setWorkflow,
    onError: (error: Error) => setWorkflowError(error.message),
  });
  const transitionWorkflowMutation = useMutation({
    mutationFn: ({ action, note }: { action: DesignWorkflowTransitionAction; note?: string }) => {
      if (!activeChangeSet) throw new Error("No active change set.");
      return glimmerApi.transitionDesignChangeSet(sessionId, activeChangeSet.id, {
        expectedRevision: workflow.data?.revision ?? 0,
        action,
        ...(note ? { note } : {}),
      });
    },
    onSuccess: (document) => {
      setWorkflow(document);
      setNotice("Workflow decision saved.");
    },
    onError: (error: Error) => setWorkflowError(error.message),
  });
  const verifyWorkflowMutation = useMutation({
    mutationFn: () => {
      if (!activeChangeSet) throw new Error("No active change set.");
      return glimmerApi.verifyDesignChangeSet(sessionId, activeChangeSet.id, {
        expectedRevision: workflow.data?.revision ?? 0,
      });
    },
    onSuccess: (document) => {
      setWorkflow(document);
      if (activeChangeSet) {
        void queryClient.invalidateQueries({
          queryKey: ["visual-regression", sessionId, activeChangeSet.id],
        });
      }
      setNotice(
        document.changeSets.find((item) => item.id === document.activeChangeSetId)?.verification
          .regressionStatus === "failed"
          ? "Visual regression gate blocked delivery. Review the screenshot diff."
          : "Viewport evidence and screenshot regression results attached to the change set.",
      );
    },
    onError: (error: Error) => setWorkflowError(error.message),
  });
  const captureBaselineMutation = useMutation({
    mutationFn: () => {
      if (!activeChangeSet) throw new Error("No active change set.");
      return glimmerApi.captureVisualRegressionBaseline(sessionId, activeChangeSet.id);
    },
    onSuccess: (evidence) => {
      queryClient.setQueryData(["visual-regression", sessionId, activeChangeSet?.id], evidence);
      setNotice("Locked the current viewport captures as this change set's visual baseline.");
    },
    onError: (error: Error) => setWorkflowError(error.message),
  });
  const compareRegressionMutation = useMutation({
    mutationFn: () => {
      if (!activeChangeSet) throw new Error("No active change set.");
      return glimmerApi.compareVisualRegression(sessionId, activeChangeSet.id);
    },
    onSuccess: (evidence) => {
      queryClient.setQueryData(["visual-regression", sessionId, activeChangeSet?.id], evidence);
      setNotice(
        evidence.report?.status === "failed"
          ? "Screenshot difference exceeds the visual regression threshold."
          : "Latest viewport captures stay within the visual regression threshold.",
      );
    },
    onError: (error: Error) => setWorkflowError(error.message),
  });
  const rollbackWorkflowMutation = useMutation({
    mutationFn: () => {
      if (!activeChangeSet) throw new Error("No active change set.");
      return glimmerApi.rollbackDesignChangeSet(sessionId, activeChangeSet.id, {
        expectedRevision: workflow.data?.revision ?? 0,
      });
    },
    onSuccess: (result) => {
      setWorkflow(result.workflow);
      refreshHistory();
      setRevision(null);
      setNotice(`Rolled back ${result.rolledBackRevisionIds.length} source revision(s).`);
    },
    onError: (error: Error) => {
      setWorkflowError(error.message);
      refreshWorkflow();
      refreshHistory();
    },
  });

  const post = useCallback(
    (type: string, payload: Record<string, unknown> = {}) => {
      if (!target || !iframe.current?.contentWindow) return;
      iframe.current.contentWindow.postMessage(
        { namespace: BRIDGE_NAMESPACE, channel: channel.current, type, ...payload },
        target.origin,
      );
    },
    [target],
  );
  const initialize = useCallback(() => post("init"), [post]);
  const stopCanvasTools = useCallback(() => {
    post("cancel-select");
    post("enable-resize", { enabled: false });
    setSelecting(false);
    setResizeMode(false);
    setAnnotating(false);
    setAnnotationPoints([]);
  }, [post]);
  const toggleSelectionTool = useCallback(() => {
    if (selecting) {
      post("cancel-select");
      setSelecting(false);
      return;
    }
    setAnnotating(false);
    setAnnotationPoints([]);
    setResizeMode(false);
    post("enable-resize", { enabled: false });
    post("select");
  }, [post, selecting]);
  const toggleResizeTool = useCallback(() => {
    if (!selected) return;
    const enabled = !resizeMode;
    post("cancel-select");
    setSelecting(false);
    setAnnotating(false);
    setAnnotationPoints([]);
    setActiveTab("layout");
    setResizeMode(enabled);
    post("enable-resize", { enabled });
  }, [post, resizeMode, selected]);
  const toggleAnnotationTool = useCallback(
    (tool: (typeof LIVE_ANNOTATION_TOOLS)[number]["id"]) => {
      post("cancel-select");
      post("enable-resize", { enabled: false });
      setSelecting(false);
      setResizeMode(false);
      if (annotating && annotationTool === tool) {
        setAnnotating(false);
        setAnnotationPoints([]);
        return;
      }
      setAnnotationTool(tool);
      setAnnotationPoints([]);
      setAnnotating(true);
    },
    [annotating, annotationTool, post],
  );
  const openStructureTool = useCallback(() => {
    stopCanvasTools();
    setPreviewMode(false);
    setActiveTab("structure");
    post("request-structure");
  }, [post, stopCanvasTools]);
  const togglePreviewMode = useCallback(() => {
    stopCanvasTools();
    setShowShortcuts(false);
    setPreviewMode((current) => !current);
  }, [stopCanvasTools]);
  const requestReselect = useCallback(() => {
    if (!selectedSelector.current) return;
    if (reselectTimer.current !== null) window.clearTimeout(reselectTimer.current);
    reselectTimer.current = window.setTimeout(() => {
      post("describe-selector", { selector: selectedSelector.current });
      reselectTimer.current = null;
    }, 220);
  }, [post]);

  useEffect(() => {
    if (!target) return;
    setConnection("connecting");
    let attempts = 0;
    handshakeTimer.current = window.setInterval(() => {
      attempts += 1;
      initialize();
      if (attempts >= 12) {
        if (handshakeTimer.current !== null) window.clearInterval(handshakeTimer.current);
        handshakeTimer.current = null;
        setConnection((current) => (current === "ready" ? current : "missing"));
      }
    }, 350);
    initialize();
    return () => {
      if (handshakeTimer.current !== null) window.clearInterval(handshakeTimer.current);
      handshakeTimer.current = null;
    };
  }, [initialize, reloadKey, target]);

  useEffect(
    () => () => {
      if (reselectTimer.current !== null) window.clearTimeout(reselectTimer.current);
      if (journalTimer.current !== null) window.clearTimeout(journalTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!journal.isFetched || journalHydrated.current) return;
    journalHydrated.current = true;
    const saved = journal.data;
    if (!saved || saved.version !== 1 || saved.sessionId !== sessionId || saved.route !== route) {
      return;
    }
    journalSequence.current = saved.sequence;
    journalSelectedSelectors.current = saved.selectedSelectors;
    setActiveTab(
      INSPECTOR_TABS.some((tab) => tab.id === saved.activeTab)
        ? (saved.activeTab as InspectorTab)
        : "content",
    );
    if (VIEWPORTS.some((viewport) => viewport.id === saved.viewportId)) {
      setViewportId(saved.viewportId as (typeof VIEWPORTS)[number]["id"]);
    }
    setZoom(saved.zoom);
    setInspectorWidth(saved.inspectorWidth);
    setElementPrompt(saved.elementPrompt);
    setAnnotationComment(saved.annotationComment);
    if (LIVE_ANNOTATION_TOOLS.some((tool) => tool.id === saved.annotationTool)) {
      setAnnotationTool(saved.annotationTool as (typeof LIVE_ANNOTATION_TOOLS)[number]["id"]);
    }
    setAnnotationPoints(saved.annotationPoints);
    setAnnotating(saved.annotating === true && Boolean(capture?.screenshot));
    setAssetPrompt(saved.assetPrompt ?? "");
    setAssetPath(saved.assetPath ?? "public/generated/live-design.png");
    setPreviewMode(saved.previewMode === true);
    setResizeMode(saved.resizeMode === true);
    setResponsiveBreakpoint(saved.responsiveBreakpoint);
    setResponsiveProperty(saved.responsiveProperty);
    setResponsiveValue(saved.responsiveValue);
    setResponsiveOverrides(saved.responsiveOverrides ?? {});
    setResponsivePreviewed(saved.responsivePreviewed === true);
    setStyleScope(saved.styleScope);
    setSelectedClass(saved.selectedClass ?? "");
    setTextCandidateId(saved.textCandidateId ?? "");
    setTokenCandidateId(saved.tokenCandidateId ?? "");
    setTokenReplacement(saved.tokenReplacement ?? "");
    setTokenBindingProperty(saved.tokenBindingProperty ?? "color");
    setLockedSelectors(new Set(saved.lockedSelectors ?? []));
    setHiddenSelectors(new Set(saved.hiddenSelectors ?? []));
    setProposal(saved.proposal ?? null);
    setProposalDecision(saved.proposal ? "previewing" : null);
    setPendingStructure(saved.pendingStructure ?? null);
    recoveredDraft.current = editorDraftFromJournal(saved.draft);
    recoveredOriginalDraft.current = editorDraftFromJournal(saved.originalDraft);
    if (saved.selectedSelector) {
      selectedSelector.current = saved.selectedSelector;
      if (connection === "ready") post("describe-selector", { selector: saved.selectedSelector });
    }
    setJournalSavedAt(saved.updatedAt);
    setNotice("Recovered unsaved Live Design progress from the continuous journal.");
  }, [capture?.screenshot, connection, journal.data, journal.isFetched, post, route, sessionId]);

  useEffect(() => {
    if (connection !== "ready" || !pendingStructure) return;
    const operation =
      pendingStructure.kind === "insert"
        ? {
            kind: pendingStructure.kind,
            targetSelector: pendingStructure.target.selector,
            placement: pendingStructure.placement,
            preset: pendingStructure.preset,
            text: pendingStructure.text,
          }
        : pendingStructure.kind === "reorder"
          ? {
              kind: pendingStructure.kind,
              movingSelector: pendingStructure.moving.selector,
              targetSelector: pendingStructure.anchor.selector,
              placement: pendingStructure.placement,
            }
          : {
              kind: pendingStructure.kind,
              movingSelector: pendingStructure.moving.selector,
              targetSelector: pendingStructure.target.selector,
              placement: pendingStructure.placement,
            };
    post("preview-structure", { operation });
  }, [connection, pendingStructure, post]);

  useEffect(() => {
    if (!target) return;
    function onMessage(event: MessageEvent) {
      if (
        event.source !== iframe.current?.contentWindow ||
        event.origin !== target!.origin ||
        !event.data ||
        event.data.namespace !== BRIDGE_NAMESPACE ||
        event.data.channel !== channel.current
      ) {
        return;
      }
      if (event.data.type === "ready") {
        if (handshakeTimer.current !== null) window.clearInterval(handshakeTimer.current);
        handshakeTimer.current = null;
        setConnection("ready");
        setNotice("");
        post("request-structure");
        requestReselect();
      } else if (event.data.type === "dom-updated") {
        post("request-structure");
        requestReselect();
      } else if (event.data.type === "structure") {
        const snapshot = normalizeStructureMessage(event.data);
        if (snapshot) setStructure(snapshot);
      } else if (event.data.type === "structure-preview-applied") {
        setNotice("Structure staged in the live preview. Save it to make it durable.");
      } else if (event.data.type === "responsive-preview-applied") {
        setResponsivePreviewed(true);
        setNotice("Responsive override staged in the selected viewport.");
      } else if (event.data.type === "style-rule-preview-applied") {
        setStyleRulePreviewed(true);
        setNotice("Component-scope layout staged across matching instances.");
      } else if (event.data.type === "resize-mode") {
        setResizeMode(event.data.enabled === true);
      } else if (
        event.data.type === "resize-change" &&
        event.data.selector === selectedSelector.current &&
        typeof event.data.width === "string" &&
        /^\d{1,4}px$/.test(event.data.width) &&
        typeof event.data.height === "string" &&
        /^\d{1,4}px$/.test(event.data.height)
      ) {
        setActiveTab("layout");
        setDraft((current) =>
          current
            ? {
                ...current,
                width: event.data.width,
                height: event.data.height,
                boxSizing: "border-box",
              }
            : current,
        );
      } else if (
        event.data.type === "move-change" &&
        event.data.selector === selectedSelector.current &&
        typeof event.data.position === "string" &&
        ["relative", "absolute", "fixed", "sticky"].includes(event.data.position) &&
        typeof event.data.left === "string" &&
        /^-?\d{1,4}px$/.test(event.data.left) &&
        typeof event.data.top === "string" &&
        /^-?\d{1,4}px$/.test(event.data.top)
      ) {
        setActiveTab("layout");
        setDraft((current) =>
          current
            ? {
                ...current,
                position: event.data.position,
                left: event.data.left,
                top: event.data.top,
              }
            : current,
        );
        if (event.data.snappedX || event.data.snappedY) {
          setNotice("Move snapped to the canvas center guide.");
        }
      } else if (event.data.type === "selection-stale") {
        setNotice("The selected element changed during HMR. Select it again to continue.");
      } else if (event.data.type === "selection-enabled") {
        setSelecting(true);
      } else if (event.data.type === "selection-cancelled") {
        setSelecting(false);
      } else if (event.data.type === "preview-error" && typeof event.data.error === "string") {
        setNotice(event.data.error);
      } else if (event.data.type === "selection-many" && Array.isArray(event.data.elements)) {
        const elements = event.data.elements
          .slice(0, 50)
          .map((value: unknown) => normalizeElementMessage(value))
          .filter((element: LiveDesignElement | null): element is LiveDesignElement =>
            Boolean(element),
          );
        if (elements.length) setSelectedElements(elements);
      } else if (event.data.type === "selected") {
        const element = normalizeElementMessage(event.data.element);
        if (!element) {
          setNotice("The preview returned invalid element metadata.");
          return;
        }
        const recovered =
          event.data.reselected && selectedSelector.current === element.selector
            ? recoveredDraft.current
            : null;
        const recoveredOriginal = recovered ? recoveredOriginalDraft.current : null;
        const nextDraft = recovered ?? draftFor(element);
        const nextOriginalDraft = recoveredOriginal ?? draftFor(element);
        recoveredDraft.current = null;
        recoveredOriginalDraft.current = null;
        const additive = event.data.additive === true;
        selectedSelector.current = element.selector;
        setSelected(element);
        setSelectedElements((current) => {
          if (!additive) {
            journalSelectedSelectors.current = [element.selector];
            return [element];
          }
          const withoutCurrent = current.filter((item) => item.selector !== element.selector);
          const next = [...withoutCurrent, element].slice(-50);
          journalSelectedSelectors.current = next.map((item) => item.selector);
          return next;
        });
        setDraft(nextDraft);
        setOriginalDraft(nextOriginalDraft);
        setSelecting(additive);
        setResolution(null);
        const classes = (element.attributes.class ?? "")
          .split(/\s+/)
          .filter((className) => /^[A-Za-z0-9_-]{1,100}$/.test(className));
        setSelectedClass((current) => (classes.includes(current) ? current : (classes[0] ?? "")));
        if (!event.data.reselected) {
          setProposal(null);
          setProposalDecision(null);
          setTextCandidateId("");
          setTokenCandidateId("");
          setTokenReplacement("");
        }
        setNotice(event.data.reselected ? "Selection restored after preview update." : "");
        resolveMutation.mutate(element);
        if (event.data.reselected && journalSelectedSelectors.current.length > 1) {
          window.setTimeout(
            () => post("describe-many", { selectors: journalSelectedSelectors.current }),
            40,
          );
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post, requestReselect, resolveMutation, target]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const root = designerRoot.current;
      if (!root || (!designerHovered.current && !root.contains(document.activeElement))) return;
      const eventTarget = event.target;
      if (
        eventTarget instanceof HTMLElement &&
        (eventTarget.matches("input, textarea, select, [contenteditable='true']") ||
          eventTarget.closest("input, textarea, select, [contenteditable='true']"))
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
        event.preventDefault();
        setShowShortcuts((current) => !current);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        stopCanvasTools();
        setPreviewMode(false);
        setShowShortcuts(false);
        return;
      }
      if (key === "v") {
        event.preventDefault();
        toggleSelectionTool();
        return;
      }
      if (key === "r") {
        event.preventDefault();
        toggleResizeTool();
        return;
      }
      if (key === "c") {
        event.preventDefault();
        toggleAnnotationTool("comment");
        return;
      }
      if (key === "z") {
        event.preventDefault();
        openStructureTool();
        return;
      }
      if (key === "p") {
        event.preventDefault();
        togglePreviewMode();
        return;
      }
      const viewportShortcut =
        key === "0"
          ? "auto"
          : key === "1"
            ? "desktop"
            : key === "2"
              ? "tablet"
              : key === "3"
                ? "mobile"
                : null;
      if (viewportShortcut) {
        event.preventDefault();
        setViewportId(viewportShortcut);
        return;
      }
      const direction: HierarchyDirection | null =
        event.key === "ArrowUp"
          ? "parent"
          : event.key === "ArrowDown"
            ? "child"
            : event.key === "ArrowLeft"
              ? "previous"
              : event.key === "ArrowRight"
                ? "next"
                : null;
      if (!direction || !selected) return;
      const selector = hierarchyNeighbor(structure, selected.selector, direction);
      if (!selector) return;
      event.preventDefault();
      post("describe-selector", { selector });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    openStructureTool,
    post,
    selected,
    stopCanvasTools,
    structure,
    toggleAnnotationTool,
    togglePreviewMode,
    toggleResizeTool,
    toggleSelectionTool,
  ]);

  useEffect(() => {
    if (connection !== "ready") return;
    post("highlight-many", {
      selectors: selectedElements.map((element) => element.selector),
    });
  }, [connection, post, selectedElements]);

  useEffect(() => {
    if (!journalHydrated.current || !target) return;
    journalSequence.current += 1;
    const update: LiveDesignDraftUpdate = {
      route,
      sequence: journalSequence.current,
      ...(selected?.selector || selectedSelector.current
        ? { selectedSelector: selected?.selector ?? selectedSelector.current }
        : {}),
      selectedSelectors:
        selectedElements.length > 0
          ? selectedElements.map((element) => element.selector)
          : journalSelectedSelectors.current,
      lockedSelectors: [...lockedSelectors],
      hiddenSelectors: [...hiddenSelectors],
      activeTab,
      viewportId,
      zoom,
      inspectorWidth,
      elementPrompt,
      annotationComment,
      annotationTool,
      annotationPoints,
      annotating,
      assetPrompt,
      assetPath,
      previewMode,
      resizeMode,
      responsiveBreakpoint,
      responsiveProperty,
      responsiveValue,
      responsiveOverrides,
      responsivePreviewed,
      styleScope,
      ...(selectedClass ? { selectedClass } : {}),
      ...(textCandidateId ? { textCandidateId } : {}),
      ...(tokenCandidateId ? { tokenCandidateId } : {}),
      ...(tokenReplacement ? { tokenReplacement } : {}),
      ...(tokenBindingProperty ? { tokenBindingProperty } : {}),
      ...(draft ? { draft } : {}),
      ...(originalDraft ? { originalDraft } : {}),
      ...(pendingStructure ? { pendingStructure } : {}),
      ...(proposal ? { proposal } : {}),
    };
    latestJournalUpdate.current = update;
    try {
      window.localStorage?.setItem(
        `glimmer.live-design-draft.${sessionId}`,
        JSON.stringify({
          version: 1,
          sessionId,
          updatedAt: new Date().toISOString(),
          ...update,
        } satisfies LiveDesignDraftJournal),
      );
    } catch {
      // The disk journal still runs when local storage is unavailable.
    }
    if (journalTimer.current !== null) window.clearTimeout(journalTimer.current);
    journalTimer.current = window.setTimeout(() => {
      journalTimer.current = null;
      saveJournalRef.current(update);
    }, 300);
    return () => {
      if (journalTimer.current !== null) window.clearTimeout(journalTimer.current);
    };
  }, [
    activeTab,
    annotationComment,
    annotationPoints,
    annotationTool,
    annotating,
    assetPath,
    assetPrompt,
    draft,
    elementPrompt,
    hiddenSelectors,
    inspectorWidth,
    lockedSelectors,
    originalDraft,
    pendingStructure,
    previewMode,
    proposal,
    responsiveBreakpoint,
    responsiveProperty,
    responsiveValue,
    responsiveOverrides,
    responsivePreviewed,
    resizeMode,
    route,
    selected,
    selectedClass,
    selectedElements,
    sessionId,
    styleScope,
    target,
    textCandidateId,
    tokenBindingProperty,
    tokenCandidateId,
    tokenReplacement,
    viewportId,
    zoom,
  ]);

  useEffect(() => {
    const flush = () => {
      if (document.visibilityState !== "hidden" || !latestJournalUpdate.current) return;
      saveJournalRef.current(latestJournalUpdate.current);
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, []);

  useEffect(() => {
    if (connection !== "ready") return;
    for (const selector of hiddenSelectors) {
      post("set-preview-visibility", { selector, hidden: true });
    }
  }, [connection, hiddenSelectors, post]);

  useEffect(() => {
    if (connection !== "ready") return;
    post("enable-resize", { enabled: resizeMode && Boolean(selected) });
  }, [connection, post, resizeMode, selected]);

  useEffect(() => {
    if (connection !== "ready" || !selected || !responsivePreviewed || !responsiveValue.trim()) {
      return;
    }
    post("preview-responsive", {
      override: {
        selector: responsivePreviewSelector(selected),
        breakpoint: responsiveBreakpoint,
        property: responsiveProperty,
        value: responsiveValue.trim(),
      },
    });
  }, [
    connection,
    post,
    responsiveBreakpoint,
    responsivePreviewed,
    responsiveProperty,
    responsiveValue,
    selected,
  ]);

  useEffect(() => {
    if (!selected || !draft || !originalDraft || connection !== "ready") return;
    const patch = previewPatch(draft, originalDraft);
    post("reset-preview", { selector: selected.selector });
    if (Object.keys(patch).length) post("preview", { selector: selected.selector, patch });
  }, [connection, draft, originalDraft, post, selected]);

  useEffect(() => {
    if (!selected) return;
    const definition = RESPONSIVE_PROPERTIES.find((item) => item.id === responsiveProperty);
    if (definition) setResponsiveValue(selected.styles[definition.styleKey]);
    setResponsivePreviewed(false);
  }, [responsiveProperty, selected]);

  const textCandidates = resolution?.candidates.filter((item) => item.kind === "text-node") ?? [];
  const tokenCandidates = resolution?.candidates.filter((item) => item.kind === "css-token") ?? [];
  const textCandidate = textCandidates.find((item) => item.id === textCandidateId);
  const tokenCandidate = tokenCandidates.find((item) => item.id === tokenCandidateId);
  const responsiveSource =
    resolution?.candidates.find(
      (item) =>
        item.confidence === "exact" &&
        /\.(?:css|scss|less|vue|svelte)$/i.test(item.path) &&
        item.kind === "css-declaration",
    ) ??
    resolution?.candidates.find(
      (item) => item.confidence === "exact" && /\.(?:css|scss|less|vue|svelte)$/i.test(item.path),
    );
  const styleSourceEdits =
    draft && originalDraft ? sourceStyleEdits(draft, originalDraft, resolution) : [];
  const layoutChanges = useMemo(
    () => (draft && originalDraft ? layoutDeclarations(draft, originalDraft) : {}),
    [draft, originalDraft],
  );
  const currentStyleScopeSelector = useMemo(
    () => (selected ? styleScopeSelector(selected, styleScope, selectedClass) : null),
    [selected, selectedClass, styleScope],
  );
  const selectedClasses = useMemo(
    () =>
      (selected?.attributes.class ?? "")
        .split(/\s+/)
        .filter((className) => /^[A-Za-z0-9_-]{1,100}$/.test(className)),
    [selected],
  );
  const matchingInstanceCount = matchingStructureNodes(structure, currentStyleScopeSelector);

  useEffect(() => {
    if (
      connection !== "ready" ||
      (activeTab !== "layout" && activeTab !== "component") ||
      !currentStyleScopeSelector ||
      !Object.keys(layoutChanges).length
    ) {
      post("reset-style-rule-preview");
      setStyleRulePreviewed(false);
      return;
    }
    post("preview-style-rule", {
      rule: { selector: currentStyleScopeSelector, declarations: layoutChanges },
    });
  }, [activeTab, connection, currentStyleScopeSelector, layoutChanges, post]);

  function resetPreview() {
    if (!selected || !originalDraft) return;
    post("reset-preview", { selector: selected.selector });
    setDraft(originalDraft);
    setNotice("Preview reset to the selected element's saved state.");
  }
  function toggleStructureLock(selector: string) {
    setLockedSelectors((current) => {
      const next = new Set(current);
      if (next.has(selector)) next.delete(selector);
      else next.add(selector);
      return next;
    });
  }
  function toggleStructureVisibility(selector: string) {
    const hidden = !hiddenSelectors.has(selector);
    post("set-preview-visibility", { selector, hidden });
    setHiddenSelectors((current) => {
      const next = new Set(current);
      if (hidden) next.add(selector);
      else next.delete(selector);
      return next;
    });
    setNotice(
      hidden
        ? "Element hidden in preview only. Save display: none to make it durable."
        : "Element restored in the live preview.",
    );
  }
  function removeMultiSelection(selector: string) {
    const remaining = selectedElements.filter((element) => element.selector !== selector);
    journalSelectedSelectors.current = remaining.map((element) => element.selector);
    setSelectedElements(remaining);
    if (selected?.selector !== selector) return;
    const next = remaining.at(-1);
    if (next) {
      post("describe-selector", { selector: next.selector });
      return;
    }
    selectedSelector.current = "";
    setSelected(null);
    setDraft(null);
    setOriginalDraft(null);
    setResolution(null);
    setProposal(null);
  }
  function discardUnsavedJournal() {
    if (selected) post("reset-preview", { selector: selected.selector });
    if (originalDraft) setDraft(originalDraft);
    for (const selector of hiddenSelectors) {
      post("set-preview-visibility", { selector, hidden: false });
    }
    setElementPrompt("");
    setAnnotationComment("");
    setAnnotationPoints([]);
    setProposal(null);
    setProposalDecision(null);
    setAnnotating(false);
    setAssetPrompt("");
    setAssetPath("public/generated/live-design.png");
    setPreviewMode(false);
    setResizeMode(false);
    post("enable-resize", { enabled: false });
    setResponsivePreviewed(false);
    post("reset-responsive-preview");
    setTextCandidateId("");
    setTokenCandidateId("");
    setTokenReplacement("");
    setTokenBindingProperty("color");
    post("reset-structure-preview");
    setPendingStructure(null);
    setLockedSelectors(new Set());
    setHiddenSelectors(new Set());
    setJournalSavedAt("");
    setJournalError("");
    window.localStorage?.removeItem(`glimmer.live-design-draft.${sessionId}`);
    void glimmerApi
      .clearLiveDesignDraft(sessionId)
      .then(() => queryClient.setQueryData(["live-design-draft", sessionId], null))
      .catch((error: Error) => setJournalError(error.message));
    setNotice("Unsaved Live Design recovery state was discarded.");
  }
  function stageStructure(operation: LiveDesignStructureOperationRequest) {
    setPendingStructure(operation);
  }
  function cancelStructurePreview() {
    post("reset-structure-preview");
    setPendingStructure(null);
    setNotice("Structure preview cancelled; source was not changed.");
  }
  function previewResponsive() {
    if (!selected || !responsiveValue.trim()) return;
    setViewportId(responsiveBreakpoint);
    post("preview-responsive", {
      override: {
        selector: responsivePreviewSelector(selected),
        breakpoint: responsiveBreakpoint,
        property: responsiveProperty,
        value: responsiveValue.trim(),
      },
    });
  }
  function makeResponsiveValueFluid() {
    const base = Number.parseFloat(responsiveValue);
    if (!Number.isFinite(base) || base <= 0) {
      setNotice("Enter a positive pixel value before generating a fluid clamp().");
      return;
    }
    const minimum = Math.max(1, Math.round(base * 0.75 * 100) / 100);
    const maximum = Math.round(base * 1.25 * 100) / 100;
    const preferred = Math.max(1, Math.round((base / 8) * 100) / 100);
    setResponsiveValue(`clamp(${minimum}px, ${preferred}vw, ${maximum}px)`);
    setNotice("Generated a fluid value. Preview each breakpoint before saving it.");
  }
  function cancelResponsivePreview() {
    post("reset-responsive-preview");
    setResponsivePreviewed(false);
    setNotice("Responsive preview cancelled; source was not changed.");
  }
  function cancelLayoutPreview() {
    post("reset-style-rule-preview");
    if (selected) post("reset-preview", { selector: selected.selector });
    if (originalDraft) setDraft(originalDraft);
    setStyleRulePreviewed(false);
    setResizeMode(false);
    post("enable-resize", { enabled: false });
    setNotice("Layout preview cancelled; source was not changed.");
  }
  function saveText() {
    if (textCandidate && draft)
      applyMutation.mutate({ candidate: textCandidate, replacement: draft.text });
  }
  function saveToken() {
    if (tokenCandidate)
      applyMutation.mutate({ candidate: tokenCandidate, replacement: tokenReplacement });
  }
  function bindTokenToProperty(token: LiveDesignTokenNode) {
    const candidate = chooseCandidate(resolution?.candidates ?? [], tokenBindingProperty);
    if (!candidate) {
      setNotice(`No exact ${tokenBindingProperty} source declaration is available to bind.`);
      return;
    }
    applyMutation.mutate({ candidate, replacement: `var(${token.name})` });
  }
  function queueForGlimmer() {
    if (!selected || !draft || !originalDraft || !capture?.screenshot) return;
    const style = styleFeedback(draft, originalDraft);
    const textPersisted = savedText === draft.text;
    const textChanged = draft.text !== originalDraft.text && !textPersisted;
    const imageChanged = draft.imageSource !== originalDraft.imageSource && draft.imageSource;
    if (!textChanged && !imageChanged && !Object.keys(style).length) {
      setNotice("Change at least one value before saving it for Glimmer.");
      return;
    }
    const sourceCandidate = textCandidate ?? tokenCandidate;
    const edit: DesignElementEdit = {
      id: crypto.randomUUID(),
      target:
        selected.attributes["aria-label"] ||
        selected.text ||
        `${selected.tagName} ${selected.selector}`,
      screenshot: capture.screenshot,
      viewport: capture.viewport,
      state: capture.state ?? "initial",
      region: regionFor(selected),
      selectorHint: selected.selector,
      ...(sourceCandidate ? { sourcePathHint: sourceCandidate.path } : {}),
      ...(textPersisted
        ? { expectedText: draft.text }
        : originalDraft.text
          ? { expectedText: originalDraft.text }
          : {}),
      ...(textChanged ? { text: draft.text } : {}),
      ...(imageChanged ? { imageSource: draft.imageSource } : {}),
      style,
      createdAt: new Date().toISOString(),
    };
    const update = baseFeedback(feedback.data);
    feedbackMutation.mutate({
      update: { ...update, elementEdits: [...update.elementEdits, edit] },
      refs: { elementEditIds: [edit.id] },
    });
  }
  function saveAnnotation() {
    if (!annotationPoints.length || !annotationComment.trim() || !capture?.screenshot) return;
    const annotation: DesignFeedbackAnnotation = {
      id: crypto.randomUUID(),
      screenshot: capture.screenshot,
      viewport: capture.viewport,
      state: capture.state ?? "initial",
      tool: annotationTool,
      points: annotationPoints,
      comment: annotationComment.trim(),
      ...(selected?.selector ? { selectorHint: selected.selector } : {}),
      ...(resolution?.candidates[0]?.path ? { sourcePathHint: resolution.candidates[0].path } : {}),
      createdAt: new Date().toISOString(),
    };
    const update = baseFeedback(feedback.data);
    feedbackMutation.mutate({
      update: { ...update, annotations: [...update.annotations, annotation] },
      refs: { annotationIds: [annotation.id] },
    });
    setAnnotationPoints([]);
    setAnnotationComment("");
    setAnnotating(false);
  }
  function generateElementProposal() {
    if (!selected || !elementPrompt.trim()) return;
    proposalMutation.mutate({ element: selected, prompt: elementPrompt.trim() });
  }
  function acceptElementProposal() {
    if (
      !proposal ||
      !selected ||
      !draft ||
      !originalDraft ||
      !capture?.screenshot ||
      feedbackMutation.isPending
    ) {
      return;
    }
    const region = regionFor(selected);
    const annotation: DesignFeedbackAnnotation = {
      id: crypto.randomUUID(),
      screenshot: capture.screenshot,
      viewport: capture.viewport,
      state: capture.state ?? "initial",
      tool: "comment",
      points: [
        {
          x: region.x + region.width / 2,
          y: region.y + region.height / 2,
        },
      ],
      comment: proposal.prompt,
      selectorHint: selected.selector,
      ...(resolution?.candidates[0]?.path
        ? { sourcePathHint: resolution.candidates[0].path }
        : selected.sourcePathHint
          ? { sourcePathHint: selected.sourcePathHint }
          : {}),
      createdAt: new Date().toISOString(),
    };
    const update = baseFeedback(feedback.data);
    const style = styleFeedback(draft, originalDraft);
    const textChanged = draft.text !== originalDraft.text;
    const imageChanged = draft.imageSource !== originalDraft.imageSource && draft.imageSource;
    const edit: DesignElementEdit | null =
      textChanged || imageChanged || Object.keys(style).length
        ? {
            id: crypto.randomUUID(),
            target:
              selected.attributes["aria-label"] ||
              selected.text ||
              `${selected.tagName} ${selected.selector}`,
            screenshot: capture.screenshot,
            viewport: capture.viewport,
            state: capture.state ?? "initial",
            region,
            selectorHint: selected.selector,
            ...(resolution?.candidates[0]?.path
              ? { sourcePathHint: resolution.candidates[0].path }
              : {}),
            ...(originalDraft.text ? { expectedText: originalDraft.text } : {}),
            ...(textChanged ? { text: draft.text } : {}),
            ...(imageChanged ? { imageSource: draft.imageSource } : {}),
            style,
            createdAt: new Date().toISOString(),
          }
        : null;
    feedbackMutation.mutate({
      update: {
        ...update,
        annotations: [...update.annotations, annotation],
        elementEdits: edit ? [...update.elementEdits, edit] : update.elementEdits,
      },
      refs: {
        annotationIds: [annotation.id],
        ...(edit ? { elementEditIds: [edit.id] } : {}),
      },
    });
    setProposalDecision("accepted");
  }
  function rejectElementProposal() {
    if (selected) post("reset-preview", { selector: selected.selector });
    if (originalDraft) setDraft(originalDraft);
    setProposal(null);
    setProposalDecision(null);
    setNotice("Proposal rejected; the canvas returned to its saved state.");
  }
  function queueVariants() {
    if (!selected || !capture?.screenshot) return;
    const variant: DesignVariantRequest = {
      id: crypto.randomUUID(),
      target: selected.componentName || selected.text || selected.selector,
      count: 3,
      directions: VARIANT_PRESETS.map((preset) => `${preset.name}: ${preset.description}`),
      screenshot: capture.screenshot,
      region: regionFor(selected),
    };
    const update = baseFeedback(feedback.data);
    feedbackMutation.mutate({
      update: { ...update, variants: [...update.variants, variant] },
      refs: { variantIds: [variant.id] },
    });
  }
  function queueAsset() {
    if (!assetPrompt.trim() || !assetPath.trim()) return;
    const asset: DesignAssetRequest = {
      id: crypto.randomUUID(),
      kind: "image",
      prompt: assetPrompt.trim(),
      outputPath: assetPath.trim(),
      aspectRatio: "16:9",
      size: "2K",
      referenceImages: [],
      referenceUploadPolicy: "local-only",
      ...(capture?.screenshot ? { screenshot: capture.screenshot } : {}),
      createdAt: new Date().toISOString(),
    };
    const update = baseFeedback(feedback.data);
    feedbackMutation.mutate({
      update: { ...update, assetRequests: [...update.assetRequests, asset] },
      refs: { assetRequestIds: [asset.id] },
    });
    setAssetPrompt("");
  }
  function queueCmsBinding(reference: LiveDesignCmsReference) {
    if (!selected || !capture?.screenshot) return;
    const region = regionFor(selected);
    const annotation: DesignFeedbackAnnotation = {
      id: crypto.randomUUID(),
      screenshot: capture.screenshot,
      viewport: capture.viewport,
      state: capture.state ?? "initial",
      tool: "comment",
      points: [{ x: region.x + region.width / 2, y: region.y + region.height / 2 }],
      comment: `Bind this content to CMS field “${reference.field}” from ${reference.path}. Preserve localization and fallback behavior.`,
      selectorHint: selected.selector,
      sourcePathHint: reference.path,
      createdAt: new Date().toISOString(),
    };
    const update = baseFeedback(feedback.data);
    feedbackMutation.mutate({
      update: { ...update, annotations: [...update.annotations, annotation] },
      refs: { annotationIds: [annotation.id] },
    });
  }

  if (!target) {
    return (
      <div className="live-design-bridge live-design-bridge--unavailable">
        <h3>Live editor unavailable</h3>
        <p>Live editing only embeds local HTTP previews on localhost or 127.0.0.1.</p>
      </div>
    );
  }

  const rawParentOrigin = window.location.origin;
  const parentOrigin =
    rawParentOrigin === "null" ||
    !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(rawParentOrigin)
      ? "http://127.0.0.1:5183"
      : rawParentOrigin;
  const bridgeClientUrl = glimmerApi.liveDesignBridgeClientUrl();
  const installSnippet = `<script data-glimmer-dev-only="true">if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname)) { const bridge = document.createElement("script"); bridge.src = ${JSON.stringify(bridgeClientUrl)}; bridge.dataset.glimmerParent = ${JSON.stringify(parentOrigin)}; document.head.appendChild(bridge); }</script>`;
  const viewport = VIEWPORTS.find((item) => item.id === viewportId) ?? VIEWPORTS[0];
  const workflowAllowsSource =
    !activeChangeSet || ["approved", "implementing"].includes(activeChangeSet.status);
  const directApply = Boolean(resolution?.directApplyAllowed) && workflowAllowsSource;
  const draftAuditFindings = draft && originalDraft ? auditDraft(draft) : [];
  const reviewFindings = [
    ...draftAuditFindings,
    ...(resolution?.auditFindings ?? []).filter(
      (finding) => !draftAuditFindings.some((draftFinding) => draftFinding.id === finding.id),
    ),
  ];
  const blockingDraftFinding = draftAuditFindings.find((finding) => finding.severity === "error");
  const layoutSaveBlocker = blockingDraftFinding
    ? blockingDraftFinding.suggestion
    : !Object.keys(layoutChanges).length
      ? "Change at least one layout value before saving."
      : !styleRulePreviewed
        ? "Wait for the live component preview before saving."
        : !currentStyleScopeSelector
          ? "Choose an element with a stable selector before saving."
          : !responsiveSource
            ? "No exact stylesheet binding is available for this element."
            : !directApply
              ? "The current branch or design workflow has not approved source changes."
              : styleOverrideMutation.isPending
                ? "The layout change is already being saved."
                : null;
  const workflowBusy =
    createWorkflowMutation.isPending ||
    activateWorkflowMutation.isPending ||
    transitionWorkflowMutation.isPending ||
    verifyWorkflowMutation.isPending ||
    rollbackWorkflowMutation.isPending ||
    captureBaselineMutation.isPending ||
    compareRegressionMutation.isPending;
  const annotationReady =
    annotationPoints.length > 0 &&
    (!["rectangle", "ellipse", "arrow"].includes(annotationTool) || annotationPoints.length === 2);
  const dirty = Boolean(
    draft && originalDraft && JSON.stringify(draft) !== JSON.stringify(originalDraft),
  );
  const responsiveDefinition = RESPONSIVE_PROPERTIES.find(
    (property) => property.id === responsiveProperty,
  );
  const responsiveBaseValue =
    selected && responsiveDefinition ? selected.styles[responsiveDefinition.styleKey] : "";

  function applyDraftAuditFix(findingId: string) {
    setDraft((current) => {
      if (!current) return current;
      if (findingId === "preview-paddingPx-rhythm") {
        return { ...current, paddingPx: String(Math.round(Number(current.paddingPx) / 4) * 4) };
      }
      if (findingId === "preview-gapPx-rhythm") {
        return { ...current, gapPx: String(Math.round(Number(current.gapPx) / 4) * 4) };
      }
      if (findingId === "preview-small-text") return { ...current, fontSizePx: "12" };
      if (findingId === "preview-low-opacity") return { ...current, opacity: "1" };
      if (findingId === "preview-contrast") {
        const background = colorChannels(current.backgroundColor);
        const dark = colorChannels("#111827")!;
        const light = colorChannels("#ffffff")!;
        const fallback =
          background && colorContrast(light, background) > colorContrast(dark, background)
            ? "#ffffff"
            : "#111827";
        const original = originalDraft?.textColor ? colorChannels(originalDraft.textColor) : null;
        const safeColor =
          original && background && colorContrast(original, background) >= 4.5
            ? originalDraft!.textColor
            : fallback;
        return { ...current, textColor: safeColor };
      }
      return current;
    });
    setNotice("Applied the deterministic review fix to the live preview.");
  }

  return (
    <div
      ref={designerRoot}
      className={`live-design-bridge${previewMode ? " live-design-bridge--preview" : ""}`}
      onPointerEnter={() => {
        designerHovered.current = true;
      }}
      onPointerLeave={() => {
        designerHovered.current = false;
      }}
    >
      <div className="live-design-bridge__header">
        <div>
          <h3>Live Design</h3>
          <p>Inspect, annotate and safely write selected changes back to the running project.</p>
        </div>
        <div className="live-design-bridge__header-status">
          <span className={`live-design-bridge__status live-design-bridge__status--${connection}`}>
            {connection === "ready"
              ? "Connected"
              : connection === "missing"
                ? "Bridge missing"
                : "Connecting"}
          </span>
          <small className={journalError ? "is-error" : ""}>
            {journalError
              ? "Recovery journal unavailable"
              : journalSavedAt
                ? `Continuously saved · ${new Date(journalSavedAt).toLocaleTimeString()}`
                : "Preparing recovery journal…"}
          </small>
          {(dirty || proposal || annotationComment || annotationPoints.length > 0) && (
            <button type="button" onClick={discardUnsavedJournal}>
              Discard unsaved
            </button>
          )}
        </div>
      </div>

      {workflow.isPending ? (
        <div className="design-workflow design-workflow--loading" aria-busy="true">
          Loading saved design workflow…
        </div>
      ) : (
        <DesignWorkflowPanel
          document={workflow.data}
          route={route}
          selected={selected}
          capture={capture}
          regression={visualRegression.data}
          regressionLoading={visualRegression.isLoading}
          busy={workflowBusy}
          error={workflowError || (workflow.error instanceof Error ? workflow.error.message : "")}
          onCreate={(input) => createWorkflowMutation.mutate(input)}
          onActivate={(changeSetId) => activateWorkflowMutation.mutate(changeSetId)}
          onTransition={(action, note) => transitionWorkflowMutation.mutate({ action, note })}
          onVerify={() => verifyWorkflowMutation.mutate()}
          onCaptureBaseline={() => captureBaselineMutation.mutate()}
          onCompareRegression={() => compareRegressionMutation.mutate()}
          onRollback={() => rollbackWorkflowMutation.mutate()}
        />
      )}

      {connection === "missing" && (
        <div className="live-design-bridge__setup">
          <strong>Connect this local preview</strong>
          <p>
            Glimmer can add the localhost-only bridge to the HTML entrypoint and record it in Undo
            history. It remains inactive outside localhost.
          </p>
          <div className="live-design-bridge__setup-actions">
            <button
              type="button"
              disabled={installMutation.isPending}
              onClick={() =>
                installMutation.mutate({
                  scriptUrl: glimmerApi.liveDesignBridgeClientUrl(),
                  parentOrigin,
                })
              }
            >
              {installMutation.isPending ? "Installing…" : "Install bridge automatically"}
            </button>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard
                  .writeText(installSnippet)
                  .then(() => setCopied(true))
                  .catch(() => setNotice("Copy failed; select the snippet manually."));
              }}
            >
              {copied ? "Copied" : "Copy manual snippet"}
            </button>
          </div>
          <code>{installSnippet}</code>
        </div>
      )}

      <div
        className={`live-design-bridge__workspace${previewMode ? " is-previewing" : ""}`}
        style={{
          gridTemplateColumns: previewMode
            ? "minmax(360px, 1fr)"
            : `minmax(360px, 1fr) ${inspectorWidth}px`,
        }}
      >
        <div className="live-design-bridge__preview">
          <div className="live-design-bridge__toolbar">
            <span className="live-design-bridge__canvas-label">
              Canvas
              {dirty && <em>Unsaved preview</em>}
            </span>
            {VIEWPORTS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={viewportId === item.id}
                onClick={() => setViewportId(item.id)}
              >
                {item.label}
              </button>
            ))}
            <label className="live-design-bridge__zoom">
              Zoom
              <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
                {[50, 75, 100, 125].map((value) => (
                  <option key={value} value={value}>
                    {value}%
                  </option>
                ))}
              </select>
            </label>
            <span className="live-design-bridge__toolbar-spacer" />
            <button type="button" aria-pressed={previewMode} onClick={togglePreviewMode}>
              {previewMode ? "Exit preview" : "Preview"}
            </button>
            <button
              type="button"
              aria-label="Keyboard shortcuts"
              onClick={() => setShowShortcuts(true)}
            >
              ?
            </button>
            <button type="button" disabled={!selected} onClick={resetPreview}>
              Reset preview
            </button>
            <button
              type="button"
              onClick={() => {
                setConnection("connecting");
                setReloadKey((current) => current + 1);
              }}
            >
              Reload
            </button>
          </div>
          <div className="live-design-bridge__canvas">
            <div
              className="live-design-bridge__viewport"
              style={{
                width: viewport.width ? `${viewport.width}px` : "100%",
                transform: `scale(${zoom / 100})`,
              }}
            >
              <iframe
                key={reloadKey}
                ref={iframe}
                title="Live app preview"
                src={target.href}
                sandbox="allow-forms allow-popups allow-same-origin allow-scripts"
                onLoad={() => {
                  setConnection("connecting");
                  setSelecting(false);
                  window.setTimeout(initialize, 50);
                }}
              />
              {annotating && (
                <div
                  className="live-design-bridge__annotation-layer"
                  role="button"
                  tabIndex={0}
                  aria-label="Draw design feedback"
                  onClick={(event) => {
                    if (annotationTool !== "comment" && annotationTool !== "sticky") return;
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const width = Math.max(1, bounds.width);
                    const height = Math.max(1, bounds.height);
                    setAnnotationPoints([
                      {
                        x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / width)),
                        y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / height)),
                      },
                    ]);
                  }}
                  onPointerDown={(event) => {
                    if (annotationTool === "comment" || annotationTool === "sticky") return;
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const point = {
                      x: Math.max(
                        0,
                        Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)),
                      ),
                      y: Math.max(
                        0,
                        Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height)),
                      ),
                    };
                    drawing.current = true;
                    setAnnotationPoints([point]);
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    if (!drawing.current || annotationTool !== "draw") return;
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const point = {
                      x: Math.max(
                        0,
                        Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)),
                      ),
                      y: Math.max(
                        0,
                        Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height)),
                      ),
                    };
                    setAnnotationPoints((current) =>
                      current.length >= 500 ? current : [...current, point],
                    );
                  }}
                  onPointerUp={(event) => {
                    if (!drawing.current) return;
                    drawing.current = false;
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const point = {
                      x: Math.max(
                        0,
                        Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)),
                      ),
                      y: Math.max(
                        0,
                        Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height)),
                      ),
                    };
                    setAnnotationPoints((current) =>
                      annotationTool === "draw"
                        ? current.length >= 500
                          ? current
                          : [...current, point]
                        : [current[0] ?? point, point],
                    );
                    event.currentTarget.releasePointerCapture?.(event.pointerId);
                  }}
                >
                  <AnnotationPreview tool={annotationTool} points={annotationPoints} />
                </div>
              )}
            </div>
          </div>
          <div className="live-design-bridge__canvas-context">
            <nav aria-label="Canvas element hierarchy">
              {selected?.breadcrumbs?.length ? (
                selected.breadcrumbs.map((item, index) => (
                  <button
                    key={`${item.selector}-canvas-${index}`}
                    type="button"
                    title={item.selector}
                    onClick={() => post("describe-selector", { selector: item.selector })}
                  >
                    {item.label}
                  </button>
                ))
              ) : (
                <span>No element selected</span>
              )}
            </nav>
            {selected && (
              <div>
                <span>
                  {currentStyleScopeSelector
                    ? `${matchingInstanceCount || 1} affected`
                    : "Computed style"}
                </span>
                {responsiveSource && <code>{responsiveSource.path}</code>}
              </div>
            )}
          </div>
          {!previewMode && (
            <>
              {annotating && (
                <div
                  className="live-design-bridge__tool-subdock"
                  role="toolbar"
                  aria-label="Markup tools"
                >
                  {LIVE_ANNOTATION_TOOLS.map((tool) => (
                    <button
                      key={tool.id}
                      type="button"
                      aria-pressed={annotationTool === tool.id}
                      onClick={() => toggleAnnotationTool(tool.id)}
                    >
                      {tool.label}
                    </button>
                  ))}
                </div>
              )}
              <div
                className="live-design-bridge__tool-dock"
                role="toolbar"
                aria-label="Live Design tools"
              >
                <button
                  type="button"
                  disabled={connection !== "ready"}
                  aria-pressed={selecting}
                  aria-label={selecting ? "Cancel selection" : "Select element"}
                  onClick={toggleSelectionTool}
                >
                  {selecting ? "Cancel" : "Select"}
                  <kbd>V</kbd>
                </button>
                <button
                  type="button"
                  disabled={connection !== "ready"}
                  aria-pressed={activeTab === "structure"}
                  aria-label="Structure mode"
                  onClick={openStructureTool}
                >
                  Structure
                  <kbd>Z</kbd>
                </button>
                <button
                  type="button"
                  disabled={connection !== "ready" || !selected}
                  aria-pressed={resizeMode}
                  aria-label={resizeMode ? "Hide transform handles" : "Transform handles"}
                  onClick={toggleResizeTool}
                >
                  {resizeMode ? "Done" : "Transform"}
                  <kbd>R</kbd>
                </button>
                <span />
                <button
                  type="button"
                  disabled={!capture?.screenshot}
                  aria-pressed={annotating}
                  aria-label={annotating ? "Exit annotation mode" : "Add note"}
                  onClick={() => {
                    if (annotating) {
                      setAnnotating(false);
                      setAnnotationPoints([]);
                    } else {
                      toggleAnnotationTool("comment");
                    }
                  }}
                >
                  Annotate
                  <kbd>C</kbd>
                </button>
              </div>
            </>
          )}
          {showShortcuts && (
            <div
              className="live-design-shortcuts"
              role="dialog"
              aria-modal="true"
              aria-label="Live Design keyboard shortcuts"
            >
              <div>
                <div className="live-design-shortcuts__heading">
                  <div>
                    <strong>Live Design shortcuts</strong>
                    <small>Canvas-first navigation without leaving the selected element.</small>
                  </div>
                  <button
                    type="button"
                    aria-label="Close shortcuts"
                    onClick={() => setShowShortcuts(false)}
                  >
                    ×
                  </button>
                </div>
                <dl>
                  <div>
                    <dt>
                      <kbd>V</kbd>
                    </dt>
                    <dd>Select element</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>R</kbd>
                    </dt>
                    <dd>Resize selected element</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>C</kbd>
                    </dt>
                    <dd>Add canvas note</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>Z</kbd>
                    </dt>
                    <dd>Open structure</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>P</kbd>
                    </dt>
                    <dd>Toggle preview mode</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>↑ ↓ ← →</kbd>
                    </dt>
                    <dd>Parent, child and siblings</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>1 2 3</kbd>
                    </dt>
                    <dd>Desktop, tablet and mobile</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>Esc</kbd>
                    </dt>
                    <dd>Exit the active canvas tool</dd>
                  </div>
                </dl>
              </div>
            </div>
          )}
        </div>

        <aside className="live-design-bridge__inspector" aria-hidden={previewMode || undefined}>
          <label className="live-design-bridge__resize">
            Inspector width
            <input
              type="range"
              min="320"
              max="520"
              value={inspectorWidth}
              onChange={(event) => setInspectorWidth(Number(event.target.value))}
            />
          </label>
          {annotationPoints.length > 0 && (
            <section className="live-design-bridge__annotation-compose">
              <strong>
                {LIVE_ANNOTATION_TOOLS.find((tool) => tool.id === annotationTool)?.label} ·{" "}
                {annotationPoints.length} point{annotationPoints.length === 1 ? "" : "s"}
              </strong>
              <textarea
                aria-label="Design note"
                rows={3}
                placeholder="Describe what should change…"
                value={annotationComment}
                onChange={(event) => setAnnotationComment(event.target.value)}
              />
              <button
                type="button"
                disabled={
                  !annotationReady || !annotationComment.trim() || feedbackMutation.isPending
                }
                onClick={saveAnnotation}
              >
                Save note for Glimmer
              </button>
            </section>
          )}
          {selected ? (
            <div className="live-design-bridge__selection">
              <div className="live-design-bridge__selection-title">
                <strong>{selected.componentName || selected.tagName}</strong>
                <span>{selected.framework ?? "html"}</span>
              </div>
              {!!selected.breadcrumbs?.length && (
                <nav className="live-design-bridge__breadcrumbs" aria-label="Element hierarchy">
                  {selected.breadcrumbs.map((item, index) => (
                    <button
                      key={`${item.selector}-${index}`}
                      type="button"
                      title={item.selector}
                      onClick={() => post("describe-selector", { selector: item.selector })}
                    >
                      {item.label}
                    </button>
                  ))}
                </nav>
              )}
              <code>{selected.selector}</code>
              {selected.sourcePathHint && <small>{selected.sourcePathHint}</small>}
              {selectedElements.length > 1 && (
                <div className="live-design-multi-selection">
                  <strong>{selectedElements.length} selected</strong>
                  <small>Shift-click on the canvas to add elements.</small>
                  <div>
                    {selectedElements.map((element) => (
                      <button
                        key={element.selector}
                        type="button"
                        title={`Remove ${element.selector} from selection`}
                        onClick={() => removeMultiSelection(element.selector)}
                      >
                        {element.componentName || element.tagName} ×
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <form
                className="live-design-element-prompt"
                onSubmit={(event) => {
                  event.preventDefault();
                  generateElementProposal();
                }}
              >
                <label htmlFor="live-design-element-prompt">Ask Glimmer about this element</label>
                <div>
                  <textarea
                    id="live-design-element-prompt"
                    rows={2}
                    maxLength={1000}
                    placeholder="Make this section clearer and more balanced…"
                    value={elementPrompt}
                    onChange={(event) => setElementPrompt(event.target.value)}
                  />
                  <button
                    type="submit"
                    disabled={!elementPrompt.trim() || proposalMutation.isPending}
                  >
                    {proposalMutation.isPending ? "Designing…" : "Generate preview"}
                  </button>
                </div>
                <small>Selection, cascade, tokens and source binding are attached.</small>
              </form>
              {proposal && (
                <section className="live-design-proposal" aria-label="Glimmer design proposal">
                  <div>
                    <strong>{proposal.summary}</strong>
                    <span data-provenance={proposal.provenance}>
                      {proposal.provenance === "model-output" ? "Glimmer model" : "Safe fallback"}
                    </span>
                  </div>
                  <ul>
                    {proposal.changes.map((change) => (
                      <li key={change.field}>
                        <strong>{change.label}</strong>
                        <code>
                          <del>{change.before || "unset"}</del>
                          <span>→</span>
                          <ins>{change.after}</ins>
                        </code>
                        <small>{change.reason}</small>
                      </li>
                    ))}
                  </ul>
                  <div className="live-design-proposal__actions">
                    <button
                      type="button"
                      className="live-design-bridge__primary-action"
                      disabled={
                        proposalDecision === "accepted" ||
                        !capture?.screenshot ||
                        feedbackMutation.isPending
                      }
                      onClick={acceptElementProposal}
                    >
                      {proposalDecision === "accepted" ? "Accepted" : "Accept and queue"}
                    </button>
                    <button
                      type="button"
                      disabled={feedbackMutation.isPending}
                      onClick={rejectElementProposal}
                    >
                      Reject
                    </button>
                  </div>
                  {!capture?.screenshot && (
                    <small>Capture a visual state before accepting this proposal.</small>
                  )}
                </section>
              )}
            </div>
          ) : (
            <p className="live-design-bridge__empty">
              Select an element in the preview. History remains available without a selection.
            </p>
          )}
          <div className="live-design-bridge__tabs" role="tablist" aria-label="Inspector">
            {INSPECTOR_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="live-design-bridge__tab-panel" role="tabpanel">
            {activeTab === "structure" && (
              <LiveDesignStructurePanel
                snapshot={structure}
                selectedSelector={selected?.selector ?? ""}
                pending={pendingStructure}
                canSave={directApply}
                busy={structureMutation.isPending}
                lockedSelectors={lockedSelectors}
                hiddenSelectors={hiddenSelectors}
                blockedReason={
                  resolution?.directApplyReason ??
                  (activeChangeSet && !workflowAllowsSource
                    ? `“${activeChangeSet.title}” must be approved before source can be changed.`
                    : selected
                      ? "Resolve this element to a safe source binding before saving."
                      : "Select an element before changing structure.")
                }
                onSelect={(selector) => post("describe-selector", { selector })}
                onHighlight={(selector) => post("highlight-selector", { selector })}
                onClearHighlight={() => post("clear-highlight")}
                onToggleLock={toggleStructureLock}
                onToggleVisibility={toggleStructureVisibility}
                onStage={stageStructure}
                onApply={() => {
                  if (pendingStructure) structureMutation.mutate(pendingStructure);
                }}
                onCancel={cancelStructurePreview}
              />
            )}
            {activeTab === "responsive" && (
              <section className="live-design-responsive">
                <div>
                  <h4>Breakpoint override</h4>
                  <p>
                    Preview a scoped media-query rule, then save it as a durable stylesheet
                    revision.
                  </p>
                </div>
                <div
                  className="live-design-responsive__breakpoints"
                  role="group"
                  aria-label="Breakpoint"
                >
                  {(["mobile", "tablet", "desktop"] as const).map((breakpoint) => (
                    <button
                      key={breakpoint}
                      type="button"
                      aria-pressed={responsiveBreakpoint === breakpoint}
                      onClick={() => setResponsiveBreakpoint(breakpoint)}
                    >
                      {breakpoint === "mobile"
                        ? "Mobile · ≤479"
                        : breakpoint === "tablet"
                          ? "Tablet · 480–991"
                          : "Desktop · ≥992"}
                    </button>
                  ))}
                </div>
                <div className="live-design-responsive__compare" aria-label="Responsive cascade">
                  {(["mobile", "tablet", "desktop"] as const).map((breakpoint) => {
                    const override = responsiveOverrides[`${breakpoint}:${responsiveProperty}`];
                    const staged =
                      responsivePreviewed && breakpoint === responsiveBreakpoint
                        ? responsiveValue
                        : undefined;
                    return (
                      <button
                        key={breakpoint}
                        type="button"
                        aria-pressed={responsiveBreakpoint === breakpoint}
                        onClick={() => {
                          setResponsiveBreakpoint(breakpoint);
                          setViewportId(breakpoint);
                          setResponsiveValue(override ?? responsiveBaseValue);
                        }}
                      >
                        <strong>{breakpoint}</strong>
                        <code>{staged ?? override ?? responsiveBaseValue ?? "unset"}</code>
                        <small>{staged ? "staged" : override ? "override" : "inherits base"}</small>
                      </button>
                    );
                  })}
                </div>
                <label>
                  Property
                  <select
                    value={responsiveProperty}
                    onChange={(event) =>
                      setResponsiveProperty(event.target.value as LiveDesignResponsiveProperty)
                    }
                  >
                    {RESPONSIVE_PROPERTIES.map((property) => (
                      <option key={property.id} value={property.id}>
                        {property.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Value
                  <input
                    value={responsiveValue}
                    maxLength={200}
                    placeholder="24px"
                    onChange={(event) => setResponsiveValue(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={
                    ![
                      "font-size",
                      "padding",
                      "margin",
                      "gap",
                      "border-width",
                      "border-radius",
                    ].includes(responsiveProperty)
                  }
                  onClick={makeResponsiveValueFluid}
                >
                  Convert pixel value to fluid clamp()
                </button>
                <small>
                  {responsiveSource
                    ? `Bound stylesheet: ${responsiveSource.path}`
                    : selected
                      ? "No exact stylesheet binding is available for this element yet."
                      : "Select an element in the navigator or preview first."}
                </small>
                <div className="live-design-responsive__actions">
                  <button
                    type="button"
                    disabled={!selected || !responsiveValue.trim() || responsiveMutation.isPending}
                    onClick={previewResponsive}
                  >
                    Preview at {responsiveBreakpoint}
                  </button>
                  <button
                    type="button"
                    className={directApply ? "live-design-bridge__primary-action" : ""}
                    disabled={
                      !responsivePreviewed ||
                      !responsiveSource ||
                      !directApply ||
                      responsiveMutation.isPending
                    }
                    onClick={() => {
                      if (responsiveSource) responsiveMutation.mutate(responsiveSource);
                    }}
                  >
                    {responsiveMutation.isPending ? "Saving…" : "Save override to source"}
                  </button>
                  <button
                    type="button"
                    disabled={!responsivePreviewed || responsiveMutation.isPending}
                    onClick={cancelResponsivePreview}
                  >
                    Cancel preview
                  </button>
                </div>
                {!directApply && selected && (
                  <p className="live-design-bridge__warning">
                    {resolution?.directApplyReason ??
                      (activeChangeSet && !workflowAllowsSource
                        ? `“${activeChangeSet.title}” must be approved before saving.`
                        : "Resolving a safe source binding…")}
                  </p>
                )}
              </section>
            )}
            {activeTab === "content" && selected && draft && (
              <>
                <label>
                  Text
                  <textarea
                    rows={4}
                    value={draft.text}
                    onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                  />
                </label>
                {selected.tagName === "img" && (
                  <label>
                    Image source
                    <input
                      value={draft.imageSource}
                      placeholder="public/images/hero.png"
                      onChange={(event) => setDraft({ ...draft, imageSource: event.target.value })}
                    />
                  </label>
                )}
                <section className="live-design-bridge__source">
                  <h4>Generate an image asset</h4>
                  <label>
                    Prompt
                    <textarea
                      rows={3}
                      value={assetPrompt}
                      placeholder="Describe the image and how it should fit this component…"
                      onChange={(event) => setAssetPrompt(event.target.value)}
                    />
                  </label>
                  <label>
                    Output path
                    <input
                      value={assetPath}
                      onChange={(event) => setAssetPath(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={
                      !assetPrompt.trim() || !assetPath.trim() || feedbackMutation.isPending
                    }
                    onClick={queueAsset}
                  >
                    Queue asset generation
                  </button>
                </section>
              </>
            )}
            {activeTab === "style" && selected && draft && (
              <>
                <div className="live-design-bridge__color-grid">
                  <label>
                    Text color
                    <input
                      type="color"
                      value={draft.textColor || "#000000"}
                      onChange={(event) => setDraft({ ...draft, textColor: event.target.value })}
                    />
                  </label>
                  <label>
                    Background
                    <input
                      type="color"
                      value={draft.backgroundColor || "#ffffff"}
                      onChange={(event) =>
                        setDraft({ ...draft, backgroundColor: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Border
                    <input
                      type="color"
                      value={draft.borderColor || "#000000"}
                      onChange={(event) => setDraft({ ...draft, borderColor: event.target.value })}
                    />
                  </label>
                </div>
                <label>
                  Font family
                  <input
                    value={draft.fontFamily}
                    onChange={(event) => setDraft({ ...draft, fontFamily: event.target.value })}
                  />
                </label>
                <div className="live-design-bridge__number-grid">
                  {(
                    [
                      ["Font px", "fontSizePx", 8, 240],
                      ["Weight", "fontWeight", 100, 900],
                      ["Line height", "lineHeight", 0.5, 4],
                      ["Opacity", "opacity", 0, 1],
                    ] as const
                  ).map(([label, key, min, max]) => (
                    <label key={key}>
                      {label}
                      <input
                        type="number"
                        min={min}
                        max={max}
                        step={key === "opacity" || key === "lineHeight" ? 0.1 : 1}
                        value={draft[key]}
                        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                      />
                    </label>
                  ))}
                </div>
                <section className="live-design-cascade">
                  <div>
                    <h4>Property sources</h4>
                    <small>
                      Matched rules are shown in cascade order; inline declarations win.
                    </small>
                  </div>
                  {selected.styleSources?.length ? (
                    <ol>
                      {selected.styleSources.map((source, index) => (
                        <li key={`${source.source}-${source.selector}-${index}`}>
                          <div>
                            <code>{source.selector}</code>
                            <span>{source.specificity}</span>
                          </div>
                          <small>
                            {source.source}
                            {source.inherited ? " · inherited" : ""}
                          </small>
                          <div className="live-design-cascade__declarations">
                            {source.declarations.slice(0, 8).map((declaration) => (
                              <span key={`${declaration.property}-${declaration.value}`}>
                                {declaration.property}: {declaration.value}
                                {declaration.important ? " !important" : ""}
                              </span>
                            ))}
                            {source.declarations.length > 8 && (
                              <span>+{source.declarations.length - 8} more</span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="live-design-bridge__empty">
                      Reload the connected preview to inspect its CSS cascade.
                    </p>
                  )}
                </section>
              </>
            )}
            {activeTab === "layout" && selected && draft && (
              <section className="live-design-layout">
                <div className="live-design-layout__summary">
                  <div>
                    <h4>Visual layout</h4>
                    <small>
                      {currentStyleScopeSelector
                        ? `${styleScope === "instance" ? "One instance" : "Reusable component"} · ${currentStyleScopeSelector}`
                        : "Choose a stable component scope before saving."}
                    </small>
                  </div>
                  <button type="button" onClick={() => setActiveTab("component")}>
                    Change scope
                  </button>
                </div>
                <button type="button" aria-pressed={resizeMode} onClick={toggleResizeTool}>
                  {resizeMode ? "Hide canvas handles" : "Show canvas resize handles"}
                </button>
                <div
                  className="live-design-display-picker"
                  role="group"
                  aria-label="Quick display mode"
                >
                  {(
                    [
                      ["block", "Block"],
                      ["flex", "Flex"],
                      ["grid", "Grid"],
                      ["none", "Hidden"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={draft.display === value}
                      onClick={() => setDraft({ ...draft, display: value })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="live-design-bridge__number-grid">
                  <label>
                    Layout display
                    <select
                      value={draft.display}
                      onChange={(event) => setDraft({ ...draft, display: event.target.value })}
                    >
                      <option value="block">Block</option>
                      <option value="inline-block">Inline block</option>
                      <option value="flex">Flex</option>
                      <option value="inline-flex">Inline flex</option>
                      <option value="grid">Grid</option>
                      <option value="inline-grid">Inline grid</option>
                      <option value="none">Hidden</option>
                    </select>
                  </label>
                  <label>
                    Box sizing
                    <select
                      value={draft.boxSizing}
                      onChange={(event) => setDraft({ ...draft, boxSizing: event.target.value })}
                    >
                      <option value="border-box">Border box</option>
                      <option value="content-box">Content box</option>
                    </select>
                  </label>
                </div>
                <LayoutSection title="Size" summary="Width, height and constraints" defaultOpen>
                  <div className="live-design-bridge__number-grid">
                    {(
                      [
                        ["Width", "width"],
                        ["Height", "height"],
                        ["Min width", "minWidth"],
                        ["Max width", "maxWidth"],
                        ["Min height", "minHeight"],
                        ["Max height", "maxHeight"],
                      ] as const
                    ).map(([label, key]) => (
                      <label key={key}>
                        {label}
                        <input
                          value={draft[key]}
                          maxLength={200}
                          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                        />
                      </label>
                    ))}
                  </div>
                </LayoutSection>
                <LayoutSection title="Spacing" summary="Uniform box-model spacing" defaultOpen>
                  <div className="live-design-box-model">
                    <span>margin</span>
                    <MetricStepper
                      label="Margin"
                      value={draft.marginPx}
                      minimum={-512}
                      maximum={512}
                      onChange={(value) => setDraft({ ...draft, marginPx: value })}
                    />
                    <div>
                      <span>padding</span>
                      <MetricStepper
                        label="Padding"
                        value={draft.paddingPx}
                        minimum={0}
                        maximum={512}
                        onChange={(value) => setDraft({ ...draft, paddingPx: value })}
                      />
                      <strong>{selected.tagName}</strong>
                    </div>
                  </div>
                  <MetricStepper
                    label="Gap"
                    value={draft.gapPx}
                    minimum={0}
                    maximum={512}
                    onChange={(value) => setDraft({ ...draft, gapPx: value })}
                  />
                </LayoutSection>
                {(draft.display.includes("flex") || draft.display.includes("grid")) && (
                  <LayoutSection
                    title={draft.display.includes("grid") ? "Grid container" : "Flex container"}
                    summary="Direction, alignment and flow"
                    defaultOpen
                  >
                    {draft.display.includes("flex") && (
                      <div className="live-design-bridge__number-grid">
                        <label>
                          Direction
                          <select
                            value={draft.direction}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                direction: event.target.value as EditorDraft["direction"],
                              })
                            }
                          >
                            <option value="row">Row</option>
                            <option value="column">Column</option>
                          </select>
                        </label>
                        <label>
                          Wrap
                          <select
                            value={draft.flexWrap}
                            onChange={(event) =>
                              setDraft({ ...draft, flexWrap: event.target.value })
                            }
                          >
                            <option value="nowrap">No wrap</option>
                            <option value="wrap">Wrap</option>
                            <option value="wrap-reverse">Wrap reverse</option>
                          </select>
                        </label>
                      </div>
                    )}
                    <div className="live-design-alignment-row">
                      <AlignmentPicker
                        direction={draft.direction}
                        justify={draft.align}
                        alignItems={draft.alignItemsValue}
                        onChange={(align, alignItemsValue) =>
                          setDraft({ ...draft, align, alignItemsValue })
                        }
                      />
                      <button
                        type="button"
                        aria-pressed={draft.align === "space-between"}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            align: draft.align === "space-between" ? "start" : "space-between",
                          })
                        }
                      >
                        Distribute space
                      </button>
                    </div>
                    {draft.display.includes("grid") && (
                      <>
                        <label>
                          Grid columns
                          <input
                            value={draft.gridTemplateColumns}
                            placeholder="repeat(3, minmax(0, 1fr))"
                            maxLength={200}
                            onChange={(event) =>
                              setDraft({ ...draft, gridTemplateColumns: event.target.value })
                            }
                          />
                        </label>
                        <label>
                          Grid rows
                          <input
                            value={draft.gridTemplateRows}
                            placeholder="auto"
                            maxLength={200}
                            onChange={(event) =>
                              setDraft({ ...draft, gridTemplateRows: event.target.value })
                            }
                          />
                        </label>
                        <label>
                          Grid flow
                          <select
                            value={draft.gridAutoFlow}
                            onChange={(event) =>
                              setDraft({ ...draft, gridAutoFlow: event.target.value })
                            }
                          >
                            <option value="row">Row</option>
                            <option value="column">Column</option>
                            <option value="dense">Dense</option>
                            <option value="row dense">Row dense</option>
                            <option value="column dense">Column dense</option>
                          </select>
                        </label>
                      </>
                    )}
                  </LayoutSection>
                )}
                <LayoutSection title="Position" summary="Offsets, order and child placement">
                  <label>
                    Position mode
                    <select
                      value={draft.position}
                      onChange={(event) => setDraft({ ...draft, position: event.target.value })}
                    >
                      <option value="static">Static</option>
                      <option value="relative">Relative</option>
                      <option value="absolute">Absolute</option>
                      <option value="fixed">Fixed</option>
                      <option value="sticky">Sticky</option>
                    </select>
                  </label>
                  <div className="live-design-bridge__number-grid">
                    {(
                      [
                        ["Top", "top"],
                        ["Right", "right"],
                        ["Bottom", "bottom"],
                        ["Left", "left"],
                        ["Z index", "zIndex"],
                        ["Order", "order"],
                        ["Flex child", "flex"],
                        ["Grid column", "gridColumn"],
                        ["Grid row", "gridRow"],
                      ] as const
                    ).map(([label, key]) => (
                      <label key={key}>
                        {label}
                        <input
                          value={draft[key]}
                          maxLength={200}
                          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                        />
                      </label>
                    ))}
                  </div>
                </LayoutSection>
                <div className="live-design-layout__stage">
                  <strong>
                    {Object.keys(layoutChanges).length} staged layout rule
                    {Object.keys(layoutChanges).length === 1 ? "" : "s"}
                  </strong>
                  <small>
                    {responsiveSource
                      ? `Bound stylesheet: ${responsiveSource.path}`
                      : "No exact stylesheet binding is available yet."}
                  </small>
                  <button
                    type="button"
                    className={directApply ? "live-design-bridge__primary-action" : ""}
                    disabled={Boolean(layoutSaveBlocker)}
                    title={
                      layoutSaveBlocker ?? "Persist the staged layout rules to the stylesheet."
                    }
                    onClick={() => {
                      if (responsiveSource) {
                        styleOverrideMutation.mutate({
                          source: responsiveSource,
                          declarations: layoutChanges,
                        });
                      }
                    }}
                  >
                    {styleOverrideMutation.isPending ? "Saving…" : "Save layout to source"}
                  </button>
                  <button
                    type="button"
                    disabled={!Object.keys(layoutChanges).length || styleOverrideMutation.isPending}
                    onClick={cancelLayoutPreview}
                  >
                    Cancel layout preview
                  </button>
                </div>
              </section>
            )}
            {activeTab === "component" && selected && (
              <section className="live-design-component-scope">
                <div>
                  <h4>Reusable component scope</h4>
                  <p>
                    Choose whether layout changes affect one stable instance or every matching
                    component instance.
                  </p>
                </div>
                <div className="live-design-component-scope__identity">
                  <strong>{selected.componentName || selected.tagName}</strong>
                  <span>{selected.framework ?? "html"}</span>
                  {selected.sourcePathHint && <small>{selected.sourcePathHint}</small>}
                </div>
                <div className="live-design-class-manager">
                  <strong>Existing classes</strong>
                  <small>Choose the reusable class that owns the new layout rule.</small>
                  {selectedClasses.length ? (
                    <div>
                      {selectedClasses.map((className) => (
                        <button
                          key={className}
                          type="button"
                          aria-pressed={selectedClass === className}
                          onClick={() => {
                            setSelectedClass(className);
                            setStyleScope("component");
                          }}
                        >
                          .{className}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="live-design-bridge__empty">
                      No reusable class is present; use instance scope until markup has a class.
                    </p>
                  )}
                </div>
                {(["instance", "component"] as const).map((scope) => {
                  const selector = styleScopeSelector(
                    selected,
                    scope,
                    scope === "component" ? selectedClass : undefined,
                  );
                  const count = matchingStructureNodes(structure, selector);
                  return (
                    <button
                      key={scope}
                      type="button"
                      className={styleScope === scope ? "is-selected" : ""}
                      disabled={!selector}
                      onClick={() => setStyleScope(scope)}
                    >
                      <strong>
                        {scope === "instance" ? "This instance" : "All matching instances"}
                      </strong>
                      <span>
                        {selector
                          ? `${selector} · ${count || 1} match${count === 1 ? "" : "es"}`
                          : scope === "instance"
                            ? "Requires id or data-testid"
                            : "Requires a stable class"}
                      </span>
                    </button>
                  );
                })}
                <div className="live-design-layout__stage">
                  <strong>
                    Active scope:{" "}
                    {styleScope === "instance" ? "one instance" : "reusable component"}
                  </strong>
                  <small>
                    {currentStyleScopeSelector
                      ? `${matchingInstanceCount || 1} matching DOM instance${matchingInstanceCount === 1 ? "" : "s"}`
                      : "This selection needs a stable selector before it can be saved."}
                  </small>
                  <button type="button" onClick={() => setActiveTab("layout")}>
                    Continue to layout
                  </button>
                </div>
              </section>
            )}
            {activeTab === "library" && (
              <DesignCatalogExplorer
                value={
                  feedback.data?.designProfiles?.length
                    ? feedback.data.designProfiles
                    : initialDesignProfiles
                }
                tokenGraph={resolution?.tokenGraph ?? []}
                projectContext={{
                  platform: "web",
                  tokenNames: resolution?.tokenGraph?.map((token) => token.name) ?? [],
                }}
                onChange={(designProfiles) => {
                  const update = baseFeedback(feedback.data, initialDesignProfiles);
                  feedbackMutation.mutate({ update: { ...update, designProfiles } });
                }}
              />
            )}
            {activeTab === "tokens" && (
              <section className="live-design-bridge__source">
                <h4>Design token graph</h4>
                {!!selected?.tokens.length && (
                  <div className="live-design-bridge__chips">
                    {selected.tokens.map((token) => (
                      <span key={`${token.name}-${token.property}`} title={token.value}>
                        {token.name} · {token.property}
                      </span>
                    ))}
                  </div>
                )}
                {resolution?.tokenGraph?.length ? (
                  <>
                    <label>
                      Bind token to property
                      <select
                        value={tokenBindingProperty}
                        onChange={(event) => setTokenBindingProperty(event.target.value)}
                      >
                        {[
                          ...new Set(
                            (resolution?.candidates ?? [])
                              .filter(
                                (candidate) =>
                                  candidate.kind === "css-declaration" &&
                                  candidate.confidence === "exact" &&
                                  candidate.property,
                              )
                              .map((candidate) => candidate.property!),
                          ),
                        ].map((property) => (
                          <option key={property} value={property}>
                            {property}
                          </option>
                        ))}
                      </select>
                    </label>
                    <ul className="live-design-bridge__data-list live-design-token-browser">
                      {resolution.tokenGraph.map((token) => {
                        const current = selected?.tokens.some(
                          (reference) => reference.name === token.name,
                        );
                        return (
                          <li key={`${token.path}-${token.name}`}>
                            <div>
                              <strong>{token.name}</strong>
                              {current && <span>current</span>}
                            </div>
                            <code>{token.value}</code>
                            <small>
                              {token.path}:{token.line}
                            </small>
                            {!!token.aliases.length && (
                              <small>Aliases: {token.aliases.join(", ")}</small>
                            )}
                            <button
                              type="button"
                              disabled={
                                !directApply ||
                                !chooseCandidate(
                                  resolution?.candidates ?? [],
                                  tokenBindingProperty,
                                ) ||
                                applyMutation.isPending
                              }
                              onClick={() => bindTokenToProperty(token)}
                            >
                              Use for {tokenBindingProperty}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : (
                  <p className="live-design-bridge__empty">No token definition is bound yet.</p>
                )}
                {!!tokenCandidates.length && (
                  <>
                    <label>
                      Token source
                      <select
                        value={tokenCandidateId}
                        onChange={(event) => {
                          const id = event.target.value;
                          setTokenCandidateId(id);
                          setTokenReplacement(
                            tokenCandidates.find((candidate) => candidate.id === id)?.expected ??
                              "",
                          );
                        }}
                      >
                        <option value="">Choose token…</option>
                        {tokenCandidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.tokenName} · {candidate.path}:{candidate.line}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Token value
                      <input
                        type="color"
                        value={tokenReplacement || "#000000"}
                        onChange={(event) => setTokenReplacement(event.target.value)}
                      />
                    </label>
                  </>
                )}
              </section>
            )}
            {activeTab === "code" && (
              <section className="live-design-bridge__source">
                <h4>Validated source bindings</h4>
                {resolveMutation.isPending ? (
                  <p>Finding safe source candidates…</p>
                ) : resolution ? (
                  <>
                    <small>
                      {resolution.scannedFiles} files · {resolution.branch}
                      {resolution.truncated ? " · capped" : ""}
                    </small>
                    {!resolution.directApplyAllowed && (
                      <p className="live-design-bridge__warning">{resolution.directApplyReason}</p>
                    )}
                    {resolution.directApplyAllowed && !workflowAllowsSource && activeChangeSet && (
                      <p className="live-design-bridge__warning">
                        “{activeChangeSet.title}” must be approved before source can be changed.
                        Preview and queued feedback remain available.
                      </p>
                    )}
                    {!!textCandidates.length && (
                      <label>
                        Text source
                        <select
                          value={textCandidateId}
                          onChange={(event) => setTextCandidateId(event.target.value)}
                        >
                          <option value="">Choose an exact match…</option>
                          {textCandidates.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.path}:{candidate.line} — {candidate.excerpt}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <ul className="live-design-bridge__candidate-list">
                      {resolution.candidates.map((candidate) => (
                        <li key={candidate.id}>
                          <span>{candidate.kind}</span>
                          <code>
                            {candidate.path}:{candidate.line}
                          </code>
                          <small>{candidate.reason ?? candidate.excerpt}</small>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p>Select an element to resolve its source.</p>
                )}
              </section>
            )}
            {activeTab === "review" && (
              <>
                <section className="live-design-bridge__source">
                  <h4>Automatic review</h4>
                  {reviewFindings.length ? (
                    <ul className="live-design-bridge__audit-list">
                      {reviewFindings.map((finding) => (
                        <li key={finding.id} data-severity={finding.severity}>
                          <div>
                            <strong>{finding.message}</strong>
                            <span>{finding.suggestion}</span>
                          </div>
                          {finding.id.startsWith("preview-") && (
                            <button type="button" onClick={() => applyDraftAuditFix(finding.id)}>
                              Fix preview
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="live-design-bridge__empty">No deterministic issues found.</p>
                  )}
                </section>
                <section className="live-design-bridge__source">
                  <h4>CMS references</h4>
                  {resolution?.cmsReferences?.length ? (
                    <ul className="live-design-bridge__data-list">
                      {resolution.cmsReferences.map((reference) => (
                        <li key={`${reference.path}-${reference.field}`}>
                          <strong>{reference.field}</strong>
                          <small>
                            {reference.path}:{reference.line}
                          </small>
                          <code>{reference.value}</code>
                          <button
                            type="button"
                            disabled={!capture?.screenshot || feedbackMutation.isPending}
                            onClick={() => queueCmsBinding(reference)}
                          >
                            Bind selected content
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="live-design-bridge__empty">
                      No configured CMS field matches this content.
                    </p>
                  )}
                </section>
              </>
            )}
            {activeTab === "variants" && selected && draft && (
              <>
                <div className="live-design-bridge__variants">
                  {VARIANT_PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      onClick={() => setDraft({ ...draft, ...preset.patch })}
                    >
                      <strong>{preset.name}</strong>
                      <span>{preset.description}</span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={!capture?.screenshot || feedbackMutation.isPending}
                  onClick={queueVariants}
                >
                  Generate all 3 with Glimmer
                </button>
              </>
            )}
            {activeTab === "history" && (
              <section className="live-design-bridge__source">
                <h4>Durable source history</h4>
                {history.isPending ? (
                  <p>Loading history…</p>
                ) : history.data?.revisions.length ? (
                  <ul className="live-design-bridge__history-list">
                    {history.data.revisions.map((item) => (
                      <li key={item.id}>
                        <div>
                          <strong>{revisionLabel(item)}</strong>
                          <small>
                            {item.path} · {new Date(item.createdAt).toLocaleTimeString()}
                          </small>
                        </div>
                        {item.rolledBackAt ? (
                          <span>Undone</span>
                        ) : (
                          <button
                            type="button"
                            disabled={rollbackMutation.isPending}
                            onClick={() => rollbackMutation.mutate(item.id)}
                          >
                            Undo
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="live-design-bridge__empty">No source edits recorded yet.</p>
                )}
              </section>
            )}
          </div>
          {selected &&
            draft &&
            originalDraft &&
            activeTab !== "structure" &&
            activeTab !== "responsive" &&
            activeTab !== "layout" &&
            activeTab !== "component" &&
            (activeTab === "content" || activeTab === "style" || activeTab === "tokens") && (
              <div className="live-design-bridge__actions">
                <div className="live-design-bridge__action-context">
                  <strong>
                    {workflowAllowsSource ? "Save approved work" : "Prepare the change"}
                  </strong>
                  <small>
                    {workflowAllowsSource
                      ? "Source saves are durable and linked to the active change set."
                      : "Preview freely, then queue the change and send the change set to review."}
                  </small>
                </div>
                {activeTab === "content" && (
                  <button
                    type="button"
                    className={workflowAllowsSource ? "live-design-bridge__primary-action" : ""}
                    disabled={
                      !textCandidate ||
                      !directApply ||
                      applyMutation.isPending ||
                      draft.text === textCandidate.expected
                    }
                    onClick={saveText}
                  >
                    Save text to source
                  </button>
                )}
                {activeTab === "style" && (
                  <button
                    type="button"
                    className={workflowAllowsSource ? "live-design-bridge__primary-action" : ""}
                    disabled={
                      !styleSourceEdits.length ||
                      !directApply ||
                      Boolean(blockingDraftFinding) ||
                      transactionMutation.isPending
                    }
                    onClick={() => transactionMutation.mutate(styleSourceEdits)}
                  >
                    Save {styleSourceEdits.length || ""} style
                    {styleSourceEdits.length === 1 ? "" : "s"} to source
                  </button>
                )}
                {(activeTab === "content" || activeTab === "style") && (
                  <button
                    type="button"
                    className={!workflowAllowsSource ? "live-design-bridge__primary-action" : ""}
                    disabled={!dirty || !capture?.screenshot || feedbackMutation.isPending}
                    onClick={queueForGlimmer}
                  >
                    Queue remaining changes
                  </button>
                )}
                {activeTab === "tokens" && (
                  <button
                    type="button"
                    disabled={
                      !tokenCandidate ||
                      !directApply ||
                      applyMutation.isPending ||
                      tokenReplacement === tokenCandidate.expected
                    }
                    onClick={saveToken}
                  >
                    Save token to source
                  </button>
                )}
                {revision && !revision.rolledBackAt && (
                  <button
                    type="button"
                    disabled={rollbackMutation.isPending}
                    onClick={() => rollbackMutation.mutate(revision.id)}
                  >
                    Undo last source edit
                  </button>
                )}
                {blockingDraftFinding && (
                  <small className="live-design-bridge__quality-blocker">
                    Save blocked: {blockingDraftFinding.suggestion}
                  </small>
                )}
              </div>
            )}
          {notice && (
            <p className="live-design-bridge__notice" role="status">
              {notice}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
