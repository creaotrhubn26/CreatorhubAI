import { createHmac, webcrypto } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunPodV2Error } from "./runpod-v2.js";
import { ComputeCoordinator } from "./worker.js";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const INGEST_TOKEN = "I".repeat(43);
const WATCHDOG_TOKEN = "W".repeat(43);
const JOB_KEY = Buffer.alloc(32, 7).toString("base64url");
const BOOTSTRAP_TOKEN = "B".repeat(43);
const JOB_ID = "12345678-1234-4123-8123-123456789abc";
const IMAGE = `ghcr.io/example/glimmer@sha256:${"a".repeat(64)}`;

class MemoryStorage {
  values = new Map();
  alarmAt = null;

  async get(key) {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async setAlarm(value) {
    this.alarmAt = value;
  }
}

let privateKey;
let publicKey;

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

beforeAll(async () => {
  const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  privateKey = base64url(await webcrypto.subtle.exportKey("pkcs8", pair.privateKey));
  publicKey = base64url(await webcrypto.subtle.exportKey("raw", pair.publicKey));
});

function environment(patch = {}) {
  return {
    RUNPOD_API_KEY: `rpa_${"k".repeat(48)}`,
    RUNPOD_API_BASE_URL: "https://api.runpod.test",
    INGEST_TOKEN,
    WATCHDOG_URL: "https://watchdog.example",
    WATCHDOG_INGEST_TOKEN: WATCHDOG_TOKEN,
    COORDINATOR_PUBLIC_URL: "https://coordinator.example",
    CACHE_SIGNING_PRIVATE_KEY: privateKey,
    CACHE_SIGNING_PUBLIC_KEY: publicKey,
    JOB_ENCRYPTION_KEY: JOB_KEY,
    CPU_CACHE_MAX_HOURLY_USD: "0.0225",
    CPU_CACHE_TTL_SECONDS: "1680",
    CACHE_REPAIR_GPU_FALLBACK_ID: "NVIDIA L4",
    CACHE_REPAIR_GPU_MAX_HOURLY_USD: "0.49",
    CACHE_REPAIR_MAX_TOTAL_USD: "0.25",
    ...patch,
  };
}

function jobRequest(patch = {}) {
  return {
    schemaVersion: 1,
    jobId: JOB_ID,
    ownerInstanceId: "creatorhub-mac",
    kind: "gpu_worker",
    image: IMAGE,
    buildId: "r2-abcdef012345",
    containerRegistryAuthId: "registry-1",
    networkVolumeId: "volume-1",
    contextTokens: 65_536,
    modelArtifacts: {
      model: { url: "https://models.example/model.gguf", sha256: "b".repeat(64) },
      mmproj: { url: "https://models.example/mmproj.gguf", sha256: "c".repeat(64) },
      draftModel: { url: "https://models.example/draft.gguf", sha256: "d".repeat(64) },
      allowedHosts: ["models.example"],
    },
    maxHourlyUsd: 1.75,
    hardDeadlineAt: new Date(NOW + 7_200_000).toISOString(),
    idleTimeoutSeconds: 300,
    gpuTypeId: "NVIDIA A100 80GB PCIe",
    bootstrapToken: BOOTSTRAP_TOKEN,
    ...patch,
  };
}

function signedRequest(method, path, value = undefined) {
  const body = value === undefined ? "" : JSON.stringify(value);
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", INGEST_TOKEN)
    .update(`${method}\n${path}\n${timestamp}\n${body}`)
    .digest("hex");
  return new Request(`https://coordinator.example${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      "X-Glimmer-Timestamp": timestamp,
      "X-Glimmer-Signature": `v1=${signature}`,
    },
    ...(body ? { body } : {}),
  });
}

function callbackRequest(token, value) {
  return new Request(`https://coordinator.example/v1/jobs/${JOB_ID}/callback`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

function coordinator(storage = new MemoryStorage()) {
  return { instance: new ComputeCoordinator({ storage }, environment()), storage };
}

function responsePod(request, kind) {
  return {
    id: kind === "cpu" ? "cpu-pod-1" : "gpu-pod-1",
    name: request.name,
    status: "RUNNING",
    cloud: "SECURE",
    cost: kind === "cpu" ? 0.02 : 1.2,
    dataCenterId: "EU-RO-1",
    mounts: { network: request.mounts.network },
    ...(kind === "cpu"
      ? { cpu: { ...request.cpu, memory: 8 }, gpu: null }
      : { gpu: { ...request.gpu, memory: 80 }, cpu: null }),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

describe("cloud coordinator ingress", () => {
  it("uses the bound watchdog Worker while preserving HMAC authentication", async () => {
    const storage = new MemoryStorage();
    const watchdogFetch = vi.fn(async (request) => {
      expect(request).toBeInstanceOf(Request);
      expect(new URL(request.url).pathname).toBe("/v1/status");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("X-Glimmer-Signature")).toMatch(/^v1=[a-f0-9]{64}$/);
      return Response.json({
        service: "glimmer-compute-watchdog",
        schemaVersion: 1,
        ready: true,
        checkedAt: new Date(NOW).toISOString(),
        lastSweepAt: new Date(NOW).toISOString(),
        staleAfterSeconds: 180,
      });
    });
    const env = { ...environment(), WATCHDOG: { fetch: watchdogFetch } };
    const instance = new ComputeCoordinator({ storage }, env);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("global fetch disabled"))),
    );

    const status = await instance.fetch(signedRequest("GET", "/v1/status"));

    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ ready: true, watchdogReady: true });
    expect(watchdogFetch).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is authenticated, idempotent, secret-free, and persists intent before any provider call", async () => {
    const { instance, storage } = coordinator();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).endsWith("/v1/status")) {
          return Response.json({
            service: "glimmer-compute-watchdog",
            schemaVersion: 1,
            ready: true,
            checkedAt: new Date(NOW).toISOString(),
            lastSweepAt: new Date(NOW).toISOString(),
            staleAfterSeconds: 180,
          });
        }
        throw new Error("provider must not be called during ingress");
      }),
    );
    const status = await instance.fetch(signedRequest("GET", "/v1/status"));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      ready: true,
      providerApiVersion: "v2",
      watchdogReady: true,
      activeJobId: null,
      cacheSigning: { algorithm: "Ed25519", publicKey },
    });

    const path = `/v1/jobs/${JOB_ID}`;
    const first = await instance.fetch(signedRequest("PUT", path, jobRequest()));
    expect(first.status).toBe(202);
    const firstJob = await first.json();
    expect(firstJob).toMatchObject({
      jobId: JOB_ID,
      phase: "cache_repair",
      cache: { state: "missing" },
      createAttempted: false,
    });
    expect(JSON.stringify(firstJob)).not.toContain(BOOTSTRAP_TOKEN);
    expect(JSON.stringify(await storage.get(`job:${JOB_ID}`))).not.toContain(BOOTSTRAP_TOKEN);
    expect(storage.alarmAt).not.toBeNull();

    const repeated = await instance.fetch(signedRequest("PUT", path, jobRequest()));
    expect(repeated.status).toBe(200);
    const conflict = await instance.fetch(
      signedRequest("PUT", path, jobRequest({ maxHourlyUsd: 1.5 })),
    );
    expect(conflict.status).toBe(409);
  });

  it("rejects a repair configuration whose TTL plus watchdog margin can exceed its total cap", async () => {
    const storage = new MemoryStorage();
    const instance = new ComputeCoordinator(
      { storage },
      environment({ CPU_CACHE_TTL_SECONDS: "1800" }),
    );
    const status = await instance.fetch(signedRequest("GET", "/v1/status"));
    expect(status.status).toBe(503);
    expect(await status.json()).toEqual({ error: "COORDINATOR_NOT_CONFIGURED" });
  });

  it("rejects a syntactically valid but non-allowlisted cache-repair GPU", async () => {
    const storage = new MemoryStorage();
    const instance = new ComputeCoordinator(
      { storage },
      environment({ CACHE_REPAIR_GPU_FALLBACK_ID: "NVIDIA RTX 4090" }),
    );
    const status = await instance.fetch(signedRequest("GET", "/v1/status"));
    expect(status.status).toBe(503);
    expect(await status.json()).toEqual({ error: "COORDINATOR_NOT_CONFIGURED" });
  });

  it("accepts only a GPU phase runtime whose hourly ceiling plus delete margin fits its total cap", async () => {
    const accepted = coordinator().instance;
    const path = `/v1/jobs/${JOB_ID}`;
    const bounded = await accepted.fetch(
      signedRequest(
        "PUT",
        path,
        jobRequest({
          maxHourlyUsd: 2.09,
          gpuMaxRuntimeSeconds: 480,
          maxTotalUsd: 0.35,
        }),
      ),
    );
    expect(bounded.status).toBe(202);
    expect(await bounded.json()).toMatchObject({
      phaseDeadlineAt: new Date(NOW + 1_680_000).toISOString(),
      maxHourlyUsd: 2.09,
      maxTotalUsd: 0.35,
    });

    const rejected = coordinator().instance;
    const overBudget = await rejected.fetch(
      signedRequest(
        "PUT",
        path,
        jobRequest({
          maxHourlyUsd: 2.09,
          gpuMaxRuntimeSeconds: 480,
          maxTotalUsd: 0.34,
        }),
      ),
    );
    expect(overBudget.status).toBe(400);
    expect(await overBudget.json()).toEqual({ error: "INVALID_GPU_BUDGET" });
  });
});

describe("cache-gated lifecycle", () => {
  it("starts the GPU phase with its own bounded deadline instead of the outer cache deadline", async () => {
    const { instance } = coordinator();
    const job = {
      jobId: JOB_ID,
      hardDeadlineAt: new Date(NOW + 3_600_000).toISOString(),
      internal: {
        request: { gpuMaxRuntimeSeconds: 480 },
        createIntentAt: "stale",
        callbackTokenHash: "stale",
        exitObservedAt: "stale",
        workerObservedAt: "stale",
        repairRequested: false,
      },
    };

    await instance.transitionToGpu(job);

    expect(job.phase).toBe("gpu_worker");
    expect(job.currentDeadlineAt).toBe(new Date(NOW + 480_000).toISOString());
    expect(job.state).toBe("cache_ready");
  });

  it("starts CPU first, signs in the coordinator, and starts GPU only after publication", async () => {
    const { instance } = coordinator();
    const creates = [];
    let cpuPresent = true;
    let gpuPresent = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init = {}) => {
        const target = String(url);
        if (target.startsWith("https://watchdog.example/")) {
          return target.endsWith("/v1/status")
            ? Response.json({
                service: "glimmer-compute-watchdog",
                schemaVersion: 1,
                ready: true,
                checkedAt: new Date(NOW).toISOString(),
                lastSweepAt: new Date(NOW).toISOString(),
                staleAfterSeconds: 180,
              })
            : Response.json({
                accepted: true,
                leaseId: JSON.parse(init.body).leaseId,
              });
        }
        if (target.endsWith("/network-volumes/volume-1")) {
          return Response.json({
            id: "volume-1",
            dataCenter: "EU-RO-1",
            size: 30,
            type: "STANDARD",
          });
        }
        if (target.endsWith("/registries/registry-1")) {
          return Response.json({ id: "registry-1", name: "ghcr" });
        }
        if (target.includes("/catalog/cpus")) {
          return Response.json({
            cpus: [
              {
                id: "cpu3c",
                vcpu: { min: 2, max: 4 },
                price: { securePerVcpu: 0.01 },
                availability: "HIGH",
                dataCenters: [{ id: "EU-RO-1", availability: "HIGH" }],
              },
            ],
          });
        }
        if (target.endsWith("/v2/pods") && init.method === "POST") {
          const request = JSON.parse(init.body);
          creates.push(request);
          if (request.cpu) cpuPresent = true;
          if (request.gpu) gpuPresent = true;
          return Response.json(responsePod(request, request.cpu ? "cpu" : "gpu"), { status: 201 });
        }
        if (target.endsWith("/v2/pods/cpu-pod-1") && init.method === "DELETE") {
          cpuPresent = false;
          return new Response(null, { status: 204 });
        }
        if (target.endsWith("/v2/pods/cpu-pod-1")) {
          return cpuPresent
            ? Response.json(responsePod(creates[0], "cpu"))
            : Response.json({}, { status: 404 });
        }
        if (target.endsWith("/v2/pods/gpu-pod-1") && init.method === "DELETE") {
          gpuPresent = false;
          return new Response(null, { status: 204 });
        }
        if (target.endsWith("/v2/pods/gpu-pod-1")) {
          return gpuPresent
            ? Response.json(
                responsePod(
                  creates.find((entry) => entry.gpu),
                  "gpu",
                ),
              )
            : Response.json({}, { status: 404 });
        }
        throw new Error(`unexpected request ${init.method ?? "GET"} ${target}`);
      }),
    );

    const path = `/v1/jobs/${JOB_ID}`;
    await instance.fetch(signedRequest("PUT", path, jobRequest()));
    await instance.alarm();
    expect(creates).toHaveLength(1);
    expect(creates[0].cpu).toEqual({ id: "cpu3c", vcpuCount: 2 });
    expect(creates[0].env.GLIMMER_CACHE_SIGNING_PRIVATE_KEY).toBeUndefined();
    expect(creates[0].env.GLIMMER_CACHE_SIGNING_PUBLIC_KEY).toBe(publicKey);
    const callbackToken = creates[0].env.GLIMMER_COORDINATOR_CALLBACK_TOKEN;

    const signed = {
      schemaVersion: 1,
      volumeId: "volume-1",
      buildId: "r2-abcdef012345",
      createdAt: new Date(NOW).toISOString(),
      artifacts: [
        {
          kind: "model",
          path: `model.${"b".repeat(64)}.gguf`,
          sha256: "b".repeat(64),
          bytes: 20_000,
        },
        {
          kind: "mmproj",
          path: `mmproj.${"c".repeat(64)}.gguf`,
          sha256: "c".repeat(64),
          bytes: 2_000,
        },
        {
          kind: "draft",
          path: `dflash.${"d".repeat(64)}.gguf`,
          sha256: "d".repeat(64),
          bytes: 1_000,
        },
      ],
    };
    const pending = await instance.getJob(JOB_ID);
    const wrongBuild = await instance.fetch(
      callbackRequest(callbackToken, {
        schemaVersion: 1,
        type: "cache_attestation",
        observedAt: new Date(NOW).toISOString(),
        cacheKey: pending.cacheKey,
        signed: { ...signed, buildId: "r2-000000000000" },
      }),
    );
    expect(wrongBuild.status).toBe(409);
    const attestation = await instance.fetch(
      callbackRequest(callbackToken, {
        schemaVersion: 1,
        type: "cache_attestation",
        observedAt: new Date(NOW).toISOString(),
        cacheKey: pending.cacheKey,
        signed,
      }),
    );
    expect(attestation.status).toBe(200);
    const attested = await attestation.json();
    expect(attested.document.signature).toMatchObject({ algorithm: "ed25519" });
    expect(creates).toHaveLength(1);

    const published = await instance.fetch(
      callbackRequest(callbackToken, {
        schemaVersion: 1,
        type: "cache_published",
        observedAt: new Date(NOW).toISOString(),
        cacheKey: pending.cacheKey,
        manifest: attested.document,
      }),
    );
    expect(published.status).toBe(200);
    expect((await published.json()).job.cache.state).toBe("ready");
    expect((await instance.getJob(JOB_ID)).failureCode).toBeUndefined();
    expect(creates).toHaveLength(1);

    await instance.alarm();
    expect(creates).toHaveLength(1);
    await instance.alarm();
    expect(creates).toHaveLength(2);
    expect(creates[1].gpu).toEqual({ id: "NVIDIA A100 80GB PCIe", count: 1 });
    expect(creates[1].env.GLIMMER_CACHE_SIGNING_PRIVATE_KEY).toBeUndefined();
    expect(creates[1].env.GLIMMER_CACHE_SIGNING_PUBLIC_KEY).toBe(publicKey);
    expect(creates[1].env.GLIMMER_CACHE_BUILD_ID).toBe("r2-abcdef012345");

    const gpuCallbackToken = creates[1].env.GLIMMER_COORDINATOR_CALLBACK_TOKEN;
    const invalid = await instance.fetch(
      callbackRequest(gpuCallbackToken, {
        schemaVersion: 1,
        type: "cache_invalid",
        observedAt: new Date(NOW).toISOString(),
        cacheKey: pending.cacheKey,
      }),
    );
    expect(invalid.status).toBe(200);
    await instance.alarm();
    await instance.alarm();
    expect(creates).toHaveLength(3);
    expect(creates[2].cpu).toEqual({ id: "cpu3c", vcpuCount: 2 });
  });

  it("uses the exact bounded L4 fallback only when automatic CPU repair is unavailable", async () => {
    const { instance, storage } = coordinator();
    const creates = [];
    const leases = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init = {}) => {
        const target = String(url);
        if (target.startsWith("https://watchdog.example/")) {
          if (target.endsWith("/v1/status")) {
            return Response.json({
              service: "glimmer-compute-watchdog",
              schemaVersion: 1,
              ready: true,
              checkedAt: new Date(NOW).toISOString(),
              lastSweepAt: new Date(NOW).toISOString(),
              staleAfterSeconds: 180,
            });
          }
          const lease = JSON.parse(init.body);
          leases.push(lease);
          return Response.json({ accepted: true, leaseId: lease.leaseId });
        }
        if (target.endsWith("/network-volumes/volume-1")) {
          return Response.json({
            id: "volume-1",
            dataCenter: "EUR-IS-1",
            size: 30,
            type: "STANDARD",
          });
        }
        if (target.endsWith("/registries/registry-1")) {
          return Response.json({ id: "registry-1", name: "ghcr" });
        }
        if (target.includes("/catalog/cpus")) {
          return Response.json({
            cpus: [
              {
                id: "cpu3c",
                vcpu: { min: 2, max: 4 },
                price: { securePerVcpu: 0.03 },
                availability: "NONE",
              },
            ],
          });
        }
        if (target.includes("/catalog/gpus")) {
          return Response.json({
            gpus: [
              {
                id: "NVIDIA L4",
                name: "L4",
                memory: 24,
                secure: true,
                price: { secure: 0.49, community: 0.31 },
                availability: "LOW",
                dataCenters: [{ id: "EUR-IS-1", name: "EUR-IS-1", availability: "LOW" }],
              },
              {
                id: "NVIDIA RTX PRO 6000 Blackwell Server Edition",
                name: "RTX PRO 6000",
                memory: 96,
                secure: true,
                price: { secure: 2.09, community: 1.69 },
                availability: "LOW",
                dataCenters: [{ id: "EUR-IS-1", name: "EUR-IS-1", availability: "LOW" }],
              },
            ],
          });
        }
        if (target.endsWith("/v2/pods") && init.method === "POST") {
          const request = JSON.parse(init.body);
          creates.push(request);
          return Response.json({ ...responsePod(request, "gpu"), cost: 0.49 }, { status: 201 });
        }
        throw new Error(`unexpected request ${init.method ?? "GET"} ${target}`);
      }),
    );

    const path = `/v1/jobs/${JOB_ID}`;
    await instance.fetch(
      signedRequest(
        "PUT",
        path,
        jobRequest({
          gpuTypeId: "NVIDIA RTX PRO 6000 Blackwell Server Edition",
          maxHourlyUsd: 2.09,
        }),
      ),
    );
    await instance.alarm();

    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      disk: 20,
      ports: [],
      cloud: "SECURE",
      dataCenterIds: ["EUR-IS-1"],
      gpu: { id: "NVIDIA L4", count: 1 },
    });
    expect(leases.at(-1)).toMatchObject({
      jobKind: "gpu_cache",
      maxHourlyUsd: 0.49,
      expected: {
        cloud: "SECURE",
        gpuCount: 1,
        gpuTypeId: "NVIDIA L4",
        networkVolumeId: "volume-1",
      },
    });
    expect(leases.at(-1).hardDeadlineAt).toBe(new Date(NOW + 1_680_000).toISOString());
    expect((await storage.get(`job:${JOB_ID}`)).internal.repairAllocation).toEqual({
      kind: "gpu",
      resourceId: "NVIDIA L4",
      maxHourlyUsd: 0.49,
      observedHourlyUsd: 0.49,
    });
  });

  it("waits cost-free for the exact bounded repair GPU instead of failing or widening", async () => {
    const { instance, storage } = coordinator();
    const path = `/v1/jobs/${JOB_ID}`;
    await instance.fetch(signedRequest("PUT", path, jobRequest()));
    vi.spyOn(instance, "advance").mockRejectedValueOnce(
      new RunPodV2Error(
        "GPU_UNAVAILABLE",
        "the exact Secure GPU is unavailable at the volume data center within the ceiling",
      ),
    );

    await instance.alarm();

    expect(await instance.getJob(JOB_ID)).toMatchObject({
      state: "waiting_for_capacity",
      phase: "cache_repair",
      createAttempted: false,
      cleanup: { requested: false, confirmed: false },
      internal: { repairAllocation: null, terminalTarget: null },
    });
    expect((await instance.getJob(JOB_ID)).failureCode).toBeUndefined();
    expect(await storage.get("active-job")).toBe(JOB_ID);
    expect(storage.alarmAt).toBe(NOW + 30_000);
  });

  it("uses worker activity for idle expiry and leaves duplicate create outcomes untouched", async () => {
    const { instance } = coordinator();
    const duplicateClient = {
      listPods: vi.fn(async () => [
        { id: "duplicate-1", name: "glimmer-gpu-duplicate" },
        { id: "duplicate-2", name: "glimmer-gpu-duplicate" },
      ]),
      deletePod: vi.fn(),
    };
    await expect(
      instance.cleanupCurrent(
        {
          cleanup: { requested: false, confirmed: false },
          podName: "glimmer-gpu-duplicate",
          currentLeaseId: "duplicate-lease",
        },
        duplicateClient,
        { watchdogUrl: "https://watchdog.example" },
      ),
    ).rejects.toThrow("DUPLICATE_CREATE_OUTCOME");
    expect(duplicateClient.deletePod).not.toHaveBeenCalled();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init = {}) => {
        const target = String(url);
        if (target.startsWith("https://watchdog.example/")) {
          return Response.json({
            accepted: true,
            leaseId: JSON.parse(init.body ?? "{}").leaseId,
          });
        }
        if (target.endsWith("/v2/pods/gpu-idle")) {
          return Response.json({
            id: "gpu-idle",
            name: "glimmer-gpu-idle",
            status: "RUNNING",
            cloud: "SECURE",
            cost: 1.2,
            dataCenterId: "EU-RO-1",
            mounts: { network: [{ volumeId: "volume-1", path: "/workspace" }] },
            gpu: { id: "A100", count: 1, memory: 80 },
            cpu: null,
          });
        }
        throw new Error(`unexpected request ${target}`);
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue(NOW + 301_000);
    const job = {
      phase: "gpu_worker",
      state: "ready",
      podId: "gpu-idle",
      podName: "glimmer-gpu-idle",
      currentLeaseId: "idle-lease",
      currentDeadlineAt: new Date(NOW + 3_600_000).toISOString(),
      hardDeadlineAt: new Date(NOW + 3_600_000).toISOString(),
      maxHourlyUsd: 1.75,
      cache: { state: "ready" },
      cleanup: { requested: false, confirmed: false },
      createAttempted: true,
      internal: {
        request: { networkVolumeId: "volume-1", idleTimeoutSeconds: 300 },
        workerState: "ready",
        workerObservedAt: new Date(NOW).toISOString(),
        repairRequested: false,
        terminalTarget: null,
      },
    };
    await instance.advance(job, {
      runpodBaseUrl: "https://api.runpod.test/v2",
      watchdogUrl: "https://watchdog.example",
    });
    expect(job.state).toBe("terminating");
    expect(job.internal.terminalTarget).toBe("terminated");
    expect(job.lastHeartbeatAt).toBeUndefined();
  });

  it("fails a cache repair at its CPU deadline without ever starting a GPU", async () => {
    const { instance, storage } = coordinator();
    const path = `/v1/jobs/${JOB_ID}`;
    await instance.fetch(signedRequest("PUT", path, jobRequest()));
    const job = await instance.getJob(JOB_ID);
    job.currentDeadlineAt = new Date(NOW - 1_000).toISOString();
    await storage.put(`job:${JOB_ID}`, job);
    const posts = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init = {}) => {
        const target = String(url);
        if (target.endsWith("/v2/pods?includeClusterPods=true")) {
          return Response.json({ pods: [] });
        }
        if (target.startsWith("https://watchdog.example/") && init.method === "DELETE") {
          return Response.json({ deleted: true, leaseId: job.currentLeaseId });
        }
        if (init.method === "POST") posts.push(target);
        throw new Error(`unexpected request ${init.method ?? "GET"} ${target}`);
      }),
    );

    await instance.alarm();

    expect(await instance.getJob(JOB_ID)).toMatchObject({
      state: "failed",
      failureCode: "CACHE_REPAIR_DEADLINE",
      cleanup: { requested: true, confirmed: true },
    });
    expect(posts).toEqual([]);
    expect(await storage.get("active-job")).toBeUndefined();
  });
});
