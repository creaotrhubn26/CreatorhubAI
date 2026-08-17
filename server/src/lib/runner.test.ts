import { describe, it, expect, afterEach } from "vitest";
import { buildArgs, runGlimmer } from "./runner.js";
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

  it("puts the objective last, after a literal -- separator, so argparse can never read it as a flag", () => {
    const args = buildArgs(CONTRACT, "/tmp/ws");
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe(CONTRACT.objective);
  });

  it("cannot be flag-injected via a malicious objective", () => {
    const malicious = { ...CONTRACT, objective: "--auto-approve" };
    const args = buildArgs(malicious, "/tmp/ws");
    const sepIndex = args.indexOf("--");
    expect(sepIndex).toBeGreaterThanOrEqual(0);
    // "--auto-approve" must appear exactly once, as the element right after "--".
    expect(args[sepIndex + 1]).toBe("--auto-approve");
    expect(args.filter((a) => a === "--auto-approve")).toHaveLength(1);
    expect(args.slice(0, sepIndex)).not.toContain("--auto-approve");
  });

  it("maps symbolic verification names to the real allowlisted commands", () => {
    const args = buildArgs({ ...CONTRACT, verification: ["frontend-typecheck", "targeted-test"] }, "/tmp/ws");
    expect(args).toContain("--verify");
    expect(args).toContain("npm --prefix frontend run typecheck");
    expect(args).toContain("npm --prefix frontend run test:unit");
    expect(args.filter((a) => a === "--verify")).toHaveLength(2);
  });

  it("drops unrecognized verification values instead of forwarding them to shlex.split", () => {
    const evil = "git push origin main";
    const args = buildArgs({ ...CONTRACT, verification: [evil, "rm -rf /", "frontend-typecheck"] }, "/tmp/ws");
    // glimmer-v2.py executes every --verify value verbatim: nothing outside the
    // allowlist may appear anywhere in argv.
    expect(args.some((a) => a.includes(evil))).toBe(false);
    expect(args.some((a) => a.includes("rm -rf"))).toBe(false);
    expect(args.filter((a) => a === "--verify")).toHaveLength(1);
    expect(args).toContain("npm --prefix frontend run typecheck");
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
