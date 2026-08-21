// Session list rows (sidebar, /sessions, dashboard) share the same three
// derivations: is this a transient "pending-*" row that should never be
// shown, what real timestamp does this session carry, and how do we group/
// label rows by day. All derived from real fields (the session id's own
// embedded timestamp, or completedAt when present) — never fabricated.

// Session ids look like `YYYYMMDD-HHMMSS-glimmer-<task-slug>`. Adopted
// pending-workspace rows use a `pending-` prefix and are transient — they
// disappear once the real session id shows up, so listing both is a
// duplicate, not two sessions.
export function isPendingSessionId(id: string): boolean {
  return id.startsWith("pending-");
}

const SESSION_ID_TS = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-glimmer-/;

export function sessionTimestamp(session: { id: string; completedAt?: string }): Date | null {
  if (session.completedAt) {
    const d = new Date(session.completedAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const m = session.id.match(SESSION_ID_TS);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const parsed = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function relativeTime(date: Date | null, now: Date = new Date()): string {
  if (!date) return "—";
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 60_000) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function dayLabel(date: Date | null, now: Date = new Date()): string {
  if (!date) return "Unknown";
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

// Session ids are `YYYYMMDD-HHMMSS-glimmer-<task-slug>` — long enough that
// showing them in full would blow out a tab, breadcrumb, or palette row.
// Keep the timestamp (which sorts/identifies) and a short slug tail.
export function shortSessionId(id: string): string {
  const marker = "-glimmer-";
  const idx = id.indexOf(marker);
  if (idx === -1) return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
  const stamp = id.slice(0, idx);
  const slug = id.slice(idx + marker.length);
  return `${stamp}…${slug.length > 12 ? slug.slice(-12) : slug}`;
}

export function groupSessionsByDay<T extends { id: string; completedAt?: string }>(
  sessions: T[],
  now: Date = new Date()
): Array<{ label: string; sessions: T[] }> {
  const groups: Array<{ label: string; sessions: T[] }> = [];
  for (const s of sessions) {
    const label = dayLabel(sessionTimestamp(s), now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.sessions.push(s);
    else groups.push({ label, sessions: [s] });
  }
  return groups;
}
