import { Router } from "express";
import { listSessionIds, readSession } from "../lib/sessions.js";
import { gitStatus, createWorkspace, WorkspaceCreateError } from "../lib/git.js";
import type { WorkspaceInfo } from "@glimmer/shared";

export const workspacesRouter = Router();

workspacesRouter.get("/workspaces", async (_req, res) => {
  try {
    const ids = await listSessionIds();
    const sessions = (await Promise.all(ids.map(readSession))).filter(Boolean) as NonNullable<
      Awaited<ReturnType<typeof readSession>>
    >[];
    const uniqueWorkspaces = [...new Set(sessions.map((s) => s.workspace))];
    const infos: WorkspaceInfo[] = await Promise.all(
      uniqueWorkspaces.map(async (ws) => {
        try {
          const status = await gitStatus(ws);
          return { path: ws, ...status };
        } catch {
          return { path: ws, branch: "Unavailable", headSha: "Unavailable", baselineSha: null, dirty: false, changedFiles: [] };
        }
      })
    );
    res.json(infos);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// §27/§4.1 — the first HTTP-triggered git-WRITE path against the real source
// repo. All git argument handling and the never-delete/never-force/never-push
// guarantees live in lib/git.ts (createWorkspace); this handler only does
// request-shape validation and error-to-status mapping.
workspacesRouter.post("/workspaces", async (req, res) => {
  const { taskName } = req.body ?? {};
  if (typeof taskName !== "string" || !taskName.trim()) {
    return res.status(400).json({ error: "taskName is required" });
  }
  try {
    const result = await createWorkspace(taskName);
    res.json(result);
  } catch (err: any) {
    if (err instanceof WorkspaceCreateError) {
      // Honest half-created-state reporting: if `worktree add` already
      // succeeded before a later step failed, name the real path/branch so
      // the caller (and the human who has to clean it up) knows they exist.
      return res.status(err.status).json({ error: err.message, ...err.partial });
    }
    res.status(500).json({ error: err.message });
  }
});
