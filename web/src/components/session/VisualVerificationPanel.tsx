import { useQuery } from "@tanstack/react-query";
import type { VisualFinding, VisualFindingSeverity } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { CollapsibleSection } from "../common/CollapsibleSection";
import { EmptyState } from "../common/EmptyState";
import { StatusBadge } from "../common/StatusBadge";

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

export function VisualVerificationPanel({ sessionId }: { sessionId: string }) {
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

  return (
    <CollapsibleSection title="Visual Verification" summary={summary}>
      <div style={{ marginBottom: 12 }}>
        <StatusBadge status={overallStatus} />
      </div>
      {manifest.viewports.map((viewport) => (
        <div key={viewport} style={{ marginBottom: 16 }}>
          <p className="mono" style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>{viewport}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {manifest.states.map((state) => {
              const capture = manifest.captures.find(
                (c) => c.viewport === viewport && (c.state ?? "initial") === state
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
                <a key={state} href={url} target="_blank" rel="noreferrer" className="visual-thumb">
                  <img src={url} alt={`${viewport} ${state}`} />
                  <span>{state}</span>
                </a>
              );
            })}
          </div>
        </div>
      ))}
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
