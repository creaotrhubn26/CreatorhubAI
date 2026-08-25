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

const realIds = [
  "20260814-235852-glimmer-oldest",
  "20260815-120000-glimmer-middle",
  "20260816-090000-glimmer-newest",
] as const;

beforeAll(async () => {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-status-root-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;
  process.env.GLIMMER_MODEL_URL = "http://127.0.0.1:1"; // nothing listens here

  // Reproduce the real on-disk state: stale `pending-<uuid>` dirs left behind
  // when a past gateway process died before its in-memory alias resolved.
  // They have no manifest.json (readSession -> null) but DO sort ahead of
  // `<timestamp>-...` real session ids in listSessionIds()'s reverse-lexical
  // sort, because "p" > any digit. 12 of them is enough to fill (and used to
  // poison) a slice(0, 10) taken before filtering.
  for (let i = 0; i < 12; i++) {
    const dir = path.join(stateRoot, "sessions", `pending-${String(i).padStart(4, "0")}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "gateway-contract.json"),
      JSON.stringify({ task: "pending" }),
    );
  }

  for (const id of realIds) {
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        task: `task ${id}`,
        status: "verified",
        workspace: "/ws",
        branch: "glimmer/x",
        attempts: [],
        updatedAt: "2026-08-16T12:00:00Z",
      }),
    );
  }

  const { createApp } = await import("../app.js");
  app = createApp();
});

afterAll(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true });
});

describe("GET /api/status with stale pending-* dirs on disk", () => {
  it("does not let pending dirs poison recentSessions/latestSession", async () => {
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.recentSessions).toHaveLength(realIds.length);
    expect(res.body.recentSessions.map((s: { id: string }) => s.id).sort()).toEqual(
      [...realIds].sort(),
    );
    expect(res.body.latestSession).not.toBeNull();
    expect(res.body.latestSession.id).toBe("20260816-090000-glimmer-newest");
  });
});
