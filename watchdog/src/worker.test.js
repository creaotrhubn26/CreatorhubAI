import { createHmac } from "node:crypto";
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
