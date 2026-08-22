import { Router } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionsDir } from "../config.js";
import { listSessionIds, isValidSessionId } from "../lib/sessions.js";
import type { DocGraph, RepoMap } from "@glimmer/shared";

export const repositoryRouter = Router();

export async function findRepoMap(): Promise<RepoMap | null> {
  const ids = await listSessionIds();
  for (const id of ids) {
    if (!isValidSessionId(id)) continue;
    const mapPath = path.join(sessionsDir(), id, "repo-map.json");
    try {
      const raw = await fs.readFile(mapPath, "utf-8");
      return JSON.parse(raw) as RepoMap;
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return null;
}

repositoryRouter.get("/repository/map", async (_req, res) => {
  try {
    const map = await findRepoMap();
    if (!map) return res.status(404).json({ error: "no repo-map.json found in any session" });
    res.json(map);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function isDocGraphShape(v: unknown): v is DocGraph {
  return !!v && typeof v === "object" && Array.isArray((v as any).nodes) && Array.isArray((v as any).edges);
}

// Task 7.5 (V7 "System Explorer"): unlike repo-map.json (a gateway-written
// copy living in the session dir), docs/graph.json is written by
// glimmer-v2.py's doc pass into the TARGET repo's own workspace -- so this
// reads a session's manifest.json only to learn its `workspace` path, then
// reads docs/graph.json from THERE. Same walk-every-session-newest-first
// shape as findRepoMap above (no single "current session" concept at the
// gateway level), same "absent or malformed -> keep looking, never fabricate"
// tolerance: a torn graph.json in one session's workspace must not block
// finding a good one elsewhere, and finding none at all is the ordinary
// "repo never ran --docs-bootstrap" case, not an error.
export async function findDocGraph(): Promise<DocGraph | null> {
  const ids = await listSessionIds();
  for (const id of ids) {
    if (!isValidSessionId(id)) continue;
    let workspace: unknown;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(sessionsDir(), id, "manifest.json"), "utf-8"));
      workspace = raw?.workspace;
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
      continue;
    }
    if (typeof workspace !== "string" || !workspace) continue;
    let raw: string;
    try {
      raw = await fs.readFile(path.join(workspace, "docs", "graph.json"), "utf-8");
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed graph.json -- skip, don't fail the whole request
    }
    if (isDocGraphShape(parsed)) return parsed;
  }
  return null;
}

repositoryRouter.get("/repository/doc-graph", async (_req, res) => {
  try {
    const graph = await findDocGraph();
    if (!graph) return res.status(404).json({ error: "no docs/graph.json found in any session workspace" });
    res.json(graph);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
