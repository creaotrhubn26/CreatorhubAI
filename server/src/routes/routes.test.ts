import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";

// Isolate from the real ~/.muse-glimmer state and from a possibly-running
// llama-server: point GLIMMER_STATE_ROOT / GLIMMER_MODEL_URL at throwaway
// values before importing anything that reads config at module-load time.
let app: Express;
let stateRoot: string;

const blockedId = "20260816-120000-glimmer-blocked";
const verifiedId = "20260815-120000-glimmer-verified";

beforeAll(async () => {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-routes-root-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;
  process.env.GLIMMER_MODEL_URL = "http://127.0.0.1:1"; // nothing listens here

  for (const [id, status] of [[blockedId, "blocked-timeout"], [verifiedId, "verified"]] as const) {
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ task: `task ${status}`, status, workspace: "/ws", branch: "glimmer/x", attempts: [], updatedAt: "2026-08-16T12:00:00Z" })
    );
  }

  const { createApp } = await import("../app.js");
  app = createApp();
});

afterAll(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true });
});

describe("GET /api/status", () => {
  it("returns a DashboardStatus-shaped payload with a model field", async () => {
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(["ONLINE", "REACHABLE_AUTH", "OFFLINE", "UNKNOWN"]).toContain(res.body.model.status);
    expect(Array.isArray(res.body.recentSessions)).toBe(true);
  });

  it("never presents a finished blocked session as the live active session", async () => {
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.recentSessions.map((s: { id: string }) => s.id)).toContain(blockedId);
    expect(res.body.activeSession).toBeNull();
  });
});
