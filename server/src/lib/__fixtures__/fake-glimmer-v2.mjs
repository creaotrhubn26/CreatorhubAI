import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

console.log("FAKE ENGINEER RUNNING");

// Opt-in long-running mode for the route-level cancellation test. All older
// tests leave GLIMMER_FAKE_REAL_ID unset and retain this fixture's original
// immediate-success behavior.
const sessionIdIndex = process.argv.indexOf("--session-id");
const canonicalId = sessionIdIndex >= 0 ? process.argv[sessionIdIndex + 1] : undefined;
const shouldStayRunning = process.env.GLIMMER_FAKE_REAL_ID;
const stateRoot = process.env.GLIMMER_STATE_ROOT;
if (shouldStayRunning && stateRoot && canonicalId) {
  const workspaceIndex = process.argv.indexOf("--workspace");
  const workspace = workspaceIndex >= 0 ? process.argv[workspaceIndex + 1] : "/ws";
  const dir = path.join(stateRoot, "sessions", canonicalId);
  mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, "manifest.json");
  const startedAt = new Date().toISOString();
  const manifest = {
    sessionId: canonicalId,
    task: "cancellable fixture",
    status: "initialized",
    workspace,
    branch: "glimmer/cancellable-fixture",
    baseline: null,
    attempts: [],
    startedAt,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  process.on("SIGTERM", () => {
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        status: "cancelled-sigterm",
        updatedAt: new Date().toISOString(),
      }),
    );
    process.exit(0);
  });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
