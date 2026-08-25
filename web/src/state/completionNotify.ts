import { STATES as RUNNING_STATES } from "../components/session/AgentStateStepper";

// `waiting_for_approval` is a stepper state but NOT a running state for
// notification purposes: the session has stopped and is waiting on a human
// (V7 §35). Counting it as running meant entering the pause fired no
// notification and no title badge — a user who switched away saw a session
// that looked busy for the full 300 s timeout, then an unexplained
// POLICY_BLOCK. Harmless while the pause was unreachable for gateway runs;
// forwarding the scope flags (buildArgs) is exactly what makes it live.
const RUNNING = new Set<string>(RUNNING_STATES.filter((s) => s !== "waiting_for_approval"));

// document.title helper: base title, or "(N) " + base once there are
// completions the user hasn't looked at yet.
export function completionTitle(base: string, unseenCount: number): string {
  return unseenCount === 0 ? base : `(${unseenCount}) ${base}`;
}

// Pure transition detector: session ids present in both maps that were
// running in `prev` and are no longer running in `next`. An id with no
// entry in `prev` (new to this poll) can't have "transitioned", so it's
// skipped rather than treated as a completion.
export function newlyCompleted(
  prev: Record<string, string>,
  next: Record<string, string>,
): string[] {
  const ids: string[] = [];
  for (const [id, status] of Object.entries(next)) {
    const prevStatus = prev[id];
    if (prevStatus !== undefined && RUNNING.has(prevStatus) && !RUNNING.has(status)) ids.push(id);
  }
  return ids;
}

// Single gate for "does this completion count as unseen" — shared by both
// the title badge and the system notification, so a session finishing
// while its own tab is open and the window is focused triggers neither.
export function isUnseenCompletion(
  id: string,
  activeSessionId: string | undefined,
  hidden: boolean,
): boolean {
  return id !== activeSessionId || hidden;
}
