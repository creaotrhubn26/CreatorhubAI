import { Router } from "express";
import { probeCliIntegrations } from "../lib/cliIntegrations.js";

export const integrationsRouter = Router();

// Read-only setup diagnostics. It never installs, authenticates, or invokes
// a repository command; fixed probes only report what the packaged app can
// actually reach through its resolved Terminal PATH.
integrationsRouter.get("/integrations/cli", async (_req, res) => {
  res.json(await probeCliIntegrations());
});
