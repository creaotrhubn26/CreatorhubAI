import { Router } from "express";
import type { DashboardStatus } from "@glimmer/shared";
import { probeModel } from "../lib/modelStatus";
import { CONFIG } from "../config";
import { listSessionIds, readSession } from "../lib/sessions";

export const statusRouter = Router();

statusRouter.get("/status", async (_req, res) => {
  const model = await probeModel(CONFIG.modelBaseUrl);
  const ids = await listSessionIds();
  const sessions = (await Promise.all(ids.slice(0, 10).map(readSession))).filter(Boolean) as NonNullable<
    Awaited<ReturnType<typeof readSession>>
  >[];
  const active = sessions.find((s) =>
    !["verified", "failed", "cancelled", "needs_review"].includes(s.status)
  );
  const latest = sessions[0];

  const body: DashboardStatus = {
    model,
    activeSession: active ? { id: active.id, status: active.status, changedFiles: active.changedFiles } : null,
    latestSession: latest ? { id: latest.id, task: latest.task, status: latest.status, completedAt: latest.completedAt } : null,
    recentSessions: sessions.map((s) => ({
      id: s.id, task: s.task, status: s.status, changedFiles: s.changedFiles, completedAt: s.completedAt,
    })),
    verification: latest ? latest.verification : null,
  };
  res.json(body);
});
