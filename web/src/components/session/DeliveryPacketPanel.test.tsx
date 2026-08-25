import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DeliveryPacketPanel } from "./DeliveryPacketPanel";
import * as client from "../../api/client";

afterEach(() => vi.restoreAllMocks());

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const FULL_PACKET = {
  task: "add widget",
  planRef: { architectUsed: true, architectureApproved: true },
  changedFiles: ["src/widget.ts"],
  orchestratorUpdatedFiles: ["docs/graph.json"],
  verification: { status: "VERIFIED", results: [{ ok: true }] },
  visual: "PASS",
  statuses: {
    technical: "VERIFIED",
    architecture: "approved",
    documentation: "not_run",
    visual: "PASS",
    delivery: "ready_with_known_limitations",
    overall: "ready_with_known_limitations",
  },
  customerReadiness: { value: "ready_with_known_limitations", provenance: "model-output" },
  limitations: {
    unresolvedItems: ["recovery feedback is subtle"],
    intentionallyNotChanged: [],
    concerns: [],
    provenance: "model-output",
  },
  forwardPlan: {
    nextSteps: [{ priority: "recommended_next", action: "add progress state" }],
    provenance: "model-output",
  },
  confidence: { level: "high", reason: "well tested", provenance: "model-output" },
  humanReviewStatus: "pending",
};

describe("DeliveryPacketPanel", () => {
  it("renders task, verification, visual, customer readiness, confidence, changed files, limitations, and plan forward", async () => {
    vi.spyOn(client.glimmerApi, "getDeliveryPacket").mockResolvedValue(FULL_PACKET as any);
    render(withQuery(<DeliveryPacketPanel sessionId="s1" />));

    await waitFor(() => expect(screen.getByText("add widget")).toBeInTheDocument());
    expect(screen.getByText("VERIFIED")).toBeInTheDocument();
    expect(screen.getByText("PASS")).toBeInTheDocument();
    expect(screen.getAllByText(/ready_with_known_limitations/).length).toBeGreaterThan(0);
    expect(screen.getByText("high — well tested")).toBeInTheDocument();
    expect(screen.getByText("src/widget.ts")).toBeInTheDocument();
    expect(screen.getByText("docs/graph.json")).toBeInTheDocument();
    expect(screen.getByText("recovery feedback is subtle")).toBeInTheDocument();
    expect(screen.getByText("add progress state")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
  });

  it("renders honest 'Unavailable' sections when no delivery review ever ran (absent artifact)", async () => {
    const bare = {
      task: "t",
      planRef: null,
      changedFiles: [],
      orchestratorUpdatedFiles: [],
      verification: { status: "NOT_RUN", results: null },
      visual: "not_run",
      statuses: {},
      customerReadiness: null,
      limitations: null,
      forwardPlan: null,
      confidence: null,
      humanReviewStatus: "pending",
    };
    vi.spyOn(client.glimmerApi, "getDeliveryPacket").mockResolvedValue(bare as any);
    render(withQuery(<DeliveryPacketPanel sessionId="s1" />));

    await waitFor(() => expect(screen.getByText("t")).toBeInTheDocument());
    // customerReadiness dd and confidence dd both honestly render the bare
    // word "Unavailable" (their <dt> already labels which is which).
    expect(screen.getAllByText("Unavailable")).toHaveLength(2);
    expect(screen.getByText("Known limitations: Unavailable")).toBeInTheDocument();
    expect(screen.getByText("Plan forward: Unavailable")).toBeInTheDocument();
    expect(screen.getByText("none")).toBeInTheDocument(); // changed files
  });

  it("renders nothing when the delivery-packet artifact 404s (absence is normal)", async () => {
    vi.spyOn(client.glimmerApi, "getDeliveryPacket").mockRejectedValue(
      new Error("GET .../delivery-packet failed: 404"),
    );
    const { container } = render(withQuery(<DeliveryPacketPanel sessionId="s1" />));

    await waitFor(() => expect(client.glimmerApi.getDeliveryPacket).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
