import { Router } from "express";
import { findRepoMap, findRepoMapForWorkspace } from "./repository.js";
import { inferArea, suggestVerification, computeArchitectRiskScore, riskScoreToLevel } from "../lib/repoAnalysis.js";
import type { TaskIntelligence, TaskContract, RepoMap } from "@glimmer/shared";

export const taskIntelligenceRouter = Router();

const VALID_SCOPE_PACKAGES = new Set(["repository", "frontend", "backend", "directory", "files"]);

taskIntelligenceRouter.get("/task-intelligence", async (req, res) => {
  try {
    const rawScope = typeof req.query.scopePackage === "string" ? req.query.scopePackage : "repository";
    const scopePackage = (VALID_SCOPE_PACKAGES.has(rawScope) ? rawScope : "repository") as TaskContract["scope"]["package"];
    const scopeArea = typeof req.query.scopeArea === "string" ? req.query.scopeArea : undefined;

    // Task 4c(b): the composer is always composing against ONE workspace, so
    // when it names one, the repo map must be that workspace's or nothing --
    // findRepoMap()'s "first session that has a map wins" answer can be an
    // entirely unrelated repository. Absent the param, behavior is unchanged.
    const workspace = typeof req.query.workspace === "string" && req.query.workspace.trim()
      ? req.query.workspace.trim()
      : undefined;
    let repoMap: RepoMap | null;
    let repoMapStatus: TaskIntelligence["repoMapStatus"];
    if (workspace) {
      const found = await findRepoMapForWorkspace(workspace);
      repoMap = found?.map ?? null;
      repoMapStatus = found ? "workspace-matched" : "unmatched-workspace";
    } else {
      repoMap = await findRepoMap();
      repoMapStatus = repoMap ? "first-found" : "none";
    }
    const { area, package: pkg } = inferArea({ package: scopePackage, area: scopeArea }, repoMap);

    // Task 9.3b (V7 §5.5/§46): populated from the same deterministic
    // pre-architect proxies glimmer-v2.py's compute_architect_risk scores a
    // session on (mode/objective/verificationLevel/candidateCount) -- NOT
    // changed files, which genuinely don't exist before a session runs.
    // Opt-in: only computed when the caller (a composer form that already
    // has the user's mode/objective/verification choice) passes at least one
    // of these hints, so an untouched pre-existing caller that only ever
    // sends scopePackage/scopeArea sees the exact same honest null it always
    // has -- no silent behavior change for that shape of request.
    const mode = typeof req.query.mode === "string" ? req.query.mode : undefined;
    const objective = typeof req.query.objective === "string" ? req.query.objective : undefined;
    const verificationLevel = typeof req.query.verificationLevel === "string" ? req.query.verificationLevel : undefined;
    // Review MN7: `Number("")` is 0, which is finite -- an empty
    // `candidateCount=` used to fabricate a zero hint (and flip hasRiskHint on).
    const rawCandidateCount = typeof req.query.candidateCount === "string" && req.query.candidateCount.trim()
      ? Number(req.query.candidateCount)
      : undefined;
    const candidateCount = Number.isFinite(rawCandidateCount) ? rawCandidateCount : undefined;
    const hasRiskHint = mode !== undefined || objective !== undefined || verificationLevel !== undefined || candidateCount !== undefined;

    const result: TaskIntelligence = {
      likelyArea: area,
      likelyPackage: pkg?.name ?? null,
      suggestedVerification: suggestVerification(pkg),
      estimatedRisk: hasRiskHint
        ? riskScoreToLevel(computeArchitectRiskScore(scopePackage, { mode, objective, verificationLevel, candidateCount }).score)
        : null,
      provenance: repoMap ? "git-derived" : "deterministic-backend",
      repoMapStatus,
    };
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
