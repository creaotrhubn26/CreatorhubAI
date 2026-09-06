// Polls coordinator status for the live podId, then samples container+system
// logs until the pod disappears; prints everything with timestamps.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";

const S = new URL(".", import.meta.url).pathname;
const runpodKey = readFileSync(path.join(os.homedir(), ".muse-glimmer", "compute-keys", "runpod.key"), "utf8").trim();
const ts = () => new Date().toISOString();

async function currentPod() {
  try {
    const out = execFileSync("node", [path.join(S, "coordinator-cache-job.mjs"), "status"], { encoding: "utf8" });
    const jobId = out.match(/"lastJobId": "([a-f0-9-]+)"/)?.[1];
    if (!jobId) return null;
    const job = execFileSync("node", [path.join(S, "get-job.mjs"), jobId], { encoding: "utf8" });
    const name = job.match(/"podName": "([^"]+)"/)?.[1];
    if (!name) return null;
    const res = await fetch("https://rest.runpod.io/v1/pods", { headers: { Authorization: `Bearer ${runpodKey}` } });
    const pods = await res.json();
    const match = Array.isArray(pods) ? pods.find((p) => p?.name === name) : null;
    return match ? { id: match.id, status: match.desiredStatus, name } : { id: null, name };
  } catch { return null; }
}

const seen = new Set();
async function sample(podId, source) {
  const response = await fetch(`https://api.runpod.io/v2/pods/${podId}/logs?source=${source}&tail=2000`, {
    headers: { Accept: "text/event-stream", Authorization: `Bearer ${runpodKey}` },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!response || response.status !== 200 || !response.body) return;
  let text = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 5000;
  try {
    while (Date.now() < deadline && text.length < 800_000) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // Partial stream reads are fine; the next sample retries.
  } finally {
    reader.cancel().catch(() => {});
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^data: (.*)$/);
    if (!m) continue;
    const key = source + m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`${ts()} [${source}] ${m[1]}`);
  }
}

let podId = null;
for (let i = 0; i < 120; i += 1) {
  const pod = await currentPod();
  if (pod?.id) { podId = pod.id; console.log(`${ts()} podId=${podId} status=${pod.status}`); break; }
  await delay(5000);
}
if (!podId) { console.log(`${ts()} no pod appeared`); process.exit(1); }
for (;;) {
  const res = await fetch(`https://rest.runpod.io/v1/pods/${podId}`, { headers: { Authorization: `Bearer ${runpodKey}` } });
  if (res.status === 404) { console.log(`${ts()} POD GONE (404)`); break; }
  const pod = await res.json().catch(() => null);
  console.log(`${ts()} status=${pod?.desiredStatus} lastStatusChange=${pod?.lastStatusChange ?? ""}`);
  await sample(podId, "system");
  await sample(podId, "container");
  await delay(10_000);
}
