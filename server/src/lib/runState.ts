import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { GlimmerSession, GlimmerSessionStatus, TaskContract } from "@glimmer/shared";
import { gatewayRunsDir } from "../config.js";

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export type GatewayRunState =
  | "created"
  | "starting"
  | "running"
  | "cancel_requested"
  | "exited"
  | "start_failed";

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
  await fs.writeFile(temp, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, target);
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
    if (err?.code !== "ENOENT") console.warn(`[gateway-runs] unreadable record ${id}: ${err?.message ?? err}`);
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
  const next = previous.catch(() => undefined).then(async () => {
    const current = await readGatewayRun(id);
    if (!current) return null;
    const updated = mutate(current);
    await atomicWrite(updated);
    return updated;
  });
  updateQueues.set(id, next);
  void next.finally(() => {
    if (updateQueues.get(id) === next) updateQueues.delete(id);
  });
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
  const terminal = status === "cancelled" || status === "failed";
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
    changedFiles: [],
    verification: { overall: "NOT_RUN", checks: [] },
    repairsUsed: 0,
    repairBudget: record.contract.repairBudget,
    finalStatus: {
      functional: "NOT_RUN",
      visual: "not_run",
      architecture: "not_run",
      documentation: "not_run",
    },
  };
}
