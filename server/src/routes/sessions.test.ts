import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Isolate this file's sessionsDir from the real ~/.muse-glimmer state by
// pointing GLIMMER_STATE_ROOT at a throwaway temp dir before importing
// anything that reads config at module-load time.
let app: Express;
let workspace: string;
let stateRoot: string;
const sessionId = "diff-error-session";

beforeAll(async () => {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-state-root-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;
  // Point the "real orchestrator" path at the fake fixture so run/replay tests
  // never spawn python3 or the actual glimmer-v2.py.
  process.env.GLIMMER_V2_PATH = path.join(__dirname, "..", "lib", "__fixtures__", "fake-glimmer-v2.mjs");

  const { createApp } = await import("../app");
  app = createApp();

  // A workspace directory that exists but is not a git repo — `git diff`
  // inside it fails, which is what we want gitDiff to reject with.
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-non-git-"));

  const sessionPath = path.join(stateRoot, "sessions", sessionId);
  await fs.mkdir(sessionPath, { recursive: true });
  await fs.writeFile(
    path.join(sessionPath, "manifest.json"),
    JSON.stringify({
      task: "test",
      status: "initialized",
      workspace,
      branch: "main",
      baseline: null,
      attempts: [],
    })
  );
});

afterAll(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("GET /api/sessions/:id/diff", () => {
  it("returns a clean error response instead of crashing when gitDiff fails", async () => {
    const res = await request(app).get(`/api/sessions/${sessionId}/diff`);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});

describe("GET /api/sessions/:id/events", () => {
  it("returns a clean 500 instead of crashing when the session id resolves to a non-directory", async () => {
    // isValidSessionId only checks the id's character shape / path resolution,
    // not that the entry is actually a directory — a plain file at that path
    // makes path.join(..., id, "engineer-00.log") + fs.readFile fail with
    // ENOTDIR, which must not propagate as an unhandled rejection.
    const fileId = "not-a-directory";
    await fs.writeFile(path.join(stateRoot, "sessions", fileId), "not a session dir");

    const res = await request(app).get(`/api/sessions/${fileId}/events`);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});

describe("POST /api/sessions/:id/revert-file", () => {
  it("returns 404 for a path-traversal session id instead of touching the filesystem", async () => {
    const res = await request(app)
      .post("/api/sessions/..%2F..%2Fevil/revert-file")
      .send({ path: "a.txt" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions", () => {
  it("rejects a taskContract missing verification/repairBudget instead of accepting it", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .send({ taskContract: { objective: "x" }, workspace: "/tmp/ws" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("accepts a well-formed taskContract", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .send({
        taskContract: {
          objective: "Fix a thing",
          scope: { package: "frontend" },
          mode: "implement",
          constraints: { minimalChange: true, noCommit: true, noPush: true, noDeploy: true, noDependencyInstall: true },
          verification: [],
          repairBudget: 1,
        },
        workspace: "/tmp/ws",
      });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
  });
});

describe("POST /api/sessions/:id/run replay protection", () => {
  const validContract = {
    objective: "Fix a thing",
    scope: { package: "frontend" },
    mode: "implement",
    constraints: { minimalChange: true, noCommit: true, noPush: true, noDeploy: true, noDependencyInstall: true },
    verification: [],
    repairBudget: 1,
  };

  it("a second /run call for the same id does not spawn a second process", async () => {
    const createRes = await request(app)
      .post("/api/sessions")
      .send({ taskContract: validContract, workspace: "/tmp/ws" });
    const id = createRes.body.id as string;

    const firstRun = await request(app).post(`/api/sessions/${id}/run`);
    expect(firstRun.status).toBe(200);

    // Called immediately, before the fake fixture's process has necessarily
    // exited: activeRuns should still hold the first handle, so this must be
    // rejected rather than spawning a second child process.
    const secondRun = await request(app).post(`/api/sessions/${id}/run`);
    expect([404, 409]).toContain(secondRun.status);
  });
});
