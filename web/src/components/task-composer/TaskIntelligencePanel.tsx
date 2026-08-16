import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";

export function TaskIntelligencePanel({ scopePackage, scopeArea }: { scopePackage: string; scopeArea?: string }) {
  const { data } = useQuery({
    queryKey: ["task-intelligence", scopePackage, scopeArea],
    queryFn: () => glimmerApi.getTaskIntelligence(scopePackage, scopeArea),
  });

  if (!data) return null;

  return (
    <fieldset>
      <legend>Task Intelligence</legend>
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Deterministic — repository-derived, not a model guess ({data.provenance})
      </p>
      <dl>
        <dt>Likely area</dt>
        <dd>{data.likelyArea ?? "Unavailable"}</dd>
        <dt>Likely package</dt>
        <dd>{data.likelyPackage ?? "Unavailable"}</dd>
        <dt>Suggested verification</dt>
        <dd>{data.suggestedVerification.length ? data.suggestedVerification.join(", ") : "Unavailable"}</dd>
        <dt>Estimated risk</dt>
        <dd>{data.estimatedRisk ?? "Unavailable"}</dd>
      </dl>
    </fieldset>
  );
}
