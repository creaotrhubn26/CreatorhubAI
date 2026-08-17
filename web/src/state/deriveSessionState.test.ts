import { describe, it, expect } from "vitest";
import { deriveSessionState } from "./deriveSessionState";
import type { GlimmerEvent } from "@glimmer/shared";

function stateEvent(state: string, id: string): GlimmerEvent {
  return { id, sessionId: "s1", timestamp: "t", type: "agent_state_changed", state: state as any };
}

describe("deriveSessionState", () => {
  it("returns the fallback when there are no state events", () => {
    expect(deriveSessionState([], "verified")).toBe("verified");
  });

  it("returns the most recent agent_state_changed event's state", () => {
    const events = [stateEvent("discovery", "e1"), stateEvent("implementing", "e2"), stateEvent("verifying", "e3")];
    expect(deriveSessionState(events, "created")).toBe("verifying");
  });

  it("ignores non-state events when finding the latest state", () => {
    const events: GlimmerEvent[] = [
      stateEvent("discovery", "e1"),
      { id: "e2", sessionId: "s1", timestamp: "t", type: "tool_started", tool: "read_file", args: {} },
    ];
    expect(deriveSessionState(events, "created")).toBe("discovery");
  });
});
