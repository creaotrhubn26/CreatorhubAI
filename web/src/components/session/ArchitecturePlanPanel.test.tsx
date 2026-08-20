import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArchitecturePlanPanel } from "./ArchitecturePlanPanel";
import * as client from "../../api/client";

afterEach(() => vi.restoreAllMocks());

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("ArchitecturePlanPanel", () => {
  it("renders the plan's objective, risk, packages, candidate files, implementation plan, constraints, and uncertainties", async () => {
    vi.spyOn(client.glimmerApi, "getArchitecturePlan").mockResolvedValue({
      objective: "Add a whisper(name) function to src/greet.js",
      packages: ["glimmer-smoke-test"],
      risk: "low",
      candidateFiles: [{ path: "src/greet.js", reason: "contains greet", confidence: 0.95 }],
      constraints: ["minimalChange true"],
      implementationPlan: ["Inspect src/greet.js", "Add whisper()"],
      uncertainties: ["No tests found in repository"],
    });
    render(withQuery(<ArchitecturePlanPanel sessionId="s1" />));

    await waitFor(() => expect(screen.getByText(/Add a whisper\(name\) function/)).toBeInTheDocument());
    expect(screen.getByText("low")).toBeInTheDocument();
    expect(screen.getByText("glimmer-smoke-test")).toBeInTheDocument();
    expect(screen.getByText(/src\/greet\.js — contains greet/)).toBeInTheDocument();
    expect(screen.getByText("Add whisper()")).toBeInTheDocument();
    expect(screen.getByText("minimalChange true")).toBeInTheDocument();
    expect(screen.getByText("No tests found in repository")).toBeInTheDocument();
    expect(screen.getByText(/model-generated/i)).toBeInTheDocument();
  });

  it("renders nothing when the plan artifact 404s (absence is normal)", async () => {
    vi.spyOn(client.glimmerApi, "getArchitecturePlan").mockRejectedValue(new Error("GET /api/sessions/s1/plan failed: 404"));
    const { container } = render(withQuery(<ArchitecturePlanPanel sessionId="s1" />));

    await waitFor(() => expect(client.glimmerApi.getArchitecturePlan).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("only renders optional sections that are present", async () => {
    vi.spyOn(client.glimmerApi, "getArchitecturePlan").mockResolvedValue({
      objective: "Minimal plan", packages: ["p"], risk: "medium",
    });
    render(withQuery(<ArchitecturePlanPanel sessionId="s1" />));

    await waitFor(() => expect(screen.getByText("Minimal plan")).toBeInTheDocument());
    expect(screen.queryByText("Candidate files")).not.toBeInTheDocument();
    expect(screen.queryByText("Implementation plan")).not.toBeInTheDocument();
  });
});
