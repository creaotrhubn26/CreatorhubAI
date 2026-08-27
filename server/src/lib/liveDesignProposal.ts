import { randomUUID } from "node:crypto";
import type {
  LiveDesignElement,
  LiveDesignProposalChange,
  LiveDesignProposalField,
  LiveDesignProposalResponse,
} from "@glimmer/shared";

const ALLOWED_FIELDS = new Set<LiveDesignProposalField>([
  "text",
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

function numeric(value: string): string {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? String(parsed) : "";
}

function currentValues(element: LiveDesignElement): Record<LiveDesignProposalField, string> {
  const fontSize = Number.parseFloat(element.styles.fontSize);
  const rawLineHeight = Number.parseFloat(element.styles.lineHeight);
  const lineHeight =
    element.styles.lineHeight.endsWith("px") && Number.isFinite(fontSize) && fontSize > 0
      ? String(Math.round((rawLineHeight / fontSize) * 100) / 100)
      : numeric(element.styles.lineHeight);
  return {
    text: element.text,
    imageSource: element.tagName === "img" ? (element.attributes.src ?? "") : "",
    textColor: element.styles.color,
    backgroundColor: element.styles.backgroundColor,
    fontFamily: element.styles.fontFamily,
    fontSizePx: numeric(element.styles.fontSize),
    fontWeight: numeric(element.styles.fontWeight),
    lineHeight,
    paddingPx: numeric(element.styles.padding),
    marginPx: numeric(element.styles.margin),
    gapPx: numeric(element.styles.gap),
    borderColor: element.styles.borderColor,
    borderWidthPx: numeric(element.styles.borderWidth),
    borderRadiusPx: numeric(element.styles.borderRadius),
    opacity: numeric(element.styles.opacity),
    direction: element.styles.flexDirection === "column" ? "column" : "row",
    align: ["center", "space-between"].includes(element.styles.justifyContent)
      ? element.styles.justifyContent
      : element.styles.justifyContent === "flex-end"
        ? "end"
        : "start",
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

function safeValue(field: LiveDesignProposalField, value: unknown): string | null {
  if (typeof value !== "string" || value.length > (field === "text" ? 5_000 : 200)) return null;
  if (value.includes("\0") || /[{}]/.test(value)) return null;
  if (
    field !== "text" &&
    (value.includes("/*") || value.includes("*/") || /@import/i.test(value))
  ) {
    return null;
  }
  if (field === "direction" && !["row", "column"].includes(value)) return null;
  if (field === "align" && !["start", "center", "end", "space-between"].includes(value)) {
    return null;
  }
  if (
    field === "display" &&
    ![
      "block",
      "inline",
      "inline-block",
      "flex",
      "inline-flex",
      "grid",
      "inline-grid",
      "none",
    ].includes(value)
  ) {
    return null;
  }
  if (
    field === "position" &&
    !["static", "relative", "absolute", "fixed", "sticky"].includes(value)
  ) {
    return null;
  }
  return value;
}

function labelFor(field: LiveDesignProposalField): string {
  return field
    .replace(/([A-Z])/g, " $1")
    .replace(/Px$/, "")
    .replace(/^./, (character) => character.toUpperCase());
}

function normalizeChanges(
  value: unknown,
  current: Record<LiveDesignProposalField, string>,
): LiveDesignProposalChange[] {
  if (!Array.isArray(value) || value.length > 20) return [];
  const changes: LiveDesignProposalChange[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    if (
      typeof raw.field !== "string" ||
      !ALLOWED_FIELDS.has(raw.field as LiveDesignProposalField)
    ) {
      continue;
    }
    const field = raw.field as LiveDesignProposalField;
    if (seen.has(field)) continue;
    const after = safeValue(field, raw.after);
    const reason =
      typeof raw.reason === "string" && raw.reason.trim() && raw.reason.length <= 500
        ? raw.reason.trim()
        : "Supports the requested visual outcome.";
    if (after === null || after === current[field]) continue;
    seen.add(field);
    changes.push({ field, label: labelFor(field), before: current[field], after, reason });
  }
  return changes;
}

function deterministicChanges(
  prompt: string,
  element: LiveDesignElement,
  current: Record<LiveDesignProposalField, string>,
): LiveDesignProposalChange[] {
  const lower = prompt.toLowerCase();
  const proposed: Array<{ field: LiveDesignProposalField; after: string; reason: string }> = [];
  const add = (field: LiveDesignProposalField, after: string, reason: string) => {
    proposed.push({ field, after, reason });
  };
  if (/hierarchy|tydelig|clear|heading|overskrift/.test(lower)) {
    const size = Math.max(18, Math.min(72, (Number(current.fontSizePx) || 16) + 4));
    add("fontSizePx", String(size), "Creates a clearer visual hierarchy.");
    add(
      "fontWeight",
      String(Math.max(650, Number(current.fontWeight) || 400)),
      "Strengthens emphasis without changing content.",
    );
    add("lineHeight", "1.2", "Keeps the stronger heading compact and readable.");
  }
  if (/balance|spacing|space|luft|rytm|rhythm/.test(lower)) {
    add(
      "paddingPx",
      String(Math.max(12, Number(current.paddingPx) || 0)),
      "Adds consistent internal breathing room.",
    );
    add(
      "gapPx",
      String(Math.max(12, Number(current.gapPx) || 0)),
      "Establishes an even spacing rhythm.",
    );
  }
  if (/responsive|mobile|fluid|fleksibel/.test(lower)) {
    add("width", "100%", "Allows the element to adapt to its container.");
    add(
      "maxWidth",
      element.tagName === "p" ? "65ch" : "100%",
      "Prevents viewport overflow while preserving readability.",
    );
    add("boxSizing", "border-box", "Keeps padding inside the responsive width.");
  }
  if (/button|action|cta|knapp/.test(lower)) {
    add(
      "paddingPx",
      String(Math.max(12, Number(current.paddingPx) || 0)),
      "Improves the interactive hit area.",
    );
    add(
      "borderRadiusPx",
      String(Math.max(8, Number(current.borderRadiusPx) || 0)),
      "Creates a consistent interactive shape.",
    );
  }
  if (!proposed.length) {
    add(
      "paddingPx",
      String(Math.max(12, (Number(current.paddingPx) || 0) + 4)),
      "Improves balance with a restrained spacing adjustment.",
    );
    if (element.text)
      add("lineHeight", "1.4", "Improves readability while preserving the current typeface.");
  }
  return normalizeChanges(proposed, current);
}

function jsonObject(content: string): Record<string, unknown> | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function modelProposal(
  modelBaseUrl: string,
  prompt: string,
  element: LiveDesignElement,
  current: Record<LiveDesignProposalField, string>,
): Promise<{ summary: string; changes: LiveDesignProposalChange[] } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${modelBaseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "muse-glimmer",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are Glimmer Live Design. Propose safe visual edits for exactly one selected element. " +
              "Return JSON only: {summary:string,changes:[{field:string,after:string,reason:string}]}. " +
              `Allowed fields: ${[...ALLOWED_FIELDS].join(", ")}. Never return CSS blocks, URLs, scripts, or tool calls.`,
          },
          {
            role: "user",
            content: JSON.stringify({
              request: prompt,
              element: {
                tagName: element.tagName,
                text: element.text,
                attributes: element.attributes,
                componentName: element.componentName,
                tokens: element.tokens,
              },
              current,
            }),
          },
        ],
      }),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const parsed = jsonObject(content);
    if (!parsed) return null;
    const changes = normalizeChanges(parsed.changes, current);
    if (!changes.length) return null;
    const summary =
      typeof parsed.summary === "string" && parsed.summary.trim() && parsed.summary.length <= 500
        ? parsed.summary.trim()
        : "Glimmer prepared a scoped visual proposal.";
    return { summary, changes };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function proposeLiveDesignChange(
  modelBaseUrl: string,
  element: LiveDesignElement,
  prompt: string,
): Promise<LiveDesignProposalResponse> {
  const current = currentValues(element);
  const generated = await modelProposal(modelBaseUrl, prompt, element, current);
  const changes = generated?.changes ?? deterministicChanges(prompt, element, current);
  return {
    id: randomUUID(),
    prompt,
    summary:
      generated?.summary ??
      "Glimmer prepared a deterministic preview while the model was unavailable.",
    changes,
    provenance: generated ? "model-output" : "deterministic-fallback",
    createdAt: new Date().toISOString(),
  };
}
