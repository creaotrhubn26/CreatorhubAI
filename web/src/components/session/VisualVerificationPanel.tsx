import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  DesignInspiration,
  DesignProfileReference,
  DesignReferenceImage,
  VisualCapture,
  VisualFinding,
  VisualFindingSeverity,
} from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { CollapsibleSection } from "../common/CollapsibleSection";
import { EmptyState } from "../common/EmptyState";
import { StatusBadge } from "../common/StatusBadge";

const LiveDesignBridge = lazy(() =>
  import("./LiveDesignBridge").then((module) => ({ default: module.LiveDesignBridge })),
);
const VisualFeedbackStudio = lazy(() =>
  import("./VisualFeedbackStudio").then((module) => ({ default: module.VisualFeedbackStudio })),
);

function DesignToolLoading({ label }: { label: string }) {
  return (
    <div className="visual-design-tool-loading" role="status">
      <span aria-hidden="true" />
      Loading {label}…
    </div>
  );
}

// V7 §22.5 severity model: critical/high both read as a real, actionable
// defect (red); medium is a warning (amber); low is muted -- present, but
// not something that should visually compete with an actual failure.
const SEVERITY_COLOR: Record<VisualFindingSeverity, string> = {
  critical: "var(--red)",
  high: "var(--red)",
  medium: "var(--amber)",
  low: "var(--text-muted)",
};

function SeverityChip({ severity }: { severity: VisualFindingSeverity }) {
  return (
    <span className="badge-check" style={{ ["--badge-color" as any]: SEVERITY_COLOR[severity] }}>
      {severity}
    </span>
  );
}

// Absent state (V7 §22.7) means "initial", same convention the finding
// itself was tagged with by _coerce_finding.
function FindingRow({ finding }: { finding: VisualFinding }) {
  return (
    <li style={{ marginBottom: 6 }}>
      <SeverityChip severity={finding.severity} />{" "}
      <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
        {finding.viewport ?? "?"} · {finding.state ?? "initial"}
      </span>{" "}
      {finding.description}
    </li>
  );
}

export function VisualVerificationPanel({
  sessionId,
  workspace = "",
  initialInspirations = [],
  initialDesignProfiles = [],
  initialReferenceImages = [],
}: {
  sessionId: string;
  workspace?: string;
  initialInspirations?: DesignInspiration[];
  initialDesignProfiles?: DesignProfileReference[];
  initialReferenceImages?: DesignReferenceImage[];
}) {
  const [selectedCapture, setSelectedCapture] = useState<VisualCapture | null>(null);
  const [showLiveEditor, setShowLiveEditor] = useState(false);
  // A session's own visual/ artifacts don't change once glimmer-visual.py
  // exits, but a repair loop can re-run it mid-session -- poll like the
  // other live session data, not a fetch-once artifact.
  const { data, isLoading } = useQuery({
    queryKey: ["visual-verification", sessionId],
    queryFn: () => glimmerApi.getVisualVerification(sessionId),
    enabled: !!sessionId,
    retry: false,
    refetchInterval: 4000,
  });

  // Still in flight -- render nothing rather than flash a false "Not run"
  // before the first response lands.
  if (isLoading) return null;

  // V7 §22.16: honest "Not run" (never silently omitted) when the session
  // never ran glimmer-visual.py at all -- collapsed by default so an
  // absent visual check doesn't compete for attention on every session.
  if (!data) {
    return (
      <CollapsibleSection title="Visual Verification" summary="Not run">
        <EmptyState icon="◌" text="Not run" />
      </CollapsibleSection>
    );
  }

  const { manifest, findings } = data;
  // findings.status is the real "did it pass" fact (build_findings) once
  // --vision ran; manifest.status only covers whether capture itself
  // succeeded, so it's the fallback when findings.json is missing.
  const overallStatus = findings?.status ?? manifest.status;
  const summary = `${overallStatus} · ${manifest.viewports.length} viewport${manifest.viewports.length === 1 ? "" : "s"}`;
  const references = findings?.references ?? manifest.references ?? [];
  const fallbackCapture =
    selectedCapture ??
    manifest.captures.find(
      (capture) => capture.status === "captured" && Boolean(capture.screenshot),
    );

  return (
    <CollapsibleSection title="Visual Verification" summary={summary}>
      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <StatusBadge status={overallStatus} />
        <button type="button" onClick={() => setShowLiveEditor((current) => !current)}>
          {showLiveEditor ? "Close live editor" : "Live edit"}
        </button>
      </div>
      {showLiveEditor && (
        <Suspense fallback={<DesignToolLoading label="Live Design" />}>
          <LiveDesignBridge
            sessionId={sessionId}
            route={manifest.route}
            capture={fallbackCapture}
            initialDesignProfiles={initialDesignProfiles}
          />
        </Suspense>
      )}
      {manifest.viewports.map((viewport) => (
        <div key={viewport} style={{ marginBottom: 16 }}>
          <p className="mono" style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
            {viewport}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {manifest.states.map((state) => {
              const capture = manifest.captures.find(
                (c) => c.viewport === viewport && (c.state ?? "initial") === state,
              );
              if (!capture || capture.status !== "captured" || !capture.screenshot) {
                return (
                  <div
                    key={state}
                    className="visual-thumb visual-thumb--missing"
                    title={capture?.error ?? "not captured"}
                  >
                    <span style={{ color: "var(--red)" }}>✕</span>
                    <span>{state}</span>
                  </div>
                );
              }
              const url = glimmerApi.visualScreenshotUrl(sessionId, capture.screenshot);
              return (
                <div key={state} className="visual-thumb-wrap">
                  <a href={url} target="_blank" rel="noreferrer" className="visual-thumb">
                    <img src={url} alt={`${viewport} ${state}`} />
                    <span>{state}</span>
                  </a>
                  <button type="button" onClick={() => setSelectedCapture(capture)}>
                    Annotate
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {selectedCapture?.screenshot && (
        <Suspense fallback={<DesignToolLoading label="visual feedback" />}>
          <VisualFeedbackStudio
            sessionId={sessionId}
            workspace={workspace}
            route={manifest.route}
            capture={selectedCapture}
            initialInspirations={initialInspirations}
            initialDesignProfiles={initialDesignProfiles}
            initialReferenceImages={initialReferenceImages}
          />
        </Suspense>
      )}
      {!!references.length && (
        <>
          <h3>Design references</h3>
          <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {findings?.referencesReviewedByModel?.length
              ? `Compared by Vision${findings.modelId ? ` (${findings.modelId})` : ""}.`
              : findings?.referenceImagePolicy === "vision-model"
                ? `Vision comparison was allowed${findings.modelId ? ` for ${findings.modelId}` : ""}, but no comparison completed.`
                : "Kept local for human review; not sent to Vision."}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            {references.map((reference) => (
              <a
                key={reference.file}
                href={glimmerApi.visualReferenceUrl(sessionId, reference.file)}
                target="_blank"
                rel="noreferrer"
                className="visual-thumb"
                title={reference.sourcePath ?? reference.label}
              >
                <img
                  src={glimmerApi.visualReferenceUrl(sessionId, reference.file)}
                  alt={reference.label}
                />
                <span>
                  {reference.label} · {reference.modelReviewed ? "Vision + human" : "human only"}
                </span>
              </a>
            ))}
          </div>
        </>
      )}
      {!!findings?.findings.length && (
        <>
          <h3>Findings</h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {findings.findings.map((f, i) => (
              <FindingRow key={f.id ?? i} finding={f} />
            ))}
          </ul>
        </>
      )}
    </CollapsibleSection>
  );
}
