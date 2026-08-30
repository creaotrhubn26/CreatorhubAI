#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";

const EXPECTED_ORCHESTRATOR_COMMIT = "7b043e907ee6d95fbf8a5843d657fa41ad73db4a";
const EXPECTED_ORCHESTRATOR_SNAPSHOT = "glimmer-runpod-r2";
const EXPECTED_RUNPOD_WORKFLOW_SHA =
  "c2f1b367b894a7dfea31c84ca844c52fd254b84e8b6aaaa0cfb2ff0d2b79c952";
const EXPECTED_PYTHON_FILES = {
  "lib/python3.13/os.py": "18560b0a37dfb90b4712fba97668d44a1328c5566b10deffaee292ba12cc21ff",
  "lib/python3.13/ssl.py": "538bb1cb334bebb9cd45b58503473ba7fd99cc9a5b769b2ff5caea81876227c3",
  "lib/python3.13/json/__init__.py":
    "43e38afede6d52ae0d602a42209b9959fc66d6020a25bcf15921446f5d1c262f",
  "lib/python3.13/sqlite3/__init__.py":
    "6e956d2166e24ccf36fef21ad63d06a5dd8f7b674aca6c81ea91eacca6b85b01",
  "requirements-tree-sitter.lock":
    "8bfe061a1ca73426e415f9a3ad2ffbe587e8bc49bb81423af8892cc1ffaa9326",
};
const EXPECTED_ORCHESTRATOR_FILES = {
  "glimmer-v2.py": "ecd0952e83bc9fd658230e4aa2707d92e90151e994529e78aacbd011b067ee4a",
  "glimmer-engineer.py": "16be8ca1c4ec368e3247a1f034a0db5b8418235129cf964962d12ee9bda3f7db",
  "glimmer_events.py": "2fd4aa0afbe32b58150be442c0e2b4cbb70f1c5ab65f2a9d2e857b239cd34454",
  "glimmer_journal.py": "67a28a2c480ca65ff49133968bda89a0c4f9e670aa02e28cd5fcb3e269464cf5",
  "glimmer_models.py": "584302c1b0689f70d825fe5a155ed88d410cba8c835de054429c6b233138409c",
  "glimmer_memory.py": "84db728096ee22c016e6abdb6efdad4b88620a3a19aa6b95eda698f9fa523920",
  "glimmer_quality.py": "cadc645a90f18cd5b069f6cd90191a55b02d9c2ad0bb16a72186baa79cce3188",
  "glimmer_semantic.py": "e1d3ce00c33f6db5d4183b1e8c237bbea50532ee051018b64b577163f864f167",
  "glimmer_verification.py": "fbd486ad5811ab3d4872f6638dd28e996c57119324bc2f04ab20fb393c9c4711",
  "glimmer-visual.py": "c9bf09838ca8742e0225a71b52ee77ac99bf4ee30f03a1b258b94828671a0ee3",
  "glimmer_remote.py": "5771ff5870bfc74b35cdad90c7011da5f23ca88bf2d54eb2f9a8a59188926bfd",
  "runpod_worker.py": "971aaa7c537d810a860ba213da06e0185dd9b5525869dffb147313f57d1eba68",
  "run-github-mcp.sh": "409041d9bd09a9febc199f755190caab073319ba68f1f3eae5417c14c4af5c33",
  "eval-baselines/baseline-stub.json":
    "65fcc635efca36848fa1e1b4069a99ee8c8f556760ef50ada005f52564976c18",
  "eval-baselines/latest-stub.json":
    "ab485efbfca4f7eb10d6105ad3b82c9b2cb82afba9231c9d4da915475c734a45",
  "eval-baselines/baseline-live.json":
    "342ea08539e3dafb23bd0a529a63fd5b398f721412261fc8e4a6c5cecfb3aa41",
  "eval-baselines/latest-live.json":
    "67b2c16d33f3cb59131d3a14147fa3912b3467bc28cb06736cda327ba7116d91",
};
const appPath = process.argv[2] ? path.resolve(process.argv[2]) : null;

if (!appPath) {
  const workflowPath = path.resolve(".github/workflows/runpod-image.yml");
  const workflowSha = crypto
    .createHash("sha256")
    .update(fs.readFileSync(workflowPath))
    .digest("hex");
  if (workflowSha !== EXPECTED_RUNPOD_WORKFLOW_SHA) {
    throw new Error(`RunPod image workflow checksum mismatch: ${workflowPath}`);
  }
}

function preparedTriple() {
  if (process.platform !== "darwin") {
    throw new Error(`unsupported runtime verification platform: ${process.platform}`);
  }
  const requested = process.env.GLIMMER_RUNTIME_TARGET;
  if (requested) {
    if (["aarch64-apple-darwin", "x86_64-apple-darwin"].includes(requested)) return requested;
    throw new Error(`unsupported requested runtime architecture: ${requested}`);
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
  path.join(orchestratorRoot, "glimmer_memory.py"),
  path.join(orchestratorRoot, "glimmer_quality.py"),
  path.join(orchestratorRoot, "glimmer_semantic.py"),
  path.join(orchestratorRoot, "glimmer_verification.py"),
  path.join(orchestratorRoot, "glimmer_remote.py"),
  path.join(orchestratorRoot, "runpod_worker.py"),
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
if (
  !pythonOrigin.treeSitterNativeFiles ||
  typeof pythonOrigin.treeSitterNativeFiles !== "object" ||
  Object.keys(pythonOrigin.treeSitterNativeFiles).length < 5
) {
  throw new Error("bundled Python manifest has no Tree-sitter native-module checksums");
}
for (const [name, expected] of Object.entries(pythonOrigin.treeSitterNativeFiles)) {
  if (
    path.isAbsolute(name) ||
    name.split(/[\\/]/).includes("..") ||
    !name.startsWith("lib/python3.13/site-packages/") ||
    !/\.(so|dylib)$/.test(name) ||
    !/^[a-f0-9]{64}$/.test(String(expected))
  ) {
    throw new Error(`invalid Tree-sitter native integrity entry: ${name}`);
  }
  const actual = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(pythonHome, name)))
    .digest("hex");
  if (actual !== expected) throw new Error(`Tree-sitter native checksum mismatch: ${name}`);
}

const origin = JSON.parse(fs.readFileSync(path.join(orchestratorRoot, "ORIGIN.json"), "utf8"));
if (origin.commit !== EXPECTED_ORCHESTRATOR_COMMIT) {
  throw new Error(`unexpected bundled orchestrator commit: ${origin.commit}`);
}
if (!origin.snapshot || origin.snapshot.id !== EXPECTED_ORCHESTRATOR_SNAPSHOT) {
  throw new Error("unexpected bundled orchestrator snapshot provenance");
}
if (!origin.files || typeof origin.files !== "object") {
  throw new Error("bundled orchestrator integrity manifest has no file checksums");
}
for (const [name, expected] of Object.entries(EXPECTED_ORCHESTRATOR_FILES)) {
  if (
    path.isAbsolute(name) ||
    name.split(/[\\/]/).includes("..") ||
    !/^[a-f0-9]{64}$/.test(String(expected))
  ) {
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
      `from importlib.metadata import version
from tree_sitter import LANGUAGE_VERSION, MIN_COMPATIBLE_LANGUAGE_VERSION, Language, Parser
import json, ssl, sqlite3, subprocess, urllib.request
import glimmer_events, glimmer_journal, glimmer_models, glimmer_quality, glimmer_semantic, glimmer_verification, glimmer_memory
import tree_sitter_javascript, tree_sitter_python, tree_sitter_rust, tree_sitter_typescript
assert (MIN_COMPATIBLE_LANGUAGE_VERSION, LANGUAGE_VERSION) == (13, 15)
expected = {'tree-sitter':'0.26.0','tree-sitter-python':'0.25.0','tree-sitter-javascript':'0.25.0','tree-sitter-typescript':'0.23.2','tree-sitter-rust':'0.24.2'}
assert {name: version(name) for name in expected} == expected
samples = [(tree_sitter_python.language,b'x = 1\\n'),(tree_sitter_javascript.language,b'const x = 1;'),(tree_sitter_typescript.language_typescript,b'const x: number = 1;'),(tree_sitter_typescript.language_tsx,b'const x = <div />;'),(tree_sitter_rust.language,b'fn main() {}')]
for grammar, source in samples:
    assert not Parser(Language(grammar())).parse(source).root_node.has_error
print(__import__('sys').version)`,
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
  `bundled runtime valid: Python 3.13.15 + orchestrator ${EXPECTED_ORCHESTRATOR_COMMIT} + ${EXPECTED_ORCHESTRATOR_SNAPSHOT}${appPath ? ` in ${appPath}` : ""}`,
);
