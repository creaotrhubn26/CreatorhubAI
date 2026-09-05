import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RemoteJobManifestV1, RemoteJobStatusV1, TaskContract } from "@glimmer/shared";
import { RemoteWorkerRunBackend, type RemoteBundlePart } from "./runBackend.js";
import {
  WorkerClient,
  WorkerProtocolError,
  decryptWorkerCheckpoint,
} from "./compute/workerClient.js";

const execFileAsync = promisify(execFile);

/** Matches the worker's per-part ceiling (glimmer_remote.MAX_PART_BYTES is 8 MiB). */
const PART_BYTES = 4 * 1024 * 1024;
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const POLL_INTERVAL_MS = 2_000;

export interface RemoteBundle {
  bytes: number;
  sha256: string;
  parts: RemoteBundlePart[];
}

export async function packWorkspaceBundle(workspace: string): Promise<RemoteBundle> {
  const bundlePath = path.join(os.tmpdir(), `glimmer-remote-${randomUUID()}.bundle`);
  try {
    await execFileAsync("git", ["-C", workspace, "bundle", "create", bundlePath, "HEAD"], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const bytes = await fs.readFile(bundlePath);
    const parts: RemoteBundlePart[] = [];
    for (let offset = 0, index = 0; offset < bytes.byteLength; offset += PART_BYTES, index += 1) {
      const chunk = bytes.subarray(offset, Math.min(offset + PART_BYTES, bytes.byteLength));
      parts.push({
        index,
        bytes: chunk,
        sha256: createHash("sha256").update(chunk).digest("hex"),
      });
    }
    if (parts.length === 0) throw new WorkerProtocolError("workspace bundle is empty");
    return {
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      parts,
    };
  } finally {
    await fs.rm(bundlePath, { force: true }).catch(() => undefined);
  }
}

export function buildRemoteManifest(input: {
  instanceId: string;
  sessionId: string;
  baselineSha: string;
  branch: string;
  contract: TaskContract;
  contextTokens: 65_536 | 131_072;
  bundle: RemoteBundle;
  now?: Date;
}): RemoteJobManifestV1 {
  if (!input.branch.startsWith("glimmer/")) {
    throw new WorkerProtocolError("remote sessions require a glimmer/* branch");
  }
  return {
    schemaVersion: 1,
    instanceId: input.instanceId,
    sessionId: input.sessionId,
    jobId: input.sessionId,
    repositoryFingerprint: input.bundle.sha256,
    baselineSha: input.baselineSha,
    branch: input.branch as `glimmer/${string}`,
    objective: input.contract.objective,
    contextTokens: input.contextTokens,
    maxRepairs: input.contract.repairBudget ?? 0,
    timeoutSeconds: 3_600,
    createdAt: (input.now ?? new Date()).toISOString(),
    input: {
      format: "git_bundle",
      parts: input.bundle.parts.length,
      bytes: input.bundle.bytes,
      sha256: input.bundle.sha256,
    },
  };
}

/**
 * Result-kind checkpoints are sequential chunks of ONE tar stream; the final
 * chunk is flagged. Each chunk is an independently encrypted GLMR1 envelope.
 */
async function downloadResultArchive(
  worker: WorkerClient,
  status: RemoteJobStatusV1,
  capability: string,
  checkpointKey: string,
): Promise<Buffer> {
  const chunks = status.checkpoints
    .filter((checkpoint) => checkpoint.kind === "result")
    .sort((a, b) => a.sequence - b.sequence);
  if (chunks.length === 0 || !chunks[chunks.length - 1].final) {
    throw new WorkerProtocolError("remote job finished without a final result checkpoint");
  }
  const plain: Buffer[] = [];
  for (const checkpoint of chunks) {
    const download = await worker.checkpoint(status.jobId, checkpoint.sequence, capability);
    plain.push(
      Buffer.from(
        decryptWorkerCheckpoint(checkpointKey, download.bytes, {
          schemaVersion: 1,
          jobId: status.jobId,
          sessionId: status.sessionId,
          sequence: checkpoint.sequence,
          kind: checkpoint.kind,
          final: checkpoint.final,
          plaintextSha256: checkpoint.plaintextSha256,
        }),
      ),
    );
    await worker
      .acknowledgeCheckpoint(
        status.jobId,
        checkpoint.sequence,
        download.sha256,
        capability,
        `${status.jobId}:ack:${checkpoint.sequence}`,
      )
      .catch(() => undefined);
  }
  return Buffer.concat(plain);
}

const SAFE_ARCHIVE_ENTRY = /^(result\.json|session(\/[^/]+)+\/?)$/;

async function assertSafeArchive(archivePath: string): Promise<void> {
  const { stdout } = await execFileAsync("tar", ["-tf", archivePath], {
    maxBuffer: 4 * 1024 * 1024,
  });
  for (const line of stdout.split("\n")) {
    const entry = line.trim();
    if (!entry) continue;
    if (
      entry.startsWith("/") ||
      entry.split("/").includes("..") ||
      !SAFE_ARCHIVE_ENTRY.test(entry)
    ) {
      throw new WorkerProtocolError(`remote result archive contains an unsafe entry: ${entry}`);
    }
  }
}

export interface RemoteSessionOutcome {
  state: RemoteJobStatusV1["state"];
  exitCode: number | null;
  detail?: string;
}

export interface RemoteSessionDeps {
  worker: WorkerClient;
  capability: string;
  checkpointKey: string;
  sessionDir: string;
  logDir: string;
  sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number;
}

export async function runRemoteSession(
  deps: RemoteSessionDeps,
  manifest: RemoteJobManifestV1,
  parts: readonly RemoteBundlePart[],
  cancelled: () => boolean,
): Promise<RemoteSessionOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const backend = new RemoteWorkerRunBackend(deps.worker, deps.capability);
  const handle = await backend.start({ manifest, parts });
  const deadline = Date.now() + (deps.deadlineMs ?? (manifest.timeoutSeconds + 600) * 1_000);
  let status = handle.accepted;
  let cancelRequested = false;
  for (;;) {
    if (TERMINAL_STATES.has(status.state)) break;
    if (Date.now() > deadline) {
      await handle.cancel().catch(() => undefined);
      return { state: "interrupted", exitCode: null, detail: "remote job deadline elapsed" };
    }
    if (!cancelRequested && cancelled()) {
      cancelRequested = true;
      await handle.cancel().catch(() => undefined);
    }
    await sleep(POLL_INTERVAL_MS);
    try {
      status = await handle.status();
    } catch {
      // Transient proxy failures must not kill a running remote job.
    }
  }
  if (status.state === "cancelled") {
    return { state: status.state, exitCode: status.exitCode ?? null, detail: status.detail };
  }
  const archive = await downloadResultArchive(
    deps.worker,
    status,
    deps.capability,
    deps.checkpointKey,
  );
  await fs.mkdir(deps.logDir, { recursive: true });
  const archivePath = path.join(deps.logDir, "remote-result.tar");
  await fs.writeFile(archivePath, archive, { mode: 0o600 });
  await assertSafeArchive(archivePath);
  await fs.mkdir(deps.sessionDir, { recursive: true });
  // result.json lands in logDir; session/* is flattened into the session
  // directory so readSession sees the same layout a local run produces.
  await execFileAsync("tar", ["-xf", archivePath, "-C", deps.logDir, "result.json"]).catch(
    () => undefined,
  );
  await execFileAsync("tar", [
    "-xf",
    archivePath,
    "-C",
    deps.sessionDir,
    "--strip-components=1",
    "session",
  ]);
  let exitCode: number | null = status.exitCode ?? null;
  try {
    const result = JSON.parse(await fs.readFile(path.join(deps.logDir, "result.json"), "utf8"));
    if (Number.isInteger(result?.exitCode)) exitCode = result.exitCode;
  } catch {
    // The worker-reported exit code stands when result.json is unavailable.
  }
  return { state: status.state, exitCode, detail: status.detail };
}
