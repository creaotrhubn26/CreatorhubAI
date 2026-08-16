import { Router } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG, sessionsDir } from "../config";
import { listSessionIds, readSession, readManifestRaw, isValidSessionId } from "../lib/sessions";
import { gitDiff, gitRevertFile } from "../lib/git";
import { parseLogToEvents } from "../lib/events";
import { runGlimmer, buildArgs } from "../lib/runner";
import type { TaskContract, GlimmerSession } from "@glimmer/shared";

export const sessionsRouter = Router();

const activeRuns = new Map<string, { cancel(): void }>();
const pendingContracts = new Map<string, { contract: TaskContract; workspace: string }>();

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

  if (req.query.stream === "1") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let lastCount = 0;
    const interval = setInterval(async () => {
      try {
        const text = await fs.readFile(logPath, "utf-8");
        const events = parseLogToEvents(req.params.id, text);
        for (const evt of events.slice(lastCount)) {
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        }
        lastCount = events.length;
      } catch { /* log not written yet */ }
    }, 1000);
    req.on("close", () => clearInterval(interval));
    return;
  }

  try {
    const text = await fs.readFile(logPath, "utf-8");
    res.json(parseLogToEvents(req.params.id, text));
  } catch (err: any) {
    if (err.code === "ENOENT") return res.json([]);
    res.status(500).json({ error: err.message });
  }
});

sessionsRouter.post("/sessions", async (req, res) => {
  const contract = req.body?.taskContract as TaskContract | undefined;
  const workspace = req.body?.workspace as string | undefined;
  if (
    !contract || typeof contract.objective !== "string" || !contract.objective ||
    !Array.isArray(contract.verification) ||
    typeof contract.repairBudget !== "number" ||
    typeof workspace !== "string" || !workspace
  ) {
    return res.status(400).json({ error: "invalid taskContract or workspace" });
  }

  const id = `pending-${randomUUID()}`;
  pendingContracts.set(id, { contract, workspace });
  const session: Partial<GlimmerSession> & { id: string } = {
    id, task: contract.objective, status: "created", workspace,
    branch: "Unavailable", baselineSha: "Unavailable", changedFiles: [],
    verification: { overall: "NOT_RUN", checks: [] }, repairsUsed: 0, repairBudget: contract.repairBudget,
  };
  res.status(201).json(session);
});

sessionsRouter.post("/sessions/:id/run", async (req, res) => {
  if (!isValidSessionId(req.params.id)) return res.status(404).json({ error: "not found" });
  if (activeRuns.has(req.params.id)) return res.status(409).json({ error: "already running" });
  const pending = pendingContracts.get(req.params.id);
  if (!pending) return res.status(404).json({ error: "no pending task contract for this session id" });

  const dir = path.join(sessionsDir(), req.params.id);
  await fs.mkdir(dir, { recursive: true });

  const args = buildArgs(pending.contract, pending.workspace);
  const handle = runGlimmer(dir, CONFIG.glimmerV2Path, ["--engineer", CONFIG.engineerPath, ...args], () => {
    activeRuns.delete(req.params.id);
  });
  activeRuns.set(req.params.id, handle);
  pendingContracts.delete(req.params.id); // consumed: a second /run 404s instead of re-spawning
  res.json({ started: true, pid: handle.pid });
});

sessionsRouter.post("/sessions/:id/cancel", async (req, res) => {
  if (!isValidSessionId(req.params.id)) return res.status(404).json({ error: "not found" });
  const run = activeRuns.get(req.params.id);
  if (!run) return res.status(404).json({ error: "no active run for this session id" });
  run.cancel();
  activeRuns.delete(req.params.id);
  res.json({ cancelled: true });
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
