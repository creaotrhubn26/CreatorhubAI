import { describe, expect, it, vi } from "vitest";
import {
  CoordinatorClient,
  CoordinatorProtocolError,
  coordinatorRequestSignature,
  parseCoordinatorStatus,
  parseCoordinatorJob,
} from "./coordinatorClient.js";

const TOKEN = "coordinator_ingest_token_that_is_long_enough";
const NOW = new Date("2026-08-31T12:00:00.000Z");
const PUBLIC_KEY = "A".repeat(43);
const KEY_ID = "a".repeat(64);

function status() {
  return {
    service: "glimmer-compute-coordinator",
    schemaVersion: 1,
    ready: true,
    checkedAt: NOW.toISOString(),
    providerApiVersion: "v2",
    watchdogReady: true,
    activeJobId: null,
    cacheSigning: { algorithm: "Ed25519", keyId: KEY_ID, publicKey: PUBLIC_KEY },
  };
}

function job() {
  return {
    schemaVersion: 1,
    jobId: "12345678-1234-4123-8123-123456789abc",
    kind: "gpu_worker",
    state: "accepted",
    phase: "cache_repair",
    cacheKey: "b".repeat(64),
    requestFingerprint: "c".repeat(64),
    podName: "glimmer-cache-12345678-1234-4123-8123-123456789abc",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    hardDeadlineAt: "2026-08-31T14:00:00.000Z",
    phaseDeadlineAt: "2026-08-31T12:28:00.000Z",
    maxHourlyUsd: 2.09,
    maxTotalUsd: 0.35,
    cache: { state: "missing" },
    createAttempted: false,
    cleanup: { requested: false, confirmed: false },
  };
}

describe("CoordinatorClient", () => {
  it("authenticates an exact status request and parses the strict response", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Glimmer-Timestamp")).toBe(String(NOW.getTime()));
      expect(headers.get("X-Glimmer-Signature")).toBe(
        `v1=${coordinatorRequestSignature(TOKEN, "GET", "/v1/status", NOW.getTime(), "")}`,
      );
      expect(init?.redirect).toBe("error");
      return Response.json(status());
    });
    const client = new CoordinatorClient({
      baseUrl: "https://coordinator.example",
      ingestToken: TOKEN,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => NOW,
    });

    await expect(client.status()).resolves.toEqual(status());
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://coordinator.example/v1/status",
      expect.any(Object),
    );
  });

  it("rejects unsafe origins, malformed keys, and schema drift", () => {
    expect(
      () =>
        new CoordinatorClient({
          baseUrl: "https://coordinator.example/private",
          ingestToken: TOKEN,
        }),
    ).toThrow(/origin-only/);
    expect(() =>
      parseCoordinatorStatus({
        ...status(),
        cacheSigning: { ...status().cacheSigning, publicKey: "not-a-key" },
      }),
    ).toThrow(/schema/);
    expect(() => parseCoordinatorStatus({ ...status(), secret: "must-not-pass" })).toThrow(
      /unsupported/,
    );
  });

  it("fails closed on HTTP errors and oversized responses", async () => {
    const httpClient = new CoordinatorClient({
      baseUrl: "https://coordinator.example",
      ingestToken: TOKEN,
      fetchImpl: vi.fn(async () => new Response("{}", { status: 503 })) as typeof fetch,
    });
    await expect(httpClient.status()).rejects.toMatchObject<Partial<CoordinatorProtocolError>>({
      status: 503,
    });

    const oversizedClient = new CoordinatorClient({
      baseUrl: "https://coordinator.example",
      ingestToken: TOKEN,
      fetchImpl: vi.fn(
        async () =>
          new Response("{}", {
            headers: { "Content-Length": String(128 * 1024 + 1) },
          }),
      ) as typeof fetch,
    });
    await expect(oversizedClient.status()).rejects.toThrow(/safe size/);
  });

  it("signs exact job mutations and rejects secret-bearing or drifted job responses", async () => {
    const input = {
      schemaVersion: 1 as const,
      jobId: job().jobId,
      ownerInstanceId: "creatorhub-mac",
      kind: "gpu_worker" as const,
      image: `ghcr.io/example/glimmer@sha256:${"d".repeat(64)}`,
      buildId: "r2-abcdef012345",
      containerRegistryAuthId: "registry-1",
      networkVolumeId: "volume-1",
      contextTokens: 65_536 as const,
      modelArtifacts: {
        model: { url: "https://models.example/model", sha256: "1".repeat(64) },
        mmproj: { url: "https://models.example/mmproj", sha256: "2".repeat(64) },
        draftModel: { url: "https://models.example/draft", sha256: "3".repeat(64) },
        allowedHosts: ["models.example"],
      },
      maxHourlyUsd: 2.09,
      hardDeadlineAt: "2026-08-31T14:00:00.000Z",
      gpuMaxRuntimeSeconds: 480,
      maxTotalUsd: 0.35,
      idleTimeoutSeconds: 300,
      gpuTypeId: "NVIDIA RTX PRO 6000 Blackwell Server Edition",
      bootstrapToken: "B".repeat(43),
    };
    const body = JSON.stringify(input);
    const path = `/v1/jobs/${input.jobId}`;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(init?.body).toBe(body);
      expect(headers.get("X-Glimmer-Signature")).toBe(
        `v1=${coordinatorRequestSignature(TOKEN, "PUT", path, NOW.getTime(), body)}`,
      );
      return Response.json(job(), { status: 202 });
    });
    const client = new CoordinatorClient({
      baseUrl: "https://coordinator.example",
      ingestToken: TOKEN,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => NOW,
    });

    await expect(client.putJob(input)).resolves.toEqual(job());
    expect(() => parseCoordinatorJob({ ...job(), callbackToken: "secret" })).toThrow(/unsupported/);
    expect(() =>
      parseCoordinatorJob({ ...job(), cache: { state: "ready", source: "model" } }),
    ).toThrow(/unsupported/);
  });
});
