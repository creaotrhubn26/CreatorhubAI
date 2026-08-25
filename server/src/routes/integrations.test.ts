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

const { createApp } = await import("../app.js");

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
