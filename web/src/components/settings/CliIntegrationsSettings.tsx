import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CliAgentAccess, CliIntegration, CliIntegrationState } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";

const STATE_LABEL: Record<CliIntegrationState, string> = {
  ready: "Ready",
  authentication_required: "Sign-in required",
  missing: "Missing",
  blocked: "Agent blocked",
};

const ACCESS_LABEL: Record<CliAgentAccess, string> = {
  runtime: "Runtime",
  read_only: "Read only",
  validation_only: "Validation only",
  approval_required: "Approval required",
  blocked: "Blocked",
};

function CommandAction({
  label,
  command,
  copied,
  onCopy,
}: {
  label: string;
  command: string;
  copied: boolean;
  onCopy(command: string): void;
}) {
  return (
    <div className="cli-command">
      <code>{command}</code>
      <button type="button" onClick={() => onCopy(command)} aria-label={`${label}: ${command}`}>
        {copied ? "Copied" : label}
      </button>
    </div>
  );
}

function IntegrationCard({
  integration,
  copiedCommand,
  onCopy,
}: {
  integration: CliIntegration;
  copiedCommand: string | null;
  onCopy(command: string): void;
}) {
  return (
    <article className="cli-integration" data-state={integration.state}>
      <div className="cli-integration__heading">
        <div>
          <h3>{integration.name}</h3>
          <span className="mono cli-integration__executable">{integration.executable}</span>
        </div>
        <span className="cli-integration__state">{STATE_LABEL[integration.state]}</span>
      </div>
      <div className="cli-integration__meta">
        <span>{integration.required ? "Required" : "Optional"}</span>
        <span>{ACCESS_LABEL[integration.agentAccess]}</span>
        <span>{integration.source}</span>
        {integration.version && <span>{integration.version}</span>}
      </div>
      <p>{integration.detail}</p>
      {integration.path && <p className="mono cli-integration__path">{integration.path}</p>}
      {integration.installCommand && integration.state === "missing" && (
        <CommandAction
          label="Copy install command"
          command={integration.installCommand}
          copied={copiedCommand === integration.installCommand}
          onCopy={onCopy}
        />
      )}
      {integration.authCommand && integration.state === "authentication_required" && (
        <CommandAction
          label="Copy sign-in command"
          command={integration.authCommand}
          copied={copiedCommand === integration.authCommand}
          onCopy={onCopy}
        />
      )}
    </article>
  );
}

export function CliIntegrationsSettings() {
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const query = useQuery({
    queryKey: ["cli-integrations"],
    queryFn: glimmerApi.getCliIntegrations,
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
    <section className="cli-integrations" aria-labelledby="cli-integrations-title">
      <div className="cli-integrations__title-row">
        <div>
          <h2 id="cli-integrations-title">CLI &amp; Integrations</h2>
          <p>Glimmer detects tools through the same Terminal PATH used by sessions.</p>
        </div>
        <button type="button" onClick={() => query.refetch()} disabled={query.isFetching}>
          {query.isFetching ? "Checking…" : "Refresh checks"}
        </button>
      </div>

      <p className="cli-integrations__policy">
        System tools are never installed or authenticated automatically. External writes require approval; Git push remains blocked.
      </p>

      {query.isLoading && <p role="status">Checking CLI integrations…</p>}
      {query.error && <p role="alert">Could not inspect CLI integrations — {(query.error as Error).message}</p>}
      {copyError && <p role="alert">Could not access the clipboard. Copy the visible command manually.</p>}

      {query.data && (
        <>
          <div className="cli-integrations__summary">
            <span>{query.data.platform}</span>
            <span>{query.data.integrations.filter((item) => item.state === "ready").length} ready</span>
            <span>{query.data.integrations.filter((item) => item.state === "missing").length} missing</span>
          </div>
          <div className="cli-integrations__grid">
            {query.data.integrations.map((integration) => (
              <IntegrationCard
                key={integration.id}
                integration={integration}
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
