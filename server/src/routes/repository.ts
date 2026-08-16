import { Router } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionsDir } from "../config";
import { listSessionIds, isValidSessionId } from "../lib/sessions";
import type { RepoMap } from "@glimmer/shared";

export const repositoryRouter = Router();

repositoryRouter.get("/repository/map", async (_req, res) => {
  try {
    const ids = await listSessionIds();
    for (const id of ids) {
      if (!isValidSessionId(id)) continue;
      const mapPath = path.join(sessionsDir(), id, "repo-map.json");
      try {
        const raw = await fs.readFile(mapPath, "utf-8");
        return res.json(JSON.parse(raw) as RepoMap);
      } catch (err: any) {
        if (err.code !== "ENOENT") throw err;
      }
    }
    res.status(404).json({ error: "no repo-map.json found in any session" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
