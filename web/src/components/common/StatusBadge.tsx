const COLOR: Record<string, string> = {
  ONLINE: "var(--green)",
  VERIFIED: "var(--green)",
  PASS: "var(--green)",
  verified: "var(--green)",
  completed: "var(--green)",
  REACHABLE_AUTH: "var(--amber)",
  waiting_for_approval: "var(--amber)",
  needs_review: "var(--amber)",
  repairing: "var(--amber)",
  OFFLINE: "var(--red)",
  FAILED: "var(--red)",
  failed: "var(--red)",
  blocked: "var(--red)",
  implementing: "var(--blue)",
  verifying: "var(--blue)",
  discovery: "var(--blue)",
  preflight: "var(--blue)",
  understanding: "var(--blue)",
  candidate_selection: "var(--blue)",
  NOT_RUN: "var(--gray)",
  created: "var(--gray)",
  cancelled: "var(--gray)",
  no_change: "var(--gray)",
  // ModelRunState intermediates (ModelStatusScreen). OFFLINE/ONLINE/FAILED
  // already map above; these two are the "in progress" pair — blue while the
  // process comes up, amber while the model loads (minutes, not seconds).
  STARTING: "var(--blue)",
  LOADING: "var(--amber)",
  // V7 §20: non-success terminal (workspace changed after VERIFIED) -- same
  // amber as needs_review/repairing, not red: no failure occurred, a re-run
  // just needs to happen.
  stale: "var(--amber)",
  // Stepper-only step states (RepairCycleStepper) — not session/verification
  // statuses, just the local DONE/RUNNING/PENDING vocabulary it derives.
  DONE: "var(--green)",
  RUNNING: "var(--blue)",
  PENDING: "var(--gray)",
  // V7 §22.4/§22.14 visual verification statuses (build_findings /
  // build_manifest, VisualVerificationPanel) — lowercase "pass"/"partial"
  // are the capture-only manifest.status; the rest are findings.json's
  // real reviewed/blocked/warned outcomes once --vision ran.
  pass: "var(--green)",
  partial: "var(--amber)",
  PASS_WITH_WARNINGS: "var(--amber)",
  BLOCKED: "var(--amber)",
  FAIL: "var(--red)",
  // Task 7.5 (V7 "System Explorer") -- DocNodeStatus. MISSING is red (a
  // documented node whose target no longer exists is a real problem);
  // GENERATED/DEPRECATED share --gray, this palette's existing "muted"
  // color, per the task's "visually muted" requirement.
  CURRENT: "var(--green)",
  STALE: "var(--amber)",
  UNVERIFIED: "var(--amber)",
  MISSING: "var(--red)",
  GENERATED: "var(--gray)",
  DEPRECATED: "var(--gray)",
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
