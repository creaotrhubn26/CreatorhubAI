import { describe, it, expect } from "vitest";
import { completionTitle, isUnseenCompletion, newlyCompleted } from "./completionNotify";

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

  // waiting_for_approval is not a running state: the session has stopped and
  // is waiting on a human, so ENTERING it is the moment worth notifying about.
  it("flags implementing -> waiting_for_approval as a completion, so the pause is announced", () => {
    expect(newlyCompleted({ s1: "implementing" }, { s1: "waiting_for_approval" })).toEqual(["s1"]);
  });

  it("does not re-flag waiting_for_approval -> blocked, already announced when the pause began", () => {
    expect(newlyCompleted({ s1: "waiting_for_approval" }, { s1: "blocked" })).toEqual([]);
  });

  it("evaluates multiple sessions independently", () => {
    const prev = { s1: "implementing", s2: "verifying", s3: "verified" };
    const next = { s1: "verified", s2: "verifying", s3: "verified" };
    expect(newlyCompleted(prev, next)).toEqual(["s1"]);
  });
});

describe("isUnseenCompletion", () => {
  it("is unseen when a different session is currently active", () => {
    expect(isUnseenCompletion("s1", "s2", false)).toBe(true);
  });

  it("is unseen when the window is hidden, even for the active session", () => {
    expect(isUnseenCompletion("s1", "s1", true)).toBe(true);
  });

  it("is NOT unseen when it's the active session and the window is visible (shared gate for badge + notification)", () => {
    expect(isUnseenCompletion("s1", "s1", false)).toBe(false);
  });

  it("is unseen when there is no active session at all", () => {
    expect(isUnseenCompletion("s1", undefined, false)).toBe(true);
  });
});
