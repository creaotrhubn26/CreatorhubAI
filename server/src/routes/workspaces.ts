import { Router } from "express";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSessionIds, readSession } from "../lib/sessions.js";
import { gitStatus, createWorkspace, WorkspaceCreateError } from "../lib/git.js";
import type { WorkspaceInfo, FsListing, FsFile } from "@glimmer/shared";

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

// Every filesystem-error-to-status mapping lives here so the listing and the
// file-content route cannot drift apart on what a missing/denied path looks
// like. Review MN3: a null byte or an over-long path is a CLIENT error, and
// the old 500 echoed the caller's own input back in the message.
function fsErrorStatus(err: any): { status: number; error: string } {
  if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return { status: 404, error: "path does not exist" };
  if (err?.code === "EACCES" || err?.code === "EPERM") return { status: 403, error: "permission denied" };
  if (err?.code === "ENAMETOOLONG" || err?.code === "ERR_INVALID_ARG_VALUE") {
    return { status: 400, error: "path is not a valid filesystem path" };
  }
  if (err?.code === "ELOOP") return { status: 400, error: "path is not a valid filesystem path" };
  return { status: 500, error: String(err?.message ?? err) };
}

type Resolved =
  | { ok: true; boundary: string; root: string; target: string }
  | { ok: false; status: number; error: string };

// THE containment check — one implementation, shared by `/fs/dirs` and
// `/fs/file`. Two copies of this logic drifting apart is precisely the bug
// class the reviews here keep finding, so neither route re-derives any of it.
// Order matters and is load-bearing:
//   1. NUL rejected before path.resolve or any syscall
//   2. LEXICAL containment before the filesystem is touched (review MJ1), so
//      the 403/404 split can't be used to probe whether an out-of-boundary
//      path exists
//   3. realpath, then containment re-checked — a symlink inside the boundary
//      pointing out of it is visible but never followed
//   4. the credential-name rule applied to the requested path (entries are
//      filtered by the same isSensitive() at listing time)
async function resolveContained(rawRoot: string, rawPath: string): Promise<Resolved> {
  if (rawRoot.includes("\0") || rawPath.includes("\0")) {
    return { ok: false, status: 400, error: "path is not a valid filesystem path" };
  }
  try {
    // The boundary is realpath()-resolved so both sides of every containment
    // check are expressed in the same terms.
    const boundary = await fs.realpath(browseRoot());

    const lexicalRoot = path.resolve(rawRoot);
    if (!contains(boundary, lexicalRoot)) {
      return { ok: false, status: 403, error: `root must be inside ${boundary}` };
    }
    const lexicalPath = path.resolve(rawPath);
    if (!contains(lexicalRoot, lexicalPath)) {
      return { ok: false, status: 403, error: `path is outside ${lexicalRoot}` };
    }
    if (hasSensitiveSegment(boundary, lexicalPath)) {
      return { ok: false, status: 403, error: "that path is not browsable" };
    }

    // Now resolve, and re-check: a symlink inside the boundary that points out
    // of it only becomes visible here, and must not be enterable.
    const root = await fs.realpath(lexicalRoot);
    if (!contains(boundary, root)) {
      return { ok: false, status: 403, error: `root must be inside ${boundary}` };
    }
    const target = await fs.realpath(lexicalPath);
    if (!contains(root, target)) {
      return { ok: false, status: 403, error: `path is outside ${root}` };
    }
    if (hasSensitiveSegment(boundary, target)) {
      return { ok: false, status: 403, error: "that path is not browsable" };
    }
    return { ok: true, boundary, root, target };
  } catch (err: any) {
    return { ok: false, ...fsErrorStatus(err) };
  }
}

workspacesRouter.get("/fs/dirs", async (req, res) => {
  const rawRoot = typeof req.query.root === "string" && req.query.root.trim() ? req.query.root.trim() : browseRoot();
  const rawPath = typeof req.query.path === "string" && req.query.path.trim() ? req.query.path.trim() : rawRoot;
  const includeFiles = req.query.includeFiles === "1";

  const resolved = await resolveContained(rawRoot, rawPath);
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
  const { root, target: dir } = resolved;

  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return res.status(400).json({ error: "path is not a directory" });
  } catch (err: any) {
    const mapped = fsErrorStatus(err);
    return res.status(mapped.status).json({ error: mapped.error });
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

// Round A / Task A1: read ONE file's text for the read-only code viewer.
// Same containment as /fs/dirs — literally the same resolveContained() — plus
// three refusals of its own, all of which report what actually happened:
//   * a hard byte ceiling: `size` is always the real on-disk size and
//     `truncated` is set only when bytes past the ceiling exist, so a capped
//     file can never be mistaken for a whole one
//   * binary content (NUL sniff) is refused, not decoded: `content` is null,
//     never "" — an empty string would be indistinguishable from an empty file
//   * anything that is not a regular file (directory, fifo, socket, device)
//     is refused BEFORE it is opened, since open(2) on a fifo blocks until a
//     writer appears and would hang the gateway
const MAX_FILE_BYTES = 512 * 1024;
// git's own heuristic: NUL anywhere in the first 8000 bytes means binary.
const BINARY_SNIFF_BYTES = 8000;

workspacesRouter.get("/fs/file", async (req, res) => {
  const rawPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
  if (!rawPath) return res.status(400).json({ error: "path is required" });
  const rawRoot = typeof req.query.root === "string" && req.query.root.trim() ? req.query.root.trim() : browseRoot();

  const resolved = await resolveContained(rawRoot, rawPath);
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
  const file = resolved.target;

  try {
    const stat = await fs.stat(file);
    if (stat.isDirectory()) return res.status(400).json({ error: "path is a directory" });
    if (!stat.isFile()) return res.status(400).json({ error: "path is not a regular file" });

    const fh = await fs.open(file, "r");
    let read: Buffer;
    try {
      const buf = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES));
      const { bytesRead } = buf.length > 0 ? await fh.read(buf, 0, buf.length, 0) : { bytesRead: 0 };
      read = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }

    if (read.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      // Nothing was returned, so nothing was truncated — `binary` is the whole
      // story and the viewer renders a notice, never bytes.
      const answer: FsFile = { path: file, size: stat.size, bytesReturned: 0, truncated: false, binary: true, content: null };
      return res.json(answer);
    }

    const truncated = stat.size > MAX_FILE_BYTES;
    let slice = read;
    if (truncated) {
      // Cut back to the last complete line: a newline is a byte boundary in
      // UTF-8, so this also guarantees the cut never lands mid-character.
      // ponytail: a file whose first 512 KiB contain no newline at all (a
      // minified bundle on one line) falls through to the raw cut and may end
      // in one U+FFFD — visible, honest, and not worth a decoder for.
      const nl = read.lastIndexOf(0x0a);
      if (nl !== -1) slice = read.subarray(0, nl + 1);
    }
    const answer: FsFile = {
      path: file,
      size: stat.size,
      bytesReturned: slice.length,
      truncated,
      binary: false,
      content: slice.toString("utf8"),
    };
    res.json(answer);
  } catch (err: any) {
    const mapped = fsErrorStatus(err);
    res.status(mapped.status).json({ error: mapped.error });
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
