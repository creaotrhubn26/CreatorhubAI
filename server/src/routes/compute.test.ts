import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import type { ComputeConfigV1, ComputeConfigUpdateV1 } from "@glimmer/shared";

const UI_ORIGIN = "http://127.0.0.1:5183";
const API_KEY = "runpod-route-secret";
const WATCHDOG_TOKEN = "watchdog_route_ingest_token_with_32_chars";
const WATCHDOG_ENDPOINT = "https://watchdog.example";
const COORDINATOR_TOKEN = "C".repeat(43);
const COORDINATOR_ENDPOINT = "https://coordinator.example";
const IMAGE = `ghcr.io/example/glimmer@sha256:${"a".repeat(64)}`;
const REGISTRY_AUTH_ID = "registry_auth_1";
const MODEL_ARTIFACTS = {
  model: { url: "https://models.example.com/model.gguf", sha256: "b".repeat(64) },
  mmproj: { url: "https://models.example.com/mmproj.gguf", sha256: "c".repeat(64) },
  draftModel: { url: "https://models.example.com/draft.gguf", sha256: "d".repeat(64) },
  allowedHosts: ["models.example.com"],
};

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
    watchdog: {
      endpointUrl: WATCHDOG_ENDPOINT,
      ingestToken: WATCHDOG_TOKEN,
    },
    profiles: defaults.profiles.map(
      ({ hasApiKey: _hasApiKey, watchdogConfigured: _watchdog, ...profile }) => ({
        ...profile,
        imageDigest: IMAGE,
        containerRegistryAuthId: REGISTRY_AUTH_ID,
        networkVolumeId: "network_volume_1",
        modelArtifacts: MODEL_ARTIFACTS,
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

function watchdogResponse(input: RequestInfo | URL, init?: RequestInit): Response | null {
  const url = new URL(String(input));
  if (url.origin !== WATCHDOG_ENDPOINT) return null;
  if (url.pathname === "/v1/status") {
    return Response.json({
      service: "glimmer-compute-watchdog",
      schemaVersion: 1,
      ready: true,
      checkedAt: "2026-08-30T12:00:00.000Z",
      lastSweepAt: "2026-08-30T12:00:00.000Z",
      staleAfterSeconds: 180,
    });
  }
  const leaseId = url.pathname.split("/").at(-1)!;
  if (init?.method === "PUT") {
    return Response.json(
      { accepted: true, leaseId, storedAt: "2026-08-30T12:00:00.000Z" },
      { status: 201 },
    );
  }
  if (init?.method === "DELETE") return Response.json({ deleted: true, leaseId });
  throw new Error(`unexpected watchdog request ${init?.method ?? "GET"} ${url}`);
}

async function verifyWatchdog() {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => watchdogResponse(input, init)!);
  const response = await request(app).post("/api/compute/watchdog/test").set("Origin", UI_ORIGIN);
  fetchMock.mockRestore();
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ ready: true, staleAfterSeconds: 180 });
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
    expect(response.body.watchdog).toEqual({ hasIngestToken: false });
    expect(response.body.coordinator).toEqual({ hasIngestToken: false });
    expect(response.body.orchestrationMode).toBe("local_gateway");
    expect(response.body.profiles[0]).toMatchObject({
      cloudType: "SECURE",
      gpuCount: 1,
      contextTokens: 65536,
      imageDigest:
        "ghcr.io/creaotrhubn26/glimmer-runpod-worker@sha256:1e5c6824ba31add182a65d5b50faef692c6f5c512fa6063c1e609d650c027c4c",
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
    expect(stored.watchdog.tokenFile).toBe(
      path.join(stateRoot, "compute-keys", "watchdog-ingest.key"),
    );
    expect((await fs.stat(stored.watchdog.tokenFile)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(saved)).not.toContain(WATCHDOG_TOKEN);
  });

  it("verifies the external watchdog without creating a provider resource", async () => {
    const saved = await configuredUpdate();
    expect(saved.watchdog).toMatchObject({
      endpointUrl: WATCHDOG_ENDPOINT,
      hasIngestToken: true,
    });
    expect(saved.watchdog.verifiedAt).toBeUndefined();
    await verifyWatchdog();
    const verified = (await request(app).get("/api/compute/config")).body as ComputeConfigV1;
    expect(verified.watchdog).toMatchObject({
      hasIngestToken: true,
      verifiedAt: "2026-08-30T12:00:00.000Z",
      lastSweepAt: "2026-08-30T12:00:00.000Z",
    });
    expect(verified.profiles.every((profile) => profile.watchdogConfigured)).toBe(true);

    const cleared = await request(app)
      .put("/api/compute/config")
      .set("Origin", UI_ORIGIN)
      .send(
        updateFrom(verified, {
          watchdog: { endpointUrl: "", clearIngestToken: true },
        }),
      );
    expect(cleared.status).toBe(200);
    expect(cleared.body.watchdog).toEqual({ hasIngestToken: false });
    await expect(
      fs.stat(path.join(stateRoot, "compute-keys", "watchdog-ingest.key")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stores and verifies the cloud coordinator behind the existing origin guard", async () => {
    const defaults = (await request(app).get("/api/compute/config")).body as ComputeConfigV1;
    const update = updateFrom(defaults, {
      enabled: true,
      defaultBackend: "runpod_pod",
      orchestrationMode: "cloud_coordinator",
      coordinator: {
        endpointUrl: COORDINATOR_ENDPOINT,
        ingestToken: COORDINATOR_TOKEN,
      },
      profiles: defaults.profiles.map(
        ({ hasApiKey: _hasApiKey, watchdogConfigured: _watchdog, ...profile }) => ({
          ...profile,
          imageDigest: IMAGE,
          workerBuildId: "r2-abcdef012345",
          containerRegistryAuthId: REGISTRY_AUTH_ID,
          networkVolumeId: "network_volume_1",
          modelArtifacts: MODEL_ARTIFACTS,
        }),
      ),
    });
    const saved = await request(app)
      .put("/api/compute/config")
      .set("Origin", UI_ORIGIN)
      .send(update);
    expect(saved.status).toBe(200);
    expect(saved.body.coordinator).toEqual({
      endpointUrl: COORDINATOR_ENDPOINT,
      hasIngestToken: true,
    });
    expect(JSON.stringify(saved.body)).not.toContain(COORDINATOR_TOKEN);
    const tokenFile = path.join(stateRoot, "compute-keys", "coordinator-ingest.key");
    expect((await fs.stat(tokenFile)).mode & 0o777).toBe(0o600);
    expect((await fs.readFile(tokenFile, "utf8")).trim()).toBe(COORDINATOR_TOKEN);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        service: "glimmer-compute-coordinator",
        schemaVersion: 1,
        ready: true,
        checkedAt: "2026-08-31T12:00:00.000Z",
        providerApiVersion: "v2",
        watchdogReady: true,
        activeJobId: null,
        cacheSigning: {
          algorithm: "Ed25519",
          keyId: "e".repeat(64),
          publicKey: "P".repeat(43),
        },
      }),
    );
    const rejected = await request(app).post("/api/compute/coordinator/test");
    expect(rejected.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();

    const verified = await request(app)
      .post("/api/compute/coordinator/test")
      .set("Origin", UI_ORIGIN);
    expect(verified.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(requestHeaders.get("X-Glimmer-Signature")).toMatch(/^v1=[a-f0-9]{64}$/);
    expect(requestHeaders.get("Authorization")).toBeNull();
    const publicConfig = (await request(app).get("/api/compute/config")).body;
    expect(publicConfig.coordinator).toMatchObject({
      verifiedAt: "2026-08-31T12:00:00.000Z",
      cacheSigningKeyId: "e".repeat(64),
    });
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
      (value: any) => (value.profiles[0].containerRegistryAuthId = "../../invalid"),
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

  it("rejects non-HTTPS, credentialed, and path-bearing watchdog endpoints", async () => {
    const defaults = (await request(app).get("/api/compute/config")).body as ComputeConfigV1;
    for (const endpointUrl of [
      "http://127.0.0.1:8787",
      "https://user:password@watchdog.example",
      "https://watchdog.example/private",
    ]) {
      const response = await request(app)
        .put("/api/compute/config")
        .set("Origin", UI_ORIGIN)
        .send(
          updateFrom(defaults, {
            watchdog: { endpointUrl, ingestToken: WATCHDOG_TOKEN },
          }),
        );
      expect(response.status).toBe(400);
    }
  });

  it("requires registry auth, a network volume, model artifacts, and a key before enabling RunPod", async () => {
    const defaults = (await request(app).get("/api/compute/config")).body as ComputeConfigV1;
    const response = await request(app)
      .put("/api/compute/config")
      .set("Origin", UI_ORIGIN)
      .send(updateFrom(defaults, { enabled: true, defaultBackend: "runpod_pod" }));
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(
      /containerRegistryAuthId|networkVolumeId|modelArtifacts|API key/,
    );
  });

  it("rejects unallowlisted, credentialed, or non-checksummed model artifacts", async () => {
    const defaults = (await request(app).get("/api/compute/config")).body as ComputeConfigV1;
    const valid = updateFrom(defaults, {
      enabled: true,
      defaultBackend: "runpod_pod",
      apiKey: API_KEY,
      profiles: defaults.profiles.map(
        ({ hasApiKey: _hasApiKey, watchdogConfigured: _watchdog, ...profile }) => ({
          ...profile,
          imageDigest: IMAGE,
          containerRegistryAuthId: REGISTRY_AUTH_ID,
          networkVolumeId: "network_volume_1",
          modelArtifacts: MODEL_ARTIFACTS,
        }),
      ),
    });
    for (const mutate of [
      (input: any) =>
        (input.profiles[0].modelArtifacts.model.url = "http://models.example.com/model.gguf"),
      (input: any) =>
        (input.profiles[0].modelArtifacts.model.url = "https://other.example.com/model.gguf"),
      (input: any) =>
        (input.profiles[0].modelArtifacts.model.url =
          "https://user:secret@models.example.com/model.gguf"),
      (input: any) => (input.profiles[0].modelArtifacts.model.sha256 = "not-a-sha256"),
      (input: any) => (input.profiles[0].modelArtifacts.allowedHosts = ["127.0.0.1"]),
    ]) {
      const input = structuredClone(valid);
      mutate(input);
      const response = await request(app)
        .put("/api/compute/config")
        .set("Origin", UI_ORIGIN)
        .send(input);
      expect(response.status).toBe(400);
    }
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
    await verifyWatchdog();
    let exists = false;
    let workerRotated = false;
    let createdPodName = "";
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const watchdog = watchdogResponse(input, init);
      if (watchdog) return watchdog;
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url === "https://pod_123-4318.proxy.runpod.net/v1/health") {
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            buildId: "r2-aaaaaaaaaaaa",
            ready: workerRotated,
            model: { ready: true, contextTokens: 65_536 },
            workerState: workerRotated ? "ready" : "bootstrapping",
          }),
          { status: 200 },
        );
      }
      if (url === "https://pod_123-4318.proxy.runpod.net/v1/handshake" && method === "POST") {
        workerRotated = true;
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            buildId: "r2-aaaaaaaaaaaa",
            capability: "C".repeat(43),
            checkpointKey: "K".repeat(43),
            contextTokens: 65_536,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/billing/pods") && method === "GET") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/pods") && method === "POST") {
        exists = true;
        const body = JSON.parse(String(init?.body));
        createdPodName = body.name;
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
      if (url.endsWith("/pods/pod_123?includeMachine=true") && method === "GET") {
        return exists
          ? new Response(
              JSON.stringify({
                id: "pod_123",
                name: createdPodName,
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
    await vi.waitFor(async () => {
      const status = await request(app).get("/api/compute/status");
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({
        backend: "runpod_pod",
        state: "ready",
        pod: { id: "pod_123", adjustedCostPerHr: 1.39 },
        worker: { buildId: "r2-aaaaaaaaaaaa", ready: true },
      });
    });
    const create = calls.find((call) => call.method === "POST" && call.url.endsWith("/pods"));
    expect(create?.body).toMatchObject({
      cloudType: "SECURE",
      computeType: "GPU",
      gpuCount: 1,
      gpuTypeIds: ["NVIDIA A100 80GB PCIe", "NVIDIA A100-SXM4-80GB"],
      imageName: IMAGE,
      containerRegistryAuthId: REGISTRY_AUTH_ID,
      networkVolumeId: "network_volume_1",
      interruptible: false,
      ports: ["4318/http"],
      env: {
        GLIMMER_CONTEXT_TOKENS: "65536",
        GLIMMER_MODEL_SHA256: "b".repeat(64),
      },
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

  it.each([401, 403])(
    "maps a definitive RunPod HTTP %i create rejection to a secret-free 502 without retry",
    async (providerStatus) => {
      await configuredUpdate();
      await verifyWatchdog();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const watchdog = watchdogResponse(input, init);
        if (watchdog) return watchdog;
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/billing/pods") && method === "GET") {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.endsWith("/pods") && method === "POST") {
          return new Response(JSON.stringify({ error: "provider-secret-body" }), {
            status: providerStatus,
          });
        }
        throw new Error(`unexpected request ${method} ${url}`);
      });

      const response = await request(app).post("/api/compute/start").set("Origin", UI_ORIGIN);

      expect(response.status).toBe(502);
      expect(response.body.error).toBe(
        `RunPod rejected Pod creation with HTTP ${providerStatus}; local cleanup completed`,
      );
      expect(JSON.stringify(response.body)).not.toContain("provider-secret-body");
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) => String(url).endsWith("/pods") && init?.method === "POST",
        ),
      ).toHaveLength(1);
      await expect(fs.stat(path.join(stateRoot, "compute-state.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("immediately terminates an allocation above the configured ceiling", async () => {
    await configuredUpdate();
    await verifyWatchdog();
    let deleted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const watchdog = watchdogResponse(input, init);
      if (watchdog) return watchdog;
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
      if (url.endsWith("/pods/pod_expensive?includeMachine=true") && method === "GET") {
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
    await verifyWatchdog();
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
