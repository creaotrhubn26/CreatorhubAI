import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ActiveSessionScreen } from "./ActiveSessionScreen";
import * as client from "../../api/client";
import * as sseHook from "../../api/useSessionEvents";
import { SessionEventsContext } from "../../api/useSessionEvents";

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

    await waitFor(() => expect(screen.getByText("Failed: Code fail")).toBeInTheDocument());
    expect(screen.getByText("repair budget exhausted")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /see verification/i })).toHaveAttribute("href", "/sessions/s1/verification");
  });

  it("renders the architect trigger line for an auto-triggered run", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Refactor auth flow", status: "verified", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [], verification: { overall: "VERIFIED", checks: [] },
      repairsUsed: 0, repairBudget: 2,
      architectTrigger: { mode: "auto", score: 6, signals: ["protected_area", "verification_full"] },
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

    await waitFor(() =>
      expect(screen.getByText("architect: auto (score 6: protected_area, verification_full)")).toBeInTheDocument()
    );
  });

  it("renders a gray USER_CANCELLED banner for a cancelled session carrying a failure", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "cancelled", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [], verification: { overall: "NOT_RUN", checks: [] },
      repairsUsed: 0, repairBudget: 2,
      failure: { class: "USER_CANCELLED", detail: "cancelled by user", evidenceIds: [] },
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

    const title = await screen.findByText("Cancelled: User cancelled");
    expect(title).toBeInTheDocument();
    const banner = title.closest(".failure-banner") as HTMLElement;
    expect(banner.style.getPropertyValue("--badge-color")).toBe("var(--gray)");
  });

  it("falls back to the session id's embedded timestamp for elapsed when startedAt is absent", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "20260821-000000-glimmer-fixture", task: "Fix dialog parser", status: "implementing",
      workspace: "/ws", branch: "glimmer/x", baselineSha: "abc", changedFiles: [],
      verification: { overall: "NOT_RUN", checks: [] }, repairsUsed: 0, repairBudget: 2,
    } as any);
    vi.spyOn(sseHook, "useSessionEvents").mockReturnValue([]);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/sessions/20260821-000000-glimmer-fixture"]}>
          <Routes><Route path="/sessions/:id" element={<ActiveSessionScreen />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // No startedAt on the fixture — elapsed must come from the parseable
    // session-id timestamp instead of being omitted.
    await waitFor(() => expect(screen.getByText(/\d+[hms]/)).toBeInTheDocument());
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

  // V7 §20: session.status === "stale" comes from the gateway's own
  // computeStale read, not from any event glimmer-v2.py emits — no failure
  // banner (no failure record for a stale session), just this amber line.
  it("shows the amber stale line for a session the gateway reports as stale, without a failure banner", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "stale", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [{ path: "a.ts", status: "modified" }],
      verification: { overall: "VERIFIED", checks: [] }, repairsUsed: 0, repairBudget: 2,
      verifiedAt: "2026-08-21T00:00:00.000Z",
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

    await waitFor(() =>
      expect(screen.getByText(/Verified result is stale/)).toBeInTheDocument()
    );
    expect(screen.queryByText(/^Stale:/)).not.toBeInTheDocument();
  });

  it("renders no amber stale line for a plain verified session", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "verified", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [], verification: { overall: "VERIFIED", checks: [] },
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
    expect(screen.queryByText(/Verified result is stale/)).not.toBeInTheDocument();
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

  // Task 8.3 (V7 §14/§35): the YELLOW human-approval boundary card.
  describe("approval card", () => {
    const pendingApproval = {
      approvalId: "s1-appr-1", action: "modify_dependencies",
      reason: "engineer requested a dependency-install command: npm install left-pad",
      proposedChanges: ["package.json", "package-lock.json"],
      risk: "medium" as const, requestedAt: "2026-08-23T00:00:00.000Z", status: "pending" as const,
    };

    it("renders nothing when pendingApproval is absent", async () => {
      vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
        id: "s1", task: "Fix dialog parser", status: "implementing", workspace: "/ws", branch: "glimmer/x",
        baselineSha: "abc", changedFiles: [], verification: { overall: "NOT_RUN", checks: [] },
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
      expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
    });

    it("renders the action/reason/risk/proposedChanges and Approve/Deny buttons for a pending approval", async () => {
      vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
        id: "s1", task: "Fix dialog parser", status: "waiting_for_approval", workspace: "/ws", branch: "glimmer/x",
        baselineSha: "abc", changedFiles: [], verification: { overall: "NOT_RUN", checks: [] },
        repairsUsed: 0, repairBudget: 2, pendingApproval,
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

      expect(await screen.findByText("modify_dependencies")).toBeInTheDocument();
      expect(screen.getByText(/npm install left-pad/)).toBeInTheDocument();
      expect(screen.getByText(/medium risk/)).toBeInTheDocument();
      expect(screen.getByText(/package.json, package-lock.json/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^approve$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^deny$/i })).toBeInTheDocument();
    });

    it("clicking Approve calls approveApproval with the session and approval ids", async () => {
      vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
        id: "s1", task: "Fix dialog parser", status: "waiting_for_approval", workspace: "/ws", branch: "glimmer/x",
        baselineSha: "abc", changedFiles: [], verification: { overall: "NOT_RUN", checks: [] },
        repairsUsed: 0, repairBudget: 2, pendingApproval,
      } as any);
      vi.spyOn(sseHook, "useSessionEvents").mockReturnValue([]);
      const approveSpy = vi.spyOn(client.glimmerApi, "approveApproval")
        .mockResolvedValue({ ...pendingApproval, status: "approved", approvedBy: "daniel", resolvedAt: "x" } as any);

      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={["/sessions/s1"]}>
            <Routes><Route path="/sessions/:id" element={<ActiveSessionScreen />} /></Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );

      fireEvent.click(await screen.findByRole("button", { name: /^approve$/i }));
      await waitFor(() => expect(approveSpy).toHaveBeenCalledWith("s1", "s1-appr-1"));
    });

    it("clicking Deny calls denyApproval with the session and approval ids", async () => {
      vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
        id: "s1", task: "Fix dialog parser", status: "waiting_for_approval", workspace: "/ws", branch: "glimmer/x",
        baselineSha: "abc", changedFiles: [], verification: { overall: "NOT_RUN", checks: [] },
        repairsUsed: 0, repairBudget: 2, pendingApproval,
      } as any);
      vi.spyOn(sseHook, "useSessionEvents").mockReturnValue([]);
      const denySpy = vi.spyOn(client.glimmerApi, "denyApproval")
        .mockResolvedValue({ ...pendingApproval, status: "denied", approvedBy: "daniel", resolvedAt: "x" } as any);

      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={["/sessions/s1"]}>
            <Routes><Route path="/sessions/:id" element={<ActiveSessionScreen />} /></Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );

      fireEvent.click(await screen.findByRole("button", { name: /^deny$/i }));
      await waitFor(() => expect(denySpy).toHaveBeenCalledWith("s1", "s1-appr-1"));
    });

    it("shows the resolved decision instead of buttons once status is no longer pending", async () => {
      vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
        id: "s1", task: "Fix dialog parser", status: "implementing", workspace: "/ws", branch: "glimmer/x",
        baselineSha: "abc", changedFiles: [], verification: { overall: "NOT_RUN", checks: [] },
        repairsUsed: 0, repairBudget: 2,
        pendingApproval: { ...pendingApproval, status: "approved", approvedBy: "daniel", resolvedAt: "x" },
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

      expect(await screen.findByText(/approved by daniel/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^deny$/i })).not.toBeInTheDocument();
    });

    // 8.3 review fix-round (M3): a session with no SSE activity in >=120s
    // (isStalled, the SAME fact LivenessLine already computes) suppresses
    // the buttons instead of inviting a click nothing will ever read back.
    it("suppresses Approve/Deny (but still shows the card) when the session is stalled", async () => {
      vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
        id: "s1", task: "Fix dialog parser", status: "waiting_for_approval", workspace: "/ws", branch: "glimmer/x",
        baselineSha: "abc", changedFiles: [], verification: { overall: "NOT_RUN", checks: [] },
        repairsUsed: 0, repairBudget: 2, pendingApproval,
      } as any);
      vi.spyOn(sseHook, "useSessionEvents").mockReturnValue([]);

      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={qc}>
          <SessionEventsContext.Provider value={{ events: [], lastEventAt: Date.now() - 200_000 }}>
            <MemoryRouter initialEntries={["/sessions/s1"]}>
              <Routes><Route path="/sessions/:id" element={<ActiveSessionScreen />} /></Routes>
            </MemoryRouter>
          </SessionEventsContext.Provider>
        </QueryClientProvider>
      );

      expect(await screen.findByText(/modify_dependencies/)).toBeInTheDocument();
      expect(screen.getByText(/no recent activity/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^deny$/i })).not.toBeInTheDocument();
    });
  });
});
