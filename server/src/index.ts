import { createApp } from "./app.js";
import { CONFIG } from "./config.js";
import { reconcileActiveRunsOnStartup } from "./routes/sessions.js";
import { getComputeController } from "./lib/compute/computeController.js";

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
    const result = await getComputeController().stop(reason);
    if (result.terminated)
      console.log("[gateway] active RunPod compute terminated during shutdown");
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
