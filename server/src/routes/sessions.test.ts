import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import type { Express } from "express";

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
      .post("/api/sessions/..%2F..%2Fevil/revert-file")
      .send({ path: "a.txt" });
    expect(res.status).toBe(404);
  });
});

// §14 Diff Review — human "accept for review" action, distinct from
// technical verification. Server-side contract: gateway-owned sidecar,
// idempotent, 404 for an unknown session.
describe("POST /api/sessions/:id/accept", () => {
  it("returns 404 for an unknown session", async () => {
    const res = await request(app).post("/api/sessions/does-not-exist/accept");
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

    const res = await request(app).post(`/api/sessions/${id}/accept`);
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

    const first = await request(app).post(`/api/sessions/${id}/accept`);
    const second = await request(app).post(`/api/sessions/${id}/accept`);
    expect(second.body).toEqual(first.body);
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
      .post("/api/sessions")
      .send({ taskContract: { ...validBase, maxTurns: 100 }, workspace: "/tmp/ws" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects timeoutSeconds out of 60..3600 range with 400", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .send({ taskContract: { ...validBase, advanced: { timeoutSeconds: 5 } }, workspace: "/tmp/ws" });
    expect(res.status).toBe(400);
  });

  it("rejects a toolchainMode outside the closed enum with 400", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .send({ taskContract: { ...validBase, advanced: { toolchainMode: "rm -rf /" } }, workspace: "/tmp/ws" });
    expect(res.status).toBe(400);
  });

  it("rejects an unparseable/injection-attempt modelReadinessUrl with 400", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .send({ taskContract: { ...validBase, advanced: { modelReadinessUrl: "http://x; rm -rf /" } }, workspace: "/tmp/ws" });
    expect(res.status).toBe(400);
  });

  it("rejects a non-http(s) modelReadinessUrl scheme with 400", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .send({ taskContract: { ...validBase, advanced: { modelReadinessUrl: "javascript:alert(1)" } }, workspace: "/tmp/ws" });
    expect(res.status).toBe(400);
  });

  it("accepts a well-formed advanced block", async () => {
    const res = await request(app).post("/api/sessions").send({
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

  it("POST /run persists the task contract so it survives pendingContracts being cleared", async () => {
    const created = await request(app)
      .post("/api/sessions")
      .send({ taskContract: validContract, workspace: "/tmp/ws" });
    const id = created.body.id;
    await request(app).post(`/api/sessions/${id}/run`);
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

describe("opt-in artifact routes reject path-traversal ids", () => {
  it.each(["plan", "architect-reviews", "delivery-review", "tasks"])(
    "GET /api/sessions/:id/%s returns 404 for a traversal id",
    async (routeName) => {
      const res = await request(app).get(`/api/sessions/..%2F..%2Fevil/${routeName}`);
      expect(res.status).toBe(404);
    }
  );
});

describe("POST /api/sessions/:id/ask", () => {
  it("returns 400 without a question", async () => {
    const res = await request(app).post("/api/sessions/some-id/ask").send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown session", async () => {
    const res = await request(app).post("/api/sessions/does-not-exist/ask").send({ question: "why?" });
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
    const res = await request(appFresh).post(`/api/sessions/${id}/ask`).send({ question: "why?" });
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

    const res = await request(app).post(`/api/sessions/${id}/ask`).send({ question: "why?" });
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
      const res = await request(streamApp).post(`/api/sessions/${id}/ask?stream=1`).send({ question: "why?" });
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
      const res = await request(streamApp).post(`/api/sessions/${id}/ask?stream=1`).send({ question: "why?" });
      expect(res.status).toBe(200);
      const frames = res.text.trim().split("\n\n").map((f) => JSON.parse(f.replace(/^data: /, "")));
      expect(frames[0]).toEqual({ delta: "Partial" });
      expect(frames[frames.length - 1]).toEqual({ error: "unavailable" });
    } finally {
      server.close();
    }
  });

  it("returns 400 without a question, same as the non-streaming path, before ever writing SSE headers", async () => {
    const res = await request(app).post("/api/sessions/some-id/ask?stream=1").send({});
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
      const res = await request(streamApp).post(`/api/sessions/${id}/ask?stream=1`).send({ question: "why?" });
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
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
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
      const res = await request(streamApp).post(`/api/sessions/${id}/ask`).send({ question: "why?" });
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
