#!/usr/bin/env node
// Drives the deployed coordinator's cpu_cache flow end to end:
// signed /v1/status, PUT cpu_cache job, poll to a terminal state.
import { createHmac, randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const stateRoot = path.join(os.homedir(), ".muse-glimmer");
const config = JSON.parse(readFileSync(path.join(stateRoot, "compute.json"), "utf8"));
const endpoint = config.coordinator.endpointUrl.replace(/\/+$/, "");
const token = readFileSync(config.coordinator.tokenFile, "utf8").trim();
const profile = config.profiles.find((p) => p.id === config.activeProfileId);

function signed(method, pathname, body = "") {
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", token)
    .update(`${method}\n${pathname}\n${timestamp}\n${body}`)
    .digest("hex");
  return {
    "X-Glimmer-Timestamp": timestamp,
    "X-Glimmer-Signature": `v1=${signature}`,
    ...(body ? { "Content-Type": "application/json" } : {}),
  };
}

async function call(method, pathname, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const response = await fetch(`${endpoint}${pathname}`, {
    method,
    headers: signed(method, pathname, payload),
    ...(payload ? { body: payload } : {}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
  return { status: response.status, body: parsed };
}

const mode = process.argv[2] ?? "status";

if (mode === "status") {
  const status = await call("GET", "/v1/status");
  console.log(JSON.stringify(status, null, 1));
  process.exit(status.status === 200 ? 0 : 1);
}

if (mode === "submit") {
  const jobId = randomUUID();
  const request = {
    schemaVersion: 1,
    jobId,
    ownerInstanceId: `cachejob-${randomBytes(8).toString("hex")}`,
    kind: "cpu_cache",
    image: profile.imageDigest,
    buildId: profile.workerBuildId,
    containerRegistryAuthId: profile.containerRegistryAuthId,
    networkVolumeId: profile.networkVolumeId,
    contextTokens: profile.contextTokens,
    modelArtifacts: {
      model: { url: profile.modelArtifacts.model.url, sha256: profile.modelArtifacts.model.sha256 },
      mmproj: {
        url: profile.modelArtifacts.mmproj.url,
        sha256: profile.modelArtifacts.mmproj.sha256,
      },
      draftModel: {
        url: profile.modelArtifacts.draftModel.url,
        sha256: profile.modelArtifacts.draftModel.sha256,
      },
      allowedHosts: profile.modelArtifacts.allowedHosts,
    },
    maxHourlyUsd: 0.075,
    hardDeadlineAt: new Date(Date.now() + 45 * 60_000).toISOString(),
  };
  const created = await call("PUT", `/v1/jobs/${jobId}`, request);
  console.log("submit:", JSON.stringify(created, null, 1));
  if (![200, 201, 202].includes(created.status)) process.exit(1);

  let previous = "";
  const deadline = Date.now() + 50 * 60_000;
  while (Date.now() < deadline) {
    await delay(10_000);
    const job = await call("GET", `/v1/jobs/${jobId}`);
    const summary = JSON.stringify({
      state: job.body?.state,
      phase: job.body?.phase,
      waitingReason: job.body?.waitingReason,
      failureCode: job.body?.failureCode,
      cleanup: job.body?.cleanup,
      cacheReady: job.body?.cacheReady ?? job.body?.cache ?? undefined,
    });
    if (summary !== previous) {
      console.log(new Date().toISOString(), summary);
      previous = summary;
    }
    const state = job.body?.state;
    if (state && ["completed", "failed", "terminated"].includes(state)) {
      console.log("final:", JSON.stringify(job.body, null, 1));
      process.exit(state === "completed" ? 0 : 1);
    }
  }
  console.error("poll deadline elapsed");
  process.exit(1);
}
