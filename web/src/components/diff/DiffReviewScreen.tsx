import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";

export function DiffReviewScreen() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { data: session } = useQuery({ queryKey: ["session", id], queryFn: () => glimmerApi.getSession(id!), enabled: !!id });
  const { data: diffResult } = useQuery({ queryKey: ["diff", id], queryFn: () => glimmerApi.getSessionDiff(id!), enabled: !!id });
  const revertMutation = useMutation({
    mutationFn: (path: string) => glimmerApi.revertFile(id!, path),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["session", id] });
      queryClient.invalidateQueries({ queryKey: ["diff", id] });
      queryClient.invalidateQueries({ queryKey: ["session-analysis", id] });
    },
  });
  // §14 Diff Review: "accept for review" is a distinct human-judgment fact,
  // never something the model/orchestrator can set — see acceptSession in
  // api/client.ts and POST /sessions/:id/accept on the gateway.
  const acceptMutation = useMutation({
    mutationFn: () => glimmerApi.acceptSession(id!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session", id] }),
  });
  const humanAcceptance = session?.humanAcceptance;

  return (
    <div>
      <h1>Diff Review</h1>
      <p>
        Technical: {session?.verification?.overall ?? "Unavailable"} — Human review:{" "}
        {humanAcceptance?.accepted
          ? `Accepted ${new Date(humanAcceptance.acceptedAt).toLocaleString()}`
          : "Not yet accepted"}
      </p>
      {!humanAcceptance?.accepted && (
        <button onClick={() => acceptMutation.mutate()} disabled={acceptMutation.isPending}>
          Accept for review
        </button>
      )}
      {acceptMutation.isError && <div>Unavailable — could not accept this session.</div>}
      <ul>
        {session?.changedFiles.map((f) => (
          <li key={f.path}>
            M {f.path}{" "}
            <button onClick={() => revertMutation.mutate(f.path)} disabled={revertMutation.isPending}>
              Revert
            </button>
          </li>
        )) ?? <li>Unavailable</li>}
      </ul>
      {revertMutation.isError && <div>Unavailable — could not revert this file.</div>}
      <pre className="mono">{diffResult?.diff ?? "Unavailable"}</pre>
    </div>
  );
}
