import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";

export function DiffReviewScreen() {
  const { id } = useParams<{ id: string }>();
  const { data: session } = useQuery({ queryKey: ["session", id], queryFn: () => glimmerApi.getSession(id!), enabled: !!id });
  const { data: diffResult } = useQuery({ queryKey: ["diff", id], queryFn: () => glimmerApi.getSessionDiff(id!), enabled: !!id });

  return (
    <div>
      <h1>Diff Review</h1>
      <ul>
        {session?.changedFiles.map((f) => <li key={f.path}>M {f.path}</li>) ?? <li>Unavailable</li>}
      </ul>
      <pre className="mono">{diffResult?.diff ?? "Unavailable"}</pre>
    </div>
  );
}
