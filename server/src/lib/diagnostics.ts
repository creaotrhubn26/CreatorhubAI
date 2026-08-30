import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DiagnosticsStatus,
  GatewayHealth,
  GatewayReadiness,
  RepairCheck,
  RepairResult,
  RecoverySmokeResult,
  RuntimeComponentCheck,
} from "@glimmer/shared";
import {
  CONFIG,
  gatewayRunLogsDir,
  gatewayRunsDir,
  recoveryBackupsDir,
  sessionIndexPath,
  sessionsDir,
  workspaceLeasesDir,
} from "../config.js";
import { probeCliIntegrations } from "./cliIntegrations.js";
import { probeMcpIntegrations } from "./mcpIntegrations.js";
import { probeModel } from "./modelStatus.js";
import { listWorkspaceLeases } from "./workspaceLeases.js";
import { readSessionPage } from "./sessionRegistry.js";

const startTime = Date.now();
const SUPPORT_LOG_BYTES = 16 * 1024;
const SUPPORT_LOG_SESSIONS = 3;
export const BUNDLED_ORCHESTRATOR_SHA256: Record<string, string> = {
  "glimmer-v2.py": "ecd0952e83bc9fd658230e4aa2707d92e90151e994529e78aacbd011b067ee4a",
  "glimmer-engineer.py": "16be8ca1c4ec368e3247a1f034a0db5b8418235129cf964962d12ee9bda3f7db",
  "glimmer_events.py": "2fd4aa0afbe32b58150be442c0e2b4cbb70f1c5ab65f2a9d2e857b239cd34454",
  "glimmer_journal.py": "67a28a2c480ca65ff49133968bda89a0c4f9e670aa02e28cd5fcb3e269464cf5",
  "glimmer_models.py": "584302c1b0689f70d825fe5a155ed88d410cba8c835de054429c6b233138409c",
  "glimmer_memory.py": "84db728096ee22c016e6abdb6efdad4b88620a3a19aa6b95eda698f9fa523920",
  "glimmer_quality.py": "cadc645a90f18cd5b069f6cd90191a55b02d9c2ad0bb16a72186baa79cce3188",
  "glimmer_semantic.py": "e1d3ce00c33f6db5d4183b1e8c237bbea50532ee051018b64b577163f864f167",
  "glimmer_verification.py": "fbd486ad5811ab3d4872f6638dd28e996c57119324bc2f04ab20fb393c9c4711",
  "glimmer-visual.py": "c9bf09838ca8742e0225a71b52ee77ac99bf4ee30f03a1b258b94828671a0ee3",
  "glimmer_remote.py": "5771ff5870bfc74b35cdad90c7011da5f23ca88bf2d54eb2f9a8a59188926bfd",
  "runpod_worker.py": "971aaa7c537d810a860ba213da06e0185dd9b5525869dffb147313f57d1eba68",
  "run-github-mcp.sh": "409041d9bd09a9febc199f755190caab073319ba68f1f3eae5417c14c4af5c33",
  "eval-baselines/baseline-stub.json":
    "65fcc635efca36848fa1e1b4069a99ee8c8f556760ef50ada005f52564976c18",
  "eval-baselines/latest-stub.json":
    "ab485efbfca4f7eb10d6105ad3b82c9b2cb82afba9231c9d4da915475c734a45",
  "eval-baselines/baseline-live.json":
    "342ea08539e3dafb23bd0a529a63fd5b398f721412261fc8e4a6c5cecfb3aa41",
  "eval-baselines/latest-live.json":
    "67b2c16d33f3cb59131d3a14147fa3912b3467bc28cb06736cda327ba7116d91",
};
const BUNDLED_PYTHON_SHA256: Record<string, string> = {
  "lib/python3.13/os.py": "18560b0a37dfb90b4712fba97668d44a1328c5566b10deffaee292ba12cc21ff",
  "lib/python3.13/ssl.py": "538bb1cb334bebb9cd45b58503473ba7fd99cc9a5b769b2ff5caea81876227c3",
  "lib/python3.13/json/__init__.py":
    "43e38afede6d52ae0d602a42209b9959fc66d6020a25bcf15921446f5d1c262f",
  "lib/python3.13/sqlite3/__init__.py":
    "6e956d2166e24ccf36fef21ad63d06a5dd8f7b674aca6c81ea91eacca6b85b01",
  "requirements-tree-sitter.lock":
    "8bfe061a1ca73426e415f9a3ad2ffbe587e8bc49bb81423af8892cc1ffaa9326",
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
    "import json, pathlib, sqlite3, ssl, sys, tree_sitter, tree_sitter_python, tree_sitter_javascript, tree_sitter_typescript, tree_sitter_rust; print(sys.version.split()[0])",
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
      ) as { files?: unknown; treeSitterNativeFiles?: unknown };
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
      if (
        !origin.treeSitterNativeFiles ||
        typeof origin.treeSitterNativeFiles !== "object" ||
        Object.keys(origin.treeSitterNativeFiles).length < 5
      ) {
        throw new Error("Tree-sitter native integrity entries are missing");
      }
      const home = path.resolve(pythonHome);
      for (const [name, expected] of Object.entries(
        origin.treeSitterNativeFiles as Record<string, unknown>,
      )) {
        const target = path.resolve(home, name);
        if (
          typeof expected !== "string" ||
          !/^[a-f0-9]{64}$/.test(expected) ||
          !target.startsWith(home + path.sep) ||
          !/\.(so|dylib)$/.test(name) ||
          (await sha256(target)) !== expected
        ) {
          throw new Error(`${name} native checksum mismatch`);
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
  overlay?: { id?: unknown };
  snapshot?: { id?: unknown };
  files?: unknown;
}

function orchestratorVersion(origin: OrchestratorOrigin | null): string | undefined {
  if (typeof origin?.commit !== "string") return undefined;
  const base = origin.commit.slice(0, 12);
  const qualifier =
    typeof origin.snapshot?.id === "string"
      ? origin.snapshot.id
      : typeof origin.overlay?.id === "string"
        ? origin.overlay.id
        : null;
  return qualifier ? `${base}+${qualifier}` : base;
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
        version: orchestratorVersion(origin),
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
    version: orchestratorVersion(origin),
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
    instanceId: CONFIG.instanceId,
    ...(CONFIG.parentPid ? { parentPid: CONFIG.parentPid } : {}),
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

const STALE_TEMP_AGE_MS = 5 * 60 * 1000;

async function backupJsonDirectory(source: string, target: string): Promise<number> {
  const entries = await fs.readdir(source, { withFileTypes: true }).catch(() => []);
  let copied = 0;
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    await fs.copyFile(path.join(source, entry.name), path.join(target, entry.name));
    await fs.chmod(path.join(target, entry.name), 0o600);
    copied += 1;
  }
  return copied;
}

async function createRecoveryBackup(): Promise<string> {
  const name = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const target = path.join(recoveryBackupsDir(), name);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  await Promise.all([
    backupJsonDirectory(gatewayRunsDir(), path.join(target, "gateway-runs")),
    backupJsonDirectory(workspaceLeasesDir(), path.join(target, "workspace-leases")),
  ]);
  try {
    await fs.copyFile(sessionIndexPath(), path.join(target, "session-index.json"));
    await fs.chmod(path.join(target, "session-index.json"), 0o600);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return target;
}

async function cleanStaleTemporaryFiles(directory: string): Promise<number> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  let cleaned = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".tmp")) continue;
    const target = path.join(directory, entry.name);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || Date.now() - stat.mtimeMs < STALE_TEMP_AGE_MS) continue;
    await fs.unlink(target);
    cleaned += 1;
  }
  return cleaned;
}

export async function repairInstallation(
  recovery?: RepairResult["recovery"],
): Promise<RepairResult> {
  const actions: string[] = [];
  const writableDirectories = [
    CONFIG.stateRoot,
    sessionsDir(),
    gatewayRunsDir(),
    gatewayRunLogsDir(),
    workspaceLeasesDir(),
    recoveryBackupsDir(),
    CONFIG.modelKeysDir,
    CONFIG.computeKeysDir,
    CONFIG.computeWorkerKeysDir,
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
  const backupPath = await createRecoveryBackup();
  actions.push(`Created a private recovery backup: ${sanitizeText(backupPath)}`);
  const cleaned =
    (await cleanStaleTemporaryFiles(gatewayRunsDir())) +
    (await cleanStaleTemporaryFiles(workspaceLeasesDir()));
  if (cleaned > 0) actions.push(`Removed ${cleaned} stale atomic-write temporary file(s).`);
  if (recovery && (recovery.reattached || recovery.interrupted || recovery.completed)) {
    actions.push(
      `Reconciled sessions: ${recovery.reattached} running, ${recovery.interrupted} interrupted, ${recovery.completed} completed.`,
    );
  }
  const readiness = await probeRuntimeReadiness();
  const checks: RepairCheck[] = readiness.components.map((component) => ({
    ...component,
    repaired: false,
  }));
  const reinstallRequired = checks.some(
    (check) => check.required && check.state === "unavailable" && check.source === "bundled",
  );
  if (reinstallRequired) {
    actions.push(
      "A signed bundled component is damaged; install the current signed release again.",
    );
  }
  return {
    checkedAt: new Date().toISOString(),
    repaired: actions.some(
      (action) => action.startsWith("Created writable") || action.startsWith("Removed"),
    ),
    reinstallRequired,
    checks,
    actions,
    backupPath,
    ...(recovery ? { recovery } : {}),
  };
}

export async function runRecoverySmoke(): Promise<RecoverySmokeResult> {
  const checks: RecoverySmokeResult["checks"] = [];
  const readiness = await probeRuntimeReadiness();
  checks.push({
    id: "runtime",
    ok: readiness.coreReady,
    detail: readiness.coreReady
      ? "Required runtime components are ready."
      : "A required runtime component is unavailable.",
  });

  const smokeFile = path.join(CONFIG.stateRoot, `.smoke-${randomUUID()}.tmp`);
  try {
    const payload = randomUUID();
    await fs.mkdir(CONFIG.stateRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(smokeFile, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const readBack = await fs.readFile(smokeFile, "utf8");
    checks.push({
      id: "state-write",
      ok: readBack === payload,
      detail:
        readBack === payload ? "Atomic state write/read passed." : "State read-back differed.",
    });
  } catch (error) {
    checks.push({
      id: "state-write",
      ok: false,
      detail: `State write/read failed: ${sanitizeText(error instanceof Error ? error.message : String(error))}`,
    });
  } finally {
    await fs.unlink(smokeFile).catch(() => undefined);
  }

  try {
    await readSessionPage({ limit: 1 });
    checks.push({ id: "session-index", ok: true, detail: "Session registry read passed." });
  } catch (error) {
    checks.push({
      id: "session-index",
      ok: false,
      detail: `Session registry read failed: ${sanitizeText(error instanceof Error ? error.message : String(error))}`,
    });
  }
  try {
    await listWorkspaceLeases();
    checks.push({ id: "workspace-leases", ok: true, detail: "Workspace lease scan passed." });
  } catch (error) {
    checks.push({
      id: "workspace-leases",
      ok: false,
      detail: `Workspace lease scan failed: ${sanitizeText(error instanceof Error ? error.message : String(error))}`,
    });
  }
  return {
    status: checks.every((check) => check.ok) ? "passed" : "failed",
    checkedAt: new Date().toISOString(),
    checks,
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

async function collectSessionLogInventory() {
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
  const logs: Array<{ sessionId: string; file: string; sizeBytes: number }> = [];
  for (const sessionId of sessionDirs) {
    const directory = path.join(gatewayRunLogsDir(), sessionId);
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries
      .filter((item) => item.isFile() && item.name.endsWith(".log"))
      .slice(0, 4)) {
      logs.push({
        sessionId,
        file: entry.name,
        sizeBytes: (await fs.stat(path.join(directory, entry.name))).size,
      });
    }
  }
  return logs;
}

export async function createSupportBundle() {
  const [diagnostics, sessionPage, sessionLogs, leases, gatewayLog] = await Promise.all([
    collectDiagnostics(),
    readSessionPage({ limit: 10 }),
    collectSessionLogInventory(),
    listWorkspaceLeases(),
    CONFIG.gatewayLogPath ? readLogTail(CONFIG.gatewayLogPath) : Promise.resolve(null),
  ]);
  const sessions = sessionPage.sessions.map((session) => ({
    id: session.id,
    status: session.status,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    recovery: session.recovery
      ? {
          detectedAt: session.recovery.detectedAt,
          progressPreserved: session.recovery.progressPreserved,
          changedFileCount: session.recovery.changedFiles.length,
          acknowledgedAt: session.recovery.acknowledgedAt,
        }
      : undefined,
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
    gatewayLog,
    sessionLogs,
    workspaceLeases: leases.map((lease) => ({
      sessionId: lease.sessionId,
      state: lease.state,
      workspace: sanitizeText(lease.workspace),
      updatedAt: lease.updatedAt,
      pid: lease.pid,
    })),
  };
}
