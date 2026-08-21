import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders no button when action is omitted", () => {
    render(<EmptyState icon="○" text="Unavailable" />);
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("fires the action callback when the button is clicked", () => {
    const onAction = vi.fn();
    render(<EmptyState icon="○" text="Unavailable" action={{ label: "New Task", onAction }} />);
    fireEvent.click(screen.getByRole("button", { name: "New Task" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
