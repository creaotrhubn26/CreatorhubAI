import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CONFIG } from "../../config.js";

const SAFE_ID = /^[A-Za-z0-9-]{1,80}$/;
const SAFE_SECRET = /^[A-Za-z0-9_-]{32,256}$/;

export interface WorkerSecretV1 {
  version: 1;
  leaseId: string;
  bootstrapToken?: string;
  capability?: string;
  checkpointKey?: string;
  handshakeIdempotencyKey: string;
  controllerNonce: string;
  createdAt: string;
  rotatedAt?: string;
}

function secretPath(leaseId: string): string {
  if (!SAFE_ID.test(leaseId)) throw new Error("worker secret lease id is invalid");
  return path.join(CONFIG.computeWorkerKeysDir, `${leaseId}.json`);
}

function isWorkerSecret(value: unknown, leaseId: string): value is WorkerSecretV1 {
  if (!value || typeof value !== "object") return false;
  const raw = value as Partial<WorkerSecretV1>;
  return (
    raw.version === 1 &&
    raw.leaseId === leaseId &&
    typeof raw.handshakeIdempotencyKey === "string" &&
    SAFE_SECRET.test(raw.handshakeIdempotencyKey) &&
    typeof raw.controllerNonce === "string" &&
    SAFE_SECRET.test(raw.controllerNonce) &&
    typeof raw.createdAt === "string" &&
    Number.isFinite(Date.parse(raw.createdAt)) &&
    (raw.bootstrapToken === undefined || SAFE_SECRET.test(raw.bootstrapToken)) &&
    (raw.capability === undefined || SAFE_SECRET.test(raw.capability)) &&
    (raw.checkpointKey === undefined || SAFE_SECRET.test(raw.checkpointKey)) &&
    (raw.rotatedAt === undefined || Number.isFinite(Date.parse(raw.rotatedAt)))
  );
}

async function writeAtomic(secret: WorkerSecretV1): Promise<void> {
  await fs.mkdir(CONFIG.computeWorkerKeysDir, { recursive: true, mode: 0o700 });
  await fs.chmod(CONFIG.computeWorkerKeysDir, 0o700);
  const target = secretPath(secret.leaseId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(secret)}\n`, { encoding: "utf8", mode: 0o600 });
  const handle = await fs.open(temporary, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
}

function generatedSecret(): string {
  return randomBytes(32).toString("base64url");
}

export async function createWorkerSecret(leaseId: string): Promise<WorkerSecretV1> {
  const secret: WorkerSecretV1 = {
    version: 1,
    leaseId,
    bootstrapToken: generatedSecret(),
    handshakeIdempotencyKey: generatedSecret(),
    controllerNonce: generatedSecret(),
    createdAt: new Date().toISOString(),
  };
  await writeAtomic(secret);
  return secret;
}

export async function readWorkerSecret(leaseId: string): Promise<WorkerSecretV1 | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(secretPath(leaseId), "utf8"));
    if (!isWorkerSecret(parsed, leaseId)) throw new Error("stored worker secret is invalid");
    return parsed;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function storeWorkerHandshake(
  leaseId: string,
  capability: string,
  checkpointKey: string,
): Promise<WorkerSecretV1> {
  if (!SAFE_SECRET.test(capability) || !SAFE_SECRET.test(checkpointKey)) {
    throw new Error("worker handshake returned an invalid secret");
  }
  const current = await readWorkerSecret(leaseId);
  if (!current) throw new Error("worker bootstrap state is missing");
  const updated: WorkerSecretV1 = {
    ...current,
    bootstrapToken: undefined,
    capability,
    checkpointKey,
    rotatedAt: new Date().toISOString(),
  };
  await writeAtomic(updated);
  return updated;
}

export async function deleteWorkerSecret(leaseId: string): Promise<void> {
  await fs.unlink(secretPath(leaseId)).catch((error: any) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
