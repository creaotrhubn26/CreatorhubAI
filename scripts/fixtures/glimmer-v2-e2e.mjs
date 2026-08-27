#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sessionId = arg("--session-id");
const workspace = arg("--workspace");
const mode = arg("--mode") ?? "inspect";
const stateRoot = process.env.GLIMMER_STATE_ROOT;
if (!sessionId || !workspace || !stateRoot) {
  process.stderr.write("e2e fixture needs --session-id, --workspace and GLIMMER_STATE_ROOT\n");
  process.exit(2);
}

const run = JSON.parse(
  readFileSync(path.join(stateRoot, "gateway-runs", `${sessionId}.json`), "utf8"),
);
const sessionDir = path.join(stateRoot, "sessions", sessionId);
mkdirSync(sessionDir, { recursive: true });
const manifestPath = path.join(sessionDir, "manifest.json");
const now = new Date().toISOString();
const branch = execFileSync("git", ["branch", "--show-current"], {
  cwd: workspace,
  encoding: "utf8",
}).trim();
const baseline = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: workspace,
  encoding: "utf8",
}).trim();
const baseManifest = {
  sessionId,
  task: run.contract.objective,
  contract: run.contract,
  status: "initialized",
  workspace,
  branch,
  baseline,
  attempts: [],
  maxRepairs: run.contract.repairBudget,
  startedAt: now,
};

function writeManifest(patch) {
  writeFileSync(manifestPath, JSON.stringify({ ...baseManifest, ...patch }, null, 2));
}

writeManifest({});

if (run.contract.objective.includes("[force-quit]")) {
  writeFileSync(path.join(workspace, "force-quit-progress.txt"), "progress survives force quit\n");
}

if (
  run.contract.objective.includes("[cancel]") ||
  run.contract.objective.includes("[force-quit]")
) {
  process.on("SIGTERM", () => {
    writeManifest({ status: "cancelled-sigterm", updatedAt: new Date().toISOString() });
    process.exit(0);
  });
  setInterval(() => {}, 1_000);
} else {
  const report = {
    schemaVersion: 1,
    mode,
    objective: run.contract.objective,
    summary: "Packaged-app E2E fixture completed without modifying the repository.",
    findings: [],
    implementationPlan: [],
    confidence: "high",
  };
  writeFileSync(path.join(sessionDir, "task-report.json"), JSON.stringify(report, null, 2));
  writeManifest({ status: `${mode}-completed`, updatedAt: new Date().toISOString() });
}
