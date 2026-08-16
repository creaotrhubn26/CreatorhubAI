import { Router } from "express";
import { probeModel } from "../lib/modelStatus";
import { CONFIG } from "../config";

export const modelRouter = Router();

modelRouter.get("/model/status", async (_req, res) => {
  res.json(await probeModel(CONFIG.modelBaseUrl));
});
