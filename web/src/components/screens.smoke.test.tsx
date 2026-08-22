import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DiffReviewScreen } from "./diff/DiffReviewScreen";
import { VerificationCenterScreen } from "./verification/VerificationCenterScreen";
import { RepositoryMapScreen } from "./repository/RepositoryMapScreen";
import { SessionHistoryScreen } from "./history/SessionHistoryScreen";
import { ModelStatusScreen } from "./model/ModelStatusScreen";
import { SettingsScreen } from "./settings/SettingsScreen";
import { SystemExplorerScreen } from "./system-explorer/SystemExplorerScreen";
import * as client from "../api/client";

vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue({ changedFiles: [] } as any);
vi.spyOn(client.glimmerApi, "getSessionDiff").mockResolvedValue({ diff: "" });
vi.spyOn(client.glimmerApi, "getStatus").mockResolvedValue({ verification: null } as any);
vi.spyOn(client.glimmerApi, "getRepositoryMap").mockRejectedValue(new Error("404"));
vi.spyOn(client.glimmerApi, "getDocGraph").mockResolvedValue(null);
vi.spyOn(client.glimmerApi, "listSessions").mockResolvedValue([]);
vi.spyOn(client.glimmerApi, "getModelStatus").mockResolvedValue({ status: "OFFLINE", endpoint: "x", provenance: "deterministic-backend" });

function withProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/sessions/s1"]}>
        <Routes>
          <Route path="/sessions/:id" element={ui} />
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("read-only screens", () => {
  it("mount without throwing", () => {
    for (const Screen of [
      DiffReviewScreen, VerificationCenterScreen, RepositoryMapScreen, SessionHistoryScreen, ModelStatusScreen, SettingsScreen,
      SystemExplorerScreen,
    ]) {
      expect(() => render(withProviders(<Screen />))).not.toThrow();
    }
  });
});
