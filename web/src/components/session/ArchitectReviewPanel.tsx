import { useQuery } from "@tanstack/react-query";
import type { ArchitectReviewDecision, GlimmerSession } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { CollapsibleSection } from "../common/CollapsibleSection";

const DECISION_COLOR: Record<ArchitectReviewDecision, string> = {
  APPROVED: "var(--green)",
  APPROVED_WITH_CONDITIONS: "var(--amber)",
  REVISE_IMPLEMENTATION: "var(--red)",
  REPLAN_REQUIRED: "var(--red)",
  HUMAN_REVIEW_REQUIRED: "var(--red)",
};

export function ArchitectReviewPanel({ sessionId, gates }: { sessionId: string; gates?: GlimmerSession["gates"] }) {
  // Reviews are opt-in artifacts written once per round, not a live stream —
  // fetch once, same as the architecture plan.
  const { data: reviews } = useQuery({
    queryKey: ["architect-reviews", sessionId],
    queryFn: () => glimmerApi.getArchitectReviews(sessionId),
    enabled: !!sessionId,
    retry: false,
  });

  // Absence is normal for non-architect-mode sessions. The gate bit is
  // orchestrator-recorded fact independent of the review artifact, so it can
  // still be worth showing even if the review list itself 404s.
  if (!gates && !reviews?.length) return null;

  const gateText = gates
    ? gates.architectureApproved === true ? "approved" : gates.architectureApproved === false ? "rejected" : "not reviewed"
    : null;

  const latest = reviews?.[0];
  // Formatted as a percentage (not the raw "0.88") so the header summary
  // never collides verbatim with the confidence line rendered below it.
  const summary = latest
    ? `${latest.decision} · ${Math.round(latest.confidence * 100)}%`
    : gateText
      ? `gate: ${gateText}`
      : undefined;

  return (
    <CollapsibleSection title="Architect Reviews" summary={summary}>
      {gateText && (
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Architecture gate (orchestrator-recorded fact): {gateText}
        </p>
      )}
      {!!reviews?.length && (
        <>
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Model-generated review — not a deterministic fact
          </p>
          {reviews.map((review, i) => {
            const color = DECISION_COLOR[review.decision] ?? "var(--gray)";
            return (
              <div key={i} style={{ marginTop: 8 }}>
                <span className="meta-value" style={{ ["--badge-color" as any]: color }}>
                  {review.decision}
                </span>{" "}
                <span>Confidence: {review.confidence}</span>
                {review.reviewFailed && <p>Review failed to generate{review.reviewFailureReason ? `: ${review.reviewFailureReason}` : "."}</p>}
                {!!review.findings?.length && (
                  <>
                    <h4>Findings</h4>
                    <ul>{review.findings.map((f, j) => <li key={j}>{f}</li>)}</ul>
                  </>
                )}
                {!!review.requiredChanges?.length && (
                  <>
                    <h4>Required changes</h4>
                    <ul>{review.requiredChanges.map((c, j) => <li key={j}>{c}</li>)}</ul>
                  </>
                )}
              </div>
            );
          })}
        </>
      )}
    </CollapsibleSection>
  );
}
