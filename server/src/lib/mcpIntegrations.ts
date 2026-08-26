import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  McpConfigUpdate,
  McpIntegration,
  McpIntegrationId,
  McpIntegrationsStatus,
} from "@glimmer/shared";
import { CONFIG } from "../config.js";
import { findExecutable } from "./cliIntegrations.js";

type CommandResult = { code: number | null; stdout: string; stderr: string };
type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

interface StoredMcpServer {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
}

interface StoredMcpConfig {
  mcpServers: Record<string, StoredMcpServer>;
}

interface CuratedSpec {
  id: McpIntegrationId;
  name: string;
  description: string;
  version: string;
  adoption: McpIntegration["adoption"];
  agentAccess: McpIntegration["agentAccess"];
  commands: string[];
  config(orchestratorRoot: string): StoredMcpServer;
}

const CURATED_SPECS: CuratedSpec[] = [
  {
    id: "context7",
    name: "Context7",
    description: "Current, library-specific documentation and code examples.",
    version: "4.0.3",
    adoption: "very_high",
    agentAccess: "read_only",
    commands: ["npx"],
    config: () => ({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp@4.0.3"],
      timeout_ms: 30_000,
    }),
  },
  {
    id: "playwright",
    name: "Playwright MCP",
    description: "Browser automation and evidence from real user workflows.",
    version: "0.0.79",
    adoption: "very_high",
    agentAccess: "approval_required",
    commands: ["npx"],
    config: () => ({
      command: "npx",
      args: ["-y", "@playwright/mcp@0.0.79", "--headless", "--isolated"],
      timeout_ms: 60_000,
    }),
  },
  {
    id: "github",
    name: "GitHub MCP",
    description: "Official repository, pull-request, workflow and security context.",
    version: "1.11.0",
    adoption: "high",
    agentAccess: "read_only",
    commands: ["bash", "docker", "gh"],
    config: (orchestratorRoot) => ({
      command: "bash",
      args: [path.join(orchestratorRoot, "run-github-mcp.sh")],
      timeout_ms: 60_000,
    }),
  },
];

const CURATED_IDS = new Set<McpIntegrationId>(CURATED_SPECS.map((spec) => spec.id));
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_SERVERS = 32;

export class McpConfigValidationError extends Error {}

export interface McpProbeOptions {
  configPath?: string;
  orchestratorRoot?: string;
  modelBaseUrl?: string;
  apiKeyFile?: string;
  pathValue?: string;
  runner?: CommandRunner;
  fetcher?: typeof fetch;
}

async function defaultRunner(file: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: 5_000,
        maxBuffer: 32 * 1024,
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

function isStoredServer(value: unknown): value is StoredMcpServer {
  if (!value || typeof value !== "object") return false;
  const raw = value as Partial<StoredMcpServer>;
  return (
    typeof raw.command === "string" &&
    !!raw.command.trim() &&
    (raw.args === undefined ||
      (Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === "string"))) &&
    (raw.cwd === undefined || typeof raw.cwd === "string") &&
    (raw.env === undefined ||
      (!!raw.env &&
        typeof raw.env === "object" &&
        !Array.isArray(raw.env) &&
        Object.values(raw.env).every((entry) => typeof entry === "string"))) &&
    (raw.timeout_ms === undefined ||
      (Number.isInteger(raw.timeout_ms) && raw.timeout_ms >= 1_000 && raw.timeout_ms <= 300_000))
  );
}

function parseStoredConfig(value: unknown): StoredMcpConfig {
  if (!value || typeof value !== "object") {
    throw new McpConfigValidationError("MCP config must be a JSON object");
  }
  const servers = (value as Partial<StoredMcpConfig>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new McpConfigValidationError("MCP config must contain an mcpServers object");
  }
  const entries = Object.entries(servers);
  if (entries.length > MAX_SERVERS) {
    throw new McpConfigValidationError(`MCP config may contain at most ${MAX_SERVERS} servers`);
  }
  for (const [name, server] of entries) {
    if (!SERVER_NAME_PATTERN.test(name) || !isStoredServer(server)) {
      throw new McpConfigValidationError(`MCP server ${JSON.stringify(name)} is invalid`);
    }
  }
  return { mcpServers: Object.fromEntries(entries) };
}

async function readStoredConfig(configPath: string): Promise<{
  config: StoredMcpConfig;
  exists: boolean;
  error?: string;
}> {
  try {
    return {
      config: parseStoredConfig(JSON.parse(await fs.readFile(configPath, "utf8"))),
      exists: true,
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { config: { mcpServers: {} }, exists: false };
    return {
      config: { mcpServers: {} },
      exists: true,
      error:
        error instanceof McpConfigValidationError || error instanceof SyntaxError
          ? error.message
          : "MCP config could not be read",
    };
  }
}

async function probeRuntimeTools(
  modelBaseUrl: string,
  apiKeyFile: string,
  fetcher: typeof fetch,
): Promise<Array<{ name: string; type: string }>> {
  let endpoint: URL;
  try {
    endpoint = new URL(`${modelBaseUrl.replace(/\/+$/, "")}/tools`);
  } catch {
    return [];
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    !new Set(["127.0.0.1", "localhost", "[::1]", "::1"]).has(endpoint.hostname.toLowerCase())
  ) {
    return [];
  }
  let key = "";
  try {
    key = (await fs.readFile(apiKeyFile, "utf8")).trim();
  } catch (error: any) {
    if (error?.code !== "ENOENT") return [];
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetcher(endpoint, {
      signal: controller.signal,
      headers: key ? { Authorization: `Bearer ${key}` } : undefined,
    });
    if (!response.ok) return [];
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) return [];
    return body.flatMap((item: any) => {
      const name = item?.tool ?? item?.definition?.function?.name;
      return typeof name === "string" && typeof item?.type === "string"
        ? [{ name, type: item.type }]
        : [];
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function commandRequirements(
  spec: CuratedSpec,
  pathValue: string,
  runner: CommandRunner,
  orchestratorRoot: string,
): Promise<{ ready: boolean; authRequired: boolean; detail?: string }> {
  for (const command of spec.commands) {
    if (!(await findExecutable(command, pathValue))) {
      return { ready: false, authRequired: false, detail: `${command} was not found on PATH.` };
    }
  }
  if (spec.id !== "github") return { ready: true, authRequired: false };
  try {
    const wrapper = await fs.stat(path.join(orchestratorRoot, "run-github-mcp.sh"));
    if (!wrapper.isFile()) {
      return { ready: false, authRequired: false, detail: "GitHub MCP wrapper is missing." };
    }
  } catch {
    return { ready: false, authRequired: false, detail: "GitHub MCP wrapper is missing." };
  }
  const gh = await findExecutable("gh", pathValue);
  const docker = await findExecutable("docker", pathValue);
  if (!gh || !docker) return { ready: false, authRequired: false };
  const auth = await runner(gh, ["auth", "status", "--hostname", "github.com"]);
  if (auth.code !== 0) {
    return { ready: false, authRequired: true, detail: "GitHub CLI sign-in is required." };
  }
  const daemon = await runner(docker, ["info", "--format", "{{.ServerVersion}}"]);
  if (daemon.code !== 0) {
    return { ready: false, authRequired: false, detail: "Docker is installed but not running." };
  }
  const image = await runner(docker, [
    "image",
    "inspect",
    "ghcr.io/github/github-mcp-server:v1.11.0",
  ]);
  if (image.code !== 0) {
    return {
      ready: false,
      authRequired: false,
      detail: "The pinned GitHub MCP image v1.11.0 is not installed.",
    };
  }
  return { ready: true, authRequired: false };
}

export async function probeMcpIntegrations(
  options: McpProbeOptions = {},
): Promise<McpIntegrationsStatus> {
  const configPath = options.configPath ?? CONFIG.mcpConfigPath;
  const orchestratorRoot = options.orchestratorRoot ?? CONFIG.orchestratorRoot;
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const runner = options.runner ?? defaultRunner;
  const stored = await readStoredConfig(configPath);
  const runtimeTools = await probeRuntimeTools(
    options.modelBaseUrl ?? CONFIG.modelBaseUrl,
    options.apiKeyFile ?? CONFIG.modelApiKeyFile,
    options.fetcher ?? fetch,
  );
  const mcpTools = runtimeTools.filter((tool) => tool.type === "mcp");
  const integrations: McpIntegration[] = [];

  for (const spec of CURATED_SPECS) {
    const configured = Object.hasOwn(stored.config.mcpServers, spec.id);
    const toolCount = mcpTools.filter((tool) => tool.name.startsWith(`${spec.id}_`)).length;
    const active = toolCount > 0;
    const requirement = await commandRequirements(spec, pathValue, runner, orchestratorRoot);
    const state: McpIntegration["state"] = active
      ? "active"
      : requirement.authRequired
        ? "authentication_required"
        : !requirement.ready
          ? "missing_requirement"
          : configured
            ? "configured_restart_required"
            : "available";
    integrations.push({
      id: spec.id,
      name: spec.name,
      description: spec.description,
      version: spec.version,
      adoption: spec.adoption,
      recommended: true,
      configured,
      active,
      state,
      agentAccess: spec.agentAccess,
      detail:
        requirement.detail ??
        (active
          ? `${toolCount} MCP tool${toolCount === 1 ? "" : "s"} active in the model runtime.`
          : configured
            ? "Configured safely. Restart the model server to activate it."
            : "Available to enable; no credentials will be stored in this config."),
      ...(requirement.detail ? { requirement: requirement.detail } : {}),
      toolCount,
    });
  }

  const configuredIds = new Set(Object.keys(stored.config.mcpServers));
  const activeIds = new Set(
    integrations.filter((integration) => integration.active).map((integration) => integration.id),
  );
  const restartRequired = integrations.some(
    (integration) => integration.configured !== activeIds.has(integration.id),
  );

  return {
    checkedAt: new Date().toISOString(),
    configPath,
    configExists: stored.exists,
    ...(stored.error ? { configError: stored.error } : {}),
    restartRequired,
    customServerCount: [...configuredIds].filter((id) => !CURATED_IDS.has(id as McpIntegrationId))
      .length,
    runtime: {
      reachable: runtimeTools.length > 0,
      totalToolCount: runtimeTools.length,
      mcpToolCount: mcpTools.length,
    },
    integrations,
    policy: {
      arbitraryServerCommandsFromUi: false,
      credentialsReturnedByApi: false,
      unclassifiedToolsRequireApproval: true,
    },
  };
}

function normalizeUpdate(input: unknown): McpConfigUpdate {
  if (!input || typeof input !== "object" || !Array.isArray((input as any).enabled)) {
    throw new McpConfigValidationError("enabled must be an array of curated MCP ids");
  }
  if (Object.keys(input).some((key) => key !== "enabled")) {
    throw new McpConfigValidationError("only the enabled field is accepted");
  }
  const enabled = (input as any).enabled;
  if (
    enabled.some(
      (id: unknown) => typeof id !== "string" || !CURATED_IDS.has(id as McpIntegrationId),
    )
  ) {
    throw new McpConfigValidationError("enabled contains an unsupported MCP id");
  }
  return { enabled: [...new Set(enabled)] as McpIntegrationId[] };
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
}

export async function saveCuratedMcpConfig(
  input: unknown,
  options: Pick<McpProbeOptions, "configPath" | "orchestratorRoot"> = {},
): Promise<void> {
  const update = normalizeUpdate(input);
  const configPath = options.configPath ?? CONFIG.mcpConfigPath;
  const orchestratorRoot = options.orchestratorRoot ?? CONFIG.orchestratorRoot;
  const stored = await readStoredConfig(configPath);
  if (stored.error) throw new McpConfigValidationError(stored.error);

  const servers = Object.fromEntries(
    Object.entries(stored.config.mcpServers).filter(
      ([id]) => !CURATED_IDS.has(id as McpIntegrationId),
    ),
  );
  for (const id of update.enabled) {
    const spec = CURATED_SPECS.find((candidate) => candidate.id === id)!;
    servers[id] = spec.config(orchestratorRoot);
  }
  await writeAtomic(configPath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
}
