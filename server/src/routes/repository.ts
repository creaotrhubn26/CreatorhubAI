import { Router } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionsDir } from "../config.js";
import { listSessionIds, isValidSessionId } from "../lib/sessions.js";
import type { RepoMap } from "@glimmer/shared";

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
