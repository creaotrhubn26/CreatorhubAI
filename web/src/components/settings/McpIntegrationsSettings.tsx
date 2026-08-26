import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { McpIntegration, McpIntegrationId, McpIntegrationState } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";

const STATE_LABEL: Record<McpIntegrationState, string> = {
  active: "Active",
  configured_restart_required: "Restart required",
  available: "Available",
  missing_requirement: "Requirement missing",
  authentication_required: "Sign-in required",
};

function McpCard({
  integration,
  busy,
  onToggle,
}: {
  integration: McpIntegration;
  busy: boolean;
  onToggle(id: McpIntegrationId): void;
}) {
  const blockedFromEnabling =
    !integration.configured &&
    (integration.state === "missing_requirement" ||
      integration.state === "authentication_required");
  return (
    <article className="cli-integration" data-state={integration.state}>
      <div className="cli-integration__heading">
        <div>
          <h3>{integration.name}</h3>
          <span className="mono cli-integration__executable">v{integration.version}</span>
        </div>
        <span className="cli-integration__state">{STATE_LABEL[integration.state]}</span>
      </div>
      <div className="cli-integration__meta">
        <span>{integration.adoption === "very_high" ? "Very widely used" : "Widely used"}</span>
        <span>{integration.agentAccess === "read_only" ? "Read only" : "Approval required"}</span>
        <span>{integration.toolCount} active tools</span>
      </div>
      <p>{integration.description}</p>
      <p>{integration.detail}</p>
      {integration.requirement && <p className="mono">{integration.requirement}</p>}
      <button
        type="button"
        onClick={() => onToggle(integration.id)}
        disabled={busy || blockedFromEnabling}
      >
        {integration.configured ? "Disable" : "Enable"}
      </button>
    </article>
  );
}

export function McpIntegrationsSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["mcp-integrations"],
    queryFn: glimmerApi.getMcpIntegrations,
    staleTime: 15_000,
  });
  const mutation = useMutation({
    mutationFn: glimmerApi.saveMcpIntegrations,
    onSuccess: (status) => queryClient.setQueryData(["mcp-integrations"], status),
  });

  function toggle(id: McpIntegrationId) {
    if (!query.data) return;
    const enabled = query.data.integrations
      .filter((integration) => integration.configured)
      .map((integration) => integration.id);
    mutation.mutate({
      enabled: enabled.includes(id)
        ? enabled.filter((candidate) => candidate !== id)
        : [...enabled, id],
    });
  }

  return (
    <section className="cli-integrations" aria-labelledby="mcp-integrations-title">
      <div className="cli-integrations__title-row">
        <div>
          <h2 id="mcp-integrations-title">MCP integrations</h2>
          <p>Curated stdio servers available to the local Glimmer model runtime.</p>
        </div>
        <button type="button" onClick={() => query.refetch()} disabled={query.isFetching}>
          {query.isFetching ? "Checking…" : "Refresh MCP"}
        </button>
      </div>

      <p className="cli-integrations__policy">
        Arbitrary server commands and credentials cannot be submitted from this UI. Unknown MCP
        tools default to approval-required unless the server explicitly marks them read-only.
      </p>

      {query.isLoading && <p role="status">Checking MCP integrations…</p>}
      {query.error && (
        <p role="alert">Could not inspect MCP integrations — {(query.error as Error).message}</p>
      )}
      {mutation.error && (
        <p role="alert">Could not update MCP integrations — {(mutation.error as Error).message}</p>
      )}

      {query.data && (
        <>
          <div className="cli-integrations__summary">
            <span>{query.data.runtime.mcpToolCount} active MCP tools</span>
            <span>{query.data.runtime.totalToolCount} total runtime tools</span>
            <span>{query.data.restartRequired ? "Model restart required" : "Runtime in sync"}</span>
          </div>
          <p className="mono cli-integration__path">{query.data.configPath}</p>
          {query.data.configError && (
            <p role="alert">Invalid MCP config — {query.data.configError}</p>
          )}
          {query.data.customServerCount > 0 && (
            <p>
              {query.data.customServerCount} manually configured server
              {query.data.customServerCount === 1 ? " is" : "s are"} preserved but cannot be edited
              here.
            </p>
          )}
          <div className="cli-integrations__grid">
            {query.data.integrations.map((integration) => (
              <McpCard
                key={integration.id}
                integration={integration}
                busy={mutation.isPending}
                onToggle={toggle}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
