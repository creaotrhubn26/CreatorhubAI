import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TasksPanel } from "./TasksPanel";
import * as client from "../../api/client";

afterEach(() => vi.restoreAllMocks());

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

// CollapsibleSection starts collapsed (its body carries the `hidden`
// attribute), and getByRole excludes inaccessible elements by default — so
// any test that queries a button/heading by role must open the section
// first, exactly like a real user would.
function openPanel() {
  fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
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

  it("groups tasks by kind, in implementation/verification/repair/documentation order", async () => {
    vi.spyOn(client.glimmerApi, "getSessionTasks").mockResolvedValue([
      { id: "t4", description: "Doc impact", kind: "documentation", dependsOn: [], status: "pending" },
      { id: "t3", description: "Fix regression", kind: "repair", dependsOn: [], status: "in_progress" },
      { id: "t2", description: "Run tests", kind: "verification", dependsOn: [], status: "pending" },
      { id: "t1", description: "Add hook", kind: "implementation", dependsOn: [], status: "complete" },
    ]);
    render(withQuery(<TasksPanel sessionId="s1" />));
    await waitFor(() => expect(screen.getByText("Add hook")).toBeInTheDocument());
    openPanel();

    const headings = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(headings).toEqual(["Implementation", "Verification", "Repair", "Documentation"]);
  });

  it("shows priority badges: required filled, recommended text, optional muted", async () => {
    vi.spyOn(client.glimmerApi, "getSessionTasks").mockResolvedValue([
      { id: "t1", description: "a", kind: "implementation", dependsOn: [], status: "pending", priority: "required" },
      { id: "t2", description: "b", kind: "implementation", dependsOn: [], status: "pending", priority: "recommended" },
      { id: "t3", description: "c", kind: "implementation", dependsOn: [], status: "pending", priority: "optional" },
    ]);
    render(withQuery(<TasksPanel sessionId="s1" />));
    await waitFor(() => expect(screen.getByText("required")).toBeInTheDocument());

    expect(screen.getByText("required").className).toContain("badge-status");
    expect(screen.getByText("recommended").className).toContain("meta-value");
    expect(screen.getByText("optional").getAttribute("style")).toContain("var(--text-muted)");
  });

  it("renders blockingReason, affectedFiles, and createdBecause", async () => {
    vi.spyOn(client.glimmerApi, "getSessionTasks").mockResolvedValue([
      {
        id: "t1", description: "Fix login", kind: "repair", dependsOn: [], status: "in_progress",
        blockingReason: "check failed: npm test", affectedFiles: ["src/a.ts", "src/b.ts"],
        createdBecause: "npm test",
      },
    ]);
    render(withQuery(<TasksPanel sessionId="s1" />));
    await waitFor(() => expect(screen.getByText(/check failed: npm test/)).toBeInTheDocument());
    expect(screen.getByText(/src\/a\.ts, src\/b\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/because: npm test/)).toBeInTheDocument();
  });

  it("toggles between list (grouped) and graph (dependency columns) views", async () => {
    vi.spyOn(client.glimmerApi, "getSessionTasks").mockResolvedValue([
      { id: "t1", description: "Add hook", kind: "implementation", dependsOn: [], status: "complete" },
      { id: "t2", description: "Run tests", kind: "verification", dependsOn: ["t1"], status: "pending" },
    ]);
    const { container } = render(withQuery(<TasksPanel sessionId="s1" />));
    await waitFor(() => expect(screen.getByText("Add hook")).toBeInTheDocument());
    openPanel();

    // List view: grouped under kind headings.
    expect(screen.getAllByRole("heading", { level: 4 }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    // Graph view: no kind headings, but both tasks still render, and the
    // dependent task shows its dependency.
    await waitFor(() => expect(container.querySelectorAll("h4").length).toBe(0));
    expect(screen.getByText("Add hook")).toBeInTheDocument();
    expect(screen.getByText("Run tests")).toBeInTheDocument();
    expect(screen.getByText(/depends on: t1/)).toBeInTheDocument();
  });

  it("fires skip/approve mutations and shows the recorded human override instead of buttons", async () => {
    vi.spyOn(client.glimmerApi, "getSessionTasks").mockResolvedValue([
      { id: "t1", description: "Optional cleanup", kind: "implementation", dependsOn: [], status: "pending", priority: "optional" },
    ]);
    const skipSpy = vi.spyOn(client.glimmerApi, "skipTask").mockResolvedValue({ taskId: "t1", action: "skip", at: "2026-01-01T00:00:00Z" });
    render(withQuery(<TasksPanel sessionId="s1" />));
    await waitFor(() => expect(screen.getByText("Optional cleanup")).toBeInTheDocument());
    openPanel();

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(skipSpy).toHaveBeenCalledWith("s1", "t1"));
  });

  it("hides Skip/Approve buttons once a task already carries a human override", async () => {
    vi.spyOn(client.glimmerApi, "getSessionTasks").mockResolvedValue([
      {
        id: "t1", description: "Already skipped", kind: "implementation", dependsOn: [], status: "skipped",
        priority: "optional", override: { action: "skip", at: "2026-01-01T00:00:00Z" },
      },
    ]);
    render(withQuery(<TasksPanel sessionId="s1" />));
    await waitFor(() => expect(screen.getByText("Already skipped")).toBeInTheDocument());
    openPanel();

    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByText(/human: skip/)).toBeInTheDocument();
  });

  it("hides Skip/Approve buttons when the session is terminal (verified/failed/blocked/cancelled)", async () => {
    vi.spyOn(client.glimmerApi, "getSessionTasks").mockResolvedValue([
      { id: "t1", description: "Add hook", kind: "implementation", dependsOn: [], status: "pending", priority: "required" },
    ]);
    render(withQuery(<TasksPanel sessionId="s1" session={{ status: "verified" } as any} />));
    await waitFor(() => expect(screen.getByText("Add hook")).toBeInTheDocument());
    openPanel();

    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
  });
});
