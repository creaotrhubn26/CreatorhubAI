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

  // Task 9.3b (V7 §5.5/§46): estimatedRisk ported from glimmer-v2.py's
  // compute_architect_risk -- opt-in only, so a caller that sends none of
  // the risk hints (the three tests above) keeps the exact honest null it
  // always got.
  it("stays null when no risk hint query params are given, even with scopePackage=repository", async () => {
    const res = await request(app).get("/api/task-intelligence?scopePackage=repository");
    expect(res.status).toBe(200);
    expect(res.body.estimatedRisk).toBeNull();
  });

  it("scores mode=refactor + scopePackage=repository as HIGH (score 5, at the auto-trigger threshold)", async () => {
    const res = await request(app).get("/api/task-intelligence?scopePackage=repository&mode=refactor");
    expect(res.status).toBe(200);
    expect(res.body.estimatedRisk).toBe("HIGH");
  });

  it("scores a plain frontend/implement/minimal request as LOW (zero signals)", async () => {
    const res = await request(app).get(
      "/api/task-intelligence?scopePackage=frontend&mode=implement&verificationLevel=minimal"
    );
    expect(res.status).toBe(200);
    expect(res.body.estimatedRisk).toBe("LOW");
  });

  it("stacks every signal to CRITICAL (mode=refactor + repository + protected keyword + full verification + high candidate count)", async () => {
    const res = await request(app).get(
      "/api/task-intelligence?scopePackage=repository&mode=refactor&objective=" +
        encodeURIComponent("rotate the auth secrets") +
        "&verificationLevel=full&candidateCount=9"
    );
    expect(res.status).toBe(200);
    expect(res.body.estimatedRisk).toBe("CRITICAL");
  });

  // Task 4c(b): findRepoMap() returns the first repo map found across ALL
  // sessions — for the composer, which is always composing against one
  // workspace, that can be an entirely unrelated repository presented as the
  // user's own. These cases pin the workspace-scoped resolution and, above
  // all, that a workspace with no repo map gets nulls rather than someone
  // else's data.
  describe("workspace-scoped repo map", () => {
    let workspace: string;
    let otherWorkspace: string;
    const wsSessionId = "20260818-000000-glimmer-ws";

    beforeAll(async () => {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-ti-ws-"));
      otherWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-ti-other-ws-"));
      const dir = path.join(stateRoot, "sessions", wsSessionId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "manifest.json"),
        JSON.stringify({ task: "t", status: "initialized", workspace, branch: "main", baseline: null, attempts: [] })
      );
      await fs.writeFile(path.join(dir, "repo-map.json"), JSON.stringify({ ...REPO_MAP, workspace }));
    });

    afterAll(async () => {
      await fs.rm(path.join(stateRoot, "sessions", wsSessionId), { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(otherWorkspace, { recursive: true, force: true });
    });

    it("resolves the repo map belonging to the workspace the caller named", async () => {
      const res = await request(app).get(
        `/api/task-intelligence?scopePackage=frontend&workspace=${encodeURIComponent(workspace)}`
      );
      expect(res.status).toBe(200);
      expect(res.body.likelyArea).toBe("frontend");
      expect(res.body.likelyPackage).toBe("creatorhub-frontend");
      expect(res.body.repoMapStatus).toBe("workspace-matched");
      expect(res.body.provenance).toBe("git-derived");
    });

    it("returns nulls — never another repository's map — for a workspace no session has run in", async () => {
      const res = await request(app).get(
        `/api/task-intelligence?scopePackage=frontend&workspace=${encodeURIComponent(otherWorkspace)}`
      );
      expect(res.status).toBe(200);
      expect(res.body.likelyArea).toBeNull();
      expect(res.body.likelyPackage).toBeNull();
      expect(res.body.suggestedVerification).toEqual([]);
      expect(res.body.repoMapStatus).toBe("unmatched-workspace");
      expect(res.body.provenance).toBe("deterministic-backend");
    });

    it("labels a request that names no workspace as first-found rather than implying it is the caller's repo", async () => {
      const res = await request(app).get("/api/task-intelligence?scopePackage=frontend");
      expect(res.status).toBe(200);
      expect(res.body.repoMapStatus).toBe("first-found");
    });

    it("still scores risk for an unmatched workspace — risk needs no repo map", async () => {
      const res = await request(app).get(
        `/api/task-intelligence?scopePackage=repository&mode=refactor&workspace=${encodeURIComponent(otherWorkspace)}`
      );
      expect(res.body.estimatedRisk).toBe("HIGH");
      expect(res.body.repoMapStatus).toBe("unmatched-workspace");
    });
  });

  it("only counts a candidateCount strictly above the threshold (5)", async () => {
    const atThreshold = await request(app).get(
      "/api/task-intelligence?scopePackage=frontend&mode=implement&candidateCount=5"
    );
    expect(atThreshold.body.estimatedRisk).toBe("LOW");
    const aboveThreshold = await request(app).get(
      "/api/task-intelligence?scopePackage=frontend&mode=implement&candidateCount=6"
    );
    expect(aboveThreshold.body.estimatedRisk).toBe("MEDIUM");
  });
});
