import { Router } from "express";
import {
  collectDiagnostics,
  createSupportBundle,
  gatewayHealth,
  probeRuntimeReadiness,
  repairInstallation,
  runRecoverySmoke,
} from "../lib/diagnostics.js";

export const diagnosticsRouter = Router();

diagnosticsRouter.get("/health", (_req, res) => {
  res.json(gatewayHealth());
});

diagnosticsRouter.get("/ready", async (_req, res, next) => {
  try {
    const readiness = await probeRuntimeReadiness();
    res.status(readiness.coreReady ? 200 : 503).json(readiness);
  } catch (error) {
    next(error);
  }
});

diagnosticsRouter.get("/diagnostics", async (_req, res, next) => {
  try {
    res.json(await collectDiagnostics());
  } catch (error) {
    next(error);
  }
});

diagnosticsRouter.post("/diagnostics/repair", async (_req, res, next) => {
  try {
    res.json(await repairInstallation());
  } catch (error) {
    next(error);
  }
});

diagnosticsRouter.post("/diagnostics/smoke", async (_req, res, next) => {
  try {
    const smoke = await runRecoverySmoke();
    res.json(smoke);
  } catch (error) {
    next(error);
  }
});

diagnosticsRouter.post("/diagnostics/support-bundle", async (_req, res, next) => {
  try {
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="glimmer-support-${date}.json"`);
    res.json(await createSupportBundle());
  } catch (error) {
    next(error);
  }
});
