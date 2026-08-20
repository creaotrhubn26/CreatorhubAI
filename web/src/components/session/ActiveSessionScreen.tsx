import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { useSessionEvents } from "../../api/useSessionEvents";
import { deriveSessionState } from "../../state/deriveSessionState";
import { AgentStateStepper } from "./AgentStateStepper";
import { AgentTimeline } from "./AgentTimeline";
import { RiskAndScopeSummary } from "./RiskAndScopeSummary";
import { SessionAssistant } from "./SessionAssistant";
import { ArchitecturePlanPanel } from "./ArchitecturePlanPanel";
import { ArchitectReviewPanel } from "./ArchitectReviewPanel";
import { TasksPanel } from "./TasksPanel";
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
  const events = useSessionEvents(id ?? "");

  if (!session) return <div>Loading session…</div>;

  const state = deriveSessionState(events, session.status);

  return (
    <div>
      <h1>{session.task}</h1>
      <Link to={`/sessions/${id}/diff`}>View diff</Link>{" "}
      <button onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending}>
        Cancel
      </button>
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
        <dt>Repair budget</dt>
        <dd>{session.repairsUsed} / {session.repairBudget}</dd>
      </dl>
      {analysis && <RiskAndScopeSummary analysis={analysis} />}
      {id && <ArchitecturePlanPanel sessionId={id} />}
      {id && <ArchitectReviewPanel sessionId={id} gates={session.gates} />}
      {id && <TasksPanel sessionId={id} />}
      {id && <DeliveryReviewPanel sessionId={id} />}
      <AgentTimeline events={events} />
      {id && <SessionAssistant sessionId={id} />}
    </div>
  );
}
