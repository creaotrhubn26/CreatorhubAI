import { promises as fs } from "node:fs";
import path from "node:path";
import { CONFIG, sessionsDir } from "../config.js";

/**
 * Confidence calibration: compares every session's STATED confidence (the
 * delivery review's or task report's high/medium/low) with its ACTUAL
 * outcome, so "high" acquires a measured meaning instead of being a vibe.
 *
 * Outcome ground truth, strongest first:
 *   - technical verification VERIFIED (the tests ran) counts as a hit;
 *   - an explicit human acceptance counts as a hit;
 *   - a failed/blocked terminal status counts as a miss;
 *   - sessions with NO known outcome (read-only runs nobody reviewed) are
 *     EXCLUDED — calibration only counts what reality graded.
 *
 * The report is written to <stateRoot>/confidence-calibration.json, where
 * the local orchestrator feeds it back into the next run's prompt and
 * delivery packet (the calibration loop).
 */

export type ConfidenceLevel = "high" | "medium" | "low";

export interface CalibrationBucket {
  level: ConfidenceLevel;
  sessions: number;
  hits: number;
  rate: number | null;
}

export interface CalibrationReport {
  schemaVersion: 1;
  generatedAt: string;
  gradedSessions: number;
  excludedSessions: number;
  buckets: CalibrationBucket[];
  /** Mean squared error between stated confidence (as probability) and
   * outcome — lower is better; 0.25 is the "always say 50%" baseline. */
  brierScore: number | null;
}

const LEVELS: ConfidenceLevel[] = ["high", "medium", "low"];
const LEVEL_PROBABILITY: Record<ConfidenceLevel, number> = {
  high: 0.9,
  medium: 0.6,
  low: 0.3,
};

function statedConfidence(deliveryReview: unknown, taskReport: unknown): ConfidenceLevel | null {
  for (const source of [deliveryReview, taskReport]) {
    const raw = (source as { confidence?: unknown } | null)?.confidence;
    // Delivery reviews carry {level, reason}; task reports carry the string.
    const value = typeof raw === "object" && raw !== null ? (raw as any).level : raw;
    if (value === "high" || value === "medium" || value === "low") return value;
  }
  return null;
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function outcomeFor(manifest: unknown, humanAcceptance: unknown): boolean | null {
  const technical = (manifest as any)?.statuses?.technical;
  if (technical === "VERIFIED") return true;
  const accepted = (humanAcceptance as any)?.accepted;
  if (accepted === true) return true;
  if (accepted === false) return false;
  const status = String((manifest as any)?.status ?? "");
  if (technical === "FAILED" || /(^|-)failed$/.test(status) || status === "blocked") return false;
  return null;
}

export async function computeCalibrationReport(): Promise<CalibrationReport> {
  const directory = sessionsDir();
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("pending-"))
      .map((entry) => entry.name);
  } catch {
    // No sessions directory yet: an empty, honest report.
  }
  const counters = new Map<ConfidenceLevel, { sessions: number; hits: number }>(
    LEVELS.map((level) => [level, { sessions: 0, hits: 0 }]),
  );
  let graded = 0;
  let excluded = 0;
  let brierSum = 0;
  for (const name of entries) {
    const base = path.join(directory, name);
    const manifest = await readJson(path.join(base, "manifest.json"));
    if (!manifest) continue;
    const confidence = statedConfidence(
      await readJson(path.join(base, "delivery-review.json")),
      await readJson(path.join(base, "task-report.json")),
    );
    if (!confidence) {
      excluded += 1;
      continue;
    }
    const outcome = outcomeFor(manifest, await readJson(path.join(base, "human-acceptance.json")));
    if (outcome === null) {
      excluded += 1;
      continue;
    }
    graded += 1;
    const bucket = counters.get(confidence)!;
    bucket.sessions += 1;
    if (outcome) bucket.hits += 1;
    brierSum += (LEVEL_PROBABILITY[confidence] - (outcome ? 1 : 0)) ** 2;
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gradedSessions: graded,
    excludedSessions: excluded,
    buckets: LEVELS.map((level) => {
      const { sessions, hits } = counters.get(level)!;
      return {
        level,
        sessions,
        hits,
        rate: sessions > 0 ? Number((hits / sessions).toFixed(3)) : null,
      };
    }),
    brierScore: graded > 0 ? Number((brierSum / graded).toFixed(4)) : null,
  };
}

/** Computes and persists the report where the orchestrator reads it back. */
export async function refreshCalibrationReport(): Promise<CalibrationReport> {
  const report = await computeCalibrationReport();
  const target = path.join(CONFIG.stateRoot, "confidence-calibration.json");
  try {
    await fs.writeFile(target, JSON.stringify(report, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    console.error(
      `[calibration] could not persist the calibration report: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return report;
}
