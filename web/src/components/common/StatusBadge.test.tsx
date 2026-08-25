import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { statusColor, StatusBadge } from "./StatusBadge";

describe("statusColor", () => {
  it("classifies verified as green and the other terminal statuses per their existing severity", () => {
    expect(statusColor("verified")).toBe("var(--green)");
    expect(statusColor("completed")).toBe("var(--green)");
    expect(statusColor("no_change")).toBe("var(--gray)");
    expect(statusColor("failed")).toBe("var(--red)");
    expect(statusColor("blocked")).toBe("var(--red)");
    expect(statusColor("needs_review")).toBe("var(--amber)");
    expect(statusColor("cancelled")).toBe("var(--gray)");
  });

  // V7 §20: "stale" is a non-success terminal status (workspace changed
  // after VERIFIED) but not a failure — same amber as needs_review, not red.
  it("classifies stale as amber, not red or green", () => {
    expect(statusColor("stale")).toBe("var(--amber)");
  });

  it("falls back to gray for an unrecognized status", () => {
    expect(statusColor("some-future-status")).toBe("var(--gray)");
  });
});

describe("StatusBadge", () => {
  it("renders the stale status with the amber badge color", () => {
    render(<StatusBadge status="stale" />);
    const badge = screen.getByText("stale");
    expect(badge.style.getPropertyValue("--badge-color")).toBe("var(--amber)");
  });
});
