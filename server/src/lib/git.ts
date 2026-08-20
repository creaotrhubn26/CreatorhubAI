import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChangedFile, CreateWorkspaceResult } from "@glimmer/shared";
import { CONFIG } from "../config.js";

const exec = promisify(execFile);

// Every git invocation in this module goes through argv-array execFile —
// never a shell string — so no argument (including anything derived from
// user input, e.g. the workspace-creation slug) can be interpreted as shell
// syntax. `timeoutMs` lets callers bound a call that touches the network
// (git fetch) without affecting the many callers that don't need it.
async function git(cwd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    timeout: opts.timeoutMs,
  });
  return stdout;
}

const STATUS_CODE_MAP: Record<string, ChangedFile["status"]> = {
  A: "added", M: "modified", D: "deleted", R: "renamed",
};

export async function gitStatus(workspace: string) {
  const [branch, headSha, porcelain] = await Promise.all([
    git(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim()),
    git(workspace, ["rev-parse", "HEAD"]).then((s) => s.trim()),
    git(workspace, ["status", "--porcelain"]),
  ]);
  const changedFiles: ChangedFile[] = porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2).trim().replace("?", "A").charAt(0);
      const filePath = line.slice(3).trim();
      return { path: filePath, status: STATUS_CODE_MAP[code] ?? "modified" };
    });
  return { branch, headSha, baselineSha: null, dirty: changedFiles.length > 0, changedFiles };
}

async function isUntracked(cwd: string, filePath: string): Promise<boolean> {
  const out = await git(cwd, ["status", "--porcelain", "--", filePath]);
  return out.split("\n").some((line) => line.startsWith("??"));
}

// `git diff` has nothing to compare a brand-new file against (it only diffs
// tracked content vs. the index/HEAD), so it silently renders nothing for
// untracked paths. Diff against /dev/null with --no-index instead, which
// renders the whole file as an addition-only patch. --no-index exits 1 when
// there ARE differences (the normal case here), which execFile treats as a
// rejection — the diff text is still on the error's stdout, so recover it.
async function gitDiffUntrackedFile(cwd: string, filePath: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["diff", "--no-color", "--no-index", "--", "/dev/null", filePath], {
      cwd, maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    if (typeof err.stdout === "string" && err.code === 1) return err.stdout;
    throw err;
  }
}

export async function gitDiff(workspace: string, paths: string[] = []): Promise<string> {
  if (paths.length === 0) return git(workspace, ["diff", "--no-color", "--"]);

  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const p of paths) {
    if (await isUntracked(workspace, p)) untracked.push(p); else tracked.push(p);
  }

  const parts: string[] = [];
  if (tracked.length > 0) parts.push(await git(workspace, ["diff", "--no-color", "--", ...tracked]));
  for (const p of untracked) parts.push(await gitDiffUntrackedFile(workspace, p));
  return parts.filter(Boolean).join("");
}

export async function gitRevertFile(
  workspace: string,
  allowedPaths: string[],
  targetPath: string,
  baselineSha: string
): Promise<void> {
  if (!allowedPaths.includes(targetPath)) {
    throw new Error(`Refusing to revert ${targetPath}: not in this session's changed files`);
  }
  const resolved = path.resolve(workspace, targetPath);
  const resolvedWorkspace = path.resolve(workspace) + path.sep;
  if (!resolved.startsWith(resolvedWorkspace)) {
    throw new Error(`Refusing to revert ${targetPath}: resolves outside workspace`);
  }
  if (!baselineSha) {
    throw new Error(`Refusing to revert ${targetPath}: session has no recorded baseline commit`);
  }
  // F4: restore from the session's actual starting commit, not the index/HEAD.
  // A dirty workspace (uncommitted edits present in OTHER files before the
  // session ever started) is not rejected at session creation — `checkout --`
  // would restore this file from HEAD, which is correct only by coincidence,
  // and touches nothing else, so unrelated pre-session-dirty edits to other
  // files are preserved either way. Using baselineSha instead of HEAD matters
  // when HEAD has moved since the session started (e.g. other commits landed
  // meanwhile) — this restores exactly what the session actually started from.
  // Residual limitation (not fixed here, needs a pre-session snapshot this
  // codebase doesn't take): if THIS file itself was already dirty at baseline,
  // those pre-session edits are still lost — baselineSha only has committed
  // content, not whatever was uncommitted in the workspace at session start.
  await git(workspace, ["checkout", baselineSha, "--", targetPath]);
}

// ---------------------------------------------------------------------------
// §27/§4.1 workspace creation — the first HTTP-triggered git-WRITE path
// against the real source repo. Mirrors new-glimmer-task.sh exactly: fetch,
// branch off the fetched SHA, `worktree add`, then verify the result before
// trusting it. Never deletes, force-pushes, or touches an existing
// worktree/branch.
// ---------------------------------------------------------------------------

const SLUG_MAX_LEN = 40;
const FETCH_TIMEOUT_MS = 120_000;

// The slug is the ONLY fragment of this flow derived from user input, and it
// feeds a branch name, a directory name, and (indirectly) git argv — so its
// charset must be closed, not blocklisted. Same algorithm as
// new-glimmer-task.sh's SLUG derivation (lowercase, collapse anything outside
// [a-z0-9._-] to a single "-", trim leading/trailing "-"), plus a length cap
// the shell script doesn't need (there's no untrusted caller there).
export function sanitizeTaskSlug(raw: string): string {
  let slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // The closed charset above still lets literal "." through on purpose
  // (real task names like "v1.2-fix" want that) — but git's ref-name rules
  // separately forbid two consecutive dots anywhere in a component, and
  // forbid a component starting with a dot (e.g. "../evil" sanitizes to
  // "..-evil" by charset alone, which `git worktree add` then rejects as an
  // invalid ref, an unhandled failure rather than a clean 400). Strip both
  // shapes explicitly instead of relying on git to reject them for us.
  slug = slug.replace(/\.{2,}/g, "-").replace(/^\.+/, "").replace(/^-+|-+$/g, "");
  // Slicing can leave a trailing "-" at the cut point; trim again.
  return slug.slice(0, SLUG_MAX_LEN).replace(/^-+|-+$/g, "");
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export class WorkspaceCreateError extends Error {
  status: number;
  // Set only once `git worktree add` has actually run: the workspace/branch
  // exist for real at that point, so the caller must be told about them even
  // though the overall call is failing. Never auto-cleaned-up (never-delete).
  partial?: { workspace: string; branch: string };
  constructor(message: string, status: number, partial?: { workspace: string; branch: string }) {
    super(message);
    this.status = status;
    this.partial = partial;
  }
}

// Module-level in-flight lock: two concurrent POSTs must never interleave git
// commands against the one real source repo. The check-then-set below is
// safe without a mutex library because it's synchronous (no `await` between
// the check and the assignment), so Node's single-threaded event loop can't
// interleave two callers through it.
// ponytail: process-wide global lock, not per-repo — fine while there's one
// source repo; move to a per-repo lock map if that ever changes.
let inFlight = false;

export async function createWorkspace(taskName: string): Promise<CreateWorkspaceResult> {
  const slug = sanitizeTaskSlug(taskName);
  if (!slug) {
    throw new WorkspaceCreateError("taskName sanitizes to an empty slug", 400);
  }
  if (inFlight) {
    throw new WorkspaceCreateError("a workspace creation is already in progress", 409);
  }
  inFlight = true;
  try {
    return await doCreateWorkspace(slug);
  } finally {
    inFlight = false;
  }
}

async function doCreateWorkspace(slug: string): Promise<CreateWorkspaceResult> {
  const sourceRepo = CONFIG.sourceRepo;

  try {
    await git(sourceRepo, ["rev-parse", "--git-dir"]);
  } catch {
    throw new WorkspaceCreateError(
      `GLIMMER_SOURCE_REPO (${sourceRepo}) does not exist or is not a git repository`,
      500
    );
  }

  try {
    await git(sourceRepo, ["fetch", "origin", "--prune"], { timeoutMs: FETCH_TIMEOUT_MS });
  } catch (err: any) {
    const reason = err.killed ? `timed out after ${FETCH_TIMEOUT_MS}ms` : err.message;
    throw new WorkspaceCreateError(`git fetch origin failed: ${reason}`, 502);
  }

  const baselineSha = (await git(sourceRepo, ["rev-parse", CONFIG.worktreeBase])).trim();

  const stamp = timestamp();
  const branch = `glimmer/${slug}-${stamp}`;
  const workspace = path.join(CONFIG.worktreeRoot, `glimmer-${slug}-${stamp}`);

  if (await refExists(sourceRepo, `refs/heads/${branch}`)) {
    throw new WorkspaceCreateError(`branch already exists: ${branch}`, 409);
  }
  if (await pathExists(workspace)) {
    throw new WorkspaceCreateError(`worktree path already exists: ${workspace}`, 409);
  }

  try {
    await git(sourceRepo, ["worktree", "add", "--no-track", "-b", branch, workspace, CONFIG.worktreeBase]);
  } catch (err: any) {
    // Nothing was actually created if this call itself failed (git rejects
    // invalid refs/paths before creating anything) — so there's no partial
    // state to report. Most likely cause is a taskName-derived branch/path
    // git itself refuses (e.g. a still-unanticipated git ref-name rule); a
    // safety net so that failure mode is a clean 400, not a raw crash.
    throw new WorkspaceCreateError(`could not create branch/worktree for taskName: ${err.message}`, 400);
  }

  // From here on the worktree and branch are real. A failure past this point
  // must never trigger a delete/rollback — report it honestly, naming the
  // created path/branch, and let a human clean up.
  try {
    const headSha = (await git(workspace, ["rev-parse", "HEAD"])).trim();
    const currentBranch = (await git(workspace, ["branch", "--show-current"])).trim();
    const status = await git(workspace, ["status", "--porcelain"]);

    if (headSha !== baselineSha) {
      throw new Error(`HEAD (${headSha}) does not match fetched ${CONFIG.worktreeBase} (${baselineSha})`);
    }
    if (currentBranch !== branch) {
      throw new Error(`worktree is on branch "${currentBranch}", expected "${branch}"`);
    }
    if (status.trim() !== "") {
      throw new Error(`new worktree is unexpectedly dirty:\n${status}`);
    }
  } catch (err: any) {
    throw new WorkspaceCreateError(
      `workspace and branch were created but failed post-create verification: ${err.message}`,
      500,
      { workspace, branch }
    );
  }

  return { workspace, branch, baselineSha };
}
