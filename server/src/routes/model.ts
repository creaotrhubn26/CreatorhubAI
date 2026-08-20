import { Router } from "express";
import { probeModel, probeModelProps } from "../lib/modelStatus.js";
import { CONFIG } from "../config.js";

export const modelRouter = Router();

modelRouter.get("/model/status", async (_req, res) => {
  // Independent, best-effort probes run in parallel: a /props failure (or
  // timeout) never blocks or breaks the existing /health-based status.
  const [status, props] = await Promise.all([
    probeModel(CONFIG.modelBaseUrl),
    probeModelProps(CONFIG.modelBaseUrl),
  ]);
  res.json(props ? { ...status, ...props } : status);
});
