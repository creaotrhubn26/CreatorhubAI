#!/usr/bin/env node

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  }),
);

const baseUrl = options.gateway ?? "http://127.0.0.1:4317";
const workspace = options.workspace ?? process.cwd();
const mode = options.mode ?? "inspect";
const objective = options.objective ?? "Hva kan bli bedre?";
const timeoutMs = Number(options.timeout ?? 15 * 60_000);
const cancelAfterMs = options["cancel-after"] ? Number(options["cancel-after"]) : null;
const origin = "http://127.0.0.1:5183";

const capabilityToken = process.env.GLIMMER_CAPABILITY_TOKEN ?? "";

async function api(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      // A controlled gateway (spawned with GLIMMER_CAPABILITY_TOKEN) rejects
      // state-changing requests without its capability header.
      ...(capabilityToken ? { "X-Glimmer-Capability": capabilityToken } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${response.status} ${body?.error ?? ""}`.trim(),
    );
  return body;
}

function assert(condition, message) {
  if (!condition) throw new Error(`dogfood assertion failed: ${message}`);
}

const contract = {
  objective,
  scope: { package: "repository" },
  mode,
  constraints: {
    minimalChange: true,
    noCommit: true,
    noPush: true,
    noDeploy: true,
    noDependencyInstall: true,
  },
  verification: [],
  repairBudget: mode === "inspect" || mode === "plan" || mode === "review" ? 0 : 2,
  advanced: { toolchainMode: "none" },
};

const created = await api("/api/sessions", {
  method: "POST",
  body: JSON.stringify({ taskContract: contract, workspace }),
});
assert(/^\d{8}-\d{6}-[a-f0-9-]{12}$/.test(created.id), `non-canonical session id ${created.id}`);
assert(!created.id.startsWith("pending-"), "pending id leaked to client");
assert(created.task === objective, "original objective was replaced");
assert(created.taskContract?.objective === objective, "persisted contract lost original objective");
if (/hva|forbedr|improv/i.test(objective)) {
  assert(
    created.taskContract?.intent?.kind === "improvement-assessment",
    "improvement intent was not inferred",
  );
}

await api(`/api/sessions/${created.id}/run`, { method: "POST" });

if (cancelAfterMs !== null) {
  await new Promise((resolve) => setTimeout(resolve, cancelAfterMs));
  await api(`/api/sessions/${created.id}/cancel`, { method: "POST" });
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
const deadline = Date.now() + timeoutMs;
let session;
while (Date.now() < deadline) {
  session = await api(`/api/sessions/${created.id}`);
  if (terminal.has(session.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
assert(session && terminal.has(session.status), `session did not finish within ${timeoutMs}ms`);
assert(session.id === created.id, "session id changed during execution");
assert(session.task === objective, "manifest/history objective differs from user input");
assert(typeof session.startedAt === "string", "startedAt is missing");
assert(typeof session.completedAt === "string", "completedAt is missing");

let report = null;
if (["inspect", "plan", "review"].includes(mode) && cancelAfterMs === null) {
  assert(session.status === "completed", `read-only session ended as ${session.status}`);
  assert(session.changedFiles.length === 0, "read-only session changed workspace files");
  assert(session.verification.overall === "NOT_RUN", "read-only report made a verification claim");
  report = await api(`/api/sessions/${created.id}/task-report`);
  assert(report.mode === mode, "task report mode mismatch");
  assert(report.objective === objective, "task report replaced the original objective");
  assert(report.reportFailed !== true, "task report is a fallback failure artifact");
}

if (cancelAfterMs !== null)
  assert(session.status === "cancelled", `cancelled run ended as ${session.status}`);

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      sessionId: created.id,
      status: session.status,
      objective: session.task,
      intent: session.taskContract?.intent,
      changedFiles: session.changedFiles.length,
      report: report
        ? { mode: report.mode, findings: report.findings.length, confidence: report.confidence }
        : null,
    },
    null,
    2,
  ) + "\n",
);
