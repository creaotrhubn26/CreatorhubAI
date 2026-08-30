import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG } from "../../config.js";
import {
  beginUsageInterval,
  finishUsageInterval,
  readTrackedPodIds,
  readUsageSummary,
} from "./usageLedger.js";

describe("usageLedger", () => {
  let temporary = "";
  let original = "";

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-compute-usage-"));
    original = CONFIG.computeUsagePath;
    (CONFIG as { computeUsagePath: string }).computeUsagePath = path.join(temporary, "usage.json");
  });

  afterEach(async () => {
    (CONFIG as { computeUsagePath: string }).computeUsagePath = original;
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it("tracks multiple Pod ids under one lease and closes them atomically", async () => {
    const startedAt = "2026-08-30T10:00:00.000Z";
    await beginUsageInterval({
      leaseId: "lease-1",
      podId: "pod-1",
      startedAt,
      hourlyUsd: 1,
    });
    await beginUsageInterval({
      leaseId: "lease-1",
      podId: "pod-2",
      startedAt,
      hourlyUsd: 2,
    });
    await beginUsageInterval({
      leaseId: "lease-1",
      podId: "pod-1",
      startedAt,
      hourlyUsd: 9,
    });

    await expect(readTrackedPodIds()).resolves.toEqual(["pod-1", "pod-2"]);
    await finishUsageInterval("lease-1", "2026-08-30T11:00:00.000Z");
    const summary = await readUsageSummary(new Date("2026-08-30T12:00:00.000Z"));
    expect(summary).toMatchObject({
      estimatedTotalUsd: 3,
      estimatedTodayUsd: 3,
      estimatedMonthUsd: 3,
    });
    expect(summary.activeHourlyUsd).toBeUndefined();

    const stored = JSON.parse(
      await fs.readFile((CONFIG as { computeUsagePath: string }).computeUsagePath, "utf8"),
    );
    expect(stored.intervals).toHaveLength(2);
    expect(stored.intervals.every((entry: { stoppedAt?: string }) => entry.stoppedAt)).toBe(true);
  });
});
