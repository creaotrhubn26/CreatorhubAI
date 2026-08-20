import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import * as client from "./api/client";

function withProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("App", () => {
  it("shows live repo context in the sidebar from the workspaces route", async () => {
    vi.spyOn(client.glimmerApi, "getStatus").mockResolvedValue({
      model: { status: "OFFLINE", endpoint: "x", provenance: "deterministic-backend" },
      activeSession: null, latestSession: null, recentSessions: [], verification: null,
    });
    vi.spyOn(client.glimmerApi, "listWorkspaces").mockResolvedValue([
      { path: "/Users/x/AI/creatorhubn-monorepo", branch: "glimmer/fix-role-room-dialog", headSha: "42fe48abcdef", baselineSha: "42fe48abcdef", dirty: false, changedFiles: [] },
    ]);
    render(withProviders(<App />));
    await waitFor(() => expect(screen.getByText("creatorhubn-monorepo")).toBeInTheDocument());
    expect(screen.getByText("glimmer/fix-role-room-dialog")).toBeInTheDocument();
    expect(screen.getByText("42fe48a")).toBeInTheDocument();
    expect(screen.getByText("Clean")).toBeInTheDocument();
  });

  it("falls back to 'Not connected' when no workspace is available, without fabricating context", async () => {
    vi.spyOn(client.glimmerApi, "getStatus").mockResolvedValue({
      model: { status: "OFFLINE", endpoint: "x", provenance: "deterministic-backend" },
      activeSession: null, latestSession: null, recentSessions: [], verification: null,
    });
    vi.spyOn(client.glimmerApi, "listWorkspaces").mockResolvedValue([]);
    render(withProviders(<App />));
    await waitFor(() => expect(screen.getByText("Not connected")).toBeInTheDocument());
  });

  it("falls back to 'Not connected' when the workspaces request fails", async () => {
    vi.spyOn(client.glimmerApi, "getStatus").mockResolvedValue({
      model: { status: "OFFLINE", endpoint: "x", provenance: "deterministic-backend" },
      activeSession: null, latestSession: null, recentSessions: [], verification: null,
    });
    vi.spyOn(client.glimmerApi, "listWorkspaces").mockRejectedValue(new Error("GET /api/workspaces failed: 500"));
    render(withProviders(<App />));
    await waitFor(() => expect(screen.getByText("Not connected")).toBeInTheDocument());
  });
});
