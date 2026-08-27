import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let stateRoot: string;
let workspace: string;
let leases: typeof import("./workspaceLeases.js");

beforeAll(async () => {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-leases-state-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-leases-workspace-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;
  vi.resetModules();
  leases = await import("./workspaceLeases.js");
});

afterAll(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("durable workspace leases", () => {
  it("allows only one session to own a canonical workspace", async () => {
    const first = await leases.acquireWorkspaceLease(workspace, "session-a");
    expect(first.state).toBe("reserved");
    await expect(leases.acquireWorkspaceLease(workspace, "session-b")).rejects.toMatchObject({
      lease: { sessionId: "session-a" },
    });
  });

  it("persists recovery state and only lets the owner release it", async () => {
    const updated = await leases.updateWorkspaceLease(workspace, "session-a", {
      state: "recovery_required",
      detail: "work preserved",
    });
    expect(updated).toMatchObject({ state: "recovery_required", detail: "work preserved" });
    expect(await leases.releaseWorkspaceLease(workspace, "session-b")).toBe(false);
    expect(await leases.releaseWorkspaceLease(workspace, "session-a")).toBe(true);
    expect(await leases.listWorkspaceLeases()).toEqual([]);
  });
});
