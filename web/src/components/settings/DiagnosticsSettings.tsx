import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function DiagnosticsSettings() {
  const queryClient = useQueryClient();
  const [supportMessage, setSupportMessage] = useState<string | null>(null);
  const [supportError, setSupportError] = useState<string | null>(null);
  const diagnostics = useQuery({
    queryKey: ["diagnostics"],
    queryFn: glimmerApi.getDiagnostics,
    refetchInterval: 30_000,
    retry: false,
  });
  const repair = useMutation({
    mutationFn: glimmerApi.repairInstallation,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["diagnostics"] }),
  });

  async function exportSupport() {
    setSupportError(null);
    setSupportMessage(null);
    try {
      const filename = await glimmerApi.downloadSupportBundle();
      setSupportMessage(`Exported ${filename}. Credentials and task prompts were excluded.`);
    } catch (error) {
      setSupportError(`Could not export support package — ${readableError(error)}`);
    }
  }

  const value = diagnostics.data;
  const readyCli = value?.cli.integrations.filter((item) => item.state === "ready").length ?? 0;
  const activeMcp = value?.mcp.integrations.filter((item) => item.active).length ?? 0;

  return (
    <section className="diagnostics" aria-labelledby="diagnostics-title">
      <div className="diagnostics__title-row">
        <div>
          <h2 id="diagnostics-title">System diagnostics</h2>
          <p>Runtime integrity, local tools, MCP status and privacy-safe support data.</p>
        </div>
        <button
          type="button"
          onClick={() => diagnostics.refetch()}
          disabled={diagnostics.isFetching}
        >
          {diagnostics.isFetching ? "Checking…" : "Refresh"}
        </button>
      </div>

      {diagnostics.isError && (
        <p role="alert">Diagnostics unavailable — {readableError(diagnostics.error)}</p>
      )}
      {!value && diagnostics.isPending && <p role="status">Loading system diagnostics…</p>}

      {value && (
        <>
          <div className="diagnostics__summary" data-state={value.readiness.status}>
            <strong>{value.readiness.status}</strong>
            <span>Glimmer {value.health.version}</span>
            <span>
              {readyCli}/{value.cli.integrations.length} CLI tools ready
            </span>
            <span>
              {activeMcp}/{value.mcp.integrations.length} MCP integrations active
            </span>
          </div>
          <div className="diagnostics__grid">
            {value.readiness.components.map((component) => (
              <article
                className="diagnostics__component"
                data-state={component.state}
                key={component.id}
              >
                <div>
                  <h3>{component.label}</h3>
                  <span>{component.state}</span>
                </div>
                <p>{component.detail}</p>
                <small>
                  {component.required ? "Required" : "Optional"}
                  {component.version ? ` · ${component.version}` : ""}
                  {component.source ? ` · ${component.source}` : ""}
                </small>
              </article>
            ))}
          </div>
        </>
      )}

      <div className="diagnostics__actions">
        <button type="button" onClick={() => repair.mutate()} disabled={repair.isPending}>
          {repair.isPending ? "Checking installation…" : "Repair installation"}
        </button>
        <button type="button" onClick={exportSupport}>
          Export support package
        </button>
      </div>

      {repair.isError && <p role="alert">Repair failed — {readableError(repair.error)}</p>}
      {repair.data && (
        <div className="diagnostics__result" role="status">
          <strong>
            {repair.data.reinstallRequired
              ? "Reinstallation required"
              : repair.data.repaired
                ? "Writable state repaired"
                : "Installation is healthy"}
          </strong>
          <ul>
            {repair.data.actions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </div>
      )}
      {supportMessage && <p role="status">{supportMessage}</p>}
      {supportError && <p role="alert">{supportError}</p>}
    </section>
  );
}
