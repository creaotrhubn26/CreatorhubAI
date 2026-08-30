import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComputeLastDiagnostic } from "@glimmer/shared";
import {
  parseComputeDiagnostic,
  readLastComputeDiagnostic,
  saveLastComputeDiagnostic,
} from "./computeDiagnosticStore.js";

let root = "";
let file = "";

const diagnostic: ComputeLastDiagnostic = {
  schemaVersion: 1,
  leaseId: "804ad34b-cdc7-4f79-aa65-57ec4d87cddf",
  podId: "pod_123",
  podName: "glimmer-test",
  observedAt: "2026-08-29T10:00:01Z",
  outcome: "bootstrapping",
  worker: {
    protocolVersion: 2,
    buildId: "r2-aaaaaaaaaaaa",
    ready: false,
    workerState: "bootstrapping",
    model: { ready: false, contextTokens: 65_536 },
    bootstrap: {
      stage: "artifact_downloading",
      outcome: "in_progress",
      stageStartedAt: "2026-08-29T10:00:00Z",
      updatedAt: "2026-08-29T10:00:01Z",
      artifact: {
        kind: "model",
        phase: "downloading",
        bytesCompleted: 268_435_456,
        bytesTotal: 19_700_000_000,
      },
    },
  },
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-compute-diagnostic-"));
  file = path.join(root, "nested", "diagnostic.json");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("compute diagnostic store", () => {
  it("round-trips a strict V2 worker observation with owner-only permissions", async () => {
    await expect(saveLastComputeDiagnostic(diagnostic, file)).resolves.toEqual(diagnostic);
    await expect(readLastComputeDiagnostic(file)).resolves.toEqual(diagnostic);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o077).toBe(0);
  });

  it("returns null only for a missing file", async () => {
    await expect(readLastComputeDiagnostic(file)).resolves.toBeNull();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "not-json", "utf8");
    await expect(readLastComputeDiagnostic(file)).rejects.toThrow();
  });

  it("rejects symlinks, broad permissions, and oversized retained files", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const target = path.join(root, "target.json");
    await fs.writeFile(target, JSON.stringify(diagnostic), { mode: 0o600 });
    await fs.symlink(target, file);
    await expect(readLastComputeDiagnostic(file)).rejects.toThrow(/unsafe/);
    await fs.unlink(file);

    await fs.writeFile(file, JSON.stringify(diagnostic), { mode: 0o644 });
    await expect(readLastComputeDiagnostic(file)).rejects.toThrow(/unsafe/);
    await fs.chmod(file, 0o600);
    await fs.writeFile(file, "x".repeat(64 * 1024 + 1), "utf8");
    await expect(readLastComputeDiagnostic(file)).rejects.toThrow(/unsafe/);
  });

  it("rejects injected fields and forged worker readiness", () => {
    expect(() => parseComputeDiagnostic({ ...diagnostic, token: "secret" })).toThrow(
      /unsupported or missing fields/,
    );
    expect(() =>
      parseComputeDiagnostic({
        ...diagnostic,
        worker: {
          ...diagnostic.worker,
          ready: true,
        },
      }),
    ).toThrow(/readiness.*conflict/);
  });
});
