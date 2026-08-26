import { describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/cliIntegrations.js", () => ({
  probeCliIntegrations: vi.fn().mockResolvedValue({
    checkedAt: "2026-08-25T00:00:00.000Z",
    platform: "darwin arm64",
    integrations: [
      {
        id: "github_cli",
        name: "GitHub CLI",
        executable: "gh",
        required: false,
        state: "ready",
        installed: true,
        authenticated: true,
        source: "path",
        agentAccess: "read_only",
        detail: "Authenticated.",
      },
    ],
    policy: {
      automaticSystemInstall: false,
      externalWritesRequireApproval: true,
      gitPushAllowed: false,
    },
  }),
}));

const mcpStatus = {
  checkedAt: "2026-08-26T00:00:00.000Z",
  configPath: "/tmp/mcp-servers.json",
  configExists: true,
  restartRequired: true,
  customServerCount: 0,
  runtime: { reachable: true, totalToolCount: 8, mcpToolCount: 0 },
  integrations: [
    {
      id: "context7",
      name: "Context7",
      description: "Documentation",
      version: "4.0.3",
      adoption: "very_high",
      recommended: true,
      configured: true,
      active: false,
      state: "configured_restart_required",
      agentAccess: "read_only",
      detail: "Restart required.",
      toolCount: 0,
    },
  ],
  policy: {
    arbitraryServerCommandsFromUi: false,
    credentialsReturnedByApi: false,
    unclassifiedToolsRequireApproval: true,
  },
};

vi.mock("../lib/mcpIntegrations.js", () => ({
  McpConfigValidationError: class McpConfigValidationError extends Error {},
  probeMcpIntegrations: vi.fn().mockResolvedValue(mcpStatus),
  saveCuratedMcpConfig: vi.fn().mockResolvedValue(undefined),
}));

const { createApp } = await import("../app.js");
const mcp = await import("../lib/mcpIntegrations.js");

describe("GET /api/integrations/cli", () => {
  it("returns read-only typed integration diagnostics", async () => {
    const response = await request(createApp()).get("/api/integrations/cli");
    expect(response.status).toBe(200);
    expect(response.body.integrations[0]).toMatchObject({
      id: "github_cli",
      state: "ready",
      authenticated: true,
      agentAccess: "read_only",
    });
    expect(response.body.policy.automaticSystemInstall).toBe(false);
  });
});

describe("MCP integration routes", () => {
  it("returns secret-free runtime and curated configuration diagnostics", async () => {
    const response = await request(createApp()).get("/api/integrations/mcp");
    expect(response.status).toBe(200);
    expect(response.body.runtime).toEqual({ reachable: true, totalToolCount: 8, mcpToolCount: 0 });
    expect(response.body.integrations[0]).toMatchObject({
      id: "context7",
      configured: true,
      state: "configured_restart_required",
    });
    expect(JSON.stringify(response.body)).not.toMatch(/token|secret/i);
  });

  it("accepts only the typed curated update through the guarded write route", async () => {
    const response = await request(createApp())
      .put("/api/integrations/mcp")
      .set("Origin", "http://localhost:5183")
      .send({ enabled: ["context7"] });
    expect(response.status).toBe(200);
    expect(mcp.saveCuratedMcpConfig).toHaveBeenCalledWith({ enabled: ["context7"] });
  });

  it("returns a bounded client error for an unsupported MCP update", async () => {
    vi.mocked(mcp.saveCuratedMcpConfig).mockRejectedValueOnce(
      new mcp.McpConfigValidationError("only the enabled field is accepted"),
    );
    const response = await request(createApp())
      .put("/api/integrations/mcp")
      .set("Origin", "http://localhost:5183")
      .send({ enabled: ["context7"], command: "arbitrary" });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "only the enabled field is accepted" });
  });
});
