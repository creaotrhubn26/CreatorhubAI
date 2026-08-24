import { Router } from "express";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSessionIds, readSession } from "../lib/sessions.js";
import { gitStatus, createWorkspace, WorkspaceCreateError } from "../lib/git.js";
import type { WorkspaceInfo, FsListing } from "@glimmer/shared";

export const workspacesRouter = Router();

workspacesRouter.get("/workspaces", async (_req, res) => {
  try {
    const ids = await listSessionIds();
    // V7 §20: plain readSession(id) (computeStale left false) -- this reads
    // every session on the list, same reasoning as GET /sessions.
    const sessions = (await Promise.all(ids.map((id) => readSession(id)))).filter(Boolean) as NonNullable<
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

// Task 4c(2/3): read-only directory browser backing the composer's workspace
// and scope-path pickers in a plain browser (in the Tauri app the native
// Finder dialog is used instead — see web/src/state/pickPath.ts).
//
// SECURITY — this is the only filesystem-listing endpoint in the gateway and
// is deliberately the narrowest thing that works:
//   * names only, never file CONTENTS, never sizes/permissions
//   * no writes, no deletes, no process execution
//   * every path is realpath()-resolved and then re-checked for containment,
//     so a symlink pointing outside the root can be seen but never entered
//     (its listing request resolves outside the root and is refused)
//   * `root` itself must be inside the user's home directory: the scope
//     picker passes the chosen workspace as root, and no caller-supplied root
//     can widen the boundary beyond home
//   * results are capped (MAX_FS_ENTRIES) so a directory with 100k entries
//     can't be used to hang the gateway or the UI
//   * dotfiles are omitted (keeps .git/node_modules noise out; nothing here
//     is a permission boundary, just a smaller honest listing)
const MAX_FS_ENTRIES = 500;

// The outer boundary: nothing outside it is ever listed, and a caller-supplied
// `root` must itself be inside it. Read per-request (not frozen at module load
// like CONFIG) purely so tests can point it at a fixture tree; it is set by
// whoever launches the gateway — the same person the gateway already runs as.
function browseRoot(): string {
  return path.resolve(process.env.GLIMMER_BROWSE_ROOT ?? os.homedir());
}

function contains(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

workspacesRouter.get("/fs/dirs", async (req, res) => {
  const rawRoot = typeof req.query.root === "string" && req.query.root.trim() ? req.query.root.trim() : browseRoot();
  const rawPath = typeof req.query.path === "string" && req.query.path.trim() ? req.query.path.trim() : rawRoot;
  const includeFiles = req.query.includeFiles === "1";

  let root: string;
  let dir: string;
  try {
    // realpath BEFORE any containment check: "~/x/../../etc" and a symlink
    // into /etc both only become visible once resolved. The boundary itself is
    // resolved the same way so the two are compared in the same terms.
    const boundary = await fs.realpath(browseRoot());
    root = await fs.realpath(path.resolve(rawRoot));
    if (!contains(boundary, root)) {
      return res.status(403).json({ error: `root must be inside ${boundary}` });
    }
    dir = await fs.realpath(path.resolve(rawPath));
    if (!contains(root, dir)) {
      return res.status(403).json({ error: `path is outside ${root}` });
    }
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return res.status(400).json({ error: "path is not a directory" });
  } catch (err: any) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "path does not exist" });
    if (err.code === "EACCES" || err.code === "EPERM") return res.status(403).json({ error: "permission denied" });
    return res.status(500).json({ error: err.message });
  }

  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const named = dirents
      .filter((e) => !e.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));
    const entries: FsListing["entries"] = [];
    let truncated = false;
    for (const e of named) {
      if (entries.length >= MAX_FS_ENTRIES) {
        truncated = true; // honest: set only when entries were actually dropped
        break;
      }
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        // A symlink's target type is what the user is picking; a broken link
        // is skipped rather than shown as something it isn't.
        try {
          isDir = (await fs.stat(path.join(dir, e.name))).isDirectory();
        } catch {
          continue;
        }
      } else if (!isDir && !e.isFile()) {
        continue; // sockets/fifos/devices are not pickable paths
      }
      if (!isDir && !includeFiles) continue;
      entries.push({ name: e.name, isDir });
    }
    const parent = path.dirname(dir);
    const listing: FsListing = {
      root,
      path: dir,
      parent: dir !== root && contains(root, parent) ? parent : null,
      entries,
      truncated,
    };
    res.json(listing);
  } catch (err: any) {
    if (err.code === "EACCES" || err.code === "EPERM") return res.status(403).json({ error: "permission denied" });
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
