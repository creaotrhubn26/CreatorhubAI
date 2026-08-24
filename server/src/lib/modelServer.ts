import { spawn, execFile } from "node:child_process";
import { constants, openSync, closeSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ModelStatus } from "@glimmer/shared";
import { CONFIG } from "../config.js";

const exec = promisify(execFile);

// Process control for the local llama-server, driven by the same two scripts
// the user runs by hand today (start-glimmer.sh / stop-glimmer.sh). Both are
// fixed absolute paths from CONFIG, spawned as argv with no arguments and no
// shell: this is a localhost process-control surface, so nothing a client
// sends can influence what gets executed.
//
// Honesty rule for this whole module: spawning proves only that we spawned.
// Whether the model is up is decided by probeModel() against /health and
// nothing else — see describeRunState.

/// What we know about the process this gateway started, if any. Cleared on
/// stop, so "we started something that later exited" (FAILED) stays
/// distinguishable from "nothing is running" (OFFLINE).
type Spawned = { pid: number; startedAt: string; alive: boolean; exitCode: number | null };
let spawned: Spawned | null = null;

const logPath = () => path.join(CONFIG.stateRoot, "model-server.log");

async function readLogTail(maxChars = 2000): Promise<string | undefined> {
  try {
    const text = await fs.readFile(logPath(), "utf8");
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return undefined; // no log yet — absent, never invented
  }
}

async function executable(script: string): Promise<boolean> {
  try {
    await fs.access(script, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function startModelServer(): Promise<{ pid: number } | { error: string }> {
  const script = CONFIG.modelStartScript;
  if (!(await executable(script))) {
    return { error: `model start script not found or not executable: ${script}` };
  }
  await fs.mkdir(CONFIG.stateRoot, { recursive: true });

  // Log to a file descriptor rather than pipes, and detach: llama-server
  // outlives the gateway on purpose (loading the 30B GGUF takes 1-2 minutes,
  // and quitting the desktop app shouldn't throw that away). Piped stdio
  // would kill it with EPIPE the moment the gateway goes away.
  const fd = openSync(logPath(), "a");
  try {
    const child = spawn(script, [], { stdio: ["ignore", fd, fd], detached: true });
    const record: Spawned = { pid: child.pid ?? -1, startedAt: new Date().toISOString(), alive: true, exitCode: null };
    spawned = record;
    child.on("exit", (code) => {
      record.alive = false;
      record.exitCode = code;
    });
    // A failed exec (missing binary, bad interpreter) never fires "exit".
    child.on("error", () => {
      record.alive = false;
    });
    child.unref();
    return { pid: record.pid };
  } catch (err) {
    spawned = null;
    return { error: `failed to spawn ${script}: ${String(err)}` };
  } finally {
    closeSync(fd); // the child dup'd it
  }
}

export async function stopModelServer(): Promise<{ error?: string }> {
  const script = CONFIG.modelStopScript;
  if (!(await executable(script))) {
    return { error: `model stop script not found or not executable: ${script}` };
  }
  try {
    await exec(script, [], { timeout: 15_000 });
  } catch (err) {
    return { error: `stop script failed: ${String(err)}` };
  } finally {
    spawned = null;
  }
  return {};
}

/// Forget the process we started without running anything — used when there
/// is nothing left to stop, so a stale FAILED marker doesn't outlive the user
/// acknowledging it.
export function forgetSpawned(): void {
  spawned = null;
}

export async function describeRunState(
  probe: ModelStatus
): Promise<Pick<ModelStatus, "runState" | "exitCode" | "logTail">> {
  // /health answered 200 (or 401/403 — up, just auth-gated). Only this is ONLINE.
  if (probe.status === "ONLINE" || probe.status === "REACHABLE_AUTH") return { runState: "ONLINE" };
  // A non-ok HTTP status still means the port accepted the connection:
  // llama-server binds early and answers /health with 503 while it loads.
  if (probe.httpStatus !== undefined) return { runState: "LOADING" };
  // Port down from here on.
  if (spawned?.alive) return { runState: "STARTING" };
  if (spawned) return { runState: "FAILED", exitCode: spawned.exitCode, logTail: await readLogTail() };
  return { runState: "OFFLINE" };
}
