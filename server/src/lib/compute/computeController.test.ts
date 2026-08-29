import { describe, expect, it, vi } from "vitest";
import type { ComputeConfigV1, ComputeUsageSummary } from "@glimmer/shared";
import { ComputeController } from "./computeController.js";
import type { ComputeLeaseV1 } from "./computeLeaseStore.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");

const config: ComputeConfigV1 = {
  version: 1,
  enabled: true,
  defaultBackend: "runpod_pod",
  activeProfileId: "runpod-a100",
  source: "saved",
  watchdog: {
    endpointUrl: "https://watchdog.example",
    hasIngestToken: true,
    verifiedAt: NOW.toISOString(),
    lastSweepAt: NOW.toISOString(),
  },
  profiles: [
    {
      id: "runpod-a100",
      label: "RunPod A100",
      provider: "runpod",
      cloudType: "SECURE",
      performance: "economy",
      gpuTypeIds: ["NVIDIA A100 80GB PCIe"],
      gpuCount: 1,
      contextTokens: 65_536,
      imageDigest: `ghcr.io/example/glimmer@sha256:${"a".repeat(64)}`,
      containerRegistryAuthId: "registry_auth_1",
      networkVolumeId: "volume_1",
      modelArtifacts: {
        model: { url: "https://models.example.com/model.gguf", sha256: "b".repeat(64) },
        mmproj: { url: "https://models.example.com/mmproj.gguf", sha256: "c".repeat(64) },
        draftModel: { url: "https://models.example.com/draft.gguf", sha256: "d".repeat(64) },
        allowedHosts: ["models.example.com"],
      },
      maxGpuHourlyUsd: 1.75,
      idleTimeoutSeconds: 300,
      clarificationTimeoutSeconds: 120,
      hardSessionLimitSeconds: 7_200,
      dailyBudgetUsd: 10,
      monthlyBudgetUsd: 50,
      hasApiKey: true,
      watchdogConfigured: true,
    },
  ],
};

const usage: ComputeUsageSummary = {
  checkedAt: NOW.toISOString(),
  estimatedTodayUsd: 0,
  estimatedMonthUsd: 0,
  estimatedTotalUsd: 0,
  provenance: { estimate: "local-interval-ledger", reconciled: "unavailable" },
};

function lease(overrides: Partial<ComputeLeaseV1> = {}): ComputeLeaseV1 {
  return {
    version: 1,
    id: "lease-1",
    profileId: "runpod-a100",
    podName: "glimmer-test-lease",
    podId: "pod_123",
    state: "bootstrapping",
    createdAt: "2026-08-29T11:00:00.000Z",
    updatedAt: "2026-08-29T11:00:00.000Z",
    lastActivityAt: "2026-08-29T11:00:00.000Z",
    idleDeadlineAt: "2026-08-29T11:05:00.000Z",
    hardDeadlineAt: "2026-08-29T13:00:00.000Z",
    observedHourlyUsd: 1.39,
    ...overrides,
  };
}

function harness(options: {
  currentLease?: ComputeLeaseV1 | null;
  currentConfig?: ComputeConfigV1;
  pod?: any;
  workerFailure?: Error;
  watchdogStatusFailure?: Error;
  watchdogUpsertFailure?: Error;
  watchdogIdentityFailure?: Error;
}) {
  let currentLease: ComputeLeaseV1 | null =
    "currentLease" in options ? (options.currentLease ?? null) : lease();
  const deletePod = vi.fn().mockResolvedValue(undefined);
  const finishUsage = vi.fn().mockResolvedValue(undefined);
  const clearLease = vi.fn().mockImplementation(async (id: string) => {
    if (currentLease?.id !== id) return false;
    currentLease = null as any;
    return true;
  });
  let deleted = false;
  deletePod.mockImplementation(async () => {
    deleted = true;
  });
  const providerPod =
    options.pod ??
    ({
      id: "pod_123",
      name: "glimmer-test-lease",
      desiredStatus: "RUNNING",
      adjustedCostPerHr: 1.39,
      gpu: { id: "NVIDIA A100 80GB PCIe", count: 1 },
    } as const);
  const fakeClient = {
    getPod: vi.fn().mockImplementation(async () => (deleted ? null : providerPod)),
    listPods: vi.fn().mockResolvedValue([]),
    createPod: vi.fn().mockResolvedValue(providerPod),
    deletePod,
    getPodBilling: vi.fn().mockResolvedValue([]),
  };
  const initialWorker = {
    protocolVersion: 1 as const,
    buildId: "r2-aaaaaaaaaaaa",
    ready: false,
    workerState: "bootstrapping" as const,
    model: { ready: true, contextTokens: 65_536 as const },
  };
  const readyWorker = {
    ...initialWorker,
    ready: true,
    workerState: "ready" as const,
  };
  const workerClient = {
    health: options.workerFailure
      ? vi.fn().mockRejectedValue(options.workerFailure)
      : vi.fn().mockResolvedValueOnce(initialWorker).mockResolvedValue(readyWorker),
    handshake: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      buildId: "r2-aaaaaaaaaaaa",
      capability: "C".repeat(43),
      checkpointKey: "K".repeat(43),
      contextTokens: 65_536,
    }),
  };
  const deleteWorkerSecret = vi.fn().mockResolvedValue(undefined);
  const watchdogClient = {
    status: options.watchdogStatusFailure
      ? vi.fn().mockRejectedValue(options.watchdogStatusFailure)
      : vi.fn().mockResolvedValue({
          service: "glimmer-compute-watchdog",
          schemaVersion: 1,
          ready: true,
          checkedAt: NOW.toISOString(),
          lastSweepAt: NOW.toISOString(),
          staleAfterSeconds: 180,
        }),
    upsertLease: options.watchdogUpsertFailure
      ? vi.fn().mockRejectedValue(options.watchdogUpsertFailure)
      : options.watchdogIdentityFailure
        ? vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValue(options.watchdogIdentityFailure)
        : vi.fn().mockResolvedValue(undefined),
    deleteLease: vi.fn().mockResolvedValue(undefined),
  };
  const storeWorkerHandshake = vi.fn().mockImplementation(async (id: string) => ({
    version: 1,
    leaseId: id,
    capability: "C".repeat(43),
    checkpointKey: "K".repeat(43),
    handshakeIdempotencyKey: "I".repeat(43),
    controllerNonce: "N".repeat(43),
    createdAt: NOW.toISOString(),
    rotatedAt: NOW.toISOString(),
  }));
  const controller = new ComputeController({
    now: () => NOW,
    readConfig: vi.fn().mockResolvedValue(options.currentConfig ?? config),
    saveConfig: vi.fn(),
    readApiKey: vi.fn().mockResolvedValue("key"),
    readWatchdogAccess: vi.fn().mockResolvedValue({
      endpointUrl: "https://watchdog.example",
      ingestToken: "watchdog_ingest_token_with_32_chars_minimum",
    }),
    markWatchdogVerified: vi.fn(),
    readLease: vi.fn().mockImplementation(async () => currentLease),
    saveLease: vi.fn().mockImplementation(async (next: ComputeLeaseV1) => {
      currentLease = next;
      return next;
    }),
    updateLease: vi.fn().mockImplementation(async (mutate: any) => {
      if (!currentLease) return null;
      currentLease = mutate(currentLease);
      return currentLease;
    }),
    clearLease,
    beginUsage: vi.fn(),
    finishUsage,
    readUsage: vi.fn().mockResolvedValue(usage),
    readTrackedPodIds: vi.fn().mockResolvedValue(["pod_123"]),
    storeReconciledUsage: vi.fn(),
    clientFactory: () => fakeClient as any,
    watchdogFactory: vi.fn().mockReturnValue(watchdogClient),
    workerFactory: vi.fn().mockReturnValue(workerClient),
    createWorkerSecret: vi.fn().mockImplementation(async (id: string) => ({
      version: 1,
      leaseId: id,
      bootstrapToken: "B".repeat(43),
      handshakeIdempotencyKey: "I".repeat(43),
      controllerNonce: "N".repeat(43),
      createdAt: NOW.toISOString(),
    })),
    readWorkerSecret: vi.fn(),
    storeWorkerHandshake,
    deleteWorkerSecret,
    sleep: vi.fn().mockResolvedValue(undefined),
    workerReadyAttempts: 1,
  } as any);
  return {
    controller,
    deletePod,
    finishUsage,
    clearLease,
    deleteWorkerSecret,
    fakeClient,
    workerClient,
    watchdogClient,
    currentLease: () => currentLease,
  };
}

describe("ComputeController startup recovery", () => {
  it("terminates a recovered Pod when the independent watchdog is unavailable", async () => {
    const { controller, deletePod, currentLease } = harness({
      currentLease: lease({
        idleDeadlineAt: "2026-08-29T12:05:00.000Z",
        hardDeadlineAt: "2026-08-29T14:00:00.000Z",
      }),
      watchdogStatusFailure: new Error("watchdog offline"),
    });
    await expect(controller.reconcileOnStartup()).resolves.toMatchObject({
      recovered: false,
      cleaned: true,
      detail: expect.stringContaining("watchdog is unavailable"),
    });
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(currentLease()).toBeNull();
  });

  it("terminates a Pod whose durable idle deadline passed while the gateway was down", async () => {
    const { controller, deletePod, finishUsage, clearLease } = harness({});
    await expect(controller.reconcileOnStartup()).resolves.toMatchObject({
      recovered: false,
      cleaned: true,
      detail: "expired compute lease terminated",
    });
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(finishUsage).toHaveBeenCalledWith("lease-1", NOW.toISOString());
    expect(clearLease).toHaveBeenCalledWith("lease-1");
  });

  it("terminates instead of guessing when the persisted profile no longer exists", async () => {
    const { controller, deletePod } = harness({
      currentLease: lease({ profileId: "removed-profile" }),
    });
    await expect(controller.reconcileOnStartup()).resolves.toMatchObject({
      cleaned: true,
      detail: "Pod terminated because its compute profile is missing",
    });
    expect(deletePod).toHaveBeenCalledWith("pod_123");
  });

  it("terminates a recovered allocation that violates the price ceiling", async () => {
    const { controller, deletePod } = harness({
      currentLease: lease({
        idleDeadlineAt: "2026-08-29T12:05:00.000Z",
        hardDeadlineAt: "2026-08-29T14:00:00.000Z",
      }),
      pod: {
        id: "pod_123",
        name: "glimmer-test-lease",
        desiredStatus: "RUNNING",
        adjustedCostPerHr: 9.99,
        gpu: { id: "NVIDIA A100 80GB PCIe", count: 1 },
      },
    });
    const result = await controller.reconcileOnStartup();
    expect(result.cleaned).toBe(true);
    expect(result.detail).toContain("exceeds the configured");
    expect(deletePod).toHaveBeenCalledWith("pod_123");
  });
});

describe("ComputeController authenticated worker startup", () => {
  it("refuses paid creation when the independent watchdog is not configured", async () => {
    const unsafeConfig = {
      ...config,
      profiles: config.profiles.map((profile) => ({ ...profile, watchdogConfigured: false })),
    };
    const { controller, fakeClient } = harness({
      currentLease: null,
      currentConfig: unsafeConfig,
    });
    await expect(controller.start()).rejects.toThrow(/watchdog has passed its live test/);
    expect(fakeClient.createPod).not.toHaveBeenCalled();
  });

  it("refuses paid creation when the live watchdog status is unavailable", async () => {
    const { controller, fakeClient } = harness({
      currentLease: null,
      watchdogStatusFailure: new Error("network unavailable"),
    });
    await expect(controller.start()).rejects.toThrow(/watchdog is unavailable/);
    expect(fakeClient.createPod).not.toHaveBeenCalled();
  });

  it("refuses paid creation when the watchdog does not accept the provisional lease", async () => {
    const { controller, fakeClient, currentLease } = harness({
      currentLease: null,
      watchdogUpsertFailure: new Error("lease rejected"),
    });
    await expect(controller.start()).rejects.toThrow(/watchdog rejected its lease/);
    expect(fakeClient.createPod).not.toHaveBeenCalled();
    expect(currentLease()).toBeNull();
  });

  it("terminates an allocated Pod if the watchdog rejects its exact identity", async () => {
    const { controller, fakeClient, deletePod, currentLease } = harness({
      currentLease: null,
      watchdogIdentityFailure: new Error("identity rejected"),
    });
    await expect(controller.start()).rejects.toThrow(/watchdog did not accept its identity/);
    expect(fakeClient.createPod).toHaveBeenCalledTimes(1);
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(currentLease()).toBeNull();
  });

  it("never promotes public health JSON to authenticated readiness", async () => {
    const { controller, workerClient } = harness({
      currentLease: lease({
        state: "bootstrapping",
        idleDeadlineAt: "2026-08-29T12:05:00.000Z",
        hardDeadlineAt: "2026-08-29T14:00:00.000Z",
      }),
    });
    workerClient.health.mockReset().mockResolvedValue({
      protocolVersion: 1,
      buildId: "r2-aaaaaaaaaaaa",
      ready: true,
      workerState: "ready",
      model: { ready: true, contextTokens: 65_536 },
    });
    await expect(controller.getStatus()).resolves.toMatchObject({
      state: "bootstrapping",
      worker: { ready: false, workerState: "bootstrapping" },
      detail: "Worker is reachable, but authenticated readiness is not established.",
    });
  });

  it("does not report ready until the worker identity, context, and rotated capability validate", async () => {
    const { controller, fakeClient, workerClient, currentLease } = harness({ currentLease: null });
    const result = await controller.start();
    expect(result).toMatchObject({
      started: true,
      status: {
        state: "ready",
        worker: {
          buildId: "r2-aaaaaaaaaaaa",
          ready: true,
          model: { contextTokens: 65_536 },
        },
      },
    });
    expect(workerClient.handshake).toHaveBeenCalledTimes(1);
    expect(currentLease()).toMatchObject({
      state: "ready",
      workerProtocolVersion: 1,
      workerBuildId: "r2-aaaaaaaaaaaa",
    });
    const input = fakeClient.createPod.mock.calls[0][0];
    expect(input.ports).toEqual(["4318/http"]);
    expect(input.containerRegistryAuthId).toBe("registry_auth_1");
    expect(input.env).toMatchObject({
      GLIMMER_CONTEXT_TOKENS: "65536",
      GLIMMER_WORKER_BOOTSTRAP_TOKEN: "B".repeat(43),
      GLIMMER_MODEL_SHA256: "b".repeat(64),
    });
    expect(JSON.stringify(input.env)).not.toContain("RunPod");
  });

  it("terminates immediately and clears worker secrets when authenticated readiness fails", async () => {
    const { controller, deletePod, deleteWorkerSecret, currentLease } = harness({
      currentLease: null,
      workerFailure: new Error("worker proxy unavailable"),
    });
    await expect(controller.start()).rejects.toThrow(/Worker bootstrap failed/);
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(deleteWorkerSecret).toHaveBeenCalledTimes(1);
    expect(currentLease()).toBeNull();
  });
});
