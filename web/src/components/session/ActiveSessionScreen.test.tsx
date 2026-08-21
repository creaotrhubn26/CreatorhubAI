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

  it("renders a failure banner with human-cased class and verbatim detail when a terminal session carries a failure", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "failed", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [], verification: { overall: "FAILED", checks: [] },
      repairsUsed: 0, repairBudget: 2,
      failure: { class: "CODE_FAIL", detail: "repair budget exhausted", evidenceIds: [] },
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

    await waitFor(() => expect(screen.getByText("Blocked: Code fail")).toBeInTheDocument());
    expect(screen.getByText("repair budget exhausted")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /see verification/i })).toHaveAttribute("href", "/sessions/s1/verification");
  });

  it("renders no failure banner when failure is absent, even for a non-success terminal state", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "failed", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [], verification: { overall: "FAILED", checks: [] },
      repairsUsed: 0, repairBudget: 2,
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
    expect(screen.queryByText(/^Blocked:/)).not.toBeInTheDocument();
  });

  it("renders no failure banner for a success terminal state, even if failure were somehow present", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "verified", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [], verification: { overall: "VERIFIED", checks: [] },
      repairsUsed: 0, repairBudget: 2,
      failure: { class: "CODE_FAIL", detail: "repair budget exhausted", evidenceIds: [] },
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
    expect(screen.queryByText(/^Blocked:/)).not.toBeInTheDocument();
  });

  it("renders the architecture plan panel once the plan artifact loads", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "verifying", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [], verification: { overall: "PARTIAL", checks: [] },
      repairsUsed: 0, repairBudget: 2,
    } as any);
    vi.spyOn(sseHook, "useSessionEvents").mockReturnValue([]);
    vi.spyOn(client.glimmerApi, "getArchitecturePlan").mockResolvedValue({
      objective: "Add whisper()", packages: ["glimmer-smoke-test"], risk: "low",
    } as any);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/sessions/s1"]}>
          <Routes><Route path="/sessions/:id" element={<ActiveSessionScreen />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByText("Add whisper()")).toBeInTheDocument());
  });

  it("shows compact human-review acceptance state, distinct from technical verification", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "verified", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [{ path: "a.ts", status: "modified" }],
      verification: { overall: "VERIFIED", checks: [] }, repairsUsed: 0, repairBudget: 2,
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

    await waitFor(() => expect(screen.getByText(/human review: not yet accepted/i)).toBeInTheDocument());
  });

  it("shows the accepted timestamp once a session carries humanAcceptance", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "verified", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [{ path: "a.ts", status: "modified" }],
      verification: { overall: "VERIFIED", checks: [] }, repairsUsed: 0, repairBudget: 2,
      humanAcceptance: { accepted: true, acceptedAt: "2026-08-21T00:00:00.000Z" },
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

    await waitFor(() => expect(screen.getByText(/human review: accepted/i)).toBeInTheDocument());
  });

  it("renders nothing for the architect artifact panels when their endpoints 404 (absence is normal)", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "verifying", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [], verification: { overall: "PARTIAL", checks: [] },
      repairsUsed: 0, repairBudget: 2,
    } as any);
    vi.spyOn(sseHook, "useSessionEvents").mockReturnValue([]);
    vi.spyOn(client.glimmerApi, "getArchitecturePlan").mockRejectedValue(new Error("GET /api/sessions/s1/plan failed: 404"));
    vi.spyOn(client.glimmerApi, "getArchitectReviews").mockRejectedValue(new Error("GET /api/sessions/s1/architect-reviews failed: 404"));
    vi.spyOn(client.glimmerApi, "getSessionTasks").mockRejectedValue(new Error("GET /api/sessions/s1/tasks failed: 404"));
    vi.spyOn(client.glimmerApi, "getDeliveryReview").mockRejectedValue(new Error("GET /api/sessions/s1/delivery-review failed: 404"));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/sessions/s1"]}>
          <Routes><Route path="/sessions/:id" element={<ActiveSessionScreen />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByText(/Changed files/)).toBeInTheDocument());
    expect(screen.queryByText(/Architecture Plan/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Architect Reviews/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Tasks$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Delivery Review/)).not.toBeInTheDocument();
  });
});
