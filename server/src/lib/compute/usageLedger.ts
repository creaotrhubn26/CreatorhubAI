import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ComputeUsageSummary } from "@glimmer/shared";
import { CONFIG } from "../../config.js";

interface UsageIntervalV1 {
  leaseId: string;
  podId: string;
  startedAt: string;
  stoppedAt?: string;
  hourlyUsd: number;
}

interface UsageLedgerV1 {
  version: 1;
  intervals: UsageIntervalV1[];
  reconciled?: {
    checkedAt: string;
    todayUsd: number;
    monthUsd: number;
  };
}

const MAX_INTERVALS = 1_000;

function emptyLedger(): UsageLedgerV1 {
  return { version: 1, intervals: [] };
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isLedger(value: unknown): value is UsageLedgerV1 {
  if (!value || typeof value !== "object") return false;
  const raw = value as Partial<UsageLedgerV1>;
  return (
    raw.version === 1 &&
    Array.isArray(raw.intervals) &&
    raw.intervals.length <= MAX_INTERVALS &&
    raw.intervals.every(
      (entry) =>
        entry &&
        typeof entry.leaseId === "string" &&
        typeof entry.podId === "string" &&
        isTimestamp(entry.startedAt) &&
        (entry.stoppedAt === undefined || isTimestamp(entry.stoppedAt)) &&
        typeof entry.hourlyUsd === "number" &&
        Number.isFinite(entry.hourlyUsd) &&
        entry.hourlyUsd >= 0,
    )
  );
}

async function readLedger(): Promise<UsageLedgerV1> {
  try {
    const parsed = JSON.parse(await fs.readFile(CONFIG.computeUsagePath, "utf8"));
    if (!isLedger(parsed)) throw new Error("stored compute usage ledger is invalid");
    return parsed;
  } catch (error: any) {
    if (error?.code === "ENOENT") return emptyLedger();
    throw error;
  }
}

async function writeLedger(ledger: UsageLedgerV1): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG.computeUsagePath), { recursive: true, mode: 0o700 });
  const temporary = `${CONFIG.computeUsagePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporary, CONFIG.computeUsagePath);
  await fs.chmod(CONFIG.computeUsagePath, 0o600);
}

export async function beginUsageInterval(input: UsageIntervalV1): Promise<void> {
  const ledger = await readLedger();
  if (ledger.intervals.some((entry) => entry.leaseId === input.leaseId)) return;
  ledger.intervals = [...ledger.intervals, input].slice(-MAX_INTERVALS);
  await writeLedger(ledger);
}

export async function finishUsageInterval(leaseId: string, stoppedAt = new Date().toISOString()) {
  const ledger = await readLedger();
  let changed = false;
  ledger.intervals = ledger.intervals.map((entry) => {
    if (entry.leaseId !== leaseId || entry.stoppedAt) return entry;
    changed = true;
    return { ...entry, stoppedAt };
  });
  if (changed) await writeLedger(ledger);
}

export async function storeReconciledUsage(input: {
  checkedAt: string;
  todayUsd: number;
  monthUsd: number;
}) {
  const ledger = await readLedger();
  ledger.reconciled = input;
  await writeLedger(ledger);
}

function utcStartOfDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function utcStartOfMonth(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function intervalCost(entry: UsageIntervalV1, startMs: number, endMs: number): number {
  const intervalStart = Math.max(Date.parse(entry.startedAt), startMs);
  const intervalEnd = Math.min(entry.stoppedAt ? Date.parse(entry.stoppedAt) : endMs, endMs);
  if (intervalEnd <= intervalStart) return 0;
  return ((intervalEnd - intervalStart) / 3_600_000) * entry.hourlyUsd;
}

export async function readUsageSummary(now = new Date()): Promise<ComputeUsageSummary> {
  const ledger = await readLedger();
  const nowMs = now.getTime();
  const dayStart = utcStartOfDay(now);
  const monthStart = utcStartOfMonth(now);
  const estimatedTodayUsd = ledger.intervals.reduce(
    (sum, entry) => sum + intervalCost(entry, dayStart, nowMs),
    0,
  );
  const estimatedMonthUsd = ledger.intervals.reduce(
    (sum, entry) => sum + intervalCost(entry, monthStart, nowMs),
    0,
  );
  const estimatedTotalUsd = ledger.intervals.reduce(
    (sum, entry) => sum + intervalCost(entry, 0, nowMs),
    0,
  );
  const active = [...ledger.intervals].reverse().find((entry) => !entry.stoppedAt);
  return {
    checkedAt: now.toISOString(),
    estimatedTodayUsd,
    estimatedMonthUsd,
    estimatedTotalUsd,
    ...(ledger.reconciled
      ? {
          reconciledTodayUsd: ledger.reconciled.todayUsd,
          reconciledMonthUsd: ledger.reconciled.monthUsd,
        }
      : {}),
    ...(active ? { activeHourlyUsd: active.hourlyUsd } : {}),
    provenance: {
      estimate: "local-interval-ledger",
      reconciled: ledger.reconciled ? "runpod-billing-api" : "unavailable",
    },
  };
}

export async function readTrackedPodIds(): Promise<string[]> {
  const ledger = await readLedger();
  return [...new Set(ledger.intervals.map((entry) => entry.podId))].slice(-1_000);
}

export function usageWindowStarts(now = new Date()): { today: string; month: string } {
  return {
    today: new Date(utcStartOfDay(now)).toISOString(),
    month: new Date(utcStartOfMonth(now)).toISOString(),
  };
}
