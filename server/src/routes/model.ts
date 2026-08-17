import { Router } from "express";
import { probeModel } from "../lib/modelStatus.js";
import { CONFIG } from "../config.js";

export const modelRouter = Router();

modelRouter.get("/model/status", async (_req, res) => {
  res.json(await probeModel(CONFIG.modelBaseUrl));
});
