import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
let readSessionEventsBatch: typeof import("./sessions.js").readSessionEventsBatch;
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
