import { Router } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionsDir } from "../config.js";
import { listSessionIds, isValidSessionId } from "../lib/sessions.js";
import type { DocGraph, DocGraphSource, RepoMap } from "@glimmer/shared";

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

// Task 4c(b): findRepoMap() above answers "some repo map, from whichever
// session happens to sort first" -- fine for the repository screen (which has
// no workspace context), a fabrication for the composer (the user is composing
// against ONE workspace, and an unrelated repo's packages/areas presented as
// theirs is a lie). This variant matches on the session's own manifest
// `workspace` (same manifest read findDocGraph does), and returns null rather
// than falling back to anything else -- "no repo map for this workspace yet"
// is an honest, common answer (the workspace has simply never been run).
export async function findRepoMapForWorkspace(
  workspace: string,
): Promise<{ map: RepoMap; sessionId: string } | null> {
  const target = path.resolve(workspace);
  for (const id of await listSessionIds()) {
    if (!isValidSessionId(id)) continue;
    let manifestRaw: string;
    try {
      manifestRaw = await fs.readFile(path.join(sessionsDir(), id, "manifest.json"), "utf-8");
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
      continue; // no manifest: can't attribute this session to a workspace
    }
    let manifestWorkspace: unknown;
    try {
      manifestWorkspace = JSON.parse(manifestRaw)?.workspace;
    } catch {
      continue; // torn manifest (glimmer-v2.py rewrites it non-atomically) — skip, don't fail the panel
    }
    if (typeof manifestWorkspace !== "string" || path.resolve(manifestWorkspace) !== target)
      continue;
    try {
      const raw = await fs.readFile(path.join(sessionsDir(), id, "repo-map.json"), "utf-8");
      return { map: JSON.parse(raw) as RepoMap, sessionId: id };
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
      // This session matched but never got a repo-map.json — an older run of
      // the same workspace still might, so keep walking.
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
  return (
    !!v &&
    typeof v === "object" &&
    Array.isArray((v as any).nodes) &&
    Array.isArray((v as any).edges)
  );
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
//
// M6 fix (round-7 review): with sessions against two different repos, "first
// found" can return the wrong repo's graph. This doesn't stop being a
// first-match walk (that's still the only "current repo" signal the gateway
// has), but it must never be SILENTLY ambiguous -- so the workspace + session
// id the graph actually came from is returned alongside it for the caller to
// label.
export async function findDocGraph(): Promise<{ graph: DocGraph; source: DocGraphSource } | null> {
  const ids = await listSessionIds();
  for (const id of ids) {
    if (!isValidSessionId(id)) continue;
    let workspace: unknown;
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(sessionsDir(), id, "manifest.json"), "utf-8"),
      );
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
    if (isDocGraphShape(parsed)) return { graph: parsed, source: { workspace, sessionId: id } };
  }
  return null;
}

repositoryRouter.get("/repository/doc-graph", async (_req, res) => {
  try {
    const found = await findDocGraph();
    if (!found)
      return res.status(404).json({ error: "no docs/graph.json found in any session workspace" });
    res.json({ ...found.graph, source: found.source });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
