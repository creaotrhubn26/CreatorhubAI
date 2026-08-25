import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated in its own file so CONFIG.sourceRepo (frozen from process.env at
// module load) can point at a directory that is deliberately NOT a git repo,
// without disturbing the real-repo fixtures other createWorkspace tests use.
let notARepo: string;

beforeAll(async () => {
  notARepo = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-wc-notrepo-"));
  process.env.GLIMMER_SOURCE_REPO = notARepo;
  process.env.GLIMMER_WORKTREE_ROOT = await fs.mkdtemp(
    path.join(os.tmpdir(), "glimmer-wc-notrepo-worktrees-"),
  );
});

afterAll(async () => {
  await fs.rm(notARepo, { recursive: true, force: true });
});

describe("createWorkspace — sanity precheck", () => {
  it("returns a clear 500 when CONFIG.sourceRepo does not exist / isn't a git repo", async () => {
    const { createWorkspace, WorkspaceCreateError } = await import("./git.js");
    const err = await createWorkspace("no repo task").catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceCreateError);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/not a git repository|does not exist/i);
  });
});
