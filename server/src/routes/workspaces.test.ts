import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";

// Writes require an allowed Origin (app.ts localOnlyGuard): a browser always
// sends one on a state-changing request, so the tests speak the same way.
const UI_ORIGIN = "http://127.0.0.1:5183";

const exec = promisify(execFile);

// Same isolation convention as routes.test.ts: point every CONFIG-relevant
// env var at throwaway fixtures before the first import of app.js (CONFIG is
// frozen from process.env at module load). §27/§4.1 workspace creation also
// needs a real source repo + bare "origin" remote so `git fetch origin` and
// `origin/main` genuinely resolve, same as createWorkspace.test.ts's lib-level
// fixtures — this file adds HTTP-shape coverage on top (validation, status
// codes, and that GET /workspaces is untouched).
let app: Express;
let stateRoot: string;
let sourceRepo: string;
let bareOrigin: string;
let worktreeRoot: string;

beforeAll(async () => {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-workspaces-route-state-"));
  sourceRepo = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-workspaces-route-source-"));
  bareOrigin = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-workspaces-route-origin-"));
  worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-workspaces-route-worktrees-"));

  await exec("git", ["init", "-q", "-b", "main", sourceRepo]);
  await exec("git", ["config", "user.email", "t@t.com"], { cwd: sourceRepo });
  await exec("git", ["config", "user.name", "t"], { cwd: sourceRepo });
  await fs.writeFile(path.join(sourceRepo, "a.txt"), "one\n");
  await exec("git", ["add", "a.txt"], { cwd: sourceRepo });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: sourceRepo });
  await exec("git", ["init", "-q", "--bare", bareOrigin]);
  await exec("git", ["remote", "add", "origin", bareOrigin], { cwd: sourceRepo });
  await exec("git", ["push", "-q", "origin", "main"], { cwd: sourceRepo });

  process.env.GLIMMER_STATE_ROOT = stateRoot;
  process.env.GLIMMER_MODEL_URL = "http://127.0.0.1:1"; // nothing listens here
  process.env.GLIMMER_SOURCE_REPO = sourceRepo;
  process.env.GLIMMER_WORKTREE_ROOT = worktreeRoot;
  process.env.GLIMMER_WORKTREE_BASE = "origin/main";

  const { createApp } = await import("../app.js");
  app = createApp();
});

afterAll(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true });
  await fs.rm(sourceRepo, { recursive: true, force: true });
  await fs.rm(bareOrigin, { recursive: true, force: true });
  await fs.rm(worktreeRoot, { recursive: true, force: true });
});

describe("GET /api/workspaces (untouched)", () => {
  it("still returns an array, with no session-backed workspaces in this fixture", async () => {
    const res = await request(app).get("/api/workspaces");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// Task 4c(2/3): the composer's path pickers in a plain browser. Read-only,
// names only, and contained — these cases exist mostly to pin the containment
// rules, since this is the gateway's only filesystem-listing endpoint.
describe("GET /api/fs/dirs", () => {
  let browseRoot: string;
  let outside: string;

  beforeAll(async () => {
    // realpath: macOS tmpdir is a symlink (/var -> /private/var) and the route
    // compares resolved paths, so the fixture must be expressed the same way.
    browseRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-browse-root-")));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-browse-outside-")));
    process.env.GLIMMER_BROWSE_ROOT = browseRoot;

    await fs.mkdir(path.join(browseRoot, "project", "src"), { recursive: true });
    await fs.writeFile(path.join(browseRoot, "project", "README.md"), "hi");
    await fs.writeFile(path.join(browseRoot, "project", ".hidden"), "x");
    await fs.writeFile(path.join(outside, "secret.txt"), "top secret");
    await fs.symlink(outside, path.join(browseRoot, "escape-hatch"));
  });

  afterAll(async () => {
    delete process.env.GLIMMER_BROWSE_ROOT;
    await fs.rm(browseRoot, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("lists subdirectory names only, hiding files and dotfiles by default", async () => {
    const res = await request(app).get(`/api/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, "project"))}`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([{ name: "src", isDir: true }]);
    expect(res.body.path).toBe(path.join(browseRoot, "project"));
    expect(res.body.truncated).toBe(false);
  });

  it("includes file names (never contents) when includeFiles=1", async () => {
    const res = await request(app).get(
      `/api/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, "project"))}&includeFiles=1`
    );
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([
      { name: "README.md", isDir: false },
      { name: "src", isDir: true },
    ]);
    expect(JSON.stringify(res.body)).not.toContain("hi");
  });

  it("reports no parent at the root, so the UI can never walk above it", async () => {
    const res = await request(app).get(`/api/fs/dirs?path=${encodeURIComponent(browseRoot)}`);
    expect(res.status).toBe(200);
    expect(res.body.parent).toBeNull();
  });

  it("rejects ../ traversal out of the browse root", async () => {
    const res = await request(app).get(`/api/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, "..", ".."))}`);
    expect(res.status).toBe(403);
  });

  it("rejects an absolute path outside the browse root", async () => {
    const res = await request(app).get(`/api/fs/dirs?path=${encodeURIComponent(outside)}`);
    expect(res.status).toBe(403);
  });

  it("rejects a symlink that escapes the root, even though it lives inside it", async () => {
    const res = await request(app).get(`/api/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, "escape-hatch"))}`);
    expect(res.status).toBe(403);
  });

  it("rejects a caller-supplied root outside the browse root (scope picker can't widen the boundary)", async () => {
    const res = await request(app).get(
      `/api/fs/dirs?root=${encodeURIComponent(outside)}&path=${encodeURIComponent(outside)}`
    );
    expect(res.status).toBe(403);
  });

  it("confines the listing to a caller-supplied root inside the boundary", async () => {
    const root = path.join(browseRoot, "project");
    const inside = await request(app).get(
      `/api/fs/dirs?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path.join(root, "src"))}`
    );
    expect(inside.status).toBe(200);
    expect(inside.body.parent).toBe(root);

    const above = await request(app).get(
      `/api/fs/dirs?root=${encodeURIComponent(root)}&path=${encodeURIComponent(browseRoot)}`
    );
    expect(above.status).toBe(403);
  });

  it("404s for a path that does not exist, and 400s for a file", async () => {
    const missing = await request(app).get(`/api/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, "nope"))}`);
    expect(missing.status).toBe(404);
    const file = await request(app).get(
      `/api/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, "project", "README.md"))}`
    );
    expect(file.status).toBe(400);
  });
});

describe("POST /api/workspaces — validation", () => {
  it("400s when taskName is missing", async () => {
    const res = await request(app).post("/api/workspaces").set("Origin", UI_ORIGIN).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/taskname/i);
  });

  it("400s when taskName is not a string", async () => {
    const res = await request(app).post("/api/workspaces").set("Origin", UI_ORIGIN).send({ taskName: 42 });
    expect(res.status).toBe(400);
  });

  it("400s when taskName sanitizes to an empty slug", async () => {
    const res = await request(app).post("/api/workspaces").set("Origin", UI_ORIGIN).send({ taskName: "!!!///???" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/workspaces — success", () => {
  it("creates a real branch+worktree and returns {workspace, branch, baselineSha}", async () => {
    const res = await request(app).post("/api/workspaces").set("Origin", UI_ORIGIN).send({ taskName: "route level task" });
    expect(res.status).toBe(200);
    expect(res.body.branch).toMatch(/^glimmer\/route-level-task-\d{8}-\d{6}$/);
    expect(typeof res.body.baselineSha).toBe("string");
    expect(path.resolve(res.body.workspace).startsWith(path.resolve(worktreeRoot) + path.sep)).toBe(true);

    const headSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: res.body.workspace })).stdout.trim();
    expect(headSha).toBe(res.body.baselineSha);
  });
});

describe("POST /api/workspaces — concurrency", () => {
  it("returns 409 for a second request fired while the first is still in flight", async () => {
    const [r1, r2] = await Promise.all([
      request(app).post("/api/workspaces").set("Origin", UI_ORIGIN).send({ taskName: "concurrent-route-a" }),
      request(app).post("/api/workspaces").set("Origin", UI_ORIGIN).send({ taskName: "concurrent-route-b" }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});
