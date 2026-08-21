import { describe, it, expect, vi } from "vitest";
import { render, screen, within, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "./AppShell";
import * as client from "../../api/client";

function withProviders(ui: React.ReactElement, initialEntries = ["/"]) {
  vi.spyOn(client.glimmerApi, "listSessions").mockResolvedValue([]);
  vi.spyOn(client.glimmerApi, "getModelStatus").mockResolvedValue({ status: "OFFLINE", endpoint: "x", provenance: "deterministic-backend" });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AppShell", () => {
  it("renders every activity-bar entry from spec §5.2", () => {
    render(withProviders(<AppShell repoContext={null}>content</AppShell>));
    const activityBar = within(screen.getByRole("navigation"));
    for (const label of ["Dashboard", "Sessions", "New Task", "Verification", "Repository", "Model", "Settings"]) {
      expect(activityBar.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("shows 'Not connected' repo context when none is provided", () => {
    render(withProviders(<AppShell repoContext={null}>content</AppShell>));
    expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0);
  });

  it("renders the routed content inside the editor content region", () => {
    render(withProviders(<AppShell repoContext={null}>hello from a route</AppShell>));
    expect(screen.getByText("hello from a route")).toBeInTheDocument();
  });

  it("shows the status bar with a model status field", async () => {
    render(withProviders(<AppShell repoContext={null}>content</AppShell>));
    expect(await screen.findByText(/model: OFFLINE/)).toBeInTheDocument();
  });

  it("opens a tab for a visited session and closes it via its close button", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "verifying", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [], verification: { overall: "PARTIAL", checks: [] },
      repairsUsed: 0, repairBudget: 2,
    } as any);
    render(withProviders(<AppShell repoContext={null}>session content</AppShell>, ["/sessions/s1"]));

    const closeBtn = await screen.findByRole("button", { name: "Close s1" });
    expect(closeBtn).toBeInTheDocument();

    fireEvent.click(closeBtn);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Close s1" })).not.toBeInTheDocument());
  });
});
