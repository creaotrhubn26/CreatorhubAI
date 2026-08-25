import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CliIntegrationsStatus } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { CliIntegrationsSettings } from "./CliIntegrationsSettings";

const status: CliIntegrationsStatus = {
  checkedAt: "2026-08-25T12:00:00.000Z",
  platform: "darwin arm64",
  integrations: [
    {
      id: "node", name: "Node.js runtime", executable: "node", required: true,
      state: "ready", installed: true, version: "v22.12.0", path: "/app/glimmer-node",
      source: "bundled", agentAccess: "runtime", detail: "Bundled with Glimmer.",
    },
    {
      id: "github_cli", name: "GitHub CLI", executable: "gh", required: false,
      state: "authentication_required", installed: true, authenticated: false, version: "gh 2.80.0",
      path: "/opt/homebrew/bin/gh", source: "path", agentAccess: "read_only",
      detail: "GitHub credentials are invalid or expired.",
      authCommand: "gh auth login -h github.com -p https -w",
    },
    {
      id: "python", name: "Python", executable: "python3", required: true,
      state: "missing", installed: false, source: "path", agentAccess: "validation_only",
      detail: "Python was not found.", installCommand: "brew install python",
    },
  ],
  policy: { automaticSystemInstall: false, externalWritesRequireApproval: true, gitPushAllowed: false },
};

afterEach(() => vi.restoreAllMocks());

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CliIntegrationsSettings />
    </QueryClientProvider>,
  );
}

describe("CliIntegrationsSettings", () => {
  it("shows honest tool, auth and policy states without exposing credentials", async () => {
    vi.spyOn(glimmerApi, "getCliIntegrations").mockResolvedValue(status);
    renderSettings();

    expect(await screen.findByRole("heading", { name: "CLI & Integrations" })).toBeInTheDocument();
    expect(await screen.findByText("darwin arm64")).toBeInTheDocument();
    expect(screen.getByText("1 missing")).toBeInTheDocument();
    expect(screen.getByText("Sign-in required")).toBeInTheDocument();
    expect(screen.getByText("brew install python")).toBeInTheDocument();
    expect(screen.getByText(/never installed or authenticated automatically/i)).toBeInTheDocument();
    expect(screen.queryByText(/token|secret/i)).not.toBeInTheDocument();
  });

  it("copies a visible sign-in command and reruns checks on request", async () => {
    const getStatus = vi.spyOn(glimmerApi, "getCliIntegrations").mockResolvedValue(status);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderSettings();

    const copy = await screen.findByRole("button", { name: /Copy sign-in command:/i });
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("gh auth login -h github.com -p https -w"));
    expect(await screen.findByRole("button", { name: /Copy sign-in command:/i })).toHaveTextContent("Copied");

    fireEvent.click(screen.getByRole("button", { name: "Refresh checks" }));
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
  });
});
