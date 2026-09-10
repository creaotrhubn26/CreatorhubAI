#!/usr/bin/env node
// Coherent version bump across the three files that must always agree:
// src-tauri/tauri.conf.json, src-tauri/Cargo.toml, and the app package's entry
// in src-tauri/Cargo.lock. Doing this by hand meant editing three files and,
// in Cargo.lock, picking the right package among identically-versioned crates
// — error-prone enough that release:check exists to catch a mismatch. This
// makes the bump one command, then runs that check.
//
//   node scripts/bump-version.mjs <version>   e.g. 0.3.1

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !SEMVER.test(version)) {
  console.error(`usage: node scripts/bump-version.mjs <semver>  (got: ${process.argv[2] ?? ""})`);
  process.exit(1);
}

const TAURI = path.join(ROOT, "src-tauri/tauri.conf.json");
const CARGO = path.join(ROOT, "src-tauri/Cargo.toml");
const LOCK = path.join(ROOT, "src-tauri/Cargo.lock");

function replaceExact(file, pattern, replacement, label) {
  const source = readFileSync(file, "utf8");
  const matches = source.match(new RegExp(pattern.source, pattern.flags.replace(/g/g, "") + "g"));
  if (!matches || matches.length !== 1) {
    throw new Error(`expected exactly one ${label} in ${path.relative(ROOT, file)}`);
  }
  writeFileSync(file, source.replace(pattern, replacement));
}

// tauri.conf.json: the top-level "version" (regex, not JSON.stringify, to keep
// the file's exact formatting).
const tauriOld = JSON.parse(readFileSync(TAURI, "utf8")).version;
replaceExact(
  TAURI,
  new RegExp(`"version":\\s*"${tauriOld.replace(/\./g, "\\.")}"`),
  `"version": "${version}"`,
  "tauri version",
);

// Cargo.toml: the [package] version — the first `version = "..."`, which the
// package section always leads with.
replaceExact(
  CARGO,
  /^version = "[^"]+"/m,
  `version = "${version}"`,
  "Cargo.toml [package] version",
);

// Cargo.lock: only the app package's entry, never a coincidentally same-
// versioned dependency.
replaceExact(
  LOCK,
  /(name = "glimmer-control-center"\nversion = )"[^"]+"/,
  `$1"${version}"`,
  "Cargo.lock glimmer-control-center version",
);

console.log(`bumped to ${version} (tauri.conf.json, Cargo.toml, Cargo.lock)`);
execFileSync("node", [path.join(ROOT, "scripts/check-release-version.mjs"), `v${version}`], {
  cwd: ROOT,
  stdio: "inherit",
});
