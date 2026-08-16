import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DashboardScreen } from "./DashboardScreen";
import * as client from "../../api/client";

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("DashboardScreen", () => {
  it("renders real model status and recent sessions", async () => {
    vi.spyOn(client.glimmerApi, "getStatus").mockResolvedValue({
      model: { status: "ONLINE", endpoint: "http://127.0.0.1:8080", provenance: "deterministic-backend" },
      activeSession: null,
      latestSession: { id: "s1", task: "Fix dialog parser", status: "verified", completedAt: "2026-08-16T00:00:00Z" },
      recentSessions: [{ id: "s1", task: "Fix dialog parser", status: "verified", changedFiles: [{ path: "a.ts", status: "modified" }], completedAt: "2026-08-16T00:00:00Z" }],
      verification: { overall: "VERIFIED", checks: [] },
    });
    render(withQuery(<DashboardScreen />));
    await waitFor(() => expect(screen.getByText("ONLINE")).toBeInTheDocument());
    expect(screen.getByText("Fix dialog parser")).toBeInTheDocument();
  });

  it("shows 'Unavailable' when the model status is OFFLINE, never a fabricated number", async () => {
    vi.spyOn(client.glimmerApi, "getStatus").mockResolvedValue({
      model: { status: "OFFLINE", endpoint: "http://127.0.0.1:8080", provenance: "deterministic-backend" },
      activeSession: null, latestSession: null, recentSessions: [], verification: null,
    });
    render(withQuery(<DashboardScreen />));
    await waitFor(() => expect(screen.getByText("OFFLINE")).toBeInTheDocument());
    // activeSession, latestSession, and verification are all null here, so
    // "Unavailable" must render exactly three times (never a fabricated value in any of them).
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
  });
});
