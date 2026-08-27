import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type {
  DesignAssetAspectRatio,
  DesignAssetKind,
  DesignAssetRequest,
  DesignElementEdit,
  DesignElementStyleEdit,
  DesignFeedbackAnnotation,
  DesignFeedbackPoint,
  DesignFeedbackTool,
  DesignChangeSetFeedbackRefs,
  DesignInspiration,
  DesignReferenceImage,
  DesignRegion,
  DesignVariantRequest,
  VisualCapture,
} from "@glimmer/shared";
import { glimmerApi } from "../../api/client";

interface Props {
  sessionId: string;
  workspace: string;
  route: string;
  capture: VisualCapture;
  initialInspirations: DesignInspiration[];
  initialReferenceImages: DesignReferenceImage[];
}

type StudioMode = "edit" | "draw" | "generate";
type DrawTool = Extract<
  DesignFeedbackTool,
  "comment" | "draw" | "rectangle" | "ellipse" | "arrow" | "sticky"
>;

function normalizedPoint(event: React.PointerEvent<SVGSVGElement>): DesignFeedbackPoint {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  };
}

function positionLabel(point: DesignFeedbackPoint): string {
  return `${Math.round(point.x * 100)}%, ${Math.round(point.y * 100)}%`;
}

function selectedRegion(points: DesignFeedbackPoint[]): DesignRegion | null {
  if (!points[0]) return null;
  if (!points[1]) return { x: points[0].x, y: points[0].y };
  const x = Math.min(points[0].x, points[1].x);
  const y = Math.min(points[0].y, points[1].y);
  return {
    x,
    y,
    width: Math.max(0, Math.max(points[0].x, points[1].x) - x),
    height: Math.max(0, Math.max(points[0].y, points[1].y) - y),
  };
}

function annotationLine(annotation: DesignFeedbackAnnotation): string {
  const point = annotation.points[0];
  const change = annotation.value ? ` (${annotation.tool}: ${annotation.value})` : "";
  return `- ${annotation.viewport}/${annotation.state} at ${positionLabel(point)}: ${annotation.comment}${change}`;
}

function elementEditLine(edit: DesignElementEdit): string {
  const changes = [
    edit.text !== undefined ? `text=${JSON.stringify(edit.text)}` : "",
    edit.imageSource ? `image=${edit.imageSource}` : "",
    ...Object.entries(edit.style).map(([key, value]) => `${key}=${value}`),
  ].filter(Boolean);
  const binding = [edit.sourcePathHint, edit.selectorHint].filter(Boolean).join(" · ");
  return `- Edit ${edit.target} at ${positionLabel(edit.region)}${binding ? ` (${binding})` : ""}: ${changes.join(", ")}`;
}

function assetLine(asset: DesignAssetRequest): string {
  const references = asset.referenceImages.map((item) => item.path).join(", ");
  return `- Generate ${asset.kind} ${asset.outputPath} (${asset.aspectRatio}) from: ${asset.prompt}${references ? `; references: ${references}` : ""}`;
}

function parseReferences(value: string): DesignReferenceImage[] {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((entry) => {
      const parts = entry.split("|").map((part) => part.trim());
      return parts.length > 1
        ? { label: parts.slice(0, -1).join(" | "), path: parts.at(-1)! }
        : { path: entry };
    });
}

function AnnotationShape({ annotation }: { annotation: DesignFeedbackAnnotation }) {
  const start = annotation.points[0];
  const end = annotation.points.at(-1) ?? start;
  const x = Math.min(start.x, end.x) * 1000;
  const y = Math.min(start.y, end.y) * 1000;
  const width = Math.abs(end.x - start.x) * 1000;
  const height = Math.abs(end.y - start.y) * 1000;
  const stroke = annotation.strokeColor ?? "#72d6cc";
  const fill = annotation.fillColor ?? "transparent";
  const strokeWidth = annotation.strokeWidth ?? 2;
  const common = {
    style: { stroke, fill, strokeWidth },
    vectorEffect: "non-scaling-stroke" as const,
  };
  if (annotation.tool === "draw") {
    return (
      <polyline
        points={annotation.points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(" ")}
        {...common}
      />
    );
  }
  if (annotation.tool === "rectangle")
    return <rect x={x} y={y} width={width} height={height} {...common} />;
  if (annotation.tool === "ellipse") {
    return (
      <ellipse cx={x + width / 2} cy={y + height / 2} rx={width / 2} ry={height / 2} {...common} />
    );
  }
  if (annotation.tool === "arrow") {
    return (
      <line
        x1={start.x * 1000}
        y1={start.y * 1000}
        x2={end.x * 1000}
        y2={end.y * 1000}
        {...common}
        markerEnd="url(#visual-feedback-arrow)"
      />
    );
  }
  if (annotation.tool === "sticky") {
    return (
      <g transform={`translate(${start.x * 1000} ${start.y * 1000})`}>
        <rect
          width="230"
          height="110"
          rx="12"
          stroke={stroke}
          fill={annotation.fillColor ?? "#fff2a8"}
          strokeWidth={strokeWidth}
        />
        <text x="14" y="30" className="visual-feedback-canvas__sticky-text">
          {annotation.comment.slice(0, 32)}
        </text>
      </g>
    );
  }
  return (
    <g transform={`translate(${start.x * 1000} ${start.y * 1000})`}>
      <circle r="16" {...common} fill={fill === "transparent" ? "#121317" : fill} />
      <text x="24" y="6">
        {annotation.tool}
      </text>
    </g>
  );
}

export function VisualFeedbackStudio({
  sessionId,
  workspace,
  route,
  capture,
  initialInspirations,
  initialReferenceImages,
}: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const feedback = useQuery({
    queryKey: ["design-feedback", sessionId],
    queryFn: () => glimmerApi.getDesignFeedback(sessionId),
    retry: false,
  });
  const workflow = useQuery({
    queryKey: ["design-workflow", sessionId],
    queryFn: () => glimmerApi.getDesignWorkflow(sessionId),
    retry: false,
  });
  const activeChangeSet = workflow.data?.changeSets.find(
    (item) => item.id === workflow.data?.activeChangeSetId,
  );
  const [annotations, setAnnotations] = useState<DesignFeedbackAnnotation[]>([]);
  const [variants, setVariants] = useState<DesignVariantRequest[]>([]);
  const [inspirations, setInspirations] = useState<DesignInspiration[]>(initialInspirations);
  const [elementEdits, setElementEdits] = useState<DesignElementEdit[]>([]);
  const [assetRequests, setAssetRequests] = useState<DesignAssetRequest[]>([]);
  const hydrated = useRef(false);
  useEffect(() => {
    if (feedback.isLoading || hydrated.current) return;
    hydrated.current = true;
    setAnnotations(feedback.data?.annotations ?? []);
    setVariants(feedback.data?.variants ?? []);
    setInspirations(
      feedback.data?.inspirations?.length ? feedback.data.inspirations : initialInspirations,
    );
    setElementEdits(feedback.data?.elementEdits ?? []);
    setAssetRequests(feedback.data?.assetRequests ?? []);
  }, [feedback.data, feedback.isLoading, initialInspirations]);

  const mutation = useMutation({ mutationFn: glimmerApi.saveDesignFeedback.bind(null, sessionId) });
  const [workflowLinkError, setWorkflowLinkError] = useState("");
  const [mode, setMode] = useState<StudioMode>("edit");
  const [tool, setTool] = useState<DrawTool>("draw");
  const [comment, setComment] = useState("");
  const [points, setPoints] = useState<DesignFeedbackPoint[]>([]);
  const [strokeColor, setStrokeColor] = useState("#72d6cc");
  const [fillColor, setFillColor] = useState("#fff2a8");
  const [strokeWidth, setStrokeWidth] = useState<1 | 2 | 4 | 8>(2);
  const drawing = useRef(false);
  const screenshot = capture.screenshot!;

  const [editTarget, setEditTarget] = useState("");
  const [selectorHint, setSelectorHint] = useState("");
  const [sourcePathHint, setSourcePathHint] = useState("");
  const [expectedText, setExpectedText] = useState("");
  const [changeText, setChangeText] = useState(false);
  const [replacementText, setReplacementText] = useState("");
  const [imageSource, setImageSource] = useState("");
  const [styleDraft, setStyleDraft] = useState({
    textColor: "",
    backgroundColor: "",
    fontFamily: "",
    fontSizePx: "",
    fontWeight: "",
    lineHeight: "",
    paddingPx: "",
    marginPx: "",
    gapPx: "",
    borderColor: "",
    borderWidthPx: "",
    borderRadiusPx: "",
    opacity: "",
    direction: "",
    align: "",
  });

  const [variantTarget, setVariantTarget] = useState("");
  const [variantDirections, setVariantDirections] = useState("");
  const [variantCount, setVariantCount] = useState<2 | 3 | 4>(3);

  const [assetKind, setAssetKind] = useState<DesignAssetKind>("image");
  const [assetPrompt, setAssetPrompt] = useState("");
  const [assetOutputPath, setAssetOutputPath] = useState("public/generated/asset.png");
  const [assetAspectRatio, setAssetAspectRatio] = useState<DesignAssetAspectRatio>("16:9");
  const [assetSize, setAssetSize] = useState<"1K" | "2K" | "4K">("2K");
  const [assetResolution, setAssetResolution] = useState<"720p" | "1080p">("720p");
  const [assetDuration, setAssetDuration] = useState<2 | 4 | 6 | 8>(4);
  const [assetAudio, setAssetAudio] = useState(false);
  const [assetAnimated, setAssetAnimated] = useState(false);
  const [assetReferencePaths, setAssetReferencePaths] = useState(() =>
    initialReferenceImages
      .map((reference) =>
        reference.label ? `${reference.label} | ${reference.path}` : reference.path,
      )
      .join("\n"),
  );
  const [allowAssetReferenceUpload, setAllowAssetReferenceUpload] = useState(false);

  const currentAnnotations = useMemo(
    () => annotations.filter((annotation) => annotation.screenshot === screenshot),
    [annotations, screenshot],
  );
  const currentEdits = useMemo(
    () => elementEdits.filter((edit) => edit.screenshot === screenshot),
    [elementEdits, screenshot],
  );

  async function persist(
    next: {
      annotations: DesignFeedbackAnnotation[];
      variants: DesignVariantRequest[];
      inspirations: DesignInspiration[];
      elementEdits: DesignElementEdit[];
      assetRequests: DesignAssetRequest[];
    },
    options: {
      link?: Partial<DesignChangeSetFeedbackRefs>;
      unlink?: Partial<DesignChangeSetFeedbackRefs>;
    } = {},
  ): Promise<boolean> {
    try {
      const saved = await mutation.mutateAsync(next);
      setAnnotations(saved.annotations);
      setVariants(saved.variants);
      setInspirations(saved.inspirations);
      setElementEdits(saved.elementEdits);
      setAssetRequests(saved.assetRequests);
      if (activeChangeSet && workflow.data && (options.link || options.unlink)) {
        try {
          let currentWorkflow = workflow.data;
          if (options.link) {
            currentWorkflow = await glimmerApi.linkDesignWorkflowFeedback(
              sessionId,
              activeChangeSet.id,
              { expectedRevision: currentWorkflow.revision, refs: options.link },
            );
          }
          if (options.unlink) {
            currentWorkflow = await glimmerApi.unlinkDesignWorkflowFeedback(
              sessionId,
              activeChangeSet.id,
              { expectedRevision: currentWorkflow.revision, refs: options.unlink },
            );
          }
          queryClient.setQueryData(["design-workflow", sessionId], currentWorkflow);
          setWorkflowLinkError("");
        } catch (error) {
          setWorkflowLinkError(
            `Feedback was saved, but its workflow link needs a refresh: ${error instanceof Error ? error.message : "unknown error"}`,
          );
          void queryClient.invalidateQueries({ queryKey: ["design-workflow", sessionId] });
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  function currentDocument(patch: Partial<Parameters<typeof persist>[0]> = {}) {
    return { annotations, variants, inspirations, elementEdits, assetRequests, ...patch };
  }

  function chooseMode(next: StudioMode) {
    setMode(next);
    setPoints([]);
    drawing.current = false;
  }

  function pointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (mode === "generate") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = normalizedPoint(event);
    drawing.current = mode === "draw" && ["draw", "rectangle", "ellipse", "arrow"].includes(tool);
    setPoints([point]);
  }

  function pointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!drawing.current) return;
    const point = normalizedPoint(event);
    setPoints((current) =>
      tool === "draw"
        ? current.length >= 500
          ? current
          : [...current, point]
        : [current[0], point],
    );
  }

  function pointerUp() {
    drawing.current = false;
  }

  async function addAnnotation() {
    if (!points.length || !comment.trim()) return;
    const next = [
      ...annotations,
      {
        id: crypto.randomUUID(),
        screenshot,
        viewport: capture.viewport,
        state: capture.state ?? "initial",
        tool,
        points,
        comment: comment.trim(),
        strokeColor,
        ...(tool === "sticky" || tool === "rectangle" || tool === "ellipse" ? { fillColor } : {}),
        strokeWidth,
        createdAt: new Date().toISOString(),
      } satisfies DesignFeedbackAnnotation,
    ];
    const annotation = next.at(-1)!;
    if (
      !(await persist(currentDocument({ annotations: next }), {
        link: { annotationIds: [annotation.id] },
      }))
    )
      return;
    setComment("");
    setPoints([]);
  }

  function numericStyle(
    key: keyof DesignElementStyleEdit,
    value: string,
    target: DesignElementStyleEdit,
  ) {
    if (value.trim() !== "") (target as Record<string, unknown>)[key] = Number(value);
  }

  async function addElementEdit() {
    const region = selectedRegion(points);
    if (!region || !editTarget.trim()) return;
    const style: DesignElementStyleEdit = {};
    if (styleDraft.textColor) style.textColor = styleDraft.textColor;
    if (styleDraft.backgroundColor) style.backgroundColor = styleDraft.backgroundColor;
    if (styleDraft.fontFamily.trim()) style.fontFamily = styleDraft.fontFamily.trim();
    for (const key of [
      "fontSizePx",
      "fontWeight",
      "lineHeight",
      "paddingPx",
      "marginPx",
      "gapPx",
      "borderWidthPx",
      "borderRadiusPx",
      "opacity",
    ] as const) {
      numericStyle(key, styleDraft[key], style);
    }
    if (styleDraft.borderColor) style.borderColor = styleDraft.borderColor;
    if (styleDraft.direction) style.direction = styleDraft.direction as "row" | "column";
    if (styleDraft.align) style.align = styleDraft.align as DesignElementStyleEdit["align"];
    if (!changeText && !imageSource.trim() && !Object.keys(style).length) return;
    const edit: DesignElementEdit = {
      id: crypto.randomUUID(),
      target: editTarget.trim(),
      screenshot,
      viewport: capture.viewport,
      state: capture.state ?? "initial",
      region,
      ...(selectorHint.trim() ? { selectorHint: selectorHint.trim() } : {}),
      ...(sourcePathHint.trim() ? { sourcePathHint: sourcePathHint.trim() } : {}),
      ...(expectedText ? { expectedText } : {}),
      ...(changeText ? { text: replacementText } : {}),
      ...(imageSource.trim() ? { imageSource: imageSource.trim() } : {}),
      style,
      createdAt: new Date().toISOString(),
    };
    if (
      !(await persist(currentDocument({ elementEdits: [...elementEdits, edit] }), {
        link: { elementEditIds: [edit.id] },
      }))
    )
      return;
    setEditTarget("");
    setSelectorHint("");
    setSourcePathHint("");
    setExpectedText("");
    setChangeText(false);
    setReplacementText("");
    setImageSource("");
    setStyleDraft(
      (current) =>
        Object.fromEntries(Object.keys(current).map((key) => [key, ""])) as typeof current,
    );
    setPoints([]);
  }

  async function addVariant() {
    const directions = variantDirections
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 4);
    if (!variantTarget.trim() || !directions.length) return;
    const region = selectedRegion(points);
    const next = [
      ...variants,
      {
        id: crypto.randomUUID(),
        target: variantTarget.trim(),
        count: variantCount,
        directions,
        screenshot,
        ...(region ? { region } : {}),
      } satisfies DesignVariantRequest,
    ];
    const variant = next.at(-1)!;
    if (
      !(await persist(currentDocument({ variants: next }), {
        link: { variantIds: [variant.id] },
      }))
    )
      return;
    setVariantTarget("");
    setVariantDirections("");
  }

  function updateAssetKind(next: DesignAssetKind) {
    setAssetKind(next);
    setAssetOutputPath(
      next === "image"
        ? "public/generated/asset.png"
        : next === "video"
          ? "public/generated/asset.mp4"
          : "public/generated/asset.svg",
    );
  }

  async function addAssetRequest() {
    if (!assetPrompt.trim() || !assetOutputPath.trim()) return;
    const common = {
      id: crypto.randomUUID(),
      prompt: assetPrompt.trim(),
      outputPath: assetOutputPath.trim(),
      aspectRatio: assetAspectRatio,
      referenceImages: parseReferences(assetReferencePaths),
      referenceUploadPolicy: allowAssetReferenceUpload
        ? ("generation-model" as const)
        : ("local-only" as const),
      screenshot,
      createdAt: new Date().toISOString(),
    };
    const request: DesignAssetRequest =
      assetKind === "image"
        ? { ...common, kind: assetKind, size: assetSize }
        : assetKind === "video"
          ? {
              ...common,
              kind: assetKind,
              resolution: assetResolution,
              durationSeconds: assetDuration,
              audio: assetAudio,
            }
          : { ...common, kind: assetKind, animated: assetAnimated };
    if (
      !(await persist(currentDocument({ assetRequests: [...assetRequests, request] }), {
        link: { assetRequestIds: [request.id] },
      }))
    )
      return;
    setAssetPrompt("");
  }

  function draftFollowup() {
    const objective = [
      `Implement the approved visual feedback from session ${sessionId}.`,
      ...annotations.map(annotationLine),
      ...elementEdits.map(elementEditLine),
      ...variants.map(
        (variant) =>
          `- Generate ${variant.count} implementation variants for ${variant.target}: ${variant.directions.join("; ")}`,
      ),
      ...assetRequests.map(assetLine),
      "Preserve the repository's CMS/content model and semantic design tokens.",
      "For media requests, use a real configured generator and report BLOCKED if none is available; never fabricate an output file.",
    ].join("\n");
    navigate("/tasks/new", {
      state: {
        objective,
        workspace,
        designDraft: {
          designTargetUrl: route,
          designRequirements: annotations.map(annotationLine).join("\n"),
          designInspirations: inspirations,
          designVariants: variants,
          designElementEdits: elementEdits,
          designAssetRequests: assetRequests,
        },
      },
    });
  }

  return (
    <div className="visual-feedback-studio">
      <div className="visual-feedback-studio__header">
        <div>
          <h3>Visual workspace</h3>
          <p>Select an area, edit its properties, draw instructions, or queue matching assets.</p>
        </div>
        <span className="mono">
          {capture.viewport} · {capture.state ?? "initial"}
        </span>
      </div>
      <div className="visual-feedback-toolbar" role="toolbar" aria-label="Visual workspace tools">
        {(["edit", "draw", "generate"] as const).map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={mode === item}
            className={mode === item ? "is-active" : ""}
            onClick={() => chooseMode(item)}
          >
            {item === "edit" ? "Edit" : item === "draw" ? "Draw" : "Generate"}
          </button>
        ))}
      </div>
      <div className="visual-feedback-studio__workspace">
        <div className="visual-feedback-canvas">
          <img
            src={glimmerApi.visualScreenshotUrl(sessionId, screenshot)}
            alt="Visual feedback canvas"
          />
          <svg
            viewBox="0 0 1000 1000"
            preserveAspectRatio="none"
            aria-label="Clickable visual annotation layer"
            className={`visual-feedback-canvas--${mode}`}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
          >
            <defs>
              <marker
                id="visual-feedback-arrow"
                markerWidth="10"
                markerHeight="10"
                refX="8"
                refY="3"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M0,0 L0,6 L9,3 z" fill="context-stroke" />
              </marker>
            </defs>
            {currentAnnotations.map((annotation) => (
              <AnnotationShape key={annotation.id} annotation={annotation} />
            ))}
            {currentEdits.map((edit) => (
              <g
                key={edit.id}
                transform={`translate(${edit.region.x * 1000} ${edit.region.y * 1000})`}
              >
                <circle r="18" className="visual-feedback-canvas__edit-pin" />
                <text x="26" y="6">
                  edit · {edit.target.slice(0, 28)}
                </text>
              </g>
            ))}
            {points.length > 1 ? (
              tool === "draw" && mode === "draw" ? (
                <polyline
                  className="visual-feedback-canvas__draft"
                  points={points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(" ")}
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                <rect
                  className="visual-feedback-canvas__draft"
                  x={Math.min(points[0].x, points[1].x) * 1000}
                  y={Math.min(points[0].y, points[1].y) * 1000}
                  width={Math.abs(points[1].x - points[0].x) * 1000}
                  height={Math.abs(points[1].y - points[0].y) * 1000}
                />
              )
            ) : points[0] ? (
              <circle
                className="visual-feedback-canvas__draft"
                cx={points[0].x * 1000}
                cy={points[0].y * 1000}
                r="18"
              />
            ) : null}
          </svg>
        </div>
        <div className="visual-feedback-studio__controls">
          {mode === "edit" && (
            <>
              <strong>Edit selected element</strong>
              <small>
                Click an element area. Glimmer resolves the owning component from repository
                evidence before editing source.
              </small>
              <label>
                Element name
                <input
                  value={editTarget}
                  maxLength={500}
                  onChange={(event) => setEditTarget(event.target.value)}
                  placeholder="Primary checkout button"
                />
              </label>
              <details>
                <summary>Source hints (optional)</summary>
                <label>
                  Selector hint
                  <input
                    value={selectorHint}
                    maxLength={500}
                    onChange={(event) => setSelectorHint(event.target.value)}
                    placeholder="button[data-action='checkout']"
                  />
                </label>
                <label>
                  Source path hint
                  <input
                    value={sourcePathHint}
                    maxLength={4_096}
                    onChange={(event) => setSourcePathHint(event.target.value)}
                    placeholder="src/components/CheckoutButton.tsx"
                  />
                </label>
                <label>
                  Current visible text
                  <input
                    value={expectedText}
                    maxLength={5_000}
                    onChange={(event) => setExpectedText(event.target.value)}
                  />
                </label>
              </details>
              <label>
                <input
                  type="checkbox"
                  checked={changeText}
                  onChange={(event) => setChangeText(event.target.checked)}
                />
                Change text
              </label>
              {changeText && (
                <label>
                  New text
                  <textarea
                    value={replacementText}
                    maxLength={5_000}
                    onChange={(event) => setReplacementText(event.target.value)}
                  />
                </label>
              )}
              <label>
                Replace image with workspace path
                <input
                  value={imageSource}
                  maxLength={4_096}
                  onChange={(event) => setImageSource(event.target.value)}
                  placeholder="public/images/new-hero.webp"
                />
              </label>
              <div className="visual-edit-grid">
                <label>
                  Text color
                  <input
                    value={styleDraft.textColor}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, textColor: event.target.value })
                    }
                    placeholder="#ffffff"
                  />
                </label>
                <label>
                  Background
                  <input
                    value={styleDraft.backgroundColor}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, backgroundColor: event.target.value })
                    }
                    placeholder="#16171a"
                  />
                </label>
                <label>
                  Font family
                  <input
                    value={styleDraft.fontFamily}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, fontFamily: event.target.value })
                    }
                    placeholder="Existing semantic font"
                  />
                </label>
                <label>
                  Font size px
                  <input
                    type="number"
                    value={styleDraft.fontSizePx}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, fontSizePx: event.target.value })
                    }
                  />
                </label>
                <label>
                  Weight
                  <input
                    type="number"
                    step="100"
                    value={styleDraft.fontWeight}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, fontWeight: event.target.value })
                    }
                  />
                </label>
                <label>
                  Line height
                  <input
                    type="number"
                    step="0.1"
                    value={styleDraft.lineHeight}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, lineHeight: event.target.value })
                    }
                  />
                </label>
                <label>
                  Padding px
                  <input
                    type="number"
                    value={styleDraft.paddingPx}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, paddingPx: event.target.value })
                    }
                  />
                </label>
                <label>
                  Margin px
                  <input
                    type="number"
                    value={styleDraft.marginPx}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, marginPx: event.target.value })
                    }
                  />
                </label>
                <label>
                  Gap px
                  <input
                    type="number"
                    value={styleDraft.gapPx}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, gapPx: event.target.value })
                    }
                  />
                </label>
                <label>
                  Border color
                  <input
                    value={styleDraft.borderColor}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, borderColor: event.target.value })
                    }
                    placeholder="#72d6cc"
                  />
                </label>
                <label>
                  Border width
                  <input
                    type="number"
                    value={styleDraft.borderWidthPx}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, borderWidthPx: event.target.value })
                    }
                  />
                </label>
                <label>
                  Radius px
                  <input
                    type="number"
                    value={styleDraft.borderRadiusPx}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, borderRadiusPx: event.target.value })
                    }
                  />
                </label>
                <label>
                  Opacity
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    value={styleDraft.opacity}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, opacity: event.target.value })
                    }
                  />
                </label>
                <label>
                  Direction
                  <select
                    value={styleDraft.direction}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, direction: event.target.value })
                    }
                  >
                    <option value="">Unchanged</option>
                    <option value="row">Row</option>
                    <option value="column">Column</option>
                  </select>
                </label>
                <label>
                  Alignment
                  <select
                    value={styleDraft.align}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, align: event.target.value })
                    }
                  >
                    <option value="">Unchanged</option>
                    <option value="start">Start</option>
                    <option value="center">Center</option>
                    <option value="end">End</option>
                    <option value="space-between">Space between</option>
                  </select>
                </label>
              </div>
              <button
                type="button"
                disabled={!points.length || !editTarget.trim() || mutation.isPending}
                onClick={() => void addElementEdit()}
              >
                Save element edit
              </button>
              <hr />
              <strong>Generate variants for this area</strong>
              <label>
                Target
                <input
                  value={variantTarget}
                  maxLength={500}
                  onChange={(event) => setVariantTarget(event.target.value)}
                  placeholder="Selected pricing card"
                />
              </label>
              <label>
                Count
                <select
                  value={variantCount}
                  onChange={(event) => setVariantCount(Number(event.target.value) as 2 | 3 | 4)}
                >
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                  <option value={4}>4</option>
                </select>
              </label>
              <label>
                Directions
                <textarea
                  value={variantDirections}
                  onChange={(event) => setVariantDirections(event.target.value)}
                  placeholder={"One per line\nCompact action row\nEditorial hierarchy"}
                />
              </label>
              <button
                type="button"
                disabled={!variantTarget.trim() || !variantDirections.trim() || mutation.isPending}
                onClick={() => void addVariant()}
              >
                Save variant request
              </button>
            </>
          )}
          {mode === "draw" && (
            <>
              <strong>Draw markup</strong>
              <label>
                Tool
                <select
                  value={tool}
                  onChange={(event) => {
                    setTool(event.target.value as DrawTool);
                    setPoints([]);
                  }}
                >
                  <option value="draw">Freehand</option>
                  <option value="rectangle">Rectangle</option>
                  <option value="ellipse">Circle / ellipse</option>
                  <option value="arrow">Arrow</option>
                  <option value="sticky">Sticky note</option>
                  <option value="comment">Comment pin</option>
                </select>
              </label>
              <div className="visual-draw-properties">
                <label>
                  Stroke
                  <input
                    type="color"
                    value={strokeColor}
                    onChange={(event) => setStrokeColor(event.target.value)}
                  />
                </label>
                <label>
                  Fill
                  <input
                    type="color"
                    value={fillColor}
                    onChange={(event) => setFillColor(event.target.value)}
                  />
                </label>
                <label>
                  Width
                  <select
                    value={strokeWidth}
                    onChange={(event) =>
                      setStrokeWidth(Number(event.target.value) as 1 | 2 | 4 | 8)
                    }
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={4}>4</option>
                    <option value={8}>8</option>
                  </select>
                </label>
              </div>
              <label>
                Instruction
                <textarea
                  value={comment}
                  maxLength={2_000}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="What should Glimmer change here?"
                />
              </label>
              <button
                type="button"
                disabled={!points.length || !comment.trim() || mutation.isPending}
                onClick={() => void addAnnotation()}
              >
                Save markup
              </button>
            </>
          )}
          {mode === "generate" && (
            <>
              <strong>Generate project-matched asset</strong>
              <small>
                The capture identity, selected Mobbin patterns, and declared workspace references
                stay attached as design context.
              </small>
              <label>
                Kind
                <select
                  value={assetKind}
                  onChange={(event) => updateAssetKind(event.target.value as DesignAssetKind)}
                >
                  <option value="image">Image</option>
                  <option value="video">Video</option>
                  <option value="vector">Vector graphic</option>
                </select>
              </label>
              <label>
                Prompt
                <textarea
                  value={assetPrompt}
                  maxLength={2_000}
                  onChange={(event) => setAssetPrompt(event.target.value)}
                  placeholder="Describe subject, composition, style, palette, and intended UI placement."
                />
              </label>
              <label>
                Output path
                <input
                  value={assetOutputPath}
                  maxLength={4_096}
                  onChange={(event) => setAssetOutputPath(event.target.value)}
                />
              </label>
              <label>
                Aspect ratio
                <select
                  value={assetAspectRatio}
                  onChange={(event) =>
                    setAssetAspectRatio(event.target.value as DesignAssetAspectRatio)
                  }
                >
                  {(["1:1", "16:9", "9:16", "4:3", "3:4"] as const).map((ratio) => (
                    <option key={ratio} value={ratio}>
                      {ratio}
                    </option>
                  ))}
                </select>
              </label>
              {assetKind === "image" && (
                <label>
                  Size
                  <select
                    value={assetSize}
                    onChange={(event) => setAssetSize(event.target.value as "1K" | "2K" | "4K")}
                  >
                    <option value="1K">1K</option>
                    <option value="2K">2K</option>
                    <option value="4K">4K</option>
                  </select>
                </label>
              )}
              {assetKind === "video" && (
                <>
                  <label>
                    Resolution
                    <select
                      value={assetResolution}
                      onChange={(event) =>
                        setAssetResolution(event.target.value as "720p" | "1080p")
                      }
                    >
                      <option value="720p">720p</option>
                      <option value="1080p">1080p</option>
                    </select>
                  </label>
                  <label>
                    Duration
                    <select
                      value={assetDuration}
                      onChange={(event) =>
                        setAssetDuration(Number(event.target.value) as 2 | 4 | 6 | 8)
                      }
                    >
                      {[2, 4, 6, 8].map((seconds) => (
                        <option key={seconds} value={seconds}>
                          {seconds}s
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={assetAudio}
                      onChange={(event) => setAssetAudio(event.target.checked)}
                    />
                    Include audio
                  </label>
                </>
              )}
              {assetKind === "vector" && (
                <label>
                  <input
                    type="checkbox"
                    checked={assetAnimated}
                    onChange={(event) => setAssetAnimated(event.target.checked)}
                  />
                  Animated SVG
                </label>
              )}
              <label>
                Workspace reference images
                <textarea
                  value={assetReferencePaths}
                  onChange={(event) => setAssetReferencePaths(event.target.value)}
                  placeholder={"One per line\nBrand reference | design/brand.png"}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={allowAssetReferenceUpload}
                  onChange={(event) => setAllowAssetReferenceUpload(event.target.checked)}
                />
                Allow local reference-image bytes to be sent to the generation model
              </label>
              <button
                type="button"
                disabled={!assetPrompt.trim() || !assetOutputPath.trim() || mutation.isPending}
                onClick={() => void addAssetRequest()}
              >
                Save generation request
              </button>
            </>
          )}
        </div>
      </div>
      {mutation.error && (
        <p role="alert">Feedback was not saved — {(mutation.error as Error).message}</p>
      )}
      {mutation.isPending && <p role="status">Saving visual workspace atomically…</p>}
      {mutation.isSuccess && <p role="status">Visual workspace saved to this session.</p>}
      <div className="visual-feedback-studio__saved">
        {!!elementEdits.length && (
          <p>
            {elementEdits.length} saved element edit{elementEdits.length === 1 ? "" : "s"}.
          </p>
        )}
        {!!annotations.length && (
          <p>
            {annotations.length} saved markup instruction{annotations.length === 1 ? "" : "s"}.
          </p>
        )}
        {!!variants.length && (
          <p>
            {variants.length} saved variant request{variants.length === 1 ? "" : "s"}.
          </p>
        )}
        {!!assetRequests.length && (
          <p>
            {assetRequests.length} saved asset request{assetRequests.length === 1 ? "" : "s"}.
          </p>
        )}
      </div>
      <ul className="visual-feedback-studio__items">
        {elementEdits.map((edit) => (
          <li key={edit.id}>
            <span>{elementEditLine(edit).slice(2)}</span>
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() =>
                void persist(
                  currentDocument({
                    elementEdits: elementEdits.filter((item) => item.id !== edit.id),
                  }),
                  { unlink: { elementEditIds: [edit.id] } },
                )
              }
            >
              Remove
            </button>
          </li>
        ))}
        {annotations.map((annotation) => (
          <li key={annotation.id}>
            <span>{annotationLine(annotation).slice(2)}</span>
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() =>
                void persist(
                  currentDocument({
                    annotations: annotations.filter((item) => item.id !== annotation.id),
                  }),
                  { unlink: { annotationIds: [annotation.id] } },
                )
              }
            >
              Remove
            </button>
          </li>
        ))}
        {assetRequests.map((asset) => (
          <li key={asset.id}>
            <span>{assetLine(asset).slice(2)}</span>
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() =>
                void persist(
                  currentDocument({
                    assetRequests: assetRequests.filter((item) => item.id !== asset.id),
                  }),
                  { unlink: { assetRequestIds: [asset.id] } },
                )
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {workflowLinkError && (
        <p className="design-workflow__error" role="alert">
          {workflowLinkError}
        </p>
      )}
      <button
        type="button"
        disabled={
          mutation.isPending ||
          (!annotations.length && !variants.length && !elementEdits.length && !assetRequests.length)
        }
        onClick={draftFollowup}
      >
        Create Glimmer implementation draft
      </button>
    </div>
  );
}
