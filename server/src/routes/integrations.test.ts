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

vi.mock("../lib/developerClients.js", () => ({
  DeveloperClientOpenError: class DeveloperClientOpenError extends Error {},
  isWorkspaceHandoffClientId: (value: unknown) =>
    value === "cursor" || value === "vscode" || value === "warp",
  openDeveloperClientWorkspace: vi.fn(),
  probeDeveloperClients: vi.fn().mockResolvedValue({
    checkedAt: "2026-08-26T00:00:00.000Z",
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
        detail: "App installed.",
        mcp: {
          supported: true,
          setupMethod: "command_palette",
          setupHint: "Open user configuration.",
          docsUrl: "https://code.visualstudio.com/docs/agent-customization/mcp-servers",
        },
      },
    ],
    policy: {
      automaticInstall: false,
      automaticConfigWrites: false,
      credentialContentsInspected: false,
      agentNestingAllowed: false,
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

const mobbinStatus = {
  configured: true,
  keyPath: "/tmp/mobbin-api-key.txt",
  docsUrl: "https://docs.mobbin.com/api/quickstart",
  availability: "team-enterprise-api",
  policy: {
    credentialsReturnedByApi: false,
    fixedApiOrigin: "https://api.mobbin.com",
    imageUrlsAreRemoteAndExpiring: true,
    imagesProxiedThroughGateway: true,
  },
};

vi.mock("../lib/mobbin.js", () => ({
  MobbinIntegrationError: class MobbinIntegrationError extends Error {
    status = 400;
  },
  mobbinStatus: vi.fn().mockResolvedValue(mobbinStatus),
  saveMobbinApiKey: vi.fn().mockResolvedValue(undefined),
  readMobbinImage: vi.fn().mockResolvedValue({
    bytes: Buffer.from([137, 80, 78, 71]),
    contentType: "image/png",
  }),
  searchMobbin: vi.fn().mockResolvedValue({
    query: "checkout with Apple Pay",
    platform: "web",
    screens: [
      {
        id: "screen-1",
        imageToken: "00000000-0000-4000-8000-000000000001",
        appName: "Example",
        platform: "web",
      },
    ],
  }),
}));

const profile = {
  profile: "creatorhub-engineering",
  checkedAt: "now",
  desiredVersion: "0.3.1",
  canApply: true,
  targets: [],
  policy: {
    previewRequired: true,
    backupBeforeApply: true,
    credentialsInspected: false,
    arbitraryCommandsExecuted: false,
  },
};
vi.mock("../lib/integrationProfile.js", () => ({
  previewIntegrationProfile: vi.fn().mockResolvedValue(profile),
  applyIntegrationProfile: vi.fn().mockResolvedValue({
    backupId: "20260827T080000-1234abcd",
    appliedTargets: ["claude", "glimmer"],
    preview: { ...profile, canApply: false },
  }),
  rollbackIntegrationProfile: vi.fn().mockResolvedValue({
    backupId: "20260827T080000-1234abcd",
    rolledBack: true,
    preview: profile,
  }),
}));

const { createApp } = await import("../app.js");
const mcp = await import("../lib/mcpIntegrations.js");
const mobbin = await import("../lib/mobbin.js");
const integrationProfile = await import("../lib/integrationProfile.js");

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

describe("GET /api/integrations/developer-clients", () => {
  it("returns read-only client and MCP setup diagnostics", async () => {
    const response = await request(createApp()).get("/api/integrations/developer-clients");
    expect(response.status).toBe(200);
    expect(response.body.clients[0]).toMatchObject({
      id: "vscode",
      state: "app_only",
      installed: true,
      mcp: { supported: true, setupMethod: "command_palette" },
    });
    expect(response.body.policy).toMatchObject({
      automaticInstall: false,
      automaticConfigWrites: false,
      credentialContentsInspected: false,
      agentNestingAllowed: false,
    });
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

describe("Mobbin integration routes", () => {
  it("returns connection status without credential contents", async () => {
    const response = await request(createApp()).get("/api/integrations/mobbin");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ configured: true, availability: "team-enterprise-api" });
    expect(JSON.stringify(response.body)).not.toContain("actual-mobbin-secret");
  });

  it("stores a credential through the guarded route and never echoes it", async () => {
    const response = await request(createApp())
      .put("/api/integrations/mobbin/credential")
      .set("Origin", "http://localhost:5183")
      .send({ apiKey: "actual-mobbin-secret" });
    expect(response.status).toBe(200);
    expect(mobbin.saveMobbinApiKey).toHaveBeenCalledWith({ apiKey: "actual-mobbin-secret" });
    expect(JSON.stringify(response.body)).not.toContain("actual-mobbin-secret");
  });

  it("forwards only the bounded search contract", async () => {
    const search = { query: "checkout with Apple Pay", platform: "web", limit: 8 };
    const response = await request(createApp())
      .post("/api/integrations/mobbin/search")
      .set("Origin", "http://localhost:5183")
      .send(search);
    expect(response.status).toBe(200);
    expect(mobbin.searchMobbin).toHaveBeenCalledWith(search);
    expect(response.body.screens[0].id).toBe("screen-1");
  });

  it("serves an opaque Mobbin preview token through the local gateway", async () => {
    const token = "00000000-0000-4000-8000-000000000001";
    const response = await request(createApp()).get(`/api/integrations/mobbin/image/${token}`);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^image\/png/);
    expect(response.headers["cache-control"]).toBe("private, max-age=300");
    expect(mobbin.readMobbinImage).toHaveBeenCalledWith(token);
  });
});

describe("CreatorHub integration profile routes", () => {
  it("requires a preview version and applies only through the guarded write route", async () => {
    const preview = await request(createApp()).get("/api/integrations/profile");
    expect(preview.body.desiredVersion).toBe("0.3.1");

    const rejected = await request(createApp())
      .post("/api/integrations/profile/apply")
      .set("Origin", "http://localhost:5183")
      .send({});
    expect(rejected.status).toBe(400);

    const applied = await request(createApp())
      .post("/api/integrations/profile/apply")
      .set("Origin", "http://localhost:5183")
      .send({ expectedVersion: "0.3.1" });
    expect(applied.status).toBe(200);
    expect(integrationProfile.applyIntegrationProfile).toHaveBeenCalledWith("0.3.1");
  });
});
