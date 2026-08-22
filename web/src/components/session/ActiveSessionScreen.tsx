import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { useSharedSessionEvents, useSharedLastEventAt } from "../../api/useSessionEvents";
import { deriveSessionState } from "../../state/deriveSessionState";
import { formatElapsed, lastActivityLabel, isStalled } from "../../state/liveness";
import { sessionTimestamp } from "../../state/sessionListMeta";
import { AgentStateStepper, STATES as RUNNING_STATES } from "./AgentStateStepper";
import { RepairCycleStepper } from "./RepairCycleStepper";
import { RiskAndScopeSummary } from "./RiskAndScopeSummary";
import { ArchitecturePlanPanel } from "./ArchitecturePlanPanel";
import { ArchitectReviewPanel } from "./ArchitectReviewPanel";
import { GatesRow } from "./GatesRow";
import { StatusesRow } from "./StatusesRow";
import { DeliveryReviewPanel } from "./DeliveryReviewPanel";
import { VisualVerificationPanel } from "./VisualVerificationPanel";
import { EvidencePanel } from "./EvidencePanel";

// Non-success terminal states where a `failure` cause (if present) is worth
// surfacing as a banner. "verified" is terminal but not a failure to
// explain; mid-flow states never carry `failure` at all. "cancelled" is
// included so a cancelled session with a USER_CANCELLED failure still gets
// the (gray) banner explaining why it stopped.
const NON_SUCCESS_TERMINAL = ["blocked", "failed", "needs_review", "cancelled"];

// USER_CANCELLED reads as neutral (the human chose to stop, not a fault);
// INFRA_BLOCKED/TIMEOUT/ORCHESTRATION_ABORTED are environment-ish (amber);
// everything else (CODE_FAIL, POLICY_BLOCK, SCOPE_FAILURE, PARSER_FAILURE,
// UNKNOWN, ...) is a real failure (red).
function failureSeverityColor(failureClass: string): string {
  if (failureClass === "USER_CANCELLED") return "var(--gray)";
  if (["INFRA_BLOCKED", "TIMEOUT", "ORCHESTRATION_ABORTED"].includes(failureClass)) return "var(--amber)";
  return "var(--red)";
}

function humanCase(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Ticks its own 1s interval so a running session's elapsed/last-activity
// line re-renders every second without re-rendering the rest of the screen
// (panels, stepper, etc. don't depend on wall-clock time).
function LivenessLine({
  isRunning, startedAt, lastEventAt,
}: { isRunning: boolean; startedAt: string | null; lastEventAt: number | null }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  if (!isRunning) return null;
  const elapsed = startedAt ? formatElapsed(startedAt, nowMs) : null;
  const activityLabel = lastActivityLabel(lastEventAt, nowMs);
  const stalled = isStalled(lastEventAt, nowMs);
  if (!elapsed && !activityLabel) return null;

  return (
    <p className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>
      {elapsed}
      {elapsed && activityLabel && " · "}
      {activityLabel && (
        <span style={stalled ? { color: "var(--amber)" } : undefined}>
          {activityLabel}
          {stalled ? " — possibly stalled" : ""}
        </span>
      )}
    </p>
  );
}

export function ActiveSessionScreen() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const cancelMutation = useMutation({
    mutationFn: () => glimmerApi.cancelSession(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["session", id] });
      queryClient.invalidateQueries({ queryKey: ["session-analysis", id] });
    },
  });
  const { data: session } = useQuery({
    queryKey: ["session", id],
    queryFn: () => glimmerApi.getSession(id!),
    enabled: !!id,
    refetchInterval: 4000,
  });
  const { data: analysis } = useQuery({
    queryKey: ["session-analysis", id],
    queryFn: () => glimmerApi.getSessionAnalysis(id!),
    enabled: !!id,
    refetchInterval: 4000,
  });
  const events = useSharedSessionEvents();
  const lastEventAt = useSharedLastEventAt();

  // The stepper reads the event-derived state (it wants the most granular
  // in-flight step). Whether the session is "running" at all is gated on
  // session.status directly — the same source the sidebar pulse and
  // newlyCompleted use — so all three can't drift out of sync with each
  // other over a stale/replaying event stream.
  const state = session ? deriveSessionState(events, session.status) : null;
  const isRunning = session != null && RUNNING_STATES.includes(session.status);

  if (!session || !state) return <div>Loading session…</div>;

  // startedAt isn't populated by the gateway yet (server/src/lib/sessions.ts
  // hardcodes it undefined); fall back to the deterministic timestamp
  // embedded in the session id — the same parse the sidebar uses — rather
  // than omitting elapsed entirely. Still omitted if neither is available.
  const startedAtBase = session.startedAt ?? sessionTimestamp({ id: session.id })?.toISOString() ?? null;

  const showFailureBanner = session.failure && NON_SUCCESS_TERMINAL.includes(state);

  return (
    <div>
      {showFailureBanner && (
        <div
          className="failure-banner"
          style={{ ["--badge-color" as any]: failureSeverityColor(session.failure!.class) }}
        >
          <p className="failure-banner__title">{humanCase(state)}: {humanCase(session.failure!.class)}</p>
          {session.failure!.detail && <p className="failure-banner__detail">{session.failure!.detail}</p>}
          {id && <Link to={`/sessions/${id}/verification`}>See verification</Link>}
        </div>
      )}
      <h1>{session.task}</h1>
      <LivenessLine isRunning={isRunning} startedAt={startedAtBase} lastEventAt={lastEventAt} />
      <div className="toolbar">
        <Link to={`/sessions/${id}/diff`}>View diff</Link>
        <Link to={`/sessions/${id}/verification`}>Verification Center</Link>
        <button onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending}>
          Cancel
        </button>
      </div>
      {cancelMutation.isError && <div>Unavailable — could not cancel this session.</div>}
      <AgentStateStepper current={state} />
      <dl>
        <dt>Changed files</dt>
        <dd>{session.changedFiles.length}</dd>
      </dl>
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Human review:{" "}
        {session.humanAcceptance?.accepted
          ? `Accepted ${new Date(session.humanAcceptance.acceptedAt).toLocaleString()}`
          : "Not yet accepted"}
      </p>
      {/* V7 §20: session.status here comes straight from the gateway's own
          read (readSession's computeStale), not the event-derived `state`
          above -- glimmer-v2.py never emits a "stale" agent_state_changed
          event (nothing runs after it exits to emit one), so the event
          trail alone would never surface this. No failure record exists for
          a stale session (nothing failed), which is why this is its own
          line rather than routed through the failure banner. */}
      {session.status === "stale" && (
        <p style={{ fontSize: 12, color: "var(--amber)" }}>
          Verified result is stale — the workspace changed after verification; re-run to re-verify.
        </p>
      )}
      {session.architectTrigger && session.architectTrigger.mode !== "off" && (
        // Deterministic fact from the orchestrator: how architect mode was
        // actually decided for THIS run (the composer preview is only an
        // estimate computed before the run existed).
        <p className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>
          architect: {session.architectTrigger.mode}
          {session.architectTrigger.score !== undefined && ` (score ${session.architectTrigger.score}${
            session.architectTrigger.signals?.length ? `: ${session.architectTrigger.signals.join(", ")}` : ""})`}
        </p>
      )}
      <RepairCycleStepper session={session} />
      <GatesRow gates={session.gates} />
      <StatusesRow statuses={session.statuses} />
      {analysis && <RiskAndScopeSummary analysis={analysis} />}
      {id && <ArchitecturePlanPanel sessionId={id} />}
      {id && <ArchitectReviewPanel sessionId={id} gates={session.gates} />}
      {id && <DeliveryReviewPanel sessionId={id} />}
      {id && <VisualVerificationPanel sessionId={id} />}
      {id && <EvidencePanel sessionId={id} />}
    </div>
  );
}
