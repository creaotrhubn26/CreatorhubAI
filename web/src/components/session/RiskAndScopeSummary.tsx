import type { RiskLevel, SessionAnalysis } from "@glimmer/shared";

const RISK_COLOR: Record<RiskLevel, string> = {
  LOW: "var(--green)", MEDIUM: "var(--amber)", HIGH: "var(--red)", CRITICAL: "var(--red)",
};
const SEVERE_RISK: ReadonlySet<RiskLevel> = new Set(["HIGH", "CRITICAL"]);

export function RiskAndScopeSummary({ analysis }: { analysis: SessionAnalysis }) {
  const severe = SEVERE_RISK.has(analysis.riskScore);
  const color = RISK_COLOR[analysis.riskScore] ?? "var(--gray)";

  return (
    <fieldset>
      <legend>Risk &amp; Scope</legend>
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Live — computed from this session's actual changed files ({analysis.provenance})
      </p>
      <dl>
        <dt>Risk level</dt>
        <dd>
          <span
            className={`risk-badge risk-${analysis.riskScore.toLowerCase()}`}
            style={{
              color,
              fontWeight: severe ? 700 : 400,
              border: severe ? `1px solid ${color}` : undefined,
              borderRadius: severe ? "var(--radius)" : undefined,
              padding: severe ? "2px 6px" : undefined,
            }}
          >
            {analysis.riskScore}
          </span>
        </dd>
      </dl>
      {analysis.scopeGuard === null && (
        <p>Scope guard: Unavailable — no task contract on record for this session.</p>
      )}
      {analysis.scopeGuard && !analysis.scopeGuard.inScope && (
        <div style={{ border: "1px solid var(--red)", borderRadius: "var(--radius)", padding: 8, marginTop: 8 }}>
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
    </fieldset>
  );
}
