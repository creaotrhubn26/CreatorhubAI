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
//   * an out-of-boundary path is refused LEXICALLY, before the filesystem is
//     touched, so the 403/404 split can't be used to probe whether a path
//     outside the boundary exists (review MJ1)
//   * a small set of credential directories/files is never listed and never
//     navigable, by name, at any depth (review MJ2 / SENSITIVE_NAMES)
const MAX_FS_ENTRIES = 500;

// Review MJ2. The previous rule ("skip entries starting with .") was cosmetic:
// it filtered listings but not the requested path, so `?path=~/.ssh` happily
// enumerated key filenames — while at the same time making a legitimate
// dot-named workspace (e.g. .smoke-test-repo) unreachable in the picker. Both
// halves were wrong, so the rule is now explicit and enforced on the path and
// the entries through the same helper:
//   * ordinary dotfiles ARE listed and navigable — .github, .superpowers and a
//     dot-named repo are project content the picker exists to reach
//   * these names are not, at any depth, whether requested directly or met as
//     an entry: their whole purpose is credentials
// This is a denylist, so it is exposure reduction, not a boundary — a caller
// who can reach this endpoint at all can already spawn a session through
// POST /api/sessions. It removes the gratuitous "here are the user's key and
// profile names" answer, nothing more.
//
// The list is KNOWINGLY INCOMPLETE, and the known hole is worth naming rather
// than papering over: `~/.local/share` holds the same data by another route
// (aws-cli and claude both keep state there), so denying `.aws`/`.claude`
// while `.local` is listable is porous by construction. Extending the list
// until it looks complete would only make it look like a boundary. Treat it
// as noise reduction; the real boundary is FS_BOUNDARY plus the fact that
// this endpoint never returns file contents.
const SENSITIVE_NAMES = new Set([
  ".ssh", ".aws", ".gnupg", ".gpg", ".docker", ".kube",
  ".password-store", ".claude", ".claude.json", ".git-credentials", ".gitconfig",
  ".netrc", ".npmrc", ".pypirc", ".zsh_history",
  ".appstoreconnect", ".fastlane-creds", ".render", ".copilot",
]);

// `.config` is denied only as a FIRST segment (the XDG config home under
// $HOME). Denying it at any depth would also hide ordinary repository
// content named config/, which is the picker's whole job to reach.
const SENSITIVE_FIRST_SEGMENT = new Set([".config"]);

function isSensitive(name: string): boolean {
  return SENSITIVE_NAMES.has(name.toLowerCase());
}

// The outer boundary: nothing outside it is ever listed, and a caller-supplied
// `root` must itself be inside it. Read per-request (not frozen at module load
// like CONFIG) purely so tests can point it at a fixture tree; it is set by
// whoever launches the gateway — the same person the gateway already runs as.
function browseRoot(): string {
  return path.resolve(process.env.GLIMMER_BROWSE_ROOT ?? os.homedir());
}

function contains(root: string, target: string): boolean {
  // Review MN1: a root of "/" made this compare against "//" and refused
  // everything (fail-closed, but the knob was silently useless at its most
  // obvious setting).
  const base = root.endsWith(path.sep) ? root : root + path.sep;
  return target === root || target.startsWith(base);
}

// Review MJ2: true when any segment of `target` below `base` is a credential
// name — used for the requested path AND for each listed entry, so the rule
// cannot drift apart between the two the way the old dotfile filter did.
function hasSensitiveSegment(base: string, target: string): boolean {
  const segments = path.relative(base, target).split(path.sep);
  if (segments.some(isSensitive)) return true;
  // First-segment-only names (.config): denied directly under the boundary,
  // allowed deeper, where they are ordinary repository content.
  return SENSITIVE_FIRST_SEGMENT.has((segments[0] ?? "").toLowerCase());
}

workspacesRouter.get("/fs/dirs", async (req, res) => {
  const rawRoot = typeof req.query.root === "string" && req.query.root.trim() ? req.query.root.trim() : browseRoot();
  const rawPath = typeof req.query.path === "string" && req.query.path.trim() ? req.query.path.trim() : rawRoot;
  const includeFiles = req.query.includeFiles === "1";
  // Review MN3: a NUL is not a path at all — reject it as the client error it
  // is, before it can reach path.resolve or a syscall, and without echoing it.
  if (rawRoot.includes("\0") || rawPath.includes("\0")) {
    return res.status(400).json({ error: "path is not a valid filesystem path" });
  }

  let root: string;
  let dir: string;
  try {
    // The boundary is realpath()-resolved so both sides of every containment
    // check are expressed in the same terms.
    const boundary = await fs.realpath(browseRoot());

    // Review MJ1: contain LEXICALLY first, before the filesystem is touched.
    // realpath()-ing an arbitrary caller path first meant ENOENT (404) vs.
    // out-of-boundary (403) told the caller whether any path on the disk
    // existed. Everything outside the boundary must look identical whether it
    // exists or not, so it is refused here, without a syscall.
    const lexicalRoot = path.resolve(rawRoot);
    if (!contains(boundary, lexicalRoot)) {
      return res.status(403).json({ error: `root must be inside ${boundary}` });
    }
    const lexicalPath = path.resolve(rawPath);
    if (!contains(lexicalRoot, lexicalPath)) {
      return res.status(403).json({ error: `path is outside ${lexicalRoot}` });
    }
    if (hasSensitiveSegment(boundary, lexicalPath)) {
      return res.status(403).json({ error: "that directory is not browsable" });
    }

    // Now resolve, and re-check: a symlink inside the boundary that points out
    // of it only becomes visible here, and must not be enterable.
    root = await fs.realpath(lexicalRoot);
    if (!contains(boundary, root)) {
      return res.status(403).json({ error: `root must be inside ${boundary}` });
    }
    dir = await fs.realpath(lexicalPath);
    if (!contains(root, dir)) {
      return res.status(403).json({ error: `path is outside ${root}` });
    }
    if (hasSensitiveSegment(boundary, dir)) {
      return res.status(403).json({ error: "that directory is not browsable" });
    }
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return res.status(400).json({ error: "path is not a directory" });
  } catch (err: any) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "path does not exist" });
    if (err.code === "EACCES" || err.code === "EPERM") return res.status(403).json({ error: "permission denied" });
    // Review MN3: a null byte or an over-long path is a CLIENT error, and the
    // old 500 echoed the caller's own input back in the message.
    if (err.code === "ENAMETOOLONG" || err.code === "ERR_INVALID_ARG_VALUE") {
      return res.status(400).json({ error: "path is not a valid filesystem path" });
    }
    return res.status(500).json({ error: err.message });
  }

  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const named = dirents
      .filter((e) => !isSensitive(e.name)) // review MJ2: same rule as the path check above
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
