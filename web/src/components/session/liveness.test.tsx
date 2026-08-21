import { describe, it, expect } from "vitest";
import { formatElapsed, lastActivityLabel, isStalled } from "../../state/liveness";

const START = "2026-08-22T12:00:00.000Z";
const START_MS = new Date(START).getTime();

describe("formatElapsed", () => {
  it("renders minutes and seconds once a minute has passed", () => {
    expect(formatElapsed(START, START_MS + 4 * 60_000 + 12_000)).toBe("4m 12s");
  });

  it("renders seconds only under a minute", () => {
    expect(formatElapsed(START, START_MS + 12_000)).toBe("12s");
  });

  it("renders hours and minutes once an hour has passed, dropping seconds", () => {
    expect(formatElapsed(START, START_MS + 60 * 60_000 + 4 * 60_000 + 30_000)).toBe("1h 4m");
  });
});

describe("lastActivityLabel", () => {
  it("returns null when no event has landed yet", () => {
    expect(lastActivityLabel(null, START_MS)).toBeNull();
  });

  it("says just now under 5 seconds", () => {
    expect(lastActivityLabel(START_MS, START_MS + 4_000)).toBe("last activity just now");
  });

  it("uses seconds form between 5 and 60 seconds", () => {
    expect(lastActivityLabel(START_MS, START_MS + 12_000)).toBe("last activity 12s ago");
  });

  it("uses minutes form above 60 seconds", () => {
    expect(lastActivityLabel(START_MS, START_MS + 3 * 60_000)).toBe("last activity 3m ago");
  });
});

describe("isStalled", () => {
  it("is false with no event yet — nothing deterministic to measure", () => {
    expect(isStalled(null, START_MS)).toBe(false);
  });

  it("is false under 120s of silence", () => {
    expect(isStalled(START_MS, START_MS + 119_000)).toBe(false);
  });

  it("is true at or above 120s of silence", () => {
    expect(isStalled(START_MS, START_MS + 120_000)).toBe(true);
    expect(isStalled(START_MS, START_MS + 200_000)).toBe(true);
  });
});
