import { Router } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionsDir } from "../config";
import { listSessionIds, readSession, readManifestRaw, isValidSessionId } from "../lib/sessions";
import { gitDiff, gitRevertFile } from "../lib/git";
import { parseLogToEvents } from "../lib/events";

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

sessionsRouter.get("/sessions/:id/events", async (req, res) => {
  if (!isValidSessionId(req.params.id)) return res.status(404).json({ error: "not found" });
  const logPath = path.join(sessionsDir(), req.params.id, "engineer-00.log");
  try {
    const text = await fs.readFile(logPath, "utf-8");
    res.json(parseLogToEvents(req.params.id, text));
  } catch (err: any) {
    if (err.code === "ENOENT") return res.json([]);
    res.status(500).json({ error: err.message });
  }
});

sessionsRouter.get("/sessions/:id/diff", async (req, res) => {
  try {
    const session = await readSession(req.params.id);
    if (!session) return res.status(404).json({ error: "not found" });
    const diff = await gitDiff(session.workspace, session.changedFiles.map((f) => f.path));
    res.json({ diff });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

sessionsRouter.post("/sessions/:id/revert-file", async (req, res) => {
  try {
    const session = await readSession(req.params.id);
    if (!session) return res.status(404).json({ error: "not found" });
    const targetPath = req.body?.path;
    if (typeof targetPath !== "string") return res.status(400).json({ error: "path required" });
    try {
      await gitRevertFile(session.workspace, session.changedFiles.map((f) => f.path), targetPath);
      res.json({ reverted: targetPath });
    } catch (err: any) {
      res.status(403).json({ error: err.message });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
