import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
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

describe("GET /api/repository/index", () => {
  it("returns only an index matching the requested workspace or session", async () => {
    const id = "repo-index-found";
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-repo-index-ws-"));
    const dir = path.join(stateRoot, "sessions", id);
    const index = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      workspace,
      head: "abc",
      dirtyHash: "def",
      cacheKey: "key",
      parserVersions: { "tree-sitter": "0.26.0" },
      coverage: { ratio: 1 },
      files: [],
      symbols: [],
      edges: [],
      routes: [],
      tests: [],
      diagnostics: [],
    };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "repo-index.json"), JSON.stringify(index));
    const found = await request(app).get("/api/repository/index").query({ workspace });
    expect(found.status).toBe(200);
    expect(found.body.sourceSessionId).toBe(id);
    expect(found.body.cacheKey).toBe("key");
    expect(
      (
        await request(app)
          .get("/api/repository/index")
          .query({ workspace: `${workspace}-other` })
      ).status,
    ).toBe(404);
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// Task 7.5 (V7 "System Explorer"): docs/graph.json lives in a session's
// WORKSPACE (the target repo), not in the session dir — a real fixture
// needs both a manifest.json (so findDocGraph can learn the workspace path)
// and an actual workspace directory. Every case cleans its session + temp
// workspace up in afterEach: findDocGraph walks every session in the shared
// stateRoot, so a fixture left behind by one case would leak into the next
// case's expected result.
describe("GET /api/repository/doc-graph", () => {
  const graph = {
    schemaVersion: 1,
    nodes: [
      {
        id: "svc:gateway",
        type: "service",
        path: "server/src",
        title: "Gateway",
        status: "CURRENT",
        confidence: "high",
        provenance: { evidence: ["server/src/app.ts"], sha: "abc123" },
      },
    ],
    edges: [],
  };

  const createdIds: string[] = [];
  const createdWorkspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(
      createdIds
        .splice(0)
        .map((id) => fs.rm(path.join(stateRoot, "sessions", id), { recursive: true, force: true })),
    );
    await Promise.all(
      createdWorkspaces.splice(0).map((ws) => fs.rm(ws, { recursive: true, force: true })),
    );
  });

  async function makeSession(id: string, setup: (ws: string) => Promise<void>) {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-doc-graph-ws-"));
    createdWorkspaces.push(ws);
    await setup(ws);
    const dir = path.join(stateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    createdIds.push(id);
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        task: "test",
        status: "initialized",
        workspace: ws,
        branch: "main",
        baseline: null,
        attempts: [],
      }),
    );
  }

  it("returns the parsed docs/graph.json from a session's workspace when present, labeled with its source", async () => {
    let ws!: string;
    await makeSession("doc-graph-found", async (w) => {
      ws = w;
      await fs.mkdir(path.join(w, "docs"), { recursive: true });
      await fs.writeFile(path.join(w, "docs", "graph.json"), JSON.stringify(graph));
    });
    const res = await request(app).get("/api/repository/doc-graph");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...graph, source: { workspace: ws, sessionId: "doc-graph-found" } });
  });

  // M6 regression (round-7 review): findDocGraph walks every session
  // newest-first and returns the FIRST docs/graph.json it finds -- with two
  // sessions pointed at two different repos, that must never come back
  // unlabeled as "the" graph. Assert the response identifies which session
  // and workspace it actually came from, not just that some graph came back.
  it("labels the returned graph's source when multiple sessions have different workspaces", async () => {
    const otherGraph = {
      schemaVersion: 1,
      nodes: [{ ...graph.nodes[0], id: "svc:other" }],
      edges: [],
    };
    let wsA!: string;
    let wsB!: string;
    await makeSession("doc-graph-repo-a", async (ws) => {
      wsA = ws;
      await fs.mkdir(path.join(ws, "docs"), { recursive: true });
      await fs.writeFile(path.join(ws, "docs", "graph.json"), JSON.stringify(graph));
    });
    await makeSession("doc-graph-repo-b", async (ws) => {
      wsB = ws;
      await fs.mkdir(path.join(ws, "docs"), { recursive: true });
      await fs.writeFile(path.join(ws, "docs", "graph.json"), JSON.stringify(otherGraph));
    });
    const res = await request(app).get("/api/repository/doc-graph");
    expect(res.status).toBe(200);
    // Whichever one wins the "first found" walk, the response's `source`
    // must name that exact session/workspace -- never silently ambiguous.
    const winner =
      res.body.source.sessionId === "doc-graph-repo-a"
        ? { graph, ws: wsA }
        : { graph: otherGraph, ws: wsB };
    expect(res.body).toEqual({
      ...winner.graph,
      source: { workspace: winner.ws, sessionId: res.body.source.sessionId },
    });
  });

  it("returns 404 when no session's workspace has a docs/graph.json (opt-in artifact)", async () => {
    await makeSession("doc-graph-missing", async () => {});
    const res = await request(app).get("/api/repository/doc-graph");
    expect(res.status).toBe(404);
  });

  it("returns 404, not a crash, when docs/graph.json is malformed", async () => {
    await makeSession("doc-graph-malformed", async (ws) => {
      await fs.mkdir(path.join(ws, "docs"), { recursive: true });
      await fs.writeFile(path.join(ws, "docs", "graph.json"), "not json {{{");
    });
    const res = await request(app).get("/api/repository/doc-graph");
    expect(res.status).toBe(404);
  });
});
