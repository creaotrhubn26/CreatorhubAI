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
const completedStatus = mode === "implement" ? "verified" : `${mode}-completed`;

function writeManifest(patch) {
  writeFileSync(manifestPath, JSON.stringify({ ...baseManifest, ...patch }, null, 2));
}

function writeV2Artifacts() {
  const report = {
    schemaVersion: 2,
    mode,
    objective: run.contract.objective,
    summary: "Only supported claims are presented as facts.",
    findings: [
      {
        severity: "info",
        category: "structure",
        title: "Fixture route exists",
        description: "The E2E fixture supplied a cited route declaration.",
        claimType: "presence",
        evidenceIds: ["evidence-1"],
        evidence: [{ path: "server.ts", line: 4, detail: "route declaration" }],
        recommendedFix: "No change.",
        verification: { status: "verified", reasons: [] },
      },
    ],
    rejectedFindings: [
      {
        severity: "medium",
        category: "correctness",
        title: "No tests exist",
        description: "The absence claim had insufficient repository coverage.",
        claimType: "absence",
        evidenceIds: [],
        evidence: [],
        recommendedFix: "Run a repository-wide search.",
        verification: { status: "rejected", reasons: ["repository search missing"] },
      },
    ],
    implementationPlan: [],
    confidence: "medium",
    coverage: {
      filesInspected: 3,
      searchesRun: 1,
      graphCoverage: 0.75,
      unsupportedLanguages: [],
      evidenceRecords: 1,
    },
    decisionPoints: [],
    critic: { status: "completed", independence: "same-model" },
  };
  const repoIndex = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    workspace,
    head: baseline,
    dirtyHash: "e2e-clean",
    cacheKey: `e2e-${sessionId}`,
    parserVersions: { "tree-sitter": "0.26.0" },
    coverage: { ratio: 0.75 },
    files: [],
    symbols: [],
    edges: [],
    routes: [],
    tests: [],
    diagnostics: [],
  };
  writeFileSync(path.join(sessionDir, "task-report.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(sessionDir, "repo-index.json"), JSON.stringify(repoIndex, null, 2));
}

function clarificationRequest(timeoutMilliseconds = 60_000) {
  return {
    schemaVersion: 1,
    id: `${sessionId}-clarification-1`,
    sessionId,
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + timeoutMilliseconds).toISOString(),
    question: "Which storage should be used?",
    impact: "high",
    options: [
      { id: "sqlite", label: "SQLite" },
      { id: "json", label: "JSON" },
    ],
    allowFreeform: true,
  };
}

writeManifest({});

if (run.contract.objective.includes("[force-quit]")) {
  writeFileSync(path.join(workspace, "force-quit-progress.txt"), "progress survives force quit\n");
}

if (run.contract.objective.includes("[clarification-timeout]")) {
  const clarification = clarificationRequest(1_000);
  writeFileSync(
    path.join(sessionDir, "clarification.json"),
    JSON.stringify(clarification, null, 2),
  );
  writeManifest({ status: "waiting-for-clarification", updatedAt: new Date().toISOString() });
  setTimeout(() => {
    writeFileSync(
      path.join(sessionDir, "clarification.json"),
      JSON.stringify({ ...clarification, status: "expired" }, null, 2),
    );
    writeManifest({
      status: "needs-review-ambiguous-task",
      failure: {
        class: "AMBIGUOUS_TASK",
        detail: "The clarification expired before implementation.",
      },
      updatedAt: new Date().toISOString(),
    });
  }, 1_100);
} else if (run.contract.objective.includes("[clarification]")) {
  const clarificationPath = path.join(sessionDir, "clarification.json");
  writeFileSync(clarificationPath, JSON.stringify(clarificationRequest(), null, 2));
  writeManifest({ status: "waiting-for-clarification", updatedAt: new Date().toISOString() });
  const timer = setInterval(() => {
    const clarification = JSON.parse(readFileSync(clarificationPath, "utf8"));
    if (clarification.status !== "answered") return;
    clearInterval(timer);
    writeV2Artifacts();
    writeManifest({ status: completedStatus, updatedAt: new Date().toISOString() });
  }, 100);
} else if (
  run.contract.objective.includes("[cancel]") ||
  run.contract.objective.includes("[force-quit]")
) {
  process.on("SIGTERM", () => {
    writeManifest({ status: "cancelled-sigterm", updatedAt: new Date().toISOString() });
    process.exit(0);
  });
  setInterval(() => {}, 1_000);
} else {
  if (run.contract.objective.includes("[v2-report]")) {
    writeV2Artifacts();
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
  }
  writeManifest({ status: completedStatus, updatedAt: new Date().toISOString() });
}
