import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CONFIG } from "../config.js";

const execFileAsync = promisify(execFile);

/**
 * Read/curate the per-repository memory the orchestrator writes
 * (glimmer_memory.py, schemaVersion 2). This makes "what the agent takes
 * for granted about this project" a visible, USER-OWNED surface: entries
 * carry their age (stale knowledge fades), and deleting an entry is
 * first-class curation — a wrong assumption is removed here and only
 * re-earns its place through fresh verified observations.
 *
 * Path derivation mirrors glimmer_memory.repo_identity exactly:
 * <stateRoot>/memory/<repoName>-<sha256(gitCommonDir)[:16]>/memory-v2.json
 */

const HALF_LIFE_DAYS = 45;
const MIN_OBSERVATIONS = 2;

export interface WorkspaceMemoryEntry {
  kind: string;
  key: string;
  count: number;
  firstSeen?: string;
  lastSeen?: string;
  payload?: unknown;
  ageDays: number | null;
  score: number;
  /** Below the orchestrator's observation floor: recorded but not yet injected. */
  belowFloor: boolean;
}

async function memoryFileFor(workspace: string): Promise<string | null> {
  let commonDir: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspace, "rev-parse", "--git-common-dir"],
      { maxBuffer: 1024 * 1024 },
    );
    commonDir = path.resolve(workspace, stdout.trim());
  } catch {
    return null;
  }
  const digest = createHash("sha256").update(commonDir).digest("hex").slice(0, 16);
  const name =
    path.basename(commonDir) === ".git"
      ? path.basename(path.dirname(commonDir))
      : path.basename(commonDir);
  return path.join(CONFIG.stateRoot, "memory", `${name}-${digest}`, "memory-v2.json");
}

export async function readWorkspaceMemory(workspace: string): Promise<WorkspaceMemoryEntry[]> {
  const file = await memoryFileFor(workspace);
  if (!file) return [];
  let data: any;
  try {
    data = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return [];
  }
  if (data?.schemaVersion !== 2 || !Array.isArray(data.entries)) return [];
  const now = Date.now();
  return data.entries
    .filter((entry: any) => entry && typeof entry === "object" && typeof entry.key === "string")
    .map((entry: any): WorkspaceMemoryEntry => {
      const lastSeenMs = Date.parse(String(entry.lastSeen ?? ""));
      const ageDays = Number.isFinite(lastSeenMs)
        ? Math.max(0, (now - lastSeenMs) / 86_400_000)
        : null;
      const count = Math.max(0, Number(entry.count) || 0);
      const score = ageDays === null ? 0 : count * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
      return {
        kind: String(entry.kind ?? "unknown"),
        key: entry.key,
        count,
        firstSeen: entry.firstSeen,
        lastSeen: entry.lastSeen,
        payload: entry.payload,
        ageDays: ageDays === null ? null : Number(ageDays.toFixed(1)),
        score: Number(score.toFixed(4)),
        belowFloor: count < MIN_OBSERVATIONS,
      };
    })
    .sort(
      (left: WorkspaceMemoryEntry, right: WorkspaceMemoryEntry) =>
        right.score - left.score || left.key.localeCompare(right.key),
    );
}

export async function deleteWorkspaceMemoryEntry(
  workspace: string,
  kind: string,
  key: string,
): Promise<boolean> {
  const file = await memoryFileFor(workspace);
  if (!file) return false;
  let data: any;
  try {
    data = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return false;
  }
  if (data?.schemaVersion !== 2 || !Array.isArray(data.entries)) return false;
  const before = data.entries.length;
  data.entries = data.entries.filter((entry: any) => !(entry?.kind === kind && entry?.key === key));
  if (data.entries.length === before) return false;
  data.updatedAt = new Date().toISOString();
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporary, file);
  return true;
}
