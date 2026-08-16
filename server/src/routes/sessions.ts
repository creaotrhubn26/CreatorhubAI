import { Router } from "express";
import { listSessionIds, readSession, readManifestRaw } from "../lib/sessions";

export const sessionsRouter = Router();

sessionsRouter.get("/sessions", async (_req, res) => {
  const ids = await listSessionIds();
  const sessions = (await Promise.all(ids.map(readSession))).filter(Boolean);
  res.json(sessions);
});

sessionsRouter.get("/sessions/:id", async (req, res) => {
  const session = await readSession(req.params.id);
  if (!session) return res.status(404).json({ error: "not found" });
  res.json(session);
});

sessionsRouter.get("/sessions/:id/manifest", async (req, res) => {
  const raw = await readManifestRaw(req.params.id);
  if (!raw) return res.status(404).json({ error: "not found" });
  res.json(raw);
});
