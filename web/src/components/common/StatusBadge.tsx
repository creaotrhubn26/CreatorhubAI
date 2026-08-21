const COLOR: Record<string, string> = {
  ONLINE: "var(--green)", VERIFIED: "var(--green)", PASS: "var(--green)", verified: "var(--green)",
  REACHABLE_AUTH: "var(--amber)", waiting_for_approval: "var(--amber)",
  needs_review: "var(--amber)", repairing: "var(--amber)",
  OFFLINE: "var(--red)", FAILED: "var(--red)", failed: "var(--red)", blocked: "var(--red)",
  implementing: "var(--blue)", verifying: "var(--blue)", discovery: "var(--blue)",
  preflight: "var(--blue)", understanding: "var(--blue)", candidate_selection: "var(--blue)",
  NOT_RUN: "var(--gray)", created: "var(--gray)", cancelled: "var(--gray)",
  // Stepper-only step states (RepairCycleStepper) — not session/verification
  // statuses, just the local DONE/RUNNING/PENDING vocabulary it derives.
  DONE: "var(--green)", RUNNING: "var(--blue)", PENDING: "var(--gray)",
};

// Shared with the IDE shell (session-list status dots, tab dots) so every
// status-color mapping in the app stays in one place.
export function statusColor(status: string): string {
  return COLOR[status] ?? "var(--gray)";
}

// Filled badge — reserved for terminal session status and stepper step
// state. Verification-check results use an outline pill (.badge-check,
// see VerificationCenterScreen) and plain metadata (risk/decision/
// readiness) uses colored text with no pill (.meta-value) — one consistent
// system, defined once in theme.css.
export function StatusBadge({ status }: { status: string }) {
  const color = statusColor(status);
  return (
    <span className="badge-status" style={{ ["--badge-color" as any]: color }}>
      {status}
    </span>
  );
}
