import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, waitFor, fireEvent, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "./AppShell";
import { ActiveSessionScreen } from "../session/ActiveSessionScreen";
import * as client from "../../api/client";

// Renders alongside AppShell (both share the same MemoryRouter context) so
// a click that calls navigate() can be asserted on without a full Routes
// tree — AppShell's own children slot isn't a route outlet.
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  close() {}
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent); }
}

function withProviders(ui: React.ReactElement, initialEntries = ["/"]) {
  vi.spyOn(client.glimmerApi, "listSessions").mockResolvedValue([]);
  vi.spyOn(client.glimmerApi, "getModelStatus").mockResolvedValue({ status: "OFFLINE", endpoint: "x", provenance: "deterministic-backend" });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AppShell", () => {
  it("renders every activity-bar entry from spec §5.2", () => {
    render(withProviders(<AppShell repoContext={null}>content</AppShell>));
    const activityBar = within(screen.getByRole("navigation"));
    for (const label of ["Dashboard", "Sessions", "New Task", "Verification", "Repository", "Model", "Settings"]) {
      expect(activityBar.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("shows 'Not connected' repo context when none is provided", () => {
    render(withProviders(<AppShell repoContext={null}>content</AppShell>));
    expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0);
  });

  it("renders the routed content inside the editor content region", () => {
    render(withProviders(<AppShell repoContext={null}>hello from a route</AppShell>));
    expect(screen.getByText("hello from a route")).toBeInTheDocument();
  });

  it("shows the status bar with a model status field", async () => {
    render(withProviders(<AppShell repoContext={null}>content</AppShell>));
    expect(await screen.findByText(/model: OFFLINE/)).toBeInTheDocument();
  });

  it("clicking the model status bar item navigates to the Model Status screen", async () => {
    vi.spyOn(client.glimmerApi, "listSessions").mockResolvedValue([]);
    vi.spyOn(client.glimmerApi, "getModelStatus").mockResolvedValue({ status: "OFFLINE", endpoint: "x", provenance: "deterministic-backend" });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/"]}>
          <AppShell repoContext={null}>content</AppShell>
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>
    );

    const modelItem = await screen.findByRole("button", { name: /model: OFFLINE/ });
    fireEvent.click(modelItem);
    expect(screen.getByTestId("location-probe")).toHaveTextContent("/model");
  });

  it("opens a tab for a visited session and closes it via its close button", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "verifying", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [], verification: { overall: "PARTIAL", checks: [] },
      repairsUsed: 0, repairBudget: 2,
    } as any);
    render(withProviders(<AppShell repoContext={null}>session content</AppShell>, ["/sessions/s1"]));

    const closeBtn = await screen.findByRole("button", { name: "Close s1" });
    expect(closeBtn).toBeInTheDocument();

    fireEvent.click(closeBtn);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Close s1" })).not.toBeInTheDocument());
  });

  // pending-* rows are transient adopted-workspace placeholders — a
  // duplicate of the real session once it lands, not a second session.
  it("hides pending-* session rows from the sidebar list", async () => {
    vi.spyOn(client.glimmerApi, "listSessions").mockResolvedValue([
      { id: "pending-abc123", task: "Fix dialog parser", status: "created", workspace: "/ws", branch: "glimmer/x", baselineSha: "abc", changedFiles: [], verification: { overall: "NOT_RUN", checks: [] }, repairsUsed: 0, repairBudget: 2 },
      { id: "20260821-221803-glimmer-x", task: "Fix dialog parser", status: "verified", workspace: "/ws", branch: "glimmer/x", baselineSha: "abc", changedFiles: [], verification: { overall: "VERIFIED", checks: [] }, repairsUsed: 0, repairBudget: 2 },
    ] as any);
    vi.spyOn(client.glimmerApi, "getModelStatus").mockResolvedValue({ status: "OFFLINE", endpoint: "x", provenance: "deterministic-backend" });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/"]}>
          <AppShell repoContext={null}>content</AppShell>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getAllByText("Fix dialog parser")).toHaveLength(1));
  });

  it("pulses the status dot for a running session's sidebar row and tab, not for a terminal one", async () => {
    vi.spyOn(client.glimmerApi, "listSessions").mockResolvedValue([
      { id: "20260821-221803-glimmer-running", task: "Running task", status: "implementing", workspace: "/ws", branch: "glimmer/x", baselineSha: "abc", changedFiles: [], verification: { overall: "NOT_RUN", checks: [] }, repairsUsed: 0, repairBudget: 2 },
      { id: "20260821-221804-glimmer-done", task: "Done task", status: "verified", workspace: "/ws", branch: "glimmer/x", baselineSha: "abc", changedFiles: [], verification: { overall: "VERIFIED", checks: [] }, repairsUsed: 0, repairBudget: 2 },
    ] as any);
    vi.spyOn(client.glimmerApi, "getModelStatus").mockResolvedValue({ status: "OFFLINE", endpoint: "x", provenance: "deterministic-backend" });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/"]}>
          <AppShell repoContext={null}>content</AppShell>
        </MemoryRouter>
      </QueryClientProvider>
    );

    const runningRow = (await screen.findByText("Running task")).closest(".ide-session-row");
    const doneRow = (await screen.findByText("Done task")).closest(".ide-session-row");
    expect(runningRow?.querySelector(".ide-status-dot")).toHaveClass("ide-status-dot--pulse");
    expect(doneRow?.querySelector(".ide-status-dot")).not.toHaveClass("ide-status-dot--pulse");
  });

  it("opens the command palette on cmd+K even when focus is inside an input", async () => {
    render(withProviders(<AppShell repoContext={null}>content</AppShell>));
    const searchInput = screen.getByPlaceholderText("Search sessions…");
    searchInput.focus();
    fireEvent.keyDown(searchInput, { key: "k", metaKey: true });
    expect(await screen.findByRole("textbox", { name: "Command palette" })).toBeInTheDocument();
  });

  it("does not toggle the sidebar on a bare `[` while typing in a field", async () => {
    render(withProviders(<AppShell repoContext={null}>content</AppShell>));
    const searchInput = screen.getByPlaceholderText("Search sessions…");
    fireEvent.keyDown(searchInput, { key: "[" });
    expect(document.querySelector(".ide-leftpanel")).not.toHaveClass("is-collapsed");
  });

  describe("session event stream", () => {
    const realEventSource = globalThis.EventSource;
    afterEach(() => {
      FakeEventSource.instances.length = 0;
      (globalThis as any).EventSource = realEventSource;
    });

    it("opens only one EventSource when a session route renders, shared with the routed screen", async () => {
      (globalThis as any).EventSource = FakeEventSource;
      vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
        id: "s1", task: "Fix dialog parser", status: "verifying", workspace: "/ws", branch: "glimmer/x",
        baselineSha: "abc", changedFiles: [], verification: { overall: "PARTIAL", checks: [] },
        repairsUsed: 0, repairBudget: 2,
      } as any);

      render(
        withProviders(
          <AppShell repoContext={null}>
            <Routes>
              <Route path="/sessions/:id" element={<ActiveSessionScreen />} />
            </Routes>
          </AppShell>,
          ["/sessions/s1"]
        )
      );

      await waitFor(() => expect(screen.getByText(/Fix dialog parser/)).toBeInTheDocument());
      expect(FakeEventSource.instances).toHaveLength(1);
      expect(FakeEventSource.instances[0].url).toContain("/api/sessions/s1/events");
    });

    it("propagates an SSE event's own timestamp through the shared context so the liveness line renders", async () => {
      (globalThis as any).EventSource = FakeEventSource;
      vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
        id: "s1", task: "Fix dialog parser", status: "implementing", workspace: "/ws", branch: "glimmer/x",
        baselineSha: "abc", changedFiles: [], verification: { overall: "NOT_RUN", checks: [] },
        repairsUsed: 0, repairBudget: 2,
      } as any);

      render(
        withProviders(
          <AppShell repoContext={null}>
            <Routes>
              <Route path="/sessions/:id" element={<ActiveSessionScreen />} />
            </Routes>
          </AppShell>,
          ["/sessions/s1"]
        )
      );

      await waitFor(() => expect(screen.getByText(/Fix dialog parser/)).toBeInTheDocument());
      const es = FakeEventSource.instances[0];
      act(() => {
        es.emit({ id: "e1", sessionId: "s1", timestamp: new Date().toISOString(), type: "tool_started", tool: "read_file", args: {} });
      });

      await waitFor(() => expect(screen.getByText(/last activity/i)).toBeInTheDocument());
    });
  });

  describe("completion notification gating", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not fire a system Notification for the session currently being viewed (shares the title-badge's unseen gate)", async () => {
      const realNotification = (globalThis as any).Notification;
      const ctorSpy = vi.fn();
      (globalThis as any).Notification = Object.assign(ctorSpy, { permission: "granted" });

      const runningSession = {
        id: "s1", task: "Fix dialog parser", status: "implementing", workspace: "/ws", branch: "glimmer/x",
        baselineSha: "abc", changedFiles: [], verification: { overall: "NOT_RUN", checks: [] }, repairsUsed: 0, repairBudget: 2,
      };
      const doneSession = { ...runningSession, status: "verified", verification: { overall: "VERIFIED", checks: [] } };

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const listSpy = vi.spyOn(client.glimmerApi, "listSessions")
        .mockResolvedValueOnce([runningSession] as any)
        .mockResolvedValue([doneSession] as any);
      vi.spyOn(client.glimmerApi, "getModelStatus").mockResolvedValue({ status: "OFFLINE", endpoint: "x", provenance: "deterministic-backend" });
      vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue(runningSession as any);

      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={["/sessions/s1"]}>
            <AppShell repoContext={null}>session content</AppShell>
          </MemoryRouter>
        </QueryClientProvider>
      );

      // First poll sees it running; advancing to the next 5000ms poll (the
      // sessions query's refetchInterval) sees it terminal — s1 is both the
      // completing session and the one currently routed to.
      await vi.waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      await vi.waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));

      expect(ctorSpy).not.toHaveBeenCalled();

      if (realNotification === undefined) delete (globalThis as any).Notification;
      else (globalThis as any).Notification = realNotification;
    });
  });
});
