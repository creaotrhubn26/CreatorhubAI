import type { GlimmerSessionStatus } from "@glimmer/shared";
import { StatusBadge } from "../common/StatusBadge";

const STATES: GlimmerSessionStatus[] = [
  "understanding", "discovery", "candidate_selection", "implementing", "verifying", "repairing", "verified",
];

export function AgentStateStepper({ current }: { current: GlimmerSessionStatus }) {
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
