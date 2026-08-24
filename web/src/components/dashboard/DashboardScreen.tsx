import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { glimmerApi } from "../../api/client";
import { StatusBadge } from "../common/StatusBadge";
import { EmptyState } from "../common/EmptyState";
import { isPendingSessionId, relativeTime, sessionTimestamp } from "../../state/sessionListMeta";

export function DashboardScreen() {
  const { data, isLoading } = useQuery({ queryKey: ["status"], queryFn: glimmerApi.getStatus, refetchInterval: 5000 });

  if (isLoading || !data) return <div>Loading dashboard…</div>;

  // pending-* rows are transient adopted-workspace placeholders, never a
  // second real session — same rule as the sidebar and /sessions list.
  const recentSessions = data.recentSessions.filter((s) => !isPendingSessionId(s.id));

  return (
    <div>
      <h1>Dashboard</h1>
      <section>
        <h2>Muse Glimmer</h2>
        <StatusBadge status={data.model.status} />
        {/* Nothing can run without the model server, and starting it is no
            longer a terminal errand — point at the screen that owns it. */}
        {data.model.status !== "ONLINE" && <Link to="/model">Start the model server</Link>}
      </section>
      <section>
        <h2>Active session</h2>
        {data.activeSession ? (
          <div>
            <StatusBadge status={data.activeSession.status} /> {data.activeSession.changedFiles.length} changed files
          </div>
        ) : (
          <EmptyState icon="○" text="Unavailable" />
        )}
      </section>
      <section>
        <h2>Latest session</h2>
        {data.latestSession ? (
          <div>
            {data.latestSession.task} <StatusBadge status={data.latestSession.status} />
          </div>
        ) : (
          <EmptyState icon="○" text="Unavailable" />
        )}
      </section>
      <section>
        <h2>Verification</h2>
        {data.verification ? <StatusBadge status={data.verification.overall} /> : <EmptyState icon="○" text="Unavailable" />}
      </section>
      <section>
        <h2>Recent sessions</h2>
        <ul>
          {recentSessions.map((s) => (
            <li key={s.id} className="row">
              {s.task} <StatusBadge status={s.status} /> {s.changedFiles.length} files
              <span className="session-list-row__meta">{relativeTime(sessionTimestamp(s))}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
