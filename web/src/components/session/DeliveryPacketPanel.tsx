import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { CollapsibleSection } from "../common/CollapsibleSection";

// V7 §23.16 -- the concise, entirely-derived-from-existing-facts session
// close-out packet glimmer-v2.py assembles once, at the very end of every
// session. This panel is a small summary view of it (developer handoff /
// PR-summary shape), not a re-render of every full artifact -- those already
// have their own panels (ArchitecturePlanPanel, DeliveryReviewPanel,
// VisualVerificationPanel). Model-derived sections are labeled the same way
// DeliveryReviewPanel already labels its own content.

// "Checked vs. assumed" made visual: deterministic/verified facts get a
// green CHECKED badge, model-stated values an amber STATED badge — the
// reviewer sees at a glance which parts of the delivery reality graded and
// which parts the model asserted.
function ProvenanceBadge({ kind }: { kind: "checked" | "stated" }) {
  const checked = kind === "checked";
  return (
    <span
      className="mono"
      style={{
        fontSize: 10,
        padding: "1px 6px",
        marginLeft: 6,
        borderRadius: 6,
        border: `1px solid ${checked ? "var(--green, #3a5)" : "var(--amber, #b90)"}`,
        color: checked ? "var(--green, #3a5)" : "var(--amber, #b90)",
      }}
    >
      {checked ? "CHECKED" : "STATED"}
    </span>
  );
}

export function DeliveryPacketPanel({
  sessionId,
  workspace,
}: {
  sessionId: string;
  workspace?: string;
}) {
  const navigate = useNavigate();
  // Written once at session close-out — fetch once, not a poll target,
  // same convention as DeliveryReviewPanel/ArchitecturePlanPanel.
  const { data: packet } = useQuery({
    queryKey: ["delivery-packet", sessionId],
    queryFn: () => glimmerApi.getDeliveryPacket(sessionId),
    enabled: !!sessionId,
    retry: false,
  });

  // Absence (404) is normal — most sessions predate this task, or ended
  // before the `finally` block that assembles it ever ran.
  if (!packet) return null;

  const readiness = packet.customerReadiness?.value ?? null;
  const summary = [packet.verification.status, readiness].filter(Boolean).join(" · ");

  return (
    <CollapsibleSection title="Delivery Packet" summary={summary || undefined}>
      <dl className="kv-grid">
        <div className="kv-wide">
          <dt>Task</dt>
          <dd>{packet.task ?? "Unavailable"}</dd>
        </div>
        <div>
          <dt>Verification</dt>
          <dd>
            {packet.verification.status}
            {packet.verification.status === "VERIFIED" && <ProvenanceBadge kind="checked" />}
          </dd>
        </div>
        <div>
          <dt>Visual</dt>
          <dd>{packet.visual}</dd>
        </div>
        <div>
          <dt>Customer readiness</dt>
          <dd>
            {readiness ?? "Unavailable"}
            {packet.customerReadiness && <ProvenanceBadge kind="stated" />}
          </dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>
            {packet.confidence ? (
              <>
                {packet.confidence.level} — {packet.confidence.reason}
                <ProvenanceBadge kind="stated" />
                {packet.confidence.calibratedRate !== undefined && (
                  <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {" "}
                    (measured: "{packet.confidence.level}" verified{" "}
                    {Math.round(packet.confidence.calibratedRate * 100)}% of n=
                    {packet.confidence.calibratedSampleSize})
                  </span>
                )}
              </>
            ) : (
              "Unavailable"
            )}
          </dd>
        </div>
        {packet.objectiveAssessment && (
          <div>
            <dt>Objective clarity</dt>
            <dd>
              {packet.objectiveAssessment.clarity}
              {packet.objectiveAssessment.signals.length > 0 &&
                ` (${packet.objectiveAssessment.signals.join(", ")})`}
              <ProvenanceBadge kind="checked" />
            </dd>
          </div>
        )}
        <div>
          <dt>Human review status</dt>
          <dd>{packet.humanReviewStatus}</dd>
        </div>
      </dl>

      <h3>Changed files ({packet.changedFiles.length})</h3>
      {packet.changedFiles.length ? (
        <ul>
          {packet.changedFiles.map((f) => (
            <li key={f}>
              <code>{f}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p>none</p>
      )}

      {!!packet.orchestratorUpdatedFiles.length && (
        <>
          <h3>Orchestrator-updated files</h3>
          <ul>
            {packet.orchestratorUpdatedFiles.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      {packet.limitations ? (
        <>
          {!!packet.limitations.unresolvedItems.length && (
            <>
              <h3>Known limitations</h3>
              <ul>
                {packet.limitations.unresolvedItems.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <p style={{ color: "var(--text-muted)" }}>Known limitations: Unavailable</p>
      )}

      {packet.forwardPlan?.nextSteps.length ? (
        <>
          <h3>Plan forward</h3>
          <ul>
            {packet.forwardPlan.nextSteps.map((s, i) => (
              <li key={i}>
                {s.action}{" "}
                <button
                  type="button"
                  onClick={() =>
                    navigate("/tasks/new", { state: { objective: s.action, workspace } })
                  }
                >
                  Start as task
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p style={{ color: "var(--text-muted)" }}>Plan forward: Unavailable</p>
      )}
    </CollapsibleSection>
  );
}
