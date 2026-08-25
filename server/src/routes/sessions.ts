import { Router, type Request, type Response } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CONFIG, gatewayRunLogsDir, sessionsDir } from "../config.js";
import {
  listSessionIds, readSession, readManifestRaw, isValidSessionId,
  resolveSessionId,
  readArchitecturePlan, readArchitectReviews, readDeliveryReview, readDeliveryPacket, readSessionTasks,
  writeHumanAcceptance, clearHumanAcceptance, readVisualManifest, readVisualFindings,
  readTaskOverrides, writeTaskOverride, applyTaskOverrides,
  readEvidenceIndex, readEvidenceEntry, resolveApproval,
  readTaskReport,
  readHunkAcceptances, writeHunkAcceptance, clearHunkAcceptance, clearHunkAcceptancesForPath,
} from "../lib/sessions.js";
import { gitDiff, gitRevertFile, gitRejectHunk, gitStatus, parseGitDiffHunks, GitHunkReviewError } from "../lib/git.js";
import { runGlimmer, buildArgs, validateAdvanced } from "../lib/runner.js";
import { computeRiskScore, computeScopeGuard } from "../lib/repoAnalysis.js";
import { findRepoMap } from "./repository.js";
import {
  askRepositoryAssistant, askSessionAssistant, streamRepositoryAssistant, streamSessionAssistant,
} from "../lib/sessionAssistant.js";
import { readWorkspaceFile } from "./workspaces.js";
import {
  inferTaskIntent, isGlimmerEvent, type TaskContract, type GlimmerSession, type SessionAnalysis, type GlimmerEvent, type RepoMap,
  type VisualVerification, type RepositorySelection, type SessionDiff,
} from "@glimmer/shared";
import {
  createGatewayRun, readGatewayRun, terminateRecordedProcess, updateGatewayRun,
} from "../lib/runState.js";

export const sessionsRouter = Router();

const activeRuns = new Map<string, { cancel(): void }>();
const TASK_MODES = new Set(["inspect", "plan", "implement", "debug", "test", "review", "refactor"]);
const TASK_INTENTS = new Set(["direct", "improvement-assessment"]);
const TASK_INTENT_SOURCES = new Set(["explicit", "deterministic-inference"]);

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

const MAX_REPOSITORY_SELECTION_LINES = 400;
const MAX_REPOSITORY_SELECTION_CHARS = 40_000;

type SelectionEvidenceResult =
  | { ok: true; evidence: string }
  | { ok: false; status: number; error: string };

async function repositorySelectionEvidence(raw: unknown): Promise<SelectionEvidenceResult> {
  const selection = raw as Partial<RepositorySelection> | null;
  if (
    !selection || typeof selection.path !== "string" || !selection.path.trim() ||
    !Number.isInteger(selection.startLine) || !Number.isInteger(selection.endLine) ||
    (selection.startLine ?? 0) < 1 || (selection.endLine ?? 0) < (selection.startLine ?? 0)
  ) {
    return { ok: false, status: 400, error: "a valid repository selection is required" };
  }
  const startLine = selection.startLine as number;
  const endLine = selection.endLine as number;
  if (endLine - startLine + 1 > MAX_REPOSITORY_SELECTION_LINES) {
    return { ok: false, status: 400, error: `selection exceeds ${MAX_REPOSITORY_SELECTION_LINES} lines` };
  }

  // Re-read at question time through Round A's exact content boundary. The
  // client cannot smuggle arbitrary evidence text into the prompt, and a
  // path outside every known workspace remains the same non-existence-oracle
  // 403 it is in the viewer.
  const read = await readWorkspaceFile(selection.path);
  if (!read.ok) return read;
  if (read.file.binary || read.file.content === null) {
    return { ok: false, status: 400, error: "binary files cannot be used as assistant evidence" };
  }
  const lines = read.file.content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  if (startLine > lines.length || endLine > lines.length) {
    return { ok: false, status: 400, error: "selection is outside the file excerpt currently available" };
  }
  const excerpt = lines.slice(startLine - 1, endLine).join("\n");
  if (excerpt.length > MAX_REPOSITORY_SELECTION_CHARS) {
    return { ok: false, status: 400, error: `selection exceeds ${MAX_REPOSITORY_SELECTION_CHARS} characters` };
  }
  return {
    ok: true,
    evidence: [
      `File: ${read.file.path}`,
      `Lines: ${startLine}-${endLine}`,
      "Provenance: gateway read from a known workspace at question time",
      "--- begin selected lines ---",
      excerpt,
      "--- end selected lines ---",
    ].join("\n"),
  };
}

// Round B / Task B1: sessionless Q&A from a code selection. This is a
// separate route on purpose: inventing a fake session would make the
// provenance label false. Like /sessions/:id/ask it supports streaming, but
// the model request carries no tools/functions in either mode.
sessionsRouter.post("/repository/ask", async (req, res) => {
  const question = req.body?.question;
  if (typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "question is required" });
  }
  let selected: SelectionEvidenceResult;
  try {
    selected = await repositorySelectionEvidence(req.body?.selection);
  } catch (err: any) {
    // Workspace discovery happens before the file reader's own fs-error
    // mapping; surface infrastructure failure as a bounded HTTP response.
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
  if (!selected.ok) return res.status(selected.status).json({ error: selected.error });

  if (req.query.stream === "1") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let clientDisconnected = false;
    const clientGone = new AbortController();
    res.on("close", () => {
      clientDisconnected = true;
      clientGone.abort();
    });
    try {
      const answer = await streamRepositoryAssistant(
        CONFIG.modelBaseUrl,
        selected.evidence,
        question,
        (delta) => { res.write(`data: ${JSON.stringify({ delta })}\n\n`); },
        undefined,
        clientGone.signal,
      );
      res.write(`data: ${JSON.stringify({ done: true, answer })}\n\n`);
    } catch {
      if (!clientDisconnected) res.write(`data: ${JSON.stringify({ error: "unavailable" })}\n\n`);
    }
    if (!clientDisconnected) res.end();
    return;
  }

  try {
    res.json(await askRepositoryAssistant(CONFIG.modelBaseUrl, selected.evidence, question));
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

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
        // Re-read the canonical session's append-only events file on every
        // tick, so a stale lastCount never outruns the file — it only grows.
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
    !TASK_MODES.has(contract.mode) ||
    !Array.isArray(contract.verification) ||
    typeof contract.repairBudget !== "number" ||
    typeof workspace !== "string" || !workspace
  ) {
    return res.status(400).json({ error: "invalid taskContract or workspace" });
  }
  if (contract.intent !== undefined && (
    typeof contract.intent !== "object" ||
    !TASK_INTENTS.has(contract.intent.kind) ||
    !TASK_INTENT_SOURCES.has(contract.intent.source)
  )) {
    return res.status(400).json({ error: "invalid taskContract.intent" });
  }
  // §7 Advanced controls: server is the validation boundary, not the
  // composer UI — a client posting an out-of-range/wrong-type value directly
  // to the API must 400 the same way a malformed core field does.
  const advancedError = validateAdvanced(contract);
  if (advancedError) return res.status(400).json({ error: advancedError });

  const normalizedContract: TaskContract = {
    ...contract,
    intent: contract.intent ?? inferTaskIntent(contract.objective),
  };
  const record = await createGatewayRun(normalizedContract, workspace);
  const session = await readSession(record.id);
  res.status(201).json(session);
});

sessionsRouter.post("/sessions/:id/run", async (req, res) => {
  if (!isValidSessionId(req.params.id)) return res.status(404).json({ error: "not found" });
  if (activeRuns.has(req.params.id)) return res.status(409).json({ error: "already running" });
  const record = await readGatewayRun(req.params.id);
  if (!record) return res.status(404).json({ error: "no task contract for this session id" });
  if (record.state !== "created") return res.status(409).json({ error: "session has already been started" });

  // Mirror the orchestrator's non-negotiable branch boundary before we
  // spawn it. This makes an early rejection synchronous and leaves
  // the composer on screen with a recovery instruction. gitStatus uses
  // execFile argv (never a shell) and also proves the selected path is a Git
  // worktree before any child process starts.
  let workspaceStatus: Awaited<ReturnType<typeof gitStatus>>;
  try {
    workspaceStatus = await gitStatus(record.workspace);
  } catch {
    return res.status(400).json({
      error: "Workspace must be a Git worktree on an isolated glimmer/* branch.",
    });
  }
  if (!workspaceStatus.branch.startsWith("glimmer/")) {
    return res.status(409).json({
      error: `Refusing branch ${workspaceStatus.branch}: create or choose a worktree on a glimmer/* branch.`,
    });
  }

  try {
    await updateGatewayRun(req.params.id, (current) => {
      if (current.state !== "created") throw new Error("already-started");
      return {
        ...current,
        state: "starting",
        branch: workspaceStatus.branch,
        baselineSha: workspaceStatus.headSha,
        startedAt: new Date().toISOString(),
      };
    });
  } catch (err: any) {
    if (err?.message === "already-started") return res.status(409).json({ error: "session has already been started" });
    throw err;
  }

  const logDir = path.join(gatewayRunLogsDir(), req.params.id);
  await fs.mkdir(logDir, { recursive: true });
  const args = buildArgs(record.contract, record.workspace, req.params.id);
  const handle = runGlimmer(logDir, CONFIG.glimmerV2Path, ["--engineer", CONFIG.engineerPath, ...args], (code) => {
    activeRuns.delete(req.params.id);
    void updateGatewayRun(req.params.id, (current) => ({
      ...current,
      state: current.state === "cancel_requested" ? "cancel_requested" : "exited",
      exitCode: code,
      completedAt: new Date().toISOString(),
    }));
  });
  if (handle.pid <= 1) {
    await updateGatewayRun(req.params.id, (current) => ({
      ...current, state: "start_failed", error: "orchestrator process did not start",
      completedAt: new Date().toISOString(),
    }));
    return res.status(500).json({ error: "orchestrator process did not start" });
  }
  activeRuns.set(req.params.id, handle);
  await updateGatewayRun(req.params.id, (current) => ({ ...current, state: "running", pid: handle.pid }));
  res.json({ started: true, pid: handle.pid });
});

sessionsRouter.post("/sessions/:id/cancel", async (req, res) => {
  if (!isValidSessionId(req.params.id)) return res.status(404).json({ error: "not found" });
  const record = await readGatewayRun(req.params.id);
  if (!record) return res.status(404).json({ error: "not found" });
  const active = activeRuns.get(req.params.id);
  if (active) {
    active.cancel();
    activeRuns.delete(req.params.id);
  } else {
    if (record.state !== "running" && record.state !== "starting") {
      return res.status(409).json({ error: "session is not running" });
    }
    // After a gateway restart the in-memory handle is gone. Only signal a PID
    // whose live command line proves it belongs to this exact canonical run.
    if (!(await terminateRecordedProcess(record))) {
      await updateGatewayRun(req.params.id, (current) => ({
        ...current, state: "exited", completedAt: current.completedAt ?? new Date().toISOString(),
      }));
      return res.status(409).json({ error: "session process is no longer running" });
    }
  }
  await updateGatewayRun(req.params.id, (current) => ({
    ...current, state: "cancel_requested", completedAt: new Date().toISOString(),
  }));
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

sessionsRouter.get("/sessions/:id/task-report", async (req, res) => {
  try {
    const report = await readTaskReport(req.params.id);
    if (!report) return res.status(404).json({ error: "not found" });
    res.json(report);
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

// Task 8.2 (V7 §23.16) -- delivery-packet.json, assembled once by
// glimmer-v2.py at session close-out. Same opt-in-artifact-absence
// convention as /delivery-review, /plan, etc.
sessionsRouter.get("/sessions/:id/delivery-packet", async (req, res) => {
  try {
    const packet = await readDeliveryPacket(req.params.id);
    if (!packet) return res.status(404).json({ error: "not found" });
    res.json(packet);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Task 5.2 (V7 §26/§46): evidence-index.json + per-entry lookup behind
// one endpoint, distinguished by the ?id= query param -- a single
// GET route (rather than a second path segment) since both read from
// the same underlying evidence store and the panel's two views (list,
// then drill into one entry) are really one resource at different
// granularity. Same opt-in-artifact-absence convention as /plan,
// /delivery-review, etc.: no evidence-index.json (or no matching id) is
// normal and 404s honestly.
sessionsRouter.get("/sessions/:id/evidence", async (req, res) => {
  try {
    const evidenceId = req.query.id;
    if (typeof evidenceId === "string" && evidenceId) {
      const entry = await readEvidenceEntry(req.params.id, evidenceId);
      if (!entry) return res.status(404).json({ error: "not found" });
      return res.json(entry);
    }
    const entries = await readEvidenceIndex(req.params.id);
    if (!entries) return res.status(404).json({ error: "not found" });
    res.json({ entries });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Task 9.3c (V7 §7 Context Engine): context-selection facts for the panel --
// every context_selected event this session emitted (glimmer-engineer.py's
// Tier0/1/2/3 sizing, re-emitted each time compaction moves something to
// Tier2) plus how many entries evidence-index.json holds (Tier2's own
// retrievable store, same file /evidence above already serves). Same
// existence check as /sessions/:id/events (isValidSessionId only, not
// "does a directory exist on disk") -- a well-formed but never-created
// session id honestly gets back empty facts (selections: [], evidenceCount:
// null), not a 404, exactly like /events already returns [] rather than
// 404ing in that case. An invalid/unsafe id is the only real 404 here.
sessionsRouter.get("/sessions/:id/context", async (req, res) => {
  if (!isValidSessionId(resolveSessionId(req.params.id))) return res.status(404).json({ error: "not found" });
  try {
    const events = await readSessionEventsBatch(req.params.id);
    const selections = events.filter((e) => e.type === "context_selected");
    const evidenceIndex = await readEvidenceIndex(req.params.id);
    res.json({
      selections,
      evidenceCount: evidenceIndex ? evidenceIndex.length : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

sessionsRouter.get("/sessions/:id/tasks", async (req, res) => {
  try {
    const tasks = await readSessionTasks(req.params.id);
    if (!tasks) return res.status(404).json({ error: "not found" });
    const overrides = await readTaskOverrides(req.params.id);
    res.json(applyTaskOverrides(tasks, overrides));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Task 4.3: human skip/approve, the task-level counterpart to §14's
// /sessions/:id/accept — gateway-owned (see writeTaskOverride), never
// touches tasks.json (glimmer-v2.py's own artifact). 404s on an unknown
// session OR an unknown taskId, same "reject bad input as not-found"
// discipline as the rest of this file; never validates session status
// here (the panel decides when to show the buttons, this route just
// records the human's decision honestly whenever it's called).
async function handleTaskOverride(req: Request, res: Response, action: "skip" | "approve") {
  try {
    const tasks = await readSessionTasks(req.params.id);
    const task = tasks?.find((t) => t.id === req.params.taskId);
    if (!task) return res.status(404).json({ error: "not found" });
    // Review round 1 (Important 3): stamp the task's CURRENT kind/
    // description onto the override record -- see writeTaskOverride/
    // applyTaskOverrides for why (task ids aren't stable across a replan).
    const record = await writeTaskOverride(req.params.id, req.params.taskId, action, {
      kind: task.kind, description: task.description,
    });
    res.json({ taskId: req.params.taskId, ...record });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

sessionsRouter.post("/sessions/:id/tasks/:taskId/skip", (req, res) => handleTaskOverride(req, res, "skip"));
sessionsRouter.post("/sessions/:id/tasks/:taskId/approve", (req, res) => handleTaskOverride(req, res, "approve"));

// Task 8.3 (V7 §14/§35): human approve/deny for a YELLOW-classified action
// glimmer-engineer.py is currently blocked waiting on (approvals.json) --
// gateway-owned resolution, exactly like the task-override routes above.
// 404s on an unknown session OR an unknown/never-requested approvalId;
// never validates session status (mirrors handleTaskOverride's own
// reasoning: this just records the human's decision honestly). Idempotent:
// a second approve/deny call on an already-resolved approvalId returns the
// SAME stored record rather than erroring or re-resolving it (see
// resolveApproval).
async function handleApprovalResolution(req: Request, res: Response, action: "approve" | "deny") {
  try {
    // No real auth/user-account system in this local single-operator tool
    // (same reality HumanAcceptance's {accepted, acceptedAt} already
    // reflects, with no actor field at all) -- approvedBy is whatever the
    // client sends, defaulting to a generic label when omitted, purely so
    // the sidecar's human-provenance field is never left blank.
    const approvedBy = typeof req.body?.approvedBy === "string" && req.body.approvedBy.trim()
      ? req.body.approvedBy.trim() : "control-center-operator";
    const record = await resolveApproval(req.params.id, req.params.approvalId, action, approvedBy);
    if (!record) return res.status(404).json({ error: "not found" });
    res.json({ approvalId: req.params.approvalId, ...record });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

sessionsRouter.post("/sessions/:id/approvals/:approvalId/approve", (req, res) => handleApprovalResolution(req, res, "approve"));
sessionsRouter.post("/sessions/:id/approvals/:approvalId/deny", (req, res) => handleApprovalResolution(req, res, "deny"));

// V7 §22.14/§22.16 visual evidence store -- static serving of a session's
// visual/ artifacts. Same opt-in-artifact-absence convention as /plan,
// /architect-reviews, etc.: no visual/ dir at all is normal (most sessions
// never run glimmer-visual.py) and 404s honestly rather than erroring.
sessionsRouter.get("/sessions/:id/visual/manifest", async (req, res) => {
  try {
    const manifest = await readVisualManifest(req.params.id);
    if (!manifest) return res.status(404).json({ error: "not found" });
    // findings.json is written unconditionally alongside visual-manifest.json
    // by glimmer-visual.py's main(), so it should always be present once
    // manifest is -- null here means a genuine read fault, not "vision
    // wasn't run" (that's findings.status === "NOT_RUN", a different fact).
    const findings = await readVisualFindings(req.params.id);
    const body: VisualVerification = { manifest, findings };
    res.json(body);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Screenshot filenames are exactly what glimmer-visual.py writes:
// "{viewport}.png" or "{viewport}-{state}.png", e.g. "1440x900.png" /
// "1440x900-dialogopen.png" -- letters, digits, and "-" only. This is a
// file-serving endpoint (untrusted path segment straight into a filesystem
// read), so validation is intentionally strict rather than permissive: no
// ".", no "/", nothing a traversal payload could exploit, checked BEFORE
// the file is ever touched. The resolved-path containment check below is
// deliberate defense in depth on top of that charset restriction, not a
// substitute for it (same two-layer discipline as isValidSessionId).
const VISUAL_SCREENSHOT_FILENAME_RE = /^[A-Za-z0-9x-]+\.png$/;

function resolveVisualScreenshotPath(visualDir: string, file: string): string | null {
  if (!VISUAL_SCREENSHOT_FILENAME_RE.test(file)) return null;
  const resolvedDir = path.resolve(visualDir);
  const resolved = path.resolve(visualDir, file);
  if (resolved !== path.join(resolvedDir, file) || !resolved.startsWith(resolvedDir + path.sep)) return null;
  return resolved;
}

sessionsRouter.get("/sessions/:id/visual/screenshot/:file", async (req, res) => {
  const real = resolveSessionId(req.params.id);
  if (!isValidSessionId(real)) return res.status(404).json({ error: "not found" });
  const visualDir = path.join(sessionsDir(), real, "visual");
  const resolved = resolveVisualScreenshotPath(visualDir, req.params.file);
  if (!resolved) return res.status(400).json({ error: "invalid filename" });
  try {
    const bytes = await fs.readFile(resolved);
    res.type("png").send(bytes);
  } catch (err: any) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "not found" });
    res.status(500).json({ error: err.message });
  }
});

sessionsRouter.get("/sessions/:id/diff", async (req, res) => {
  try {
    const session = await readSession(req.params.id);
    if (!session) return res.status(404).json({ error: "not found" });
    const diff = await gitDiff(session.workspace, session.changedFiles.map((f) => f.path));
    const acceptances = await readHunkAcceptances(req.params.id);
    const hunks = parseGitDiffHunks(diff).map(({ patch: _patch, ...hunk }) => {
      const accepted = acceptances[hunk.id];
      return {
        ...hunk,
        status: accepted?.path === hunk.path ? "accepted" as const : "pending" as const,
        ...(accepted?.path === hunk.path ? { acceptedAt: accepted.acceptedAt } : {}),
      };
    });
    const body: SessionDiff = { diff, hunks };
    res.json(body);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

sessionsRouter.post("/sessions/:id/hunks/:hunkId/accept", async (req, res) => {
  try {
    const session = await readSession(req.params.id);
    if (!session) return res.status(404).json({ error: "not found" });
    const targetPath = req.body?.path;
    if (typeof targetPath !== "string") return res.status(400).json({ error: "path required" });
    if (!session.changedFiles.some((file) => file.path === targetPath)) {
      return res.status(403).json({ error: "path is not in this session's changed files" });
    }
    const current = parseGitDiffHunks(await gitDiff(session.workspace, [targetPath]));
    const hunk = current.find((candidate) => candidate.path === targetPath && candidate.id === req.params.hunkId);
    if (!hunk) return res.status(409).json({ error: "hunk changed; refresh and review again" });
    const record = await writeHunkAcceptance(req.params.id, hunk.id, hunk.path);
    res.json({ hunkId: hunk.id, path: hunk.path, decision: "accepted", decidedAt: record.acceptedAt });
  } catch (err: any) {
    res.status(500).json({ error: "could not accept hunk" });
  }
});

sessionsRouter.post("/sessions/:id/hunks/:hunkId/reject", async (req, res) => {
  try {
    const session = await readSession(req.params.id);
    if (!session) return res.status(404).json({ error: "not found" });
    const targetPath = req.body?.path;
    if (typeof targetPath !== "string") return res.status(400).json({ error: "path required" });
    if (!session.changedFiles.some((file) => file.path === targetPath)) {
      return res.status(403).json({ error: "path is not in this session's changed files" });
    }
    const current = parseGitDiffHunks(await gitDiff(session.workspace, [targetPath]));
    if (!current.some((candidate) => candidate.path === targetPath && candidate.id === req.params.hunkId)) {
      return res.status(409).json({ error: "hunk changed; refresh and review again" });
    }
    // Clear a prior acceptance before the mutation. If git apply then finds
    // a race after the canonical check above, the safe outcome is pending
    // review rather than retaining an acceptance they attempted to reject.
    await clearHunkAcceptance(req.params.id, req.params.hunkId);
    const hunk = await gitRejectHunk(
      session.workspace,
      session.changedFiles.map((file) => file.path),
      targetPath,
      req.params.hunkId,
    );
    await clearHumanAcceptance(req.params.id);
    res.json({
      hunkId: hunk.id,
      path: hunk.path,
      decision: "rejected",
      decidedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    if (err instanceof GitHunkReviewError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: "could not reject hunk" });
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
    // The UI disables this action while text hunks remain pending, but the
    // server is the trust boundary: a direct HTTP caller must not bypass the
    // same review invariant. Binary-only diffs have no text hunks and retain
    // the existing file-level review fallback.
    if (session.changedFiles.length > 0) {
      const diff = await gitDiff(session.workspace, session.changedFiles.map((file) => file.path));
      const hunks = parseGitDiffHunks(diff);
      const acceptances = await readHunkAcceptances(req.params.id);
      const pending = hunks.filter((hunk) => acceptances[hunk.id]?.path !== hunk.path);
      if (pending.length > 0) {
        return res.status(409).json({
          error: "all current text hunks must be accepted first",
          pendingHunks: pending.length,
        });
      }
    }
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
      await Promise.all([
        clearHunkAcceptancesForPath(req.params.id, targetPath),
        clearHumanAcceptance(req.params.id),
      ]);
      res.json({ reverted: targetPath });
    } catch (err: any) {
      res.status(403).json({ error: err.message });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
