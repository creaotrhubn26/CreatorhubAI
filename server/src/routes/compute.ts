import { Router } from "express";
import { ComputeControlError, getComputeController } from "../lib/compute/computeController.js";
import { ComputeConfigValidationError } from "../lib/compute/configStore.js";
import { RunPodApiError } from "../lib/compute/runpodClient.js";

export const computeRouter = Router();

function sendError(res: any, error: unknown) {
  const message = error instanceof Error ? error.message : "unknown compute error";
  if (error instanceof ComputeConfigValidationError) {
    return res.status(400).json({ error: message });
  }
  if (error instanceof ComputeControlError) {
    return res.status(error.statusCode).json({ error: message });
  }
  if (error instanceof RunPodApiError) {
    const status = error.status === 401 || error.status === 403 ? 502 : 503;
    return res.status(status).json({ error: message });
  }
  console.error("[compute] route failed:", error);
  return res.status(500).json({ error: "compute operation failed" });
}

computeRouter.get("/compute/config", async (_req, res) => {
  try {
    res.json(await getComputeController().readConfig());
  } catch (error) {
    sendError(res, error);
  }
});

computeRouter.put("/compute/config", async (req, res) => {
  try {
    res.json(await getComputeController().saveConfig(req.body));
  } catch (error) {
    sendError(res, error);
  }
});

computeRouter.get("/compute/status", async (_req, res) => {
  try {
    res.json(await getComputeController().getStatus());
  } catch (error) {
    sendError(res, error);
  }
});

computeRouter.post("/compute/test", async (_req, res) => {
  try {
    res.json(await getComputeController().testCredentials());
  } catch (error) {
    sendError(res, error);
  }
});

computeRouter.post("/compute/watchdog/test", async (_req, res) => {
  try {
    res.json(await getComputeController().testWatchdog());
  } catch (error) {
    sendError(res, error);
  }
});

computeRouter.post("/compute/coordinator/test", async (_req, res) => {
  try {
    res.json(await getComputeController().testCoordinator());
  } catch (error) {
    sendError(res, error);
  }
});

computeRouter.post("/compute/start", async (_req, res) => {
  try {
    const result = await getComputeController().start();
    res.status(result.started ? 202 : 409).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

computeRouter.post("/compute/stop", async (_req, res) => {
  try {
    res.json(await getComputeController().stop());
  } catch (error) {
    sendError(res, error);
  }
});

computeRouter.delete("/compute/pod", async (req, res) => {
  try {
    if (typeof req.body?.podId !== "string") {
      return res.status(400).json({ error: "podId is required" });
    }
    res.json(await getComputeController().terminateExact(req.body.podId));
  } catch (error) {
    sendError(res, error);
  }
});

computeRouter.get("/compute/usage", async (_req, res) => {
  try {
    res.json(await getComputeController().getUsage(false));
  } catch (error) {
    sendError(res, error);
  }
});

computeRouter.post("/compute/usage/reconcile", async (_req, res) => {
  try {
    res.json(await getComputeController().getUsage(true));
  } catch (error) {
    sendError(res, error);
  }
});
