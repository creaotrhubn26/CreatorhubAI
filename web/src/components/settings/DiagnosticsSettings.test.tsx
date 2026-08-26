import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getDiagnostics: vi.fn(),
  repairInstallation: vi.fn(),
  downloadSupportBundle: vi.fn(),
}));

vi.mock("../../api/client", () => ({ glimmerApi: api }));

import { DiagnosticsSettings } from "./DiagnosticsSettings";

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DiagnosticsSettings />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.getDiagnostics.mockResolvedValue({
    health: {
      service: "glimmer-gateway",
      status: "ok",
      version: "0.2.3",
      timestamp: "now",
      uptimeSeconds: 2,
    },
    readiness: {
      status: "degraded",
      coreReady: true,
      checkedAt: "now",
      components: [
        {
          id: "gateway",
          label: "Local gateway",
          state: "ready",
          required: true,
          version: "0.2.3",
          source: "local",
          detail: "Responding.",
        },
        {
          id: "model",
          label: "Model server",
          state: "degraded",
          required: false,
          source: "configured",
          detail: "Offline.",
        },
      ],
    },
    cli: { integrations: [{ state: "ready" }, { state: "missing" }] },
    mcp: { integrations: [{ active: true }, { active: false }] },
  });
  api.repairInstallation.mockResolvedValue({
    repaired: false,
    reinstallRequired: false,
    actions: ["Writable application state was already healthy."],
    checks: [],
    checkedAt: "now",
  });
  api.downloadSupportBundle.mockResolvedValue("glimmer-support-2026-08-26.json");
});

describe("DiagnosticsSettings", () => {
  it("shows component, CLI and MCP status", async () => {
    renderSettings();
    expect(await screen.findByText("Glimmer 0.2.3")).toBeInTheDocument();
    expect(screen.getByText("1/2 CLI tools ready")).toBeInTheDocument();
    expect(screen.getByText("1/2 MCP integrations active")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Model server" })).toBeInTheDocument();
  });

  it("runs repair and exports a privacy-safe support package", async () => {
    renderSettings();
    await screen.findByText("Glimmer 0.2.3");
    fireEvent.click(screen.getByRole("button", { name: "Repair installation" }));
    expect(await screen.findByText("Installation is healthy")).toBeInTheDocument();
    expect(api.repairInstallation).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Export support package" }));
    await waitFor(() => expect(api.downloadSupportBundle).toHaveBeenCalledOnce());
    expect(
      await screen.findByText(/Credentials and task prompts were excluded/),
    ).toBeInTheDocument();
  });
});
