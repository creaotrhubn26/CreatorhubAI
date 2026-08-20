import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);

// Isolated in its own file so CONFIG.sourceRepo (frozen from process.env at
// module load) can point at a real repo whose `origin` remote is broken —
// exercises the same catch/502 path a real 120s fetch timeout would take,
// without actually waiting 120s in the test suite.
let brokenSource: string;

beforeAll(async () => {
  brokenSource = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-wc-broken-"));
  await exec("git", ["init", "-q", "-b", "main", brokenSource]);
  await exec("git", ["config", "user.email", "t@t.com"], { cwd: brokenSource });
  await exec("git", ["config", "user.name", "t"], { cwd: brokenSource });
  await fs.writeFile(path.join(brokenSource, "a.txt"), "one\n");
  await exec("git", ["add", "a.txt"], { cwd: brokenSource });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: brokenSource });
  await exec("git", ["remote", "add", "origin", "/nonexistent/does-not-exist"], { cwd: brokenSource });

  process.env.GLIMMER_SOURCE_REPO = brokenSource;
  process.env.GLIMMER_WORKTREE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-wc-broken-worktrees-"));
});

afterAll(async () => {
  await fs.rm(brokenSource, { recursive: true, force: true });
});

describe("createWorkspace — fetch failure", () => {
  it("maps a git fetch failure to a 502 with an honest message, never touching the worktree step", async () => {
    const { createWorkspace, WorkspaceCreateError } = await import("./git.js");
    const err = await createWorkspace("fetch fail task").catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceCreateError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/fetch/i);
    // Never got far enough to create anything -> no partial to report.
    expect(err.partial).toBeUndefined();
  });
});
