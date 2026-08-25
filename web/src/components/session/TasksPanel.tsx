import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GlimmerSession, GlimmerTask } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { CollapsibleSection } from "../common/CollapsibleSection";

// V7 "Control Center UX" / "Task graph view": grouped-by-kind list is the
// default; graph is opt-in for complex sessions. Kind vocabulary matches
// GlimmerTask.kind (glimmer-v2.py's C3 task graph + O2 documentation tasks).
const KIND_ORDER: GlimmerTask["kind"][] = ["implementation", "verification", "repair", "documentation"];
const KIND_LABEL: Record<GlimmerTask["kind"], string> = {
  implementation: "Implementation", verification: "Verification", repair: "Repair", documentation: "Documentation",
};

// Deliberately local, not the shared common/StatusBadge's statusColor() --
// that map's vocabulary is session-level statuses (verified/repairing/...);
// task statuses are a completely different, smaller set, and "pending" vs.
// "in_progress" vs. "complete" need to stay visually distinct from each
// other, which the shared map's fallback-to-gray does not give them.
const TASK_STATUS_COLOR: Record<GlimmerTask["status"], string> = {
  pending: "var(--gray)", in_progress: "var(--blue)", complete: "var(--green)",
  failed: "var(--red)", skipped: "var(--gray)",
};

function TaskStatusBadge({ status }: { status: GlimmerTask["status"] }) {
  return (
    <span className="badge-status" style={{ ["--badge-color" as any]: TASK_STATUS_COLOR[status] ?? "var(--gray)" }}>
      {status}
    </span>
  );
}

// Session statuses where a human skip/approve action is still meaningful --
// "session non-terminal or needs_review" per the brief (needs_review IS
// terminal for gate-computation purposes, see TERMINAL_SESSION_STATUSES
// below, but a human is exactly who's expected to act on required tasks in
// that state).
const READONLY_SESSION_STATUSES: ReadonlySet<GlimmerSession["status"]> = new Set([
  "verified", "completed", "no_change", "failed", "blocked", "cancelled",
]);

// Review round 1 (Important 2): every status where glimmer-v2.py's process
// has already exited and gates were already computed -- unlike
// READONLY_SESSION_STATUSES above, this INCLUDES needs_review, because an
// override recorded on a needs_review session still can't retroactively
// change gates this run already wrote to manifest.json. Used only to decide
// whether to show the "takes effect on the next run" note, never to hide
// the buttons themselves (needs_review must stay actionable).
const TERMINAL_SESSION_STATUSES: ReadonlySet<GlimmerSession["status"]> = new Set([
  "verified", "completed", "no_change", "failed", "blocked", "cancelled", "needs_review",
]);

function PriorityBadge({ priority }: { priority?: GlimmerTask["priority"] }) {
  // v1 tasks.json (predating Task 4.1) has no priority field at all --
  // treated as "required" for display, mirroring glimmer-v2.py's own
  // back-compat default for tasks with no priority (the only tier that
  // ever existed before this field).
  const p = priority ?? "required";
  if (p === "required") {
    return <span className="badge-status" style={{ ["--badge-color" as any]: "var(--red)" }}>required</span>;
  }
  if (p === "recommended") {
    return <span className="meta-value" style={{ ["--badge-color" as any]: "var(--amber)" }}>recommended</span>;
  }
  return <span style={{ color: "var(--text-muted)" }}>optional</span>;
}

function TaskCard({ task, canAct, sessionTerminal, onSkip, onApprove, pending }: {
  task: GlimmerTask;
  canAct: boolean;
  sessionTerminal: boolean;
  onSkip: (taskId: string) => void;
  onApprove: (taskId: string) => void;
  pending: boolean;
}) {
  const showButtons = canAct && !task.override && ["pending", "in_progress", "failed"].includes(task.status);
  return (
    <li className="row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
      <div>
        <TaskStatusBadge status={task.status} /> <PriorityBadge priority={task.priority} />{" "}
        <strong>{task.kind}</strong> {task.description}
      </div>
      {task.dependsOn.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>depends on: {task.dependsOn.join(", ")}</div>
      )}
      {task.blockingReason && (
        <div style={{ fontSize: 12, color: "var(--amber)" }}>{task.blockingReason}</div>
      )}
      {task.affectedFiles && task.affectedFiles.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>files: {task.affectedFiles.join(", ")}</div>
      )}
      {task.createdBecause && (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>because: {task.createdBecause}</div>
      )}
      {task.override && (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          human: {task.override.action} at {new Date(task.override.at).toLocaleString()}
        </div>
      )}
      {/* Review round 1 (Important 2): a session's gates are computed once,
          at process-exit time -- an override recorded afterward (this
          session already reached a terminal status, needs_review included)
          is real and stored, but cannot change THIS run's already-written
          gates. Deterministic, not a guess: shown purely off session
          status. */}
      {task.override && sessionTerminal && (
        <div style={{ fontSize: 12, color: "var(--amber)" }}>Recorded — takes effect on the next run</div>
      )}
      {/* Review round 1 (Important 3): task-overrides.json keys by task id,
          but ids can be recycled across a replan (merge_replanned_tasks
          renumbers). An override whose recorded kind/description no longer
          match THIS task with that id was written for a task that no
          longer exists -- ignored, not silently misapplied. */}
      {task.staleOverride && (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          A recorded {task.staleOverride.action} override no longer matches this task (its id was reused by a
          replan) — ignored.
        </div>
      )}
      {showButtons && (
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => onSkip(task.id)} disabled={pending}>Skip</button>
          <button onClick={() => onApprove(task.id)} disabled={pending}>Approve</button>
        </div>
      )}
    </li>
  );
}

// Graph view: dependency columns computed by longest-path depth (no
// layout library — text/CSS only, same spirit as RepairCycleStepper's
// connector). A task's column is one past the deepest of its dependsOn
// entries; tasks with no (resolvable) deps sit in column 0. dependsOn ids
// that don't resolve to a real task (or a cycle) fall back to depth 0
// rather than throwing — tasks.json is orchestrator output, not to be
// blindly trusted by a display component.
function computeColumns(tasks: GlimmerTask[]): GlimmerTask[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  function depthOf(t: GlimmerTask, seen: Set<string>): number {
    if (depth.has(t.id)) return depth.get(t.id)!;
    if (seen.has(t.id)) return 0; // cycle guard
    seen.add(t.id);
    const deps = t.dependsOn.map((id) => byId.get(id)).filter((d): d is GlimmerTask => !!d);
    const d = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => depthOf(dep, seen))) + 1;
    depth.set(t.id, d);
    return d;
  }
  const maxDepth = tasks.reduce((m, t) => Math.max(m, depthOf(t, new Set())), 0);
  const columns: GlimmerTask[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const t of tasks) columns[depthOf(t, new Set())].push(t);
  return columns;
}

export function TasksPanel({ sessionId, session }: { sessionId: string; session?: GlimmerSession | null }) {
  const [view, setView] = useState<"list" | "graph">("list");
  const queryClient = useQueryClient();

  // Flat task list is opt-in and written by the orchestrator as it runs;
  // fetch once like the other artifact panels rather than polling a file.
  const { data: tasks } = useQuery({
    queryKey: ["session-tasks", sessionId],
    queryFn: () => glimmerApi.getSessionTasks(sessionId),
    enabled: !!sessionId,
    retry: false,
  });

  // Task 4.3: gateway-owned, reversible-by-second-click-only, one-shot
  // buttons -- see writeTaskOverride (server/src/lib/sessions.ts).
  const skipMutation = useMutation({
    mutationFn: (taskId: string) => glimmerApi.skipTask(sessionId, taskId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session-tasks", sessionId] }),
  });
  const approveMutation = useMutation({
    mutationFn: (taskId: string) => glimmerApi.approveTask(sessionId, taskId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session-tasks", sessionId] }),
  });

  // Absence (404) is normal for sessions that never opted into task tracking.
  if (!tasks?.length) return null;

  const done = tasks.filter((t) => t.status === "complete").length;
  // Review round 1 (Moderate 7): a human "approve" override launders a
  // task into the same status="complete" the "done" count above reads --
  // without this, N/M complete would silently blend orchestrator evidence
  // and a human's manual sign-off into one indistinguishable number.
  const humanApproved = tasks.filter((t) => t.override?.action === "approve").length;
  const summary = humanApproved > 0
    ? `${done}/${tasks.length} complete (${humanApproved} human)`
    : `${done}/${tasks.length} complete`;
  // Review round 1 (Minor 8d): wait for the session to actually load before
  // deciding whether actions are allowed -- session===undefined means "not
  // loaded yet", not "no restriction", so buttons don't flash visible then
  // disappear once the real status arrives.
  const canAct = session != null && !READONLY_SESSION_STATUSES.has(session.status);
  const sessionTerminal = session != null && TERMINAL_SESSION_STATUSES.has(session.status);
  const anyPending = skipMutation.isPending || approveMutation.isPending;

  return (
    <CollapsibleSection title="Tasks" summary={summary}>
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Deterministic — evidence-driven task list, not a model guess
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => setView("list")} disabled={view === "list"}>List</button>
        <button onClick={() => setView("graph")} disabled={view === "graph"}>Graph</button>
      </div>

      {view === "list" ? (
        KIND_ORDER.filter((kind) => tasks.some((t) => t.kind === kind)).map((kind) => (
          <div key={kind}>
            <h4 style={{ margin: "8px 0 4px" }}>{KIND_LABEL[kind]}</h4>
            <ul>
              {tasks.filter((t) => t.kind === kind).map((t) => (
                <TaskCard
                  key={t.id} task={t} canAct={canAct} sessionTerminal={sessionTerminal} pending={anyPending}
                  onSkip={(id) => skipMutation.mutate(id)} onApprove={(id) => approveMutation.mutate(id)}
                />
              ))}
            </ul>
          </div>
        ))
      ) : (
        <div style={{ display: "flex", gap: 24, overflowX: "auto" }}>
          {computeColumns(tasks).map((col, idx) => (
            <div key={idx} style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 180 }}>
              <ul>
                {col.map((t) => (
                  <TaskCard
                    key={t.id} task={t} canAct={canAct} sessionTerminal={sessionTerminal} pending={anyPending}
                    onSkip={(id) => skipMutation.mutate(id)} onApprove={(id) => approveMutation.mutate(id)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}
