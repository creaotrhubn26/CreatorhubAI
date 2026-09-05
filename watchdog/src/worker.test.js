import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { sweep } from "./worker.js";

class MemoryKv {
  values = new Map();

  async get(key, type) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list({ prefix = "" }) {
    return {
      keys: [...this.values.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
    };
  }
}

const INGEST_TOKEN = "watchdog-ingest-token-that-is-long-enough";
const NOW = Date.parse("2026-08-30T12:00:00.000Z");

function environment() {
  return {
    LEASES: new MemoryKv(),
    INGEST_TOKEN,
    RUNPOD_API_KEY: "restricted-runpod-watchdog-key",
    RUNPOD_API_BASE_URL: "https://rest.runpod.io/v1",
    RUNPOD_API_V2_BASE_URL: "https://api.runpod.io/v2",
    STALE_AFTER_SECONDS: "180",
  };
}

function lease(patch = {}) {
  return {
    schemaVersion: 1,
    leaseId: "lease-1",
    ownerInstanceId: "instance-1",
    podName: "glimmer-instance-1-lease-1",
    podId: "pod_1",
    hardDeadlineAt: new Date(NOW + 3_600_000).toISOString(),
    lastHeartbeatAt: new Date(NOW).toISOString(),
    maxHourlyUsd: 1.75,
    ...patch,
  };
}

function leaseV2(patch = {}) {
  return {
    schemaVersion: 2,
    leaseId: "job-1",
    ownerInstanceId: "coordinator-1",
    jobKind: "cpu_cache",
    podName: "glimmer-cache-job-1",
    podId: "pod_v2_1",
    hardDeadlineAt: new Date(NOW + 2_700_000).toISOString(),
    lastHeartbeatAt: new Date(NOW).toISOString(),
    maxHourlyUsd: 0.0225,
    expected: {
      cloud: "SECURE",
      gpuCount: 0,
      networkVolumeId: "volume-1",
    },
    ...patch,
  };
}

// Mirrors the RAW RunPod REST v1 Pod shape (fixtures/runpod-rest-v1): the V2
// sweep consumes provider responses directly, never a parsed adaptation.
function cpuPodV2(patch = {}) {
  return {
    id: "pod_v2_1",
    name: "glimmer-cache-job-1",
    desiredStatus: "RUNNING",
    costPerHr: 0.02,
    cpuFlavorId: "cpu3c",
    vcpuCount: 2,
    machine: { secureCloud: true, dataCenterId: "EUR-IS-1" },
    networkVolume: { id: "volume-1", dataCenterId: "EUR-IS-1", size: 200, name: "glimmer-cache" },
    volumeMountPath: "/workspace",
    ...patch,
  };
}

const rawGpuFixture = () =>
  JSON.parse(readFileSync(new URL("../../fixtures/runpod-rest-v1/pod-gpu.json", import.meta.url)));

function signedRequest(method, path, body = "", timestamp = NOW) {
  const timestampText = String(timestamp);
  const signature = createHmac("sha256", INGEST_TOKEN)
    .update(`${method}\n${path}\n${timestampText}\n${body}`)
    .digest("hex");
  return new Request(`https://watchdog.example${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Glimmer-Timestamp": timestampText,
      "X-Glimmer-Signature": `v1=${signature}`,
    },
    ...(body ? { body } : {}),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

describe("watchdog HTTP contract", () => {
  it("stores, reports, and deletes an authenticated lease without returning secrets", async () => {
    const env = environment();
    await env.LEASES.put(
      "meta:last-sweep",
      JSON.stringify({ schemaVersion: 1, sweptAt: new Date(NOW).toISOString(), ok: true }),
    );
    const body = JSON.stringify(lease());
    const created = await worker.fetch(signedRequest("PUT", "/v1/leases/lease-1", body), env);
    expect(created.status).toBe(201);
    expect(await env.LEASES.get("lease:lease-1", "json")).toMatchObject({ podId: "pod_1" });

    const status = await worker.fetch(signedRequest("GET", "/v1/status"), env);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      service: "glimmer-compute-watchdog",
      ready: true,
      staleAfterSeconds: 180,
    });

    const deleted = await worker.fetch(signedRequest("DELETE", "/v1/leases/lease-1"), env);
    expect(deleted.status).toBe(200);
    expect(await env.LEASES.get("lease:lease-1", "json")).toBeNull();
    expect(await deleted.text()).not.toContain(INGEST_TOKEN);
  });

  it("rejects forged, stale, and identity-changing updates", async () => {
    const env = environment();
    const body = JSON.stringify(lease());
    const forged = signedRequest("PUT", "/v1/leases/lease-1", body);
    forged.headers.set("X-Glimmer-Signature", `v1=${"0".repeat(64)}`);
    expect((await worker.fetch(forged, env)).status).toBe(401);

    expect(
      (await worker.fetch(signedRequest("PUT", "/v1/leases/lease-1", body, NOW - 121_000), env))
        .status,
    ).toBe(401);

    expect((await worker.fetch(signedRequest("PUT", "/v1/leases/lease-1", body), env)).status).toBe(
      201,
    );
    const changed = JSON.stringify(
      lease({ hardDeadlineAt: new Date(NOW + 7_200_000).toISOString() }),
    );
    const response = await worker.fetch(signedRequest("PUT", "/v1/leases/lease-1", changed), env);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "LEASE_IDENTITY_CHANGED" });
  });

  it("rejects an oversized request body before authentication or KV access", async () => {
    const env = environment();
    const response = await worker.fetch(
      new Request("https://watchdog.example/v1/leases/lease-1", {
        method: "PUT",
        body: "x".repeat(8 * 1024 + 1),
      }),
      env,
    );
    expect(response.status).toBe(413);
    expect(env.LEASES.values.size).toBe(0);
  });
});

describe("watchdog sweep", () => {
  it.each([
    ["nested numeric", { gpu: { count: 1 } }],
    ["nested numeric string", { gpu: { count: "1" } }],
    ["top-level numeric", { gpuCount: 1 }],
    ["top-level numeric string", { gpuCount: "1" }],
    ["matching nested and top-level", { gpu: { count: "1" }, gpuCount: 1 }],
  ])("retains a valid Pod with %s GPU count metadata", async (_label, gpuMetadata) => {
    const env = environment();
    await env.LEASES.put("lease:lease-1", JSON.stringify(lease()));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        id: "pod_1",
        name: "glimmer-instance-1-lease-1",
        desiredStatus: "RUNNING",
        adjustedCostPerHr: 1.59,
        ...gpuMetadata,
      }),
    );

    await expect(sweep(env, NOW)).resolves.toMatchObject({
      ok: true,
      checked: 1,
      terminationRequests: 0,
    });
    expect(await env.LEASES.get("lease:lease-1", "json")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains a Pod whose provider response omits GPU count metadata entirely", async () => {
    // Live GPU Pods often carry the GPU only as machine metadata; absence of
    // a count is not a policy violation (the rate ceiling still applies).
    const env = environment();
    await env.LEASES.put("lease:lease-1", JSON.stringify(lease()));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        id: "pod_1",
        name: "glimmer-instance-1-lease-1",
        desiredStatus: "RUNNING",
        adjustedCostPerHr: 1.59,
      }),
    );

    await expect(sweep(env, NOW)).resolves.toMatchObject({
      ok: true,
      checked: 1,
      terminationRequests: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["fractional", { gpuCount: 1.5 }],
    ["negative", { gpu: { count: -1 } }],
    ["non-numeric string", { gpuCount: "one" }],
    ["unsafe integer", { gpuCount: "9007199254740992" }],
    ["contradictory", { gpu: { count: 1 }, gpuCount: 2 }],
  ])("terminates a Pod with %s GPU count metadata", async (_label, gpuMetadata) => {
    const env = environment();
    await env.LEASES.put("lease:lease-1", JSON.stringify(lease()));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({
        id: "pod_1",
        name: "glimmer-instance-1-lease-1",
        desiredStatus: "RUNNING",
        adjustedCostPerHr: 1.59,
        ...gpuMetadata,
      });
    });

    await expect(sweep(env, NOW)).resolves.toMatchObject({
      ok: true,
      checked: 1,
      terminationRequests: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://rest.runpod.io/v1/pods/pod_1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("retains a provisional lease with no name match until its hard deadline", async () => {
    const env = environment();
    await env.LEASES.put("lease:lease-1", JSON.stringify(lease({ podId: undefined })));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json([]));

    await expect(sweep(env, NOW)).resolves.toMatchObject({
      ok: true,
      checked: 1,
      terminationRequests: 0,
    });
    expect(await env.LEASES.get("lease:lease-1", "json")).not.toBeNull();

    await expect(sweep(env, NOW + 3_600_000)).resolves.toMatchObject({
      ok: true,
      checked: 1,
      terminationRequests: 0,
    });
    expect(await env.LEASES.get("lease:lease-1", "json")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://rest.runpod.io/v1/pods",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("terminates every exact-name match and retains the provisional lease when one fails", async () => {
    const env = environment();
    await env.LEASES.put("lease:lease-1", JSON.stringify(lease({ podId: undefined })));
    let firstPodDeleteAttempts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/pods") && !init?.method) {
        return Response.json([
          { id: "pod_first", name: "glimmer-instance-1-lease-1" },
          { id: "pod_second", name: "glimmer-instance-1-lease-1" },
          { id: "pod_unrelated", name: "another-lease" },
        ]);
      }
      if (url.endsWith("/pods/pod_first") && init?.method === "DELETE") {
        firstPodDeleteAttempts += 1;
        return firstPodDeleteAttempts === 1
          ? Response.json({ error: "unavailable" }, { status: 503 })
          : new Response(null, { status: 204 });
      }
      if (url.endsWith("/pods/pod_second") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${url}`);
    });

    await expect(sweep(env, NOW)).resolves.toMatchObject({
      ok: false,
      checked: 1,
      terminationRequests: 2,
      errorCodes: ["RUNPOD_HTTP_503"],
    });
    expect(await env.LEASES.get("lease:lease-1", "json")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://rest.runpod.io/v1/pods/pod_first",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://rest.runpod.io/v1/pods/pod_second",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("pod_unrelated"))).toBe(false);

    await expect(sweep(env, NOW + 120_000)).resolves.toMatchObject({
      ok: true,
      checked: 1,
      terminationRequests: 2,
      errorCodes: [],
    });
    expect(firstPodDeleteAttempts).toBe(2);
    expect(await env.LEASES.get("lease:lease-1", "json")).not.toBeNull();
  });

  it("retains an exact-id lease when the provider response body has another identity", async () => {
    const env = environment();
    await env.LEASES.put("lease:lease-1", JSON.stringify(lease()));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        id: "pod_other",
        name: "glimmer-instance-1-lease-1",
        desiredStatus: "TERMINATED",
      }),
    );

    await expect(sweep(env, NOW)).resolves.toMatchObject({
      ok: false,
      checked: 1,
      terminationRequests: 0,
      errorCodes: ["RUNPOD_POD_IDENTITY_MISMATCH"],
    });
    expect(await env.LEASES.get("lease:lease-1", "json")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries exact-id termination for a stale lease until the provider confirms removal", async () => {
    const env = environment();
    await env.LEASES.put(
      "lease:lease-1",
      JSON.stringify(lease({ lastHeartbeatAt: new Date(NOW - 181_000).toISOString() })),
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/pods/pod_1") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/pods/pod_1")) {
        return Response.json({
          id: "pod_1",
          name: "glimmer-instance-1-lease-1",
          desiredStatus: "RUNNING",
          adjustedCostPerHr: 1.59,
          gpu: { count: 1 },
        });
      }
      throw new Error(`unexpected request ${url}`);
    });

    const first = await sweep(env, NOW);
    expect(first).toMatchObject({ ok: true, checked: 1, terminationRequests: 1 });
    expect(await env.LEASES.get("lease:lease-1", "json")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://rest.runpod.io/v1/pods/pod_1",
      expect.objectContaining({ method: "DELETE" }),
    );

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const second = await sweep(env, NOW + 120_000);
    expect(second.ok).toBe(true);
    expect(await env.LEASES.get("lease:lease-1", "json")).toBeNull();
  });

  it("terminates a running Pod when the observed provider rate exceeds the lease ceiling", async () => {
    const env = environment();
    await env.LEASES.put("lease:lease-1", JSON.stringify(lease()));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({
        id: "pod_1",
        name: "glimmer-instance-1-lease-1",
        desiredStatus: "RUNNING",
        adjustedCostPerHr: 1.8,
        gpu: { count: 1 },
      });
    });
    await expect(sweep(env, NOW)).resolves.toMatchObject({
      ok: true,
      checked: 1,
      terminationRequests: 1,
    });
  });
});

describe("watchdog V2 leases", () => {
  it("stores V2 CPU leases separately without changing the V1 HTTP route", async () => {
    const env = environment();
    const body = JSON.stringify(leaseV2());
    const response = await worker.fetch(signedRequest("PUT", "/v1/leases/job-1", body), env);

    expect(response.status).toBe(201);
    expect(await env.LEASES.get("lease-v2:job-1", "json")).toEqual(leaseV2());
    expect(await env.LEASES.get("lease:job-1", "json")).toBeNull();
  });

  it("retains a conforming V2 CPU Pod below its ceiling", async () => {
    const env = environment();
    await env.LEASES.put("lease-v2:job-1", JSON.stringify(leaseV2()));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(cpuPodV2()));

    await expect(sweep(env, NOW)).resolves.toMatchObject({
      ok: true,
      checked: 1,
      terminationRequests: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.runpod.io/v2/pods/pod_v2_1",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("retains an explicitly leased one-GPU cache repair at its bounded rate", async () => {
    const env = environment();
    const fallbackLease = leaseV2({
      jobKind: "gpu_cache",
      maxHourlyUsd: 0.49,
      expected: {
        cloud: "SECURE",
        gpuCount: 1,
        gpuTypeId: "NVIDIA L4",
        networkVolumeId: "volume-1",
      },
    });
    await env.LEASES.put("lease-v2:job-1", JSON.stringify(fallbackLease));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(
          cpuPodV2({
            cpuFlavorId: undefined,
            vcpuCount: undefined,
            gpu: { id: "NVIDIA L4", count: 1 },
            costPerHr: 0.49,
          }),
        ),
      );

    await expect(sweep(env, NOW)).resolves.toMatchObject({
      ok: true,
      checked: 1,
      terminationRequests: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.runpod.io/v2/pods/pod_v2_1",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("terminates a GPU cache Pod whose exact GPU identity differs from its lease", async () => {
    const env = environment();
    await env.LEASES.put(
      "lease-v2:job-1",
      JSON.stringify(
        leaseV2({
          jobKind: "gpu_cache",
          maxHourlyUsd: 0.49,
          expected: {
            cloud: "SECURE",
            gpuCount: 1,
            gpuTypeId: "NVIDIA L4",
            networkVolumeId: "volume-1",
          },
        }),
      ),
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json(
        cpuPodV2({
          cpu: null,
          gpu: { id: "NVIDIA GeForce RTX 4090", count: 1 },
          cost: 0.44,
        }),
      );
    });

    await expect(sweep(env, NOW)).resolves.toMatchObject({
      ok: true,
      checked: 1,
      terminationRequests: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.runpod.io/v2/pods/pod_v2_1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("retains the sanitized live GPU Pod shape for a coordinator gpu_worker lease", async () => {
    const env = environment();
    const lease = leaseV2({
      jobKind: "gpu_worker",
      maxHourlyUsd: 1.75,
      podId: "pod_fixture_gpu1",
      podName: "glimmer-gpu-fixture",
      expected: {
        cloud: "SECURE",
        gpuCount: 1,
        gpuTypeId: "NVIDIA A100 80GB PCIe",
        networkVolumeId: "vol_fixture_1",
      },
    });
    await env.LEASES.put("lease-v2:job-1", JSON.stringify(lease));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(rawGpuFixture()));

    await expect(sweep(env, NOW)).resolves.toMatchObject({
      ok: true,
      checked: 1,
      terminationRequests: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains a live GPU Pod whose response omits gpu, cost, and volume metadata", async () => {
    const env = environment();
    const lease = leaseV2({
      jobKind: "gpu_worker",
      maxHourlyUsd: 1.75,
      podId: "pod_fixture_gpu1",
      podName: "glimmer-gpu-fixture",
      expected: {
        cloud: "SECURE",
        gpuCount: 1,
        gpuTypeId: "NVIDIA A100 80GB PCIe",
        networkVolumeId: "vol_fixture_1",
      },
    });
    await env.LEASES.put("lease-v2:job-1", JSON.stringify(lease));
    const raw = rawGpuFixture();
    delete raw.gpu;
    delete raw.costPerHr;
    delete raw.adjustedCostPerHr;
    delete raw.networkVolume;
    delete raw.machine;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(raw));

    await expect(sweep(env, NOW)).resolves.toMatchObject({
      ok: true,
      checked: 1,
      terminationRequests: 0,
    });
  });

  it("terminates a live GPU Pod whose machine metadata names the wrong GPU type", async () => {
    const env = environment();
    const lease = leaseV2({
      jobKind: "gpu_worker",
      maxHourlyUsd: 1.75,
      podId: "pod_fixture_gpu1",
      podName: "glimmer-gpu-fixture",
      expected: {
        cloud: "SECURE",
        gpuCount: 1,
        gpuTypeId: "NVIDIA A100 80GB PCIe",
        networkVolumeId: "vol_fixture_1",
      },
    });
    await env.LEASES.put("lease-v2:job-1", JSON.stringify(lease));
    const raw = rawGpuFixture();
    delete raw.gpu;
    raw.machine.gpuTypeId = "NVIDIA GeForce RTX 4090";
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) =>
      Promise.resolve(
        init?.method === "DELETE" ? new Response(null, { status: 200 }) : Response.json(raw),
      ),
    );

    await expect(sweep(env, NOW)).resolves.toMatchObject({
      ok: true,
      checked: 1,
      terminationRequests: 1,
    });
  });

  it("terminates an exact-id V2 GPU Pod after a stale heartbeat", async () => {
    const env = environment();
    await env.LEASES.put(
      "lease-v2:job-1",
      JSON.stringify(
        leaseV2({
          jobKind: "gpu_worker",
          maxHourlyUsd: 1.75,
          lastHeartbeatAt: new Date(NOW - 181_000).toISOString(),
          expected: { cloud: "SECURE", gpuCount: 1, networkVolumeId: "volume-1" },
        }),
      ),
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json(
        cpuPodV2({
          cpuFlavorId: undefined,
          vcpuCount: undefined,
          gpu: { id: "NVIDIA A100 80GB PCIe", count: 1 },
          costPerHr: 1.59,
        }),
      );
    });

    await expect(sweep(env, NOW)).resolves.toMatchObject({
      ok: true,
      checked: 1,
      terminationRequests: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.runpod.io/v2/pods/pod_v2_1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("still parses an expired stored V2 lease so the hard deadline deletes its Pod", async () => {
    const env = environment();
    await env.LEASES.put(
      "lease-v2:job-1",
      JSON.stringify(
        leaseV2({
          hardDeadlineAt: new Date(NOW - 1_000).toISOString(),
          lastHeartbeatAt: new Date(NOW - 10_000).toISOString(),
        }),
      ),
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json(cpuPodV2());
    });

    await expect(sweep(env, NOW)).resolves.toMatchObject({
      ok: true,
      checked: 1,
      terminationRequests: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.runpod.io/v2/pods/pod_v2_1",
      expect.objectContaining({ method: "DELETE", redirect: "manual" }),
    );
  });

  it("fails closed without deleting when provisional exact-name recovery is ambiguous", async () => {
    const env = environment();
    await env.LEASES.put("lease-v2:job-1", JSON.stringify(leaseV2({ podId: undefined })));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        pods: [cpuPodV2({ id: "pod_v2_a" }), cpuPodV2({ id: "pod_v2_b" })],
      }),
    );

    await expect(sweep(env, NOW)).resolves.toMatchObject({
      ok: false,
      checked: 1,
      terminationRequests: 0,
      errorCodes: ["RUNPOD_EXACT_NAME_AMBIGUOUS"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
