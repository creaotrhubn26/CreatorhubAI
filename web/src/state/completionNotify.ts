import { STATES as RUNNING_STATES } from "../components/session/AgentStateStepper";

const RUNNING = new Set<string>(RUNNING_STATES);

// document.title helper: base title, or "(N) " + base once there are
// completions the user hasn't looked at yet.
export function completionTitle(base: string, unseenCount: number): string {
  return unseenCount === 0 ? base : `(${unseenCount}) ${base}`;
}

// Pure transition detector: session ids present in both maps that were
// running in `prev` and are no longer running in `next`. An id with no
// entry in `prev` (new to this poll) can't have "transitioned", so it's
// skipped rather than treated as a completion.
export function newlyCompleted(prev: Record<string, string>, next: Record<string, string>): string[] {
  const ids: string[] = [];
  for (const [id, status] of Object.entries(next)) {
    const prevStatus = prev[id];
    if (prevStatus !== undefined && RUNNING.has(prevStatus) && !RUNNING.has(status)) ids.push(id);
  }
  return ids;
}
