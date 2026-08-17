const COLOR: Record<string, string> = {
  ONLINE: "var(--green)", VERIFIED: "var(--green)", PASS: "var(--green)",
  REACHABLE_AUTH: "var(--amber)", waiting_for_approval: "var(--amber)",
  OFFLINE: "var(--red)", FAILED: "var(--red)", failed: "var(--red)", blocked: "var(--red)",
  implementing: "var(--blue)", verifying: "var(--blue)", discovery: "var(--blue)",
  NOT_RUN: "var(--gray)", created: "var(--gray)",
};

export function StatusBadge({ status }: { status: string }) {
  const color = COLOR[status] ?? "var(--gray)";
  return (
    <span style={{ color, border: `1px solid ${color}`, borderRadius: "var(--radius)", padding: "2px 6px", fontSize: 12 }}>
      {status}
    </span>
  );
}
