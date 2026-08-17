import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
      likelyArea: "frontend", likelyPackage: "creatorhub-frontend",
      suggestedVerification: ["frontend-typecheck"], estimatedRisk: null, provenance: "git-derived",
    });
    render(withQuery(<TaskIntelligencePanel scopePackage="frontend" scopeArea={undefined} />));
    await waitFor(() => expect(screen.getByText("frontend")).toBeInTheDocument());
    expect(screen.getByText("creatorhub-frontend")).toBeInTheDocument();
    expect(screen.getByText(/Deterministic/i)).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument(); // estimatedRisk: null
  });

  it("shows Unavailable throughout when no repo map exists", async () => {
    vi.spyOn(client.glimmerApi, "getTaskIntelligence").mockResolvedValue({
      likelyArea: null, likelyPackage: null, suggestedVerification: [], estimatedRisk: null, provenance: "deterministic-backend",
    });
    render(withQuery(<TaskIntelligencePanel scopePackage="repository" scopeArea={undefined} />));
    await waitFor(() => expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0));
  });

  it("reads the provenance field into the caption instead of a fully static string", async () => {
    vi.spyOn(client.glimmerApi, "getTaskIntelligence").mockResolvedValue({
      likelyArea: "frontend", likelyPackage: "creatorhub-frontend",
      suggestedVerification: ["frontend-typecheck"], estimatedRisk: null, provenance: "git-derived",
    });
    render(withQuery(<TaskIntelligencePanel scopePackage="frontend" scopeArea={undefined} />));
    await waitFor(() => expect(screen.getByText(/git-derived/)).toBeInTheDocument());
  });
});
