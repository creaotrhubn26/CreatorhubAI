import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CollapsibleSection } from "./CollapsibleSection";

describe("CollapsibleSection", () => {
  it("shows the summary in the header and hides the body by default", () => {
    render(
      <CollapsibleSection title="Architecture Plan" summary="low risk · 1 candidate file">
        <p>Objective text</p>
      </CollapsibleSection>
    );
    expect(screen.getByText("low risk · 1 candidate file")).toBeInTheDocument();
    expect(screen.getByText("Objective text")).not.toBeVisible();
  });

  it("expands on click and collapses again on a second click", () => {
    render(
      <CollapsibleSection title="Risk & Scope">
        <p>Body content</p>
      </CollapsibleSection>
    );
    const header = screen.getByRole("button", { name: /Risk & Scope/ });
    expect(header).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Body content")).toBeVisible();

    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Body content")).not.toBeVisible();
  });

  it("respects defaultOpen", () => {
    render(
      <CollapsibleSection title="Risk & Scope" defaultOpen>
        <p>Body content</p>
      </CollapsibleSection>
    );
    expect(screen.getByRole("button", { name: /Risk & Scope/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Body content")).toBeVisible();
  });
});
