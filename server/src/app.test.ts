import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";

// The gateway-wide CSRF / DNS-rebinding guard (app.ts localOnlyGuard). These
// are the security properties every write route on this API depends on, so
// they are tested against the real app, not the middleware in isolation.
let app: Express;
let stateRoot: string;
const CAPABILITY = "test-app-instance-capability";

beforeAll(async () => {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-app-guard-root-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;
  process.env.GLIMMER_MODEL_URL = "http://127.0.0.1:1"; // nothing listens here
  process.env.GLIMMER_CAPABILITY_TOKEN = CAPABILITY;
  process.env.GLIMMER_UI_ORIGIN = "http://127.0.0.1:5199";
  const { createApp } = await import("./app.js");
  app = createApp();
});

afterAll(async () => {
  delete process.env.GLIMMER_CAPABILITY_TOKEN;
  delete process.env.GLIMMER_UI_ORIGIN;
  await fs.rm(stateRoot, { recursive: true, force: true });
});

describe("localOnlyGuard", () => {
  it("lets a write from the packaged Tauri webview's real origin through", async () => {
    // Captured from the notarized bundle in /Applications, not assumed.
    const res = await request(app)
      .post("/api/model/stop")
      .set("Origin", "tauri://localhost")
      .set("X-Glimmer-Capability", CAPABILITY);
    expect(res.status).not.toBe(403);
  });

  it("lets a write from the dev web origin through", async () => {
    const res = await request(app)
      .post("/api/model/stop")
      .set("Origin", "http://127.0.0.1:5183")
      .set("X-Glimmer-Capability", CAPABILITY);
    expect(res.status).not.toBe(403);
  });

  it("requires the per-launch capability even for an allowed origin", async () => {
    const missing = await request(app).post("/api/model/stop").set("Origin", "tauri://localhost");
    expect(missing.status).toBe(403);
    expect(missing.body.error).toContain("app instance");

    const wrong = await request(app)
      .post("/api/model/stop")
      .set("Origin", "tauri://localhost")
      .set("X-Glimmer-Capability", "wrong");
    expect(wrong.status).toBe(403);
  });

  it("accepts one explicitly configured loopback UI origin", async () => {
    const res = await request(app)
      .post("/api/model/stop")
      .set("Origin", "http://127.0.0.1:5199")
      .set("X-Glimmer-Capability", CAPABILITY);
    expect(res.status).not.toBe(403);
  });

  it("rejects a write from a foreign origin — the C1 reproduction (simple request, no preflight)", async () => {
    const res = await request(app)
      .post("/api/model/start")
      .set("Origin", "https://evil.example")
      .set("Content-Type", "text/plain")
      .send("x");
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("evil.example");
  });

  it("rejects a write with no Origin at all", async () => {
    const res = await request(app).post("/api/model/start");
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Origin");
  });

  it("rejects any request whose Host is not loopback (DNS rebinding)", async () => {
    const res = await request(app).get("/api/status").set("Host", "glimmer.attacker.example");
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Host");
  });

  it("accepts loopback Host spellings, including bracketed IPv6 with a port", async () => {
    for (const host of ["127.0.0.1:4317", "localhost:4317", "[::1]:4317"]) {
      const res = await request(app).get("/api/status").set("Host", host);
      expect(res.status).toBe(200);
    }
  });

  it("leaves safe methods alone — a GET needs no Origin", async () => {
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
  });

  it("guards every write route, not just the model ones", async () => {
    for (const route of ["/api/sessions", "/api/workspaces", "/api/sessions/some-id/accept"]) {
      const res = await request(app).post(route).set("Origin", "https://evil.example");
      expect(res.status).toBe(403);
    }
  });
});
