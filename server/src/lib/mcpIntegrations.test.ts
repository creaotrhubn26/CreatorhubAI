import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  McpConfigValidationError,
  probeMcpIntegrations,
  saveCuratedMcpConfig,
} from "./mcpIntegrations.js";

let root: string;
let bin: string;
let configPath: string;
let apiKeyFile: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-mcp-probe-"));
  bin = path.join(root, "bin");
  configPath = path.join(root, "config", "mcp-servers.json");
  apiKeyFile = path.join(root, "config", "api-key.txt");
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  for (const command of ["npx", "bash", "docker", "gh"]) {
    const file = path.join(bin, command);
    await fs.writeFile(file, "#!/bin/sh\nexit 0\n");
    await fs.chmod(file, 0o755);
  }
  await fs.writeFile(path.join(root, "run-github-mcp.sh"), "#!/bin/sh\nexit 0\n");
  await fs.writeFile(apiKeyFile, "test-key\n", { mode: 0o600 });
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("MCP integration discovery", () => {
  it("reports configured, active and missing-requirement states without returning secrets", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          context7: { command: "npx", args: ["fixture"] },
          custom: { command: "custom-mcp", env: { TOKEN: "secret-that-must-not-escape" } },
        },
      }),
    );
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          { tool: "read_file", type: "builtin" },
          { tool: "context7_resolve-library-id", type: "mcp" },
          { tool: "context7_query-docs", type: "mcp" },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const status = await probeMcpIntegrations({
      configPath,
      orchestratorRoot: root,
      apiKeyFile,
      modelBaseUrl: "http://127.0.0.1:8080",
      pathValue: bin,
      fetcher,
      runner: async (file, args) => ({
        code: path.basename(file) === "docker" && args[0] === "info" ? 1 : 0,
        stdout: "",
        stderr: "",
      }),
    });

    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:8080/tools"),
      expect.objectContaining({ headers: { Authorization: "Bearer test-key" } }),
    );
    expect(status.runtime).toEqual({ reachable: true, totalToolCount: 3, mcpToolCount: 2 });
    expect(status.customServerCount).toBe(1);
    expect(status.integrations.find((item) => item.id === "context7")).toMatchObject({
      configured: true,
      active: true,
      state: "active",
      toolCount: 2,
      agentAccess: "read_only",
    });
    expect(status.integrations.find((item) => item.id === "playwright")).toMatchObject({
      configured: false,
      state: "available",
      agentAccess: "approval_required",
    });
    expect(status.integrations.find((item) => item.id === "github")).toMatchObject({
      state: "missing_requirement",
      requirement: "Docker is installed but not running.",
    });
    expect(JSON.stringify(status)).not.toContain("secret-that-must-not-escape");
  });

  it("writes only pinned curated definitions, preserves custom servers, and uses mode 0600", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          custom: { command: "custom-mcp", env: { TOKEN: "preserved-locally" } },
        },
      }),
    );
    await saveCuratedMcpConfig(
      { enabled: ["context7", "playwright", "github"] },
      { configPath, orchestratorRoot: root },
    );

    const stored = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(stored.mcpServers.custom.env.TOKEN).toBe("preserved-locally");
    expect(stored.mcpServers.context7.args).toContain("@upstash/context7-mcp@4.0.3");
    expect(stored.mcpServers.playwright.args).toContain("@playwright/mcp@0.0.79");
    expect(stored.mcpServers.github).toEqual({
      command: "bash",
      args: [path.join(root, "run-github-mcp.sh")],
      timeout_ms: 60_000,
    });
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("does not offer GitHub MCP until the pinned container image is installed", async () => {
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }));
    const status = await probeMcpIntegrations({
      configPath,
      orchestratorRoot: root,
      apiKeyFile,
      pathValue: bin,
      fetcher: vi.fn().mockRejectedValue(new Error("offline")),
      runner: async (file, args) => ({
        code: path.basename(file) === "docker" && args[0] === "image" ? 1 : 0,
        stdout: "",
        stderr: "",
      }),
    });

    expect(status.integrations.find((item) => item.id === "github")).toMatchObject({
      state: "missing_requirement",
      requirement: "The pinned GitHub MCP image v1.11.0 is not installed.",
    });
  });

  it("rejects unsupported ids and refuses to overwrite an invalid manual config", async () => {
    await expect(
      saveCuratedMcpConfig({ enabled: ["arbitrary-command"] }, { configPath }),
    ).rejects.toBeInstanceOf(McpConfigValidationError);
    await expect(
      saveCuratedMcpConfig({ enabled: ["context7"], command: "arbitrary-command" }, { configPath }),
    ).rejects.toBeInstanceOf(McpConfigValidationError);

    await fs.writeFile(configPath, "{ invalid");
    await expect(
      saveCuratedMcpConfig({ enabled: ["context7"] }, { configPath }),
    ).rejects.toBeInstanceOf(McpConfigValidationError);
    expect(await fs.readFile(configPath, "utf8")).toBe("{ invalid");
  });

  it("rejects malformed argument and environment containers", async () => {
    for (const server of [
      { command: "npx", args: { zero: "not-an-array" } },
      { command: "npx", env: ["not-an-object-map"] },
    ]) {
      await fs.writeFile(configPath, JSON.stringify({ mcpServers: { malformed: server } }));
      await expect(
        saveCuratedMcpConfig({ enabled: ["context7"] }, { configPath }),
      ).rejects.toBeInstanceOf(McpConfigValidationError);
    }
  });

  it("never sends the local model key to a non-loopback endpoint", async () => {
    const fetcher = vi.fn();
    await probeMcpIntegrations({
      configPath,
      orchestratorRoot: root,
      apiKeyFile,
      modelBaseUrl: "https://remote.example",
      pathValue: bin,
      fetcher,
      runner: async () => ({ code: 1, stdout: "", stderr: "" }),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
