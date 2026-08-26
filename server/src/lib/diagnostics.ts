import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DiagnosticsStatus,
  GatewayHealth,
  GatewayReadiness,
  RepairCheck,
  RepairResult,
  RuntimeComponentCheck,
} from "@glimmer/shared";
import { CONFIG, gatewayRunLogsDir, gatewayRunsDir, sessionsDir } from "../config.js";
import { probeCliIntegrations } from "./cliIntegrations.js";
import { probeMcpIntegrations } from "./mcpIntegrations.js";
import { probeModel } from "./modelStatus.js";
import { listSessionIds, readSession } from "./sessions.js";

const startTime = Date.now();
const SUPPORT_LOG_BYTES = 16 * 1024;
const SUPPORT_LOG_SESSIONS = 3;
const BUNDLED_ORCHESTRATOR_SHA256: Record<string, string> = {
  "glimmer-v2.py": "3a09e47002b129063b56da89ca4602e56c5b07ee443e44a22c64a897d13b7c65",
  "glimmer-engineer.py": "f337bae58b458252e30e0cc330575aafeb3d87959b142950bc107e49bdf1bd34",
  "glimmer_events.py": "0e2e6978de1de562d5580e331bab1e93acfadab130de85a57bd5201d4ccad1d5",
  "glimmer_models.py": "bf84fe821df6ce7e21babdeecc3dab3f053519ecf1edc467b4df83434b9ff6ee",
  "glimmer-visual.py": "0ba69bdfc9a8e50a8a2626293d3f734f2afd794a3e2f9ae7ad03d45358a967b5",
  "run-github-mcp.sh": "409041d9bd09a9febc199f755190caab073319ba68f1f3eae5417c14c4af5c33",
};
const BUNDLED_PYTHON_SHA256: Record<string, string> = {
  "lib/python3.13/os.py": "18560b0a37dfb90b4712fba97668d44a1328c5566b10deffaee292ba12cc21ff",
  "lib/python3.13/ssl.py": "538bb1cb334bebb9cd45b58503473ba7fd99cc9a5b769b2ff5caea81876227c3",
  "lib/python3.13/json/__init__.py":
    "43e38afede6d52ae0d602a42209b9959fc66d6020a25bcf15921446f5d1c262f",
  "lib/python3.13/sqlite3/__init__.py":
    "6e956d2166e24ccf36fef21ad63d06a5dd8f7b674aca6c81ea91eacca6b85b01",
};

type CommandResult = { code: number | null; stdout: string; stderr: string };
type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

export interface RuntimeProbeOptions {
  pythonPath?: string;
  pythonBundled?: boolean;
  pythonHome?: string;
  orchestratorRoot?: string;
  orchestratorBundled?: boolean;
  glimmerV2Path?: string;
  engineerPath?: string;
  modelBaseUrl?: string;
  runner?: CommandRunner;
  expectedPythonFiles?: Record<string, string>;
  expectedOrchestratorFiles?: Record<string, string>;
}

function runCommand(file: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5_000, maxBuffer: 64 * 1024 }, (error: any, stdout, stderr) => {
      resolve({
        code: typeof error?.code === "number" ? error.code : error ? null : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

async function readableFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    await fs.access(file, fsConstants.R_OK);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

async function probePython(options: RuntimeProbeOptions): Promise<RuntimeComponentCheck> {
  const pythonPath = options.pythonPath ?? CONFIG.pythonPath;
  const bundled = options.pythonBundled ?? CONFIG.pythonBundled;
  const result = await (options.runner ?? runCommand)(pythonPath, [
    "-c",
    "import json, pathlib, sqlite3, ssl, sys; print(sys.version.split()[0])",
  ]);
  const version = result.stdout.trim().split(/\s+/)[0];
  if (result.code !== 0 || !version) {
    return {
      id: "python",
      label: "Python runtime",
      state: "unavailable",
      required: true,
      source: bundled ? "bundled" : "configured",
      detail: bundled
        ? "The bundled Python runtime failed its standard-library self-test."
        : "The configured Python runtime could not complete its self-test.",
    };
  }
  if (bundled) {
    const pythonHome = options.pythonHome ?? process.env.PYTHONHOME;
    try {
      if (!pythonHome) throw new Error("PYTHONHOME is unavailable");
      const origin = JSON.parse(
        await fs.readFile(path.join(pythonHome, "ORIGIN.json"), "utf8"),
      ) as { files?: unknown };
      if (!origin.files || typeof origin.files !== "object") {
        throw new Error("integrity manifest is invalid");
      }
      const expectedFiles = options.expectedPythonFiles ?? BUNDLED_PYTHON_SHA256;
      for (const [name, expected] of Object.entries(expectedFiles)) {
        const manifested = (origin.files as Record<string, unknown>)[name];
        if (manifested !== expected || (await sha256(path.join(pythonHome, name))) !== expected) {
          throw new Error(`${name} checksum mismatch`);
        }
      }
    } catch (error) {
      return {
        id: "python",
        label: "Python runtime",
        state: "unavailable",
        required: true,
        source: "bundled",
        version,
        detail: `The bundled Python integrity check failed: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }
  }
  return {
    id: "python",
    label: "Python runtime",
    state: "ready",
    required: true,
    source: bundled ? "bundled" : "configured",
    version,
    detail: bundled
      ? "Interpreter self-test passed and critical files match the signed integrity manifest."
      : "Interpreter and required standard-library modules loaded successfully.",
  };
}

interface OrchestratorOrigin {
  commit?: unknown;
  files?: unknown;
}

async function probeOrchestrator(options: RuntimeProbeOptions): Promise<RuntimeComponentCheck> {
  const root = options.orchestratorRoot ?? CONFIG.orchestratorRoot;
  const bundled = options.orchestratorBundled ?? CONFIG.orchestratorBundled;
  const required = bundled
    ? [path.join(root, "glimmer-v2.py"), path.join(root, "glimmer-engineer.py")]
    : [options.glimmerV2Path ?? CONFIG.glimmerV2Path, options.engineerPath ?? CONFIG.engineerPath];
  const missing: string[] = [];
  for (const file of required) {
    if (!(await readableFile(file))) missing.push(path.basename(file));
  }
  if (missing.length) {
    return {
      id: "orchestrator",
      label: "Glimmer orchestrator",
      state: "unavailable",
      required: true,
      source: bundled ? "bundled" : "configured",
      detail: `Missing or unreadable: ${missing.join(", ")}.`,
    };
  }

  let origin: OrchestratorOrigin | null = null;
  try {
    origin = JSON.parse(await fs.readFile(path.join(root, "ORIGIN.json"), "utf8"));
  } catch {
    if (bundled) {
      return {
        id: "orchestrator",
        label: "Glimmer orchestrator",
        state: "unavailable",
        required: true,
        source: "bundled",
        detail: "The bundled integrity manifest is missing or invalid.",
      };
    }
  }

  if (bundled && (!origin?.files || typeof origin.files !== "object")) {
    return {
      id: "orchestrator",
      label: "Glimmer orchestrator",
      state: "unavailable",
      required: true,
      source: "bundled",
      detail: "The bundled integrity manifest has no valid file checksums.",
    };
  }

  if (bundled && origin?.files && typeof origin.files === "object") {
    const mismatches: string[] = [];
    const expectedFiles = options.expectedOrchestratorFiles ?? BUNDLED_ORCHESTRATOR_SHA256;
    for (const [name, expected] of Object.entries(expectedFiles)) {
      const manifested = (origin.files as Record<string, unknown>)[name];
      if (manifested !== expected) {
        mismatches.push(name);
        continue;
      }
      try {
        if ((await sha256(path.join(root, name))) !== expected) mismatches.push(name);
      } catch {
        mismatches.push(name);
      }
    }
    if (mismatches.length) {
      return {
        id: "orchestrator",
        label: "Glimmer orchestrator",
        state: "unavailable",
        required: true,
        source: "bundled",
        version: typeof origin.commit === "string" ? origin.commit.slice(0, 12) : undefined,
        detail: `Integrity check failed: ${mismatches.join(", ")}.`,
      };
    }
  }

  return {
    id: "orchestrator",
    label: "Glimmer orchestrator",
    state: "ready",
    required: true,
    source: bundled ? "bundled" : "configured",
    version: typeof origin?.commit === "string" ? origin.commit.slice(0, 12) : undefined,
    detail: bundled
      ? "All bundled files match the signed integrity manifest."
      : "Core scripts are readable.",
  };
}

export function gatewayHealth(): GatewayHealth {
  return {
    service: "glimmer-gateway",
    status: "ok",
    version: CONFIG.appVersion,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - startTime) / 1000)),
  };
}

export async function probeRuntimeReadiness(
  options: RuntimeProbeOptions = {},
): Promise<GatewayReadiness> {
  const [python, orchestrator, model] = await Promise.all([
    probePython(options),
    probeOrchestrator(options),
    probeModel(options.modelBaseUrl ?? CONFIG.modelBaseUrl, 2_000),
  ]);
  const modelReady = model.status === "ONLINE" || model.status === "REACHABLE_AUTH";
  const components: RuntimeComponentCheck[] = [
    {
      id: "gateway",
      label: "Local gateway",
      state: "ready",
      required: true,
      source: "local",
      version: CONFIG.appVersion,
      detail: "The local HTTP gateway is responding.",
    },
    python,
    orchestrator,
    {
      id: "model",
      label: "Model server",
      state: modelReady ? "ready" : "degraded",
      required: false,
      source: "configured",
      detail: modelReady
        ? `Model endpoint is reachable (${model.status}).`
        : "Model endpoint is offline; local gateway and task history remain available.",
    },
  ];
  const coreReady = components
    .filter((item) => item.required)
    .every((item) => item.state === "ready");
  return {
    status: !coreReady ? "unavailable" : modelReady ? "ready" : "degraded",
    coreReady,
    checkedAt: new Date().toISOString(),
    components,
  };
}

export async function collectDiagnostics(): Promise<DiagnosticsStatus> {
  const [readiness, cli, mcp] = await Promise.all([
    probeRuntimeReadiness(),
    probeCliIntegrations(),
    probeMcpIntegrations(),
  ]);
  return { health: gatewayHealth(), readiness, cli, mcp };
}

export async function repairInstallation(): Promise<RepairResult> {
  const actions: string[] = [];
  const writableDirectories = [
    CONFIG.stateRoot,
    sessionsDir(),
    gatewayRunsDir(),
    gatewayRunLogsDir(),
    CONFIG.modelKeysDir,
  ];
  for (const directory of writableDirectories) {
    let existed = true;
    try {
      await fs.access(directory, fsConstants.W_OK);
    } catch {
      existed = false;
    }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700).catch(() => undefined);
    if (!existed) actions.push(`Created writable state directory: ${sanitizeText(directory)}`);
  }
  const readiness = await probeRuntimeReadiness();
  const checks: RepairCheck[] = readiness.components.map((component) => ({
    ...component,
    repaired: false,
  }));
  const reinstallRequired = checks.some(
    (check) => check.required && check.state === "unavailable" && check.source === "bundled",
  );
  if (actions.length === 0) actions.push("Writable application state was already healthy.");
  if (reinstallRequired) {
    actions.push(
      "A signed bundled component is damaged; install the current signed release again.",
    );
  }
  return {
    checkedAt: new Date().toISOString(),
    repaired: actions.some((action) => action.startsWith("Created")),
    reinstallRequired,
    checks,
    actions,
  };
}

export function sanitizeText(value: string): string {
  const home = os.homedir();
  return value
    .replaceAll(home, "$HOME")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]")
    .replace(
      /(["']?\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)["']?\s*[:=]\s*["']?)([^"'\s,;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      "[REDACTED]",
    )
    .replace(
      /\b(?=[A-Za-z0-9._-]{32,}\b)(?=[A-Za-z0-9._-]*[A-Za-z])(?=[A-Za-z0-9._-]*\d)[A-Za-z0-9._-]+\b/g,
      "[REDACTED HIGH-ENTROPY VALUE]",
    )
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    );
}

function sanitizeValue(value: unknown, key = ""): unknown {
  if (/api[_-]?key|access[_-]?token|auth[_-]?token|password|secret/i.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, sanitizeValue(child, childKey)]),
    );
  }
  return value;
}

async function readLogTail(file: string): Promise<string> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
  } catch {
    return "[log omitted: not a regular private file]";
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      return "[log omitted: not a regular private file]";
    }
    const length = Math.min(stat.size, SUPPORT_LOG_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    return sanitizeText(buffer.toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function collectLogTails() {
  let sessionDirs: string[];
  try {
    sessionDirs = (await fs.readdir(gatewayRunLogsDir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, SUPPORT_LOG_SESSIONS);
  } catch {
    return [];
  }
  const logs: Array<{ sessionId: string; file: string; tail: string }> = [];
  for (const sessionId of sessionDirs) {
    const directory = path.join(gatewayRunLogsDir(), sessionId);
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries
      .filter((item) => item.isFile() && item.name.endsWith(".log"))
      .slice(0, 4)) {
      logs.push({
        sessionId,
        file: entry.name,
        tail: await readLogTail(path.join(directory, entry.name)),
      });
    }
  }
  return logs;
}

export async function createSupportBundle() {
  const [diagnostics, ids, logs] = await Promise.all([
    collectDiagnostics(),
    listSessionIds(),
    collectLogTails(),
  ]);
  const sessions = (await Promise.all(ids.slice(0, 20).map((id) => readSession(id))))
    .filter((session): session is NonNullable<typeof session> => session !== null)
    .slice(0, 10)
    .map((session) => ({
      id: session.id,
      status: session.status,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
    }));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    privacy: {
      credentialsIncluded: false,
      taskPromptsIncluded: false,
      logTailBytesPerFile: SUPPORT_LOG_BYTES,
    },
    diagnostics: sanitizeValue(diagnostics),
    sessions,
    logs,
  };
}
