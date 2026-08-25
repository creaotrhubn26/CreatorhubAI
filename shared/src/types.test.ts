// shared/src/types.test.ts
import { describe, it, expect } from "vitest";
import { inferTaskIntent, isGlimmerEvent, taskModeAllowsWrites } from "./types";

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

  it("accepts model-call provenance without connection or key material", () => {
    const evt = {
      id: "evt_model_1",
      sessionId: "s1",
      timestamp: "2026-08-25T00:00:00Z",
      type: "model_request_started",
      requestId: "req-1",
      role: "architect",
      providerId: "frontier",
      modelId: "frontier-1",
    };
    expect(isGlimmerEvent(evt)).toBe(true);
    expect(evt).not.toHaveProperty("apiKey");
    expect(evt).not.toHaveProperty("baseUrl");
  });
});

describe("task intent and execution policy", () => {
  it.each([
    "Hva kan bli bedre?",
    "Se hva som kan forbedres i frontenden",
    "Finn forbedringsmuligheter",
    "What can be improved?",
    "Identify improvement opportunities",
  ])("recognizes an open-ended improvement assessment: %s", (objective) => {
    expect(inferTaskIntent(objective)).toEqual({
      kind: "improvement-assessment",
      source: "deterministic-inference",
    });
  });

  it("keeps concrete objectives direct", () => {
    expect(inferTaskIntent("Fix cancellation after a gateway restart").kind).toBe("direct");
  });

  it.each(["inspect", "plan", "review"] as const)("makes %s structurally read-only", (mode) => {
    expect(taskModeAllowsWrites(mode)).toBe(false);
  });

  it.each(["implement", "debug", "test", "refactor"] as const)("allows %s to write", (mode) => {
    expect(taskModeAllowsWrites(mode)).toBe(true);
  });
});
