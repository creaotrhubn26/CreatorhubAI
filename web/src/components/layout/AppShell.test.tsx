import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "./AppShell";

describe("AppShell", () => {
  it("renders every spec §5 sidebar section as a nav link", () => {
    render(
      <MemoryRouter>
        <AppShell repoContext={null}>content</AppShell>
      </MemoryRouter>
    );
    for (const label of ["Dashboard", "New Task", "Workspaces", "Sessions", "Repository", "Verification", "Model", "Settings"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("shows 'Not connected' repo context when none is provided", () => {
    render(
      <MemoryRouter>
        <AppShell repoContext={null}>content</AppShell>
      </MemoryRouter>
    );
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });
});
