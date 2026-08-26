#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const expected = process.argv[2]?.replace(/^v/, "");
const tauriConfig = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
const cargoManifest = await readFile("src-tauri/Cargo.toml", "utf8");
const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const tauriVersion = tauriConfig.version;

const problems = [];
if (typeof tauriVersion !== "string" || !SEMVER.test(tauriVersion)) {
  problems.push(`src-tauri/tauri.conf.json has an invalid SemVer version: ${String(tauriVersion)}`);
}
if (!cargoVersion || !SEMVER.test(cargoVersion)) {
  problems.push(`src-tauri/Cargo.toml has an invalid SemVer version: ${String(cargoVersion)}`);
}
if (tauriVersion !== cargoVersion) {
  problems.push(`Tauri (${tauriVersion}) and Cargo (${cargoVersion}) versions do not match`);
}
if (expected && tauriVersion !== expected) {
  problems.push(`Release tag/version ${expected} does not match the app version ${tauriVersion}`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`release version error: ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`release version ok: ${tauriVersion}`);
}
