import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { StatusBadge } from "../common/StatusBadge";
import { EmptyState } from "../common/EmptyState";
import { groupSessionsByDay, isPendingSessionId, relativeTime, sessionTimestamp } from "../../state/sessionListMeta";

export function SessionHistoryScreen() {
  const { data } = useQuery({ queryKey: ["sessions"], queryFn: glimmerApi.listSessions });
  const navigate = useNavigate();

  // pending-* rows are transient adopted-workspace placeholders — a
  // duplicate of the real session once it appears, not a second session.
  const sessions = (data ?? []).filter((s) => !isPendingSessionId(s.id));
  const groups = groupSessionsByDay(sessions);

  return (
    <div>
      <h1>Sessions</h1>
      {sessions.length === 0 && (
        <EmptyState
          icon="○"
          text="Unavailable"
          action={{ label: "New Task", onAction: () => navigate("/tasks/new") }}
        />
      )}
      {groups.map((group) => (
        <div className="session-list-group" key={group.label}>
          <h2 className="session-list-group__label">{group.label}</h2>
          <ul>
            {group.sessions.map((s) => (
              <li key={s.id} className="row">
                <Link to={`/sessions/${s.id}`}>{s.task}</Link>
                <span className="session-list-row__meta">
                  <StatusBadge status={s.status} /> · {relativeTime(sessionTimestamp(s))} · {s.changedFiles.length} files
                  {s.humanAcceptance?.accepted && " · Accepted"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
