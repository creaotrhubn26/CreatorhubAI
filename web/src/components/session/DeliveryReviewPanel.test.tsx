import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { DeliveryReviewPanel } from "./DeliveryReviewPanel";
import * as client from "../../api/client";

afterEach(() => vi.restoreAllMocks());

// DeliveryReviewPanel's "convert to task" action calls useNavigate(), which
// requires a Router context -- MemoryRouter is test scaffolding, matching
// AppShell.test.tsx's LocationProbe pattern, so the navigation target/state
// can be asserted without a real /tasks/new route tree.
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location-probe">
      {location.pathname}::{JSON.stringify(location.state)}
    </div>
  );
}

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        {ui}
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("DeliveryReviewPanel", () => {
  it("renders summary, customerReadiness badge, strengths, concerns, grouped next steps, and confidence", async () => {
    vi.spyOn(client.glimmerApi, "getDeliveryReview").mockResolvedValue({
      summary: "src/greet.js now defines whisper(name)",
      customerReadiness: "ready_with_known_limitations",
      confidence: { level: "medium", reason: "no executed validation" },
      strengths: ["Implementation matches required signature"],
      concerns: [
        {
          severity: "medium",
          category: "verification",
          description: "No non-destructive validation command could run",
          evidenceIds: [],
        },
      ],
      nextSteps: [
        { priority: "recommended_next", action: "Run a quick node sanity check" },
        { priority: "future_opportunity", action: "Add unit tests for whisper edge cases" },
      ],
    });
    render(withQuery(<DeliveryReviewPanel sessionId="s1" />));

    await waitFor(() =>
      expect(screen.getByText(/src\/greet\.js now defines whisper/)).toBeInTheDocument(),
    );
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
    const states = [
      "ready_to_ship",
      "ready_with_known_limitations",
      "needs_polish",
      "needs_rework",
      "not_customer_ready",
    ] as const;
    const colors: (string | null)[] = [];
    for (const customerReadiness of states) {
      vi.spyOn(client.glimmerApi, "getDeliveryReview").mockResolvedValue({
        summary: "s",
        customerReadiness,
        confidence: { level: "low", reason: "r" },
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
      summary: "unused",
      customerReadiness: "not_customer_ready",
      confidence: { level: "low", reason: "n/a" },
      reviewFailed: true,
      reviewFailureReason: "model output could not be parsed",
    } as any);
    render(withQuery(<DeliveryReviewPanel sessionId="s1" />));

    await waitFor(() =>
      expect(screen.getByText(/delivery review failed to generate/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/model output could not be parsed/)).toBeInTheDocument();
    expect(screen.queryByText("unused")).not.toBeInTheDocument();
    expect(screen.queryByText("not_customer_ready")).not.toBeInTheDocument();
  });

  it("renders nothing when the delivery-review artifact 404s (absence is normal)", async () => {
    vi.spyOn(client.glimmerApi, "getDeliveryReview").mockRejectedValue(
      new Error("GET .../delivery-review failed: 404"),
    );
    const { container } = render(withQuery(<DeliveryReviewPanel sessionId="s1" />));

    await waitFor(() => expect(client.glimmerApi.getDeliveryReview).toHaveBeenCalled());
    // container also holds the test-only LocationProbe sibling (see
    // withQuery above), so "renders nothing" is checked against the
    // panel's own root element (a CollapsibleSection <section>), not the
    // whole container.
    expect(container.querySelector("section")).toBeNull();
  });

  it("renders approachRationale, unresolvedItems, and intentionallyNotChanged when present", async () => {
    vi.spyOn(client.glimmerApi, "getDeliveryReview").mockResolvedValue({
      summary: "s",
      customerReadiness: "ready_to_ship",
      confidence: { level: "high", reason: "r" },
      approachRationale: ["Reused the existing adapter instead of a new one"],
      unresolvedItems: ["recovery feedback is subtle"],
      intentionallyNotChanged: ["left the legacy formatter alone"],
    } as any);
    render(withQuery(<DeliveryReviewPanel sessionId="s1" />));

    await waitFor(() =>
      expect(screen.getByText(/Reused the existing adapter/)).toBeInTheDocument(),
    );
    expect(screen.getByText("recovery feedback is subtle")).toBeInTheDocument();
    expect(screen.getByText("left the legacy formatter alone")).toBeInTheDocument();
  });

  it("omits approachRationale/unresolvedItems/intentionallyNotChanged sections honestly when absent", async () => {
    vi.spyOn(client.glimmerApi, "getDeliveryReview").mockResolvedValue({
      summary: "s",
      customerReadiness: "ready_to_ship",
      confidence: { level: "high", reason: "r" },
    } as any);
    render(withQuery(<DeliveryReviewPanel sessionId="s1" />));

    await waitFor(() => expect(screen.getByText("s")).toBeInTheDocument());
    expect(screen.queryByText("Approach rationale")).not.toBeInTheDocument();
    expect(screen.queryByText("Unresolved items")).not.toBeInTheDocument();
    expect(screen.queryByText("Intentionally not changed")).not.toBeInTheDocument();
  });

  it("'convert to task' navigates to /tasks/new with a DRAFT objective and runs nothing", async () => {
    vi.spyOn(client.glimmerApi, "getDeliveryReview").mockResolvedValue({
      summary: "s",
      customerReadiness: "ready_to_ship",
      confidence: { level: "high", reason: "r" },
      nextSteps: [{ priority: "recommended_next", action: "Add restoration progress state" }],
    } as any);
    render(withQuery(<DeliveryReviewPanel sessionId="s1" />));

    await waitFor(() =>
      expect(screen.getByText("Add restoration progress state")).toBeInTheDocument(),
    );
    // The section body is collapsed by default (CollapsibleSection's native
    // `hidden` attribute) -- getByText still finds it (unlike getByRole,
    // which excludes hidden-from-accessibility-tree elements), and
    // fireEvent.click on it bubbles up correctly regardless of visibility.
    fireEvent.click(screen.getByText("Convert to task"));

    const probe = screen.getByTestId("location-probe");
    expect(probe.textContent).toBe(
      `/tasks/new::${JSON.stringify({ objective: "Add restoration progress state" })}`,
    );
  });

  it("renders the architect escalation section when present", async () => {
    vi.spyOn(client.glimmerApi, "getDeliveryReview").mockResolvedValue({
      summary: "s",
      customerReadiness: "needs_polish",
      confidence: { level: "medium", reason: "r" },
      concerns: [
        {
          severity: "high",
          category: "architecture",
          description: "data ownership duplicated",
          evidenceIds: [],
        },
      ],
      architectEscalation: { question: "Is this sound?", answer: "Approved, proceed as-is." },
    } as any);
    render(withQuery(<DeliveryReviewPanel sessionId="s1" />));

    await waitFor(() => expect(screen.getByText("Architect escalation")).toBeInTheDocument());
    expect(screen.getByText(/Is this sound\?/)).toBeInTheDocument();
    expect(screen.getByText("Approved, proceed as-is.")).toBeInTheDocument();
  });

  it("renders a failed-consultation line when architect escalation could not run", async () => {
    vi.spyOn(client.glimmerApi, "getDeliveryReview").mockResolvedValue({
      summary: "s",
      customerReadiness: "needs_polish",
      confidence: { level: "medium", reason: "r" },
      architectEscalation: { consultationFailed: true, reason: "architect model unreachable" },
    } as any);
    render(withQuery(<DeliveryReviewPanel sessionId="s1" />));

    await waitFor(() => expect(screen.getByText("Architect escalation")).toBeInTheDocument());
    expect(
      screen.getByText(/Consultation failed: architect model unreachable/),
    ).toBeInTheDocument();
  });
});
