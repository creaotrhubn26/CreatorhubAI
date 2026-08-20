import { useQuery } from "@tanstack/react-query";
import type { GlimmerTask } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";

const STATUS_COLOR: Record<GlimmerTask["status"], string> = {
  pending: "var(--gray)", in_progress: "var(--blue)", complete: "var(--green)", failed: "var(--red)",
};

export function TasksPanel({ sessionId }: { sessionId: string }) {
  // Flat task list is opt-in and written by the orchestrator as it runs;
  // fetch once like the other artifact panels rather than polling a file.
  const { data: tasks } = useQuery({
    queryKey: ["session-tasks", sessionId],
    queryFn: () => glimmerApi.getSessionTasks(sessionId),
    enabled: !!sessionId,
    retry: false,
  });

  // Absence (404) is normal for sessions that never opted into task tracking.
  if (!tasks?.length) return null;

  return (
    <fieldset>
      <legend>Tasks</legend>
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Deterministic — evidence-driven task list, not a model guess
      </p>
      <ul>
        {tasks.map((t) => {
          const color = STATUS_COLOR[t.status] ?? "var(--gray)";
          return (
            <li key={t.id}>
              <span style={{ color, border: `1px solid ${color}`, borderRadius: "var(--radius)", padding: "2px 6px", fontSize: 12 }}>
                {t.status}
              </span>{" "}
              <strong>{t.kind}</strong> {t.description}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
