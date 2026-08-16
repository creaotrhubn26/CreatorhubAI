import { Router } from "express";
import { listSessionIds, readSession } from "../lib/sessions";
import { gitStatus } from "../lib/git";
import type { WorkspaceInfo } from "@glimmer/shared";

export const workspacesRouter = Router();

workspacesRouter.get("/workspaces", async (_req, res) => {
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
});
