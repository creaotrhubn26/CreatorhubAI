#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  }),
);
const appBinary = options.app;
const workspace = options.workspace;
const stateRoot = options.state;
const fixture = options.fixture ?? path.resolve("scripts/fixtures/glimmer-v2-e2e.mjs");
const baseUrl = options.gateway ?? "http://127.0.0.1:4317";
const timeoutMs = Number(options.timeout ?? 60_000);
const origin = "http://127.0.0.1:5183";
if (!appBinary || !workspace || !stateRoot) {
  throw new Error("--app, --workspace and --state are required");
}

function assert(condition, message) {
  if (!condition) throw new Error(`native Force Quit E2E assertion failed: ${message}`);
}

async function api(apiPath, token, init = {}) {
  const response = await fetch(`${baseUrl}${apiPath}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "X-Glimmer-Capability": token,
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${apiPath}: ${response.status} ${body?.error ?? ""}`);
  }
  return body;
}

function startApp(instanceId, token) {
  return spawn(appBinary, [], {
    env: {
      ...process.env,
      GLIMMER_STATE_ROOT: stateRoot,
      GLIMMER_V2_PATH: fixture,
      GLIMMER_INSTANCE_ID: instanceId,
      GLIMMER_CAPABILITY_TOKEN: token,
      GLIMMER_MODEL_URL: "http://127.0.0.1:1",
    },
    stdio: "ignore",
  });
}

async function waitForHealth(instanceId, token) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = await api("/api/health", token);
      if (health.instanceId === instanceId) return health;
    } catch {
      // App supervisor is starting or the stale parent watchdog is exiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`gateway instance ${instanceId} did not become healthy`);
}

async function waitFor(check, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message);
}

await fs.mkdir(stateRoot, { recursive: true });
const firstInstance = `force-quit-1-${randomUUID()}`;
const firstToken = randomUUID() + randomUUID();
let app = startApp(firstInstance, firstToken);
let secondToken;
try {
  await waitForHealth(firstInstance, firstToken);
  const contract = {
    objective: "[force-quit] preserve in-progress work",
    intent: { kind: "direct", source: "explicit" },
    scope: { package: "repository" },
    mode: "inspect",
    constraints: {
      minimalChange: true,
      noCommit: true,
      noPush: true,
      noDeploy: true,
      noDependencyInstall: true,
    },
    verification: [],
    repairBudget: 0,
    advanced: { toolchainMode: "none" },
  };
  const created = await api("/api/sessions", firstToken, {
    method: "POST",
    body: JSON.stringify({ taskContract: contract, workspace }),
  });
  await api(`/api/sessions/${created.id}/run`, firstToken, { method: "POST" });
  const progressPath = path.join(workspace, "force-quit-progress.txt");
  await waitFor(
    () =>
      fs
        .readFile(progressPath, "utf8")
        .then(() => true)
        .catch(() => false),
    "fixture never wrote durable progress",
  );

  app.kill("SIGKILL");
  await new Promise((resolve) => app.once("exit", resolve));
  await waitFor(async () => {
    try {
      const health = await api("/api/health", firstToken);
      return health.instanceId !== firstInstance;
    } catch {
      return true;
    }
  }, "force-quit gateway did not stop with its parent");

  const secondInstance = `force-quit-2-${randomUUID()}`;
  secondToken = randomUUID() + randomUUID();
  app = startApp(secondInstance, secondToken);
  await waitForHealth(secondInstance, secondToken);
  const recovered = await api(`/api/sessions/${created.id}`, secondToken);
  assert(recovered.status === "preflight", `live work was not reattached (${recovered.status})`);
  assert(
    (await fs.readFile(progressPath, "utf8")) === "progress survives force quit\n",
    "worktree progress changed during restart",
  );
  await api(`/api/sessions/${created.id}/cancel`, secondToken, { method: "POST" });
  await waitFor(async () => {
    const session = await api(`/api/sessions/${created.id}`, secondToken);
    return session.status === "cancelled";
  }, "recovered session could not be cancelled");

  process.stdout.write(
    `${JSON.stringify({ ok: true, sessionId: created.id, progressPreserved: true, reattached: true }, null, 2)}\n`,
  );
} finally {
  if (app.exitCode === null) app.kill("SIGTERM");
}
