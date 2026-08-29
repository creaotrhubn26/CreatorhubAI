import { createHash } from "node:crypto";
import type { RemoteJobManifestV1, RemoteJobStatusV1 } from "@glimmer/shared";
import { runGlimmer } from "./runner.js";
import { WorkerClient, WorkerProtocolError } from "./compute/workerClient.js";

export interface RunBackend<Request, Handle> {
  readonly kind: "local_process" | "runpod_pod";
  start(request: Request): Promise<Handle>;
}

export interface LocalRunRequest {
  sessionDir: string;
  engineerScriptPath: string;
  args: string[];
  onExit: (code: number | null) => void;
}

export interface LocalRunHandle {
  pid: number;
  cancel: () => void;
}

/** Compatibility adapter; session routing remains local until milestone R3. */
export class LocalProcessRunBackend implements RunBackend<LocalRunRequest, LocalRunHandle> {
  readonly kind = "local_process" as const;

  async start(request: LocalRunRequest): Promise<LocalRunHandle> {
    return runGlimmer(request.sessionDir, request.engineerScriptPath, request.args, request.onExit);
  }
}

export interface RemoteBundlePart {
  index: number;
  bytes: Uint8Array;
  sha256: string;
}

export interface RemoteRunRequest {
  manifest: RemoteJobManifestV1;
  parts: readonly RemoteBundlePart[];
}

export interface RemoteRunHandle {
  jobId: string;
  accepted: RemoteJobStatusV1;
  status: () => Promise<RemoteJobStatusV1>;
  cancel: () => Promise<RemoteJobStatusV1>;
}

function validateParts(request: RemoteRunRequest): void {
  if (request.parts.length !== request.manifest.input.parts) {
    throw new WorkerProtocolError("remote bundle part count does not match the manifest");
  }
  const fullDigest = createHash("sha256");
  let total = 0;
  for (let index = 0; index < request.parts.length; index += 1) {
    const part = request.parts[index];
    if (part.index !== index) {
      throw new WorkerProtocolError("remote bundle parts must be contiguous and ordered");
    }
    const digest = createHash("sha256").update(part.bytes).digest("hex");
    if (digest !== part.sha256) {
      throw new WorkerProtocolError("remote bundle part checksum does not match");
    }
    total += part.bytes.byteLength;
    fullDigest.update(part.bytes);
  }
  if (total !== request.manifest.input.bytes) {
    throw new WorkerProtocolError("remote bundle size does not match the manifest");
  }
  if (fullDigest.digest("hex") !== request.manifest.input.sha256) {
    throw new WorkerProtocolError("remote bundle checksum does not match the manifest");
  }
}

/**
 * Authenticated transport backend. It deliberately accepts an already-built,
 * checksum-bound Git bundle; repository packaging and session selection are R3.
 */
export class RemoteWorkerRunBackend implements RunBackend<RemoteRunRequest, RemoteRunHandle> {
  readonly kind = "runpod_pod" as const;

  constructor(
    private readonly worker: WorkerClient,
    private readonly capability: string,
  ) {}

  async start(request: RemoteRunRequest): Promise<RemoteRunHandle> {
    validateParts(request);
    const jobId = request.manifest.jobId;
    await this.worker.createJob(request.manifest, this.capability, `${jobId}:create`);
    for (const part of request.parts) {
      await this.worker.uploadPart({
        jobId,
        part: part.index,
        bytes: part.bytes,
        sha256: part.sha256,
        capability: this.capability,
        idempotencyKey: `${jobId}:part:${part.index}`,
      });
    }
    const accepted = await this.worker.startJob(jobId, this.capability, `${jobId}:start`);
    return {
      jobId,
      accepted,
      status: () => this.worker.jobStatus(jobId, this.capability),
      cancel: () => this.worker.cancelJob(jobId, this.capability, `${jobId}:cancel`),
    };
  }
}
