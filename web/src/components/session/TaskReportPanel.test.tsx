import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as client from "../../api/client";
import { TaskReportPanel } from "./TaskReportPanel";

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TaskReportPanel sessionId="s1" />
    </QueryClientProvider>,
  );
}

describe("TaskReportPanel", () => {
  it("renders evidence-backed findings and the ordered plan", async () => {
    vi.spyOn(client.glimmerApi, "getTaskReport").mockResolvedValue({
      schemaVersion: 1,
      mode: "inspect",
      objective: "Hva kan bli bedre?",
      summary: "One concrete issue was found.",
      findings: [{
        severity: "high",
        category: "correctness",
        title: "Cancellation state is lost",
        description: "The process record is memory-only.",
        evidence: [{ path: "server/src/routes/sessions.ts", line: 31, detail: "activeRuns is an in-memory map" }],
        recommendedFix: "Persist the process record.",
      }],
      implementationPlan: ["Persist run state", "Verify ownership before SIGTERM"],
      confidence: "high",
    });
    renderPanel();
    expect(await screen.findByText("One concrete issue was found.")).toBeInTheDocument();
    expect(screen.getByText(/sessions\.ts:31/)).toBeInTheDocument();
    expect(screen.getByText("Persist run state")).toBeInTheDocument();
  });

  it("renders nothing when the session has no report", async () => {
    vi.spyOn(client.glimmerApi, "getTaskReport").mockRejectedValue(new Error("404"));
    const { container } = renderPanel();
    await vi.waitFor(() => expect(client.glimmerApi.getTaskReport).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
