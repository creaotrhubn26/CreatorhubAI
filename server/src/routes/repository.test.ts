import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";

// Isolate this file's sessionsDir from the real ~/.muse-glimmer state by
// pointing GLIMMER_STATE_ROOT at a throwaway temp dir before importing
// anything that reads config at module-load time.
let app: Express;
let stateRoot: string;
const sessionId = "repo-map-error-session";

beforeAll(async () => {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-state-root-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;

  const { createApp } = await import("../app.js");
  app = createApp();

  const sessionPath = path.join(stateRoot, "sessions", sessionId);
  await fs.mkdir(sessionPath, { recursive: true });
  // A directory named repo-map.json, not a file — fs.readFile on it fails
  // with EISDIR (not ENOENT), which must not propagate as an unhandled
  // rejection / crash the process.
  await fs.mkdir(path.join(sessionPath, "repo-map.json"));
});

afterAll(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true });
});

describe("GET /api/repository/map", () => {
  it("returns a clean 500 instead of crashing when repo-map.json can't be read", async () => {
    const res = await request(app).get("/api/repository/map");
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});
