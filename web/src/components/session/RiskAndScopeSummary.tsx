import type { RiskLevel, SessionAnalysis } from "@glimmer/shared";
import { CollapsibleSection } from "../common/CollapsibleSection";

const RISK_COLOR: Record<RiskLevel, string> = {
  LOW: "var(--green)",
  MEDIUM: "var(--amber)",
  HIGH: "var(--red)",
  CRITICAL: "var(--red)",
};
const SEVERE_RISK: ReadonlySet<RiskLevel> = new Set(["HIGH", "CRITICAL"]);

// Note: intentionally never the literal substring "SCOPE EXPANSION" (case
// insensitively) — that string is reserved for the callout box itself so a
// single test/user query can't match both the summary and the real notice.
function scopeSummary(analysis: SessionAnalysis): string {
  if (analysis.scopeGuard === null) return "scope unknown";
  if (analysis.scopeGuard.unbounded) return "scope unbounded";
  if (!analysis.scopeGuard.inScope) return "scope expanded outside plan";
  return "in scope";
}

export function RiskAndScopeSummary({ analysis }: { analysis: SessionAnalysis }) {
  const severe = SEVERE_RISK.has(analysis.riskScore);
  const color = RISK_COLOR[analysis.riskScore] ?? "var(--gray)";
  const summary = `${analysis.riskScore.toLowerCase()} risk · ${scopeSummary(analysis)}`;

  return (
    <CollapsibleSection title="Risk & Scope" summary={summary} defaultOpen>
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Live — computed from this session's actual changed files ({analysis.provenance})
      </p>
      <dl className="kv-grid">
        <div>
          <dt>Risk level</dt>
          <dd>
            <span
              className={`meta-value risk-${analysis.riskScore.toLowerCase()}`}
              style={{ ["--badge-color" as any]: color, fontWeight: severe ? 700 : 600 }}
            >
              {analysis.riskScore}
            </span>
          </dd>
        </div>
      </dl>
      {analysis.scopeGuard === null && (
        <p>Scope guard: Unavailable — no task contract on record for this session.</p>
      )}
      {analysis.scopeGuard?.unbounded && (
        <p>
          Scope guard: Unbounded — this task's scope had no concrete path set, so scope could not be
          verified.
        </p>
      )}
      {analysis.scopeGuard && !analysis.scopeGuard.unbounded && !analysis.scopeGuard.inScope && (
        <div
          style={{
            border: "1px solid var(--red)",
            borderRadius: "var(--radius)",
            padding: 8,
            marginTop: 8,
          }}
        >
          <strong style={{ color: "var(--red)" }}>SCOPE EXPANSION</strong>
          <dl>
            <dt>Expected</dt>
            <dd>{analysis.scopeGuard.expected.join(", ")}</dd>
            <dt>Actual</dt>
            <dd>{analysis.scopeGuard.actual.join(", ")}</dd>
            <dt>Files outside declared scope</dt>
            <dd>{analysis.scopeGuard.expandedFiles.join(", ")}</dd>
          </dl>
        </div>
      )}
    </CollapsibleSection>
  );
}
