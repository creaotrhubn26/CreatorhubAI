import { useQuery } from "@tanstack/react-query";
import type { ArchitecturePlanRisk } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";

const RISK_COLOR: Record<ArchitecturePlanRisk, string> = {
  low: "var(--green)", medium: "var(--amber)", high: "var(--red)", critical: "var(--red)",
};

export function ArchitecturePlanPanel({ sessionId }: { sessionId: string }) {
  // Architecture plans are opt-in and written once, before implementation
  // starts — no reason to poll a file that won't change under us.
  const { data: plan } = useQuery({
    queryKey: ["architecture-plan", sessionId],
    queryFn: () => glimmerApi.getArchitecturePlan(sessionId),
    enabled: !!sessionId,
    retry: false,
  });

  // Absence is the normal case for non-architect-mode sessions (404) — no
  // error noise, just nothing rendered.
  if (!plan) return null;

  const color = RISK_COLOR[plan.risk] ?? "var(--gray)";

  return (
    <fieldset>
      <legend>Architecture Plan</legend>
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Model-generated plan — not a deterministic fact
      </p>
      <dl>
        <dt>Objective</dt>
        <dd>{plan.objective}</dd>
        <dt>Risk</dt>
        <dd>
          <span style={{ color, border: `1px solid ${color}`, borderRadius: "var(--radius)", padding: "2px 6px", fontSize: 12 }}>
            {plan.risk}
          </span>
        </dd>
        <dt>Packages</dt>
        <dd>{plan.packages.join(", ")}</dd>
      </dl>
      {!!plan.candidateFiles?.length && (
        <>
          <h3>Candidate files</h3>
          <ul>
            {plan.candidateFiles.map((f) => (
              <li key={f.path}>{f.path} — {f.reason} ({f.confidence})</li>
            ))}
          </ul>
        </>
      )}
      {!!plan.implementationPlan?.length && (
        <>
          <h3>Implementation plan</h3>
          <ol>
            {plan.implementationPlan.map((step, i) => <li key={i}>{step}</li>)}
          </ol>
        </>
      )}
      {!!plan.constraints?.length && (
        <>
          <h3>Constraints</h3>
          <ul>
            {plan.constraints.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </>
      )}
      {!!plan.uncertainties?.length && (
        <>
          <h3>Uncertainties</h3>
          <ul>
            {plan.uncertainties.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
        </>
      )}
    </fieldset>
  );
}
