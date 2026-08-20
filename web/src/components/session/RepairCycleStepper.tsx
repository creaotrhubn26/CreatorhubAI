import type { GlimmerSession, GlimmerSessionStatus } from "@glimmer/shared";
import { StatusBadge } from "../common/StatusBadge";

// Spec §17: Implementation -> Repair 1..N -> Verification -> Final status.
// Every label below is derived only from fields the session already carries
// (status, repairsUsed, repairBudget, verification.overall) — no per-repair
// pass/fail history exists, so steps that haven't happened yet say PENDING
// rather than guessing an outcome.
const PAST_IMPLEMENTATION: ReadonlySet<GlimmerSessionStatus> = new Set([
  "verifying", "repairing", "waiting_for_approval",
  "verified", "failed", "blocked", "needs_review", "cancelled",
]);
const REACHED_VERIFICATION: ReadonlySet<GlimmerSessionStatus> = new Set([
  "repairing", "waiting_for_approval", "verified", "failed", "blocked", "needs_review", "cancelled",
]);
const TERMINAL: ReadonlySet<GlimmerSessionStatus> = new Set([
  "verified", "failed", "blocked", "needs_review", "cancelled",
]);

export function RepairCycleStepper({ session }: { session: GlimmerSession }) {
  const { status, repairsUsed, repairBudget, verification } = session;

  // A repair round only ever starts because the prior attempt failed, so
  // repairsUsed > 0 (or being mid-repair right now) is honest evidence that
  // Implementation itself failed — this isn't fabricated, it's implied by
  // the field's own meaning.
  const implementationState = status === "repairing" || repairsUsed > 0
    ? "FAILED"
    : PAST_IMPLEMENTATION.has(status)
      ? "DONE"
      : "RUNNING";

  const verificationState = status === "verifying"
    ? "RUNNING"
    : REACHED_VERIFICATION.has(status)
      ? verification.overall
      : "PENDING";

  const finalState = TERMINAL.has(status) ? status : "PENDING";

  return (
    <div>
      <dl>
        <dt>Repair budget</dt>
        <dd className="mono">{repairsUsed} / {repairBudget} used</dd>
      </dl>
      <ol style={{ display: "flex", gap: 16, listStyle: "none", padding: 0, margin: 0 }}>
        <li style={{ opacity: implementationState === "RUNNING" || implementationState === "FAILED" ? 1 : 0.7 }}>
          <div className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>Implementation</div>
          <StatusBadge status={implementationState} />
        </li>
        {Array.from({ length: repairBudget }, (_, idx) => {
          const n = idx + 1;
          const state = n <= repairsUsed ? "DONE" : status === "repairing" && n === repairsUsed + 1 ? "RUNNING" : "PENDING";
          return (
            <li key={n} style={{ opacity: state === "PENDING" ? 0.4 : 1 }}>
              <div className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>Repair {n}</div>
              <StatusBadge status={state} />
            </li>
          );
        })}
        <li style={{ opacity: verificationState === "PENDING" ? 0.4 : 1 }}>
          <div className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>Verification</div>
          <StatusBadge status={verificationState} />
        </li>
        <li style={{ opacity: finalState === "PENDING" ? 0.4 : 1 }}>
          <div className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>Final status</div>
          <StatusBadge status={finalState} />
        </li>
      </ol>
    </div>
  );
}
