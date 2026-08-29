import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RemoteJobManifestV1 } from "@glimmer/shared";
import { RemoteWorkerRunBackend } from "./runBackend.js";

function status(state: "created" | "uploading" | "running" = "created") {
  return {
    schemaVersion: 1 as const,
    jobId: "job-1",
    sessionId: "session-1",
    state,
    receivedParts: state === "created" ? 0 : 1,
    expectedParts: 1,
    receivedBytes: state === "created" ? 0 : 6,
    expectedBytes: 6,
    createdAt: "2026-08-29T10:00:00Z",
    updatedAt: "2026-08-29T10:00:01Z",
    checkpoints: [],
  };
}

describe("RemoteWorkerRunBackend", () => {
  it("uploads the checksum-bound bundle and starts with stable idempotency keys", async () => {
    const bytes = new TextEncoder().encode("bundle");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const manifest: RemoteJobManifestV1 = {
      schemaVersion: 1,
      instanceId: "control-1",
      sessionId: "session-1",
      jobId: "job-1",
      repositoryFingerprint: "a".repeat(64),
      baselineSha: "b".repeat(40),
      branch: "glimmer/job-1",
      objective: "Implement the bounded change",
      contextTokens: 65_536,
      maxRepairs: 2,
      timeoutSeconds: 1_200,
      createdAt: "2026-08-29T10:00:00Z",
      input: { format: "git_bundle", parts: 1, bytes: bytes.byteLength, sha256 },
    };
    const worker = {
      createJob: vi.fn().mockResolvedValue(status()),
      uploadPart: vi.fn().mockResolvedValue(status("uploading")),
      startJob: vi.fn().mockResolvedValue(status("running")),
      jobStatus: vi.fn().mockResolvedValue(status("running")),
      cancelJob: vi.fn().mockResolvedValue(status("running")),
    };
    const backend = new RemoteWorkerRunBackend(worker as any, "C".repeat(43));
    const handle = await backend.start({ manifest, parts: [{ index: 0, bytes, sha256 }] });
    expect(worker.createJob).toHaveBeenCalledWith(manifest, "C".repeat(43), "job-1:create");
    expect(worker.uploadPart).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "job-1:part:0", sha256 }),
    );
    expect(worker.startJob).toHaveBeenCalledWith("job-1", "C".repeat(43), "job-1:start");
    await handle.cancel();
    expect(worker.cancelJob).toHaveBeenCalledWith("job-1", "C".repeat(43), "job-1:cancel");
  });

  it("rejects modified bytes locally before calling the paid worker", async () => {
    const bytes = new TextEncoder().encode("bundle");
    const worker = { createJob: vi.fn() };
    const backend = new RemoteWorkerRunBackend(worker as any, "C".repeat(43));
    await expect(
      backend.start({
        manifest: {
          schemaVersion: 1,
          instanceId: "control-1",
          sessionId: "session-1",
          jobId: "job-1",
          repositoryFingerprint: "a".repeat(64),
          baselineSha: "b".repeat(40),
          branch: "glimmer/job-1",
          objective: "Implement the bounded change",
          contextTokens: 65_536,
          maxRepairs: 2,
          timeoutSeconds: 1_200,
          createdAt: "2026-08-29T10:00:00Z",
          input: { format: "git_bundle", parts: 1, bytes: 6, sha256: "0".repeat(64) },
        },
        parts: [{ index: 0, bytes, sha256: "0".repeat(64) }],
      }),
    ).rejects.toThrow(/part checksum/);
    expect(worker.createJob).not.toHaveBeenCalled();
  });
});
