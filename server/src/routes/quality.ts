import { Router } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { LocalQualityMetrics, TaskReportV2 } from "@glimmer/shared";
import { CONFIG, sessionsDir } from "../config.js";
import { isValidSessionId, listSessionIds } from "../lib/sessions.js";

export const qualityRouter = Router();

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch (err: any) {
    if (err.code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
    return null;
  }
}

export async function computeLocalQualityMetrics(): Promise<LocalQualityMetrics> {
  const ids = (await listSessionIds()).filter(isValidSessionId).slice(0, 500);
  let reports = 0;
  let verifiedClaims = 0;
  let partialClaims = 0;
  let rejectedClaims = 0;
  const graphCoverage: number[] = [];
  let decisions = 0;
  let highRiskOverrides = 0;
  const criticIndependence = { independent: 0, "same-model": 0, unavailable: 0 };

  for (const id of ids) {
    const directory = path.join(sessionsDir(), id);
    const report = (await readJson(
      path.join(directory, "task-report.json"),
    )) as TaskReportV2 | null;
    if (report?.schemaVersion === 2) {
      reports += 1;
      verifiedClaims += report.findings.filter(
        (finding) => finding.verification.status === "verified",
      ).length;
      partialClaims += report.findings.filter(
        (finding) => finding.verification.status === "partial",
      ).length;
      rejectedClaims += report.rejectedFindings.length;
    }
    const repoIndex = (await readJson(path.join(directory, "repo-index.json"))) as any;
    if (typeof repoIndex?.coverage?.ratio === "number")
      graphCoverage.push(repoIndex.coverage.ratio);
    try {
      const lines = (await fs.readFile(path.join(directory, "events.jsonl"), "utf-8")).split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type !== "model_routing_decision") continue;
        decisions += 1;
        if (event.reason === "high-risk-override") highRiskOverrides += 1;
        const independence: unknown = event.criticIndependence;
        if (independence === "independent" || independence === "same-model") {
          criticIndependence[independence] += 1;
        } else {
          criticIndependence.unavailable += 1;
        }
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  const denominator = verifiedClaims + partialClaims + rejectedClaims;
  const evaluationRoot = path.join(CONFIG.orchestratorRoot, "eval-baselines");
  const live = await readJson(path.join(evaluationRoot, "latest-live.json"));
  const stub = await readJson(path.join(evaluationRoot, "latest-stub.json"));
  const candidateRecallAt5 =
    typeof (live as any)?.candidateRecallAt5 === "number"
      ? (live as any).candidateRecallAt5
      : typeof (stub as any)?.candidateRecallAt5 === "number"
        ? (stub as any).candidateRecallAt5
        : null;
  return {
    schemaVersion: 1,
    sessionsScanned: ids.length,
    reports,
    verifiedClaims,
    partialClaims,
    rejectedClaims,
    claimPrecision: denominator ? Number((verifiedClaims / denominator).toFixed(4)) : null,
    averageGraphCoverage: graphCoverage.length
      ? Number(
          (graphCoverage.reduce((sum, value) => sum + value, 0) / graphCoverage.length).toFixed(4),
        )
      : null,
    candidateRecallAt5,
    evaluation: { live, stub },
    routing: { decisions, highRiskOverrides, criticIndependence },
  };
}

qualityRouter.get("/quality/metrics", async (_req, res) => {
  try {
    res.json(await computeLocalQualityMetrics());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
