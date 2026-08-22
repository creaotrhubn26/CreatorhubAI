import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { GatesRow } from "./GatesRow";

describe("GatesRow", () => {
  it("renders nothing when gates is absent", () => {
    const { container } = render(<GatesRow />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders all 5 gates as chips, true/false/null -> ✓/✗/—", () => {
    const { getByText } = render(
      <GatesRow
        gates={{
          implementationComplete: true,
          architectureApproved: false,
          verificationPassed: true,
          scopeApproved: null,
          documentationCurrent: null,
        }}
      />
    );
    expect(getByText("Implementation ✓")).toBeInTheDocument();
    expect(getByText("Architecture ✗")).toBeInTheDocument();
    expect(getByText("Verification ✓")).toBeInTheDocument();
    expect(getByText("Scope —")).toBeInTheDocument();
    expect(getByText("Docs —")).toBeInTheDocument();
  });

  it("reads a missing key on an older manifest as — (never-ran), not a failure", () => {
    const { getByText } = render(<GatesRow gates={{ architectureApproved: true }} />);
    expect(getByText("Implementation —")).toBeInTheDocument();
    expect(getByText("Docs —")).toBeInTheDocument();
  });
});
