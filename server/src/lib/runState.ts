import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { GlimmerSession, GlimmerSessionStatus, TaskContract } from "@glimmer/shared";
import { gatewayRunsDir, sessionsDir } from "../config.js";

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export type GatewayRunState =
  | "created"
  | "starting"
  | "running"
  | "cancel_requested"
  | "exited"
  | "start_failed"
  | "interrupted";

export interface GatewayRunRecord {
  version: 1;
  id: string;
  contract: TaskContract;
  workspace: string;
  state: GatewayRunState;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  branch?: string;
  baselineSha?: string;
  pid?: number;
  exitCode?: number | null;
  error?: string;
  updatedAt?: string;
  heartbeatAt?: string;
  recovery?: NonNullable<GlimmerSession["recovery"]>;
}

const updateQueues = new Map<string, Promise<unknown>>();

function recordPath(id: string): string | null {
  if (!SAFE_ID.test(id) || id === "." || id === "..") return null;
  return path.join(gatewayRunsDir(), `${id}.json`);
}

async function atomicWrite(record: GatewayRunRecord): Promise<void> {
  const target = recordPath(record.id);
  if (!target) throw new Error("invalid gateway run id");
  await fs.mkdir(gatewayRunsDir(), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  record.updatedAt = new Date().toISOString();
  await fs.writeFile(temp, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
  const tempHandle = await fs.open(temp, "r");
  try {
    await tempHandle.sync();
  } finally {
    await tempHandle.close();
  }
  await fs.rename(temp, target);
  const directoryHandle = await fs.open(gatewayRunsDir(), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

type DurableCheckpoint = NonNullable<NonNullable<GlimmerSession["recovery"]>["durableCheckpoint"]>;

function safeGitPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return false;
  if (path.isAbsolute(value)) return false;
  return !value.split(/[\\/]/).includes("..");
}

/** Read the deliberately small JSON projection of runtime.sqlite3. */
export async function readDurableCheckpoint(
  id: string,
  workspace?: string,
): Promise<DurableCheckpoint | null> {
  if (!SAFE_ID.test(id) || id === "." || id === "..") return null;
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(sessionsDir(), id, "recovery-state.json"), "utf8"),
    ) as Record<string, unknown>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.sessionId !== id ||
      parsed.durable !== true ||
      typeof parsed.lastDurableAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.lastDurableAt)) ||
      typeof parsed.phase !== "string" ||
      parsed.phase.length > 100
    ) {
      return null;
    }
    const checkpoint: DurableCheckpoint = {
      lastDurableAt: parsed.lastDurableAt,
      phase: parsed.phase,
    };
    if (Number.isInteger(parsed.turn) && Number(parsed.turn) >= -1)
      checkpoint.turn = Number(parsed.turn);
    if (Number.isInteger(parsed.durableMessageCount) && Number(parsed.durableMessageCount) >= 0)
      checkpoint.durableMessageCount = Number(parsed.durableMessageCount);
    if (
      Number.isInteger(parsed.partialModelCharacters) &&
      Number(parsed.partialModelCharacters) >= 0
    )
      checkpoint.partialModelCharacters = Number(parsed.partialModelCharacters);

    const pending = parsed.pendingTool as Record<string, unknown> | null;
    if (
      pending &&
      typeof pending.callId === "string" &&
      pending.callId.length <= 200 &&
      typeof pending.tool === "string" &&
      pending.tool.length <= 100
    ) {
      checkpoint.pendingTool = {
        callId: pending.callId,
        tool: pending.tool,
        ...(safeGitPath(pending.path) ? { path: pending.path } : {}),
      };
    }

    const snapshot = parsed.snapshot as Record<string, unknown> | null;
    if (
      snapshot &&
      typeof snapshot.commit === "string" &&
      /^[a-f0-9]{40,64}$/.test(snapshot.commit)
    ) {
      let commitExists = true;
      if (workspace) {
        try {
          await execFileAsync("git", ["cat-file", "-e", `${snapshot.commit}^{commit}`], {
            cwd: workspace,
          });
        } catch {
          commitExists = false;
        }
      }
      if (commitExists) {
        checkpoint.snapshotCommit = snapshot.commit;
        if (Array.isArray(snapshot.changedFiles)) {
          checkpoint.snapshotChangedFiles = snapshot.changedFiles.filter(safeGitPath).slice(0, 500);
        }
      }
    }
    return checkpoint;
  } catch (error: any) {
    if (error?.code !== "ENOENT")
      console.warn(
        `[gateway-runs] unreadable durable checkpoint ${id}: ${error?.message ?? error}`,
      );
    return null;
  }
}

export function createCanonicalSessionId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${randomUUID().slice(0, 12)}`;
}

export async function createGatewayRun(
  contract: TaskContract,
  workspace: string,
): Promise<GatewayRunRecord> {
  const record: GatewayRunRecord = {
    version: 1,
    id: createCanonicalSessionId(),
    contract,
    workspace,
    state: "created",
    createdAt: new Date().toISOString(),
  };
  await atomicWrite(record);
  return record;
}

export async function readGatewayRun(id: string): Promise<GatewayRunRecord | null> {
  const target = recordPath(id);
  if (!target) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(target, "utf8")) as GatewayRunRecord;
    return parsed?.version === 1 && parsed.id === id ? parsed : null;
  } catch (err: any) {
    if (err?.code !== "ENOENT")
      console.warn(`[gateway-runs] unreadable record ${id}: ${err?.message ?? err}`);
    return null;
  }
}

export async function listGatewayRunIds(): Promise<string[]> {
  try {
    const names = await fs.readdir(gatewayRunsDir());
    return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

export function updateGatewayRun(
  id: string,
  mutate: (record: GatewayRunRecord) => GatewayRunRecord,
): Promise<GatewayRunRecord | null> {
  const previous = updateQueues.get(id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await readGatewayRun(id);
      if (!current) return null;
      const updated = mutate(current);
      await atomicWrite(updated);
      return updated;
    });
  updateQueues.set(id, next);
  const cleanup = () => {
    if (updateQueues.get(id) === next) updateQueues.delete(id);
  };
  void next.then(cleanup, cleanup);
  return next;
}

export async function isRecordedProcessAlive(record: GatewayRunRecord): Promise<boolean> {
  if (!Number.isInteger(record.pid) || (record.pid ?? 0) <= 1) return false;
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-p", String(record.pid), "-o", "command="]);
    return commandBelongsToRun(stdout.trim(), record.id);
  } catch {
    return false;
  }
}

export async function terminateRecordedProcess(record: GatewayRunRecord): Promise<boolean> {
  if (!(await isRecordedProcessAlive(record))) return false;
  const pid = record.pid!;
  try {
    // Gateway-launched orchestrators are process-group leaders. Signalling
    // the group makes restart recovery equivalent to the in-memory cancel
    // handle and prevents an engineer subprocess from surviving its session.
    process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
    return true;
  } catch {
    if (process.platform === "win32") return false;
    try {
      // Compatibility with records created before process groups were used.
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

export function commandBelongsToRun(command: string, id: string): boolean {
  if (!command.includes("glimmer-v2")) return false;
  const tokens = command.trim().split(/\s+/);
  const sessionFlag = tokens.indexOf("--session-id");
  return sessionFlag >= 0 && tokens[sessionFlag + 1] === id;
}

export function gatewayRunToSession(record: GatewayRunRecord): GlimmerSession {
  let status: GlimmerSessionStatus = "created";
  if (record.state === "starting" || record.state === "running") status = "preflight";
  if (record.state === "cancel_requested") status = "cancelled";
  if (record.state === "exited" || record.state === "start_failed") status = "failed";
  if (record.state === "interrupted") status = "needs_review";
  const terminal = status === "cancelled" || status === "failed" || status === "needs_review";
  return {
    id: record.id,
    task: record.contract.objective,
    taskContract: record.contract,
    status,
    workspace: record.workspace,
    branch: record.branch ?? "Unavailable",
    baselineSha: record.baselineSha ?? "Unavailable",
    startedAt: record.startedAt,
    completedAt: terminal ? record.completedAt : undefined,
    changedFiles: record.recovery?.changedFiles ?? [],
    ...(record.recovery ? { recovery: record.recovery } : {}),
    verification: {
      overall: record.state === "interrupted" ? "NEEDS_REVIEW" : "NOT_RUN",
      checks: [],
    },
    repairsUsed: 0,
    repairBudget: record.contract.repairBudget,
    finalStatus: {
      functional: record.state === "interrupted" ? "NEEDS_REVIEW" : "NOT_RUN",
      visual: "not_run",
      architecture: "not_run",
      documentation: "not_run",
    },
  };
}
