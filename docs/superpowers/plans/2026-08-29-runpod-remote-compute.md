# RunPod remote compute for Glimmer

**Status:** implementation-ready plan  
**Control Center base:** `784cb662c1cdebe10bad0295bdf866a8d33f9dba`  
**Orchestrator base:** `3d5fcba94a504492de5d6d187257642900f2c59b`  
**Scope:** local branches and worktrees only; no push, merge, deployment, or paid RunPod resource is authorized by this plan.

## Outcome

Glimmer can execute an entire coding session on one RunPod Secure Cloud GPU, including model inference, tools, repository indexing, tests, and repair loops. The Mac remains the trusted controller and canonical copy of the repository. It performs only bounded packaging, encrypted checkpoint transfer, status polling, and result validation.

The first production profile uses one Secure Cloud A100 80 GB. H100 is an explicit latency profile, never an automatic price escalation. The local backend remains the default until the remote path has passed live acceptance.

## Why the complete job must move

Today the Control Center starts `glimmer-v2.py` as a detached local process in `server/src/lib/runner.ts`. The session route records a local PID and reconciles it after a gateway restart in `server/src/routes/sessions.ts`. The orchestrator can address an OpenAI-compatible remote model, but ordinary file and shell tools are served through the llama.cpp `/tools` endpoint. Pointing the model registry at a remote URL therefore moves inference but does not create a complete remote Glimmer runtime.

The compatible extension is a second run backend:

- `local_process`: current behavior, unchanged.
- `runpod_pod`: a complete Linux worker containing the orchestrator, llama.cpp server, tool executor, repository copy, and verification runtimes.

`POST /api/sessions/:id/run` keeps one entry point and delegates to the configured backend after the existing Git branch and workspace-lease checks.

## Current flow

```text
Web composer
  -> local gateway
  -> validate glimmer/* worktree and acquire workspace lease
  -> spawn bundled glimmer-v2.py on the Mac
  -> local llama-server performs inference and /tools
  -> orchestrator writes directly in the local worktree
  -> local PID, Git state, and session artifacts drive recovery
```

## Target flow

```text
Web composer
  -> local gateway (origin + per-launch capability)
  -> validate glimmer/* worktree and acquire workspace lease
  -> compute policy: local or RunPod; A100 or explicit H100
  -> create/resume one Secure Cloud Pod within the price ceiling
  -> authenticate the short-request worker API
  -> upload a checksummed Git bundle in bounded chunks
  -> worker creates an isolated glimmer/* worktree on container disk
  -> worker runs llama.cpp + Glimmer + tools + tests remotely
  -> gateway polls status and downloads encrypted checkpoints/results
  -> gateway verifies session ID, base SHA, paths, checksums, and result commit
  -> apply result only when the local base still matches
  -> reconcile provider billing
  -> terminate/stop compute when the queue is empty and idle timeout expires
```

The RunPod HTTP proxy has a 100-second connection ceiling, so the worker protocol uses short idempotent requests and polling. No model generation, test run, or session stream is held open through the proxy.

## Architectural decisions

### Control plane and trust boundary

The Control Center remains authoritative for workspace selection, task contracts, budget policy, and acceptance. The RunPod worker is treated as a remote executor, not as the source of truth.

- The RunPod account API key is stored only in a gateway-owned file under `~/.muse-glimmer/compute-keys`, mode `0600`.
- The account key is never sent to the Pod, browser, session event, support bundle, environment dump, or model prompt.
- Pod creation uses `cloudType: SECURE`, `gpuCount: 1`, on-demand/non-interruptible compute, and an image pinned by digest.
- The worker exposes one HTTPS-proxied port. Every endpoint except a minimal liveness response requires a timing-safe bearer capability.
- The bootstrap capability is generated per Pod, stored as a secret, redacted from diagnostics, and rotated after a successful controller/worker handshake.
- The public proxy is not trusted to provide application authentication.
- All transfer manifests include schema version, instance ID, session ID, repository fingerprint, baseline SHA, byte length, and SHA-256.
- Incoming paths are relative, normalized, and rejected on absolute paths, `..`, symlinks, device files, or containment escape.
- A returned result is never applied if the local branch, base SHA, or workspace lease changed. The session becomes `needs_review` instead.

Existing `localOnlyGuard` protection remains the outer boundary for all new local write endpoints. No user-supplied value becomes a shell command; RunPod and worker calls use typed JSON and fixed executables.

### Storage and data lifecycle

Production uses a small RunPod network volume for the public model, verified runtime cache, and encrypted recovery blobs. The working repository remains on the Pod's container disk.

This choice makes idle cleanup economical: the Pod can be terminated and recreated while the network volume remains. RunPod does not allow a Pod with a network volume to be stopped, so the lifecycle controller maps idle shutdown to `terminate`, not `stop`, for this profile.

- Raw source exists remotely only on the active Pod's temporary container disk.
- Recovery and result bundles written to the network volume are encrypted on the worker with an ephemeral per-session key delivered during the authenticated handshake.
- The Mac downloads and validates each durable checkpoint. The network-volume ciphertext is removed after local acknowledgement.
- Public model/runtime files are content-addressed and checksum-verified before use.
- Termination is blocked while the newest durable result has not been acknowledged locally, unless the hard safety watchdog is firing; that case records `REMOTE_RESULT_AT_RISK` and preserves encrypted recovery data.
- A volume-disk profile is supported later for debugging, but is not the cost-default because stopped volume disk is billed at a higher storage rate and is tied to the Pod lease.

### Compute and cost policy

Default policy:

| Setting | Default |
| --- | --- |
| Backend | local until remote acceptance; then RunPod per user selection |
| Cloud | Secure Cloud only |
| GPUs | A100 80 GB PCIe, then A100 SXM4 80 GB |
| H100 | explicit `latency` profile only |
| GPU count | exactly 1 |
| Context | 65,536; 131,072 is task/profile opt-in |
| Idle timeout | 300 seconds |
| Clarification idle timeout | 120 seconds after checkpoint |
| Hard session limit | 2 hours |
| Concurrent Pods | 1 |
| Price behavior | fail closed above `maxGpuHourlyUsd`; no silent expensive fallback |
| Storage | network volume, model/cache plus encrypted checkpoints only |

The controller reads `adjustedCostPerHr` from the created/current Pod and refuses readiness if it exceeds the configured ceiling. A durable local interval ledger provides immediate burn-rate visibility, while in-process cleanup deadlines use monotonic timers. `GET /v1/billing/pods`, grouped by Pod ID, later reconciles provider-billed time and USD. Estimated and reconciled values are displayed separately.

Browser activity does not extend a compute lease. Only an active job, a worker checkpoint, or a bounded user clarification lease does.

### Independent runaway protection

The desktop gateway's idle timer is the primary controller, but it cannot protect against a Mac crash. Unattended paid execution is not accepted until a separately deployable watchdog is configured and live-tested.

The watchdog receives only a narrowly scoped RunPod key capable of listing and stopping/terminating Glimmer-tagged Pods. It evaluates durable lease records containing Pod ID, owner instance ID, hard deadline, last heartbeat, and maximum hourly rate. It never receives repository contents, model keys, or worker capabilities.

Initial deployment options are a tiny scheduled cloud function or another always-on low-cost service. The repository supplies the watchdog contract and reference implementation; choosing its host is an operational deployment decision and is not hidden inside the desktop app.

## Public types and persisted schemas

Add to `shared/src/types.ts`:

```ts
type ComputeBackend = "local_process" | "runpod_pod";
type ComputeRunState =
  | "offline"
  | "provisioning"
  | "bootstrapping"
  | "ready"
  | "busy"
  | "idle"
  | "stopping"
  | "stopped"
  | "terminating"
  | "failed"
  | "budget_blocked"
  | "unavailable";

interface ComputeConfigV1 {
  version: 1;
  enabled: boolean;
  defaultBackend: ComputeBackend;
  profiles: ComputeProfileV1[];
  activeProfileId?: string;
}

interface ComputeProfileV1 {
  id: string;
  label: string;
  provider: "runpod";
  cloudType: "SECURE";
  gpuTypeIds: string[];
  gpuCount: 1;
  contextTokens: 65_536 | 131_072;
  imageDigest: string;
  containerRegistryAuthId?: string;
  networkVolumeId?: string;
  maxGpuHourlyUsd: number;
  idleTimeoutSeconds: number;
  clarificationTimeoutSeconds: number;
  hardSessionLimitSeconds: number;
  dailyBudgetUsd?: number;
  monthlyBudgetUsd?: number;
  hasApiKey: boolean;
  watchdogConfigured: boolean;
}
```

Also add `ComputeStatus`, `ComputeLeaseV1`, `ComputeUsageSummary`, `RemoteJobManifestV1`, `RemoteCheckpointV1`, and `RemoteJobResultV1`. The account key is accepted only by an update DTO and is omitted from every public/read type.

`GatewayRunRecord` becomes a backward-readable union. Version 1 remains local. Version 2 adds `backend`, `remotePodId`, `remoteJobId`, `remoteState`, `estimatedCostUsd`, `lastRemoteCheckpoint`, and `resultAcknowledgedAt`. Existing records require no rewrite.

## Local gateway API

Add these routes under the existing `/api` guard:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/compute/config` | Public, secret-free compute configuration |
| `PUT` | `/compute/config` | Validate profiles; set/replace/clear API key atomically |
| `GET` | `/compute/status` | Provider state, active lease, GPU, rate, and readiness |
| `POST` | `/compute/start` | Explicit warm-up within policy and budget |
| `POST` | `/compute/stop` | Stop or terminate according to storage profile |
| `DELETE` | `/compute/pod` | Explicit destructive termination with exact Pod ID confirmation |
| `GET` | `/compute/usage` | Estimated and reconciled local aggregates |
| `POST` | `/compute/test` | Read-only credential/capacity check; never creates a Pod |

`POST /sessions/:id/run` and cancel/recovery endpoints stay source-compatible. The response may add `backend`, `remoteJobId`, and `computeState`; existing clients can ignore them.

## Worker protocol

The worker implements short, retry-safe endpoints:

| Method | Endpoint | Semantics |
| --- | --- | --- |
| `GET` | `/v1/health` | Build ID, readiness, loaded model, context, no secrets |
| `POST` | `/v1/handshake` | Rotate bootstrap token into a session capability |
| `POST` | `/v1/jobs` | Create one idempotent job from a signed manifest |
| `PUT` | `/v1/jobs/:id/input/:part` | Upload one checksummed bounded chunk |
| `POST` | `/v1/jobs/:id/start` | Assemble, verify, and start after all chunks exist |
| `GET` | `/v1/jobs/:id` | State, progress counters, checkpoint metadata |
| `GET` | `/v1/jobs/:id/checkpoints/:n` | Download encrypted checkpoint/result chunk |
| `POST` | `/v1/jobs/:id/checkpoints/:n/ack` | Confirm durable local receipt |
| `POST` | `/v1/jobs/:id/cancel` | Idempotent process-group cancellation |

Only one active job is accepted per Pod in the first version. Every mutation requires the Pod/session capability and an idempotency key. Worker stdout is structured and secret-redacted.

## Exact implementation surfaces

### CreatorHub Control Center

Modify:

- `shared/src/types.ts` — public compute, lease, usage, and remote-job types.
- `server/src/config.ts` — compute config path, key directory, and worker defaults.
- `server/src/app.ts` — mount the compute router; retain the global local-only guard.
- `server/src/lib/runState.ts` — additive V2 run records and remote reconciliation.
- `server/src/lib/runner.ts` — extract the current local runner behind `RunBackend`.
- `server/src/routes/sessions.ts` — backend selection, remote start/cancel/recovery, result validation.
- `server/src/lib/workspaceLeases.ts` — remote lease metadata without weakening exclusivity.
- `server/src/lib/modelStatus.ts` — compute-aware remote health; local probe unchanged.
- `server/src/routes/model.ts` — present model lifecycle through the active compute backend.
- `server/src/routes/diagnostics.ts` — secret-free remote readiness and watchdog status.
- `web/src/api/client.ts` — typed compute API methods.
- `web/src/components/model/ModelStatusScreen.tsx` — provider-neutral state, warm-up, stop, and burn rate.
- `web/src/components/settings/ModelRegistrySettings.tsx` — link model providers to compute status without changing registry V1.
- `web/src/components/settings/SettingsScreen.tsx` — add Compute settings section.
- `src-tauri/scripts/prepare-orchestrator.sh` and `scripts/verify-bundled-runtime.mjs` — repin the exact orchestrator worker snapshot and checksums when that milestone lands.

Add:

- `server/src/lib/compute/configStore.ts`
- `server/src/lib/compute/computeController.ts`
- `server/src/lib/compute/runpodClient.ts`
- `server/src/lib/compute/runpodSchemas.ts`
- `server/src/lib/compute/computeLeaseStore.ts`
- `server/src/lib/compute/usageLedger.ts`
- `server/src/lib/compute/remoteTransfer.ts`
- `server/src/lib/compute/remoteRunBackend.ts`
- `server/src/routes/compute.ts`
- `web/src/components/settings/ComputeSettings.tsx`
- `web/src/components/model/ComputeStatusPanel.tsx`
- focused `*.test.ts`/`*.test.tsx` files beside each module.

Use Node 20 built-in `fetch`, `crypto`, streams, and filesystem primitives. Do not add a RunPod SDK in the first version.

### Muse Glimmer orchestrator

Modify:

- `glimmer-v2.py` — accept the worker-provided job manifest and checkpoint sink.
- `glimmer-engineer.py` — preserve provider binding while allowing the worker-local tool endpoint.
- `glimmer_journal.py` — emit bounded, deterministic remote checkpoints.
- `glimmer_events.py` — add compute/job/checkpoint events without secrets.
- `start-glimmer.sh` — split Mac/Metal defaults from Linux/CUDA configuration.
- `Makefile` — worker unit/contract/image checks in `make quality`.

Add:

- `glimmer_remote.py` — versioned manifest/result/checkpoint validation.
- `runpod_worker.py` — authenticated job server and process supervisor.
- `Dockerfile.runpod` — digest-pinned Linux/CUDA worker image.
- `docker/runpod/entrypoint.sh` — fixed startup and readiness sequence.
- `docker/runpod/healthcheck.py`
- `scripts/build-runpod-image.sh`
- `scripts/verify-runpod-image.sh`
- `scripts/runpod-live-smoke.sh`
- `tests/test_glimmer_remote.py`
- `tests/test_runpod_worker.py`
- fixtures for traversal, stale SHA, interrupted upload, cancellation, checkpoint, and result recovery.

The model weights are not baked into the image. The worker downloads only the configured immutable model artifacts into the persistent cache and verifies expected hashes before readiness.

## Milestones and local commit boundaries

### R1 — compute lifecycle, configuration, and cost guard

Control Center only:

- Add types, secret store, RunPod REST client, state machine, budget ledger, routes, and settings/status UI.
- Mock all provider calls; no paid Pod is created by tests.
- Implement create/get/start/stop/delete and billing reconciliation against the current REST API.
- Enforce Secure Cloud, one GPU, image digest, allowed GPU IDs, hourly ceiling, daily/monthly budgets, and idempotent cleanup.
- Keep `defaultBackend: local_process`.

Acceptance: configuration round-trip, secret redaction, full provider state-transition tests, no local workflow regression, `npm run quality` green.

### R2 — reproducible remote worker and transport

Orchestrator first, then repin Control Center:

- Build the CUDA worker image with pinned digests and provenance.
- Implement authenticated job/chunk/checkpoint protocol and remote manifest validation.
- Start llama.cpp and its `/tools` implementation inside the worker.
- Verify 65k and 128k context startup separately.
- Add the remote `RunBackend` and fake-worker integration in Control Center.

Acceptance: all contract fixtures pass; image SBOM/checksums recorded; no source or secret in image layers/logs; both repository quality commands green.

### R3 — session execution, recovery, and safe result application

Both repositories:

- Route selected sessions remotely.
- Package the exact Git worktree state, including dirty/untracked non-ignored files, without unrelated filesystem data.
- Pull encrypted checkpoints, update durable gateway records, cancel remotely, and reconcile after app restart.
- Apply returned commits only after baseline and containment checks; otherwise use `needs_review`.
- Integrate clarification timeout with compute idle policy.

Acceptance: fake end-to-end remote edit/test/cancel/crash flows pass; stale local workspace is never overwritten; local backend remains byte-compatible.

### R4 — live economics, watchdog, and rollout

- Deploy the external watchdog and prove hard-deadline termination while the Mac/gateway is unavailable.
- Run the same fixed task set on local M5 Pro, Secure A100 80 GB, and explicit H100.
- Record cold start, warm start, tokens/second, task success, wall time, Mac CPU, GPU billed seconds, and reconciled USD.
- Choose A100 as production default unless H100 demonstrates a measured value worth its higher hourly rate.
- Enable remote backend only behind an explicit user setting after acceptance.

Acceptance: no active GPU five minutes after the last safe checkpoint and empty queue; one Pod maximum; budget ceiling cannot be bypassed; at least two intentional watchdog kills recover cleanly.

## Test matrix

### Unit and contract

- RunPod response validation, malformed JSON, 401/403/404/409/429/5xx, timeouts, and retry bounds.
- No-capacity and zero-GPU restart behavior.
- Price changes between create and ready.
- Daily/monthly budget boundary and clock/monotonic-time behavior.
- State transitions and duplicate start/stop/cancel calls.
- API key and bootstrap-token redaction in errors, logs, events, diagnostics, and support exports.
- Manifest forgery, wrong instance/session, stale SHA, oversized archive, checksum mismatch, duplicate chunks, decompression bomb, path traversal, symlink, and special-file rejection.
- Encrypted checkpoint tamper detection, replay rejection, and acknowledgement cleanup.
- Local/result branch divergence and workspace lease conflicts.

### Integration

- Fake RunPod REST server plus fake worker exercises start, warm-up, run, checkpoint, result, idle cleanup, and billing reconciliation.
- Real Git fixtures cover clean, dirty, untracked, ignored, submodule, worktree, and large-file cases.
- Gateway restart while provisioning, uploading, running, clarifying, downloading result, and terminating.
- Local model/session tests run unchanged.

### E2E

- Add/remove RunPod credential without it returning to the webview.
- Select A100 profile, see estimated ceiling, warm and stop compute.
- H100 requires explicit profile selection and confirmation of the displayed ceiling.
- Run/cancel/recover a remote session and display checkpoint/cost events.
- Budget-blocked and capacity-unavailable states provide recovery actions.
- Model settings continue to read V1 registries.

### Live acceptance

- `make quality` in the orchestrator worktree.
- `npm run quality` in the Control Center worktree.
- Bundled runtime preparation/sign/verification after every orchestrator pin.
- Linux worker import, parser, llama.cpp patch, model hash, tool, and signature/provenance checks.
- Fixed live task set at 65k and a targeted 128k task.
- Mac shows no local model or orchestrator process during a remote job; average Control Center CPU is measured separately from short archive/result-transfer bursts.

## Compatibility and rollback

- Compute config is additive and disabled by default.
- Model registry schema V1 is not migrated in R1; existing providers and adaptive routing continue to work.
- Gateway run V1 remains readable; only remote runs write V2.
- `local_process` can be selected immediately without deleting remote configuration.
- Failed remote startup releases the workspace lease and never falls through silently to a paid or differently priced GPU.
- Remote result application is transactional: validate first, then apply; preserve the bundle on failure.
- No milestone deletes a Pod or remote volume except through an exact-ID lifecycle operation. Termination UI states that container data is unrecoverable and requires explicit confirmation outside automatic idle policy.
- Each milestone is a separate local commit in both implementation worktrees. Control Center pins the exact orchestrator commit and file checksums after R2, R3, and R4.

## Prepared worktrees

- Control Center: `/private/tmp/creatorhub-glimmer-runpod-control`, branch `codex/glimmer-runpod-control`
- Orchestrator: `/private/tmp/glimmer-runpod-orchestrator`, branch `codex/glimmer-runpod-orchestrator`

Both are based on the completed seven-measure accuracy work and leave the original worktrees untouched.

## Implementation prerequisites

Before the first paid live smoke:

1. Create a RunPod API key for the controller and store it through the Compute settings UI; never commit it.
2. Create a RunPod container registry auth for the private GHCR package and enter only its ID in the active compute profile. Registry credentials remain in RunPod and are never stored by Glimmer.
3. Use the published worker image `ghcr.io/creaotrhubn26/glimmer-runpod-worker@sha256:1e5c6824ba31add182a65d5b50faef692c6f5c512fa6063c1e609d650c027c4c`. It was built from orchestrator commit `daf6d33b664227021c2830e374acc29e775d003a`, with OCI provenance and SBOM, then pulled and runtime-verified by GitHub Actions run `33391127738`.
4. Create a network volume sized for the verified model/runtime cache; do not store raw repository source there.
5. Set explicit hourly, daily, and monthly budgets.
6. Deploy and test the independent watchdog.
7. Authorize one controlled A100 smoke; H100 remains a separate explicit benchmark.

## Authoritative RunPod references

- REST API overview and OpenAPI: <https://docs.runpod.io/api-reference/overview>
- Create/list/get/start Pods: <https://docs.runpod.io/api-reference/pods/POST/pods>
- Create a private container registry auth: <https://docs.runpod.io/api-reference/container-registry-auths/POST/containerregistryauth>
- Pod lifecycle and stop/terminate behavior: <https://docs.runpod.io/pods/manage-pods>
- Storage persistence and pricing: <https://docs.runpod.io/pods/storage/types>
- HTTP proxy behavior and 100-second ceiling: <https://docs.runpod.io/pods/configuration/expose-ports>
- Pod billing history: <https://docs.runpod.io/api-reference/billing/GET/billing/pods>
