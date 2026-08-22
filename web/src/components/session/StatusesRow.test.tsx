import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StatusesRow } from "./StatusesRow";

describe("StatusesRow", () => {
  it("renders nothing when statuses is absent", () => {
    const { container } = render(<StatusesRow />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders all 6 statuses legs as chips, each in its own native vocabulary", () => {
    const { getByText } = render(
      <StatusesRow
        statuses={{
          technical: "VERIFIED",
          architecture: "approved",
          documentation: "not_run",
          visual: "PASS_WITH_WARNINGS",
          delivery: "needs_polish",
          overall: "needs_polish",
        }}
      />
    );
    expect(getByText("Technical VERIFIED")).toBeInTheDocument();
    expect(getByText("Architecture approved")).toBeInTheDocument();
    expect(getByText("Docs not_run")).toBeInTheDocument();
    expect(getByText("Visual PASS_WITH_WARNINGS")).toBeInTheDocument();
    expect(getByText("Delivery needs_polish")).toBeInTheDocument();
    expect(getByText("Overall needs_polish")).toBeInTheDocument();
  });

  it("renders every not_run leg honestly when a session never produced a real statuses fact", () => {
    const { getByText } = render(
      <StatusesRow
        statuses={{
          technical: "NOT_RUN",
          architecture: "not_run",
          documentation: "not_run",
          visual: "not_run",
          delivery: "not_run",
          overall: "not_run",
        }}
      />
    );
    expect(getByText("Technical NOT_RUN")).toBeInTheDocument();
    expect(getByText("Overall not_run")).toBeInTheDocument();
  });
});
