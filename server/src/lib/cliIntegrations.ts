import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CliAgentAccess,
  CliIntegration,
  CliIntegrationId,
  CliIntegrationsStatus,
} from "@glimmer/shared";
import { CONFIG } from "../config.js";

type CommandResult = { code: number | null; stdout: string; stderr: string };
type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

export interface CliProbeOptions {
  pathValue?: string;
  platform?: NodeJS.Platform;
  nodePath?: string;
  nodeVersion?: string;
  glimmerV2Path?: string;
  engineerPath?: string;
  orchestratorBundled?: boolean;
  pythonBundled?: boolean;
  runner?: CommandRunner;
}

const VERSION_ARGS: Partial<Record<CliIntegrationId, string[]>> = {
  github_cli: ["--version"],
  git: ["--version"],
  npm: ["--version"],
  python: ["--version"],
  cargo: ["--version"],
  pnpm: ["--version"],
  yarn: ["--version"],
  homebrew: ["--version"],
};

const SPECS: Array<{
  id: CliIntegrationId;
  name: string;
  executable: string;
  required: boolean;
  agentAccess: CliAgentAccess;
}> = [
  { id: "git", name: "Git", executable: "git", required: true, agentAccess: "read_only" },
  {
    id: "python",
    name: "Python",
    executable: "python3",
    required: true,
    agentAccess: "validation_only",
  },
  { id: "npm", name: "npm", executable: "npm", required: false, agentAccess: "approval_required" },
  {
    id: "github_cli",
    name: "GitHub CLI",
    executable: "gh",
    required: false,
    agentAccess: "read_only",
  },
  {
    id: "cargo",
    name: "Cargo",
    executable: "cargo",
    required: false,
    agentAccess: "validation_only",
  },
  { id: "pnpm", name: "pnpm", executable: "pnpm", required: false, agentAccess: "blocked" },
  { id: "yarn", name: "Yarn", executable: "yarn", required: false, agentAccess: "blocked" },
  { id: "homebrew", name: "Homebrew", executable: "brew", required: false, agentAccess: "blocked" },
];

async function defaultRunner(file: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
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

export async function findExecutable(
  executable: string,
  pathValue: string,
): Promise<string | null> {
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, executable);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      }
    } catch {
      // Missing, non-executable, or an unreadable PATH entry: keep looking.
    }
  }
  return null;
}

function firstOutputLine(result: CommandResult): string | undefined {
  return `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

function installCommand(id: CliIntegrationId, platform: NodeJS.Platform): string | undefined {
  if (platform !== "darwin") return undefined;
  switch (id) {
    case "github_cli":
      return "brew install gh";
    case "git":
      return "xcode-select --install";
    case "npm":
      return "brew install node";
    case "python":
      return "brew install python";
    case "cargo":
      return "brew install rust";
    case "pnpm":
      return "corepack enable pnpm";
    case "yarn":
      return "corepack enable yarn";
    default:
      return undefined;
  }
}

function readyDetail(id: CliIntegrationId): string {
  switch (id) {
    case "git":
      return "Read-only status, diff, log and show commands are available. Commit, merge and push remain blocked.";
    case "python":
      return "Available for the orchestrator and bounded syntax checks.";
    case "npm":
      return "Validation scripts are allowed. Dependency installation pauses for explicit human approval.";
    case "cargo":
      return "Cargo check and test are allowed when a Rust workspace needs them.";
    case "pnpm":
      return "Detected, but agent execution is not allowlisted yet.";
    case "yarn":
      return "Detected, but agent execution is not allowlisted yet.";
    case "homebrew":
      return "Available for commands you choose to run manually; agents cannot invoke Homebrew.";
    default:
      return "Available.";
  }
}

async function fileReadable(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    await fs.access(file, fsConstants.R_OK);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function probeCliIntegrations(
  options: CliProbeOptions = {},
): Promise<CliIntegrationsStatus> {
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? defaultRunner;
  const nodePath = options.nodePath ?? process.execPath;
  const nodeVersion = options.nodeVersion ?? process.version;
  const glimmerV2Path = options.glimmerV2Path ?? CONFIG.glimmerV2Path;
  const engineerPath = options.engineerPath ?? CONFIG.engineerPath;
  const orchestratorBundled = options.orchestratorBundled ?? CONFIG.orchestratorBundled;
  const pythonBundled = options.pythonBundled ?? CONFIG.pythonBundled;

  const commandIntegrations = await Promise.all(
    SPECS.map(async (spec): Promise<CliIntegration> => {
      const executablePath = await findExecutable(spec.executable, pathValue);
      if (!executablePath) {
        if (spec.id === "python" && pythonBundled) {
          return {
            ...spec,
            state: "missing",
            installed: false,
            source: "bundled",
            detail: "The bundled Python runtime is incomplete. Reinstall Glimmer Control Center.",
          };
        }
        return {
          ...spec,
          state: "missing",
          installed: false,
          source: "path",
          detail: `${spec.name} was not found on the app's resolved Terminal PATH.`,
          installCommand: installCommand(spec.id, platform),
        };
      }

      const versionResult = await runner(executablePath, VERSION_ARGS[spec.id] ?? ["--version"]);
      const base: CliIntegration = {
        ...spec,
        state:
          spec.agentAccess === "blocked" && (spec.id === "pnpm" || spec.id === "yarn")
            ? "blocked"
            : "ready",
        installed: true,
        version: firstOutputLine(versionResult),
        path: executablePath,
        source: spec.id === "python" && pythonBundled ? "bundled" : "path",
        detail: readyDetail(spec.id),
      };

      if (spec.id === "python" && pythonBundled) {
        base.detail =
          "Bundled with Glimmer Control Center; no separate Python installation is required for the orchestrator.";
      }

      if (spec.id !== "github_cli") return base;
      const auth = await runner(executablePath, ["auth", "status", "--hostname", "github.com"]);
      const output = `${auth.stdout}\n${auth.stderr}`.toLowerCase();
      const authenticated = auth.code === 0;
      return {
        ...base,
        state: authenticated ? "ready" : "authentication_required",
        authenticated,
        authCommand: "gh auth login -h github.com -p https -w",
        detail: authenticated
          ? "Authenticated. Agents may only use allowlisted read-only GitHub commands in the current repository."
          : output.includes("invalid")
            ? "GitHub credentials are invalid or expired. Re-authenticate in Terminal."
            : "GitHub CLI is installed but not authenticated for github.com.",
      };
    }),
  );

  const orchestratorReady =
    (await fileReadable(glimmerV2Path)) && (await fileReadable(engineerPath));
  const orchestrator: CliIntegration = {
    id: "orchestrator",
    name: "Muse Glimmer orchestrator",
    executable: "glimmer-v2.py",
    required: true,
    state: orchestratorReady ? "ready" : "missing",
    installed: orchestratorReady,
    path: glimmerV2Path,
    source: orchestratorBundled ? "bundled" : "configured",
    agentAccess: "runtime",
    detail: orchestratorReady
      ? orchestratorBundled
        ? "Bundled glimmer-v2.py and glimmer-engineer.py are ready."
        : "Both configured orchestrator scripts are readable."
      : orchestratorBundled
        ? "The bundled orchestrator resources are incomplete. Reinstall Glimmer Control Center."
        : "The external orchestrator scripts are missing. Configure GLIMMER_V2_PATH and GLIMMER_ENGINEER_PATH.",
  };

  const node: CliIntegration = {
    id: "node",
    name: "Node.js runtime",
    executable: "node",
    required: true,
    state: "ready",
    installed: true,
    version: nodeVersion,
    path: nodePath,
    source: path.basename(nodePath).startsWith("glimmer-node") ? "bundled" : "path",
    agentAccess: "runtime",
    detail: path.basename(nodePath).startsWith("glimmer-node")
      ? "Bundled with Glimmer Control Center; no separate Node installation is required for the gateway."
      : "Using the current development/runtime Node executable.",
  };

  return {
    checkedAt: new Date().toISOString(),
    platform: `${platform} ${os.arch()}`,
    integrations: [orchestrator, node, ...commandIntegrations],
    policy: {
      automaticSystemInstall: false,
      externalWritesRequireApproval: true,
      gitPushAllowed: false,
    },
  };
}
