import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  gitStatus, gitDiff, gitRevertFile, computeDiffHash, parseGitDiffHunks, gitRejectHunk, GitHunkReviewError,
} from "./git.js";

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

describe("per-hunk diff review", () => {
  async function hunkRepo(): Promise<string> {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-hunk-git-"));
    await exec("git", ["init", "-q"], { cwd: ws });
    await exec("git", ["config", "user.email", "t@t.com"], { cwd: ws });
    await exec("git", ["config", "user.name", "t"], { cwd: ws });
    await fs.writeFile(path.join(ws, "review.txt"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    await exec("git", ["add", "review.txt"], { cwd: ws });
    await exec("git", ["commit", "-q", "-m", "baseline"], { cwd: ws });
    return ws;
  }

  it("parses and reverse-applies only the selected canonical hunk", async () => {
    const ws = await hunkRepo();
    try {
      const lines = (await fs.readFile(path.join(ws, "review.txt"), "utf8")).trimEnd().split("\n");
      lines[1] = "line 2 changed";
      lines[24] = "line 25 changed";
      await fs.writeFile(path.join(ws, "review.txt"), lines.join("\n") + "\n");
      const hunks = parseGitDiffHunks(await gitDiff(ws, ["review.txt"]));
      expect(hunks).toHaveLength(2);
      expect(hunks.every((hunk) => hunk.path === "review.txt")).toBe(true);

      await gitRejectHunk(ws, ["review.txt"], "review.txt", hunks[1].id);

      const content = await fs.readFile(path.join(ws, "review.txt"), "utf8");
      expect(content).toContain("line 2 changed");
      expect(content).toContain("line 25\n");
      expect(content).not.toContain("line 25 changed");
      expect(parseGitDiffHunks(await gitDiff(ws, ["review.txt"]))).toHaveLength(1);
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("keeps a later hunk id stable when an earlier insertion is rejected", async () => {
    const ws = await hunkRepo();
    try {
      const lines = (await fs.readFile(path.join(ws, "review.txt"), "utf8")).trimEnd().split("\n");
      lines.splice(1, 0, "inserted near start");
      lines[25] = "line 25 changed";
      await fs.writeFile(path.join(ws, "review.txt"), lines.join("\n") + "\n");
      const before = parseGitDiffHunks(await gitDiff(ws, ["review.txt"]));
      expect(before).toHaveLength(2);

      await gitRejectHunk(ws, ["review.txt"], "review.txt", before[0].id);

      const after = parseGitDiffHunks(await gitDiff(ws, ["review.txt"]));
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(before[1].id);
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("rejects an untracked file hunk by removing only that new file", async () => {
    const ws = await hunkRepo();
    try {
      await fs.writeFile(path.join(ws, "brand new.txt"), "first\nsecond\n");
      const hunks = parseGitDiffHunks(await gitDiff(ws, ["brand new.txt"]));
      expect(hunks).toHaveLength(1);
      expect(hunks[0].path).toBe("brand new.txt");

      await gitRejectHunk(ws, ["brand new.txt"], "brand new.txt", hunks[0].id);

      await expect(fs.stat(path.join(ws, "brand new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("refuses a stale or unscoped hunk id without changing the file", async () => {
    const ws = await hunkRepo();
    try {
      await fs.writeFile(path.join(ws, "review.txt"), "changed\n");
      const before = await fs.readFile(path.join(ws, "review.txt"), "utf8");
      await expect(gitRejectHunk(ws, ["review.txt"], "review.txt", "0".repeat(64)))
        .rejects.toMatchObject<Partial<GitHunkReviewError>>({ status: 409 });
      await expect(gitRejectHunk(ws, ["other.txt"], "review.txt", "0".repeat(64)))
        .rejects.toMatchObject<Partial<GitHunkReviewError>>({ status: 403 });
      expect(await fs.readFile(path.join(ws, "review.txt"), "utf8")).toBe(before);
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});

// V7 §20 — CROSS-LANGUAGE CONTRACT TEST. computeDiffHash must produce
// byte-identical output to glimmer-v2.py's diff_hash() for the same inputs,
// or session-level stale detection silently breaks (a drift here would
// still "work" — it would just always disagree with the orchestrator).
// This is not a hand-derived expected value: it's the real output of the
// real Python function, captured once against this exact fixture, so a
// future edit to either side's hashing logic that breaks the contract fails
// this test instead of shipping silently.
describe("computeDiffHash — cross-language contract with glimmer-v2.py's diff_hash()", () => {
  it("matches the real Python diff_hash() output for a fixed tracked+untracked fixture", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-diffhash-contract-"));
    try {
      await exec("git", ["init", "-q"], { cwd: ws });
      await exec("git", ["config", "user.email", "t@t.com"], { cwd: ws });
      await exec("git", ["config", "user.name", "t"], { cwd: ws });
      await fs.writeFile(path.join(ws, "a.txt"), "one\n");
      await exec("git", ["add", "a.txt"], { cwd: ws });
      await exec("git", ["commit", "-q", "-m", "init"], { cwd: ws });
      const baseline = (await exec("git", ["rev-parse", "HEAD"], { cwd: ws })).stdout.trim();

      // Uncommitted tracked change + one untracked file -- exercises both
      // halves of diff_hash's input.
      await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\n");
      await fs.writeFile(path.join(ws, "new.txt"), "brand new\n");

      const hash = await computeDiffHash(ws, baseline);

      // Golden value, produced once by running the REAL glimmer-v2.py
      // diff_hash() against this exact fixture (same commands/content as
      // above):
      //   python3 -c '
      //     import importlib.util, pathlib
      //     spec = importlib.util.spec_from_file_location(
      //         "glimmer_v2", "/path/to/glimmer-v2.py")
      //     mod = importlib.util.module_from_spec(spec)
      //     spec.loader.exec_module(mod)
      //     print(mod.diff_hash(pathlib.Path(ws), baseline))
      //   '
      // (run with cwd=repo root so glimmer-v2.py's sibling imports resolve)
      expect(hash).toBe("023ec2dbdcc21fa531e402476a0c2dfa84be7d6910f16733d372492969d08311");
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});

describe("computeDiffHash — bounded timeout", () => {
  // MED (review round 1): this runs on a route a session screen polls every
  // 4s -- a hung mount/filesystem must error out fast, not hang the request
  // forever. A 1ms timeout can't complete even a trivial `git diff`
  // spawn+exec, so this proves the timeoutMs option actually reaches the
  // underlying process (both the diff spawn and the ls-files spawn), rather
  // than just being accepted and ignored.
  it("rejects instead of hanging when timeoutMs is too small for the git process to complete", async () => {
    await expect(computeDiffHash(repo, "HEAD", { timeoutMs: 1 })).rejects.toThrow();
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
