#!/usr/bin/env node

const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  }),
);

const baseUrl = options.gateway ?? "http://127.0.0.1:4317";
const workspace = options.workspace;
const timeoutMs = Number(options.timeout ?? 60_000);
const capability = options.capability;
const expectedInstance = options.instance;
const origin = "http://127.0.0.1:5183";
if (!workspace) throw new Error("--workspace=<isolated glimmer/* git worktree> is required");

function assert(condition, message) {
  if (!condition) throw new Error(`packaged-app E2E assertion failed: ${message}`);
}

async function api(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(capability ? { "X-Glimmer-Capability": capability } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${response.status} ${body?.error ?? ""}`.trim(),
    );
  }
  return body;
}

const terminalStatuses = new Set([
  "verified",
  "completed",
  "no_change",
  "needs_review",
  "failed",
  "blocked",
  "cancelled",
  "stale",
]);

async function createAndRun(objective, { cancel = false } = {}) {
  const contract = {
    objective,
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
  const created = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ taskContract: contract, workspace }),
  });
  assert(/^\d{8}-\d{6}-[a-f0-9-]{12}$/.test(created.id), `invalid session id ${created.id}`);
  await api(`/api/sessions/${created.id}/run`, { method: "POST" });

  if (cancel) {
    const runningDeadline = Date.now() + 10_000;
    let running;
    while (Date.now() < runningDeadline) {
      running = await api(`/api/sessions/${created.id}`);
      if (running.status === "preflight") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(running?.status === "preflight", "cancel target never reached a running state");
    await api(`/api/sessions/${created.id}/cancel`, { method: "POST" });
  }

  const deadline = Date.now() + timeoutMs;
  let session;
  while (Date.now() < deadline) {
    session = await api(`/api/sessions/${created.id}`);
    if (terminalStatuses.has(session.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert(session && terminalStatuses.has(session.status), `${created.id} did not finish`);
  assert(session.task === objective, "task objective changed during the run");
  assert(typeof session.startedAt === "string", "startedAt is missing");
  assert(typeof session.completedAt === "string", "completedAt is missing");
  if (cancel) assert(session.status === "cancelled", `cancelled task ended as ${session.status}`);
  else assert(session.status === "completed", `completed task ended as ${session.status}`);
  return { id: session.id, status: session.status };
}

let health;
const healthDeadline = Date.now() + timeoutMs;
while (Date.now() < healthDeadline) {
  try {
    health = await api("/api/health");
    if (!expectedInstance || health.instanceId === expectedInstance) break;
  } catch {
    // The real app may still be starting its bundled gateway.
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
assert(health, "gateway never became healthy");
assert(health.service === "glimmer-gateway", "health endpoint is not the Glimmer gateway");
assert(typeof health.instanceId === "string", "health endpoint has no app instance identity");
if (expectedInstance) assert(health.instanceId === expectedInstance, "wrong gateway instance");
const readiness = await api("/api/ready");
assert(readiness.coreReady === true, "packaged runtime is not core-ready");

const first = await createAndRun("[e2e] create and complete a task");
const cancelled = await createAndRun("[cancel] cancel a running task", { cancel: true });
const restarted = await createAndRun("[e2e] start a new task after cancellation");
const diagnostics = await api("/api/diagnostics");
assert(diagnostics.readiness.coreReady === true, "diagnostics disagree with readiness");
const repair = await api("/api/diagnostics/repair", { method: "POST" });
assert(repair.reinstallRequired === false, "repair reported a corrupt packaged runtime");
assert(typeof repair.backupPath === "string", "repair did not create a recovery backup");
const smoke = await api("/api/diagnostics/smoke", { method: "POST" });
assert(smoke.status === "passed", "deep recovery smoke failed");
const support = await api("/api/diagnostics/support-bundle", { method: "POST" });
assert(
  support.privacy?.credentialsIncluded === false,
  "support package privacy contract is missing",
);
assert(support.privacy?.taskPromptsIncluded === false, "support package contains task prompts");

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      appVersion: health.version,
      readiness: readiness.status,
      workflow: { first, cancelled, restarted },
      repair: { repaired: repair.repaired, reinstallRequired: repair.reinstallRequired },
      smoke: { status: smoke.status, checks: smoke.checks.length },
      support: { sessions: support.sessions.length, sessionLogs: support.sessionLogs.length },
    },
    null,
    2,
  )}\n`,
);
