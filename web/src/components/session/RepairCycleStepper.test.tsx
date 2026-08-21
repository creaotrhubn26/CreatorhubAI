import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { GlimmerSession } from "@glimmer/shared";
import { RepairCycleStepper } from "./RepairCycleStepper";

function session(overrides: Partial<GlimmerSession>): GlimmerSession {
  return {
    id: "s1", task: "Fix dialog parser", status: "implementing",
    workspace: "/ws", branch: "glimmer/x", baselineSha: "abc",
    changedFiles: [], verification: { overall: "NOT_RUN", checks: [] },
    repairsUsed: 0, repairBudget: 2,
    ...overrides,
  };
}

describe("RepairCycleStepper", () => {
  it("shows the repair budget and marks Implementation as the running step while implementing", () => {
    render(<RepairCycleStepper session={session({ status: "implementing" })} />);
    expect(screen.getByText("0 / 2 used")).toBeInTheDocument();
    expect(screen.getByText("Implementation")).toBeInTheDocument();
    expect(screen.getByText("RUNNING")).toBeInTheDocument();
  });

  it("matches the spec §17 example: a failed implementation with Repair 1 running", () => {
    // Reaching "repairing" means an earlier verification run already found a
    // problem — that real overall (FAILED) is what triggered the repair, so
    // the Verification step honestly reflects it rather than saying PENDING.
    render(<RepairCycleStepper session={session({
      status: "repairing", repairsUsed: 0, repairBudget: 2,
      verification: { overall: "FAILED", checks: [] },
    })} />);
    expect(screen.getByText("Implementation").nextSibling).toHaveTextContent("FAILED");
    expect(screen.getByText("Repair 1").nextSibling).toHaveTextContent("RUNNING");
    expect(screen.getByText("Repair 2").nextSibling).toHaveTextContent("PENDING");
    expect(screen.getByText("Verification").nextSibling).toHaveTextContent("FAILED");
    expect(screen.getByText("Final status").nextSibling).toHaveTextContent("PENDING");
  });

  it("shows a completed repair, the real verification overall, and the terminal session status once verified", () => {
    render(<RepairCycleStepper session={session({
      status: "verified", repairsUsed: 1, repairBudget: 2,
      verification: { overall: "VERIFIED", checks: [] },
    })} />);
    expect(screen.getByText("Repair 1").nextSibling).toHaveTextContent("DONE");
    expect(screen.getByText("Repair 2").nextSibling).toHaveTextContent("PENDING");
    expect(screen.getByText("Verification").nextSibling).toHaveTextContent("VERIFIED");
    expect(screen.getByText("Final status").nextSibling).toHaveTextContent("verified");
  });

  it("renders no repair slots when the repair budget is 0", () => {
    render(<RepairCycleStepper session={session({ status: "verifying", repairBudget: 0 })} />);
    expect(screen.queryByText(/Repair 1/)).not.toBeInTheDocument();
    expect(screen.getByText("0 / 0 used")).toBeInTheDocument();
  });

  // Smoke test for the visual stepper: connected nodes render ✓/●/○ per the
  // step's real state, not just badge text.
  it("renders done/active/pending nodes with distinct glyphs", () => {
    const { container } = render(<RepairCycleStepper session={session({
      status: "repairing", repairsUsed: 1, repairBudget: 2,
      verification: { overall: "NOT_RUN", checks: [] },
    })} />);
    const nodes = Array.from(container.querySelectorAll(".stepper__node")).map((n) => n.textContent);
    // Implementation: FAILED -> done (✓), Repair 1: DONE -> ✓, Repair 2: PENDING -> ○.
    expect(nodes).toContain("✓");
    expect(nodes).toContain("○");
  });
});
