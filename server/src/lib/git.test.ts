import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitStatus, gitDiff, gitRevertFile } from "./git.js";

const exec = promisify(execFile);
let repo: string;

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-git-test-"));
  await exec("git", ["init", "-q"], { cwd: repo });
  await exec("git", ["config", "user.email", "t@t.com"], { cwd: repo });
  await exec("git", ["config", "user.name", "t"], { cwd: repo });
  await fs.writeFile(path.join(repo, "a.txt"), "one\n");
  await exec("git", ["add", "a.txt"], { cwd: repo });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  await fs.writeFile(path.join(repo, "a.txt"), "two\n");
});

afterAll(async () => { await fs.rm(repo, { recursive: true, force: true }); });

describe("gitStatus", () => {
  it("reports branch, head, dirty, and changed files", async () => {
    const status = await gitStatus(repo);
    expect(status.dirty).toBe(true);
    expect(status.changedFiles).toEqual([{ path: "a.txt", status: "modified" }]);
    expect(status.headSha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("gitDiff", () => {
  it("returns a real unified diff", async () => {
    const diff = await gitDiff(repo);
    expect(diff).toContain("-one");
    expect(diff).toContain("+two");
  });
});

describe("gitDiff with an untracked (new) file", () => {
  it("renders the new file's content as an addition-only patch, not empty output", async () => {
    await fs.writeFile(path.join(repo, "new-file.txt"), "brand new content\nsecond line\n");

    const diff = await gitDiff(repo, ["new-file.txt"]);

    expect(diff).toContain("new-file.txt");
    expect(diff).toContain("+brand new content");
    expect(diff).toContain("+second line");
  });

  it("still diffs a modified tracked path normally when mixed with an untracked one", async () => {
    await fs.writeFile(path.join(repo, "mixed-new.txt"), "untracked content\n");

    const diff = await gitDiff(repo, ["a.txt", "mixed-new.txt"]);

    expect(diff).toContain("-one"); // a.txt tracked modification (set up in beforeAll)
    expect(diff).toContain("+two");
    expect(diff).toContain("+untracked content");
  });
});

describe("gitRevertFile", () => {
  it("restores an allowed file to the given baseline commit", async () => {
    const baselineSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await gitRevertFile(repo, ["a.txt"], "a.txt", baselineSha);
    expect(await fs.readFile(path.join(repo, "a.txt"), "utf-8")).toBe("one\n");
  });

  it("refuses a file not in the allow-list", async () => {
    const baselineSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await fs.writeFile(path.join(repo, "a.txt"), "three\n");
    await expect(gitRevertFile(repo, ["other.txt"], "a.txt", baselineSha)).rejects.toThrow();
  });

  it("refuses a path-traversal attempt", async () => {
    const baselineSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await expect(gitRevertFile(repo, ["../secret.txt"], "../secret.txt", baselineSha)).rejects.toThrow();
  });

  it("refuses to revert when no baseline commit is known, instead of silently trusting HEAD", async () => {
    await expect(gitRevertFile(repo, ["a.txt"], "a.txt", "")).rejects.toThrow(/baseline/i);
  });

  // F4 (data-loss bug): the session's baselineSha is the commit it actually
  // started from. HEAD can move on past that (e.g. another commit lands on
  // this branch while the session is running) — reverting must restore this
  // file to baseline's content, NOT whatever's at HEAD/index by the time
  // Revert is clicked. The old buggy implementation (`git checkout -- file`)
  // would restore from HEAD here and get "post-baseline\n", which is wrong.
  it("restores to the baseline commit's content, not to a HEAD that has since moved on", async () => {
    const isolated = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-git-baseline-test-"));
    try {
      await exec("git", ["init", "-q"], { cwd: isolated });
      await exec("git", ["config", "user.email", "t@t.com"], { cwd: isolated });
      await exec("git", ["config", "user.name", "t"], { cwd: isolated });
      await fs.writeFile(path.join(isolated, "b.txt"), "baseline-content\n");
      await exec("git", ["add", "b.txt"], { cwd: isolated });
      await exec("git", ["commit", "-q", "-m", "baseline"], { cwd: isolated });
      const baselineSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: isolated })).stdout.trim();

      // A commit lands AFTER the session's baseline (e.g. someone else pushed,
      // or the orchestrator committed something) — HEAD is now ahead of
      // baselineSha, with different committed content for the same file.
      await fs.writeFile(path.join(isolated, "b.txt"), "post-baseline\n");
      await exec("git", ["commit", "-aq", "-m", "moved on"], { cwd: isolated });

      // The session's own (uncommitted) edit, made after that commit landed.
      await fs.writeFile(path.join(isolated, "b.txt"), "session-edit\n");

      await gitRevertFile(isolated, ["b.txt"], "b.txt", baselineSha);

      expect(await fs.readFile(path.join(isolated, "b.txt"), "utf-8")).toBe("baseline-content\n");
    } finally {
      await fs.rm(isolated, { recursive: true, force: true });
    }
  });
});
