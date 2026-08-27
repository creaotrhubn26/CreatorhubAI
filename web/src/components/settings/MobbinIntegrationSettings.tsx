import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";

export function MobbinIntegrationSettings() {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const query = useQuery({
    queryKey: ["mobbin-integration"],
    queryFn: glimmerApi.getMobbinIntegration,
    staleTime: 15_000,
  });
  const mutation = useMutation({
    mutationFn: glimmerApi.saveMobbinCredential,
    onSuccess: (status) => {
      setApiKey("");
      queryClient.setQueryData(["mobbin-integration"], status);
    },
  });

  return (
    <section className="cli-integrations" aria-labelledby="mobbin-integration-title">
      <div className="cli-integrations__title-row">
        <div>
          <h2 id="mobbin-integration-title">Mobbin inspiration</h2>
          <p>Search real UI references directly from the Design Mode composer.</p>
        </div>
        <span className="cli-integration__state">
          {query.data?.configured ? "Connected" : "Not connected"}
        </span>
      </div>
      <p className="cli-integrations__policy">
        The API key is stored owner-readable on this machine and is never returned to the browser.
        Search calls go only to the fixed official Mobbin API origin. Mobbin API access requires a
        Team or Enterprise plan.
      </p>
      {query.data && <p className="mono cli-integration__path">{query.data.keyPath}</p>}
      <label>
        Mobbin API key
        <input
          type="password"
          value={apiKey}
          autoComplete="off"
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={query.data?.configured ? "Enter a replacement key" : "Paste API key"}
        />
      </label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={apiKey.trim().length < 8 || mutation.isPending}
          onClick={() => mutation.mutate({ apiKey })}
        >
          {mutation.isPending ? "Saving…" : query.data?.configured ? "Replace key" : "Connect"}
        </button>
        <a
          href={query.data?.docsUrl ?? "https://docs.mobbin.com/api/quickstart"}
          target="_blank"
          rel="noreferrer"
        >
          Mobbin API setup
        </a>
      </div>
      {query.error && (
        <p role="alert">Could not inspect Mobbin — {(query.error as Error).message}</p>
      )}
      {mutation.error && (
        <p role="alert">Could not save Mobbin key — {(mutation.error as Error).message}</p>
      )}
      {mutation.isSuccess && <p role="status">Mobbin key saved securely.</p>}
    </section>
  );
}
