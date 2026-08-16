import { Router } from "express";
import type { DashboardStatus } from "@glimmer/shared";

export const statusRouter = Router();

statusRouter.get("/status", (_req, res) => {
  const body: DashboardStatus = {
    model: { status: "UNKNOWN", endpoint: "", provenance: "deterministic-backend" },
    activeSession: null,
    latestSession: null,
    recentSessions: [],
    verification: null,
  };
  res.json(body);
});
