import { describe, expect, it, vi } from "vitest";
import request from "supertest";

const diagnostics = vi.hoisted(() => ({
  gatewayHealth: vi.fn(() => ({
    service: "glimmer-gateway",
    status: "ok",
    version: "0.2.3",
    timestamp: "now",
    uptimeSeconds: 1,
  })),
  probeRuntimeReadiness: vi.fn(async () => ({
    status: "unavailable",
    coreReady: false,
    checkedAt: "now",
    components: [],
  })),
  collectDiagnostics: vi.fn(async () => ({ health: {}, readiness: {}, cli: {}, mcp: {} })),
  repairInstallation: vi.fn(async () => ({
    checkedAt: "now",
    repaired: false,
    reinstallRequired: false,
    checks: [],
    actions: [],
  })),
  createSupportBundle: vi.fn(async () => ({
    privacy: { credentialsIncluded: false, taskPromptsIncluded: false },
  })),
}));

vi.mock("../lib/diagnostics.js", () => diagnostics);

import { createApp } from "../app.js";

describe("diagnostics routes", () => {
  it("exposes a cheap, identifiable gateway health contract", async () => {
    const response = await request(createApp()).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ service: "glimmer-gateway", status: "ok" });
    expect(response.body.timestamp).toEqual(expect.any(String));
    expect(response.body.uptimeSeconds).toEqual(expect.any(Number));
  });

  it("keeps the loopback host guard in front of diagnostics", async () => {
    const response = await request(createApp()).get("/api/health").set("Host", "example.test");
    expect(response.status).toBe(403);
  });

  it("returns 503 with the readiness body when a required runtime is unavailable", async () => {
    const response = await request(createApp()).get("/api/ready");
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ coreReady: false, status: "unavailable" });
  });

  it("protects repair with the state-changing origin guard", async () => {
    const rejected = await request(createApp()).post("/api/diagnostics/repair");
    expect(rejected.status).toBe(403);

    const accepted = await request(createApp())
      .post("/api/diagnostics/repair")
      .set("Origin", "tauri://localhost");
    expect(accepted.status).toBe(200);
    expect(diagnostics.repairInstallation).toHaveBeenCalled();
  });

  it("exports support data as an attachment with an explicit privacy contract", async () => {
    const response = await request(createApp())
      .post("/api/diagnostics/support-bundle")
      .set("Origin", "tauri://localhost");
    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toMatch(/^attachment; filename=/);
    expect(response.headers["access-control-expose-headers"]).toContain("Content-Disposition");
    expect(response.body.privacy.credentialsIncluded).toBe(false);
  });
});
