#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";

const EXPECTED_ORCHESTRATOR_COMMIT = "0ec371d9dc5f76ec68b6463585183f19ddb6180d";
const EXPECTED_ORCHESTRATOR_OVERLAY = {
  id: "durable-journal-v1",
  patchSha256: "3c8375dddccd0000a36b1e38f6b643e9d62a54f006bf9f0d86910a78eb17d3d1",
  moduleSha256: "1832b24b2aa301b3f022e4f12a199aa22f36a6eb0c166dd413b95836996ce5e6",
};
const EXPECTED_PYTHON_FILES = {
  "lib/python3.13/os.py": "18560b0a37dfb90b4712fba97668d44a1328c5566b10deffaee292ba12cc21ff",
  "lib/python3.13/ssl.py": "538bb1cb334bebb9cd45b58503473ba7fd99cc9a5b769b2ff5caea81876227c3",
  "lib/python3.13/json/__init__.py":
    "43e38afede6d52ae0d602a42209b9959fc66d6020a25bcf15921446f5d1c262f",
  "lib/python3.13/sqlite3/__init__.py":
    "6e956d2166e24ccf36fef21ad63d06a5dd8f7b674aca6c81ea91eacca6b85b01",
};
const EXPECTED_ORCHESTRATOR_FILES = {
  "glimmer-v2.py": "5e52137fd07ac0a538b519fdd50fb5e5bac8c258c9eeb28d4b0f58035b7cf88b",
  "glimmer-engineer.py": "d6da291640495392d5330bb4d0c6ae996879dd8a7a185b00f1e7ef03e447a5cb",
  "glimmer_events.py": "5756d4280378ba351a75605109fcb4f84231e03b8cf9dcb63722173fc865b71e",
  "glimmer_journal.py": "1832b24b2aa301b3f022e4f12a199aa22f36a6eb0c166dd413b95836996ce5e6",
  "glimmer_models.py": "bf84fe821df6ce7e21babdeecc3dab3f053519ecf1edc467b4df83434b9ff6ee",
  "glimmer-visual.py": "0ba69bdfc9a8e50a8a2626293d3f734f2afd794a3e2f9ae7ad03d45358a967b5",
  "run-github-mcp.sh": "409041d9bd09a9febc199f755190caab073319ba68f1f3eae5417c14c4af5c33",
};
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
  path.join(pythonHome, "ORIGIN.json"),
  path.join(orchestratorRoot, "glimmer-v2.py"),
  path.join(orchestratorRoot, "glimmer-engineer.py"),
  path.join(orchestratorRoot, "glimmer-visual.py"),
  path.join(orchestratorRoot, "glimmer_events.py"),
  path.join(orchestratorRoot, "glimmer_journal.py"),
  path.join(orchestratorRoot, "glimmer_models.py"),
  path.join(orchestratorRoot, "run-github-mcp.sh"),
  path.join(orchestratorRoot, "ORIGIN.json"),
];
for (const file of requiredFiles) {
  if (!fs.statSync(file).isFile()) throw new Error(`bundled runtime file missing: ${file}`);
}

const pythonOrigin = JSON.parse(fs.readFileSync(path.join(pythonHome, "ORIGIN.json"), "utf8"));
if (pythonOrigin.version !== "3.13.15" || !pythonOrigin.files) {
  throw new Error("bundled Python integrity manifest is invalid");
}
for (const [name, expected] of Object.entries(EXPECTED_PYTHON_FILES)) {
  if (
    path.isAbsolute(name) ||
    name.split(/[\\/]/).includes("..") ||
    !/^[a-f0-9]{64}$/.test(String(expected))
  ) {
    throw new Error(`invalid bundled Python integrity entry: ${name}`);
  }
  if (pythonOrigin.files[name] !== expected) {
    throw new Error(`unexpected bundled Python manifest checksum: ${name}`);
  }
  const actual = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(pythonHome, name)))
    .digest("hex");
  if (actual !== expected) throw new Error(`bundled Python checksum mismatch: ${name}`);
}

const origin = JSON.parse(fs.readFileSync(path.join(orchestratorRoot, "ORIGIN.json"), "utf8"));
if (origin.commit !== EXPECTED_ORCHESTRATOR_COMMIT) {
  throw new Error(`unexpected bundled orchestrator commit: ${origin.commit}`);
}
if (
  !origin.overlay ||
  origin.overlay.id !== EXPECTED_ORCHESTRATOR_OVERLAY.id ||
  origin.overlay.patchSha256 !== EXPECTED_ORCHESTRATOR_OVERLAY.patchSha256 ||
  origin.overlay.moduleSha256 !== EXPECTED_ORCHESTRATOR_OVERLAY.moduleSha256
) {
  throw new Error("unexpected bundled orchestrator durability overlay provenance");
}
if (!origin.files || typeof origin.files !== "object") {
  throw new Error("bundled orchestrator integrity manifest has no file checksums");
}
for (const [name, expected] of Object.entries(EXPECTED_ORCHESTRATOR_FILES)) {
  if (path.basename(name) !== name || !/^[a-f0-9]{64}$/.test(String(expected))) {
    throw new Error(`invalid bundled orchestrator integrity entry: ${name}`);
  }
  if (origin.files[name] !== expected) {
    throw new Error(`unexpected bundled orchestrator manifest checksum: ${name}`);
  }
  const actual = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(orchestratorRoot, name)))
    .digest("hex");
  if (actual !== expected) throw new Error(`bundled orchestrator checksum mismatch: ${name}`);
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
      "import json, ssl, sqlite3, subprocess, urllib.request; import glimmer_events, glimmer_journal, glimmer_models; print(__import__('sys').version)",
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
  `bundled runtime valid: Python 3.13.15 + orchestrator ${EXPECTED_ORCHESTRATOR_COMMIT} + ${EXPECTED_ORCHESTRATOR_OVERLAY.id}${appPath ? ` in ${appPath}` : ""}`,
);
