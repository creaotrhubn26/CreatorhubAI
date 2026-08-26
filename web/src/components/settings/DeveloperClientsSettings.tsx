import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DeveloperClient, DeveloperClientState } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { CommandAction } from "./CliIntegrationsSettings";

const STATE_LABEL: Record<DeveloperClientState, string> = {
  ready: "Ready",
  app_only: "App only",
  missing: "Missing",
};

function ClientCard({
  client,
  copiedCommand,
  onCopy,
}: {
  client: DeveloperClient;
  copiedCommand: string | null;
  onCopy(command: string): void;
}) {
  const path = client.executablePath ?? client.appPath;

  return (
    <article className="cli-integration" data-state={client.state}>
      <div className="cli-integration__heading">
        <div>
          <h3>{client.name}</h3>
          <span className="mono cli-integration__executable">
            {client.executable ?? client.kind}
          </span>
        </div>
        <span className="cli-integration__state">{STATE_LABEL[client.state]}</span>
      </div>
      <div className="cli-integration__meta">
        <span>{client.kind}</span>
        <span>MCP supported</span>
        {client.version && <span>{client.version}</span>}
      </div>
      <p>{client.detail}</p>
      {path && <p className="mono cli-integration__path">{path}</p>}
      <p>{client.mcp.setupHint}</p>
      {client.mcp.configPath && (
        <p className="mono cli-integration__path">
          {client.mcp.configPresent ? "Client config found" : "No client config yet"}:{" "}
          {client.mcp.configPath}
        </p>
      )}
      <p>
        <a href={client.mcp.docsUrl} target="_blank" rel="noreferrer">
          Official MCP guide
        </a>
      </p>
      {client.installCommand && (
        <CommandAction
          label="Copy install command"
          command={client.installCommand}
          copied={copiedCommand === client.installCommand}
          onCopy={onCopy}
        />
      )}
      {client.mcp.inspectCommand && client.installed && (
        <CommandAction
          label="Copy MCP check"
          command={client.mcp.inspectCommand}
          copied={copiedCommand === client.mcp.inspectCommand}
          onCopy={onCopy}
        />
      )}
    </article>
  );
}

export function DeveloperClientsSettings() {
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const query = useQuery({
    queryKey: ["developer-clients"],
    queryFn: glimmerApi.getDeveloperClients,
    staleTime: 30_000,
  });

  async function copy(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCommand(command);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <section className="cli-integrations" aria-labelledby="developer-clients-title">
      <div className="cli-integrations__title-row">
        <div>
          <h2 id="developer-clients-title">Developer clients</h2>
          <p>Editors, terminals and coding agents that can use the same MCP ecosystem.</p>
        </div>
        <button type="button" onClick={() => query.refetch()} disabled={query.isFetching}>
          {query.isFetching ? "Checking…" : "Refresh clients"}
        </button>
      </div>

      <p className="cli-integrations__policy">
        Detection is read only. Glimmer does not install clients, rewrite their configuration, read
        credential contents, or start one coding agent inside another.
      </p>

      {query.isLoading && <p role="status">Checking developer clients…</p>}
      {query.error && (
        <p role="alert">Could not inspect developer clients — {(query.error as Error).message}</p>
      )}
      {copyError && (
        <p role="alert">Could not access the clipboard. Copy the visible command manually.</p>
      )}

      {query.data && (
        <>
          <div className="cli-integrations__summary">
            <span>{query.data.platform}</span>
            <span>{query.data.clients.filter((client) => client.installed).length} installed</span>
            <span>{query.data.clients.filter((client) => !client.installed).length} missing</span>
          </div>
          <div className="cli-integrations__grid">
            {query.data.clients.map((client) => (
              <ClientCard
                key={client.id}
                client={client}
                copiedCommand={copiedCommand}
                onCopy={copy}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
