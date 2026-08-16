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
    },
  });

  return (
    <div>
      <h1>Diff Review</h1>
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
