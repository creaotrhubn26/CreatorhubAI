import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { NewTaskScreen } from "./NewTaskScreen";

// NewTaskScreen calls useNavigate() (per the task-12 brief's exact implementation),
// which requires a Router context to render. MemoryRouter is added here (matching
// the pattern already used in AppShell.test.tsx) purely as test scaffolding — it
// does not change what is asserted.
function withQuery(ui: React.ReactElement) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("NewTaskScreen", () => {
  it("renders commit/push/deploy/install as permanently disabled and unchecked", () => {
    render(withQuery(<NewTaskScreen />));
    for (const label of ["Commit", "Push", "Deploy", "Install dependencies"]) {
      const box = screen.getByLabelText(label) as HTMLInputElement;
      expect(box.disabled).toBe(true);
      expect(box.checked).toBe(false);
    }
  });

  it("renders read/search/modify as checked and enabled", () => {
    render(withQuery(<NewTaskScreen />));
    for (const label of ["Read repository", "Search repository", "Modify files"]) {
      const box = screen.getByLabelText(label) as HTMLInputElement;
      expect(box.checked).toBe(true);
    }
  });

  it("shows the RUN GLIMMER primary action", () => {
    render(withQuery(<NewTaskScreen />));
    expect(screen.getByRole("button", { name: "RUN GLIMMER" })).toBeInTheDocument();
  });
});
