import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TaskIntelligencePanel } from "./TaskIntelligencePanel";
import * as client from "../../api/client";

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("TaskIntelligencePanel", () => {
  it("renders deterministic area/package/verification with provenance, never a fabricated risk", async () => {
    vi.spyOn(client.glimmerApi, "getTaskIntelligence").mockResolvedValue({
      likelyArea: "frontend",
      likelyPackage: "creatorhub-frontend",
      suggestedVerification: ["frontend-typecheck"],
      estimatedRisk: null,
      provenance: "git-derived",
      repoMapStatus: "workspace-matched",
    });
    render(withQuery(<TaskIntelligencePanel scopePackage="frontend" scopeArea={undefined} />));
    await waitFor(() => expect(screen.getByText("frontend")).toBeInTheDocument());
    expect(screen.getByText("creatorhub-frontend")).toBeInTheDocument();
    expect(screen.getByText(/Deterministic/i)).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument(); // estimatedRisk: null
  });

  it("reads the provenance field into the caption instead of a fully static string", async () => {
    vi.spyOn(client.glimmerApi, "getTaskIntelligence").mockResolvedValue({
      likelyArea: "frontend",
      likelyPackage: "creatorhub-frontend",
      suggestedVerification: ["frontend-typecheck"],
      estimatedRisk: null,
      provenance: "git-derived",
      repoMapStatus: "workspace-matched",
    });
    render(withQuery(<TaskIntelligencePanel scopePackage="frontend" scopeArea={undefined} />));
    await waitFor(() => expect(screen.getByText(/git-derived/)).toBeInTheDocument());
  });

  // Task 4c(c): a null field has three different meanings and used to render
  // as "Unavailable" in all three, which read as a broken panel.
  describe("the three honest empty states", () => {
    it("says 'not applicable' for repository-wide scope, which has no single area by definition", async () => {
      vi.spyOn(client.glimmerApi, "getTaskIntelligence").mockResolvedValue({
        likelyArea: null,
        likelyPackage: null,
        suggestedVerification: [],
        estimatedRisk: "MEDIUM",
        provenance: "git-derived",
        repoMapStatus: "workspace-matched",
      });
      render(withQuery(<TaskIntelligencePanel scopePackage="repository" mode="implement" />));
      // Review MN5: area and package genuinely have no single value for a
      // repository-wide scope — suggested verification does not get the same
      // excuse, it is simply unknown without a package to read scripts from.
      await waitFor(() => expect(screen.getAllByText(/not applicable/i).length).toBe(2));
      expect(screen.getByText("MEDIUM")).toBeInTheDocument();
      expect(screen.getAllByText("Unavailable").length).toBe(1); // suggested verification
    });

    it("says no repository map exists yet when the chosen workspace has never been run", async () => {
      vi.spyOn(client.glimmerApi, "getTaskIntelligence").mockResolvedValue({
        likelyArea: null,
        likelyPackage: null,
        suggestedVerification: [],
        estimatedRisk: "LOW",
        provenance: "deterministic-backend",
        repoMapStatus: "unmatched-workspace",
      });
      render(
        withQuery(
          <TaskIntelligencePanel
            scopePackage="frontend"
            workspace="/tmp/fresh-ws"
            mode="implement"
          />,
        ),
      );
      await waitFor(() =>
        expect(screen.getAllByText(/no repository map for this workspace yet/i).length).toBe(3),
      );
      expect(
        screen.getByText(/No session has produced a repository map for this workspace yet/i),
      ).toBeInTheDocument();
    });

    it("keeps a plain 'Unavailable' for a genuinely unknown field when a map does exist", async () => {
      vi.spyOn(client.glimmerApi, "getTaskIntelligence").mockResolvedValue({
        likelyArea: null,
        likelyPackage: null,
        suggestedVerification: [],
        estimatedRisk: null,
        provenance: "git-derived",
        repoMapStatus: "workspace-matched",
      });
      render(withQuery(<TaskIntelligencePanel scopePackage="frontend" workspace="/tmp/ws" />));
      await waitFor(() => expect(screen.getAllByText("Unavailable").length).toBe(4));
    });

    it("labels an unlabeled first-found map instead of implying it is the user's repository", async () => {
      vi.spyOn(client.glimmerApi, "getTaskIntelligence").mockResolvedValue({
        likelyArea: "frontend",
        likelyPackage: "creatorhub-frontend",
        suggestedVerification: [],
        estimatedRisk: null,
        provenance: "git-derived",
        repoMapStatus: "first-found",
      });
      render(withQuery(<TaskIntelligencePanel scopePackage="frontend" />));
      await waitFor(() =>
        expect(screen.getByText(/first one found across all sessions/i)).toBeInTheDocument(),
      );
    });
  });

  // Review MN6: the panel used to render null on any query error, so it
  // silently vanished (e.g. a 431 from a very long objective) — the same
  // disappearing-data problem the honest empty states exist to prevent.
  it("says the request failed instead of silently disappearing", async () => {
    vi.spyOn(client.glimmerApi, "getTaskIntelligence").mockRejectedValue(
      new Error("GET /api/task-intelligence failed: 431"),
    );
    render(withQuery(<TaskIntelligencePanel scopePackage="frontend" mode="implement" />));
    expect(await screen.findByRole("alert")).toHaveTextContent("431");
    expect(screen.getByText("Task Intelligence")).toBeInTheDocument();
  });

  // Task 4c(a): risk only exists when the hints are sent, so the panel must
  // actually send them.
  it("forwards the composer's workspace and risk hints to the endpoint", async () => {
    const spy = vi.spyOn(client.glimmerApi, "getTaskIntelligence").mockResolvedValue({
      likelyArea: null,
      likelyPackage: null,
      suggestedVerification: [],
      estimatedRisk: "HIGH",
      provenance: "deterministic-backend",
      repoMapStatus: "unmatched-workspace",
    });
    render(
      withQuery(
        <TaskIntelligencePanel
          scopePackage="repository"
          workspace="/tmp/ws"
          mode="refactor"
          verificationLevel="standard"
          candidateCount={7}
        />,
      ),
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toMatchObject({
      scopePackage: "repository",
      workspace: "/tmp/ws",
      mode: "refactor",
      verificationLevel: "standard",
      candidateCount: 7,
    });
  });

  it("debounces the objective instead of requesting on every keystroke", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(client.glimmerApi, "getTaskIntelligence").mockResolvedValue({
      likelyArea: null,
      likelyPackage: null,
      suggestedVerification: [],
      estimatedRisk: "LOW",
      provenance: "deterministic-backend",
      repoMapStatus: "none",
    });
    // One stable QueryClient across rerenders: a fresh client per render would
    // refetch for reasons that have nothing to do with the debounce.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const panel = (objective: string) => (
      <QueryClientProvider client={qc}>
        <TaskIntelligencePanel scopePackage="frontend" objective={objective} />
      </QueryClientProvider>
    );
    const { rerender } = render(panel("a"));
    await act(async () => {
      await Promise.resolve();
    });
    rerender(panel("ab"));
    rerender(panel("abc"));
    // The first render queries with what it was mounted with; the two edits
    // that follow have not landed yet.
    expect(spy.mock.calls.map(([params]) => params.objective)).toEqual(["a"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // Only the settled value was ever requested — the intermediate "ab" never
    // reached the network.
    expect(spy.mock.calls.some(([params]) => params.objective === "abc")).toBe(true);
    expect(spy.mock.calls.some(([params]) => params.objective === "ab")).toBe(false);
    vi.useRealTimers();
  });
});
