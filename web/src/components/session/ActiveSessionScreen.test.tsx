import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ActiveSessionScreen } from "./ActiveSessionScreen";
import * as client from "../../api/client";
import * as sseHook from "../../api/useSessionEvents";

describe("ActiveSessionScreen", () => {
  it("shows the session's changed-file count and derived state", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "verifying", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [{ path: "a.ts", status: "modified" }],
      verification: { overall: "PARTIAL", checks: [] }, repairsUsed: 0, repairBudget: 2,
    } as any);
    vi.spyOn(sseHook, "useSessionEvents").mockReturnValue([]);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/sessions/s1"]}>
          <Routes><Route path="/sessions/:id" element={<ActiveSessionScreen />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByText(/Changed files/)).toBeInTheDocument());
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("renders the risk/scope summary once analysis data loads", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "verifying", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [{ path: "a.ts", status: "modified" }],
      verification: { overall: "PARTIAL", checks: [] }, repairsUsed: 0, repairBudget: 2,
    } as any);
    vi.spyOn(sseHook, "useSessionEvents").mockReturnValue([]);
    vi.spyOn(client.glimmerApi, "getSessionAnalysis").mockResolvedValue({ riskScore: "LOW", scopeGuard: null, provenance: "git-derived" });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/sessions/s1"]}>
          <Routes><Route path="/sessions/:id" element={<ActiveSessionScreen />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByText("LOW")).toBeInTheDocument());
  });

  it("renders a Cancel button that calls cancelSession, and a link to the diff view", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "verifying", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [{ path: "a.ts", status: "modified" }],
      verification: { overall: "PARTIAL", checks: [] }, repairsUsed: 0, repairBudget: 2,
    } as any);
    vi.spyOn(sseHook, "useSessionEvents").mockReturnValue([]);
    vi.spyOn(client.glimmerApi, "getSessionAnalysis").mockResolvedValue({ riskScore: "LOW", scopeGuard: null, provenance: "git-derived" });
    const cancelSpy = vi.spyOn(client.glimmerApi, "cancelSession").mockResolvedValue({ cancelled: true });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/sessions/s1"]}>
          <Routes><Route path="/sessions/:id" element={<ActiveSessionScreen />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => screen.getByRole("button", { name: /cancel/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(cancelSpy).toHaveBeenCalledWith("s1"));
    expect(screen.getByRole("link", { name: /diff/i })).toHaveAttribute("href", "/sessions/s1/diff");
  });

  it("shows an error message when cancel fails, without crashing", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "verifying", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [{ path: "a.ts", status: "modified" }],
      verification: { overall: "PARTIAL", checks: [] }, repairsUsed: 0, repairBudget: 2,
    } as any);
    vi.spyOn(sseHook, "useSessionEvents").mockReturnValue([]);
    vi.spyOn(client.glimmerApi, "getSessionAnalysis").mockResolvedValue({ riskScore: "LOW", scopeGuard: null, provenance: "git-derived" });
    vi.spyOn(client.glimmerApi, "cancelSession").mockRejectedValue(new Error("boom"));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/sessions/s1"]}>
          <Routes><Route path="/sessions/:id" element={<ActiveSessionScreen />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => screen.getByRole("button", { name: /cancel/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.getByText(/unavailable/i)).toBeInTheDocument());
  });

  it("polls session-analysis on the same 4000ms cadence as the session query, so it never goes stale while live", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "verifying", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [{ path: "a.ts", status: "modified" }],
      verification: { overall: "PARTIAL", checks: [] }, repairsUsed: 0, repairBudget: 2,
    } as any);
    vi.spyOn(sseHook, "useSessionEvents").mockReturnValue([]);
    const analysisSpy = vi.spyOn(client.glimmerApi, "getSessionAnalysis")
      .mockResolvedValue({ riskScore: "LOW", scopeGuard: null, provenance: "git-derived" });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/sessions/s1"]}>
          <Routes><Route path="/sessions/:id" element={<ActiveSessionScreen />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await vi.waitFor(() => expect(analysisSpy).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await vi.waitFor(() => expect(analysisSpy).toHaveBeenCalledTimes(2));

    vi.useRealTimers();
  });

  it("invalidates session-analysis when Cancel succeeds, so the panel refetches instead of showing a stale score", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "verifying", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [{ path: "a.ts", status: "modified" }],
      verification: { overall: "PARTIAL", checks: [] }, repairsUsed: 0, repairBudget: 2,
    } as any);
    vi.spyOn(sseHook, "useSessionEvents").mockReturnValue([]);
    const analysisSpy = vi.spyOn(client.glimmerApi, "getSessionAnalysis")
      .mockResolvedValue({ riskScore: "LOW", scopeGuard: null, provenance: "git-derived" });
    vi.spyOn(client.glimmerApi, "cancelSession").mockResolvedValue({ cancelled: true });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/sessions/s1"]}>
          <Routes><Route path="/sessions/:id" element={<ActiveSessionScreen />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => expect(analysisSpy).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(analysisSpy.mock.calls.length).toBeGreaterThan(1));
  });
});
