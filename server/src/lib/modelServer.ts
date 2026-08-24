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

// Read only the tail off the end of the file. The log is opened "a" and never
// rotated — it accumulates every llama-server run — and the status route polls
// this every few seconds while FAILED, so slurping the whole file would grow
// without bound.
async function readLogTail(maxBytes = 2000): Promise<string | undefined> {
  let handle;
  try {
    handle = await fs.open(logPath(), "r");
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, Math.max(0, size - length));
    return buf.toString("utf8");
  } catch {
    return undefined; // no log yet — absent, never invented
  } finally {
    await handle?.close().catch(() => {});
  }
}

/// Does this pid still exist? EPERM means it exists but isn't ours — still
/// alive, which is what the caller is asking.
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitGone(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !processAlive(pid);
}

async function executable(script: string): Promise<boolean> {
  try {
    await fs.access(script, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Serialised: the route's "is it already running?" check is a read-then-act
// with awaits in between, so N concurrent POSTs used to reach the spawn
// together and start N servers — and the last one to spawn overwrote the
// single `spawned` handle, so the gateway could report a loser's FAILED exit
// while the winner was loading. One in-flight start at a time, all callers
// share its result.
let inFlight: Promise<{ pid: number } | { error: string }> | null = null;

export function startModelServer(): Promise<{ pid: number } | { error: string }> {
  return (inFlight ??= doStart().finally(() => {
    inFlight = null;
  }));
}

async function doStart(): Promise<{ pid: number } | { error: string }> {
  // Second line of defence behind the serialisation: never abandon a process
  // we already own by overwriting its handle.
  if (spawned?.alive && processAlive(spawned.pid)) return { pid: spawned.pid };
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

/// Runs the stop script and then establishes, from evidence, whether anything
/// is actually gone. `pidStillAlive` is the honest answer for the process we
/// started; the caller re-probes the port for the other half.
///
/// Two things the script alone cannot tell us, both found live:
///  - it finds its target with `lsof -tiTCP:$PORT`, so a process that hasn't
///    bound yet (the STARTING window) is invisible to it and survives;
///  - it exits 0 when it deliberately refuses to kill a non-llama-server
///    process on the port.
/// So its exit code is never treated as proof, and `spawned` is cleared only
/// once the pid is really gone — a failed stop must not lose the handle to a
/// process that is definitely still running.
export async function stopModelServer(): Promise<{ error?: string; pidStillAlive: boolean }> {
  const script = CONFIG.modelStopScript;
  const pid = spawned && processAlive(spawned.pid) ? spawned.pid : null;
  if (!(await executable(script))) {
    return { error: `model stop script not found or not executable: ${script}`, pidStillAlive: pid !== null };
  }

  let error: string | undefined;
  try {
    await exec(script, [], { timeout: 15_000 });
  } catch (err) {
    error = `stop script failed: ${String(err)}`;
  }

  if (pid && processAlive(pid)) {
    // The child was spawned detached, so it leads its own process group —
    // signal the group so an exec'd llama-server goes with it.
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone between the check and the signal */
      }
    }
    await waitGone(pid);
  }

  const pidStillAlive = pid !== null && processAlive(pid);
  if (!pidStillAlive) spawned = null;
  return { error, pidStillAlive };
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
