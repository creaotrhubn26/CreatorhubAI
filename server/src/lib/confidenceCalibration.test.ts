import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "calibration-"));
  process.env.GLIMMER_STATE_ROOT = scratch;
  // CONFIG reads the env at import time; force a fresh module graph so the
  // library sees this test's state root (same isolation as routes.test.ts).
  vi.resetModules();
});
afterEach(async () => {
  delete process.env.GLIMMER_STATE_ROOT;
  await fs.rm(scratch, { recursive: true, force: true });
});

async function writeSession(
  name: string,
  files: Record<string, unknown>,
): Promise<void> {
  const directory = path.join(scratch, "sessions", name);
  await fs.mkdir(directory, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await fs.writeFile(path.join(directory, file), JSON.stringify(content));
  }
}

describe("confidence calibration", () => {
  it("grades stated confidence against outcomes and excludes ungraded runs", async () => {
    // high + VERIFIED -> hit
    await writeSession("20260901-000001-aaaaaaaaaaaa", {
      "manifest.json": { statuses: { technical: "VERIFIED" } },
      "delivery-review.json": { confidence: { level: "high" } },
    });
    // high + failed -> miss
    await writeSession("20260901-000002-bbbbbbbbbbbb", {
      "manifest.json": { status: "failed", statuses: { technical: "FAILED" } },
      "delivery-review.json": { confidence: { level: "high" } },
    });
    // medium + human-accepted (report-level confidence) -> hit
    await writeSession("20260901-000003-cccccccccccc", {
      "manifest.json": { statuses: { technical: "NOT_RUN" } },
      "task-report.json": { confidence: "medium" },
      "human-acceptance.json": { accepted: true },
    });
    // read-only run nobody reviewed -> excluded
    await writeSession("20260901-000004-dddddddddddd", {
      "manifest.json": { status: "inspect-completed", statuses: { technical: "NOT_RUN" } },
      "task-report.json": { confidence: "low" },
    });

    const { computeCalibrationReport } = await import("./confidenceCalibration.js");
    const report = await computeCalibrationReport();
    expect(report.gradedSessions).toBe(3);
    expect(report.excludedSessions).toBe(1);
    const high = report.buckets.find((bucket) => bucket.level === "high")!;
    expect(high).toMatchObject({ sessions: 2, hits: 1, rate: 0.5 });
    const medium = report.buckets.find((bucket) => bucket.level === "medium")!;
    expect(medium).toMatchObject({ sessions: 1, hits: 1, rate: 1 });
    expect(report.brierScore).not.toBeNull();
  });

  it("persists the report where the orchestrator reads it back", async () => {
    const { refreshCalibrationReport } = await import("./confidenceCalibration.js");
    const report = await refreshCalibrationReport();
    const persisted = JSON.parse(
      await fs.readFile(path.join(scratch, "confidence-calibration.json"), "utf8"),
    );
    expect(persisted.generatedAt).toBe(report.generatedAt);
    expect(persisted.schemaVersion).toBe(1);
  });
});
