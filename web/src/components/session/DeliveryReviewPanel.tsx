import { useQuery } from "@tanstack/react-query";
import type { DeliveryReviewCustomerReadiness, NextStepPriority } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { CollapsibleSection } from "../common/CollapsibleSection";

const READINESS_COLOR: Record<DeliveryReviewCustomerReadiness, string> = {
  ready_to_ship: "var(--green)",
  ready_with_known_limitations: "var(--amber)",
  needs_polish: "var(--amber)",
  needs_rework: "var(--red)",
  not_customer_ready: "var(--red)",
};

const PRIORITY_ORDER: NextStepPriority[] = ["required_before_ship", "recommended_next", "future_opportunity"];
const PRIORITY_LABEL: Record<NextStepPriority, string> = {
  required_before_ship: "Required before ship",
  recommended_next: "Recommended next",
  future_opportunity: "Future opportunity",
};

export function DeliveryReviewPanel({ sessionId }: { sessionId: string }) {
  // Written once at session close-out — fetch once, not a poll target.
  const { data: review } = useQuery({
    queryKey: ["delivery-review", sessionId],
    queryFn: () => glimmerApi.getDeliveryReview(sessionId),
    enabled: !!sessionId,
    retry: false,
  });

  // Absence (404) is normal for sessions that never reached delivery review.
  if (!review) return null;

  if (review.reviewFailed) {
    return (
      <CollapsibleSection title="Delivery Review" summary="failed to generate">
        <p>Delivery review failed to generate{review.reviewFailureReason ? `: ${review.reviewFailureReason}` : "."}</p>
      </CollapsibleSection>
    );
  }

  const color = READINESS_COLOR[review.customerReadiness] ?? "var(--gray)";
  const summary = `${review.customerReadiness} · ${review.confidence.level}`;

  return (
    <CollapsibleSection title="Delivery Review" summary={summary}>
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Model-generated review — not a deterministic fact
      </p>
      <p>{review.summary}</p>
      <dl className="kv-grid">
        <div>
          <dt>Customer readiness</dt>
          <dd>
            <span className="meta-value" style={{ ["--badge-color" as any]: color }}>{review.customerReadiness}</span>
          </dd>
        </div>
        <div className="kv-wide">
          <dt>Confidence</dt>
          <dd>{review.confidence.level} — {review.confidence.reason}</dd>
        </div>
      </dl>
      {!!review.strengths?.length && (
        <>
          <h3>Strengths</h3>
          <ul>{review.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </>
      )}
      {!!review.concerns?.length && (
        <>
          <h3>Concerns</h3>
          <ul>
            {review.concerns.map((c, i) => (
              <li key={i}>[{c.severity}] {c.category}: {c.description}</li>
            ))}
          </ul>
        </>
      )}
      {!!review.nextSteps?.length && (
        <>
          <h3>Next steps</h3>
          {PRIORITY_ORDER.filter((p) => review.nextSteps!.some((s) => s.priority === p)).map((p) => (
            <div key={p}>
              <strong>{PRIORITY_LABEL[p]}</strong>
              <ul>
                {review.nextSteps!.filter((s) => s.priority === p).map((s, i) => <li key={i}>{s.action}</li>)}
              </ul>
            </div>
          ))}
        </>
      )}
    </CollapsibleSection>
  );
}
