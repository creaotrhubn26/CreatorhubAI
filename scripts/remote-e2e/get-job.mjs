import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const config = JSON.parse(
  readFileSync(path.join(os.homedir(), ".muse-glimmer", "compute.json"), "utf8"),
);
const token = readFileSync(config.coordinator.tokenFile, "utf8").trim();
const pathname = `/v1/jobs/${process.argv[2]}`;
const timestamp = String(Date.now());
const signature = createHmac("sha256", token)
  .update(`GET\n${pathname}\n${timestamp}\n`)
  .digest("hex");
const response = await fetch(config.coordinator.endpointUrl.replace(/\/+$/, "") + pathname, {
  headers: { "X-Glimmer-Timestamp": timestamp, "X-Glimmer-Signature": `v1=${signature}` },
});
console.log(response.status, JSON.stringify(await response.json(), null, 1));
