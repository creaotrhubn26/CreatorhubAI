import { Router } from "express";
import { probeCliIntegrations } from "../lib/cliIntegrations.js";
import {
  McpConfigValidationError,
  probeMcpIntegrations,
  saveCuratedMcpConfig,
} from "../lib/mcpIntegrations.js";

export const integrationsRouter = Router();

// Read-only setup diagnostics. It never installs, authenticates, or invokes
// a repository command; fixed probes only report what the packaged app can
// actually reach through its resolved Terminal PATH.
integrationsRouter.get("/integrations/cli", async (_req, res) => {
  res.json(await probeCliIntegrations());
});

integrationsRouter.get("/integrations/mcp", async (_req, res) => {
  res.json(await probeMcpIntegrations());
});

// This write surface accepts only a closed set of curated ids. It cannot
// receive a command, argument, environment value, token, or arbitrary server
// definition from the browser.
integrationsRouter.put("/integrations/mcp", async (req, res) => {
  try {
    await saveCuratedMcpConfig(req.body);
    res.json(await probeMcpIntegrations());
  } catch (error) {
    if (error instanceof McpConfigValidationError) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }
});
