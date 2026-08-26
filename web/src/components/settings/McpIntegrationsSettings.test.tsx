import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { McpIntegrationsStatus } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { McpIntegrationsSettings } from "./McpIntegrationsSettings";

const status: McpIntegrationsStatus = {
  checkedAt: "2026-08-26T00:00:00.000Z",
  configPath: "/Users/test/AI/muse-glimmer/config/mcp-servers.json",
  configExists: false,
  restartRequired: false,
  customServerCount: 0,
  runtime: { reachable: true, totalToolCount: 8, mcpToolCount: 0 },
  integrations: [
    {
      id: "context7",
      name: "Context7",
      description: "Current documentation.",
      version: "4.0.3",
      adoption: "very_high",
      recommended: true,
      configured: false,
      active: false,
      state: "available",
      agentAccess: "read_only",
      detail: "Available to enable.",
      toolCount: 0,
    },
    {
      id: "playwright",
      name: "Playwright MCP",
      description: "Browser automation.",
      version: "0.0.79",
      adoption: "very_high",
      recommended: true,
      configured: false,
      active: false,
      state: "available",
      agentAccess: "approval_required",
      detail: "Available to enable.",
      toolCount: 0,
    },
    {
      id: "github",
      name: "GitHub MCP",
      description: "GitHub context.",
      version: "1.11.0",
      adoption: "high",
      recommended: true,
      configured: false,
      active: false,
      state: "missing_requirement",
      agentAccess: "read_only",
      detail: "Docker is installed but not running.",
      requirement: "Docker is installed but not running.",
      toolCount: 0,
    },
  ],
  policy: {
    arbitraryServerCommandsFromUi: false,
    credentialsReturnedByApi: false,
    unclassifiedToolsRequireApproval: true,
  },
};

afterEach(() => vi.restoreAllMocks());

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <McpIntegrationsSettings />
    </QueryClientProvider>,
  );
}

describe("McpIntegrationsSettings", () => {
  it("shows runtime, permission and requirement states honestly", async () => {
    vi.spyOn(glimmerApi, "getMcpIntegrations").mockResolvedValue(status);
    renderSettings();

    expect(await screen.findByText("0 active MCP tools")).toBeInTheDocument();
    expect(screen.getByText("Approval required")).toBeInTheDocument();
    expect(screen.getAllByText("Docker is installed but not running.").length).toBeGreaterThan(0);
    const buttons = screen.getAllByRole("button", { name: "Enable" });
    expect(buttons[0]).toBeEnabled();
    expect(buttons[2]).toBeDisabled();
  });

  it("submits only curated ids when enabling a server", async () => {
    vi.spyOn(glimmerApi, "getMcpIntegrations").mockResolvedValue(status);
    const save = vi.spyOn(glimmerApi, "saveMcpIntegrations").mockResolvedValue({
      ...status,
      restartRequired: true,
      configExists: true,
      integrations: status.integrations.map((integration) =>
        integration.id === "context7"
          ? { ...integration, configured: true, state: "configured_restart_required" as const }
          : integration,
      ),
    });
    renderSettings();

    const buttons = await screen.findAllByRole("button", { name: "Enable" });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(save.mock.calls[0]?.[0]).toEqual({ enabled: ["context7"] }));
    expect(await screen.findByText("Model restart required")).toBeInTheDocument();
  });
});
