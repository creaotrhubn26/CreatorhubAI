import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import type { ComputeConfigV1, ComputeConfigUpdateV1 } from "@glimmer/shared";

const UI_ORIGIN = "http://127.0.0.1:5183";
const API_KEY = "runpod-route-secret";
const IMAGE = `ghcr.io/example/glimmer@sha256:${"a".repeat(64)}`;

let app: Express;
let stateRoot: string;

beforeEach(async () => {
  vi.resetModules();
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-compute-route-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;
  process.env.GLIMMER_COMPUTE_CONFIG = path.join(stateRoot, "compute.json");
  process.env.GLIMMER_RUNPOD_API_BASE = "https://rest.runpod.io/v1";
  app = (await import("../app.js")).createApp();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateRoot, { recursive: true, force: true });
  delete process.env.GLIMMER_STATE_ROOT;
  delete process.env.GLIMMER_COMPUTE_CONFIG;
  delete process.env.GLIMMER_RUNPOD_API_BASE;
});

function updateFrom(config: ComputeConfigV1, patch: Partial<ComputeConfigUpdateV1> = {}) {
  return {
    version: 1 as const,
    enabled: config.enabled,
    defaultBackend: config.defaultBackend,
    activeProfileId: config.activeProfileId,
    profiles: config.profiles.map(
      ({ hasApiKey: _hasApiKey, watchdogConfigured: _watchdog, ...profile }) => profile,
    ),
    ...patch,
  } satisfies ComputeConfigUpdateV1;
}

async function configuredUpdate(patch: Partial<ComputeConfigUpdateV1> = {}) {
  const defaults = (await request(app).get("/api/compute/config")).body as ComputeConfigV1;
  const update = updateFrom(defaults, {
    enabled: true,
    defaultBackend: "runpod_pod",
    apiKey: API_KEY,
    profiles: defaults.profiles.map(
      ({ hasApiKey: _hasApiKey, watchdogConfigured: _watchdog, ...profile }) => ({
        ...profile,
        imageDigest: IMAGE,
        networkVolumeId: "network_volume_1",
      }),
    ),
    ...patch,
  });
  const response = await request(app)
    .put("/api/compute/config")
    .set("Origin", UI_ORIGIN)
    .send(update);
  expect(response.status).toBe(200);
  return response.body as ComputeConfigV1;
}

describe("compute configuration API", () => {
  it("returns a disabled, local, secret-free default", async () => {
    const response = await request(app).get("/api/compute/config");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      version: 1,
      enabled: false,
      defaultBackend: "local_process",
      activeProfileId: "runpod-a100",
      source: "default",
    });
    expect(response.body.profiles).toHaveLength(2);
    expect(response.body.profiles[0]).toMatchObject({
      cloudType: "SECURE",
      gpuCount: 1,
      contextTokens: 65536,
      hasApiKey: false,
      watchdogConfigured: false,
    });
    expect(JSON.stringify(response.body)).not.toContain("apiKeyFile");
  });

  it("stores the RunPod key separately in mode 0600 and never returns it", async () => {
    const saved = await configuredUpdate();
    expect(saved.profiles.every((profile) => profile.hasApiKey)).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(API_KEY);
    expect(JSON.stringify(saved)).not.toContain("apiKeyFile");

    const storedText = await fs.readFile(path.join(stateRoot, "compute.json"), "utf8");
    const stored = JSON.parse(storedText);
    expect(storedText).not.toContain(API_KEY);
    expect(stored.apiKeyFile).toBe(path.join(stateRoot, "compute-keys", "runpod.key"));
    expect((await fs.stat(stored.apiKeyFile)).mode & 0o777).toBe(0o600);
    expect((await fs.readFile(stored.apiKeyFile, "utf8")).trim()).toBe(API_KEY);
  });

  it("preserves a blank stored key update and clears only the gateway-owned key on request", async () => {
    const saved = await configuredUpdate();
    const disabled = updateFrom(saved, { enabled: false, defaultBackend: "local_process" });
    const preserved = await request(app)
      .put("/api/compute/config")
      .set("Origin", UI_ORIGIN)
      .send(disabled);
    expect(preserved.status).toBe(200);
    expect(preserved.body.profiles[0].hasApiKey).toBe(true);

    const cleared = await request(app)
      .put("/api/compute/config")
      .set("Origin", UI_ORIGIN)
      .send({ ...disabled, clearApiKey: true });
    expect(cleared.status).toBe(200);
    expect(cleared.body.profiles[0].hasApiKey).toBe(false);
    await expect(fs.stat(path.join(stateRoot, "compute-keys", "runpod.key"))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });

  it("rejects Community Cloud, multiple GPUs, mutable images, and hidden H100 escalation", async () => {
    const defaults = (await request(app).get("/api/compute/config")).body as ComputeConfigV1;
    const base = updateFrom(defaults);
    for (const mutate of [
      (value: any) => (value.profiles[0].cloudType = "COMMUNITY"),
      (value: any) => (value.profiles[0].gpuCount = 2),
      (value: any) => (value.profiles[0].imageDigest = "ghcr.io/example/glimmer:latest"),
      (value: any) => (value.profiles[0].gpuTypeIds = ["NVIDIA H100 PCIe"]),
    ]) {
      const input = structuredClone(base);
      mutate(input);
      const response = await request(app)
        .put("/api/compute/config")
        .set("Origin", UI_ORIGIN)
        .send(input);
      expect(response.status).toBe(400);
    }
  });

  it("requires an immutable image, network volume, and key before enabling RunPod", async () => {
    const defaults = (await request(app).get("/api/compute/config")).body as ComputeConfigV1;
    const response = await request(app)
      .put("/api/compute/config")
      .set("Origin", UI_ORIGIN)
      .send(updateFrom(defaults, { enabled: true, defaultBackend: "runpod_pod" }));
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/imageDigest|networkVolumeId|API key/);
  });

  it("protects writes with the existing origin guard", async () => {
    const defaults = (await request(app).get("/api/compute/config")).body as ComputeConfigV1;
    const response = await request(app)
      .put("/api/compute/config")
      .set("Origin", "https://attacker.example")
      .send(updateFrom(defaults));
    expect(response.status).toBe(403);
  });
});

describe("RunPod compute lifecycle", () => {
  it("keeps GET usage read-only and performs provider reconciliation only behind a guarded POST", async () => {
    await configuredUpdate();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const read = await request(app).get("/api/compute/usage");
    expect(read.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();

    const rejected = await request(app).post("/api/compute/usage/reconcile");
    expect(rejected.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tests credentials with GET /pods and creates no resource", async () => {
    await configuredUpdate();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const response = await request(app).post("/api/compute/test").set("Origin", UI_ORIGIN);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ authenticated: true, visiblePodCount: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://rest.runpod.io/v1/pods");
    expect(init?.method).toBeUndefined();
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("creates one Secure A100 Pod and terminates it on stop because it has a network volume", async () => {
    await configuredUpdate();
    let exists = false;
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.includes("/billing/pods") && method === "GET") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/pods") && method === "POST") {
        exists = true;
        const body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            id: "pod_123",
            name: body.name,
            desiredStatus: "RUNNING",
            adjustedCostPerHr: 1.39,
            gpu: { id: "NVIDIA A100 80GB PCIe", count: 1 },
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/pods/pod_123") && method === "GET") {
        return exists
          ? new Response(
              JSON.stringify({
                id: "pod_123",
                name: "glimmer-development-test",
                desiredStatus: "RUNNING",
                adjustedCostPerHr: 1.39,
                gpu: { id: "NVIDIA A100 80GB PCIe", count: 1 },
              }),
              { status: 200 },
            )
          : new Response("", { status: 404 });
      }
      if (url.endsWith("/pods/pod_123") && method === "DELETE") {
        exists = false;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });

    const started = await request(app).post("/api/compute/start").set("Origin", UI_ORIGIN);
    expect(started.status).toBe(202);
    expect(started.body.started).toBe(true);
    expect(started.body.status).toMatchObject({
      backend: "runpod_pod",
      state: "bootstrapping",
      pod: { id: "pod_123", adjustedCostPerHr: 1.39 },
    });
    const create = calls.find((call) => call.method === "POST" && call.url.endsWith("/pods"));
    expect(create?.body).toMatchObject({
      cloudType: "SECURE",
      computeType: "GPU",
      gpuCount: 1,
      gpuTypeIds: ["NVIDIA A100 80GB PCIe", "NVIDIA A100-SXM4-80GB"],
      imageName: IMAGE,
      networkVolumeId: "network_volume_1",
      interruptible: false,
    });
    expect(JSON.stringify(create?.body)).not.toContain(API_KEY);

    const current = (await request(app).get("/api/compute/config")).body as ComputeConfigV1;
    const blockedConfigChange = await request(app)
      .put("/api/compute/config")
      .set("Origin", UI_ORIGIN)
      .send(updateFrom(current));
    expect(blockedConfigChange.status).toBe(409);

    const stopped = await request(app).post("/api/compute/stop").set("Origin", UI_ORIGIN);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ stopped: true, terminated: true });
    expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/pod_123"))).toBe(
      true,
    );
    await expect(fs.stat(path.join(stateRoot, "compute-state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("immediately terminates an allocation above the configured ceiling", async () => {
    await configuredUpdate();
    let deleted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/billing/pods") && method === "GET") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/pods") && method === "POST") {
        const body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            id: "pod_expensive",
            name: body.name,
            desiredStatus: "RUNNING",
            adjustedCostPerHr: 9.99,
            gpu: { id: "NVIDIA A100 80GB PCIe", count: 1 },
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/pods/pod_expensive") && method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/pods/pod_expensive") && method === "GET") {
        return new Response("", { status: deleted ? 404 : 200 });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });
    const response = await request(app).post("/api/compute/start").set("Origin", UI_ORIGIN);
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("exceeds the configured");
    expect(deleted).toBe(true);
    await expect(fs.stat(path.join(stateRoot, "compute-state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed before allocation when provider billing cannot be reconciled", async () => {
    await configuredUpdate();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
    const response = await request(app).post("/api/compute/start").set("Origin", UI_ORIGIN);
    expect(response.status).toBe(503);
    expect(response.body.error).toContain("RunPod API request failed with HTTP 503");
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url).endsWith("/pods") && init?.method === "POST",
      ),
    ).toBe(false);
    await expect(fs.stat(path.join(stateRoot, "compute-state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reconciles provider billing while preserving local-estimate provenance", async () => {
    await configuredUpdate();
    await fs.writeFile(
      path.join(stateRoot, "compute-usage.json"),
      JSON.stringify({
        version: 1,
        intervals: [
          {
            leaseId: "old-lease",
            podId: "pod_old",
            startedAt: new Date(Date.now() - 3_600_000).toISOString(),
            stoppedAt: new Date().toISOString(),
            hourlyUsd: 1.39,
          },
        ],
      }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            amount: 2.5,
            podId: "pod_old",
            time: new Date().toISOString(),
            timeBilledMs: 3_600_000,
          },
        ]),
        { status: 200 },
      ),
    );
    const response = await request(app)
      .post("/api/compute/usage/reconcile")
      .set("Origin", UI_ORIGIN);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      reconciledTodayUsd: 2.5,
      reconciledMonthUsd: 2.5,
      provenance: { reconciled: "runpod-billing-api" },
    });
  });
});
