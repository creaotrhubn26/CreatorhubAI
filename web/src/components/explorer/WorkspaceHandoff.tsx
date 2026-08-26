import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { WorkspaceHandoffClientId } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";

const OPENABLE_IDS = new Set<WorkspaceHandoffClientId>(["cursor", "vscode", "warp"]);

export function WorkspaceHandoff({ workspace }: { workspace: string }) {
  const [busyId, setBusyId] = useState<WorkspaceHandoffClientId | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(
    null,
  );
  const query = useQuery({
    queryKey: ["developer-clients"],
    queryFn: glimmerApi.getDeveloperClients,
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    setFeedback(null);
    setBusyId(null);
  }, [workspace]);

  const clients = (query.data?.clients ?? []).filter(
    (client) => OPENABLE_IDS.has(client.id as WorkspaceHandoffClientId) && client.workspaceHandoff,
  );

  async function open(clientId: WorkspaceHandoffClientId, name: string) {
    setBusyId(clientId);
    setFeedback(null);
    try {
      await glimmerApi.openWorkspace(clientId, workspace);
      setFeedback({ kind: "success", message: `Opened in ${name}.` });
    } catch (error) {
      setFeedback({
        kind: "error",
        message: `Could not open in ${name} — ${(error as Error).message}`,
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="workspace-handoff" aria-label="Open workspace in another app">
      <span className="workspace-handoff__label">Open workspace</span>
      {query.isLoading && <span className="workspace-handoff__note">Checking apps…</span>}
      {query.isError && (
        <button type="button" onClick={() => query.refetch()} disabled={query.isFetching}>
          {query.isFetching ? "Checking…" : "Retry app check"}
        </button>
      )}
      {clients.length > 0 && (
        <div className="workspace-handoff__actions">
          {clients.map((client) => {
            const clientId = client.id as WorkspaceHandoffClientId;
            return (
              <button
                type="button"
                key={clientId}
                aria-label={`Open workspace in ${client.name}`}
                disabled={busyId !== null}
                onClick={() => open(clientId, client.name)}
              >
                {busyId === clientId ? "Opening…" : client.name}
              </button>
            );
          })}
        </div>
      )}
      {query.data && clients.length === 0 && (
        <span className="workspace-handoff__note">No supported app detected.</span>
      )}
      {feedback && (
        <span
          className={`workspace-handoff__feedback workspace-handoff__feedback--${feedback.kind}`}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </span>
      )}
    </div>
  );
}
