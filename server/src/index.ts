import { promises as fs, unlinkSync } from "node:fs";
import path from "node:path";
import { createApp } from "./app.js";
import { CONFIG } from "./config.js";
import { reconcileActiveRunsOnStartup } from "./routes/sessions.js";
import { getComputeController } from "./lib/compute/computeController.js";

// Last line of defense (observed live: a route handler's async throw is
// invisible to Express 4's error middleware, and the default behavior kills
// the gateway — orphaning running orchestrators and marking their sessions
// interrupted). Log loudly and keep serving; the failing request itself
// times out client-side, which is strictly better than losing every run.
process.on("unhandledRejection", (reason) => {
  console.error("[gateway] unhandled rejection:", reason);
});


const app = createApp();

let shutdownStarted = false;
async function shutdownWithComputeCleanup(reason: string, exitCode = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const forceExit = setTimeout(() => {
    console.error("[gateway] compute cleanup timed out during shutdown");
    process.exit(1);
  }, 12_000);
  try {
    // A coordinator-supervised lease survives gateway death by design: the
    // cloud coordinator and independent watchdog own its lifecycle (idle
    // timeout, hard deadline, budgets), and tearing it down here would kill
    // remote sessions that startup recovery can otherwise reattach to.
    const lease = await getComputeController().readLeaseForShutdown();
    if (lease?.orchestrationMode === "cloud_coordinator") {
      console.log(
        "[gateway] leaving coordinator-supervised compute running for restart recovery",
      );
    } else {
      const result = await getComputeController().stop(reason);
      if (result.terminated)
        console.log("[gateway] active RunPod compute terminated during shutdown");
    }
  } catch (error) {
    console.error(
      `[gateway] compute cleanup failed during shutdown: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(forceExit);
    process.exit(exitCode);
  }
}

process.once("SIGTERM", () => void shutdownWithComputeCleanup("gateway received SIGTERM"));
process.once("SIGINT", () => void shutdownWithComputeCleanup("gateway received SIGINT", 130));

if (CONFIG.parentPid) {
  const parentPid = CONFIG.parentPid;
  const parentWatchdog = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (error: any) {
      if (error?.code === "EPERM") return;
      console.error(`[gateway] parent process ${parentPid} is gone; cleaning up for safe restart.`);
      void shutdownWithComputeCleanup("desktop parent process exited");
    }
  }, 1_000);
  parentWatchdog.unref();
}

const recovery = await reconcileActiveRunsOnStartup();
if (recovery.reattached || recovery.interrupted || recovery.completed) {
  console.log(`[gateway] startup recovery=${JSON.stringify(recovery)}`);
}
const computeRecovery = await getComputeController()
  .reconcileOnStartup()
  .catch((error) => ({
    recovered: false,
    cleaned: false,
    detail: `unavailable: ${error instanceof Error ? error.message : String(error)}`,
  }));
if (
  computeRecovery.recovered ||
  computeRecovery.cleaned ||
  computeRecovery.detail !== "no compute lease"
) {
  console.log(`[gateway] compute recovery=${JSON.stringify(computeRecovery)}`);
}
// Loopback only: this API can spawn processes, so it must never be reachable
// from other hosts on the network.
// Local tooling (the remote-e2e drivers) attaches to a running app instead
// of racing it for the port; state-changing requests need this instance's
// capability token, so it is exposed to the SAME user only via a 0600 file
// in the state root — the trust domain that already holds the compute keys.
const capabilityTokenPath = path.join(CONFIG.stateRoot, "gateway-capability.token");
if (CONFIG.capabilityToken) {
  try {
    await fs.mkdir(CONFIG.stateRoot, { recursive: true });
    await fs.writeFile(capabilityTokenPath, CONFIG.capabilityToken, {
      encoding: "utf8",
      mode: 0o600,
    });
    process.once("exit", () => {
      try {
        unlinkSync(capabilityTokenPath);
      } catch {
        // Best effort; a stale file is harmless (it is only readable by the
        // same user and stops matching once a new instance rewrites it).
      }
    });
  } catch (error) {
    console.error(
      `[gateway] could not expose the capability token for local tooling: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

app.listen(CONFIG.port, "127.0.0.1", () => {
  console.log(`Glimmer Local API listening on http://127.0.0.1:${CONFIG.port}`);
  // The PATH this process inherited is the PATH glimmer-v2.py and every
  // verification command it spawns will run with. A GUI-launched .app gets
  // launchd's minimal PATH unless the Tauri shell resolved a real one
  // (src-tauri/src/lib.rs resolve_user_path), and "npm: command not found"
  // is indistinguishable from a real failure once it reaches a session log —
  // so state it here, at boot, where it can be checked.
  console.log(`[gateway] PATH=${process.env.PATH ?? "(unset)"}`);
  // Review MN2: GLIMMER_BROWSE_ROOT widens what GET /api/fs/dirs will list.
  // Same trust level as the other env knobs, but it must not be INVISIBLE —
  // a widened boundary should be checkable at boot, like PATH above.
  console.log(`[gateway] fs browse root=${process.env.GLIMMER_BROWSE_ROOT ?? "(default: home)"}`);
});
