import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DeveloperClientsStatus } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { DeveloperClientsSettings } from "./DeveloperClientsSettings";

const status: DeveloperClientsStatus = {
  checkedAt: "2026-08-26T12:00:00.000Z",
  platform: "darwin arm64",
  clients: [
    {
      id: "vscode",
      name: "Visual Studio Code",
      kind: "editor",
      state: "app_only",
      installed: true,
      workspaceHandoff: true,
      appPath: "/Applications/Visual Studio Code.app",
      executable: "code",
      detail: "The app is installed but its shell command is missing.",
      mcp: {
        supported: true,
        setupMethod: "command_palette",
        setupHint: "Run MCP: Open User Configuration.",
        configPath: "/Users/test/Library/Application Support/Code/User/mcp.json",
        configPresent: false,
        docsUrl: "https://code.visualstudio.com/docs/agent-customization/mcp-servers",
      },
    },
    {
      id: "cursor",
      name: "Cursor",
      kind: "editor",
      state: "missing",
      installed: false,
      workspaceHandoff: false,
      executable: "cursor",
      detail: "Cursor was not found.",
      installCommand: "brew install --cask cursor",
      mcp: {
        supported: true,
        setupMethod: "file",
        setupHint: "Use mcp.json.",
        configPath: "/Users/test/.cursor/mcp.json",
        configPresent: false,
        docsUrl: "https://cursor.com/docs/context/model-context-protocol",
      },
    },
    {
      id: "codex",
      name: "Codex",
      kind: "agent",
      state: "ready",
      installed: true,
      workspaceHandoff: false,
      executable: "codex",
      executablePath: "/usr/local/bin/codex",
      version: "codex-cli 1.0.0",
      detail: "Available for manual use.",
      mcp: {
        supported: true,
        setupMethod: "cli",
        setupHint: "Shared configuration.",
        configPath: "/Users/test/.codex/config.toml",
        configPresent: true,
        inspectCommand: "codex mcp list",
        docsUrl: "https://learn.chatgpt.com/docs/extend/mcp",
      },
    },
  ],
  policy: {
    automaticInstall: false,
    automaticConfigWrites: false,
    credentialContentsInspected: false,
    agentNestingAllowed: false,
  },
};

afterEach(() => vi.restoreAllMocks());

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DeveloperClientsSettings />
    </QueryClientProvider>,
  );
}

describe("DeveloperClientsSettings", () => {
  it("shows installed, app-only and missing clients with MCP guidance", async () => {
    vi.spyOn(glimmerApi, "getDeveloperClients").mockResolvedValue(status);
    renderSettings();

    expect(await screen.findByRole("heading", { name: "Developer clients" })).toBeInTheDocument();
    expect(await screen.findByText("2 installed")).toBeInTheDocument();
    expect(screen.getByText("1 missing")).toBeInTheDocument();
    expect(screen.getByText("App only")).toBeInTheDocument();
    expect(screen.getByText(/does not install clients/i)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Official MCP guide" })).toHaveLength(3);
    expect(screen.getAllByText(/No client config yet.*mcp\.json/)).toHaveLength(2);
  });

  it("copies fixed install and MCP inspection commands", async () => {
    vi.spyOn(glimmerApi, "getDeveloperClients").mockResolvedValue(status);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderSettings();

    fireEvent.click(await screen.findByRole("button", { name: /Copy install command:/i }));
    fireEvent.click(screen.getByRole("button", { name: /Copy MCP check:/i }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("brew install --cask cursor");
      expect(writeText).toHaveBeenCalledWith("codex mcp list");
    });
  });
});
