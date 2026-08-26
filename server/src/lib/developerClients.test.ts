import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DeveloperClientOpenError,
  openDeveloperClientWorkspace,
  probeDeveloperClients,
} from "./developerClients.js";

let root: string;
let bin: string;
let applications: string;
let home: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-developer-clients-"));
  bin = path.join(root, "bin");
  applications = path.join(root, "Applications");
  home = path.join(root, "home");
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(path.join(applications, "Visual Studio Code.app"), { recursive: true });
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true });

  for (const name of ["code", "claude", "codex", "opencode"]) {
    const file = path.join(bin, name);
    await fs.writeFile(file, "#!/bin/sh\nexit 0\n");
    await fs.chmod(file, 0o755);
  }

  await fs.writeFile(path.join(home, ".claude.json"), '{"token":"must-not-escape"}\n');
  await fs.writeFile(path.join(home, ".codex", "config.toml"), 'api_key = "must-not-escape"\n');
  await fs.writeFile(
    path.join(home, ".config", "opencode", "opencode.json"),
    '{"secret":"must-not-escape"}\n',
  );
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("developer client discovery", () => {
  it("detects named apps and agents without reading client configuration contents", async () => {
    const result = await probeDeveloperClients({
      pathValue: bin,
      platform: "darwin",
      homeDirectory: home,
      applicationsDirectory: applications,
      runner: async (file) => ({
        code: 0,
        stdout: `${path.basename(file)} 1.2.3\n`,
        stderr: "",
      }),
    });

    const byId = Object.fromEntries(result.clients.map((client) => [client.id, client]));
    expect(byId.vscode).toMatchObject({
      state: "ready",
      installed: true,
      workspaceHandoff: true,
      executable: "code",
      appPath: path.join(applications, "Visual Studio Code.app"),
    });
    expect(byId.cursor).toMatchObject({
      state: "missing",
      installed: false,
      workspaceHandoff: false,
      installCommand: "brew install --cask cursor",
    });
    expect(byId.warp).toMatchObject({
      state: "missing",
      workspaceHandoff: false,
      installCommand: "brew install --cask warp",
    });
    expect(byId.claude_code).toMatchObject({
      state: "ready",
      kind: "agent",
      workspaceHandoff: false,
      mcp: { configPresent: true, inspectCommand: "claude mcp list" },
    });
    expect(byId.codex).toMatchObject({
      state: "ready",
      mcp: { configPresent: true, inspectCommand: "codex mcp list" },
    });
    expect(byId.opencode).toMatchObject({
      state: "ready",
      mcp: { configPresent: true, inspectCommand: "opencode mcp list" },
    });
    expect(result.policy).toEqual({
      automaticInstall: false,
      automaticConfigWrites: false,
      credentialContentsInspected: false,
      agentNestingAllowed: false,
    });
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
  });

  it("distinguishes an installed app from a shell command on PATH", async () => {
    const result = await probeDeveloperClients({
      pathValue: "",
      platform: "darwin",
      homeDirectory: home,
      applicationsDirectory: applications,
      runner: async () => ({ code: 0, stdout: "", stderr: "" }),
    });

    const vscode = result.clients.find((client) => client.id === "vscode");
    expect(vscode).toMatchObject({
      state: "app_only",
      installed: true,
      workspaceHandoff: true,
    });
    expect(vscode).not.toHaveProperty("executablePath");
  });
});

describe("developer client workspace handoff", () => {
  it("opens an editor with its discovered executable and one literal workspace argument", async () => {
    const runner = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const workspace = path.join(root, "repo with spaces");

    const result = await openDeveloperClientWorkspace("vscode", workspace, {
      pathValue: bin,
      platform: "darwin",
      applicationsDirectory: applications,
      runner,
    });

    expect(runner).toHaveBeenCalledWith(path.join(bin, "code"), [workspace]);
    expect(result).toEqual({
      clientId: "vscode",
      workspace,
      opened: true,
      method: "cli",
    });
  });

  it("falls back to the fixed macOS application path when the editor CLI is absent", async () => {
    const runner = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const workspace = path.join(root, "repo");

    const result = await openDeveloperClientWorkspace("vscode", workspace, {
      pathValue: "",
      platform: "darwin",
      applicationsDirectory: applications,
      runner,
    });

    expect(runner).toHaveBeenCalledWith("/usr/bin/open", [
      "-a",
      path.join(applications, "Visual Studio Code.app"),
      workspace,
    ]);
    expect(result.method).toBe("application");
  });

  it("uses Warp's fixed URI scheme with an encoded workspace path", async () => {
    const warpApp = path.join(applications, "Warp.app");
    await fs.mkdir(warpApp, { recursive: true });
    const runner = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const workspace = path.join(root, "repo with spaces & symbols");
    try {
      const result = await openDeveloperClientWorkspace("warp", workspace, {
        pathValue: bin,
        platform: "darwin",
        applicationsDirectory: applications,
        runner,
      });

      expect(runner).toHaveBeenCalledOnce();
      const [file, args] = runner.mock.calls[0];
      expect(file).toBe("/usr/bin/open");
      expect(args.slice(0, 2)).toEqual(["-a", warpApp]);
      const uri = new URL(args[2]);
      expect(uri.protocol).toBe("warp:");
      expect(uri.host).toBe("action");
      expect(uri.pathname).toBe("/new_tab");
      expect(uri.searchParams.get("path")).toBe(workspace);
      expect(result.method).toBe("uri");
    } finally {
      await fs.rm(warpApp, { recursive: true, force: true });
    }
  });

  it("rejects agent clients and reports launch failures without accepting a command", async () => {
    await expect(
      openDeveloperClientWorkspace("codex" as any, path.join(root, "repo")),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      openDeveloperClientWorkspace("vscode", path.join(root, "repo"), {
        pathValue: bin,
        platform: "darwin",
        applicationsDirectory: applications,
        runner: async () => ({ code: 1, stdout: "", stderr: "secret stderr" }),
      }),
    ).rejects.toEqual(
      new DeveloperClientOpenError("Could not open the workspace in Visual Studio Code.", 502),
    );
  });
});
