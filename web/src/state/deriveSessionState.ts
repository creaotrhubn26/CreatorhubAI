import type { GlimmerEvent, GlimmerSessionStatus } from "@glimmer/shared";

export function deriveSessionState(
  events: GlimmerEvent[],
  fallback: GlimmerSessionStatus,
): GlimmerSessionStatus {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "agent_state_changed") return e.state;
  }
  return fallback;
}
