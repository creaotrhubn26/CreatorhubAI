import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";

const LABELS = { in_sync: "In sync", drift: "Update available", missing: "Missing" } as const;

export function IntegrationProfileSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["integration-profile"],
    queryFn: glimmerApi.getIntegrationProfile,
    staleTime: 15_000,
  });
  const apply = useMutation({
    mutationFn: (version: string) => glimmerApi.applyIntegrationProfile(version),
    onSuccess: (result) => queryClient.setQueryData(["integration-profile"], result.preview),
  });
  const rollback = useMutation({
    mutationFn: (backupId: string) => glimmerApi.rollbackIntegrationProfile(backupId),
    onSuccess: (result) => queryClient.setQueryData(["integration-profile"], result.preview),
  });
  const profile = query.data;
  const error = query.error ?? apply.error ?? rollback.error;

  return (
    <section className="cli-integrations" aria-labelledby="integration-profile-title">
      <div className="cli-integrations__title-row">
        <div>
          <h2 id="integration-profile-title">CreatorHub Engineering profile</h2>
          <p>One version across Codex, Claude and Glimmer, with preview, backup and rollback.</p>
        </div>
        <button type="button" onClick={() => query.refetch()} disabled={query.isFetching}>
          {query.isFetching ? "Checking…" : "Refresh profile"}
        </button>
      </div>
      <p className="cli-integrations__policy">
        Apply copies only the locally installed CreatorHub package. It runs no plugin installer
        script, reads no credentials, and creates a private recovery backup before replacing files.
      </p>
      {query.isPending && <p role="status">Building integration preview…</p>}
      {error && <p role="alert">Integration profile failed — {(error as Error).message}</p>}
      {profile && (
        <>
          <div className="cli-integrations__summary">
            <span>Desired {profile.desiredVersion ?? "Unavailable"}</span>
            <span>
              {profile.targets.filter((target) => target.state === "in_sync").length}/3 in sync
            </span>
            <span>Backup before every apply</span>
          </div>
          {profile.sourcePath && <p className="mono cli-integration__path">{profile.sourcePath}</p>}
          <div className="cli-integrations__grid">
            {profile.targets.map((target) => (
              <article className="cli-integration" data-state={target.state} key={target.id}>
                <div className="cli-integration__heading">
                  <h3>{target.name}</h3>
                  <span className="cli-integration__state">{LABELS[target.state]}</span>
                </div>
                <p>{target.action}</p>
                <p className="mono cli-integration__path">{target.path}</p>
              </article>
            ))}
          </div>
          <div className="diagnostics__actions">
            <button
              type="button"
              disabled={!profile.canApply || !profile.desiredVersion || apply.isPending}
              onClick={() => profile.desiredVersion && apply.mutate(profile.desiredVersion)}
            >
              {apply.isPending ? "Applying backed-up profile…" : "Apply reviewed profile"}
            </button>
            <button
              type="button"
              disabled={!profile.latestRollbackId || rollback.isPending}
              onClick={() => profile.latestRollbackId && rollback.mutate(profile.latestRollbackId)}
            >
              {rollback.isPending ? "Rolling back…" : "Rollback latest apply"}
            </button>
          </div>
          {apply.data && (
            <p role="status">
              Applied {apply.data.appliedTargets.join(", ") || "no changes"}. Backup:{" "}
              {apply.data.backupId ?? "not needed"}.
            </p>
          )}
          {rollback.data && <p role="status">Rolled back backup {rollback.data.backupId}.</p>}
        </>
      )}
    </section>
  );
}
