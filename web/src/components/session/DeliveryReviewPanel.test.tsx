import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DeliveryReviewPanel } from "./DeliveryReviewPanel";
import * as client from "../../api/client";

afterEach(() => vi.restoreAllMocks());

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("DeliveryReviewPanel", () => {
  it("renders summary, customerReadiness badge, strengths, concerns, grouped next steps, and confidence", async () => {
    vi.spyOn(client.glimmerApi, "getDeliveryReview").mockResolvedValue({
      summary: "src/greet.js now defines whisper(name)",
      customerReadiness: "ready_with_known_limitations",
      confidence: { level: "medium", reason: "no executed validation" },
      strengths: ["Implementation matches required signature"],
      concerns: [{ severity: "medium", category: "verification", description: "No non-destructive validation command could run", evidenceIds: [] }],
      nextSteps: [
        { priority: "recommended_next", action: "Run a quick node sanity check" },
        { priority: "future_opportunity", action: "Add unit tests for whisper edge cases" },
      ],
    });
    render(withQuery(<DeliveryReviewPanel sessionId="s1" />));

    await waitFor(() => expect(screen.getByText(/src\/greet\.js now defines whisper/)).toBeInTheDocument());
    expect(screen.getByText("ready_with_known_limitations")).toBeInTheDocument();
    expect(screen.getByText(/Implementation matches required signature/)).toBeInTheDocument();
    expect(screen.getByText(/No non-destructive validation command could run/)).toBeInTheDocument();
    expect(screen.getByText(/Run a quick node sanity check/)).toBeInTheDocument();
    expect(screen.getByText(/Add unit tests for whisper edge cases/)).toBeInTheDocument();
    expect(screen.getByText("Recommended next")).toBeInTheDocument();
    expect(screen.getByText("Future opportunity")).toBeInTheDocument();
    expect(screen.getByText(/medium — no executed validation/)).toBeInTheDocument();
    expect(screen.getByText(/model-generated/i)).toBeInTheDocument();
  });

  it("distinguishes all 5 customerReadiness states visually", async () => {
    const states = ["ready_to_ship", "ready_with_known_limitations", "needs_polish", "needs_rework", "not_customer_ready"] as const;
    const colors: (string | null)[] = [];
    for (const customerReadiness of states) {
      vi.spyOn(client.glimmerApi, "getDeliveryReview").mockResolvedValue({
        summary: "s", customerReadiness, confidence: { level: "low", reason: "r" },
      } as any);
      const { unmount } = render(withQuery(<DeliveryReviewPanel sessionId="s1" />));
      await waitFor(() => expect(screen.getByText(customerReadiness)).toBeInTheDocument());
      colors.push(screen.getByText(customerReadiness).getAttribute("style"));
      unmount();
      vi.restoreAllMocks();
    }
    expect(new Set(colors).size).toBeGreaterThan(1);
  });

  it("renders a single honest failure line instead of the full review when reviewFailed is true", async () => {
    vi.spyOn(client.glimmerApi, "getDeliveryReview").mockResolvedValue({
      summary: "unused", customerReadiness: "not_customer_ready",
      confidence: { level: "low", reason: "n/a" }, reviewFailed: true, reviewFailureReason: "model output could not be parsed",
    } as any);
    render(withQuery(<DeliveryReviewPanel sessionId="s1" />));

    await waitFor(() => expect(screen.getByText(/delivery review failed to generate/i)).toBeInTheDocument());
    expect(screen.getByText(/model output could not be parsed/)).toBeInTheDocument();
    expect(screen.queryByText("unused")).not.toBeInTheDocument();
    expect(screen.queryByText("not_customer_ready")).not.toBeInTheDocument();
  });

  it("renders nothing when the delivery-review artifact 404s (absence is normal)", async () => {
    vi.spyOn(client.glimmerApi, "getDeliveryReview").mockRejectedValue(new Error("GET .../delivery-review failed: 404"));
    const { container } = render(withQuery(<DeliveryReviewPanel sessionId="s1" />));

    await waitFor(() => expect(client.glimmerApi.getDeliveryReview).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
