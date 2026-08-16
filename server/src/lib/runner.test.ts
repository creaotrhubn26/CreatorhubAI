import { describe, it, expect, afterEach } from "vitest";
import { buildArgs, runGlimmer } from "./runner";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINEER = path.join(__dirname, "__fixtures__", "fake-glimmer-v2.mjs");

const CONTRACT = {
  objective: "Fix dialog state restoration",
  scope: { package: "frontend" as const, area: "role-room" },
  mode: "implement" as const,
  constraints: { minimalChange: true, noCommit: true as const, noPush: true as const, noDeploy: true as const, noDependencyInstall: true as const },
  verification: ["frontend-typecheck"],
  repairBudget: 2,
};

describe("buildArgs", () => {
  it("never includes a commit/push/deploy/install flag", () => {
    const args = buildArgs(CONTRACT, "/tmp/ws");
    const joined = args.join(" ");
    expect(joined).not.toMatch(/commit|push|deploy|install/i);
  });

  it("passes objective, workspace, and repair budget", () => {
    const args = buildArgs(CONTRACT, "/tmp/ws");
    expect(args).toContain(CONTRACT.objective);
    expect(args).toContain("--workspace");
    expect(args).toContain("/tmp/ws");
    expect(args).toContain("--max-repairs");
    expect(args).toContain("2");
  });
});

describe("runGlimmer", () => {
  let cancelHandle: { cancel(): void } | undefined;
  afterEach(() => cancelHandle?.cancel());

  it("spawns the given engineer script and streams stdout into the session log", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-run-test-"));
    const done = new Promise<number | null>((resolve) => {
      cancelHandle = runGlimmer(dir, FAKE_ENGINEER, ["task", "--workspace", "/tmp/ws"], resolve);
    });
    const code = await done;
    expect(code).toBe(0);
    const log = await fs.readFile(path.join(dir, "engineer-00.log"), "utf-8");
    expect(log).toContain("FAKE ENGINEER RUNNING");
  });
});
