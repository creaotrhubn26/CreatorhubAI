import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentStateStepper } from "./AgentStateStepper";

describe("AgentStateStepper", () => {
  it("renders the in-flight flow with the current step highlighted", () => {
    render(<AgentStateStepper current="verifying" />);
    expect(screen.getByText("verifying")).toBeInTheDocument();
    expect(screen.getByText("implementing")).toBeInTheDocument();
  });

  it("renders a terminal status as its own badge instead of an unhighlighted flow", () => {
    for (const terminal of [
      "blocked",
      "failed",
      "needs_review",
      "verified",
      "completed",
      "no_change",
      "cancelled",
    ] as const) {
      const { unmount } = render(<AgentStateStepper current={terminal} />);
      expect(screen.getByText(terminal)).toBeInTheDocument();
      // No stepper rendered: a finished session never looks mid-flow.
      expect(screen.queryByText("implementing")).toBeNull();
      unmount();
    }
  });
});
