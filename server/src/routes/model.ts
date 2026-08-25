import { Router } from "express";
import { probeModel, probeModelProps } from "../lib/modelStatus.js";
import { describeRunState, forgetSpawned, startModelServer, stopModelServer } from "../lib/modelServer.js";
import { CONFIG } from "../config.js";
import { ModelRegistryValidationError, readModelRegistry, saveModelRegistry } from "../lib/modelRegistry.js";

export const modelRouter = Router();

modelRouter.get("/models/config", async (_req, res) => {
  try {
    res.json(await readModelRegistry());
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

modelRouter.put("/models/config", async (req, res) => {
  try {
    res.json(await saveModelRegistry(req.body));
  } catch (err: any) {
    const message = String(err?.message ?? err);
    const clientError = err instanceof ModelRegistryValidationError;
    res.status(clientError ? 400 : 500).json({ error: clientError ? message : "could not save model registry" });
  }
});

modelRouter.get("/model/status", async (_req, res) => {
  // Independent, best-effort probes run in parallel: a /props failure (or
  // timeout) never blocks or breaks the existing /health-based status.
  const [status, props] = await Promise.all([
    probeModel(CONFIG.modelBaseUrl),
    probeModelProps(CONFIG.modelBaseUrl),
  ]);
  const run = await describeRunState(status);
  res.json({ ...status, ...props, ...run });
});

// Process control for the local llama-server. Both handlers execute exactly
// one fixed script from CONFIG (absolute path, argv, no shell, no arguments)
// and both are idempotent: `status` here stays probe-derived, so neither can
// ever report ONLINE just because a process was spawned.
modelRouter.post("/model/start", async (_req, res) => {
  const probe = await probeModel(CONFIG.modelBaseUrl);
  const run = await describeRunState(probe);
  // Already up, coming up, or loading — say so, don't spawn a second server
  // (the start script itself refuses on a busy port anyway). FAILED is the
  // one non-OFFLINE state a start may proceed from: it's a retry.
  if (run.runState !== "OFFLINE" && run.runState !== "FAILED") {
    return res.status(409).json({ started: false, ...probe, ...run });
  }

  const result = await startModelServer();
  if ("error" in result) {
    return res.status(500).json({ started: false, error: result.error, ...probe, runState: "OFFLINE" });
  }
  // 202, not 200: the process exists, the model does not answer yet. The next
  // GET /model/status poll reports STARTING -> LOADING -> ONLINE on its own.
  res.status(202).json({ started: true, pid: result.pid, ...probe, runState: "STARTING" });
});

modelRouter.post("/model/stop", async (_req, res) => {
  const probe = await probeModel(CONFIG.modelBaseUrl);
  const run = await describeRunState(probe);
  if (run.runState === "OFFLINE" || run.runState === "FAILED") {
    // Nothing to stop. Report what was actually true (including a FAILED
    // process's exit code and log tail) and drop the marker, so the next
    // poll is a plain OFFLINE rather than a stale failure.
    forgetSpawned();
    return res.json({ stopped: false, ...probe, ...run });
  }

  const result = await stopModelServer();
  // Re-probe: the honest answer is what the port and the pid say now, never
  // the stop script's exit code (it exits 0 when it refuses to kill a
  // non-llama-server process, and it cannot see a process that hasn't bound
  // yet). `stopped` is derived from that evidence, so a target that survived
  // is reported as survived — never as a stop that did not happen.
  const after = await probeModel(CONFIG.modelBaseUrl);
  const afterRun = await describeRunState(after);
  const stopped = !result.pidStillAlive && afterRun.runState === "OFFLINE";
  const detail = stopped
    ? undefined
    : result.pidStillAlive
      ? "the process we started is still running after the stop attempt"
      : `something is still listening on the model port (${afterRun.runState})`;
  if (result.error) {
    return res.status(500).json({ stopped, error: result.error, detail, ...after, ...afterRun });
  }
  res.json({ stopped, ...(detail ? { detail } : {}), ...after, ...afterRun });
});
