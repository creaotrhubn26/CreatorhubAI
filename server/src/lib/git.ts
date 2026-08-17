import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { ChangedFile } from "@glimmer/shared";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 });
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
  targetPath: string
): Promise<void> {
  if (!allowedPaths.includes(targetPath)) {
    throw new Error(`Refusing to revert ${targetPath}: not in this session's changed files`);
  }
  const resolved = path.resolve(workspace, targetPath);
  const resolvedWorkspace = path.resolve(workspace) + path.sep;
  if (!resolved.startsWith(resolvedWorkspace)) {
    throw new Error(`Refusing to revert ${targetPath}: resolves outside workspace`);
  }
  await git(workspace, ["checkout", "--", targetPath]);
}
