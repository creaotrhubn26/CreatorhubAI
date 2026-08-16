import { Router } from "express";
import { findRepoMap } from "./repository.js";
import { inferArea, suggestVerification } from "../lib/repoAnalysis.js";
import type { TaskIntelligence, TaskContract } from "@glimmer/shared";

export const taskIntelligenceRouter = Router();

const VALID_SCOPE_PACKAGES = new Set(["repository", "frontend", "backend", "directory", "files"]);

taskIntelligenceRouter.get("/task-intelligence", async (req, res) => {
  try {
    const rawScope = typeof req.query.scopePackage === "string" ? req.query.scopePackage : "repository";
    const scopePackage = (VALID_SCOPE_PACKAGES.has(rawScope) ? rawScope : "repository") as TaskContract["scope"]["package"];
    const scopeArea = typeof req.query.scopeArea === "string" ? req.query.scopeArea : undefined;

    const repoMap = await findRepoMap();
    const { area, package: pkg } = inferArea({ package: scopePackage, area: scopeArea }, repoMap);

    const result: TaskIntelligence = {
      likelyArea: area,
      likelyPackage: pkg?.name ?? null,
      suggestedVerification: suggestVerification(pkg),
      // Deterministic risk scoring needs real changed files, which don't exist
      // before a session has run — an honest "Unavailable", never a guess.
      estimatedRisk: null,
      provenance: repoMap ? "git-derived" : "deterministic-backend",
    };
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
