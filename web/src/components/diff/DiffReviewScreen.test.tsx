import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DiffReviewScreen } from "./DiffReviewScreen";
import * as client from "../../api/client";

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/sessions/s1/diff"]}>
        <Routes><Route path="/sessions/:id/diff" element={<DiffReviewScreen />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("DiffReviewScreen", () => {
  beforeEach(() => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "x", status: "verified", workspace: "/ws", branch: "glimmer/x", baselineSha: "abc",
      changedFiles: [{ path: "a.ts", status: "modified" }],
      verification: { overall: "VERIFIED", checks: [] }, repairsUsed: 0, repairBudget: 2,
    } as any);
    vi.spyOn(client.glimmerApi, "getSessionDiff").mockResolvedValue({ diff: "--- a\n+++ b\n" });
  });

  it("renders a Revert button per changed file that calls revertFile with the real path", async () => {
    const revertSpy = vi.spyOn(client.glimmerApi, "revertFile").mockResolvedValue({ reverted: "a.ts" });
    renderScreen();
    await waitFor(() => screen.getByRole("button", { name: /revert/i }));
    fireEvent.click(screen.getByRole("button", { name: /revert/i }));
    await waitFor(() => expect(revertSpy).toHaveBeenCalledWith("s1", "a.ts"));
  });

  it("shows an error message when revert fails, without crashing", async () => {
    vi.spyOn(client.glimmerApi, "revertFile").mockRejectedValue(new Error("boom"));
    renderScreen();
    await waitFor(() => screen.getByRole("button", { name: /revert/i }));
    fireEvent.click(screen.getByRole("button", { name: /revert/i }));
    await waitFor(() => expect(screen.getByText(/unavailable/i)).toBeInTheDocument());
  });

  it("invalidates session-analysis on a successful revert, so a stale risk/scope score isn't left behind", async () => {
    vi.spyOn(client.glimmerApi, "revertFile").mockResolvedValue({ reverted: "a.ts" });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/sessions/s1/diff"]}>
          <Routes><Route path="/sessions/:id/diff" element={<DiffReviewScreen />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => screen.getByRole("button", { name: /revert/i }));
    fireEvent.click(screen.getByRole("button", { name: /revert/i }));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["session-analysis", "s1"] })
    );
  });
});
