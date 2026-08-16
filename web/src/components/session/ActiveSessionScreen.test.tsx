import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ActiveSessionScreen } from "./ActiveSessionScreen";
import * as client from "../../api/client";
import * as sseHook from "../../api/useSessionEvents";

describe("ActiveSessionScreen", () => {
  it("shows the session's changed-file count and derived state", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({
      id: "s1", task: "Fix dialog parser", status: "verifying", workspace: "/ws", branch: "glimmer/x",
      baselineSha: "abc", changedFiles: [{ path: "a.ts", status: "modified" }],
      verification: { overall: "PARTIAL", checks: [] }, repairsUsed: 0, repairBudget: 2,
    } as any);
    vi.spyOn(sseHook, "useSessionEvents").mockReturnValue([]);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/sessions/s1"]}>
          <Routes><Route path="/sessions/:id" element={<ActiveSessionScreen />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByText(/Changed files/)).toBeInTheDocument());
    expect(screen.getByText("1")).toBeInTheDocument();
  });
});
