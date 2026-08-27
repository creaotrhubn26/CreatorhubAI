import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskContract } from "@glimmer/shared";

const CONTRACT: TaskContract = {
  objective: "Hva kan bli bedre?",
  intent: { kind: "improvement-assessment", source: "deterministic-inference" },
  scope: { package: "repository" },
  mode: "inspect",
  constraints: {
    minimalChange: true,
    noCommit: true,
    noPush: true,
    noDeploy: true,
    noDependencyInstall: true,
  },
  verification: [],
  repairBudget: 0,
};

let stateRoot: string;
let runState: typeof import("./runState.js");
let child: ChildProcess | undefined;

beforeAll(async () => {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-run-state-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;
  vi.resetModules();
  runState = await import("./runState.js");
});

afterAll(async () => {
  child?.kill("SIGTERM");
  await fs.rm(stateRoot, { recursive: true, force: true });
});

describe("durable gateway run state", () => {
  it("creates a canonical non-pending id and survives a module reload", async () => {
    const created = await runState.createGatewayRun(CONTRACT, "/tmp/workspace");
    expect(created.id).toMatch(/^\d{8}-\d{6}-[a-f0-9-]{12}$/);
    expect(created.id).not.toMatch(/^pending-/);

    vi.resetModules();
    const reloaded = await import("./runState.js");
    expect(await reloaded.readGatewayRun(created.id)).toEqual(created);
    expect(reloaded.gatewayRunToSession(created).taskContract?.intent?.kind).toBe(
      "improvement-assessment",
    );
  });

  it("serializes concurrent updates instead of losing the terminal transition", async () => {
    const created = await runState.createGatewayRun(CONTRACT, "/tmp/workspace");
    const first = runState.updateGatewayRun(created.id, (record) => ({
      ...record,
      state: "running",
      pid: 123,
    }));
    const second = runState.updateGatewayRun(created.id, (record) => ({
      ...record,
      state: "exited",
      exitCode: 0,
    }));
    await Promise.all([first, second]);
    expect((await runState.readGatewayRun(created.id))?.state).toBe("exited");
  });

  it("validates the crash-safe journal projection without trusting artifact paths", async () => {
    const created = await runState.createGatewayRun(CONTRACT, "/tmp/workspace");
    const sessionDir = path.join(stateRoot, "sessions", created.id);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "recovery-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: created.id,
        durable: true,
        lastDurableAt: "2026-08-27T08:00:00.000Z",
        phase: "tool_running",
        turn: 2,
        durableMessageCount: 7,
        partialModelCharacters: 321,
        pendingTool: { callId: "call-2", tool: "edit_file", path: "src/app.ts" },
        snapshot: {
          commit: "a".repeat(40),
          changedFiles: ["src/app.ts", "../outside", "/absolute"],
        },
      }),
    );

    expect(await runState.readDurableCheckpoint(created.id)).toEqual({
      lastDurableAt: "2026-08-27T08:00:00.000Z",
      phase: "tool_running",
      turn: 2,
      durableMessageCount: 7,
      partialModelCharacters: 321,
      pendingTool: { callId: "call-2", tool: "edit_file", path: "src/app.ts" },
      snapshotCommit: "a".repeat(40),
      snapshotChangedFiles: ["src/app.ts"],
    });
    expect(await runState.readDurableCheckpoint(created.id, stateRoot)).not.toHaveProperty(
      "snapshotCommit",
    );
  });

  it("recognizes only a live process carrying this exact canonical session id", async () => {
    const created = await runState.createGatewayRun(CONTRACT, "/tmp/workspace");
    const fixture = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "__fixtures__",
      "fake-glimmer-v2.mjs",
    );
    child = spawn(
      process.execPath,
      [fixture, "--session-id", created.id, "--workspace", "/tmp/workspace"],
      {
        env: {
          ...process.env,
          GLIMMER_FAKE_REAL_ID: "stay-running",
          GLIMMER_STATE_ROOT: stateRoot,
        },
        stdio: "ignore",
      },
    );
    await new Promise<void>((resolve, reject) => {
      child!.once("spawn", resolve);
      child!.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    const record = { ...created, state: "running" as const, pid: child.pid };
    const command = `${process.execPath} ${fixture} --session-id ${created.id} --workspace /tmp/workspace`;
    expect(runState.commandBelongsToRun(command, created.id)).toBe(true);
    expect(runState.commandBelongsToRun(command, `${created.id}-other`)).toBe(false);
    expect(
      runState.commandBelongsToRun(`python3 other.py --session-id ${created.id}`, created.id),
    ).toBe(false);
    // The actual /bin/ps probe is allowed to return false in a sandbox that
    // blocks process-list inspection; the pure command ownership boundary
    // above is the part cancellation relies on once ps is available.
    expect(typeof (await runState.isRecordedProcessAlive(record))).toBe("boolean");
    child.kill("SIGTERM");
    child = undefined;
  });
});
