import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { useSessionEvents } from "../../api/useSessionEvents";
import { deriveSessionState } from "../../state/deriveSessionState";
import { AgentStateStepper } from "./AgentStateStepper";
import { AgentTimeline } from "./AgentTimeline";
import { RiskAndScopeSummary } from "./RiskAndScopeSummary";
import { SessionAssistant } from "./SessionAssistant";

export function ActiveSessionScreen() {
  const { id } = useParams<{ id: string }>();
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
  });
  const events = useSessionEvents(id ?? "");

  if (!session) return <div>Loading session…</div>;

  const state = deriveSessionState(events, session.status);

  return (
    <div>
      <h1>{session.task}</h1>
      <AgentStateStepper current={state} />
      <dl>
        <dt>Changed files</dt>
        <dd>{session.changedFiles.length}</dd>
        <dt>Repair budget</dt>
        <dd>{session.repairsUsed} / {session.repairBudget}</dd>
      </dl>
      {analysis && <RiskAndScopeSummary analysis={analysis} />}
      <AgentTimeline events={events} />
      {id && <SessionAssistant sessionId={id} />}
    </div>
  );
}
