import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ChangedFile, CreateWorkspaceResult } from "@glimmer/shared";
import { CONFIG } from "../config.js";

const exec = promisify(execFile);

// Every git invocation in this module goes through argv-array execFile —
// never a shell string — so no argument (including anything derived from
// user input, e.g. the workspace-creation slug) can be interpreted as shell
// syntax. `timeoutMs` lets callers bound a call that touches the network
// (git fetch) without affecting the many callers that don't need it.
async function git(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    timeout: opts.timeoutMs,
  });
  return stdout;
}

const STATUS_CODE_MAP: Record<string, ChangedFile["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
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
    const { stdout } = await exec(
      "git",
      ["diff", "--no-color", "--no-index", "--", "/dev/null", filePath],
      {
        cwd,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
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
    if (await isUntracked(workspace, p)) untracked.push(p);
    else tracked.push(p);
  }

  const parts: string[] = [];
  if (tracked.length > 0)
    parts.push(await git(workspace, ["diff", "--no-color", "--", ...tracked]));
  for (const p of untracked) parts.push(await gitDiffUntrackedFile(workspace, p));
  return parts.filter(Boolean).join("");
}

export interface ParsedGitDiffHunk {
  id: string;
  path: string;
  header: string;
  added: number;
  removed: number;
  patch: string;
}

function diffPath(fileHeader: string[]): string | null {
  for (const line of fileHeader) {
    if (!line.startsWith("+++ ")) continue;
    const value = line.slice(4).trim();
    if (value !== "/dev/null") return value.replace(/^b\//, "");
  }
  for (const line of fileHeader) {
    if (!line.startsWith("--- ")) continue;
    const value = line.slice(4).trim();
    if (value !== "/dev/null") return value.replace(/^a\//, "");
  }
  return null;
}

function hunkId(filePath: string, hunkLines: string[]): string {
  // oldStart is anchored in the baseline side of the diff, so rejecting an
  // earlier hunk does not renumber a later accepted hunk. The body makes two
  // changes at the same baseline position distinct.
  const oldStart = hunkLines[0]?.match(/^@@ -(\d+)/)?.[1] ?? "unknown";
  return createHash("sha256")
    .update(filePath)
    .update("\0")
    .update(oldStart)
    .update("\0")
    .update(hunkLines.slice(1).join("\n"))
    .digest("hex");
}

/** Split a canonical git diff into independently reviewable text hunks. */
export function parseGitDiffHunks(diff: string): ParsedGitDiffHunk[] {
  if (!diff) return [];
  const lines = diff.replace(/\n$/, "").split("\n");
  const hunks: ParsedGitDiffHunk[] = [];
  let fileHeader: string[] = [];
  let hunkLines: string[] | null = null;

  function flushHunk() {
    if (!hunkLines) return;
    const filePath = diffPath(fileHeader);
    if (filePath && hunkLines[0]?.startsWith("@@ ")) {
      const body = hunkLines.slice(1);
      hunks.push({
        id: hunkId(filePath, hunkLines),
        path: filePath,
        header: hunkLines[0],
        added: body.filter((line) => line.startsWith("+")).length,
        removed: body.filter((line) => line.startsWith("-")).length,
        patch: [...fileHeader, ...hunkLines].join("\n") + "\n",
      });
    }
    hunkLines = null;
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushHunk();
      fileHeader = [line];
      continue;
    }
    if (line.startsWith("@@ ")) {
      flushHunk();
      hunkLines = [line];
      continue;
    }
    if (hunkLines) hunkLines.push(line);
    else if (fileHeader.length) fileHeader.push(line);
  }
  flushHunk();
  return hunks;
}

export class GitHunkReviewError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 409,
  ) {
    super(message);
  }
}

/** Reverse exactly one hunk from the server's current diff, never client patch text. */
export async function gitRejectHunk(
  workspace: string,
  allowedPaths: string[],
  targetPath: string,
  targetHunkId: string,
): Promise<ParsedGitDiffHunk> {
  if (!allowedPaths.includes(targetPath)) {
    throw new GitHunkReviewError(
      `Refusing to reject a hunk in ${targetPath}: not in this session's changed files`,
      403,
    );
  }
  const resolved = path.resolve(workspace, targetPath);
  if (!resolved.startsWith(path.resolve(workspace) + path.sep)) {
    throw new GitHunkReviewError(
      `Refusing to reject a hunk in ${targetPath}: resolves outside workspace`,
      403,
    );
  }

  const currentDiff = await gitDiff(workspace, [targetPath]);
  const hunk = parseGitDiffHunks(currentDiff).find(
    (candidate) => candidate.path === targetPath && candidate.id === targetHunkId,
  );
  if (!hunk) {
    throw new GitHunkReviewError(
      "This hunk is no longer present in the current diff; refresh and review again",
      409,
    );
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-hunk-review-"));
  const patchFile = path.join(tempDir, `${randomUUID()}.patch`);
  try {
    await fs.writeFile(patchFile, hunk.patch, { encoding: "utf8", mode: 0o600 });
    try {
      await git(workspace, [
        "apply",
        "--reverse",
        "--recount",
        "--whitespace=nowarn",
        "--check",
        patchFile,
      ]);
      await git(workspace, ["apply", "--reverse", "--recount", "--whitespace=nowarn", patchFile]);
    } catch {
      throw new GitHunkReviewError(
        "This hunk no longer applies cleanly; refresh and review again",
        409,
      );
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  return hunk;
}

// V7 §20 session-level verification freeze — CROSS-LANGUAGE CONTRACT, must
// match glimmer-v2.py's diff_hash(ws, baseline) (glimmer-v2.py, ~line 471)
// byte-for-byte, or stale detection silently breaks. Both sides hash, in
// order:
//   1. the raw stdout of `git diff --binary <baseline> --` (run in workspace)
//   2. for each path from `git ls-files --others --exclude-standard`, in
//      THAT command's own output order: utf8(path) + 0x00 + the file's raw
//      bytes (empty if it can't be read) + 0x00
// Why this is safe despite glimmer-v2.py routing step 1 through a
// text-mode subprocess (decode UTF-8, then re-`.encode()` before hashing):
// that round-trip is lossless for valid UTF-8, which `git diff --binary`
// always produces (binary hunks are base85-encoded, i.e. plain ASCII) —
// capturing raw bytes here reproduces the identical input Python actually
// hashes, without needing to replicate the round-trip.
async function gitDiffHashInput(
  workspace: string,
  baseline: string,
  opts: { timeoutMs?: number },
): Promise<{ diff: Buffer; others: string[] }> {
  const [{ stdout: diff }, othersRaw] = await Promise.all([
    exec("git", ["diff", "--binary", baseline, "--"], {
      cwd: workspace,
      maxBuffer: 20 * 1024 * 1024,
      timeout: opts.timeoutMs,
      encoding: "buffer",
    }),
    git(workspace, ["ls-files", "--others", "--exclude-standard"], opts),
  ]);
  // Mirrors glimmer-v2.py's lines(): split on any newline, drop blank lines.
  const others = othersRaw.split(/\r\n|\r|\n/).filter((l) => l.trim());
  return { diff: diff as unknown as Buffer, others };
}

export async function computeDiffHash(
  workspace: string,
  baseline: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const { diff, others } = await gitDiffHashInput(workspace, baseline, opts);
  const hash = createHash("sha256");
  hash.update(diff);
  for (const rel of others) {
    hash.update(Buffer.from(rel, "utf-8"));
    hash.update(Buffer.from([0]));
    try {
      hash.update(await fs.readFile(path.join(workspace, rel)));
    } catch {
      // Matches diff_hash's `except OSError: pass` -- file vanished/
      // unreadable between ls-files and the read; contributes no content,
      // still gets the trailing NUL below.
    }
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

export async function gitRevertFile(
  workspace: string,
  allowedPaths: string[],
  targetPath: string,
  baselineSha: string,
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
// `worktree add` is a local filesystem op, not network — but it runs while
// holding the global inFlight lock, so a hang here (stale lock file, wedged
// filesystem) would 409 every other caller forever. Bound it too.
const WORKTREE_ADD_TIMEOUT_MS = 60_000;
// "invalid reference" can also come from a bad CONFIG.worktreeBase (a
// commit-ish that doesn't resolve), not just a taskName-derived branch name.
// That's unreachable today only because `rev-parse CONFIG.worktreeBase`
// (below, under the same inFlight lock) already validates the base and
// throws first -- if that ordering ever changes, this regex would
// misattribute a bad-base failure to the taskName as a 400.
const REF_NAME_REJECTION = /not a valid (branch|ref) name|invalid reference/i;

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
  slug = slug
    .replace(/\.{2,}/g, "-")
    .replace(/^\.+/, "")
    .replace(/^-+|-+$/g, "");
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

// Free local invariant, kept as its own pure function so it's directly
// testable without having to route an adversarial value through
// sanitizeTaskSlug first (which, by construction, never produces a slug that
// could actually trip this — no "/" survives it — making the check itself
// otherwise dead code from createWorkspace's one real caller).
export function resolvesWithinRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root) + path.sep;
  return path.resolve(candidate).startsWith(resolvedRoot);
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
// source repo; move to a per-repo lock map if that ever changes. Also
// unbounded in principle if a git call under it hangs — every git call in
// this flow now carries a timeoutMs (fetch: FETCH_TIMEOUT_MS, worktree add:
// WORKTREE_ADD_TIMEOUT_MS) specifically so this lock can't wedge forever.
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
      500,
    );
  }

  try {
    await git(sourceRepo, ["fetch", "origin", "--prune"], { timeoutMs: FETCH_TIMEOUT_MS });
  } catch (err: any) {
    // Raw git stderr here can contain the origin remote URL — never put that
    // in the HTTP response. Log the real detail server-side, return a fixed
    // message.
    console.error("[workspace-create] git fetch origin failed:", err);
    const reason = err.killed ? `timed out after ${FETCH_TIMEOUT_MS}ms` : "see server logs";
    throw new WorkspaceCreateError(`git fetch origin failed (${reason})`, 502);
  }

  const baselineSha = (await git(sourceRepo, ["rev-parse", CONFIG.worktreeBase])).trim();

  const stamp = timestamp();
  const branch = `glimmer/${slug}-${stamp}`;
  const workspace = path.join(CONFIG.worktreeRoot, `glimmer-${slug}-${stamp}`);

  // Guards CONFIG.worktreeRoot (server config), not taskName — the slug's
  // closed charset already forbids "/", so nothing user-supplied can trip
  // this. A trip here means worktreeRoot itself is misconfigured -> 500,
  // not 400.
  if (!resolvesWithinRoot(CONFIG.worktreeRoot, workspace)) {
    throw new WorkspaceCreateError(
      `refusing to create a worktree outside worktreeRoot: ${workspace}`,
      500,
    );
  }

  if (await refExists(sourceRepo, `refs/heads/${branch}`)) {
    throw new WorkspaceCreateError(`branch already exists: ${branch}`, 409);
  }
  if (await pathExists(workspace)) {
    throw new WorkspaceCreateError(`worktree path already exists: ${workspace}`, 409);
  }

  try {
    await git(
      sourceRepo,
      ["worktree", "add", "--no-track", "-b", branch, workspace, CONFIG.worktreeBase],
      { timeoutMs: WORKTREE_ADD_TIMEOUT_MS },
    );
  } catch (err: any) {
    // Nothing was actually created if this call itself failed (git rejects
    // invalid refs/paths before creating anything) — so there's no partial
    // state to report. Only downgrade to 400 (the taskName's fault) when git
    // itself says the ref/branch name was rejected. Everything else — a
    // colliding "glimmer" branch causing a D/F ref conflict under
    // refs/heads/glimmer/*, an unwritable worktreeRoot, a stale lock, a full
    // disk — is a server-side condition, not a bad taskName, and blanket-
    // mapping it to 400 previously sent the user into an infinite rename
    // loop trying to "fix" an input that was never the problem.
    const detail = String(err.stderr ?? err.message ?? "");
    if (REF_NAME_REJECTION.test(detail)) {
      throw new WorkspaceCreateError(
        `could not create branch/worktree for taskName: ${err.message}`,
        400,
      );
    }
    console.error("[workspace-create] git worktree add failed:", err);
    throw new WorkspaceCreateError(
      "failed to create the worktree (server-side git error, see server logs)",
      500,
    );
  }

  // From here on the worktree and branch are real. A failure past this point
  // must never trigger a delete/rollback — report it honestly, naming the
  // created path/branch, and let a human clean up.
  try {
    const headSha = (await git(workspace, ["rev-parse", "HEAD"])).trim();
    const currentBranch = (await git(workspace, ["branch", "--show-current"])).trim();
    const status = await git(workspace, ["status", "--porcelain"]);
    // Reference script's fourth check: `--no-track` should mean no upstream
    // got configured, but branch.autoSetupMerge can still wire one up behind
    // it — verify the negative instead of assuming --no-track was enough.
    const upstream = await git(workspace, ["rev-parse", "--abbrev-ref", "@{upstream}"])
      .then((s) => s.trim())
      .catch(() => "");

    if (headSha !== baselineSha) {
      throw new Error(
        `HEAD (${headSha}) does not match fetched ${CONFIG.worktreeBase} (${baselineSha})`,
      );
    }
    if (currentBranch !== branch) {
      throw new Error(`worktree is on branch "${currentBranch}", expected "${branch}"`);
    }
    if (status.trim() !== "") {
      throw new Error(`new worktree is unexpectedly dirty:\n${status}`);
    }
    if (upstream) {
      throw new Error(`worktree unexpectedly has an upstream configured: ${upstream}`);
    }
  } catch (err: any) {
    throw new WorkspaceCreateError(
      `workspace and branch were created but failed post-create verification: ${err.message}`,
      500,
      { workspace, branch },
    );
  }

  return { workspace, branch, baselineSha };
}
