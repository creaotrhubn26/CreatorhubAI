import { Router } from "express";
import type { DashboardStatus, GlimmerSessionStatus } from "@glimmer/shared";
import { probeModel } from "../lib/modelStatus.js";
import { CONFIG } from "../config.js";
import { listSessionIds, readSession } from "../lib/sessions.js";

export const statusRouter = Router();

const IN_FLIGHT_STATUSES = new Set<GlimmerSessionStatus>([
  "preflight", "understanding", "discovery", "candidate_selection",
  "implementing", "verifying", "repairing", "waiting_for_approval",
]);

statusRouter.get("/status", async (_req, res) => {
  const model = await probeModel(CONFIG.modelBaseUrl);
  const ids = await listSessionIds();
  const sessions = (await Promise.all(ids.slice(0, 10).map(readSession))).filter(Boolean) as NonNullable<
    Awaited<ReturnType<typeof readSession>>
  >[];
  // Inclusion, not exclusion: an unmapped/terminal status must never be shown
  // as the live "active session" (spec: never show fake live values as real).
  const active = sessions.find((s) => IN_FLIGHT_STATUSES.has(s.status));
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
