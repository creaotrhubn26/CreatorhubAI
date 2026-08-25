import type { GlimmerSession, GlimmerSessionStatus } from "@glimmer/shared";
import { StatusBadge, statusColor } from "../common/StatusBadge";

// Spec §17: Implementation -> Repair 1..N -> Verification -> Final status.
// Every label below is derived only from fields the session already carries
// (status, repairsUsed, repairBudget, verification.overall) — no per-repair
// pass/fail history exists, so steps that haven't happened yet say PENDING
// rather than guessing an outcome.
const PAST_IMPLEMENTATION: ReadonlySet<GlimmerSessionStatus> = new Set([
  "verifying", "repairing", "waiting_for_approval",
  "verified", "completed", "no_change", "failed", "blocked", "needs_review", "cancelled",
]);
const REACHED_VERIFICATION: ReadonlySet<GlimmerSessionStatus> = new Set([
  "repairing", "waiting_for_approval", "verified", "completed", "no_change", "failed", "blocked", "needs_review", "cancelled",
]);
const TERMINAL: ReadonlySet<GlimmerSessionStatus> = new Set([
  "verified", "completed", "no_change", "failed", "blocked", "needs_review", "cancelled",
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

  const steps: Array<{ key: string; label: string; state: string }> = [
    { key: "impl", label: "Implementation", state: implementationState },
    ...Array.from({ length: repairBudget }, (_, idx) => {
      const n = idx + 1;
      const state = n <= repairsUsed ? "DONE" : status === "repairing" && n === repairsUsed + 1 ? "RUNNING" : "PENDING";
      return { key: `repair-${n}`, label: `Repair ${n}`, state };
    }),
    { key: "verify", label: "Verification", state: verificationState },
    { key: "final", label: "Final status", state: finalState },
  ];

  // ✓ done / ● active / ○ pending — a real connected stepper instead of a
  // row of independent badges. Nodes sit on one continuous connector line
  // (drawn once behind the row, see .stepper__nodes::before in theme.css).
  function nodeGlyph(state: string): string {
    if (state === "PENDING") return "○";
    if (state === "RUNNING") return "●";
    return "✓";
  }

  return (
    <div>
      <dl>
        <dt>Repair budget</dt>
        <dd className="mono">{repairsUsed} / {repairBudget} used</dd>
      </dl>
      <div className="stepper" style={{ ["--stepper-cols" as any]: steps.length }}>
        <ul className="stepper__nodes">
          {steps.map((s) => (
            <li key={s.key} className="stepper__node-cell">
              <span className="stepper__node" style={{ ["--node-color" as any]: statusColor(s.state) }} aria-hidden="true">
                {nodeGlyph(s.state)}
              </span>
            </li>
          ))}
        </ul>
        <ul className="stepper__labels">
          {steps.map((s) => (
            <li key={s.key} style={{ opacity: s.state === "PENDING" ? 0.5 : 1 }}>
              <div className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>{s.label}</div>
              <StatusBadge status={s.state} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
