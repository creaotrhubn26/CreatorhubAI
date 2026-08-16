// shared/src/types.test.ts
import { describe, it, expect } from "vitest";
import { isGlimmerEvent } from "./types";

describe("isGlimmerEvent", () => {
  it("accepts a well-formed tool_started event", () => {
    const evt = {
      id: "evt_1",
      sessionId: "s1",
      timestamp: "2026-08-16T14:22:06+02:00",
      type: "tool_started",
      tool: "read_file",
      args: { path: "a.ts" },
    };
    expect(isGlimmerEvent(evt)).toBe(true);
  });

  it("rejects an object missing a discriminant", () => {
    expect(isGlimmerEvent({ id: "evt_2", sessionId: "s1", timestamp: "x" })).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(isGlimmerEvent("not an event")).toBe(false);
  });
});
