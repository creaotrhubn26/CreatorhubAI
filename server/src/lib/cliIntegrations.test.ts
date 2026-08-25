import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findExecutable, probeCliIntegrations } from "./cliIntegrations.js";

let root: string;
let bin: string;
let glimmerV2: string;
let engineer: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-cli-probe-"));
  bin = path.join(root, "bin");
  await fs.mkdir(bin);
  for (const name of ["gh", "git", "npm", "brew"]) {
    const file = path.join(bin, name);
    await fs.writeFile(file, "#!/bin/sh\nexit 0\n");
    await fs.chmod(file, 0o755);
  }
  glimmerV2 = path.join(root, "glimmer-v2.py");
  engineer = path.join(root, "glimmer-engineer.py");
  await fs.writeFile(glimmerV2, "# fixture\n");
  await fs.writeFile(engineer, "# fixture\n");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("CLI integration discovery", () => {
  it("resolves only executable files from the supplied PATH", async () => {
    expect(await findExecutable("gh", bin)).toBe(path.join(bin, "gh"));
    await fs.writeFile(path.join(bin, "not-executable"), "fixture");
    expect(await findExecutable("not-executable", bin)).toBeNull();
  });

  it("reports invalid GitHub credentials without exposing command output", async () => {
    const result = await probeCliIntegrations({
      pathValue: bin,
      platform: "darwin",
      nodePath: "/Applications/Glimmer.app/Contents/MacOS/glimmer-node",
      nodeVersion: "v22.12.0",
      glimmerV2Path: glimmerV2,
      engineerPath: engineer,
      runner: async (file, args) => {
        if (path.basename(file) === "gh" && args[0] === "auth") {
          return { code: 1, stdout: "", stderr: "token ghp_should_never_escape is invalid" };
        }
        return { code: 0, stdout: `${path.basename(file)} version fixture\n`, stderr: "" };
      },
    });

    const byId = Object.fromEntries(result.integrations.map((item) => [item.id, item]));
    expect(byId.node).toMatchObject({ state: "ready", source: "bundled", version: "v22.12.0" });
    expect(byId.orchestrator).toMatchObject({ state: "ready", required: true });
    expect(byId.github_cli).toMatchObject({
      state: "authentication_required",
      authenticated: false,
      agentAccess: "read_only",
      authCommand: "gh auth login -h github.com -p https -w",
    });
    expect(byId.github_cli).not.toHaveProperty("installCommand");
    expect(JSON.stringify(result)).not.toContain("ghp_should_never_escape");
    expect(byId.python).toMatchObject({ state: "missing", installCommand: "brew install python" });
    expect(result.policy).toEqual({
      automaticSystemInstall: false,
      externalWritesRequireApproval: true,
      gitPushAllowed: false,
    });
  });

  it("reports configured orchestrator scripts honestly when either file is missing", async () => {
    const result = await probeCliIntegrations({
      pathValue: "",
      glimmerV2Path: glimmerV2,
      engineerPath: path.join(root, "missing-engineer.py"),
      runner: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(result.integrations.find((item) => item.id === "orchestrator")).toMatchObject({
      state: "missing",
      installed: false,
    });
  });
});
