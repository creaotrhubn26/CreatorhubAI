import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "wsmem-"));
  process.env.GLIMMER_STATE_ROOT = scratch;
  vi.resetModules();
});
afterEach(async () => {
  delete process.env.GLIMMER_STATE_ROOT;
  await fs.rm(scratch, { recursive: true, force: true });
});

async function makeRepoWithMemory(): Promise<string> {
  const workspace = path.join(scratch, "repo");
  await fs.mkdir(workspace, { recursive: true });
  await execFileAsync("git", ["init", "-q", workspace]);
  const { stdout } = await execFileAsync("git", ["-C", workspace, "rev-parse", "--git-common-dir"]);
  const commonDir = path.resolve(workspace, stdout.trim());
  const digest = createHash("sha256").update(commonDir).digest("hex").slice(0, 16);
  const directory = path.join(scratch, "memory", `repo-${digest}`);
  await fs.mkdir(directory, { recursive: true });
  const now = new Date();
  const old = new Date(now.getTime() - 90 * 86_400_000);
  await fs.writeFile(
    path.join(directory, "memory-v2.json"),
    JSON.stringify({
      schemaVersion: 2,
      repoIdentity: `repo-${digest}`,
      updatedAt: now.toISOString(),
      entries: [
        { kind: "cochange", key: "fresh", count: 5, lastSeen: now.toISOString() },
        { kind: "cochange", key: "stale", count: 5, lastSeen: old.toISOString() },
        { kind: "blocked-command", key: "floor", count: 1, lastSeen: now.toISOString() },
      ],
    }),
  );
  return workspace;
}

describe("workspace memory surface", () => {
  it("exposes entries with age and decayed score, freshest first", async () => {
    const workspace = await makeRepoWithMemory();
    const { readWorkspaceMemory } = await import("./workspaceMemory.js");
    const entries = await readWorkspaceMemory(workspace);
    expect(entries.map((entry) => entry.key)).toEqual(["fresh", "stale", "floor"]);
    expect(entries[0].ageDays).toBeLessThan(1);
    expect(entries[1].ageDays).toBeGreaterThan(80);
    expect(entries[1].score).toBeLessThan(entries[0].score);
    expect(entries[2].belowFloor).toBe(true);
  });

  it("deletes one entry as curation and reports a missing one honestly", async () => {
    const workspace = await makeRepoWithMemory();
    const { readWorkspaceMemory, deleteWorkspaceMemoryEntry } = await import(
      "./workspaceMemory.js"
    );
    expect(await deleteWorkspaceMemoryEntry(workspace, "cochange", "stale")).toBe(true);
    expect(await deleteWorkspaceMemoryEntry(workspace, "cochange", "stale")).toBe(false);
    const remaining = await readWorkspaceMemory(workspace);
    expect(remaining.map((entry) => entry.key)).toEqual(["fresh", "floor"]);
  });

  it("returns empty for a non-repository without touching anything", async () => {
    const { readWorkspaceMemory } = await import("./workspaceMemory.js");
    expect(await readWorkspaceMemory(path.join(scratch, "not-a-repo"))).toEqual([]);
  });
});
