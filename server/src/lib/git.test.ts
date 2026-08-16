import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitStatus, gitDiff, gitRevertFile } from "./git";

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

describe("gitRevertFile", () => {
  it("restores an allowed file", async () => {
    await gitRevertFile(repo, ["a.txt"], "a.txt");
    expect(await fs.readFile(path.join(repo, "a.txt"), "utf-8")).toBe("one\n");
  });

  it("refuses a file not in the allow-list", async () => {
    await fs.writeFile(path.join(repo, "a.txt"), "three\n");
    await expect(gitRevertFile(repo, ["other.txt"], "a.txt")).rejects.toThrow();
  });

  it("refuses a path-traversal attempt", async () => {
    await expect(gitRevertFile(repo, ["../secret.txt"], "../secret.txt")).rejects.toThrow();
  });
});
