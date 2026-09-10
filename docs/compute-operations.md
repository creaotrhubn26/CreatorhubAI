# Compute operations runbook

Operational cadence and commands for the coordinator-supervised RunPod
GPU execution chain. The live proofs live in `scripts/remote-e2e/`.

## Architecture at a glance

- **Coordinator** (Cloudflare Durable Object, `coordinator/`): owns the
  Pod lifecycle — create, cache verification, worker readiness, idle
  timeout, hard deadline, cleanup. Deploy: `npm run coordinator:deploy`.
- **Watchdog** (Cloudflare Worker + KV leases, `watchdog/`): independent
  sweeper (cron every 2 min) that terminates Pods violating their lease.
  Deploy: `npm run watchdog:deploy`. It consumes the RAW RunPod REST v1
  Pod shape — test against `fixtures/runpod-rest-v1/`, never hand mocks.
- **Worker image** (`glimmer-orchestrator-main` branch): built by the
  `runpod-image.yml` workflow, dispatched from the `main` ref with
  `publish_image=true`. The digest is pinned in
  `~/.muse-glimmer/compute.json` (`imageDigest` as a full OCI reference,
  `workerBuildId` as `r2-<12 hex of the orchestrator commit>`).
- **Gateway** (`server/`, bundled into the app): routes sessions to the
  GPU worker when cloud compute is ready. After ANY gateway change:
  `./src-tauri/scripts/prepare-gateway.sh && rsync -a --delete
src-tauri/resources/gateway/ "/Applications/Glimmer Control
Center.app/Contents/Resources/resources/gateway/" && codesign -f -s -
"/Applications/Glimmer Control Center.app"` — then grep the bundle for
  a new symbol to prove it landed.

## Monthly

- **Roll the Ubuntu snapshot pin** (orchestrator branch): the date
  appears in `docker/runpod/jammy-snapshot.sources.list`,
  `docker/runpod/image-lock.json`, and `scripts/verify-runpod-image.sh`.
  Probe the new date first:
  `curl -so /dev/null -w "%{http_code}" https://snapshot.ubuntu.com/ubuntu/<DATE>/dists/jammy/InRelease`
  (expect 200; the mirror throws transient 5xx — retry later, not harder).
  Then dispatch the image workflow, pin the new digest, and run one
  `--mode inspect` E2E as regression.

## Quarterly / dated

- **ghcr pull PAT** (`glimmer-ghcr-readonly`, scope `read:packages`):
  expires around 2026-12-01. Rotate in GitHub settings, update the
  container registry auth in RunPod, run one E2E.
- **RunPod balance**: check with the GraphQL `myself { clientBalance }`
  query or the console. A100 runs cost ~$1.59/h; typical E2E ~$0.05-0.15.

## After any compute-related change

```
node scripts/remote-e2e/remote-session-e2e.mjs --worktree <clean glimmer/* worktree> --mode verify
```

Expect `verified`, artifacts synced, and `provider_final {"podCount":0}`.
Add `--kill-mid-run` to also prove restart recovery.

## Known sharp edges

- `compute.json` is validated as a whole: ONE out-of-set value silently
  degrades to defaults (no coordinator access → 412 everywhere). The
  gateway logs a loud error since 2026-09-06; if compute suddenly reports
  412/unavailable, check that log line first.
- GPU availability is per data center (the network volume lives in
  EUR-IS-1); the public catalog's availability flag is global. L40S is in
  the allowed GPU set but NOT in the production profile — its 48GB fit
  for the 65k-context stack is unproven (the trial run never got
  capacity). Prove it with a `--mode verify` run before adding it.
- The snapshot mirror (snapshot.ubuntu.com) has multi-minute 5xx
  outages; image builds that fail there succeed on retrigger.
- One unreproduced compute.test flake was observed during an on-Pod
  verification run (2026-09-07); 5 isolated + 2 full-suite runs in the
  exact image could not reproduce it. Working hypothesis: CPU contention
  with llama-server during live runs. If it recurs, the session's
  orchestrator.log carries the failure output — investigate then, not
  preemptively.
- Never build llama.cpp without `-DGGML_NATIVE=OFF` — CI runners leak
  AMX/AVX-512 into the binary and Pods on older hosts die with
  "Illegal instruction".
