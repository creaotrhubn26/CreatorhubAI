import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DeveloperClient,
  DeveloperClientId,
  DeveloperClientsStatus,
  WorkspaceHandoffClientId,
  WorkspaceHandoffResult,
} from "@glimmer/shared";
import { findExecutable } from "./cliIntegrations.js";

type CommandResult = { code: number | null; stdout: string; stderr: string };
type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

export interface DeveloperClientProbeOptions {
  pathValue?: string;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  applicationsDirectory?: string;
  runner?: CommandRunner;
}

export interface DeveloperClientOpenOptions {
  pathValue?: string;
  platform?: NodeJS.Platform;
  applicationsDirectory?: string;
  runner?: CommandRunner;
}

export class DeveloperClientOpenError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 502,
  ) {
    super(message);
    this.name = "DeveloperClientOpenError";
  }
}

interface ClientSpec {
  id: DeveloperClientId;
  name: string;
  kind: DeveloperClient["kind"];
  executable?: string;
  application?: string;
  installCommand?: string;
  appOnlyDetail?: string;
  configPath?(homeDirectory: string): string;
  mcp: Pick<DeveloperClient["mcp"], "setupMethod" | "setupHint" | "inspectCommand" | "docsUrl">;
}

const CLIENTS: ClientSpec[] = [
  {
    id: "cursor",
    name: "Cursor",
    kind: "editor",
    executable: "cursor",
    application: "Cursor.app",
    installCommand: "brew install --cask cursor",
    appOnlyDetail:
      "Cursor is installed and can open Glimmer workspaces. Add its shell command from the Command Palette for terminal use too.",
    configPath: (home) => path.join(home, ".cursor", "mcp.json"),
    mcp: {
      setupMethod: "file",
      setupHint: "Open Cursor → Customize → MCPs, or use the global mcp.json file.",
      docsUrl: "https://cursor.com/docs/context/model-context-protocol",
    },
  },
  {
    id: "vscode",
    name: "Visual Studio Code",
    kind: "editor",
    executable: "code",
    application: "Visual Studio Code.app",
    installCommand: "brew install --cask visual-studio-code",
    appOnlyDetail:
      "Visual Studio Code is installed and can open Glimmer workspaces. Run “Shell Command: Install 'code' command in PATH” from its Command Palette for terminal use too.",
    configPath: (home) =>
      path.join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
    mcp: {
      setupMethod: "command_palette",
      setupHint: "Run “MCP: Open User Configuration” from the Command Palette.",
      docsUrl: "https://code.visualstudio.com/docs/agent-customization/mcp-servers",
    },
  },
  {
    id: "warp",
    name: "Warp",
    kind: "terminal",
    executable: "oz",
    application: "Warp.app",
    installCommand: "brew install --cask warp",
    appOnlyDetail:
      "Warp is installed and can open Glimmer workspaces. Its MCP settings work without the optional oz agent command on Glimmer's PATH.",
    mcp: {
      setupMethod: "settings",
      setupHint: "Open Settings → AI → Manage MCP servers. Warp keeps this configuration itself.",
      docsUrl: "https://docs.warp.dev/agent-platform/capabilities/mcp",
    },
  },
  {
    id: "claude_code",
    name: "Claude Code",
    kind: "agent",
    executable: "claude",
    configPath: (home) => path.join(home, ".claude.json"),
    mcp: {
      setupMethod: "cli",
      setupHint: "Use Claude Code's scoped MCP commands; Glimmer does not invoke another agent.",
      inspectCommand: "claude mcp list",
      docsUrl: "https://docs.anthropic.com/en/docs/claude-code/mcp",
    },
  },
  {
    id: "codex",
    name: "Codex",
    kind: "agent",
    executable: "codex",
    configPath: (home) => path.join(home, ".codex", "config.toml"),
    mcp: {
      setupMethod: "cli",
      setupHint: "Codex CLI, the IDE extension and ChatGPT desktop share this MCP configuration.",
      inspectCommand: "codex mcp list",
      docsUrl: "https://learn.chatgpt.com/docs/extend/mcp",
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    kind: "agent",
    executable: "opencode",
    configPath: (home) => path.join(home, ".config", "opencode", "opencode.json"),
    mcp: {
      setupMethod: "cli",
      setupHint:
        "Use OpenCode's MCP command or configuration; Glimmer does not invoke another agent.",
      inspectCommand: "opencode mcp list",
      docsUrl: "https://dev.opencode.ai/docs/mcp-servers/",
    },
  },
];

const WORKSPACE_HANDOFF_IDS = new Set<DeveloperClientId>(["cursor", "vscode", "warp"]);

export function isWorkspaceHandoffClientId(value: unknown): value is WorkspaceHandoffClientId {
  return typeof value === "string" && WORKSPACE_HANDOFF_IDS.has(value as DeveloperClientId);
}

async function defaultRunner(file: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: 5_000,
        maxBuffer: 32 * 1024,
        env: { ...process.env, NO_COLOR: "1" },
      },
      (error: any, stdout, stderr) => {
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? null : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

function versionFrom(result: CommandResult): string | undefined {
  return `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 160);
}

function detailFor(spec: ClientSpec, executablePath?: string, appPath?: string): string {
  if (!executablePath && !appPath) {
    return `${spec.name} was not found on the app's resolved Terminal PATH or in Applications.`;
  }
  if (!executablePath && appPath) {
    return (
      spec.appOnlyDetail ??
      `${spec.name} is installed, but its shell command is not on Glimmer's Terminal PATH.`
    );
  }
  if (spec.kind === "agent") {
    return `${spec.name} is available for manual use. Agent-to-agent nesting remains disabled in Glimmer.`;
  }
  return `${spec.name} and its shell command are available.`;
}

function supportsWorkspaceHandoff(
  spec: ClientSpec,
  executablePath: string | null,
  appPath: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (spec.id === "warp") return platform === "darwin" && Boolean(appPath);
  if (spec.id === "cursor" || spec.id === "vscode") return Boolean(executablePath || appPath);
  return false;
}

function warpWorkspaceUri(workspace: string): string {
  const uri = new URL("warp://action/new_tab");
  uri.searchParams.set("path", workspace);
  return uri.toString();
}

async function runLaunch(
  runner: CommandRunner,
  file: string,
  args: string[],
  clientName: string,
): Promise<void> {
  const result = await runner(file, args);
  if (result.code !== 0) {
    throw new DeveloperClientOpenError(`Could not open the workspace in ${clientName}.`, 502);
  }
}

// Opens only a pre-validated workspace with one of three fixed clients. The
// caller cannot supply an executable, application, URI, argument, or shell
// fragment: all launch shapes come from CLIENTS and this closed switch. The
// route performs the known-workspace boundary check immediately before this
// function is called.
export async function openDeveloperClientWorkspace(
  clientId: WorkspaceHandoffClientId,
  workspace: string,
  options: DeveloperClientOpenOptions = {},
): Promise<WorkspaceHandoffResult> {
  if (!isWorkspaceHandoffClientId(clientId)) {
    throw new DeveloperClientOpenError("that developer client cannot open workspaces", 400);
  }

  const platform = options.platform ?? process.platform;
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const applicationsDirectory = options.applicationsDirectory ?? "/Applications";
  const runner = options.runner ?? defaultRunner;
  const spec = CLIENTS.find((candidate) => candidate.id === clientId)!;
  const executablePath = spec.executable ? await findExecutable(spec.executable, pathValue) : null;
  const candidateAppPath =
    platform === "darwin" && spec.application
      ? path.join(applicationsDirectory, spec.application)
      : undefined;
  const appPath =
    candidateAppPath && (await directoryExists(candidateAppPath)) ? candidateAppPath : undefined;

  if (clientId === "warp") {
    if (platform !== "darwin" || !appPath) {
      throw new DeveloperClientOpenError(
        "Warp cannot open this workspace because the Warp application was not found.",
        409,
      );
    }
    // Force the verified Warp app instead of trusting whichever application
    // currently owns the system-wide warp:// scheme registration.
    await runLaunch(
      runner,
      "/usr/bin/open",
      ["-a", appPath, warpWorkspaceUri(workspace)],
      spec.name,
    );
    return { clientId, workspace, opened: true, method: "uri" };
  }

  if (executablePath) {
    await runLaunch(runner, executablePath, [workspace], spec.name);
    return { clientId, workspace, opened: true, method: "cli" };
  }

  if (platform === "darwin" && appPath) {
    await runLaunch(runner, "/usr/bin/open", ["-a", appPath, workspace], spec.name);
    return { clientId, workspace, opened: true, method: "application" };
  }

  throw new DeveloperClientOpenError(
    `${spec.name} cannot open this workspace because it was not found.`,
    409,
  );
}

export async function probeDeveloperClients(
  options: DeveloperClientProbeOptions = {},
): Promise<DeveloperClientsStatus> {
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const applicationsDirectory = options.applicationsDirectory ?? "/Applications";
  const runner = options.runner ?? defaultRunner;

  const clients = await Promise.all(
    CLIENTS.map(async (spec): Promise<DeveloperClient> => {
      const executablePath = spec.executable
        ? await findExecutable(spec.executable, pathValue)
        : null;
      const candidateAppPath =
        platform === "darwin" && spec.application
          ? path.join(applicationsDirectory, spec.application)
          : undefined;
      const appPath =
        candidateAppPath && (await directoryExists(candidateAppPath))
          ? candidateAppPath
          : undefined;
      const installed = Boolean(executablePath || appPath);
      const state = !installed ? "missing" : executablePath ? "ready" : "app_only";
      const configPath = spec.configPath?.(homeDirectory);
      const configPresent = configPath ? await fileExists(configPath) : undefined;
      const version = executablePath
        ? versionFrom(await runner(executablePath, ["--version"]))
        : undefined;

      return {
        id: spec.id,
        name: spec.name,
        kind: spec.kind,
        state,
        installed,
        workspaceHandoff: supportsWorkspaceHandoff(spec, executablePath, appPath, platform),
        ...(appPath ? { appPath } : {}),
        ...(spec.executable ? { executable: spec.executable } : {}),
        ...(executablePath ? { executablePath } : {}),
        ...(version ? { version } : {}),
        detail: detailFor(spec, executablePath ?? undefined, appPath),
        ...(spec.installCommand && !installed ? { installCommand: spec.installCommand } : {}),
        mcp: {
          supported: true,
          ...spec.mcp,
          ...(configPath ? { configPath, configPresent } : {}),
        },
      };
    }),
  );

  return {
    checkedAt: new Date().toISOString(),
    platform: `${platform} ${os.arch()}`,
    clients,
    policy: {
      automaticInstall: false,
      automaticConfigWrites: false,
      credentialContentsInspected: false,
      agentNestingAllowed: false,
    },
  };
}
