import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { workspaceLeasesDir } from "../config.js";

export type WorkspaceLeaseState = "reserved" | "running" | "recovery_required";

export interface WorkspaceLease {
  version: 1;
  workspace: string;
  sessionId: string;
  state: WorkspaceLeaseState;
  createdAt: string;
  updatedAt: string;
  pid?: number;
  detail?: string;
}

export class WorkspaceLeaseConflictError extends Error {
  constructor(readonly lease: WorkspaceLease) {
    super(`workspace is owned by session ${lease.sessionId}`);
  }
}

const leaseQueues = new Map<string, Promise<unknown>>();

function withLeaseQueue<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const previous = leaseQueues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  leaseQueues.set(file, next);
  const cleanup = () => {
    if (leaseQueues.get(file) === next) leaseQueues.delete(file);
  };
  void next.then(cleanup, cleanup);
  return next;
}

function leaseKey(workspace: string): string {
  return createHash("sha256").update(workspace).digest("hex");
}

function leasePath(workspace: string): string {
  return path.join(workspaceLeasesDir(), `${leaseKey(workspace)}.json`);
}

async function canonicalWorkspace(workspace: string): Promise<string> {
  return fs.realpath(workspace);
}

async function readLeaseFile(file: string): Promise<WorkspaceLease | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as WorkspaceLease;
    return parsed?.version === 1 && typeof parsed.sessionId === "string" ? parsed : null;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeLease(file: string, lease: WorkspaceLease): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(lease, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
}

export async function acquireWorkspaceLease(
  workspace: string,
  sessionId: string,
): Promise<WorkspaceLease> {
  const canonical = await canonicalWorkspace(workspace);
  const file = leasePath(canonical);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const lease: WorkspaceLease = {
    version: 1,
    workspace: canonical,
    sessionId,
    state: "reserved",
    createdAt: now,
    updatedAt: now,
  };
  try {
    const handle = await fs.open(file, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(lease, null, 2), "utf8");
    } finally {
      await handle.close();
    }
    return lease;
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readLeaseFile(file);
    if (!existing) {
      throw new Error("workspace lease exists but is unreadable; run Repair installation", {
        cause: error,
      });
    }
    if (existing.sessionId === sessionId) return existing;
    throw new WorkspaceLeaseConflictError(existing);
  }
}

export async function updateWorkspaceLease(
  workspace: string,
  sessionId: string,
  update: Partial<Pick<WorkspaceLease, "state" | "pid" | "detail">>,
): Promise<WorkspaceLease | null> {
  const canonical = await canonicalWorkspace(workspace).catch(() => path.resolve(workspace));
  const file = leasePath(canonical);
  return withLeaseQueue(file, async () => {
    const existing = await readLeaseFile(file);
    if (!existing || existing.sessionId !== sessionId) return null;
    const next: WorkspaceLease = { ...existing, ...update, updatedAt: new Date().toISOString() };
    await writeLease(file, next);
    return next;
  });
}

export async function releaseWorkspaceLease(
  workspace: string,
  sessionId: string,
): Promise<boolean> {
  const canonical = await canonicalWorkspace(workspace).catch(() => path.resolve(workspace));
  const file = leasePath(canonical);
  return withLeaseQueue(file, async () => {
    const existing = await readLeaseFile(file);
    if (!existing || existing.sessionId !== sessionId) return false;
    await fs.unlink(file).catch((error: any) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return true;
  });
}

export async function listWorkspaceLeases(): Promise<WorkspaceLease[]> {
  let names: string[];
  try {
    names = await fs.readdir(workspaceLeasesDir());
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const leases = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map((name) => readLeaseFile(path.join(workspaceLeasesDir(), name))),
  );
  return leases.filter((lease): lease is WorkspaceLease => lease !== null);
}
