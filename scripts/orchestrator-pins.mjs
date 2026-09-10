#!/usr/bin/env node
// Single authority for the bundled-orchestrator pins.
//
// The orchestrator commit, snapshot id, and per-file SHA-256 table are pinned
// independently in several source files — deliberately, for defense in depth:
// each is an independent copy the runtime/CI compares against a possibly
// tampered ORIGIN.json manifest. The cost of that independence was drift: a
// roll (r2→r5 this session) had to touch every copy by hand, and one was
// always missed, failing the shipped app or the release build.
//
// This script removes the hand-editing without collapsing the copies: it reads
// the freshly built ORIGIN.json (the one authoritative computation of the
// hashes) and writes those values into every consumer.
//   --sync  (default) rewrite the pins to match ORIGIN.json
//   --check  fail (exit 1) if any consumer disagrees — for CI and preflight
//
// prepare-orchestrator.sh runs --sync after building the bundle, so the pins
// are coherent by construction; --check is the safety net against a hand edit
// that skipped prepare.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = path.join(ROOT, "src-tauri/binaries/runtime/orchestrator/ORIGIN.json");
const DIAGNOSTICS = path.join(ROOT, "server/src/lib/diagnostics.ts");
const DIAGNOSTICS_TEST = path.join(ROOT, "server/src/lib/diagnostics.test.ts");
const VERIFY = path.join(ROOT, "scripts/verify-bundled-runtime.mjs");

const mode = process.argv.includes("--check") ? "check" : "sync";

const origin = JSON.parse(readFileSync(ORIGIN, "utf8"));
const commit = origin.commit;
const snapshot = origin.snapshot?.id;
const files = origin.files;
if (typeof commit !== "string" || typeof snapshot !== "string" || !files) {
  throw new Error("ORIGIN.json is missing commit, snapshot.id, or files");
}

/** Rewrite a `{ "name": "hash", ... }` object literal in place, preserving its
 * existing keys and order and refreshing each value from ORIGIN.json. */
function rewriteHashObject(source, declaration, indent = "  ") {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`could not find ${declaration}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("};", open);
  if (open === -1 || close === -1) throw new Error(`malformed object after ${declaration}`);
  const body = source.slice(open + 1, close);
  const keys = [...body.matchAll(/"([^"]+)"\s*:/g)].map((m) => m[1]);
  if (keys.length === 0) throw new Error(`no keys in ${declaration}`);
  const lines = keys.map((key) => {
    if (!(key in files)) throw new Error(`ORIGIN.json has no hash for ${key}`);
    return `${indent}"${key}": "${files[key]}",`;
  });
  return source.slice(0, open + 1) + "\n" + lines.join("\n") + "\n" + source.slice(close);
}

function replaceOnce(source, pattern, replacement, label) {
  const matches = source.match(new RegExp(pattern.source, pattern.flags.replace("g", "") + "g"));
  if (!matches || matches.length !== 1) throw new Error(`expected exactly one ${label}`);
  return source.replace(pattern, replacement);
}

function computeDiagnostics() {
  const s = readFileSync(DIAGNOSTICS, "utf8");
  return rewriteHashObject(
    s,
    "export const BUNDLED_ORCHESTRATOR_SHA256: Record<string, string> = ",
  );
}

function computeDiagnosticsTest() {
  const s = readFileSync(DIAGNOSTICS_TEST, "utf8");
  // The test pins one representative file hash; keep it honest.
  return replaceOnce(
    s,
    /(BUNDLED_ORCHESTRATOR_SHA256\["runpod_worker\.py"\]\)\.toBe\(\s*")[a-f0-9]{64}(")/s,
    `$1${files["runpod_worker.py"]}$2`,
    "pinned runpod_worker.py hash",
  );
}

function computeVerify() {
  let s = readFileSync(VERIFY, "utf8");
  s = replaceOnce(
    s,
    /(const EXPECTED_ORCHESTRATOR_COMMIT = ")[a-f0-9]{40}(";)/,
    `$1${commit}$2`,
    "EXPECTED_ORCHESTRATOR_COMMIT",
  );
  s = replaceOnce(
    s,
    /(const EXPECTED_ORCHESTRATOR_SNAPSHOT = ")[^"]+(";)/,
    `$1${snapshot}$2`,
    "EXPECTED_ORCHESTRATOR_SNAPSHOT",
  );
  s = rewriteHashObject(s, "const EXPECTED_ORCHESTRATOR_FILES = ");
  return s;
}

const targets = [
  { path: DIAGNOSTICS, compute: computeDiagnostics },
  { path: DIAGNOSTICS_TEST, compute: computeDiagnosticsTest },
  { path: VERIFY, compute: computeVerify },
];

// Value-based drift detection: compare the pinned hashes/commit/snapshot, not
// bytes, so prettier's line-wrapping of a long entry never reads as drift.
function pinValues(source) {
  const hashes = [...source.matchAll(/"([^"]+)"\s*:\s*\n?\s*"([a-f0-9]{64})"/g)].map(
    (m) => `${m[1]}=${m[2]}`,
  );
  const commitMatch = source.match(/EXPECTED_ORCHESTRATOR_COMMIT = "([a-f0-9]{40})"/);
  const snapMatch = source.match(/EXPECTED_ORCHESTRATOR_SNAPSHOT = "([^"]+)"/);
  return [
    ...hashes,
    ...(commitMatch ? [`commit=${commitMatch[1]}`] : []),
    ...(snapMatch ? [`snapshot=${snapMatch[1]}`] : []),
  ].sort();
}

let drift = false;
const written = [];
for (const target of targets) {
  const current = readFileSync(target.path, "utf8");
  const next = target.compute();
  if (pinValues(next).join("\n") === pinValues(current).join("\n")) continue;
  if (mode === "check") {
    drift = true;
    console.error(
      `orchestrator pin drift: ${path.relative(ROOT, target.path)} disagrees with ORIGIN.json`,
    );
  } else {
    writeFileSync(target.path, next);
    written.push(target.path);
    console.log(`synced ${path.relative(ROOT, target.path)}`);
  }
}

if (mode === "check") {
  if (drift) {
    console.error("run `npm run pins:sync` (or re-run prepare-orchestrator.sh) to fix.");
    process.exit(1);
  }
  console.log(`orchestrator pins ok: ${commit.slice(0, 12)} / ${snapshot}`);
} else {
  if (written.length > 0) {
    // Canonicalize formatting so the written entries match prettier and never
    // read as drift on the next check.
    execFileSync("npx", ["prettier", "--write", ...written], { cwd: ROOT, stdio: "inherit" });
  }
  console.log(`orchestrator pins synced to ${commit.slice(0, 12)} / ${snapshot}`);
}
