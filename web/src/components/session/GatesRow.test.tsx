import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { GatesRow } from "./GatesRow";

describe("GatesRow", () => {
  it("renders nothing when gates is absent", () => {
    const { container } = render(<GatesRow />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders all 7 gates as chips, true/false/null -> ✓/✗/—", () => {
    const { getByText } = render(
      <GatesRow
        gates={{
          implementationComplete: true,
          architectureApproved: false,
          verificationPassed: true,
          scopeApproved: null,
          documentationCurrent: null,
          tasksResolved: false,
          customerReadinessApproved: false,
        }}
      />
    );
    expect(getByText("Implementation ✓")).toBeInTheDocument();
    expect(getByText("Architecture ✗")).toBeInTheDocument();
    expect(getByText("Verification ✓")).toBeInTheDocument();
    expect(getByText("Scope —")).toBeInTheDocument();
    expect(getByText("Docs —")).toBeInTheDocument();
    expect(getByText("Tasks ✗")).toBeInTheDocument();
    expect(getByText("Delivery ✗")).toBeInTheDocument();
  });

  it("reads a missing key on an older manifest as — (never-ran), not a failure", () => {
    const { getByText } = render(<GatesRow gates={{ architectureApproved: true }} />);
    expect(getByText("Implementation —")).toBeInTheDocument();
    expect(getByText("Docs —")).toBeInTheDocument();
    expect(getByText("Tasks —")).toBeInTheDocument();
    expect(getByText("Delivery —")).toBeInTheDocument();
  });

  it("marks Tasks ✓ (human) distinctly when tasksResolvedBy is human, not a plain ✓", () => {
    const { getByText, queryByText } = render(
      <GatesRow gates={{ architectureApproved: null, tasksResolved: true, tasksResolvedBy: "human" }} />
    );
    expect(getByText("Tasks ✓ (human)")).toBeInTheDocument();
    expect(queryByText("Tasks ✓")).not.toBeInTheDocument();
  });

  it("renders a plain Tasks ✓ when tasksResolved is true with no human override involved", () => {
    const { getByText } = render(<GatesRow gates={{ architectureApproved: null, tasksResolved: true }} />);
    expect(getByText("Tasks ✓")).toBeInTheDocument();
  });
});
