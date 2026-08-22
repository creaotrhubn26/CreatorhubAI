import { Router } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG, sessionsDir } from "../config.js";
import {
  listSessionIds, readSession, readManifestRaw, isValidSessionId,
  resolveSessionId, adoptRealSessionDir, writeGatewayContract,
  readArchitecturePlan, readArchitectReviews, readDeliveryReview, readSessionTasks,
  writeHumanAcceptance,
} from "../lib/sessions.js";
import { gitDiff, gitRevertFile } from "../lib/git.js";
import { runGlimmer, buildArgs, validateAdvanced } from "../lib/runner.js";
import { computeRiskScore, computeScopeGuard } from "../lib/repoAnalysis.js";
import { findRepoMap } from "./repository.js";
import { askSessionAssistant, streamSessionAssistant } from "../lib/sessionAssistant.js";
import { isGlimmerEvent, type TaskContract, type GlimmerSession, type SessionAnalysis, type GlimmerEvent, type RepoMap } from "@glimmer/shared";

export const sessionsRouter = Router();

const activeRuns = new Map<string, { cancel(): void }>();
const pendingContracts = new Map<string, { contract: TaskContract; workspace: string }>();

// This session's own repo-map.json, if glimmer-v2.py wrote one for this run.
// Must take priority over the global findRepoMap() fallback (which walks ALL
// sessions newest-first) — otherwise analyzing any session that isn't the
// most-recently-created one scores against a stranger session's repo map.
async function findOwnRepoMap(id: string): Promise<RepoMap | null> {
  const mapPath = path.join(sessionsDir(), resolveSessionId(id), "repo-map.json");
  try {
    return JSON.parse(await fs.readFile(mapPath, "utf-8")) as RepoMap;
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
    return null;
  }
}

export async function readSessionEventsBatch(id: string): Promise<GlimmerEvent[]> {
  const eventsPath = path.join(sessionsDir(), resolveSessionId(id), "events.jsonl");
  let text: string;
  try {
    text = await fs.readFile(eventsPath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const events: GlimmerEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (isGlimmerEvent(parsed)) events.push(parsed);
      // else: silently skip — a malformed or partially-written line (a
      // concurrent writer's in-flight append) is not a server error.
    } catch {
      // Torn/partial JSON line — same treatment as above, not an error.
    }
  }
  return events;
}

sessionsRouter.get("/sessions", async (_req, res) => {
  const ids = await listSessionIds();
  // V7 §20: deliberately NOT { computeStale: true } here -- see readSession's
  // own comment. This is a polled list endpoint; per-session git spawns here
  // would scale with session count on every poll interval.
  const sessions = (await Promise.all(ids.map((id) => readSession(id)))).filter(Boolean);
  res.json(sessions);
});

sessionsRouter.get("/sessions/:id", async (req, res) => {
  const session = await readSession(req.params.id, { computeStale: true });
  if (!session) return res.status(404).json({ error: "not found" });
  res.json(session);
});

sessionsRouter.get("/sessions/:id/manifest", async (req, res) => {
  const raw = await readManifestRaw(req.params.id);
  if (!raw) return res.status(404).json({ error: "not found" });
  res.json(raw);
});

sessionsRouter.get("/sessions/:id/events", async (req, res) => {
  if (!isValidSessionId(resolveSessionId(req.params.id))) return res.status(404).json({ error: "not found" });

  if (req.query.stream === "1") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let lastCount = 0;
    const interval = setInterval(async () => {
      try {
        // readSessionEventsBatch re-resolves the pending -> real session alias
        // and re-reads events.jsonl (append-only) on every tick, so a stale
        // lastCount never outruns the file — it only ever grows.
        const events = await readSessionEventsBatch(req.params.id);
        for (const evt of events.slice(lastCount)) {
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        }
        lastCount = events.length;
      } catch { /* events.jsonl not written yet */ }
    }, 1000);
    req.on("close", () => clearInterval(interval));
    return;
  }

  try {
    res.json(await readSessionEventsBatch(req.params.id));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

sessionsRouter.post("/sessions/:id/ask", async (req, res) => {
  const question = req.body?.question;
  if (typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "question is required" });
  }
  let session, events;
  try {
    session = await readSession(req.params.id);
    if (!session) return res.status(404).json({ error: "not found" });
    events = await readSessionEventsBatch(req.params.id);
  } catch (err: any) {
    // Fault reading our own session/event state — a gateway-side error, not
    // the model's fault. Must not be reported as a 502 (upstream unreachable).
    return res.status(500).json({ error: err.message });
  }
  if (req.query.stream === "1") {
    // Reuses the SSE header pattern from GET /sessions/:id/events above.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // The client tab closing / navigating away must not leave the upstream
    // model generation running for nothing — abort it the moment our own
    // response socket closes. Deliberately `res`, not `req`: express.json()
    // has already fully consumed and ended the request stream by the time
    // this handler runs, so `req`'s own 'close'/'destroyed' fire almost
    // immediately regardless of whether the client is still there — `res`
    // (still open, mid-response) only closes on a genuine disconnect.
    let clientDisconnected = false;
    const clientGone = new AbortController();
    res.on("close", () => {
      clientDisconnected = true;
      clientGone.abort();
    });
    try {
      const answer = await streamSessionAssistant(
        CONFIG.modelBaseUrl, session, events, question,
        (delta) => { res.write(`data: ${JSON.stringify({ delta })}\n\n`); },
        undefined, clientGone.signal
      );
      res.write(`data: ${JSON.stringify({ done: true, answer })}\n\n`);
    } catch {
      // Covers both connection-time failure and a mid-stream upstream error —
      // headers are already sent, so this must be a data frame, not a status
      // code. The client shows the same "Unavailable" copy as the 502 path.
      // Guarded: if we got here because the client itself disconnected, the
      // socket is already gone and writing to it would throw.
      if (!clientDisconnected) res.write(`data: ${JSON.stringify({ error: "unavailable" })}\n\n`);
    }
    if (!clientDisconnected) res.end();
    return;
  }

  try {
    const answer = await askSessionAssistant(CONFIG.modelBaseUrl, session, events, question);
    res.json(answer);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
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
  // §7 Advanced controls: server is the validation boundary, not the
  // composer UI — a client posting an out-of-range/wrong-type value directly
  // to the API must 400 the same way a malformed core field does.
  const advancedError = validateAdvanced(contract);
  if (advancedError) return res.status(400).json({ error: advancedError });

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
  await writeGatewayContract(dir, pending.contract);

  // Snapshot before spawning: glimmer-v2.py creates its own session directory
  // early in main(), and whichever directory appears next is this run's.
  const before = new Set(await listSessionIds());

  const args = buildArgs(pending.contract, pending.workspace);
  const handle = runGlimmer(dir, CONFIG.glimmerV2Path, ["--engineer", CONFIG.engineerPath, ...args], () => {
    activeRuns.delete(req.params.id);
  });
  void adoptRealSessionDir(req.params.id, before);
  activeRuns.set(req.params.id, handle);
  pendingContracts.delete(req.params.id); // consumed: a second /run 404s instead of re-spawning
  res.json({ started: true, pid: handle.pid });
});

sessionsRouter.post("/sessions/:id/cancel", async (req, res) => {
  if (!isValidSessionId(resolveSessionId(req.params.id))) return res.status(404).json({ error: "not found" });
  const run = activeRuns.get(req.params.id);
  if (!run) return res.status(404).json({ error: "no active run for this session id" });
  run.cancel();
  activeRuns.delete(req.params.id);
  res.json({ cancelled: true });
});

sessionsRouter.get("/sessions/:id/analysis", async (req, res) => {
  try {
    const session = await readSession(req.params.id);
    if (!session) return res.status(404).json({ error: "not found" });
    const repoMap = (await findOwnRepoMap(req.params.id)) ?? (await findRepoMap());
    const riskScore = computeRiskScore(session.changedFiles, repoMap);
    const scopeGuard = session.taskContract
      ? computeScopeGuard(session.taskContract.scope, session.changedFiles, repoMap)
      : null;
    // changedFiles always comes from this session's own real manifest/git
    // state (never a model guess) — see repoAnalysis.ts for how riskScore and
    // scopeGuard are derived from it.
    const body: SessionAnalysis = { riskScore, scopeGuard, provenance: "git-derived" };
    res.json(body);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Opt-in architect-mode artifacts (C2/C3, glimmer-v7). Read-only, fixed
// filenames within the resolved session dir only — no arbitrary file
// serving. Absence is normal (most sessions never opt into architect mode),
// so it 404s the same way a missing/malformed manifest.json does; a real fs
// fault (permissions, EISDIR, ...) is a gateway bug and 500s.
sessionsRouter.get("/sessions/:id/plan", async (req, res) => {
  try {
    const plan = await readArchitecturePlan(req.params.id);
    if (!plan) return res.status(404).json({ error: "not found" });
    res.json(plan);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

sessionsRouter.get("/sessions/:id/architect-reviews", async (req, res) => {
  try {
    const reviews = await readArchitectReviews(req.params.id);
    if (!reviews) return res.status(404).json({ error: "not found" });
    res.json(reviews);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

sessionsRouter.get("/sessions/:id/delivery-review", async (req, res) => {
  try {
    const review = await readDeliveryReview(req.params.id);
    if (!review) return res.status(404).json({ error: "not found" });
    res.json(review);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

sessionsRouter.get("/sessions/:id/tasks", async (req, res) => {
  try {
    const tasks = await readSessionTasks(req.params.id);
    if (!tasks) return res.status(404).json({ error: "not found" });
    res.json(tasks);
  } catch (err: any) {
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

// §14 Diff Review — human "accept for review" action. Distinct from
// technical verification: the model/orchestrator never writes this file (see
// writeHumanAcceptance in lib/sessions.ts), only this route does, on a real
// human's click. Idempotent — accepting an already-accepted session just
// returns the original acceptance record.
sessionsRouter.post("/sessions/:id/accept", async (req, res) => {
  try {
    const session = await readSession(req.params.id);
    if (!session) return res.status(404).json({ error: "not found" });
    const record = await writeHumanAcceptance(req.params.id);
    res.json(record);
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
      await gitRevertFile(session.workspace, session.changedFiles.map((f) => f.path), targetPath, session.baselineSha);
      res.json({ reverted: targetPath });
    } catch (err: any) {
      res.status(403).json({ error: err.message });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
