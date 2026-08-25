import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import type { Express } from "express";

// Writes require an allowed Origin (app.ts localOnlyGuard): a browser always
// sends one on a state-changing request, so the tests speak the same way.
const UI_ORIGIN = "http://127.0.0.1:5183";

const execGit = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Isolate this file's sessionsDir from the real ~/.muse-glimmer state by
// pointing GLIMMER_STATE_ROOT at a throwaway temp dir before importing
// anything that reads config at module-load time.
let app: Express;
let workspace: string;
let stateRoot: string;
let readSessionEventsBatch: typeof import("./sessions.js").readSessionEventsBatch;
// computeDiffHash comes from lib/git.js, which imports config.js -- like
// app.js/sessions.js above, this MUST be a dynamic import done after
// GLIMMER_STATE_ROOT is set below, never a static top-of-file import: a
// static import runs at module-parse time, before this beforeAll, which
// would warm config.js's module cache with the wrong (real ~/.muse-glimmer)
// state root and 404 every route in this entire file.
let computeDiffHash: typeof import("../lib/git.js").computeDiffHash;
const sessionId = "diff-error-session";

beforeAll(async () => {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-state-root-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;
  // Point the "real orchestrator" path at the fake fixture so run/replay tests
  // never spawn python3 or the actual glimmer-v2.py.
  process.env.GLIMMER_V2_PATH = path.join(__dirname, "..", "lib", "__fixtures__", "fake-glimmer-v2.mjs");

  const { createApp } = await import("../app.js");
  app = createApp();
  ({ readSessionEventsBatch } = await import("./sessions.js"));
  ({ computeDiffHash } = await import("../lib/git.js"));

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

describe("per-hunk diff review routes", () => {
  const id = "20260825-000001-glimmer-hunk-review";
  let hunkWorkspace: string;
  let baseline: string;

  beforeAll(async () => {
    hunkWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-route-hunks-"));
    await execGit("git", ["init", "-q"], { cwd: hunkWorkspace });
    await execGit("git", ["config", "user.email", "t@t.com"], { cwd: hunkWorkspace });
    await execGit("git", ["config", "user.name", "t"], { cwd: hunkWorkspace });
    await fs.writeFile(
      path.join(hunkWorkspace, "review.txt"),
      Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") + "\n",
    );
    await execGit("git", ["add", "review.txt"], { cwd: hunkWorkspace });
    await execGit("git", ["commit", "-q", "-m", "baseline"], { cwd: hunkWorkspace });
    baseline = (await execGit("git", ["rev-parse", "HEAD"], { cwd: hunkWorkspace })).stdout.trim();
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({
      task: "hunk review", status: "verified", workspace: hunkWorkspace, branch: "main",
      baseline, finalChangedFiles: ["review.txt"], attempts: [],
    }));
  });

  beforeEach(async () => {
    await execGit("git", ["checkout", baseline, "--", "review.txt"], { cwd: hunkWorkspace });
    const lines = (await fs.readFile(path.join(hunkWorkspace, "review.txt"), "utf8")).trimEnd().split("\n");
    lines[1] = "line 2 changed";
    lines[24] = "line 25 changed";
    await fs.writeFile(path.join(hunkWorkspace, "review.txt"), lines.join("\n") + "\n");
    await fs.rm(path.join(stateRoot, "sessions", id, "hunk-acceptances.json"), { force: true });
    await fs.rm(path.join(stateRoot, "sessions", id, "human-acceptance.json"), { force: true });
  });

  afterAll(async () => {
    await fs.rm(hunkWorkspace, { recursive: true, force: true });
  });

  it("returns server-derived hunk ids without exposing raw patch payloads", async () => {
    const res = await request(app).get(`/api/sessions/${id}/diff`);
    expect(res.status).toBe(200);
    expect(res.body.hunks).toHaveLength(2);
    expect(res.body.hunks[0]).toMatchObject({ path: "review.txt", status: "pending" });
    expect(res.body.hunks[0].id).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.hunks[0]).not.toHaveProperty("patch");
  });

  it("persists hunk acceptance and returns it on the next diff read", async () => {
    const initial = await request(app).get(`/api/sessions/${id}/diff`);
    const hunk = initial.body.hunks[0];
    const accepted = await request(app)
      .post(`/api/sessions/${id}/hunks/${hunk.id}/accept`).set("Origin", UI_ORIGIN)
      .send({ path: "review.txt" });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ hunkId: hunk.id, path: "review.txt", decision: "accepted" });

    const reread = await request(app).get(`/api/sessions/${id}/diff`);
    expect(reread.body.hunks[0].status).toBe("accepted");
    expect(typeof reread.body.hunks[0].acceptedAt).toBe("string");
  });

  it("rejects only the selected canonical hunk and ignores client patch text", async () => {
    const initial = await request(app).get(`/api/sessions/${id}/diff`);
    const hunk = initial.body.hunks[1];
    const rejected = await request(app)
      .post(`/api/sessions/${id}/hunks/${hunk.id}/reject`).set("Origin", UI_ORIGIN)
      .send({ path: "review.txt", patch: "malicious client patch is never consumed" });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ hunkId: hunk.id, path: "review.txt", decision: "rejected" });

    const content = await fs.readFile(path.join(hunkWorkspace, "review.txt"), "utf8");
    expect(content).toContain("line 2 changed");
    expect(content).not.toContain("line 25 changed");
    const reread = await request(app).get(`/api/sessions/${id}/diff`);
    expect(reread.body.hunks).toHaveLength(1);
  });

  it("returns 409 for a stale id and 403 for an unscoped path without changing the file", async () => {
    const before = await fs.readFile(path.join(hunkWorkspace, "review.txt"), "utf8");
    const stale = await request(app)
      .post(`/api/sessions/${id}/hunks/${"0".repeat(64)}/reject`).set("Origin", UI_ORIGIN)
      .send({ path: "review.txt" });
    expect(stale.status).toBe(409);
    const unscoped = await request(app)
      .post(`/api/sessions/${id}/hunks/${"0".repeat(64)}/reject`).set("Origin", UI_ORIGIN)
      .send({ path: "../outside.txt" });
    expect(unscoped.status).toBe(403);
    expect(await fs.readFile(path.join(hunkWorkspace, "review.txt"), "utf8")).toBe(before);
  });

  it("refuses whole-session acceptance until every current text hunk is accepted", async () => {
    const initial = await request(app).get(`/api/sessions/${id}/diff`);

    const premature = await request(app).post(`/api/sessions/${id}/accept`).set("Origin", UI_ORIGIN);
    expect(premature.status).toBe(409);
    expect(premature.body).toMatchObject({ pendingHunks: 2 });

    for (const hunk of initial.body.hunks) {
      const accepted = await request(app)
        .post(`/api/sessions/${id}/hunks/${hunk.id}/accept`).set("Origin", UI_ORIGIN)
        .send({ path: "review.txt" });
      expect(accepted.status).toBe(200);
    }

    const complete = await request(app).post(`/api/sessions/${id}/accept`).set("Origin", UI_ORIGIN);
    expect(complete.status).toBe(200);
    expect(complete.body.accepted).toBe(true);
  });

  it("clears whole-session acceptance after an accepted hunk is rejected", async () => {
    const initial = await request(app).get(`/api/sessions/${id}/diff`);
    for (const hunk of initial.body.hunks) {
      await request(app)
        .post(`/api/sessions/${id}/hunks/${hunk.id}/accept`).set("Origin", UI_ORIGIN)
        .send({ path: "review.txt" });
    }
    expect((await request(app).post(`/api/sessions/${id}/accept`).set("Origin", UI_ORIGIN)).status).toBe(200);

    const rejected = await request(app)
      .post(`/api/sessions/${id}/hunks/${initial.body.hunks[1].id}/reject`).set("Origin", UI_ORIGIN)
      .send({ path: "review.txt" });
    expect(rejected.status).toBe(200);

    const session = await request(app).get(`/api/sessions/${id}`);
    expect(session.body).not.toHaveProperty("humanAcceptance");
  });

  it("clears whole-session acceptance after a file-level revert", async () => {
    const initial = await request(app).get(`/api/sessions/${id}/diff`);
    for (const hunk of initial.body.hunks) {
      await request(app)
        .post(`/api/sessions/${id}/hunks/${hunk.id}/accept`).set("Origin", UI_ORIGIN)
        .send({ path: "review.txt" });
    }
    expect((await request(app).post(`/api/sessions/${id}/accept`).set("Origin", UI_ORIGIN)).status).toBe(200);

    const reverted = await request(app)
      .post(`/api/sessions/${id}/revert-file`).set("Origin", UI_ORIGIN)
      .send({ path: "review.txt" });
    expect(reverted.status).toBe(200);

    const session = await request(app).get(`/api/sessions/${id}`);
    expect(session.body).not.toHaveProperty("humanAcceptance");
  });
});

describe("GET /api/sessions/:id/events", () => {
  it("returns a clean 500 instead of crashing when the session id resolves to a non-directory", async () => {
    // isValidSessionId only checks the id's character shape / path resolution,
    // not that the entry is actually a directory — a plain file at that path
    // makes path.join(..., id, "events.jsonl") + fs.readFile fail with
    // ENOTDIR, which must not propagate as an unhandled rejection.
    const fileId = "not-a-directory";
    await fs.writeFile(path.join(stateRoot, "sessions", fileId), "not a session dir");

    const res = await request(app).get(`/api/sessions/${fileId}/events`);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});

describe("readSessionEventsBatch", () => {
  it("reads events.jsonl, validates each line with isGlimmerEvent, and silently skips a malformed line", async () => {
    const id = "20260817-000040-glimmer-events-jsonl-test";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        id: "evt_1", sessionId: id, timestamp: "2026-08-17T00:00:00.000Z",
        type: "tool_started", tool: "read_file", args: { path: "a.ts" },
      }),
      "not valid json at all {{{", // torn/malformed line — must be skipped, not crash the batch
      JSON.stringify({
        id: "evt_2", sessionId: id, timestamp: "2026-08-17T00:00:01.000Z",
        type: "tool_completed", tool: "read_file", resultSummary: "ok",
      }),
    ];
    await fs.writeFile(path.join(dir, "events.jsonl"), lines.join("\n") + "\n");

    const events = await readSessionEventsBatch(id);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ id: "evt_1", type: "tool_started" });
    expect(events[1]).toMatchObject({ id: "evt_2", type: "tool_completed" });
  });

  it("returns [] when events.jsonl does not exist yet", async () => {
    const id = "20260817-000041-glimmer-events-jsonl-missing";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    expect(await readSessionEventsBatch(id)).toEqual([]);
  });
});

describe("POST /api/sessions/:id/revert-file", () => {
  it("returns 404 for a path-traversal session id instead of touching the filesystem", async () => {
    const res = await request(app)
      .post("/api/sessions/..%2F..%2Fevil/revert-file").set("Origin", UI_ORIGIN)
      .send({ path: "a.txt" });
    expect(res.status).toBe(404);
  });
});

// §14 Diff Review — human "accept for review" action, distinct from
// technical verification. Server-side contract: gateway-owned sidecar,
// idempotent, 404 for an unknown session.
describe("POST /api/sessions/:id/accept", () => {
  it("returns 404 for an unknown session", async () => {
    const res = await request(app).post("/api/sessions/does-not-exist/accept").set("Origin", UI_ORIGIN);
    expect(res.status).toBe(404);
  });

  it("accepts a real session, writes human-acceptance.json, and readSession reflects it", async () => {
    const id = "20260821-000001-glimmer-accept-route";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ task: "test", status: "verified", workspace, branch: "main", baseline: null, attempts: [] })
    );

    const res = await request(app).post(`/api/sessions/${id}/accept`).set("Origin", UI_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(typeof res.body.acceptedAt).toBe("string");

    const onDisk = JSON.parse(await fs.readFile(path.join(dir, "human-acceptance.json"), "utf-8"));
    expect(onDisk).toEqual(res.body);

    const sessionRes = await request(app).get(`/api/sessions/${id}`);
    expect(sessionRes.body.humanAcceptance).toEqual(res.body);
  });

  it("is idempotent — accepting an already-accepted session returns the original record", async () => {
    const id = "20260821-000002-glimmer-accept-twice-route";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ task: "test", status: "verified", workspace, branch: "main", baseline: null, attempts: [] })
    );

    const first = await request(app).post(`/api/sessions/${id}/accept`).set("Origin", UI_ORIGIN);
    const second = await request(app).post(`/api/sessions/${id}/accept`).set("Origin", UI_ORIGIN);
    expect(second.body).toEqual(first.body);
  });
});

describe("POST /api/sessions", () => {
  it("rejects a taskContract missing verification/repairBudget instead of accepting it", async () => {
    const res = await request(app)
      .post("/api/sessions").set("Origin", UI_ORIGIN)
      .send({ taskContract: { objective: "x" }, workspace: "/tmp/ws" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("accepts a well-formed taskContract", async () => {
    const res = await request(app)
      .post("/api/sessions").set("Origin", UI_ORIGIN)
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

describe("POST /api/sessions — §7 advanced controls validation", () => {
  const validBase = {
    objective: "Fix a thing",
    scope: { package: "frontend" },
    mode: "implement",
    constraints: { minimalChange: true, noCommit: true, noPush: true, noDeploy: true, noDependencyInstall: true },
    verification: [],
    repairBudget: 1,
  };

  it("rejects maxTurns out of 1..64 range with 400", async () => {
    const res = await request(app)
      .post("/api/sessions").set("Origin", UI_ORIGIN)
      .send({ taskContract: { ...validBase, maxTurns: 100 }, workspace: "/tmp/ws" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects timeoutSeconds out of 60..3600 range with 400", async () => {
    const res = await request(app)
      .post("/api/sessions").set("Origin", UI_ORIGIN)
      .send({ taskContract: { ...validBase, advanced: { timeoutSeconds: 5 } }, workspace: "/tmp/ws" });
    expect(res.status).toBe(400);
  });

  it("rejects a toolchainMode outside the closed enum with 400", async () => {
    const res = await request(app)
      .post("/api/sessions").set("Origin", UI_ORIGIN)
      .send({ taskContract: { ...validBase, advanced: { toolchainMode: "rm -rf /" } }, workspace: "/tmp/ws" });
    expect(res.status).toBe(400);
  });

  it("rejects an unparseable/injection-attempt modelReadinessUrl with 400", async () => {
    const res = await request(app)
      .post("/api/sessions").set("Origin", UI_ORIGIN)
      .send({ taskContract: { ...validBase, advanced: { modelReadinessUrl: "http://x; rm -rf /" } }, workspace: "/tmp/ws" });
    expect(res.status).toBe(400);
  });

  it("rejects a non-http(s) modelReadinessUrl scheme with 400", async () => {
    const res = await request(app)
      .post("/api/sessions").set("Origin", UI_ORIGIN)
      .send({ taskContract: { ...validBase, advanced: { modelReadinessUrl: "javascript:alert(1)" } }, workspace: "/tmp/ws" });
    expect(res.status).toBe(400);
  });

  it("accepts a well-formed advanced block", async () => {
    const res = await request(app).post("/api/sessions").set("Origin", UI_ORIGIN).send({
      taskContract: {
        ...validBase,
        maxTurns: 20,
        advanced: { timeoutSeconds: 600, toolchainMode: "linked", modelReadinessUrl: "https://model.local/ready", architectFirst: true },
      },
      workspace: "/tmp/ws",
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /api/sessions/:id/run replay protection", () => {
  let runWorkspace: string;
  let mainWorkspace: string;

  beforeAll(async () => {
    runWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-run-route-"));
    mainWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-main-route-"));
    for (const repo of [runWorkspace, mainWorkspace]) {
      await execGit("git", ["init", "-q"], { cwd: repo });
      await execGit("git", ["config", "user.email", "t@t.com"], { cwd: repo });
      await execGit("git", ["config", "user.name", "t"], { cwd: repo });
      await fs.writeFile(path.join(repo, "README.md"), "fixture\n");
      await execGit("git", ["add", "README.md"], { cwd: repo });
      await execGit("git", ["commit", "-q", "-m", "baseline"], { cwd: repo });
    }
    await execGit("git", ["switch", "-q", "-c", "glimmer/run-route-test"], { cwd: runWorkspace });
    await execGit("git", ["branch", "-M", "main"], { cwd: mainWorkspace });
  });

  afterAll(async () => {
    await fs.rm(runWorkspace, { recursive: true, force: true });
    await fs.rm(mainWorkspace, { recursive: true, force: true });
  });

  const validContract = {
    objective: "Fix a thing",
    scope: { package: "frontend" },
    mode: "implement",
    constraints: { minimalChange: true, noCommit: true, noPush: true, noDeploy: true, noDependencyInstall: true },
    verification: [],
    repairBudget: 1,
  };

  it("rejects a non-glimmer branch synchronously with a recovery instruction", async () => {
    const created = await request(app)
      .post("/api/sessions").set("Origin", UI_ORIGIN)
      .send({ taskContract: validContract, workspace: mainWorkspace });

    const run = await request(app).post(`/api/sessions/${created.body.id}/run`).set("Origin", UI_ORIGIN);

    expect(run.status).toBe(409);
    expect(run.body.error).toContain("branch main");
    expect(run.body.error).toContain("glimmer/*");
    await expect(fs.stat(path.join(stateRoot, "sessions", created.body.id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a non-Git workspace before spawning the orchestrator", async () => {
    const created = await request(app)
      .post("/api/sessions").set("Origin", UI_ORIGIN)
      .send({ taskContract: validContract, workspace });

    const run = await request(app).post(`/api/sessions/${created.body.id}/run`).set("Origin", UI_ORIGIN);

    expect(run.status).toBe(400);
    expect(run.body.error).toContain("Git worktree");
  });

  it("cancels an adopted active run when the UI addresses it by its real session id", async () => {
    const realId = "20260825-170000-glimmer-cancellable-fixture";
    process.env.GLIMMER_FAKE_REAL_ID = realId;
    try {
      const created = await request(app)
        .post("/api/sessions").set("Origin", UI_ORIGIN)
        .send({ taskContract: validContract, workspace: runWorkspace });
      expect((await request(app).post(`/api/sessions/${created.body.id}/run`).set("Origin", UI_ORIGIN)).status).toBe(200);

      // Wait until the gateway has adopted the fixture's real directory;
      // without that alias the regression (activeRuns keyed by pending id,
      // UI sending the real id) cannot be exercised.
      let adopted = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const current = await request(app).get(`/api/sessions/${created.body.id}`);
        if (current.status === 200 && current.body.id === realId) {
          adopted = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(adopted).toBe(true);

      const cancelled = await request(app).post(`/api/sessions/${realId}/cancel`).set("Origin", UI_ORIGIN);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toEqual({ cancelled: true });
    } finally {
      delete process.env.GLIMMER_FAKE_REAL_ID;
    }
  });

  it("a second /run call for the same id does not spawn a second process", async () => {
    const createRes = await request(app)
      .post("/api/sessions").set("Origin", UI_ORIGIN)
      .send({ taskContract: validContract, workspace: runWorkspace });
    const id = createRes.body.id as string;

    const firstRun = await request(app).post(`/api/sessions/${id}/run`).set("Origin", UI_ORIGIN);
    expect(firstRun.status).toBe(200);

    // Called immediately, before the fake fixture's process has necessarily
    // exited: activeRuns should still hold the first handle, so this must be
    // rejected rather than spawning a second child process.
    const secondRun = await request(app).post(`/api/sessions/${id}/run`).set("Origin", UI_ORIGIN);
    expect([404, 409]).toContain(secondRun.status);
  });

  it("POST /run persists the task contract so it survives pendingContracts being cleared", async () => {
    const created = await request(app)
      .post("/api/sessions").set("Origin", UI_ORIGIN)
      .send({ taskContract: validContract, workspace: runWorkspace });
    const id = created.body.id;
    await request(app).post(`/api/sessions/${id}/run`).set("Origin", UI_ORIGIN);
    const contractPath = path.join(stateRoot, "sessions", id, "gateway-contract.json");
    const written = JSON.parse(await fs.readFile(contractPath, "utf-8"));
    expect(written).toEqual(validContract);
  });
});

describe("GET /api/sessions/:id/analysis", () => {
  it("computes risk score and scope guard from real session data", async () => {
    const id = "20260817-000010-glimmer-analysis-test";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({
      task: "test", status: "verified", workspace: "/tmp/ws", branch: "main", baseline: null, attempts: [],
      finalChangedFiles: ["frontend/client/src/dialog/Dialog.tsx", "backend/src/unrelated.ts"],
    }));
    await fs.writeFile(path.join(dir, "gateway-contract.json"), JSON.stringify({
      objective: "x", scope: { package: "directory", area: "frontend/client/src/dialog" }, mode: "implement",
      constraints: { minimalChange: true, noCommit: true, noPush: true, noDeploy: true, noDependencyInstall: true },
      verification: [], repairBudget: 0,
    }));

    const res = await request(app).get(`/api/sessions/${id}/analysis`);
    expect(res.status).toBe(200);
    expect(res.body.scopeGuard.inScope).toBe(false);
    expect(res.body.scopeGuard.expandedFiles).toEqual(["backend/src/unrelated.ts"]);
    expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).toContain(res.body.riskScore);
  });

  it("returns scopeGuard: null when no contract was ever persisted", async () => {
    const id = "20260817-000011-glimmer-nocontract-analysis";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({
      task: "test", status: "verified", workspace: "/tmp/ws", branch: "main", baseline: null, attempts: [],
    }));

    const res = await request(app).get(`/api/sessions/${id}/analysis`);
    expect(res.status).toBe(200);
    expect(res.body.scopeGuard).toBeNull();
  });

  it("returns 404 for an unknown session id instead of crashing", async () => {
    const res = await request(app).get("/api/sessions/does-not-exist/analysis");
    expect(res.status).toBe(404);
  });

  it("scores against THIS session's own repo-map.json, not the newest session's", async () => {
    const repoPackage = (dir: string) => ({
      path: dir, dir, name: dir, scripts: {}, frameworks: [], engines: {}, workspaces: {},
    });

    // Older id, analyzed by this test — its own repo-map says its backend
    // package lives at "backend-a", matching where its changed file lives.
    const olderId = "20260817-000012-glimmer-own-repo-map-a";
    const olderDir = path.join(stateRoot, "sessions", olderId);
    await fs.mkdir(olderDir, { recursive: true });
    await fs.writeFile(path.join(olderDir, "manifest.json"), JSON.stringify({
      task: "test", status: "verified", workspace: "/tmp/ws", branch: "main", baseline: null, attempts: [],
      finalChangedFiles: ["backend-a/file.ts"],
    }));
    await fs.writeFile(path.join(olderDir, "gateway-contract.json"), JSON.stringify({
      objective: "x", scope: { package: "backend" }, mode: "implement",
      constraints: { minimalChange: true, noCommit: true, noPush: true, noDeploy: true, noDependencyInstall: true },
      verification: [], repairBudget: 0,
    }));
    await fs.writeFile(path.join(olderDir, "repo-map.json"), JSON.stringify({
      generatedAt: "x", workspace: "/tmp/ws", branch: "main", head: "x", upstream: null,
      packages: [repoPackage("backend-a")],
    }));

    // Newer id (lexicographically later => listSessionIds() sorts it first),
    // with a DIFFERENT repo-map. Before the fix, findRepoMap() would return
    // this one for both sessions.
    const newerId = "20260817-000013-glimmer-own-repo-map-b";
    const newerDir = path.join(stateRoot, "sessions", newerId);
    await fs.mkdir(newerDir, { recursive: true });
    await fs.writeFile(path.join(newerDir, "manifest.json"), JSON.stringify({
      task: "test", status: "verified", workspace: "/tmp/ws", branch: "main", baseline: null, attempts: [],
      finalChangedFiles: ["backend-b/file.ts"],
    }));
    await fs.writeFile(path.join(newerDir, "repo-map.json"), JSON.stringify({
      generatedAt: "x", workspace: "/tmp/ws", branch: "main", head: "x", upstream: null,
      packages: [repoPackage("backend-b")],
    }));

    const res = await request(app).get(`/api/sessions/${olderId}/analysis`);
    expect(res.status).toBe(200);
    // If this were scored against the newer session's repo-map (dir
    // "backend-b"), expected would be ["backend-b"] and "backend-a/file.ts"
    // would wrongly read as a scope expansion.
    expect(res.body.scopeGuard.expected).toEqual(["backend-a"]);
    expect(res.body.scopeGuard.inScope).toBe(true);
  });

  it("includes a provenance field on the response body", async () => {
    const id = "20260817-000014-glimmer-provenance-test";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({
      task: "test", status: "verified", workspace: "/tmp/ws", branch: "main", baseline: null, attempts: [],
    }));

    const res = await request(app).get(`/api/sessions/${id}/analysis`);
    expect(res.status).toBe(200);
    expect(res.body.provenance).toBe("git-derived");
  });
});

describe("GET /api/sessions/:id/plan", () => {
  const plan = {
    objective: "Add a whisper(name) function.",
    packages: ["glimmer-smoke-test"],
    risk: "low",
  };

  it("returns the parsed architecture-plan.json when present", async () => {
    const id = "20260818-000001-glimmer-plan-found";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "architecture-plan.json"), JSON.stringify(plan));

    const res = await request(app).get(`/api/sessions/${id}/plan`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(plan);
  });

  it("returns 404 when no plan was ever written (opt-in artifact)", async () => {
    const id = "20260818-000002-glimmer-plan-missing";
    await fs.mkdir(path.join(stateRoot, "sessions", id), { recursive: true });

    const res = await request(app).get(`/api/sessions/${id}/plan`);
    expect(res.status).toBe(404);
  });

  it("returns 404, not a crash, for malformed JSON", async () => {
    const id = "20260818-000003-glimmer-plan-malformed";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "architecture-plan.json"), "not json {{{");

    const res = await request(app).get(`/api/sessions/${id}/plan`);
    expect(res.status).toBe(404);
  });

  it("returns 500, not a crash, on a real fs read error", async () => {
    const id = "20260818-000004-glimmer-plan-fserror";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    // A directory named architecture-plan.json, not a file: fs.readFile fails
    // with EISDIR, a genuine gateway fault distinct from "no artifact".
    await fs.mkdir(path.join(dir, "architecture-plan.json"));

    const res = await request(app).get(`/api/sessions/${id}/plan`);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});

describe("GET /api/sessions/:id/architect-reviews", () => {
  const review = { decision: "APPROVED_WITH_CONDITIONS", confidence: 0.88 };

  it("returns the sorted array of architect-review-NN-MM.json files", async () => {
    const id = "20260818-000005-glimmer-reviews-found";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "architect-review-00-02.json"), JSON.stringify({ ...review, decision: "REVISE_IMPLEMENTATION" }));
    await fs.writeFile(path.join(dir, "architect-review-00-01.json"), JSON.stringify(review));

    const res = await request(app).get(`/api/sessions/${id}/architect-reviews`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([review, { ...review, decision: "REVISE_IMPLEMENTATION" }]);
  });

  it("returns 404 when no review files exist (opt-in artifact)", async () => {
    const id = "20260818-000006-glimmer-reviews-missing";
    await fs.mkdir(path.join(stateRoot, "sessions", id), { recursive: true });

    const res = await request(app).get(`/api/sessions/${id}/architect-reviews`);
    expect(res.status).toBe(404);
  });

  it("skips a malformed individual review file and returns the rest", async () => {
    const id = "20260818-000007-glimmer-reviews-malformed";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "architect-review-00-01.json"), JSON.stringify(review));
    await fs.writeFile(path.join(dir, "architect-review-00-02.json"), "not json {{{");

    const res = await request(app).get(`/api/sessions/${id}/architect-reviews`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([review]);
  });

  it("returns 500, not a crash, on a real fs read error", async () => {
    const fileId = "20260818-000008-not-a-directory";
    await fs.writeFile(path.join(stateRoot, "sessions", fileId), "not a session dir");

    const res = await request(app).get(`/api/sessions/${fileId}/architect-reviews`);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});

describe("GET /api/sessions/:id/delivery-review", () => {
  const deliveryReview = {
    summary: "src/greet.js now defines whisper(name).",
    customerReadiness: "ready_with_known_limitations",
    confidence: { level: "medium", reason: "File content confirmed by read-back." },
  };

  it("returns the parsed delivery-review.json when present", async () => {
    const id = "20260818-000009-glimmer-delivery-found";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "delivery-review.json"), JSON.stringify(deliveryReview));

    const res = await request(app).get(`/api/sessions/${id}/delivery-review`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(deliveryReview);
  });

  it("returns 404 when no delivery review was ever written (opt-in artifact)", async () => {
    const id = "20260818-000010-glimmer-delivery-missing";
    await fs.mkdir(path.join(stateRoot, "sessions", id), { recursive: true });

    const res = await request(app).get(`/api/sessions/${id}/delivery-review`);
    expect(res.status).toBe(404);
  });

  it("returns 404, not a crash, for malformed JSON", async () => {
    const id = "20260818-000011-glimmer-delivery-malformed";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "delivery-review.json"), "not json {{{");

    const res = await request(app).get(`/api/sessions/${id}/delivery-review`);
    expect(res.status).toBe(404);
  });

  it("returns 500, not a crash, on a real fs read error", async () => {
    const id = "20260818-000012-glimmer-delivery-fserror";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, "delivery-review.json"));

    const res = await request(app).get(`/api/sessions/${id}/delivery-review`);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });

  // Task 8.2 (V7 §23.15): a session that triggered architect escalation
  // gets it merged onto the SAME response, not a separate route.
  it("merges architect-escalation.json onto the response when present", async () => {
    const id = "20260821-000010-glimmer-delivery-escalated";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "delivery-review.json"), JSON.stringify(deliveryReview));
    await fs.writeFile(
      path.join(dir, "architect-escalation.json"),
      JSON.stringify({ consultationFailed: true, reason: "architect model unreachable" })
    );

    const res = await request(app).get(`/api/sessions/${id}/delivery-review`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...deliveryReview,
      architectEscalation: { consultationFailed: true, reason: "architect model unreachable" },
    });
  });
});

describe("GET /api/sessions/:id/delivery-packet", () => {
  const packet = {
    task: "add widget", planRef: null, changedFiles: ["src/widget.ts"], orchestratorUpdatedFiles: [],
    verification: { status: "VERIFIED", results: null }, visual: "not_run",
    statuses: { technical: "VERIFIED", architecture: "not_run", documentation: "not_run", visual: "not_run", delivery: "not_run", overall: "not_run" },
    customerReadiness: null, limitations: null, forwardPlan: null, confidence: null,
    humanReviewStatus: "pending",
  };

  it("returns the parsed delivery-packet.json when present", async () => {
    const id = "20260821-000011-glimmer-packet-found";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "delivery-packet.json"), JSON.stringify(packet));

    const res = await request(app).get(`/api/sessions/${id}/delivery-packet`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(packet);
  });

  it("returns 404 when no packet was ever written (opt-in artifact)", async () => {
    const id = "20260821-000012-glimmer-packet-missing";
    await fs.mkdir(path.join(stateRoot, "sessions", id), { recursive: true });

    const res = await request(app).get(`/api/sessions/${id}/delivery-packet`);
    expect(res.status).toBe(404);
  });

  it("returns 500, not a crash, on a real fs read error", async () => {
    const id = "20260821-000013-glimmer-packet-fserror";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, "delivery-packet.json"));

    const res = await request(app).get(`/api/sessions/${id}/delivery-packet`);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});

describe("GET /api/sessions/:id/evidence", () => {
  const indexEntries = [
    { id: "sess-1-ev-1", kind: "file", path: "src/greet.js", toolCall: "read_file" },
    {
      id: "sess-1-ev-2", kind: "test-search", path: "src/greet.js", toolCall: "find_related_tests",
      relatesTo: [{ path: "src/greet.test.js", kind: "test" }],
    },
  ];

  it("returns the parsed evidence-index.json list when present", async () => {
    const id = "20260822-000001-glimmer-evidence-found";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "evidence-index.json"), JSON.stringify(indexEntries));

    const res = await request(app).get(`/api/sessions/${id}/evidence`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: indexEntries });
  });

  it("returns 404 when no evidence-index.json was ever written (opt-in artifact)", async () => {
    const id = "20260822-000002-glimmer-evidence-missing";
    await fs.mkdir(path.join(stateRoot, "sessions", id), { recursive: true });

    const res = await request(app).get(`/api/sessions/${id}/evidence`);
    expect(res.status).toBe(404);
  });

  it("?id= returns the single persisted evidence-NN.jsonl line, capped", async () => {
    const id = "20260822-000003-glimmer-evidence-entry";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    const bigContent = "z".repeat(5000);
    await fs.writeFile(
      path.join(dir, "evidence-00.jsonl"),
      JSON.stringify({
        id: "sess-1-ev-1", sessionId: "sess-1", timestamp: "t", tool: "read_file",
        arguments: { path: "src/greet.js" }, content: bigContent,
      }) + "\n"
      // A tool_envelope-kind line has no top-level "id" -- must never be
      // mistaken for the entry being looked up.
      + JSON.stringify({ kind: "tool_envelope", ok: true, tool: "read_file", data: "x" }) + "\n"
    );

    const res = await request(app).get(`/api/sessions/${id}/evidence?id=sess-1-ev-1`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("sess-1-ev-1");
    expect(res.body.tool).toBe("read_file");
    expect(res.body.arguments).toEqual({ path: "src/greet.js" });
    expect(res.body.content.length).toBeLessThan(bigContent.length);
    expect(res.body.content.endsWith("[truncated]")).toBe(true);
  });

  it("?id= redacts write_file/edit_file arguments to path+keys (never echoes full file content)", async () => {
    const id = "20260822-000006-glimmer-evidence-write-redact";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    const wholeFileContent = "line 1\n".repeat(2000);
    await fs.writeFile(
      path.join(dir, "evidence-00.jsonl"),
      JSON.stringify({
        id: "sess-1-ev-1", tool: "write_file",
        arguments: { path: "src/big.ts", content: wholeFileContent },
        content: "wrote src/big.ts",
      }) + "\n"
    );

    const res = await request(app).get(`/api/sessions/${id}/evidence?id=sess-1-ev-1`);
    expect(res.status).toBe(200);
    expect(res.body.arguments).toEqual({ path: "src/big.ts", keys: ["path", "content"] });
    expect(JSON.stringify(res.body.arguments)).not.toContain("line 1");
  });

  it("?id= caps non-write-tool arguments at 4000 characters", async () => {
    const id = "20260822-000007-glimmer-evidence-args-cap";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    const hugePattern = "x".repeat(5000);
    await fs.writeFile(
      path.join(dir, "evidence-00.jsonl"),
      JSON.stringify({
        id: "sess-1-ev-1", tool: "grep_search",
        arguments: { pattern: hugePattern }, content: "no matches",
      }) + "\n"
    );

    const res = await request(app).get(`/api/sessions/${id}/evidence?id=sess-1-ev-1`);
    expect(res.status).toBe(200);
    expect(typeof res.body.arguments).toBe("string");
    expect(res.body.arguments.length).toBeLessThan(JSON.stringify({ pattern: hugePattern }).length);
    expect(res.body.arguments.endsWith("...(truncated)")).toBe(true);
  });

  it("?id= returns 404 for an unknown evidence id", async () => {
    const id = "20260822-000004-glimmer-evidence-entry-missing";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "evidence-00.jsonl"),
      JSON.stringify({ id: "sess-1-ev-1", tool: "read_file", arguments: {}, content: "x" }) + "\n"
    );

    const res = await request(app).get(`/api/sessions/${id}/evidence?id=sess-1-ev-999`);
    expect(res.status).toBe(404);
  });

  it("returns 500, not a crash, on a real fs read error", async () => {
    const fileId = "20260822-000005-not-a-directory";
    await fs.writeFile(path.join(stateRoot, "sessions", fileId), "not a session dir");

    const res = await request(app).get(`/api/sessions/${fileId}/evidence`);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});

// Task 9.3c (V7 §7 Context Engine): context-selection facts from
// context_selected events + evidence-index.json's own entry count.
describe("GET /api/sessions/:id/context", () => {
  it("returns context_selected events plus the evidence-index.json entry count", async () => {
    const id = "20260823-000001-glimmer-context-found";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    const events = [
      {
        id: "evt_1", sessionId: id, timestamp: "2026-08-23T00:00:00.000Z",
        type: "context_selected", tier0Chars: 1000, tier1Chars: 0, tier2Refs: 0, tier3Note: "cold: n/a",
      },
      {
        id: "evt_2", sessionId: id, timestamp: "2026-08-23T00:00:01.000Z",
        type: "tool_started", tool: "read_file", args: { path: "a.ts" },
      },
      {
        id: "evt_3", sessionId: id, timestamp: "2026-08-23T00:00:02.000Z",
        type: "context_selected", tier0Chars: 1000, tier1Chars: 400, tier2Refs: 1, tier3Note: "cold: n/a",
      },
    ];
    await fs.writeFile(dir + "/events.jsonl", events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    await fs.writeFile(
      path.join(dir, "evidence-index.json"),
      JSON.stringify([{ id: "e1", kind: "file", path: "a.ts", toolCall: "read_file" }])
    );

    const res = await request(app).get(`/api/sessions/${id}/context`);
    expect(res.status).toBe(200);
    expect(res.body.selections).toHaveLength(2);
    expect(res.body.selections.every((e: any) => e.type === "context_selected")).toBe(true);
    expect(res.body.evidenceCount).toBe(1);
  });

  it("honestly returns empty facts (not 404) for a well-formed session with nothing recorded yet", async () => {
    const id = "20260823-000002-glimmer-context-empty";
    await fs.mkdir(path.join(stateRoot, "sessions", id), { recursive: true });

    const res = await request(app).get(`/api/sessions/${id}/context`);
    expect(res.status).toBe(200);
    expect(res.body.selections).toEqual([]);
    expect(res.body.evidenceCount).toBeNull();
  });

  it("404s for an unsafe/invalid session id", async () => {
    const res = await request(app).get(`/api/sessions/${encodeURIComponent("../../etc")}/context`);
    expect(res.status).toBe(404);
  });

  it("returns 500, not a crash, on a real fs read error", async () => {
    const fileId = "20260823-000003-context-not-a-directory";
    await fs.writeFile(path.join(stateRoot, "sessions", fileId), "not a session dir");

    const res = await request(app).get(`/api/sessions/${fileId}/context`);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});

describe("GET /api/sessions/:id/tasks", () => {
  const tasks = [
    { id: "t1", description: "Inspect src/greet.js", kind: "implementation", dependsOn: [], status: "complete" },
  ];

  it("returns the parsed tasks.json when present", async () => {
    const id = "20260818-000013-glimmer-tasks-found";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "tasks.json"), JSON.stringify(tasks));

    const res = await request(app).get(`/api/sessions/${id}/tasks`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(tasks);
  });

  it("unwraps a Task 4.1 v2 {schemaVersion, tasks} tasks.json to the same flat array", async () => {
    const id = "20260822-000017-glimmer-tasks-v2";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "tasks.json"), JSON.stringify({ schemaVersion: 2, tasks }));

    const res = await request(app).get(`/api/sessions/${id}/tasks`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(tasks);
  });

  it("returns 404 when no tasks.json was ever written (opt-in artifact)", async () => {
    const id = "20260818-000014-glimmer-tasks-missing";
    await fs.mkdir(path.join(stateRoot, "sessions", id), { recursive: true });

    const res = await request(app).get(`/api/sessions/${id}/tasks`);
    expect(res.status).toBe(404);
  });

  it("returns 404, not a crash, for malformed JSON", async () => {
    const id = "20260818-000015-glimmer-tasks-malformed";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "tasks.json"), "not json {{{");

    const res = await request(app).get(`/api/sessions/${id}/tasks`);
    expect(res.status).toBe(404);
  });

  it("returns 500, not a crash, on a real fs read error", async () => {
    const id = "20260818-000016-glimmer-tasks-fserror";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, "tasks.json"));

    const res = await request(app).get(`/api/sessions/${id}/tasks`);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});

// Task 4.3: human skip/approve, the task-level counterpart to §14's
// /sessions/:id/accept. Gateway-owned (task-overrides.json) -- these routes
// never touch tasks.json itself.
describe("POST /api/sessions/:id/tasks/:taskId/skip and /approve", () => {
  const tasks = [
    { id: "t1", description: "Add hook", kind: "implementation", dependsOn: [], status: "pending", priority: "required" },
    { id: "t2", description: "Run tests", kind: "verification", dependsOn: ["t1"], status: "pending", priority: "required" },
  ];

  it("writes task-overrides.json on skip and reflects it on a re-read", async () => {
    const id = "20260822-000018-glimmer-task-skip";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "tasks.json"), JSON.stringify(tasks));

    const res = await request(app).post(`/api/sessions/${id}/tasks/t1/skip`).set("Origin", UI_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ taskId: "t1", action: "skip" });
    expect(typeof res.body.at).toBe("string");

    const onDisk = JSON.parse(await fs.readFile(path.join(dir, "task-overrides.json"), "utf-8"));
    expect(onDisk).toEqual({
      t1: { action: "skip", at: res.body.at, kind: "implementation", description: "Add hook" },
    });
  });

  it("writes task-overrides.json on approve, independent of other tasks' overrides", async () => {
    const id = "20260822-000019-glimmer-task-approve";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "tasks.json"), JSON.stringify(tasks));

    await request(app).post(`/api/sessions/${id}/tasks/t1/skip`).set("Origin", UI_ORIGIN);
    const res = await request(app).post(`/api/sessions/${id}/tasks/t2/approve`).set("Origin", UI_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ taskId: "t2", action: "approve" });

    const onDisk = JSON.parse(await fs.readFile(path.join(dir, "task-overrides.json"), "utf-8"));
    expect(onDisk.t1).toMatchObject({ action: "skip" });
    expect(onDisk.t2).toMatchObject({ action: "approve" });
  });

  it("404s for an unknown session id", async () => {
    const res = await request(app).post("/api/sessions/does-not-exist/tasks/t1/skip").set("Origin", UI_ORIGIN);
    expect(res.status).toBe(404);
  });

  it("404s for a taskId that isn't in this session's tasks.json", async () => {
    const id = "20260822-000020-glimmer-task-bad-id";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "tasks.json"), JSON.stringify(tasks));

    const res = await request(app).post(`/api/sessions/${id}/tasks/does-not-exist/skip`).set("Origin", UI_ORIGIN);
    expect(res.status).toBe(404);

    // And the sidecar must not have been written for the rejected call.
    await expect(fs.readFile(path.join(dir, "task-overrides.json"), "utf-8")).rejects.toThrow();
  });

  it("GET /sessions/:id/tasks merges overrides: skip -> status skipped + priority optional, approve -> status complete", async () => {
    const id = "20260822-000021-glimmer-task-merge";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "tasks.json"), JSON.stringify(tasks));

    await request(app).post(`/api/sessions/${id}/tasks/t1/skip`).set("Origin", UI_ORIGIN);
    await request(app).post(`/api/sessions/${id}/tasks/t2/approve`).set("Origin", UI_ORIGIN);

    const res = await request(app).get(`/api/sessions/${id}/tasks`);
    expect(res.status).toBe(200);
    const t1 = res.body.find((t: any) => t.id === "t1");
    const t2 = res.body.find((t: any) => t.id === "t2");
    expect(t1).toMatchObject({ status: "skipped", priority: "optional" });
    expect(t1.override).toMatchObject({ action: "skip" });
    expect(t2).toMatchObject({ status: "complete", priority: "required" });
    expect(t2.override).toMatchObject({ action: "approve" });
  });

  // Review round 1 (Important 3): replay a replan renumbering ids -- an
  // override recorded for the OLD "t2" (a "Run tests" verification task)
  // must not silently apply to a NEW, unrelated task that happens to be
  // renumbered to the same id "t2" afterward (merge_replanned_tasks can do
  // this; ids are not stable across a replan).
  it("does not apply an override whose id was recycled by a replan for a different task", async () => {
    const id = "20260822-000022-glimmer-task-id-recycled";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "tasks.json"), JSON.stringify(tasks));

    const skipRes = await request(app).post(`/api/sessions/${id}/tasks/t2/skip`).set("Origin", UI_ORIGIN);
    expect(skipRes.body).toMatchObject({ taskId: "t2", action: "skip" });

    // Simulate a replan: t2 now names a completely different task.
    const replannedTasks = [
      tasks[0],
      { id: "t2", description: "Add telemetry for the new flow", kind: "implementation", dependsOn: ["t1"], status: "pending", priority: "required" },
    ];
    await fs.writeFile(path.join(dir, "tasks.json"), JSON.stringify(replannedTasks));

    const res = await request(app).get(`/api/sessions/${id}/tasks`);
    const newT2 = res.body.find((t: any) => t.id === "t2");
    expect(newT2.status).toBe("pending"); // NOT "skipped" -- the stale override must not apply
    expect(newT2.override).toBeUndefined();
    expect(newT2.staleOverride).toMatchObject({ action: "skip" });
  });
});

// Task 8.3 (V7 §14/§35): human approve/deny for a YELLOW-classified action
// glimmer-engineer.py is currently blocked on (approvals.json). Gateway-
// owned resolution, exactly like the task-override routes above.
describe("POST /api/sessions/:id/approvals/:approvalId/approve and /deny", () => {
  const pendingApproval = {
    action: "modify_dependencies",
    reason: "engineer requested a dependency-install command: npm install left-pad",
    proposedChanges: ["package.json", "package-lock.json"],
    risk: "medium",
    requestedAt: "2026-08-22T00:00:00.000Z",
    status: "pending",
  };

  it("writes approvals.json on approve and reflects it on a re-read", async () => {
    const id = "20260823-000001-glimmer-approval-approve";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "approvals.json"), JSON.stringify({ "appr-1": pendingApproval }));

    const res = await request(app).post(`/api/sessions/${id}/approvals/appr-1/approve`).set("Origin", UI_ORIGIN).send({ approvedBy: "daniel" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approvalId: "appr-1", status: "approved", approvedBy: "daniel" });
    expect(typeof res.body.resolvedAt).toBe("string");

    const onDisk = JSON.parse(await fs.readFile(path.join(dir, "approvals.json"), "utf-8"));
    expect(onDisk["appr-1"]).toMatchObject({ status: "approved", approvedBy: "daniel" });
  });

  it("writes approvals.json on deny, defaulting approvedBy when omitted", async () => {
    const id = "20260823-000002-glimmer-approval-deny";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "approvals.json"), JSON.stringify({ "appr-2": pendingApproval }));

    const res = await request(app).post(`/api/sessions/${id}/approvals/appr-2/deny`).set("Origin", UI_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approvalId: "appr-2", status: "denied" });
    expect(typeof res.body.approvedBy).toBe("string");
    expect(res.body.approvedBy.length).toBeGreaterThan(0);
  });

  it("404s for an unknown session id", async () => {
    const res = await request(app).post("/api/sessions/does-not-exist/approvals/appr-1/approve").set("Origin", UI_ORIGIN);
    expect(res.status).toBe(404);
  });

  it("404s for an approvalId that was never requested", async () => {
    const id = "20260823-000003-glimmer-approval-bad-id";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "approvals.json"), JSON.stringify({ "appr-1": pendingApproval }));

    const res = await request(app).post(`/api/sessions/${id}/approvals/does-not-exist/approve`).set("Origin", UI_ORIGIN);
    expect(res.status).toBe(404);
  });

  it("double-approve is idempotent: the second call returns the same record, not a re-resolved one", async () => {
    const id = "20260823-000004-glimmer-approval-double";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "approvals.json"), JSON.stringify({ "appr-1": pendingApproval }));

    const first = await request(app).post(`/api/sessions/${id}/approvals/appr-1/approve`).set("Origin", UI_ORIGIN).send({ approvedBy: "daniel" });
    expect(first.status).toBe(200);
    const second = await request(app).post(`/api/sessions/${id}/approvals/appr-1/approve`).set("Origin", UI_ORIGIN).send({ approvedBy: "someone-else" });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body); // unchanged -- not re-resolved to "someone-else"/a new timestamp

    // A denial after an approval is already recorded is equally a no-op.
    const third = await request(app).post(`/api/sessions/${id}/approvals/appr-1/deny`).set("Origin", UI_ORIGIN);
    expect(third.body).toEqual(first.body);
  });

  it("GET /api/sessions/:id exposes pendingApproval + status waiting_for_approval from manifest.json", async () => {
    const id = "20260823-000005-glimmer-approval-session";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({
      status: "waiting-for-approval", workspace: "/tmp/ws", branch: "main", baseline: "abc123",
      task: "add widget", attempts: [], updatedAt: "2026-08-23T00:00:00.000Z",
      pendingApproval: { approvalId: "appr-1", ...pendingApproval },
    }));

    const res = await request(app).get(`/api/sessions/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("waiting_for_approval");
    expect(res.body.pendingApproval).toMatchObject({ approvalId: "appr-1", action: "modify_dependencies" });
  });
});

describe("GET /api/sessions/:id/visual/manifest", () => {
  const manifest = {
    route: "http://localhost:5183/role-room",
    viewports: ["1440x900"],
    states: ["initial"],
    status: "pass",
    captures: [{ viewport: "1440x900", screenshot: "1440x900.png", status: "captured", error: null }],
  };
  const findings = { status: "PASS", viewport: "multi", viewports: ["1440x900"], findings: [] };

  it("returns manifest + findings when both are present", async () => {
    const id = "20260822-000060-glimmer-visual-found";
    const dir = path.join(stateRoot, "sessions", id, "visual");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "visual-manifest.json"), JSON.stringify(manifest));
    await fs.writeFile(path.join(dir, "findings.json"), JSON.stringify(findings));

    const res = await request(app).get(`/api/sessions/${id}/visual/manifest`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ manifest, findings });
  });

  it("returns findings: null when only visual-manifest.json exists", async () => {
    const id = "20260822-000061-glimmer-visual-no-findings";
    const dir = path.join(stateRoot, "sessions", id, "visual");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "visual-manifest.json"), JSON.stringify(manifest));

    const res = await request(app).get(`/api/sessions/${id}/visual/manifest`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ manifest, findings: null });
  });

  it("returns 404 when the session never ran glimmer-visual.py (opt-in artifact)", async () => {
    const id = "20260822-000062-glimmer-visual-missing";
    await fs.mkdir(path.join(stateRoot, "sessions", id), { recursive: true });

    const res = await request(app).get(`/api/sessions/${id}/visual/manifest`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a path-traversal id", async () => {
    const res = await request(app).get("/api/sessions/..%2F..%2Fevil/visual/manifest");
    expect(res.status).toBe(404);
  });

  it("returns 500, not a crash, on a real fs read error", async () => {
    const id = "20260822-000063-glimmer-visual-fserror";
    const dir = path.join(stateRoot, "sessions", id, "visual");
    await fs.mkdir(dir, { recursive: true });
    // A directory named visual-manifest.json, not a file -> EISDIR, a real
    // gateway fault distinct from "no artifact".
    await fs.mkdir(path.join(dir, "visual-manifest.json"));

    const res = await request(app).get(`/api/sessions/${id}/visual/manifest`);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});

describe("GET /api/sessions/:id/visual/screenshot/:file", () => {
  it("serves the PNG bytes with an image/png content type", async () => {
    const id = "20260822-000064-glimmer-screenshot-found";
    const dir = path.join(stateRoot, "sessions", id, "visual");
    await fs.mkdir(dir, { recursive: true });
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic bytes
    await fs.writeFile(path.join(dir, "1440x900.png"), pngBytes);

    const res = await request(app).get(`/api/sessions/${id}/visual/screenshot/1440x900.png`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect(Buffer.from(res.body)).toEqual(pngBytes);
  });

  it("returns 404 when the named screenshot does not exist", async () => {
    const id = "20260822-000065-glimmer-screenshot-missing";
    await fs.mkdir(path.join(stateRoot, "sessions", id, "visual"), { recursive: true });

    const res = await request(app).get(`/api/sessions/${id}/visual/screenshot/1440x900.png`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown/path-traversal session id before ever touching the filename", async () => {
    const res = await request(app).get("/api/sessions/..%2F..%2Fevil/visual/screenshot/1440x900.png");
    expect(res.status).toBe(404);
  });

  it.each([
    "..%2F..%2Fetc%2Fpasswd", // encoded traversal via slashes
    "..png", // no chars before the required .png suffix
    "foo%2Fbar.png", // encoded slash mid-name
    "foo_bar.png", // outside the strict allowed charset
    "1440x900.PNG", // wrong case extension
    "1440x900", // missing .png suffix entirely
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd.png", // fully-encoded traversal attempt
  ])("returns 400 for an invalid/traversal filename: %s", async (rawFile) => {
    const id = "20260822-000066-glimmer-screenshot-traversal";
    await fs.mkdir(path.join(stateRoot, "sessions", id, "visual"), { recursive: true });

    const res = await request(app).get(`/api/sessions/${id}/visual/screenshot/${rawFile}`);
    expect(res.status).toBe(400);
  });

  it("returns 500, not a crash, on a real fs read error", async () => {
    const id = "20260822-000067-glimmer-screenshot-fserror";
    const dir = path.join(stateRoot, "sessions", id, "visual");
    // A directory named like a valid screenshot filename -> EISDIR.
    await fs.mkdir(path.join(dir, "1440x900.png"), { recursive: true });

    const res = await request(app).get(`/api/sessions/${id}/visual/screenshot/1440x900.png`);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});

describe("opt-in artifact routes reject path-traversal ids", () => {
  it.each(["plan", "architect-reviews", "delivery-review", "delivery-packet", "tasks", "evidence"])(
    "GET /api/sessions/:id/%s returns 404 for a traversal id",
    async (routeName) => {
      const res = await request(app).get(`/api/sessions/..%2F..%2Fevil/${routeName}`);
      expect(res.status).toBe(404);
    }
  );
});

describe("POST /api/sessions/:id/ask", () => {
  it("returns 400 without a question", async () => {
    const res = await request(app).post("/api/sessions/some-id/ask").set("Origin", UI_ORIGIN).send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown session", async () => {
    const res = await request(app).post("/api/sessions/does-not-exist/ask").set("Origin", UI_ORIGIN).send({ question: "why?" });
    expect(res.status).toBe(404);
  });

  it("returns 502, not a crash, when the model is unreachable", async () => {
    const id = "20260817-000020-glimmer-ask-test";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({
      task: "test", status: "verified", workspace: "/tmp/ws", branch: "main", baseline: null, attempts: [],
    }));
    // Isolate this test's CONFIG.modelBaseUrl from the rest of the file:
    // CONFIG is a module-level const read at import time, so mutating the env
    // var alone would not affect the already-imported `app`. Reset the module
    // registry and re-import app.js under the new env var, mirroring
    // sessions.test.ts (lib)'s contractStateRoot isolation pattern.
    process.env.GLIMMER_MODEL_URL = "http://127.0.0.1:1"; // nothing listens here
    vi.resetModules();
    const { createApp: createAppFresh } = await import("../app.js");
    const appFresh = createAppFresh();
    const res = await request(appFresh).post(`/api/sessions/${id}/ask`).set("Origin", UI_ORIGIN).send({ question: "why?" });
    expect(res.status).toBe(502);
  });

  it("returns 500, not 502, when reading the session's own event log fails (a gateway fault, not the model's)", async () => {
    const id = "20260817-000021-glimmer-ask-fs-fault";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({
      task: "test", status: "verified", workspace: "/tmp/ws", branch: "main", baseline: null, attempts: [],
    }));
    // A directory named events.jsonl, not a file: fs.readFile on it fails
    // with EISDIR before askSessionAssistant (and therefore the model) is
    // ever reached — this must not be reported as "model unreachable" (502).
    await fs.mkdir(path.join(dir, "events.jsonl"));

    const res = await request(app).post(`/api/sessions/${id}/ask`).set("Origin", UI_ORIGIN).send({ question: "why?" });
    expect(res.status).toBe(500);
  });
});

describe("POST /api/sessions/:id/ask?stream=1", () => {
  async function makeSession(id: string): Promise<void> {
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({
      task: "test", status: "verified", workspace: "/tmp/ws", branch: "main", baseline: null, attempts: [],
    }));
  }

  // Isolate CONFIG.modelBaseUrl per test the same way the 502 test above
  // does: it's a module-level const read at import time, so the fake
  // upstream's URL must be set before `app.js` is (re-)imported.
  async function appWithUpstream(handler: http.RequestListener): Promise<{ app: Express; server: http.Server }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    process.env.GLIMMER_MODEL_URL = `http://127.0.0.1:${port}`;
    vi.resetModules();
    const { createApp } = await import("../app.js");
    return { app: createApp(), server };
  }

  it("streams chunked delta frames followed by a final done frame with the full answer", async () => {
    const id = "20260822-000001-glimmer-ask-stream-ok";
    await makeSession(id);
    const { app: streamApp, server } = await appWithUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "It owns " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "the parser state." } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    try {
      const res = await request(streamApp).post(`/api/sessions/${id}/ask?stream=1`).set("Origin", UI_ORIGIN).send({ question: "why?" });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      const frames = res.text.trim().split("\n\n").map((f) => JSON.parse(f.replace(/^data: /, "")));
      expect(frames).toEqual([
        { delta: "It owns " },
        { delta: "the parser state." },
        { done: true, answer: "It owns the parser state." },
      ]);
    } finally {
      server.close();
    }
  });

  it("emits an error frame, byte-identical to the non-streaming Unavailable path's cause, when the upstream fails mid-stream", async () => {
    const id = "20260822-000002-glimmer-ask-stream-midfail";
    await makeSession(id);
    const { app: streamApp, server } = await appWithUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Partial" } }] })}\n\n`);
      // Give the chunk a tick to actually flush to the client before the
      // connection dies mid-stream, so this genuinely exercises "some deltas
      // already arrived, then upstream failed" rather than a connection-time
      // failure.
      setTimeout(() => res.destroy(), 20);
    });
    try {
      const res = await request(streamApp).post(`/api/sessions/${id}/ask?stream=1`).set("Origin", UI_ORIGIN).send({ question: "why?" });
      expect(res.status).toBe(200);
      const frames = res.text.trim().split("\n\n").map((f) => JSON.parse(f.replace(/^data: /, "")));
      expect(frames[0]).toEqual({ delta: "Partial" });
      expect(frames[frames.length - 1]).toEqual({ error: "unavailable" });
    } finally {
      server.close();
    }
  });

  it("returns 400 without a question, same as the non-streaming path, before ever writing SSE headers", async () => {
    const res = await request(app).post("/api/sessions/some-id/ask?stream=1").set("Origin", UI_ORIGIN).send({});
    expect(res.status).toBe(400);
  });

  it("emits an error frame instead of a done frame when the upstream sends only [DONE] (empty concatenated answer)", async () => {
    const id = "20260822-000004-glimmer-ask-stream-empty-answer";
    await makeSession(id);
    const { app: streamApp, server } = await appWithUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: [DONE]\n\n");
    });
    try {
      const res = await request(streamApp).post(`/api/sessions/${id}/ask?stream=1`).set("Origin", UI_ORIGIN).send({ question: "why?" });
      expect(res.status).toBe(200);
      const frames = res.text.trim().split("\n\n").map((f) => JSON.parse(f.replace(/^data: /, "")));
      expect(frames).toEqual([{ error: "unavailable" }]);
      expect(frames.some((f: any) => f.done)).toBe(false); // never a done frame for an empty answer
    } finally {
      server.close();
    }
  });

  it("aborts the upstream request the moment the client disconnects mid-stream", async () => {
    const id = "20260822-000005-glimmer-ask-stream-client-disconnect";
    await makeSession(id);
    let upstreamGotClose = false;
    const { app: streamApp, server: upstreamServer } = await appWithUpstream((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
      req.on("close", () => { upstreamGotClose = true; });
      // Deliberately never ends on its own — only the gateway aborting on
      // client disconnect (or the test's own cleanup) ends this.
    });
    const gatewayServer: http.Server = await new Promise((resolve) => {
      const s = streamApp.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (gatewayServer.address() as any).port;

    try {
      await new Promise<void>((resolve, reject) => {
        const body = JSON.stringify({ question: "why?" });
        const clientReq = http.request(
          {
            hostname: "127.0.0.1", port, path: `/api/sessions/${id}/ask?stream=1`, method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              Origin: UI_ORIGIN, // writes need one (app.ts localOnlyGuard), same as a browser sends
            },
          },
          (res) => {
            res.once("data", () => clientReq.destroy()); // simulate the browser tab closing mid-stream
          }
        );
        clientReq.on("error", () => resolve()); // destroying our own socket surfaces as a local error here — expected
        clientReq.on("close", () => resolve());
        clientReq.on("timeout", () => reject(new Error("client request timed out")));
        clientReq.setTimeout(2000);
        clientReq.write(body);
        clientReq.end();
      });

      await new Promise((r) => setTimeout(r, 50)); // let 'close' propagate: Express req -> our AbortController -> upstream
      expect(upstreamGotClose).toBe(true);
    } finally {
      gatewayServer.close();
      upstreamServer.close();
    }
  });

  it("leaves the non-streaming response shape byte-compatible when ?stream=1 is absent", async () => {
    const id = "20260822-000003-glimmer-ask-nonstream-unchanged";
    await makeSession(id);
    const { app: streamApp, server } = await appWithUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "It owns the parser state." } }] }));
    });
    try {
      const res = await request(streamApp).post(`/api/sessions/${id}/ask`).set("Origin", UI_ORIGIN).send({ question: "why?" });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.body).toEqual({ answer: "It owns the parser state.", provenance: "model-output" });
    } finally {
      server.close();
    }
  });
});

// V7 §20 session-level verification freeze: GET /sessions/:id computes
// staleness (git-derived), GET /sessions (the list) deliberately does not
// (see the comment at that route and at readSession's computeStale option —
// a per-session git spawn on every list poll would scale with session
// count).
// V7 §20 review round 1: fixtures below model production ordering, not
// plain dirtiness -- glimmer-v2.py's collapse() leaves a real VERIFIED
// session's workspace with an uncommitted diff on purpose, so finalDiffHash
// (fingerprinted from that exact post-collapse state) is what staleness
// actually compares against, not `git status --porcelain`.
describe("stale verified-session detection (V7 §20)", () => {
  let staleWorkspace: string;
  let baselineSha: string;
  let postCollapseHash: string;
  const POST_COLLAPSE_CONTENT = "one\ntwo\n";

  beforeAll(async () => {
    staleWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-route-stale-ws-"));
    await execGit("git", ["init", "-q"], { cwd: staleWorkspace });
    await execGit("git", ["config", "user.email", "t@t.com"], { cwd: staleWorkspace });
    await execGit("git", ["config", "user.name", "t"], { cwd: staleWorkspace });
    await fs.writeFile(path.join(staleWorkspace, "a.txt"), "one\n");
    await execGit("git", ["add", "a.txt"], { cwd: staleWorkspace });
    await execGit("git", ["commit", "-q", "-m", "init"], { cwd: staleWorkspace });
    baselineSha = (await execGit("git", ["rev-parse", "HEAD"], { cwd: staleWorkspace })).stdout.trim();

    // Model collapse()'s end state: HEAD stays at baselineSha, working tree
    // holds the uncommitted diff -- finalDiffHash below is the real
    // computeDiffHash() fingerprint of exactly this state, same as
    // glimmer-v2.py's `finally` block computes it.
    await fs.writeFile(path.join(staleWorkspace, "a.txt"), POST_COLLAPSE_CONTENT);
    postCollapseHash = await computeDiffHash(staleWorkspace, baselineSha);
  });

  afterAll(async () => {
    await fs.rm(staleWorkspace, { recursive: true, force: true });
  });

  it("GET /sessions/:id reports plain verified right after collapse, before anything else touches the workspace", async () => {
    const id = "20260822-000009-glimmer-route-verified-unchanged";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        task: "test", status: "verified", verifiedAt: "2026-08-21T00:00:00.000Z",
        finalDiffHash: postCollapseHash, workspace: staleWorkspace, branch: "main",
        baseline: baselineSha, attempts: [],
      })
    );

    const res = await request(app).get(`/api/sessions/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("verified");
  });

  it("GET /sessions/:id reports stale once the workspace is modified again after collapse", async () => {
    await fs.writeFile(path.join(staleWorkspace, "a.txt"), "one\ntwo\nTHREE\n");
    const id = "20260822-000010-glimmer-route-stale";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        task: "test", status: "verified", verifiedAt: "2026-08-21T00:00:00.000Z",
        finalDiffHash: postCollapseHash, workspace: staleWorkspace, branch: "main",
        baseline: baselineSha, attempts: [],
      })
    );

    const res = await request(app).get(`/api/sessions/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("stale");

    await fs.writeFile(path.join(staleWorkspace, "a.txt"), POST_COLLAPSE_CONTENT); // restore
  });

  it("GET /sessions (list) does NOT compute staleness — the same modified verified session still reads as plain verified", async () => {
    await fs.writeFile(path.join(staleWorkspace, "a.txt"), "one\ntwo\nTHREE\n");
    const id = "20260822-000011-glimmer-route-stale-list";
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        task: "test", status: "verified", verifiedAt: "2026-08-21T00:00:00.000Z",
        finalDiffHash: postCollapseHash, workspace: staleWorkspace, branch: "main",
        baseline: baselineSha, attempts: [],
      })
    );

    const res = await request(app).get("/api/sessions");
    expect(res.status).toBe(200);
    const row = res.body.find((s: { id: string }) => s.id === id);
    expect(row?.status).toBe("verified");

    await fs.writeFile(path.join(staleWorkspace, "a.txt"), POST_COLLAPSE_CONTENT); // restore
  });
});
