import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { StatusBadge } from "../common/StatusBadge";

export function SessionHistoryScreen() {
  const { data } = useQuery({ queryKey: ["sessions"], queryFn: glimmerApi.listSessions });

  return (
    <div>
      <h1>Sessions</h1>
      <ul>
        {(data ?? []).map((s) => (
          <li key={s.id}>
            <Link to={`/sessions/${s.id}`}>{s.task}</Link> <StatusBadge status={s.status} /> {s.changedFiles.length} files
            {s.humanAcceptance?.accepted && (
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}> · Accepted</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
