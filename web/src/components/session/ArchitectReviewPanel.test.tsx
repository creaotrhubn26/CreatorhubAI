import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArchitectReviewPanel } from "./ArchitectReviewPanel";
import * as client from "../../api/client";

afterEach(() => vi.restoreAllMocks());

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("ArchitectReviewPanel", () => {
  it("renders each review's decision badge, confidence, findings, and required changes", async () => {
    vi.spyOn(client.glimmerApi, "getArchitectReviews").mockResolvedValue([
      {
        decision: "APPROVED_WITH_CONDITIONS",
        confidence: 0.88,
        findings: ["src/greet.js now contains whisper()"],
        requiredChanges: ["remove test_greet.js"],
      },
    ]);
    render(withQuery(<ArchitectReviewPanel sessionId="s1" />));

    await waitFor(() => expect(screen.getByText("APPROVED_WITH_CONDITIONS")).toBeInTheDocument());
    expect(screen.getByText(/0.88/)).toBeInTheDocument();
    expect(screen.getByText(/src\/greet\.js now contains whisper/)).toBeInTheDocument();
    expect(screen.getByText(/remove test_greet\.js/)).toBeInTheDocument();
    expect(screen.getByText(/model-generated/i)).toBeInTheDocument();
  });

  it("colors APPROVED, APPROVED_WITH_CONDITIONS, and a revise/replan/human decision distinctly", async () => {
    vi.spyOn(client.glimmerApi, "getArchitectReviews").mockResolvedValue([
      { decision: "APPROVED", confidence: 0.9 },
      { decision: "APPROVED_WITH_CONDITIONS", confidence: 0.7 },
      { decision: "REPLAN_REQUIRED", confidence: 0.4 },
    ] as any);
    render(withQuery(<ArchitectReviewPanel sessionId="s1" />));

    await waitFor(() => expect(screen.getByText("APPROVED")).toBeInTheDocument());
    const approvedColor = screen.getByText("APPROVED").getAttribute("style");
    const conditionalColor = screen.getByText("APPROVED_WITH_CONDITIONS").getAttribute("style");
    const replanColor = screen.getByText("REPLAN_REQUIRED").getAttribute("style");
    expect(approvedColor).not.toBe(conditionalColor);
    expect(conditionalColor).not.toBe(replanColor);
    expect(approvedColor).not.toBe(replanColor);
  });

  it("renders nothing when reviews 404 and there is no gate data (absence is normal)", async () => {
    vi.spyOn(client.glimmerApi, "getArchitectReviews").mockRejectedValue(new Error("GET .../architect-reviews failed: 404"));
    const { container } = render(withQuery(<ArchitectReviewPanel sessionId="s1" />));

    await waitFor(() => expect(client.glimmerApi.getArchitectReviews).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("surfaces session.gates.architectureApproved as orchestrator-recorded fact: true/false/null -> approved/rejected/not-reviewed", async () => {
    vi.spyOn(client.glimmerApi, "getArchitectReviews").mockRejectedValue(new Error("404"));
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ArchitectReviewPanel sessionId="s1" gates={{ architectureApproved: true }} />
      </QueryClientProvider>
    );
    await waitFor(() => expect(screen.getByText(/approved/)).toBeInTheDocument());
    expect(screen.getByText(/orchestrator-recorded/i)).toBeInTheDocument();

    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ArchitectReviewPanel sessionId="s1" gates={{ architectureApproved: false }} />
      </QueryClientProvider>
    );
    await waitFor(() => expect(screen.getByText(/rejected/)).toBeInTheDocument());

    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ArchitectReviewPanel sessionId="s1" gates={{ architectureApproved: null }} />
      </QueryClientProvider>
    );
    await waitFor(() => expect(screen.getByText(/not reviewed/)).toBeInTheDocument());
  });
});
