#!/usr/bin/env node

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

const defaultArtifact = "src-tauri/target/release/bundle/macos/Glimmer Control Center.app.tar.gz";
const artifactPath = process.argv[2] ?? defaultArtifact;
const signaturePath = process.argv[3] ?? `${artifactPath}.sig`;

function payloadLine(envelope, description) {
  const lines = Buffer.from(envelope.trim(), "base64").toString("utf8").split(/\r?\n/);
  if (lines.length < 2 || !lines[0].startsWith("untrusted comment:")) {
    throw new Error(`${description} is not a valid minisign envelope`);
  }
  return Buffer.from(lines[1], "base64");
}

const [configText, artifact, signatureEnvelope] = await Promise.all([
  readFile("src-tauri/tauri.conf.json", "utf8"),
  readFile(artifactPath),
  readFile(signaturePath, "utf8"),
]);
const config = JSON.parse(configText);
const publicKeyEnvelope = config.plugins?.updater?.pubkey;
if (typeof publicKeyEnvelope !== "string") {
  throw new Error("tauri.conf.json does not contain plugins.updater.pubkey");
}

const publicPacket = payloadLine(publicKeyEnvelope, "embedded updater public key");
const signaturePacket = payloadLine(signatureEnvelope, "updater signature");
if (publicPacket.length !== 42 || publicPacket.subarray(0, 2).toString("ascii") !== "Ed") {
  throw new Error("embedded updater public key has an unsupported format");
}
if (signaturePacket.length !== 74 || signaturePacket.subarray(0, 2).toString("ascii") !== "ED") {
  throw new Error("updater signature has an unsupported format");
}
if (!publicPacket.subarray(2, 10).equals(signaturePacket.subarray(2, 10))) {
  throw new Error("updater signature key id does not match the key embedded in Glimmer");
}

// Minisign's ED packet signs a BLAKE2b-512 digest with Ed25519. Wrap the raw
// 32-byte public key in the standard Ed25519 SubjectPublicKeyInfo prefix so
// Node can perform the same cryptographic check as the Tauri updater.
const subjectPublicKeyInfo = Buffer.concat([
  Buffer.from("302a300506032b6570032100", "hex"),
  publicPacket.subarray(10),
]);
const publicKey = createPublicKey({ key: subjectPublicKeyInfo, format: "der", type: "spki" });
const digest = createHash("blake2b512").update(artifact).digest();
const valid = verify(null, digest, publicKey, signaturePacket.subarray(10));
if (!valid) throw new Error(`invalid updater signature for ${artifactPath}`);

console.log(`updater signature valid: ${artifactPath}`);
