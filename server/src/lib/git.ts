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

export async function gitDiff(workspace: string, paths: string[] = []): Promise<string> {
  return git(workspace, ["diff", "--no-color", "--", ...paths]);
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
