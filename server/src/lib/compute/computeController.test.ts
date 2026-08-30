import { describe, expect, it, vi } from "vitest";
import type { ComputeConfigV1, ComputeUsageSummary } from "@glimmer/shared";
import { ComputeControlError, ComputeController } from "./computeController.js";
import type { ComputeLeaseV1 } from "./computeLeaseStore.js";
import { RunPodApiError } from "./runpodClient.js";
import { RunPodSchemaError } from "./runpodSchemas.js";

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
  saveLeaseFailureCall?: number;
  readUsageFailureCall?: number;
  beginUsageFailure?: Error;
  now?: () => Date;
  monotonicNow?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  usageSummary?: ComputeUsageSummary;
}) {
  let currentLease: ComputeLeaseV1 | null =
    "currentLease" in options ? (options.currentLease ?? null) : lease();
  const deletePod = vi.fn().mockResolvedValue(undefined);
  const beginUsage = options.beginUsageFailure
    ? vi.fn().mockRejectedValue(options.beginUsageFailure)
    : vi.fn().mockResolvedValue(undefined);
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
  let activeProviderPod = providerPod;
  const fakeClient = {
    getPod: vi.fn().mockImplementation(async () => (deleted ? null : activeProviderPod)),
    listPods: vi.fn().mockResolvedValue([]),
    createPod: vi.fn().mockImplementation(async (input: { name: string }) => {
      activeProviderPod = { ...providerPod, name: input.name };
      return activeProviderPod;
    }),
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
  let saveLeaseCalls = 0;
  const saveLease = vi.fn().mockImplementation(async (next: ComputeLeaseV1) => {
    saveLeaseCalls += 1;
    if (saveLeaseCalls === options.saveLeaseFailureCall) {
      throw new Error("lease persistence unavailable");
    }
    currentLease = next;
    return next;
  });
  let readUsageCalls = 0;
  const readUsage = vi.fn().mockImplementation(async () => {
    readUsageCalls += 1;
    if (readUsageCalls === options.readUsageFailureCall) {
      throw new Error("usage summary unavailable");
    }
    return options.usageSummary ?? usage;
  });
  const readWorkerSecret = vi.fn();
  let monotonicMs = 0;
  const monotonicNow = options.monotonicNow ?? (() => monotonicMs);
  const sleep =
    options.sleep ??
    vi.fn().mockImplementation(async (milliseconds: number) => {
      monotonicMs += milliseconds;
    });
  const controller = new ComputeController({
    now: options.now ?? (() => NOW),
    monotonicNow,
    readConfig: vi.fn().mockResolvedValue(options.currentConfig ?? config),
    saveConfig: vi.fn(),
    readApiKey: vi.fn().mockResolvedValue("key"),
    readWatchdogAccess: vi.fn().mockResolvedValue({
      endpointUrl: "https://watchdog.example",
      ingestToken: "watchdog_ingest_token_with_32_chars_minimum",
    }),
    markWatchdogVerified: vi.fn(),
    readLease: vi.fn().mockImplementation(async () => currentLease),
    saveLease,
    updateLease: vi.fn().mockImplementation(async (mutate: any) => {
      if (!currentLease) return null;
      currentLease = mutate(currentLease);
      return currentLease;
    }),
    clearLease,
    beginUsage,
    finishUsage,
    readUsage,
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
    readWorkerSecret,
    storeWorkerHandshake,
    deleteWorkerSecret,
    sleep,
    workerReadyAttempts: 1,
  } as any);
  return {
    controller,
    deletePod,
    beginUsage,
    finishUsage,
    clearLease,
    deleteWorkerSecret,
    fakeClient,
    workerClient,
    watchdogClient,
    saveLease,
    readUsage,
    readWorkerSecret,
    monotonicNow,
    sleep,
    currentLease: () => currentLease,
  };
}

describe("ComputeController startup recovery", () => {
  it("retains a name-only lease through its hard deadline while visibility converges", async () => {
    const { controller, clearLease, deleteWorkerSecret, currentLease } = harness({
      currentLease: lease({
        podId: undefined,
        state: "terminating",
        createdAt: "2026-08-29T11:00:00.000Z",
        idleDeadlineAt: "2026-08-29T12:05:00.000Z",
        hardDeadlineAt: "2026-08-29T14:00:00.000Z",
      }),
    });

    await expect(controller.reconcileOnStartup()).resolves.toMatchObject({
      recovered: false,
      cleaned: false,
      detail: "provisional Pod reconciliation is still pending",
    });
    expect(clearLease).not.toHaveBeenCalled();
    expect(deleteWorkerSecret).not.toHaveBeenCalled();
    expect(currentLease()).toMatchObject({ state: "terminating", podId: undefined });
  });

  it("terminates a recovered Pod when the independent watchdog is unavailable", async () => {
    const { controller, deletePod, beginUsage, currentLease } = harness({
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
    expect(beginUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: "lease-1",
        podId: "pod_123",
        startedAt: "2026-08-29T11:00:00.000Z",
        hourlyUsd: 1.75,
      }),
    );
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
    const { controller, deletePod, beginUsage } = harness({
      currentLease: lease({ profileId: "removed-profile", observedHourlyUsd: undefined }),
    });
    await expect(controller.reconcileOnStartup()).resolves.toMatchObject({
      cleaned: true,
      detail: "Pod terminated because its compute profile is missing",
    });
    expect(beginUsage).toHaveBeenCalledWith(
      expect.objectContaining({ podId: "pod_123", hourlyUsd: 0 }),
    );
    expect(deletePod).toHaveBeenCalledWith("pod_123");
  });

  it("polls delayed allocation evidence and restores the original usage interval", async () => {
    const incomplete = {
      id: "pod_123",
      name: "glimmer-test-lease",
      desiredStatus: "RUNNING" as const,
      adjustedCostPerHr: 1.39,
      gpu: { id: "NVIDIA A100 80GB PCIe" },
    };
    const complete = { ...incomplete, gpu: { ...incomplete.gpu, count: 1 } };
    const { controller, fakeClient, beginUsage, readWorkerSecret, currentLease } = harness({
      currentLease: lease({
        idleDeadlineAt: "2026-08-29T12:05:00.000Z",
        hardDeadlineAt: "2026-08-29T14:00:00.000Z",
      }),
      pod: incomplete,
    });
    fakeClient.getPod.mockReset().mockResolvedValueOnce(incomplete).mockResolvedValue(complete);
    readWorkerSecret.mockResolvedValue({
      version: 1,
      leaseId: "lease-1",
      capability: "C".repeat(43),
      checkpointKey: "K".repeat(43),
      handshakeIdempotencyKey: "I".repeat(43),
      controllerNonce: "N".repeat(43),
      createdAt: NOW.toISOString(),
    });

    await expect(controller.reconcileOnStartup()).resolves.toMatchObject({
      recovered: true,
      cleaned: false,
    });
    expect(beginUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: "lease-1",
        podId: "pod_123",
        startedAt: "2026-08-29T11:00:00.000Z",
        hourlyUsd: 1.75,
      }),
    );
    expect(currentLease()).toMatchObject({ podId: "pod_123", state: "ready" });
  });

  it.each([
    {
      label: "idle",
      leasePatch: {
        idleDeadlineAt: new Date(NOW.getTime() + 20_000).toISOString(),
        hardDeadlineAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      },
      detail: "idle deadline elapsed before worker bootstrap",
    },
    {
      label: "hard session",
      leasePatch: {
        idleDeadlineAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
        hardDeadlineAt: new Date(NOW.getTime() + 20_000).toISOString(),
      },
      detail: "hard session deadline elapsed before worker bootstrap",
    },
  ])(
    "terminates recovery when the $label deadline passes during evidence polling",
    async (testCase) => {
      const incomplete = {
        id: "pod_123",
        name: "glimmer-test-lease",
        desiredStatus: "RUNNING" as const,
        adjustedCostPerHr: 1.39,
        gpu: { id: "NVIDIA A100 80GB PCIe" },
      };
      let elapsedMs = 0;
      const sleep = vi.fn().mockImplementation(async (milliseconds: number) => {
        elapsedMs += milliseconds;
      });
      const { controller, fakeClient, deletePod, workerClient, readWorkerSecret } = harness({
        currentLease: lease(testCase.leasePatch),
        pod: incomplete,
        now: () => new Date(NOW.getTime() + elapsedMs),
        monotonicNow: () => elapsedMs,
        sleep,
      });
      let evidenceReads = 0;
      fakeClient.getPod.mockImplementation(
        async (_podId: string, requestOptions?: { timeoutMs?: number }) => {
          if (!requestOptions) return deletePod.mock.calls.length ? null : incomplete;
          elapsedMs += Math.min(10_000, requestOptions.timeoutMs ?? 10_000);
          evidenceReads += 1;
          return {
            ...incomplete,
            gpu: { ...incomplete.gpu, ...(evidenceReads >= 2 ? { count: 1 } : {}) },
          };
        },
      );

      await expect(controller.reconcileOnStartup()).resolves.toMatchObject({
        recovered: false,
        cleaned: true,
        detail: expect.stringContaining(testCase.detail),
      });
      expect(elapsedMs).toBe(22_500);
      expect(deletePod).toHaveBeenCalledWith("pod_123");
      expect(readWorkerSecret).not.toHaveBeenCalled();
      expect(workerClient.health).not.toHaveBeenCalled();
    },
  );

  it("terminates recovery when the budget is exhausted during evidence polling", async () => {
    const incomplete = {
      id: "pod_123",
      name: "glimmer-test-lease",
      desiredStatus: "RUNNING" as const,
      adjustedCostPerHr: 1.39,
      gpu: { id: "NVIDIA A100 80GB PCIe" },
    };
    const complete = { ...incomplete, gpu: { ...incomplete.gpu, count: 1 } };
    const { controller, fakeClient, deletePod, readUsage, readWorkerSecret, workerClient } =
      harness({
        currentLease: lease({
          idleDeadlineAt: "2026-08-29T12:05:00.000Z",
          hardDeadlineAt: "2026-08-29T14:00:00.000Z",
        }),
        pod: incomplete,
      });
    fakeClient.getPod
      .mockReset()
      .mockResolvedValueOnce(incomplete)
      .mockResolvedValueOnce(complete)
      .mockResolvedValueOnce(null);
    readUsage
      .mockReset()
      .mockResolvedValueOnce(usage)
      .mockResolvedValue({
        ...usage,
        estimatedTodayUsd: 10,
        estimatedMonthUsd: 10,
        estimatedTotalUsd: 10,
      });

    await expect(controller.reconcileOnStartup()).resolves.toMatchObject({
      recovered: false,
      cleaned: true,
      detail: expect.stringContaining("daily compute budget is exhausted"),
    });
    expect(readUsage).toHaveBeenCalledTimes(2);
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(readWorkerSecret).not.toHaveBeenCalled();
    expect(workerClient.health).not.toHaveBeenCalled();
  });

  it("terminates the exact recovered Pod when a permanent evidence read fails", async () => {
    const incomplete = {
      id: "pod_123",
      name: "glimmer-test-lease",
      desiredStatus: "RUNNING" as const,
      adjustedCostPerHr: 1.39,
      gpu: { id: "NVIDIA A100 80GB PCIe" },
    };
    const { controller, fakeClient, deletePod, readWorkerSecret, workerClient } = harness({
      currentLease: lease({
        idleDeadlineAt: "2026-08-29T12:05:00.000Z",
        hardDeadlineAt: "2026-08-29T14:00:00.000Z",
      }),
      pod: incomplete,
    });
    fakeClient.getPod
      .mockReset()
      .mockResolvedValueOnce(incomplete)
      .mockRejectedValueOnce(new RunPodApiError("RunPod API request failed with HTTP 401", 401))
      .mockResolvedValueOnce(null);

    await expect(controller.reconcileOnStartup()).resolves.toMatchObject({
      recovered: false,
      cleaned: true,
      detail: "Pod terminated because allocation evidence could not be verified",
    });
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(readWorkerSecret).not.toHaveBeenCalled();
    expect(workerClient.health).not.toHaveBeenCalled();
  });

  it("never rebinds a durable lease to a mismatched startup response", async () => {
    const { controller, fakeClient, deletePod, beginUsage, workerClient, currentLease } = harness({
      currentLease: lease({
        idleDeadlineAt: "2026-08-29T12:05:00.000Z",
        hardDeadlineAt: "2026-08-29T14:00:00.000Z",
      }),
    });
    fakeClient.getPod.mockResolvedValue({
      id: "pod_other",
      name: "glimmer-test-lease",
      desiredStatus: "RUNNING",
      adjustedCostPerHr: 1.39,
      gpu: { id: "NVIDIA A100 80GB PCIe", count: 1 },
    });

    await expect(controller.reconcileOnStartup()).resolves.toMatchObject({
      recovered: false,
      cleaned: false,
      detail: expect.stringContaining("exact-id termination is still pending"),
    });
    expect(beginUsage).toHaveBeenCalledWith(expect.objectContaining({ podId: "pod_123" }));
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(deletePod).not.toHaveBeenCalledWith("pod_other");
    expect(workerClient.health).not.toHaveBeenCalled();
    expect(currentLease()).toMatchObject({ podId: "pod_123", state: "terminating" });
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

  it.each([400, 401, 403])(
    "clears a definitively rejected HTTP %i create without name reconciliation",
    async (status) => {
      const {
        controller,
        fakeClient,
        clearLease,
        deleteWorkerSecret,
        watchdogClient,
        currentLease,
      } = harness({ currentLease: null });
      fakeClient.createPod.mockRejectedValue(
        new RunPodApiError("provider-secret-body-must-not-surface", status),
      );

      const failure = await controller.start().catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ComputeControlError);
      expect(failure).toMatchObject({
        message: `RunPod rejected Pod creation with HTTP ${status}; local cleanup completed`,
        statusCode: 502,
      });
      expect((failure as Error).message).not.toContain("provider-secret-body");
      expect(fakeClient.createPod).toHaveBeenCalledTimes(1);
      expect(fakeClient.listPods).not.toHaveBeenCalled();
      expect(deleteWorkerSecret).toHaveBeenCalledTimes(1);
      expect(watchdogClient.deleteLease).toHaveBeenCalledTimes(1);
      expect(clearLease).toHaveBeenCalledTimes(1);
      expect(currentLease()).toBeNull();
    },
  );

  it.each([
    ["HTTP 408", new RunPodApiError("RunPod API request failed with HTTP 408", 408)],
    ["HTTP 409", new RunPodApiError("RunPod API request failed with HTTP 409", 409)],
    ["HTTP 425", new RunPodApiError("RunPod API request failed with HTTP 425", 425)],
    ["HTTP 429", new RunPodApiError("RunPod API request failed with HTTP 429", 429)],
    ["HTTP 404", new RunPodApiError("RunPod API request failed with HTTP 404", 404)],
    ["HTTP 422", new RunPodApiError("RunPod API request failed with HTTP 422", 422)],
    ["unknown HTTP 418", new RunPodApiError("RunPod API request failed with HTTP 418", 418)],
    ["HTTP 500", new RunPodApiError("RunPod API request failed with HTTP 500", 500)],
    ["HTTP 200 parse failure", new RunPodApiError("RunPod API returned invalid JSON", 200)],
    ["network failure", new RunPodApiError("RunPod API request failed: network unavailable")],
    ["generic failure", new Error("create response lost")],
    ["post-create schema failure", new RunPodSchemaError("RunPod Pod response is malformed")],
  ])("keeps protected exact-name convergence after %s", async (_label, providerError) => {
    const { controller, fakeClient, clearLease, deleteWorkerSecret, watchdogClient, currentLease } =
      harness({ currentLease: null });
    fakeClient.createPod.mockRejectedValue(providerError);

    await expect(controller.start()).rejects.toThrow(/protected exact-name reconciliation/);

    expect(fakeClient.listPods).toHaveBeenCalledTimes(3);
    expect(fakeClient.createPod).toHaveBeenCalledTimes(1);
    expect(deleteWorkerSecret).not.toHaveBeenCalled();
    expect(watchdogClient.deleteLease).not.toHaveBeenCalled();
    expect(clearLease).not.toHaveBeenCalled();
    expect(currentLease()).toMatchObject({ state: "terminating" });
    expect(currentLease()?.podId).toBeUndefined();
  });

  it("retains a confirmed lease and retries when definitive rejection cleanup is incomplete", async () => {
    vi.useFakeTimers();
    try {
      const {
        controller,
        fakeClient,
        clearLease,
        deleteWorkerSecret,
        watchdogClient,
        currentLease,
      } = harness({ currentLease: null });
      fakeClient.createPod.mockRejectedValue(
        new RunPodApiError("provider-secret-body-must-not-surface", 401),
      );
      deleteWorkerSecret.mockRejectedValueOnce(new Error("secret store unavailable"));

      await expect(controller.start()).rejects.toMatchObject({
        message: "RunPod rejected Pod creation with HTTP 401; local cleanup is pending",
        statusCode: 502,
      });

      expect(currentLease()).toMatchObject({
        state: "terminating",
        providerTerminationConfirmedAt: NOW.toISOString(),
      });
      expect(clearLease).not.toHaveBeenCalled();
      expect(watchdogClient.deleteLease).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);

      expect(deleteWorkerSecret).toHaveBeenCalledTimes(2);
      expect(watchdogClient.deleteLease).toHaveBeenCalledTimes(1);
      expect(clearLease).toHaveBeenCalledTimes(1);
      expect(currentLease()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains protection after a lost create response until a delayed Pod is terminated", async () => {
    const {
      controller,
      fakeClient,
      deletePod,
      beginUsage,
      deleteWorkerSecret,
      watchdogClient,
      currentLease,
    } = harness({ currentLease: null });
    let createdName = "";
    fakeClient.createPod.mockImplementation(async (input: { name: string }) => {
      createdName = input.name;
      throw new Error("create response lost");
    });
    fakeClient.listPods
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockImplementation(async () => [
        {
          id: "pod_delayed",
          name: createdName,
          desiredStatus: "RUNNING",
          adjustedCostPerHr: 1.39,
          gpu: { id: "NVIDIA A100 80GB PCIe", count: 1 },
        },
      ]);

    await expect(controller.start()).rejects.toThrow(/protected exact-name reconciliation/);
    expect(currentLease()).toMatchObject({
      podName: createdName,
      state: "terminating",
    });
    expect(currentLease()?.podId).toBeUndefined();
    expect(deleteWorkerSecret).not.toHaveBeenCalled();
    expect(watchdogClient.deleteLease).not.toHaveBeenCalled();

    await expect(controller.stop()).resolves.toMatchObject({ stopped: true, terminated: true });
    expect(beginUsage).toHaveBeenCalledWith(
      expect.objectContaining({ podId: "pod_delayed", hourlyUsd: 1.75 }),
    );
    expect(deletePod).toHaveBeenCalledWith("pod_delayed");
    expect(currentLease()).toBeNull();
  });

  it("terminates every exact-name Pod after an ambiguous create outcome", async () => {
    const { controller, fakeClient, deletePod, beginUsage, currentLease } = harness({
      currentLease: null,
    });
    let createdName = "";
    fakeClient.createPod.mockImplementation(async (input: { name: string }) => {
      createdName = input.name;
      throw new Error("create response lost");
    });
    fakeClient.listPods.mockImplementation(async () => [
      {
        id: "pod_ambiguous_1",
        name: createdName,
        desiredStatus: "RUNNING",
        adjustedCostPerHr: 1.39,
      },
      {
        id: "pod_ambiguous_2",
        name: createdName,
        desiredStatus: "RUNNING",
        adjustedCostPerHr: 1.49,
      },
    ]);

    await expect(controller.start()).rejects.toThrow(/create outcome was ambiguous/);
    expect(deletePod).toHaveBeenCalledWith("pod_ambiguous_1");
    expect(deletePod).toHaveBeenCalledWith("pod_ambiguous_2");
    expect(beginUsage).toHaveBeenCalledWith(
      expect.objectContaining({ podId: "pod_ambiguous_1", hourlyUsd: 1.75 }),
    );
    expect(beginUsage).toHaveBeenCalledWith(
      expect.objectContaining({ podId: "pod_ambiguous_2", hourlyUsd: 1.75 }),
    );
    expect(currentLease()).toBeNull();
  });

  it("terminates an allocated Pod if the watchdog rejects its exact identity", async () => {
    const { controller, fakeClient, deletePod, currentLease } = harness({
      currentLease: null,
      watchdogIdentityFailure: new Error("identity rejected"),
    });
    await expect(controller.start()).rejects.toThrow(
      /watchdog did not accept the allocated Pod identity/,
    );
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

  it("polls the exact Pod until an incomplete create response proves one approved GPU", async () => {
    const { controller, fakeClient, deletePod, sleep } = harness({ currentLease: null });
    let createdName = "";
    let exactReads = 0;
    fakeClient.createPod.mockImplementation(async (input: { name: string }) => {
      createdName = input.name;
      return {
        id: "pod_123",
        name: input.name,
        desiredStatus: "RUNNING" as const,
        adjustedCostPerHr: 1.39,
        gpu: { id: "NVIDIA A100 80GB PCIe" },
      };
    });
    fakeClient.getPod.mockImplementation(async () => {
      exactReads += 1;
      return {
        id: "pod_123",
        name: createdName,
        desiredStatus: "RUNNING",
        adjustedCostPerHr: 1.39,
        gpu: {
          id: "NVIDIA A100 80GB PCIe",
          ...(exactReads >= 6 ? { count: 1 } : {}),
        },
      };
    });

    await expect(controller.start()).resolves.toMatchObject({
      started: true,
      status: { state: "ready", pod: { gpuCount: 1 } },
    });
    expect(fakeClient.getPod).toHaveBeenCalledWith(
      "pod_123",
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(exactReads).toBe(6);
    expect(sleep).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledWith(2_500);
    expect(deletePod).not.toHaveBeenCalled();
  });

  it("fails closed when exact Pod reads never prove the allocated GPU count", async () => {
    const incompletePod = {
      id: "pod_123",
      name: "glimmer-test-lease",
      desiredStatus: "RUNNING" as const,
      adjustedCostPerHr: 1.39,
      gpu: { id: "NVIDIA A100 80GB PCIe" },
    };
    const { controller, fakeClient, deletePod, beginUsage, workerClient, sleep, currentLease } =
      harness({
        currentLease: null,
        pod: incompletePod,
      });

    await expect(controller.start()).rejects.toThrow(
      "RunPod did not prove that exactly one GPU was allocated",
    );
    // Ten immediate/transient exact reads span the monotonic 25-second
    // deadline. The eleventh read is the exact-id post-delete confirmation.
    expect(fakeClient.getPod).toHaveBeenCalledTimes(11);
    expect(sleep).toHaveBeenCalledTimes(10);
    expect(sleep).toHaveBeenCalledWith(2_500);
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(beginUsage).toHaveBeenCalledWith(
      expect.objectContaining({ podId: "pod_123", startedAt: NOW.toISOString(), hourlyUsd: 1.75 }),
    );
    expect(workerClient.health).not.toHaveBeenCalled();
    expect(currentLease()).toBeNull();
  });

  it("bounds slow exact reads and retry sleeps to one monotonic 25-second window", async () => {
    const incompletePod = {
      id: "pod_123",
      name: "glimmer-test-lease",
      desiredStatus: "RUNNING" as const,
      adjustedCostPerHr: 1.39,
      gpu: { id: "NVIDIA A100 80GB PCIe" },
    };
    let elapsedMs = 0;
    const sleep = vi.fn().mockImplementation(async (milliseconds: number) => {
      elapsedMs += milliseconds;
    });
    const { controller, fakeClient, deletePod, workerClient } = harness({
      currentLease: null,
      pod: incompletePod,
      monotonicNow: () => elapsedMs,
      sleep,
    });
    fakeClient.getPod.mockImplementation(
      async (_podId: string, requestOptions?: { timeoutMs?: number }) => {
        if (!requestOptions) return null;
        elapsedMs += Math.min(10_000, requestOptions.timeoutMs ?? 10_000);
        return { ...incompletePod, name: fakeClient.createPod.mock.calls[0][0].name };
      },
    );

    await expect(controller.start()).rejects.toThrow(
      "RunPod did not prove that exactly one GPU was allocated",
    );
    const evidenceReads = fakeClient.getPod.mock.calls.filter((call) => call.length === 2);
    expect(evidenceReads).toHaveLength(2);
    expect(evidenceReads.map(([, options]) => options.timeoutMs)).toEqual([25_000, 12_500]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(elapsedMs).toBe(25_000);
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(workerClient.health).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "GPU count",
      observed: { gpu: { id: "NVIDIA A100 80GB PCIe", count: 2 } },
      error: /allocated 2 GPUs/,
    },
    {
      label: "GPU type",
      observed: { gpu: { id: "NVIDIA H100 PCIe", count: 1 } },
      error: /outside the active profile/,
    },
    {
      label: "provider rate",
      observed: {
        adjustedCostPerHr: 1.8,
        gpu: { id: "NVIDIA A100 80GB PCIe", count: 1 },
      },
      error: /exceeds the configured/,
    },
  ])("fails immediately when late $label evidence violates policy", async (scenario) => {
    const incompletePod = {
      id: "pod_123",
      name: "glimmer-test-lease",
      desiredStatus: "RUNNING" as const,
      adjustedCostPerHr: 1.39,
      gpu: { id: "NVIDIA A100 80GB PCIe" },
    };
    const { controller, fakeClient, deletePod, workerClient, sleep } = harness({
      currentLease: null,
      pod: incompletePod,
    });
    fakeClient.getPod
      .mockImplementationOnce(async () => ({
        ...incompletePod,
        name: fakeClient.createPod.mock.calls[0][0].name,
        ...scenario.observed,
      }))
      .mockResolvedValueOnce(null);

    await expect(controller.start()).rejects.toThrow(scenario.error);
    expect(sleep).not.toHaveBeenCalled();
    expect(fakeClient.getPod).toHaveBeenCalledTimes(2);
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(workerClient.health).not.toHaveBeenCalled();
  });

  it.each([
    new RunPodApiError("RunPod API request failed with HTTP 401", 401),
    new RunPodSchemaError("RunPod Pod allocation metadata is malformed"),
  ])("fails immediately on permanent allocation read error: %s", async (providerError) => {
    const incompletePod = {
      id: "pod_123",
      name: "glimmer-test-lease",
      desiredStatus: "RUNNING" as const,
      adjustedCostPerHr: 1.39,
      gpu: { id: "NVIDIA A100 80GB PCIe" },
    };
    const { controller, fakeClient, deletePod, workerClient, sleep } = harness({
      currentLease: null,
      pod: incompletePod,
    });
    fakeClient.getPod.mockRejectedValueOnce(providerError).mockResolvedValueOnce(null);

    await expect(controller.start()).rejects.toThrow(providerError.message);
    expect(sleep).not.toHaveBeenCalled();
    expect(fakeClient.getPod).toHaveBeenCalledTimes(2);
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(workerClient.health).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "idle",
      profilePatch: { idleTimeoutSeconds: 20 },
      error: "idle deadline elapsed before worker bootstrap",
    },
    {
      label: "hard session",
      profilePatch: { hardSessionLimitSeconds: 20 },
      error: "hard session deadline elapsed before worker bootstrap",
    },
  ])("re-checks the $label deadline immediately before worker bootstrap", async (scenario) => {
    const incompletePod = {
      id: "pod_123",
      name: "glimmer-test-lease",
      desiredStatus: "RUNNING" as const,
      adjustedCostPerHr: 1.39,
      gpu: { id: "NVIDIA A100 80GB PCIe" },
    };
    const shortDeadlineConfig: ComputeConfigV1 = {
      ...config,
      profiles: config.profiles.map((profile) => ({ ...profile, ...scenario.profilePatch })),
    };
    let elapsedMs = 0;
    const sleep = vi.fn().mockImplementation(async (milliseconds: number) => {
      elapsedMs += milliseconds;
    });
    const { controller, fakeClient, deletePod, workerClient } = harness({
      currentLease: null,
      currentConfig: shortDeadlineConfig,
      pod: incompletePod,
      now: () => new Date(NOW.getTime() + elapsedMs),
      monotonicNow: () => elapsedMs,
      sleep,
    });
    let evidenceReads = 0;
    fakeClient.getPod.mockImplementation(
      async (_podId: string, requestOptions?: { timeoutMs?: number }) => {
        if (!requestOptions) return null;
        elapsedMs += Math.min(10_000, requestOptions.timeoutMs ?? 10_000);
        evidenceReads += 1;
        return {
          ...incompletePod,
          name: fakeClient.createPod.mock.calls[0][0].name,
          gpu: {
            ...incompletePod.gpu,
            ...(evidenceReads >= 2 ? { count: 1 } : {}),
          },
        };
      },
    );

    await expect(controller.start()).rejects.toThrow(scenario.error);
    expect(elapsedMs).toBe(22_500);
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(workerClient.health).not.toHaveBeenCalled();
  });

  it("re-checks the accrued budget immediately before worker bootstrap", async () => {
    const { controller, readUsage, deletePod, workerClient } = harness({ currentLease: null });
    const exhaustedUsage: ComputeUsageSummary = {
      ...usage,
      estimatedTodayUsd: 10,
      estimatedMonthUsd: 10,
      estimatedTotalUsd: 10,
    };
    readUsage
      .mockReset()
      .mockResolvedValueOnce(usage)
      .mockResolvedValueOnce(usage)
      .mockResolvedValueOnce(usage)
      .mockResolvedValue(exhaustedUsage);

    await expect(controller.start()).rejects.toThrow(
      "budget no longer permits worker bootstrap: daily compute budget is exhausted",
    );
    expect(readUsage).toHaveBeenCalledTimes(4);
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(workerClient.health).not.toHaveBeenCalled();
  });

  it("tracks an unknown-rate allocation conservatively before evidence polling", async () => {
    const incompletePod = {
      id: "pod_123",
      name: "glimmer-test-lease",
      desiredStatus: "RUNNING" as const,
      gpu: { id: "NVIDIA A100 80GB PCIe" },
    };
    const { controller, beginUsage, deletePod } = harness({
      currentLease: null,
      pod: incompletePod,
    });

    await expect(controller.start()).rejects.toThrow(
      "RunPod did not report a verifiable hourly rate",
    );
    expect(beginUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        podId: "pod_123",
        startedAt: NOW.toISOString(),
        hourlyUsd: 1.75,
      }),
    );
    expect(deletePod).toHaveBeenCalledWith("pod_123");
  });

  it("never trusts or deletes a mismatched refreshed Pod identity", async () => {
    const { controller, fakeClient, deletePod, workerClient } = harness({ currentLease: null });
    fakeClient.createPod.mockImplementation(async () => ({
      id: "pod_123",
      name: "not-the-leased-name",
      desiredStatus: "RUNNING" as const,
      adjustedCostPerHr: 1.39,
      gpu: { id: "NVIDIA A100 80GB PCIe", count: 1 },
    }));

    await expect(controller.start()).rejects.toThrow(
      "RunPod did not preserve the allocated Pod identity",
    );
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(workerClient.health).not.toHaveBeenCalled();
  });

  it("fails immediately on a mismatched exact GET and only terminates the original allocation", async () => {
    const { controller, fakeClient, deletePod, workerClient, sleep } = harness({
      currentLease: null,
    });
    let createdName = "";
    fakeClient.createPod.mockImplementation(async (input: { name: string }) => {
      createdName = input.name;
      return {
        id: "pod_123",
        name: input.name,
        desiredStatus: "RUNNING" as const,
        adjustedCostPerHr: 1.39,
        gpu: { id: "NVIDIA A100 80GB PCIe" },
      };
    });
    const mismatched = {
      id: "pod_other",
      name: createdName,
      desiredStatus: "RUNNING" as const,
      adjustedCostPerHr: 1.39,
      gpu: { id: "NVIDIA A100 80GB PCIe", count: 1 },
    };
    fakeClient.getPod
      .mockReset()
      .mockImplementationOnce(async () => ({ ...mismatched, name: createdName }))
      .mockResolvedValue(null);

    await expect(controller.start()).rejects.toThrow(
      "RunPod did not preserve the allocated Pod identity",
    );
    expect(sleep).not.toHaveBeenCalled();
    expect(fakeClient.getPod).toHaveBeenCalledTimes(2);
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(deletePod).not.toHaveBeenCalledWith("pod_other");
    expect(workerClient.health).not.toHaveBeenCalled();
  });

  it("deletes the exact Pod when persisting its allocated identity fails", async () => {
    const { controller, deletePod, currentLease } = harness({
      currentLease: null,
      saveLeaseFailureCall: 2,
    });

    await expect(controller.start()).rejects.toThrow(/post-create bookkeeping failed/);
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(currentLease()).toBeNull();
  });

  it("deletes the exact Pod when local safety scheduling fails", async () => {
    const { controller, deletePod, currentLease } = harness({
      currentLease: null,
      readUsageFailureCall: 2,
    });

    await expect(controller.start()).rejects.toThrow(/post-create bookkeeping failed/);
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(currentLease()).toBeNull();
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

describe("ComputeController exact-id termination", () => {
  it("keeps one stable usage lease across partial duplicate-cleanup retries", async () => {
    const { controller, fakeClient, deletePod, beginUsage, finishUsage, currentLease } = harness({
      currentLease: lease({ podId: undefined, state: "terminating" }),
    });
    const first = {
      id: "pod_duplicate_1",
      name: "glimmer-test-lease",
      desiredStatus: "RUNNING",
      adjustedCostPerHr: 1.39,
    };
    const second = { ...first, id: "pod_duplicate_2", adjustedCostPerHr: 1.49 };
    fakeClient.listPods
      .mockReset()
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([second]);
    const deletedIds = new Set<string>();
    let secondDeleteAttempts = 0;
    deletePod.mockReset().mockImplementation(async (podId: string) => {
      if (podId === second.id) {
        secondDeleteAttempts += 1;
        if (secondDeleteAttempts === 1) throw new Error("delete unavailable");
      }
      deletedIds.add(podId);
    });
    fakeClient.getPod.mockImplementation(async (podId: string) => {
      if (deletedIds.has(podId)) return null;
      throw new Error("confirmation unavailable");
    });

    await expect(controller.stop()).rejects.toThrow(/termination is still pending/);
    expect(finishUsage).not.toHaveBeenCalled();
    expect(currentLease()).toMatchObject({ state: "terminating", podId: undefined });

    await expect(controller.stop()).resolves.toMatchObject({ stopped: true, terminated: true });
    expect(beginUsage).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-1", podId: first.id }),
    );
    expect(beginUsage).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-1", podId: second.id }),
    );
    expect(beginUsage.mock.calls.every(([entry]) => entry.leaseId === "lease-1")).toBe(true);
    expect(finishUsage).toHaveBeenCalledWith("lease-1", NOW.toISOString());
    expect(currentLease()).toBeNull();
  });

  it("retries local finalization directly when usage closing fails once", async () => {
    vi.useFakeTimers();
    try {
      const { controller, fakeClient, finishUsage, deleteWorkerSecret, currentLease } = harness({
        currentLease: lease({ podId: undefined, state: "terminating" }),
      });
      finishUsage
        .mockRejectedValueOnce(new Error("usage ledger unavailable"))
        .mockResolvedValue(undefined);
      fakeClient.listPods.mockResolvedValue([
        {
          id: "pod_duplicate_1",
          name: "glimmer-test-lease",
          desiredStatus: "RUNNING",
          adjustedCostPerHr: 1.39,
        },
        {
          id: "pod_duplicate_2",
          name: "glimmer-test-lease",
          desiredStatus: "RUNNING",
          adjustedCostPerHr: 1.49,
        },
      ]);

      await expect(controller.stop()).rejects.toThrow(/termination is still pending/);
      expect(deleteWorkerSecret).not.toHaveBeenCalled();
      expect(currentLease()).toMatchObject({
        state: "terminating",
        podId: undefined,
        providerTerminationConfirmedAt: NOW.toISOString(),
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(finishUsage).toHaveBeenCalledTimes(2);
      expect(deleteWorkerSecret).toHaveBeenCalledTimes(1);
      expect(currentLease()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the lease and usage open when deletion cannot be confirmed", async () => {
    const { controller, fakeClient, deletePod, finishUsage, currentLease } = harness({});
    deletePod.mockReset().mockRejectedValue(new Error("delete response unavailable"));
    fakeClient.getPod.mockRejectedValue(new Error("exact read unavailable"));

    await expect(controller.stop()).rejects.toThrow(/termination is pending/);
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(finishUsage).not.toHaveBeenCalled();
    expect(currentLease()).toMatchObject({ podId: "pod_123", state: "terminating" });
  });

  it("does not accept a terminated response for a different Pod id", async () => {
    const { controller, fakeClient, deletePod, finishUsage, currentLease } = harness({});
    deletePod.mockReset().mockResolvedValue(undefined);
    fakeClient.getPod.mockResolvedValue({
      id: "pod_other",
      name: "glimmer-test-lease",
      desiredStatus: "TERMINATED",
    });

    await expect(controller.stop()).rejects.toThrow(/termination is pending/);
    expect(deletePod).toHaveBeenCalledWith("pod_123");
    expect(deletePod).not.toHaveBeenCalledWith("pod_other");
    expect(finishUsage).not.toHaveBeenCalled();
    expect(currentLease()).toMatchObject({ podId: "pod_123", state: "terminating" });
  });
});
