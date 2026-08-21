import { describe, it, expect } from "vitest";
import { completionTitle, newlyCompleted } from "./completionNotify";

describe("completionTitle", () => {
  it("returns the base title when there are no unseen completions", () => {
    expect(completionTitle("Glimmer Control Center", 0)).toBe("Glimmer Control Center");
  });

  it("prefixes the unseen count when there are unseen completions", () => {
    expect(completionTitle("Glimmer Control Center", 3)).toBe("(3) Glimmer Control Center");
  });
});

describe("newlyCompleted", () => {
  it("flags a session that moved from a running state to a terminal one", () => {
    expect(newlyCompleted({ s1: "implementing" }, { s1: "verified" })).toEqual(["s1"]);
  });

  it("ignores a session that stayed within the running states", () => {
    expect(newlyCompleted({ s1: "implementing" }, { s1: "verifying" })).toEqual([]);
  });

  it("ignores a session that was already terminal", () => {
    expect(newlyCompleted({ s1: "verified" }, { s1: "verified" })).toEqual([]);
  });

  it("ignores a session with no prior entry, since it can't have transitioned", () => {
    expect(newlyCompleted({}, { s1: "verified" })).toEqual([]);
  });

  it("flags waiting_for_approval -> blocked as a completion (per AgentStateStepper.STATES)", () => {
    expect(newlyCompleted({ s1: "waiting_for_approval" }, { s1: "blocked" })).toEqual(["s1"]);
  });

  it("evaluates multiple sessions independently", () => {
    const prev = { s1: "implementing", s2: "verifying", s3: "verified" };
    const next = { s1: "verified", s2: "verifying", s3: "verified" };
    expect(newlyCompleted(prev, next)).toEqual(["s1"]);
  });
});
