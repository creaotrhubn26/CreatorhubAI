const COLOR: Record<string, string> = {
  ONLINE: "var(--green)", VERIFIED: "var(--green)", PASS: "var(--green)", verified: "var(--green)",
  REACHABLE_AUTH: "var(--amber)", waiting_for_approval: "var(--amber)",
  needs_review: "var(--amber)", repairing: "var(--amber)",
  OFFLINE: "var(--red)", FAILED: "var(--red)", failed: "var(--red)", blocked: "var(--red)",
  implementing: "var(--blue)", verifying: "var(--blue)", discovery: "var(--blue)",
  preflight: "var(--blue)", understanding: "var(--blue)", candidate_selection: "var(--blue)",
  NOT_RUN: "var(--gray)", created: "var(--gray)", cancelled: "var(--gray)",
};

// Shared with the IDE shell (session-list status dots, tab dots) so every
// status-color mapping in the app stays in one place.
export function statusColor(status: string): string {
  return COLOR[status] ?? "var(--gray)";
}

export function StatusBadge({ status }: { status: string }) {
  const color = statusColor(status);
  return (
    <span style={{ color, border: `1px solid ${color}`, borderRadius: "var(--radius)", padding: "2px 6px", fontSize: 12 }}>
      {status}
    </span>
  );
}
