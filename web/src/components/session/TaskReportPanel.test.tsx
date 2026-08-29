import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as client from "../../api/client";
import { TaskReportPanel } from "./TaskReportPanel";

function renderPanel(ready = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const panel = (isReady: boolean) => (
    <QueryClientProvider client={queryClient}>
      <TaskReportPanel sessionId="s1" ready={isReady} />
    </QueryClientProvider>
  );
  const result = render(panel(ready));
  return { ...result, rerenderReady: (isReady: boolean) => result.rerender(panel(isReady)) };
}

describe("TaskReportPanel", () => {
  it("renders evidence-backed findings and the ordered plan", async () => {
    vi.spyOn(client.glimmerApi, "getTaskReport").mockResolvedValue({
      schemaVersion: 1,
      mode: "inspect",
      objective: "Hva kan bli bedre?",
      summary: "One concrete issue was found.",
      findings: [
        {
          severity: "high",
          category: "correctness",
          title: "Cancellation state is lost",
          description: "The process record is memory-only.",
          evidence: [
            {
              path: "server/src/routes/sessions.ts",
              line: 31,
              detail: "activeRuns is an in-memory map",
            },
          ],
          recommendedFix: "Persist the process record.",
        },
      ],
      implementationPlan: ["Persist run state", "Verify ownership before SIGTERM"],
      confidence: "high",
    });
    renderPanel();
    expect(await screen.findByText("One concrete issue was found.")).toBeInTheDocument();
    expect(screen.getByText(/sessions\.ts:31/)).toBeInTheDocument();
    expect(screen.getByText("Persist run state")).toBeInTheDocument();
  });

  it("labels V2 claim validation, coverage, critic independence, and rejected claims", async () => {
    vi.spyOn(client.glimmerApi, "getTaskReport").mockResolvedValue({
      schemaVersion: 2,
      mode: "inspect",
      objective: "Validate evidence",
      summary: "Only supported claims are shown as findings.",
      findings: [
        {
          severity: "info",
          category: "structure",
          title: "Route exists",
          description: "The route is present.",
          claimType: "presence",
          evidenceIds: ["ev-1"],
          evidence: [{ path: "server.ts", line: 4, detail: "route declaration" }],
          recommendedFix: "No change.",
          verification: { status: "verified", reasons: [] },
        },
      ],
      rejectedFindings: [
        {
          severity: "high",
          category: "correctness",
          title: "No tests exist",
          description: "Unsupported absence claim.",
          claimType: "absence",
          evidenceIds: [],
          evidence: [],
          recommendedFix: "Search first.",
          verification: { status: "rejected", reasons: ["repository search missing"] },
        },
      ],
      implementationPlan: [],
      confidence: "medium",
      coverage: {
        filesInspected: 4,
        searchesRun: 2,
        graphCoverage: 0.75,
        unsupportedLanguages: ["haskell"],
        evidenceRecords: 1,
      },
      decisionPoints: [],
      critic: { status: "completed", independence: "independent" },
    });
    renderPanel();

    expect(await screen.findByText(/presence · verified/i)).toBeInTheDocument();
    expect(screen.getByText(/graph coverage 75%/i)).toBeInTheDocument();
    expect(screen.getByText(/independence: independent/i)).toBeInTheDocument();
    expect(screen.getByText(/1 rejected claim/i)).toBeInTheDocument();
    expect(screen.getByText(/repository search missing/i)).toBeInTheDocument();
  });

  it("renders nothing when the session has no report", async () => {
    vi.spyOn(client.glimmerApi, "getTaskReport").mockRejectedValue(new Error("404"));
    const { container } = renderPanel();
    await vi.waitFor(() => expect(client.glimmerApi.getTaskReport).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("waits for a terminal session before fetching a report that does not exist yet", async () => {
    const request = vi.spyOn(client.glimmerApi, "getTaskReport").mockResolvedValue({
      schemaVersion: 1,
      mode: "inspect",
      objective: "Hva kan bli bedre?",
      summary: "The completed report is now available.",
      findings: [],
      implementationPlan: [],
      confidence: "medium",
    });
    const { rerenderReady } = renderPanel(false);

    expect(request).not.toHaveBeenCalled();
    rerenderReady(true);

    expect(await screen.findByText("The completed report is now available.")).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
