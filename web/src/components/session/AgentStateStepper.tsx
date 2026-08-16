import type { GlimmerSessionStatus } from "@glimmer/shared";
import { StatusBadge } from "../common/StatusBadge";

// The in-flight flow only. Terminal states (verified/failed/blocked/
// needs_review/cancelled) are not steps — they replace the stepper, so a
// finished session never renders as if it were mid-flow.
const STATES: GlimmerSessionStatus[] = [
  "created", "preflight", "understanding", "discovery", "candidate_selection",
  "implementing", "verifying", "repairing", "waiting_for_approval",
];

export function AgentStateStepper({ current }: { current: GlimmerSessionStatus }) {
  if (!STATES.includes(current)) return <StatusBadge status={current} />;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {STATES.map((s) => (
        <span key={s} style={{ opacity: s === current ? 1 : 0.4 }}>
          {s === current ? <StatusBadge status={s} /> : s}
        </span>
      ))}
    </div>
  );
}
