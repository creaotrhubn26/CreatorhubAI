import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TasksPanel } from "./TasksPanel";
import * as client from "../../api/client";

afterEach(() => vi.restoreAllMocks());

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("TasksPanel", () => {
  it("renders the flat task list with id, kind, description, and status", async () => {
    vi.spyOn(client.glimmerApi, "getSessionTasks").mockResolvedValue([
      { id: "t1", description: "Inspect src/greet.js", kind: "implementation", dependsOn: [], status: "complete" },
      { id: "t6", description: "Manual smoke test", kind: "verification", dependsOn: ["t4"], status: "pending" },
    ]);
    render(withQuery(<TasksPanel sessionId="s1" />));

    await waitFor(() => expect(screen.getByText("Inspect src/greet.js")).toBeInTheDocument());
    expect(screen.getByText("complete")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(screen.getByText("Manual smoke test")).toBeInTheDocument();
    expect(screen.getByText(/deterministic/i)).toBeInTheDocument();
  });

  it("visually distinguishes pending/in_progress/complete/failed statuses", async () => {
    vi.spyOn(client.glimmerApi, "getSessionTasks").mockResolvedValue([
      { id: "t1", description: "a", kind: "implementation", dependsOn: [], status: "pending" },
      { id: "t2", description: "b", kind: "implementation", dependsOn: [], status: "in_progress" },
      { id: "t3", description: "c", kind: "implementation", dependsOn: [], status: "complete" },
      { id: "t4", description: "d", kind: "implementation", dependsOn: [], status: "failed" },
    ]);
    render(withQuery(<TasksPanel sessionId="s1" />));

    await waitFor(() => expect(screen.getByText("pending")).toBeInTheDocument());
    const styles = ["pending", "in_progress", "complete", "failed"].map((s) => screen.getByText(s).getAttribute("style"));
    expect(new Set(styles).size).toBe(4);
  });

  it("renders nothing when the tasks artifact 404s (absence is normal)", async () => {
    vi.spyOn(client.glimmerApi, "getSessionTasks").mockRejectedValue(new Error("GET .../tasks failed: 404"));
    const { container } = render(withQuery(<TasksPanel sessionId="s1" />));

    await waitFor(() => expect(client.glimmerApi.getSessionTasks).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
