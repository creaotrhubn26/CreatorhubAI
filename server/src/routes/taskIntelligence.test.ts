import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";

// Isolate from the real ~/.muse-glimmer state by pointing GLIMMER_STATE_ROOT
// at a throwaway temp dir before importing anything that reads config at
// module-load time.
let app: Express;
let stateRoot: string;
let repoMapPath: string;

const REPO_MAP = {
  generatedAt: "2026-08-17T00:00:00Z",
  workspace: "/ws",
  branch: "glimmer/x",
  head: "abc",
  upstream: null,
  packages: [
    {
      path: "frontend/package.json",
      dir: "frontend",
      name: "creatorhub-frontend",
      scripts: { typecheck: "tsc --noEmit" },
      frameworks: ["React"],
      engines: null,
      workspaces: null,
    },
  ],
};

beforeAll(async () => {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-ti-root-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;

  const sessionDir = path.join(stateRoot, "sessions", "20260817-000000-glimmer-x");
  await fs.mkdir(sessionDir, { recursive: true });
  repoMapPath = path.join(sessionDir, "repo-map.json");
  await fs.writeFile(repoMapPath, JSON.stringify(REPO_MAP));

  const { createApp } = await import("../app.js");
  app = createApp();
});

afterAll(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true });
});

describe("GET /api/task-intelligence", () => {
  it("infers area/package/suggested-verification from a real repo map, marks provenance", async () => {
    const res = await request(app).get("/api/task-intelligence?scopePackage=frontend");
    expect(res.status).toBe(200);
    expect(res.body.likelyArea).toBe("frontend");
    expect(res.body.likelyPackage).toBe("creatorhub-frontend");
    expect(res.body.suggestedVerification).toContain("frontend-typecheck");
    expect(res.body.provenance).toBe("git-derived");
    expect(res.body.estimatedRisk).toBeNull(); // honest: no changed files exist yet pre-run
  });

  it("returns nulls, not fabricated data, when no repo map exists anywhere", async () => {
    // Remove the fixture repo-map.json so findRepoMap() has nothing to scan.
    await fs.rm(repoMapPath);

    const res = await request(app).get("/api/task-intelligence?scopePackage=repository");
    expect(res.status).toBe(200);
    expect(res.body.likelyArea).toBeNull();
    expect(res.body.likelyPackage).toBeNull();
    expect(res.body.provenance).toBe("deterministic-backend");
    expect(res.body.estimatedRisk).toBeNull();
  });

  it("defaults an invalid scopePackage instead of passing it through unchecked", async () => {
    const res = await request(app).get("/api/task-intelligence?scopePackage=not-a-real-scope");
    expect(res.status).toBe(200);
    // Falls back to "repository" scope, which has no area/package inference.
    expect(res.body.likelyArea).toBeNull();
    expect(res.body.likelyPackage).toBeNull();
  });
});
