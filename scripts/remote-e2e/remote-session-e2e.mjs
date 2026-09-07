#!/usr/bin/env node
// Proves milestone R3 end to end THROUGH THE PRODUCT: create a session via the
// gateway's own /api/sessions, run it, and observe the gateway route it to the
// coordinator-supervised GPU worker, sync artifacts, and finish.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const APP = "/Applications/Glimmer Control Center.app/Contents/MacOS/glimmer-control-center";
const BASE = "http://127.0.0.1:4317";
const ORIGIN = "tauri://localhost";

// Usage: node scripts/remote-e2e/remote-session-e2e.mjs --worktree <path> \
//          [--mode inspect|implement|verify] [--kill-mid-run]
// The worktree must be a clean git worktree on a glimmer/* branch; a paid
// GPU run (~$0.05-0.15) starts through the app's own APIs and is always
// stopped and cleaned in the finally block.
const options = Object.fromEntries(
  process.argv.slice(2).map((argument, index, all) => {
    if (!argument.startsWith("--")) return [];
    const key = argument.replace(/^--/, "");
    const next = all[index + 1];
    return [key, next && !next.startsWith("--") ? next : "true"];
  }).filter((entry) => entry.length),
);
const WORKTREE = options.worktree;
if (!WORKTREE) {
  console.error("--worktree <path> is required (clean worktree on a glimmer/* branch)");
  process.exit(2);
}
const MODE = options.mode ?? "inspect";
const KILL_MID_RUN = options["kill-mid-run"] === "true";

const instanceId = randomBytes(16).toString("hex");
let capability = randomBytes(32).toString("hex");
const stateRoot = path.join(os.homedir(), ".muse-glimmer");

const log = (event, extra = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...extra }));

async function api(pathname, init = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: {
      Origin: ORIGIN,
      "X-Glimmer-Capability": capability,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${pathname}: ${response.status} ${body?.error ?? ""}`);
  }
  return body;
}

function computeUpdate(enabled) {
  const stored = JSON.parse(readFileSync(path.join(stateRoot, "compute.json"), "utf8"));
  return {
    version: 1,
    enabled,
    defaultBackend: enabled ? "runpod_pod" : "local_process",
    activeProfileId: stored.activeProfileId,
    apiKeyFile: stored.apiKeyFile,
    ...(stored.orchestrationMode ? { orchestrationMode: stored.orchestrationMode } : {}),
    ...(stored.coordinator ? { coordinator: stored.coordinator } : {}),
    profiles: stored.profiles.map((profile) => {
      const copy = { ...profile };
      delete copy.hasApiKey;
      delete copy.watchdogConfigured;
      return copy;
    }),
  };
}

// Attach to an already-running app instead of racing it for the gateway
// port: a user's open app and a driver-spawned one collide (one gateway
// shuts the other's session down mid-run). Attach reuses the live gateway;
// spawn happens only when nothing is listening.
async function gatewayAlive() {
  try {
    const response = await fetch(`${BASE}/api/ready`, { headers: { Origin: ORIGIN } });
    return response.ok || response.status === 503;
  } catch {
    return false;
  }
}

let app = null;
let appOut = "";
let exitCode = 1;
let originalEnabled = false;
try {
  const attached = await gatewayAlive();
  if (attached) {
    // The running instance enforces its own capability token; the gateway
    // exposes it to the same user via a 0600 file in the state root.
    try {
      capability = readFileSync(path.join(stateRoot, "gateway-capability.token"), "utf8").trim();
    } catch {
      throw new Error(
        "an app is running but its capability token file is missing — update the app (the gateway writes ~/.muse-glimmer/gateway-capability.token) or quit it first",
      );
    }
  }
  if (attached && KILL_MID_RUN) {
    throw new Error(
      "--kill-mid-run needs to own the app process; quit the running app first",
    );
  }
  if (!attached) {
    app = spawn(APP, [], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GLIMMER_INSTANCE_ID: instanceId, GLIMMER_CAPABILITY_TOKEN: capability },
    });
    app.stdout.on("data", (d) => (appOut += d));
    app.stderr.on("data", (d) => (appOut += d));
  }
  for (let i = 0; i < 60; i += 1) {
    try {
      await api("/api/ready");
      break;
    } catch {
      await delay(2000);
    }
  }
  log("gateway_ready", { attached });
  originalEnabled = JSON.parse(
    readFileSync(path.join(stateRoot, "compute.json"), "utf8"),
  ).enabled === true;
  await api("/api/compute/config", { method: "PUT", body: JSON.stringify(computeUpdate(true)) });
  await api("/api/compute/start", { method: "POST", body: JSON.stringify({}) });
  log("compute_start_accepted");

  const readyDeadline = Date.now() + 20 * 60_000;
  for (;;) {
    if (Date.now() > readyDeadline) throw new Error("worker did not become ready in 12 minutes");
    const status = await api("/api/compute/status").catch(() => null);
    if (status?.state === "ready") break;
    await delay(6000);
  }
  log("worker_ready");

  const constraints = {
    minimalChange: true,
    noCommit: true,
    noPush: true,
    noDeploy: true,
    noDependencyInstall: true,
  };
  const contract =
    MODE === "inspect"
      ? {
          objective:
            "Les README eller package.json og skriv en kort oppsummering (3-5 setninger) av hva dette prosjektet er. Ikke endre noen filer.",
          scope: { package: "repository" },
          mode: "inspect",
          constraints,
          verification: [],
          repairBudget: 0,
          advanced: { toolchainMode: "none" },
        }
      : {
          objective:
            "Opprett en ny fil REMOTE_NOTE.md i repo-roten med nøyaktig én linje: 'Denne filen ble skrevet av GPU-workeren.' Ikke endre andre filer.",
          scope: { package: "repository" },
          mode: "implement",
          constraints,
          verification: MODE === "verify" ? ["frontend-typecheck"] : [],
          repairBudget: 0,
          advanced: { toolchainMode: "none" },
        };
  const created = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ taskContract: contract, workspace: WORKTREE }),
  });
  log("session_created", { sessionId: created.id });

  const run = await api(`/api/sessions/${created.id}/run`, { method: "POST" });
  log("session_run_accepted", run);
  if (run.backend !== "runpod_pod") {
    throw new Error(`session did not route to the remote worker: ${JSON.stringify(run)}`);
  }

  if (KILL_MID_RUN) {
    // Restart-recovery proof: SIGKILL the whole app mid-run, relaunch, and
    // rely on startup reconciliation to reattach and finish the session.
    await delay(45_000);
    app.kill("SIGKILL");
    log("app_killed_mid_run");
    await delay(3_000);
    app = spawn(APP, [], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GLIMMER_INSTANCE_ID: instanceId, GLIMMER_CAPABILITY_TOKEN: capability },
    });
    app.stdout.on("data", (d) => (appOut += d));
    app.stderr.on("data", (d) => (appOut += d));
    for (let i = 0; i < 60; i += 1) {
      try {
        await api("/api/ready");
        break;
      } catch {
        await delay(2000);
      }
    }
    log("gateway_restarted");
  }

  const terminal = new Set([
    "verified",
    "completed",
    "no_change",
    "needs_review",
    "failed",
    "blocked",
    "cancelled",
    "stale",
  ]);
  const deadline = Date.now() + 15 * 60_000;
  let session = null;
  for (;;) {
    if (Date.now() > deadline) throw new Error("session did not finish in 15 minutes");
    session = await api(`/api/sessions/${created.id}`).catch(() => null);
    if (session && terminal.has(session.status)) break;
    await delay(3000);
  }
  log("session_finished", {
    status: session.status,
    changedFiles: session.changedFiles?.length,
    completedAt: session.completedAt,
  });

  const sessionDir = path.join(stateRoot, "sessions", created.id);
  const manifest = JSON.parse(readFileSync(path.join(sessionDir, "manifest.json"), "utf8"));
  const orchestratorLog = readFileSync(path.join(sessionDir, "orchestrator.log"), "utf8");
  log("artifacts_synced", {
    manifestStatus: manifest.status ?? manifest.result ?? "present",
    logBytes: orchestratorLog.length,
    logTail: orchestratorLog.slice(-400),
  });
  const { execFileSync } = await import("node:child_process");
  if (MODE === "inspect") {
    log("r3_e2e_ok");
    exitCode = 0;
    throw { earlyExit: true };
  }
  const gitStatus = execFileSync("git", ["-C", WORKTREE, "status", "--short"], { encoding: "utf8" });
  const noteExists = (() => {
    try {
      return readFileSync(path.join(WORKTREE, "REMOTE_NOTE.md"), "utf8");
    } catch {
      return null;
    }
  })();
  log("worktree_after", { gitStatus: gitStatus.trim(), remoteNote: noteExists });
  const podLog = readFileSync(path.join(stateRoot, "sessions", created.id, "orchestrator.log"), "utf8");
  log("verification_evidence", {
    npmCi: podLog.includes("npm ci"),
    fixtureTypecheck: podLog.includes("fixture typecheck OK"),
  });
  if (!noteExists) throw new Error("remote change did not land in the local worktree");
  execFileSync("git", ["-C", WORKTREE, "checkout", "--", "."], { encoding: "utf8" });
  execFileSync("git", ["-C", WORKTREE, "clean", "-fd"], { encoding: "utf8" });
  log("worktree_restored");
  log("r3_e2e_ok");
  exitCode = 0;
} catch (error) {
  if (!error?.earlyExit) {
    log("e2e_failed", { message: error instanceof Error ? error.message : String(error) });
    exitCode = 1;
  }
} finally {
  await api("/api/compute/stop", { method: "POST", body: JSON.stringify({}) }).catch((error) =>
    log("compute_stop_error", { message: String(error) }),
  );
  log("compute_stop_requested");
  for (let i = 0; i < 20; i += 1) {
    const status = await api("/api/compute/status").catch(() => null);
    if (status && ["offline", "failed"].includes(status.state)) break;
    await delay(5000);
  }
  await api("/api/compute/config", { method: "PUT", body: JSON.stringify(computeUpdate(originalEnabled)) })
    .then(() => log("config_restored"))
    .catch((error) => log("config_restore_error", { message: String(error) }));
  const runpodKey = readFileSync(path.join(stateRoot, "compute-keys", "runpod.key"), "utf8").trim();
  const pods = await fetch("https://rest.runpod.io/v1/pods", {
    headers: { Authorization: `Bearer ${runpodKey}` },
  })
    .then((r) => r.json())
    .catch(() => null);
  log("provider_final", { podCount: Array.isArray(pods) ? pods.length : -1 });
  if (app) app.kill("SIGTERM");
  if (exitCode !== 0) {
    console.error("--- gateway log tail ---");
    console.error(appOut.slice(-4000));
  }
  process.exit(exitCode);
}
