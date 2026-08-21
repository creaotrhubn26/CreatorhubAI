// Running-session liveness: elapsed time, last-activity label, and the
// stalled check that turns the label amber. Every value here derives ONLY
// from deterministic inputs (session startedAt, and events' own `timestamp`
// fields — never SSE receipt time) — never fabricated. Missing input means
// the caller omits the line, not a guess.

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

// "4m 12s" style elapsed time since a session's real startedAt. Caller
// should skip rendering entirely when startedAt is missing rather than
// call this with a guessed timestamp.
export function formatElapsed(startIso: string, nowMs: number): string {
  const startMs = new Date(startIso).getTime();
  return formatDuration((nowMs - startMs) / 1000);
}

// null when no SSE event has landed yet for this session — the caller
// omits the last-activity line rather than showing a fabricated "0s ago".
export function lastActivityLabel(lastEventAtMs: number | null, nowMs: number): string | null {
  if (lastEventAtMs === null) return null;
  const diffSeconds = Math.max(0, Math.floor((nowMs - lastEventAtMs) / 1000));
  if (diffSeconds < 5) return "last activity just now";
  if (diffSeconds < 60) return `last activity ${diffSeconds}s ago`;
  return `last activity ${Math.floor(diffSeconds / 60)}m ago`;
}

// True once a running session has gone >=120s without an SSE event. With
// no event yet at all (lastEventAtMs null) there's nothing deterministic to
// measure staleness against, so this stays false rather than guessing.
export function isStalled(lastEventAtMs: number | null, nowMs: number): boolean {
  if (lastEventAtMs === null) return false;
  return nowMs - lastEventAtMs >= 120_000;
}
