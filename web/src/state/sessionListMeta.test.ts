import { describe, it, expect } from "vitest";
import { isPendingSessionId, sessionTimestamp, relativeTime, dayLabel, groupSessionsByDay } from "./sessionListMeta";

describe("sessionListMeta", () => {
  it("flags pending-* ids as transient", () => {
    expect(isPendingSessionId("pending-abc123")).toBe(true);
    expect(isPendingSessionId("20260821-221803-glimmer-x")).toBe(false);
  });

  it("derives a timestamp from the session id when completedAt is absent", () => {
    const d = sessionTimestamp({ id: "20260821-221803-glimmer-x" });
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(7); // August
    expect(d?.getDate()).toBe(21);
  });

  it("prefers completedAt over the id timestamp when present", () => {
    const d = sessionTimestamp({ id: "20260101-000000-glimmer-x", completedAt: "2026-08-21T00:00:00.000Z" });
    expect(d?.toISOString().startsWith("2026-08-21")).toBe(true);
  });

  it("returns null (honest unknown), not a fabricated date, for an unparseable id", () => {
    expect(sessionTimestamp({ id: "pending-abc" })).toBeNull();
  });

  it("formats relative time and falls back to an em dash when unknown", () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    expect(relativeTime(new Date("2026-08-21T10:00:00.000Z"), now)).toBe("2h ago");
    expect(relativeTime(null, now)).toBe("—");
  });

  it("labels Today/Yesterday and groups consecutive same-day sessions", () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    expect(dayLabel(new Date("2026-08-21T09:00:00.000Z"), now)).toBe("Today");
    expect(dayLabel(new Date("2026-08-20T09:00:00.000Z"), now)).toBe("Yesterday");

    const groups = groupSessionsByDay(
      [
        { id: "a", completedAt: "2026-08-21T09:00:00.000Z" },
        { id: "b", completedAt: "2026-08-21T08:00:00.000Z" },
        { id: "c", completedAt: "2026-08-20T08:00:00.000Z" },
      ],
      now
    );
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday"]);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["a", "b"]);
  });
});
