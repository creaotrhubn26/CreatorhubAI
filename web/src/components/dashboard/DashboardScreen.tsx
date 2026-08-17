import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { StatusBadge } from "../common/StatusBadge";

export function DashboardScreen() {
  const { data, isLoading } = useQuery({ queryKey: ["status"], queryFn: glimmerApi.getStatus, refetchInterval: 5000 });

  if (isLoading || !data) return <div>Loading dashboard…</div>;

  return (
    <div>
      <h1>Dashboard</h1>
      <section>
        <h2>Muse Glimmer</h2>
        <StatusBadge status={data.model.status} />
      </section>
      <section>
        <h2>Active session</h2>
        {data.activeSession ? (
          <div>
            <StatusBadge status={data.activeSession.status} /> {data.activeSession.changedFiles.length} changed files
          </div>
        ) : (
          <div>Unavailable</div>
        )}
      </section>
      <section>
        <h2>Latest session</h2>
        {data.latestSession ? (
          <div>
            {data.latestSession.task} <StatusBadge status={data.latestSession.status} />
          </div>
        ) : (
          <div>Unavailable</div>
        )}
      </section>
      <section>
        <h2>Verification</h2>
        {data.verification ? <StatusBadge status={data.verification.overall} /> : <div>Unavailable</div>}
      </section>
      <section>
        <h2>Recent sessions</h2>
        <ul>
          {data.recentSessions.map((s) => (
            <li key={s.id}>
              {s.task} <StatusBadge status={s.status} /> {s.changedFiles.length} files
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
