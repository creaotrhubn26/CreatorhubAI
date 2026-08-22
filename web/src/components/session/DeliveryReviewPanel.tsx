import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { DeliveryReviewCustomerReadiness, NextStepPriority } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { CollapsibleSection } from "../common/CollapsibleSection";

// Exported for StatusesRow (Task 8.1, V7 §23.11) -- the delivery/overall
// legs there use this exact same 5-level vocabulary, one color map instead
// of two independently-drifting ones.
export const READINESS_COLOR: Record<DeliveryReviewCustomerReadiness, string> = {
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
  const navigate = useNavigate();
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
      {!!review.approachRationale?.length && (
        <>
          <h3>Approach rationale</h3>
          <ul>{review.approachRationale.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </>
      )}
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
      {!!review.unresolvedItems?.length && (
        <>
          <h3>Unresolved items</h3>
          <ul>{review.unresolvedItems.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </>
      )}
      {!!review.intentionallyNotChanged?.length && (
        <>
          <h3>Intentionally not changed</h3>
          <ul>{review.intentionallyNotChanged.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </>
      )}
      {!!review.nextSteps?.length && (
        <>
          <h3>Next steps</h3>
          {PRIORITY_ORDER.filter((p) => review.nextSteps!.some((s) => s.priority === p)).map((p) => (
            <div key={p}>
              <strong>{PRIORITY_LABEL[p]}</strong>
              <ul>
                {review.nextSteps!.filter((s) => s.priority === p).map((s, i) => (
                  <li key={i} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span>{s.action}</span>
                    <button
                      type="button"
                      style={{ fontSize: 12 }}
                      title="Convert this next step into a new task (opens the composer, prefilled — nothing runs automatically)"
                      onClick={() => navigate("/tasks/new", { state: { objective: s.action } })}
                    >
                      Convert to task
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
      {review.architectEscalation && (
        <>
          <h3>Architect escalation</h3>
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
            V7 §23.15 — a high/critical concern above triggered a second architect opinion
          </p>
          {review.architectEscalation.consultationFailed ? (
            <p>
              Consultation failed{review.architectEscalation.reason ? `: ${review.architectEscalation.reason}` : "."}
            </p>
          ) : (
            <>
              {review.architectEscalation.question && <p><strong>Question:</strong> {review.architectEscalation.question}</p>}
              {review.architectEscalation.answer && <p>{review.architectEscalation.answer}</p>}
            </>
          )}
        </>
      )}
    </CollapsibleSection>
  );
}
