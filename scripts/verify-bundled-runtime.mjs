#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const EXPECTED_ORCHESTRATOR_COMMIT = "0ec371d9dc5f76ec68b6463585183f19ddb6180d";
const appPath = process.argv[2] ? path.resolve(process.argv[2]) : null;

function preparedTriple() {
  if (process.platform !== "darwin") {
    throw new Error(`unsupported runtime verification platform: ${process.platform}`);
  }
  if (process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.arch === "x64") return "x86_64-apple-darwin";
  throw new Error(`unsupported runtime verification architecture: ${process.arch}`);
}

const pythonHome = appPath
  ? path.join(appPath, "Contents", "Resources", "binaries", "runtime", "python")
  : path.resolve("src-tauri/binaries/runtime/python");
const orchestratorRoot = appPath
  ? path.join(appPath, "Contents", "Resources", "binaries", "runtime", "orchestrator")
  : path.resolve("src-tauri/binaries/runtime/orchestrator");
const preparedPython = appPath
  ? path.join(appPath, "Contents", "MacOS", "python3")
  : path.resolve(`src-tauri/binaries/python3-${preparedTriple()}`);

const requiredFiles = [
  preparedPython,
  path.join(pythonHome, "lib", "python3.13", "os.py"),
  path.join(orchestratorRoot, "glimmer-v2.py"),
  path.join(orchestratorRoot, "glimmer-engineer.py"),
  path.join(orchestratorRoot, "glimmer-visual.py"),
  path.join(orchestratorRoot, "glimmer_events.py"),
  path.join(orchestratorRoot, "glimmer_models.py"),
  path.join(orchestratorRoot, "run-github-mcp.sh"),
  path.join(orchestratorRoot, "ORIGIN.json"),
];
for (const file of requiredFiles) {
  if (!fs.statSync(file).isFile()) throw new Error(`bundled runtime file missing: ${file}`);
}

const origin = JSON.parse(fs.readFileSync(path.join(orchestratorRoot, "ORIGIN.json"), "utf8"));
if (origin.commit !== EXPECTED_ORCHESTRATOR_COMMIT) {
  throw new Error(`unexpected bundled orchestrator commit: ${origin.commit}`);
}

const temporaryBin = appPath
  ? null
  : fs.mkdtempSync(path.join(os.tmpdir(), "glimmer-runtime-bin-"));
const runtimeBin = appPath ? path.dirname(preparedPython) : temporaryBin;
if (temporaryBin) fs.symlinkSync(preparedPython, path.join(temporaryBin, "python3"));

const env = {
  ...process.env,
  PATH: runtimeBin,
  PYTHONHOME: pythonHome,
  PYTHONDONTWRITEBYTECODE: "1",
};

function run(file, args, description) {
  const result = spawnSync(file, args, {
    cwd: orchestratorRoot,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${description} failed (${result.status ?? "spawn error"}): ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return `${result.stdout}\n${result.stderr}`;
}

try {
  const pythonOutput = run(
    preparedPython,
    [
      "-c",
      "import json, ssl, subprocess, urllib.request; import glimmer_events, glimmer_models; print(__import__('sys').version)",
    ],
    "bundled Python import self-test",
  );
  if (!pythonOutput.includes("3.13.15")) {
    throw new Error(`unexpected bundled Python version: ${pythonOutput.trim()}`);
  }

  // Run the real scripts directly with PATH containing only the bundled
  // python3. This proves their /usr/bin/env shebang never needs a system or
  // Homebrew Python installation.
  run(path.join(orchestratorRoot, "glimmer-v2.py"), ["--help"], "orchestrator shebang self-test");
  run(path.join(orchestratorRoot, "glimmer-engineer.py"), ["--help"], "engineer shebang self-test");
  run(
    path.join(orchestratorRoot, "glimmer-visual.py"),
    ["--help"],
    "visual verifier shebang self-test",
  );
} finally {
  if (temporaryBin) fs.rmSync(temporaryBin, { recursive: true, force: true });
}

console.log(
  `bundled runtime valid: Python 3.13.15 + orchestrator ${EXPECTED_ORCHESTRATOR_COMMIT}${appPath ? ` in ${appPath}` : ""}`,
);
