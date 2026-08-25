import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

console.log("FAKE ENGINEER RUNNING");

// Opt-in long-running mode for the route-level cancellation test. All older
// tests leave GLIMMER_FAKE_REAL_ID unset and retain this fixture's original
// immediate-success behavior.
const realId = process.env.GLIMMER_FAKE_REAL_ID;
const stateRoot = process.env.GLIMMER_STATE_ROOT;
if (realId && stateRoot) {
  const workspaceIndex = process.argv.indexOf("--workspace");
  const workspace = workspaceIndex >= 0 ? process.argv[workspaceIndex + 1] : "/ws";
  const dir = path.join(stateRoot, "sessions", realId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    task: "cancellable fixture", status: "initialized", workspace,
    branch: "glimmer/cancellable-fixture", baseline: null, attempts: [],
  }));
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
