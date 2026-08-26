import os from "node:os";
import path from "node:path";

const stateRoot = process.env.GLIMMER_STATE_ROOT ?? path.join(os.homedir(), ".muse-glimmer");
const glimmerV2Path =
  process.env.GLIMMER_V2_PATH ?? path.join(os.homedir(), "AI", "muse-glimmer", "glimmer-v2.py");
const orchestratorRoot = path.dirname(glimmerV2Path);

export const CONFIG = {
  stateRoot,
  orchestratorRoot,
  modelConfigPath: process.env.GLIMMER_MODEL_CONFIG ?? path.join(stateRoot, "models.json"),
  modelKeysDir: path.join(stateRoot, "model-keys"),
  glimmerV2Path,
  engineerPath:
    process.env.GLIMMER_ENGINEER_PATH ??
    path.join(os.homedir(), "AI", "muse-glimmer", "glimmer-engineer.py"),
  modelBaseUrl: process.env.GLIMMER_MODEL_URL ?? "http://127.0.0.1:8080",
  modelApiKeyFile:
    process.env.GLIMMER_API_KEY_FILE ?? path.join(orchestratorRoot, "config", "api-key.txt"),
  mcpConfigPath:
    process.env.GLIMMER_MCP_CONFIG ?? path.join(orchestratorRoot, "config", "mcp-servers.json"),
  // The only two commands POST /api/model/{start,stop} may ever run: fixed
  // absolute paths, executed as argv with no arguments and no shell (see
  // lib/modelServer.ts). Nothing from a request body reaches a process.
  modelStartScript:
    process.env.GLIMMER_MODEL_START_SCRIPT ??
    path.join(os.homedir(), "AI", "muse-glimmer", "start-glimmer.sh"),
  modelStopScript:
    process.env.GLIMMER_MODEL_STOP_SCRIPT ??
    path.join(os.homedir(), "AI", "muse-glimmer", "stop-glimmer.sh"),
  port: Number(process.env.PORT ?? 4317),
  // §27/§4.1 workspace creation: the real source repo new worktrees are cut
  // from, where new worktrees/branches live, and the ref they're based on.
  // Mirrors new-glimmer-task.sh's REPO/WORKTREE_ROOT/BASE exactly.
  sourceRepo: process.env.GLIMMER_SOURCE_REPO ?? path.join(os.homedir(), "Creatorhubn-monorepo"),
  worktreeRoot: process.env.GLIMMER_WORKTREE_ROOT ?? os.homedir(),
  worktreeBase: process.env.GLIMMER_WORKTREE_BASE ?? "origin/main",
} as const;

export const sessionsDir = () => path.join(CONFIG.stateRoot, "sessions");
export const gatewayRunsDir = () => path.join(CONFIG.stateRoot, "gateway-runs");
export const gatewayRunLogsDir = () => path.join(CONFIG.stateRoot, "gateway-run-logs");
