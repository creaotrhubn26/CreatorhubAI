import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RemoteJobStatusV1, TaskContract } from "@glimmer/shared";
import { canonicalJsonBytes } from "./compute/workerClient.js";
import { buildRemoteManifest, packWorkspaceBundle, runRemoteSession } from "./remoteSessionRun.js";

const execFileAsync = promisify(execFile);

const CONTRACT: TaskContract = {
  objective: "Summarize the repository.",
  scope: { package: "repository" },
  mode: "inspect",
  constraints: {
    minimalChange: true,
    noCommit: true,
    noPush: true,
    noDeploy: true,
    noDependencyInstall: true,
  },
  verification: [],
  repairBudget: 0,
} as TaskContract;

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "remote-session-"));
});
afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

async function createWorkspace(): Promise<string> {
  const workspace = path.join(scratch, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "README.md"), "# fixture\n");
  const git = (...args: string[]) => execFileAsync("git", ["-C", workspace, ...args]);
  await git("init", "-q", "-b", "glimmer/remote-fixture");
  await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  await git("add", "-A");
  await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fixture");
  return workspace;
}

function encryptCheckpoint(
  keyBase64Url: string,
  metadata: Record<string, unknown>,
  plaintext: Buffer,
): Buffer {
  const key = Buffer.from(keyBase64Url, "base64url");
  const nonce = randomBytes(12);
  const aad = Buffer.from(canonicalJsonBytes(metadata));
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32BE(aad.byteLength);
  return Buffer.concat([
    Buffer.from("GLMR1", "ascii"),
    nonce,
    lengthPrefix,
    aad,
    ciphertext,
    cipher.getAuthTag(),
  ]);
}

/** Minimal ustar writer so tests can produce archives tar itself refuses to create. */
function ustarArchive(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000600\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${entry.content.byteLength.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.write("        ", 148, 8, "ascii");
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header);
    blocks.push(entry.content);
    const remainder = entry.content.byteLength % 512;
    if (remainder) blocks.push(Buffer.alloc(512 - remainder));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function fakeWorker(archive: Buffer, checkpointKey: string, options: { chunkBytes?: number } = {}) {
  const chunkBytes = options.chunkBytes ?? Math.ceil(archive.byteLength / 2);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < archive.byteLength; offset += chunkBytes) {
    chunks.push(archive.subarray(offset, Math.min(offset + chunkBytes, archive.byteLength)));
  }
  const calls: string[] = [];
  let manifest: any = null;
  const status = (state: RemoteJobStatusV1["state"]): RemoteJobStatusV1 => ({
    schemaVersion: 1,
    jobId: manifest.jobId,
    sessionId: manifest.sessionId,
    state,
    receivedParts: manifest.input.parts,
    expectedParts: manifest.input.parts,
    receivedBytes: manifest.input.bytes,
    expectedBytes: manifest.input.bytes,
    createdAt: manifest.createdAt,
    updatedAt: manifest.createdAt,
    exitCode: state === "succeeded" ? 0 : 1,
    checkpoints: chunks.map((chunk, sequence) => ({
      sequence,
      bytes: chunk.byteLength + 64,
      sha256: "0".repeat(64),
      plaintextSha256: createHash("sha256").update(chunk).digest("hex"),
      kind: "result" as const,
      final: sequence === chunks.length - 1,
      acknowledged: false,
    })),
  });
  const uploaded: number[] = [];
  return {
    calls,
    uploaded,
    worker: {
      createJob: async (value: any) => {
        manifest = value;
        calls.push("create");
        return status("created");
      },
      uploadPart: async (input: any) => {
        uploaded.push(input.part);
        calls.push(`part:${input.part}`);
        return status("uploading");
      },
      startJob: async () => {
        calls.push("start");
        return status("running");
      },
      jobStatus: async () => {
        calls.push("status");
        return status("succeeded");
      },
      cancelJob: async () => {
        calls.push("cancel");
        return status("cancelled");
      },
      checkpoint: async (_jobId: string, sequence: number) => {
        calls.push(`checkpoint:${sequence}`);
        const chunk = chunks[sequence];
        const bytes = encryptCheckpoint(
          checkpointKey,
          {
            schemaVersion: 1,
            jobId: manifest.jobId,
            sessionId: manifest.sessionId,
            sequence,
            kind: "result",
            final: sequence === chunks.length - 1,
            plaintextSha256: createHash("sha256").update(chunk).digest("hex"),
          },
          Buffer.from(chunk),
        );
        return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
      },
      acknowledgeCheckpoint: async (_jobId: string, sequence: number) => {
        calls.push(`ack:${sequence}`);
        return {};
      },
    } as any,
  };
}

describe("packWorkspaceBundle", () => {
  it("produces a checksum-consistent, clonable bundle", async () => {
    const workspace = await createWorkspace();
    const bundle = await packWorkspaceBundle(workspace);
    expect(bundle.parts.length).toBeGreaterThan(0);
    const total = bundle.parts.reduce((sum, part) => sum + part.bytes.byteLength, 0);
    expect(total).toBe(bundle.bytes);
    const joined = Buffer.concat(bundle.parts.map((part) => Buffer.from(part.bytes)));
    expect(createHash("sha256").update(joined).digest("hex")).toBe(bundle.sha256);
    const bundlePath = path.join(scratch, "roundtrip.bundle");
    await fs.writeFile(bundlePath, joined);
    const clone = path.join(scratch, "clone");
    await execFileAsync("git", ["clone", "-q", bundlePath, clone]);
    const { stdout } = await execFileAsync("git", ["-C", clone, "log", "--oneline"]);
    expect(stdout).toContain("fixture");
  });
});

describe("buildRemoteManifest", () => {
  it("binds the manifest to the bundle and refuses non-glimmer branches", async () => {
    const workspace = await createWorkspace();
    const bundle = await packWorkspaceBundle(workspace);
    const manifest = buildRemoteManifest({
      instanceId: "gateway-test",
      sessionId: "20260905-190000-abcdefabcdef",
      baselineSha: "a".repeat(40),
      branch: "glimmer/remote-fixture",
      contract: CONTRACT,
      contextTokens: 65_536,
      bundle,
    });
    expect(manifest.jobId).toBe(manifest.sessionId);
    expect(manifest.input.sha256).toBe(bundle.sha256);
    expect(manifest.repositoryFingerprint).toBe(bundle.sha256);
    expect(() =>
      buildRemoteManifest({
        instanceId: "gateway-test",
        sessionId: "s1",
        baselineSha: "a".repeat(40),
        branch: "main",
        contract: CONTRACT,
        contextTokens: 65_536,
        bundle,
      }),
    ).toThrow(/glimmer/);
  });
});

describe("runRemoteSession", () => {
  const checkpointKey = randomBytes(32).toString("base64url");

  async function makeManifest() {
    const workspace = await createWorkspace();
    const bundle = await packWorkspaceBundle(workspace);
    const manifest = buildRemoteManifest({
      instanceId: "gateway-test",
      sessionId: "20260905-190000-abcdefabcdef",
      baselineSha: "a".repeat(40),
      branch: "glimmer/remote-fixture",
      contract: CONTRACT,
      contextTokens: 65_536,
      bundle,
    });
    return { bundle, manifest };
  }

  it("uploads, polls, reassembles multi-chunk checkpoints, and lands session artifacts", async () => {
    const { bundle, manifest } = await makeManifest();
    const archive = ustarArchive([
      { name: "result.json", content: Buffer.from(JSON.stringify({ exitCode: 2 })) },
      { name: "session/manifest.json", content: Buffer.from("{}") },
      { name: "session/orchestrator.log", content: Buffer.from("done\n") },
    ]);
    const fake = fakeWorker(archive, checkpointKey, { chunkBytes: 700 });
    const sessionDir = path.join(scratch, "session-out");
    const logDir = path.join(scratch, "logs");
    const outcome = await runRemoteSession(
      {
        worker: fake.worker,
        capability: "C".repeat(43),
        checkpointKey,
        sessionDir,
        logDir,
        sleep: async () => {},
      },
      manifest,
      bundle.parts,
      () => false,
    );
    expect(outcome.state).toBe("succeeded");
    expect(outcome.exitCode).toBe(2);
    expect(fake.uploaded).toEqual(bundle.parts.map((part) => part.index));
    expect(fake.calls.filter((call) => call.startsWith("checkpoint:")).length).toBeGreaterThan(1);
    await expect(fs.readFile(path.join(sessionDir, "manifest.json"), "utf8")).resolves.toBe("{}");
    await expect(fs.readFile(path.join(sessionDir, "orchestrator.log"), "utf8")).resolves.toBe(
      "done\n",
    );
  });

  it("refuses an archive whose entries escape the session layout", async () => {
    const { bundle, manifest } = await makeManifest();
    const archive = ustarArchive([
      { name: "session/../escape.txt", content: Buffer.from("evil") },
    ]);
    const fake = fakeWorker(archive, checkpointKey);
    await expect(
      runRemoteSession(
        {
          worker: fake.worker,
          capability: "C".repeat(43),
          checkpointKey,
          sessionDir: path.join(scratch, "session-out"),
          logDir: path.join(scratch, "logs"),
          sleep: async () => {},
        },
        manifest,
        bundle.parts,
        () => false,
      ),
    ).rejects.toThrow(/unsafe entry/);
  });

  it("cancels the remote job when the session is cancelled", async () => {
    const { bundle, manifest } = await makeManifest();
    const archive = ustarArchive([
      { name: "result.json", content: Buffer.from(JSON.stringify({ exitCode: 1 })) },
    ]);
    const fake = fakeWorker(archive, checkpointKey);
    let polls = 0;
    fake.worker.jobStatus = async () => {
      polls += 1;
      const base = await fake.worker.cancelJob();
      return { ...base, state: polls > 1 ? "cancelled" : "running" };
    };
    const outcome = await runRemoteSession(
      {
        worker: fake.worker,
        capability: "C".repeat(43),
        checkpointKey,
        sessionDir: path.join(scratch, "session-out"),
        logDir: path.join(scratch, "logs"),
        sleep: async () => {},
      },
      manifest,
      bundle.parts,
      () => true,
    );
    expect(outcome.state).toBe("cancelled");
    expect(fake.calls).toContain("cancel");
  });
});
