import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";

function percentage(value: number | null): string {
  return value == null ? "Unavailable" : `${Math.round(value * 100)}%`;
}

export function QualityMetricsSettings() {
  const { data, error } = useQuery({
    queryKey: ["quality-metrics"],
    queryFn: glimmerApi.getQualityMetrics,
    retry: false,
  });
  return (
    <section aria-labelledby="quality-metrics-heading">
      <h2 id="quality-metrics-heading">Local quality metrics</h2>
      <p>Aggregated repository facts only. Source code and raw prompts are never shown here.</p>
      {error && <p role="alert">Quality metrics unavailable — {(error as Error).message}</p>}
      {data && (
        <dl>
          <dt>Claim precision</dt>
          <dd>{percentage(data.claimPrecision)}</dd>
          <dt>Claims</dt>
          <dd>
            {data.verifiedClaims} verified · {data.partialClaims} partial · {data.rejectedClaims}{" "}
            rejected
          </dd>
          <dt>Average code-graph coverage</dt>
          <dd>{percentage(data.averageGraphCoverage)}</dd>
          <dt>Candidate recall@5</dt>
          <dd>{percentage(data.candidateRecallAt5)}</dd>
          <dt>Routing</dt>
          <dd>
            {data.routing.decisions} decisions · {data.routing.highRiskOverrides} high-risk
            overrides · critic independent {data.routing.criticIndependence.independent},
            unavailable {data.routing.criticIndependence.unavailable}
          </dd>
          <dt>Evaluations</dt>
          <dd>
            live {data.evaluation.live ? "available" : "not run"} · stub{" "}
            {data.evaluation.stub ? "available" : "not run"}
          </dd>
        </dl>
      )}
    </section>
  );
}
