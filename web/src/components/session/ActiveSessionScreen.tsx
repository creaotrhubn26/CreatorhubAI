import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { useSharedSessionEvents, useSharedLastEventAt } from "../../api/useSessionEvents";
import { deriveSessionState } from "../../state/deriveSessionState";
import { formatElapsed, lastActivityLabel, isStalled } from "../../state/liveness";
import { AgentStateStepper, STATES as RUNNING_STATES } from "./AgentStateStepper";
import { RepairCycleStepper } from "./RepairCycleStepper";
import { RiskAndScopeSummary } from "./RiskAndScopeSummary";
import { ArchitecturePlanPanel } from "./ArchitecturePlanPanel";
import { ArchitectReviewPanel } from "./ArchitectReviewPanel";
import { DeliveryReviewPanel } from "./DeliveryReviewPanel";

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

  // Liveness: elapsed + last-activity, ticking once a second — single
  // interval, only while this session is actually running, cleared on
  // unmount/status change.
  const state = session ? deriveSessionState(events, session.status) : null;
  const isRunning = state !== null && (RUNNING_STATES as readonly string[]).includes(state);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  if (!session || !state) return <div>Loading session…</div>;

  const elapsed = isRunning && session.startedAt ? formatElapsed(session.startedAt, nowMs) : null;
  const activityLabel = isRunning ? lastActivityLabel(lastEventAt, nowMs) : null;
  const stalled = isRunning && isStalled(lastEventAt, nowMs);

  return (
    <div>
      <h1>{session.task}</h1>
      {isRunning && (elapsed || activityLabel) && (
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
      )}
      <div className="toolbar">
        <Link to={`/sessions/${id}/diff`}>View diff</Link>
        <Link to={`/sessions/${id}/verification`}>Verification Center</Link>
        <button onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending}>
          Cancel
        </button>
      </div>
      {cancelMutation.isError && <div>Unavailable — could not cancel this session.</div>}
      <AgentStateStepper current={state} />
      {session.failure && (
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Failure: {session.failure.class} — {session.failure.detail}
        </p>
      )}
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
      <RepairCycleStepper session={session} />
      {analysis && <RiskAndScopeSummary analysis={analysis} />}
      {id && <ArchitecturePlanPanel sessionId={id} />}
      {id && <ArchitectReviewPanel sessionId={id} gates={session.gates} />}
      {id && <DeliveryReviewPanel sessionId={id} />}
    </div>
  );
}
