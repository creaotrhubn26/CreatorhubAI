import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DiffReviewScreen } from "./DiffReviewScreen";
import * as client from "../../api/client";

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/sessions/s1/diff"]}>
        <Routes><Route path="/sessions/:id/diff" element={<DiffReviewScreen />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("DiffReviewScreen", () => {
  beforeEach(() => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "x", status: "verified", workspace: "/ws", branch: "glimmer/x", baselineSha: "abc",
      changedFiles: [{ path: "a.ts", status: "modified" }],
      verification: { overall: "VERIFIED", checks: [] }, repairsUsed: 0, repairBudget: 2,
    } as any);
    vi.spyOn(client.glimmerApi, "getSessionDiff").mockResolvedValue({ diff: "--- a\n+++ b\n", hunks: [] });
  });

  it("renders a Revert button per changed file that calls revertFile with the real path", async () => {
    const revertSpy = vi.spyOn(client.glimmerApi, "revertFile").mockResolvedValue({ reverted: "a.ts" });
    renderScreen();
    await waitFor(() => screen.getByRole("button", { name: /revert/i }));
    fireEvent.click(screen.getByRole("button", { name: /revert/i }));
    await waitFor(() => expect(revertSpy).toHaveBeenCalledWith("s1", "a.ts"));
  });

  it("shows an error message when revert fails, without crashing", async () => {
    vi.spyOn(client.glimmerApi, "revertFile").mockRejectedValue(new Error("boom"));
    renderScreen();
    await waitFor(() => screen.getByRole("button", { name: /revert/i }));
    fireEvent.click(screen.getByRole("button", { name: /revert/i }));
    await waitFor(() => expect(screen.getByText(/unavailable/i)).toBeInTheDocument());
  });

  it("invalidates session-analysis on a successful revert, so a stale risk/scope score isn't left behind", async () => {
    vi.spyOn(client.glimmerApi, "revertFile").mockResolvedValue({ reverted: "a.ts" });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/sessions/s1/diff"]}>
          <Routes><Route path="/sessions/:id/diff" element={<DiffReviewScreen />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => screen.getByRole("button", { name: /revert/i }));
    fireEvent.click(screen.getByRole("button", { name: /revert/i }));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["session-analysis", "s1"] })
    );
  });

  // §14 Diff Review: human acceptance must be distinct from technical
  // verification — both facts render, and only a real click sets acceptance.
  it("shows technical verification and human review as two separate facts, with acceptance not yet accepted", async () => {
    renderScreen();
    await waitFor(() => screen.getByText(/technical: verified/i));
    expect(screen.getByText(/human review: not yet accepted/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /accept for review/i })).toBeInTheDocument();
  });

  it("clicking Accept for review calls acceptSession with the session id", async () => {
    const acceptSpy = vi.spyOn(client.glimmerApi, "acceptSession").mockResolvedValue({
      accepted: true, acceptedAt: "2026-08-21T00:00:00.000Z",
    });
    renderScreen();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /accept for review/i })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /accept for review/i }));
    await waitFor(() => expect(acceptSpy).toHaveBeenCalledWith("s1"));
  });

  it("shows the accepted timestamp and hides the button once the session is human-accepted", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "x", status: "verified", workspace: "/ws", branch: "glimmer/x", baselineSha: "abc",
      changedFiles: [{ path: "a.ts", status: "modified" }],
      verification: { overall: "VERIFIED", checks: [] }, repairsUsed: 0, repairBudget: 2,
      humanAcceptance: { accepted: true, acceptedAt: "2026-08-21T00:00:00.000Z" },
    } as any);
    renderScreen();
    await waitFor(() => screen.getByText(/human review: accepted/i));
    expect(screen.queryByRole("button", { name: /accept for review/i })).not.toBeInTheDocument();
  });

  it("shows an error message when accept fails, without faking success", async () => {
    vi.spyOn(client.glimmerApi, "acceptSession").mockRejectedValue(new Error("boom"));
    renderScreen();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /accept for review/i })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /accept for review/i }));
    await waitFor(() => expect(screen.getByText(/could not accept/i)).toBeInTheDocument());
    expect(screen.getByText(/human review: not yet accepted/i)).toBeInTheDocument();
  });

  it("keeps the real session id on a diff-header file link for live viewer refresh", async () => {
    vi.spyOn(client.glimmerApi, "getSessionDiff").mockResolvedValue({
      diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      hunks: [],
    });
    renderScreen();
    const link = await screen.findByRole("link", { name: "a.ts" });
    expect(link).toHaveAttribute("href", "/files?path=%2Fws%2Fa.ts&line=1&session=s1");
  });

  // §14 side-by-side: a mode toggle switches between the unified diff and a
  // two-column split view, built from the same parsed diff.
  it("toggles between Unified and Split diff modes, rendering both without throwing", async () => {
    vi.spyOn(client.glimmerApi, "getSessionDiff").mockResolvedValue({
      diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context line\n",
      hunks: [],
    });
    const { container } = renderScreen();
    await waitFor(() => expect(container.querySelector(".diff-view")).toBeInTheDocument());
    expect(container.querySelector(".diff-view--split")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(container.querySelector(".diff-view--split")).toBeInTheDocument();
    expect(container.querySelector(".diff-view__split-row")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Unified" }));
    expect(container.querySelector(".diff-view--split")).not.toBeInTheDocument();
  });

  it("requires a decision for every text hunk and posts accept by server id", async () => {
    const hunkId = "a".repeat(64);
    vi.spyOn(client.glimmerApi, "getSessionDiff").mockResolvedValue({
      diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      hunks: [{
        id: hunkId, path: "a.ts", header: "@@ -1 +1 @@", added: 1, removed: 1, status: "pending",
      }],
    });
    const acceptHunk = vi.spyOn(client.glimmerApi, "acceptHunk").mockResolvedValue({
      hunkId, path: "a.ts", decision: "accepted", decidedAt: "2026-08-25T00:00:00Z",
    });
    renderScreen();

    const acceptAll = await screen.findByRole("button", { name: "Accept for review" });
    expect(await screen.findByRole("status")).toHaveTextContent("1 pending");
    expect(acceptAll).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /accept hunk in a\.ts/i }));
    await waitFor(() => expect(acceptHunk).toHaveBeenCalledWith("s1", hunkId, "a.ts"));
  });

  it("renders persisted hunk acceptance and enables complete-diff acceptance", async () => {
    vi.spyOn(client.glimmerApi, "getSessionDiff").mockResolvedValue({
      diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      hunks: [{
        id: "b".repeat(64), path: "a.ts", header: "@@ -1 +1 @@", added: 1, removed: 1,
        status: "accepted", acceptedAt: "2026-08-25T00:00:00Z",
      }],
    });
    renderScreen();

    expect(await screen.findByText("Accepted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /accept hunk in a\.ts/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Accept for review" })).toBeEnabled();
  });

  it("rejects one hunk by id and invalidates stale session analysis", async () => {
    const hunkId = "c".repeat(64);
    vi.spyOn(client.glimmerApi, "getSessionDiff").mockResolvedValue({
      diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      hunks: [{ id: hunkId, path: "a.ts", header: "@@ -1 +1 @@", added: 1, removed: 1, status: "pending" }],
    });
    const rejectHunk = vi.spyOn(client.glimmerApi, "rejectHunk").mockResolvedValue({
      hunkId, path: "a.ts", decision: "rejected", decidedAt: "2026-08-25T00:00:00Z",
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/sessions/s1/diff"]}>
          <Routes><Route path="/sessions/:id/diff" element={<DiffReviewScreen />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: /reject hunk in a\.ts/i }));
    await waitFor(() => expect(rejectHunk).toHaveBeenCalledWith("s1", hunkId, "a.ts"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["session-analysis", "s1"] });
  });
});
