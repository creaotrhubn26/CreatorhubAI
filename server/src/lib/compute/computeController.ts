import { randomUUID } from "node:crypto";
import type {
  ComputeBudgetStatus,
  ComputeConfigV1,
  ComputeControlResult,
  ComputeCredentialTestResult,
  ComputeProfileV1,
  ComputeStatus,
  ComputeUsageSummary,
  ComputeWatchdogTestResult,
  ComputeWorkerStatus,
} from "@glimmer/shared";
import { CONFIG } from "../../config.js";
import {
  markComputeWatchdogVerified,
  readComputeConfig,
  readComputeWatchdogAccess,
  readRunPodApiKey,
  saveComputeConfig,
} from "./configStore.js";
import {
  clearComputeLease,
  readComputeLease,
  saveComputeLease,
  updateComputeLease,
  type ComputeLeaseV1,
} from "./computeLeaseStore.js";
import { RunPodClient } from "./runpodClient.js";
import type { RunPodCreatePodInput, RunPodPod } from "./runpodSchemas.js";
import { WorkerClient, WorkerProtocolError, workerBaseUrlForPod } from "./workerClient.js";
import { WatchdogClient, WatchdogProtocolError, type WatchdogLeaseV1 } from "./watchdogClient.js";
import {
  createWorkerSecret,
  deleteWorkerSecret,
  readWorkerSecret,
  storeWorkerHandshake,
  type WorkerSecretV1,
} from "./workerSecretStore.js";
import {
  beginUsageInterval,
  finishUsageInterval,
  readUsageSummary,
  readTrackedPodIds,
  storeReconciledUsage,
  usageWindowStarts,
} from "./usageLedger.js";

export class ComputeControlError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

class PermanentWorkerValidationError extends Error {}

interface ControllerDependencies {
  now: () => Date;
  readConfig: typeof readComputeConfig;
  saveConfig: typeof saveComputeConfig;
  readApiKey: typeof readRunPodApiKey;
  readWatchdogAccess: typeof readComputeWatchdogAccess;
  markWatchdogVerified: typeof markComputeWatchdogVerified;
  readLease: typeof readComputeLease;
  saveLease: typeof saveComputeLease;
  updateLease: typeof updateComputeLease;
  clearLease: typeof clearComputeLease;
  beginUsage: typeof beginUsageInterval;
  finishUsage: typeof finishUsageInterval;
  readUsage: typeof readUsageSummary;
  readTrackedPodIds: typeof readTrackedPodIds;
  storeReconciledUsage: typeof storeReconciledUsage;
  clientFactory: (apiKey: string) => RunPodClient;
  watchdogFactory: (endpointUrl: string, ingestToken: string) => WatchdogClient;
  workerFactory: (podId: string) => WorkerClient;
  createWorkerSecret: typeof createWorkerSecret;
  readWorkerSecret: typeof readWorkerSecret;
  storeWorkerHandshake: typeof storeWorkerHandshake;
  deleteWorkerSecret: typeof deleteWorkerSecret;
  sleep: (milliseconds: number) => Promise<void>;
  workerReadyAttempts: number;
}

const DEFAULT_DEPENDENCIES: ControllerDependencies = {
  now: () => new Date(),
  readConfig: readComputeConfig,
  saveConfig: saveComputeConfig,
  readApiKey: readRunPodApiKey,
  readWatchdogAccess: readComputeWatchdogAccess,
  markWatchdogVerified: markComputeWatchdogVerified,
  readLease: readComputeLease,
  saveLease: saveComputeLease,
  updateLease: updateComputeLease,
  clearLease: clearComputeLease,
  beginUsage: beginUsageInterval,
  finishUsage: finishUsageInterval,
  readUsage: readUsageSummary,
  readTrackedPodIds,
  storeReconciledUsage,
  clientFactory: (apiKey) => new RunPodClient({ baseUrl: CONFIG.runpodApiBaseUrl, apiKey }),
  watchdogFactory: (endpointUrl, ingestToken) =>
    new WatchdogClient({ baseUrl: endpointUrl, ingestToken }),
  workerFactory: (podId) => new WorkerClient({ baseUrl: workerBaseUrlForPod(podId) }),
  createWorkerSecret,
  readWorkerSecret,
  storeWorkerHandshake,
  deleteWorkerSecret,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  workerReadyAttempts: 40,
};

function activeProfile(config: ComputeConfigV1): ComputeProfileV1 | null {
  return config.profiles.find((profile) => profile.id === config.activeProfileId) ?? null;
}

function price(pod: RunPodPod): number | undefined {
  return pod.adjustedCostPerHr ?? pod.costPerHr;
}

function podSummary(pod: RunPodPod) {
  return {
    id: pod.id,
    name: pod.name,
    desiredStatus: pod.desiredStatus,
    ...(pod.gpu?.id ? { gpuTypeId: pod.gpu.id } : {}),
    ...(pod.gpu?.count !== undefined ? { gpuCount: pod.gpu.count } : {}),
    ...(price(pod) !== undefined ? { adjustedCostPerHr: price(pod) } : {}),
    ...(pod.publicIp ? { publicIp: pod.publicIp } : {}),
    ...(pod.lastStartedAt ? { lastStartedAt: pod.lastStartedAt } : {}),
  };
}

function budgetStatus(
  profile: ComputeProfileV1,
  usage: ComputeUsageSummary,
  currentHourlyUsd?: number,
): ComputeBudgetStatus {
  const daySpent = Math.max(usage.estimatedTodayUsd, usage.reconciledTodayUsd ?? 0);
  const monthSpent = Math.max(usage.estimatedMonthUsd, usage.reconciledMonthUsd ?? 0);
  let reason: string | undefined;
  if (currentHourlyUsd !== undefined && currentHourlyUsd > profile.maxGpuHourlyUsd) {
    reason = `provider rate $${currentHourlyUsd.toFixed(4)}/h exceeds the configured $${profile.maxGpuHourlyUsd.toFixed(4)}/h ceiling`;
  } else if (profile.dailyBudgetUsd !== undefined && daySpent >= profile.dailyBudgetUsd) {
    reason = "daily compute budget is exhausted";
  } else if (profile.monthlyBudgetUsd !== undefined && monthSpent >= profile.monthlyBudgetUsd) {
    reason = "monthly compute budget is exhausted";
  }
  return {
    allowed: !reason,
    hourlyCeilingUsd: profile.maxGpuHourlyUsd,
    ...(currentHourlyUsd !== undefined ? { currentHourlyUsd } : {}),
    ...(profile.dailyBudgetUsd !== undefined ? { dailyBudgetUsd: profile.dailyBudgetUsd } : {}),
    ...(profile.monthlyBudgetUsd !== undefined
      ? { monthlyBudgetUsd: profile.monthlyBudgetUsd }
      : {}),
    estimatedTodayUsd: usage.estimatedTodayUsd,
    estimatedMonthUsd: usage.estimatedMonthUsd,
    ...(reason ? { reason } : {}),
  };
}

function safeInstanceId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, 32) || "local";
}

export class ComputeController {
  private operation: Promise<unknown> = Promise.resolve();
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogHeartbeat: ReturnType<typeof setInterval> | null = null;
  private watchdogHeartbeatRunning = false;

  constructor(private readonly dependencies: ControllerDependencies = DEFAULT_DEPENDENCIES) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.catch(() => undefined).then(operation);
    this.operation = next;
    return next;
  }

  private async client(): Promise<RunPodClient> {
    const key = await this.dependencies.readApiKey();
    if (!key) throw new ComputeControlError("RunPod API key is not configured", 412);
    return this.dependencies.clientFactory(key);
  }

  private async watchdog(): Promise<WatchdogClient> {
    const access = await this.dependencies.readWatchdogAccess();
    if (!access) {
      throw new ComputeControlError(
        "Independent compute watchdog endpoint and ingest token are not configured",
        412,
      );
    }
    return this.dependencies.watchdogFactory(access.endpointUrl, access.ingestToken);
  }

  private watchdogLease(
    lease: ComputeLeaseV1,
    profile: ComputeProfileV1,
    heartbeatAt = this.dependencies.now(),
  ): WatchdogLeaseV1 {
    return {
      schemaVersion: 1,
      leaseId: lease.id,
      ownerInstanceId: safeInstanceId(CONFIG.instanceId),
      podName: lease.podName,
      ...(lease.podId ? { podId: lease.podId } : {}),
      hardDeadlineAt: lease.hardDeadlineAt,
      lastHeartbeatAt: heartbeatAt.toISOString(),
      maxHourlyUsd: profile.maxGpuHourlyUsd,
    };
  }

  private clearWatchdogHeartbeat() {
    if (this.watchdogHeartbeat) clearInterval(this.watchdogHeartbeat);
    this.watchdogHeartbeat = null;
    this.watchdogHeartbeatRunning = false;
  }

  private scheduleWatchdogHeartbeat() {
    this.clearWatchdogHeartbeat();
    this.watchdogHeartbeat = setInterval(() => {
      if (this.watchdogHeartbeatRunning) return;
      this.watchdogHeartbeatRunning = true;
      void (async () => {
        try {
          const lease = await this.dependencies.readLease();
          if (!lease) {
            this.clearWatchdogHeartbeat();
            return;
          }
          const config = await this.dependencies.readConfig();
          const profile = config.profiles.find((candidate) => candidate.id === lease.profileId);
          if (!profile) throw new Error("active compute profile is unavailable");
          await (await this.watchdog()).upsertLease(this.watchdogLease(lease, profile));
        } catch (error) {
          console.error(
            `[compute] watchdog heartbeat failed: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        } finally {
          this.watchdogHeartbeatRunning = false;
        }
      })();
    }, 60_000);
    this.watchdogHeartbeat.unref?.();
  }

  private async deleteWatchdogLeaseBestEffort(leaseId: string): Promise<void> {
    try {
      await (await this.watchdog()).deleteLease(leaseId);
    } catch (error) {
      console.error(
        `[compute] watchdog lease cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  private policy(profile?: ComputeProfileV1) {
    const watchdogConfigured = profile?.watchdogConfigured ?? false;
    return {
      secureCloudOnly: true as const,
      maximumGpuCount: 1 as const,
      watchdogConfigured,
      unattendedUseAllowed: watchdogConfigured,
    };
  }

  private async statusFrom(
    config: ComputeConfigV1,
    lease: ComputeLeaseV1 | null,
    pod: RunPodPod | null,
    detail?: string,
    worker?: ComputeWorkerStatus,
  ): Promise<ComputeStatus> {
    const profile = lease
      ? config.profiles.find((candidate) => candidate.id === lease.profileId)
      : activeProfile(config);
    const usage = await this.dependencies.readUsage(this.dependencies.now());
    const observedPrice = pod ? price(pod) : lease?.observedHourlyUsd;
    const budget = profile ? budgetStatus(profile, usage, observedPrice) : undefined;
    if (!lease) {
      return {
        backend: config.defaultBackend,
        state: "offline",
        checkedAt: this.dependencies.now().toISOString(),
        ...(profile ? { profileId: profile.id, budget } : {}),
        detail:
          detail ??
          (config.defaultBackend === "local_process"
            ? "Local process execution remains selected."
            : "No RunPod Pod is active."),
        policy: this.policy(profile ?? undefined),
      };
    }
    let state = lease.state;
    if (pod?.desiredStatus === "EXITED") state = "stopped";
    if (pod?.desiredStatus === "TERMINATED") state = "offline";
    if (pod?.desiredStatus === "RUNNING" && state === "provisioning") state = "bootstrapping";
    if (pod?.desiredStatus === "RUNNING" && worker?.ready) state = "ready";
    if (pod?.desiredStatus === "RUNNING" && worker && !worker.ready) state = "bootstrapping";
    if (budget && !budget.allowed && state !== "terminating") state = "budget_blocked";
    return {
      backend: "runpod_pod",
      state,
      checkedAt: this.dependencies.now().toISOString(),
      profileId: lease.profileId,
      ...(pod ? { pod: podSummary(pod) } : {}),
      idleDeadlineAt: lease.idleDeadlineAt,
      hardDeadlineAt: lease.hardDeadlineAt,
      ...(worker ? { worker } : {}),
      detail:
        detail ??
        lease.error ??
        (worker?.ready
          ? `Authenticated worker ${worker.buildId} is ready with ${worker.model.contextTokens} context tokens.`
          : pod?.desiredStatus === "RUNNING"
            ? "The provider is RUNNING while the authenticated worker is still bootstrapping."
            : pod
              ? `The provider reports ${pod.desiredStatus}.`
              : "The gateway has a provisional compute lease but no confirmed Pod yet."),
      ...(budget ? { budget } : {}),
      policy: this.policy(profile ?? undefined),
    };
  }

  private async findLeasePod(
    client: RunPodClient,
    lease: ComputeLeaseV1,
    persistRecoveredId = false,
  ): Promise<RunPodPod | null> {
    if (lease.podId) return client.getPod(lease.podId);
    const matches = (await client.listPods()).filter((pod) => pod.name === lease.podName);
    if (matches.length > 1) {
      throw new ComputeControlError(
        "Multiple RunPod Pods match the provisional lease; refusing automatic selection",
        409,
      );
    }
    if (!matches.length) return null;
    if (persistRecoveredId) {
      await this.dependencies.updateLease((current) => ({ ...current, podId: matches[0].id }));
    }
    return matches[0];
  }

  private createInput(
    profile: ComputeProfileV1,
    podName: string,
    bootstrapToken: string,
  ): RunPodCreatePodInput {
    if (
      !profile.imageDigest ||
      !profile.containerRegistryAuthId ||
      !profile.networkVolumeId ||
      !profile.modelArtifacts
    ) {
      throw new ComputeControlError(
        "The active RunPod profile requires an immutable image digest, registry auth, network volume, and checksum-bound model artifacts",
        412,
      );
    }
    return {
      name: podName,
      imageName: profile.imageDigest,
      containerRegistryAuthId: profile.containerRegistryAuthId,
      cloudType: "SECURE",
      computeType: "GPU",
      gpuTypeIds: profile.gpuTypeIds,
      gpuTypePriority: "availability",
      gpuCount: 1,
      containerDiskInGb: 50,
      networkVolumeId: profile.networkVolumeId,
      volumeMountPath: "/workspace",
      ports: ["4318/http"],
      interruptible: false,
      locked: false,
      env: {
        GLIMMER_CONTEXT_TOKENS: String(profile.contextTokens),
        GLIMMER_WORKER_BOOTSTRAP_TOKEN: bootstrapToken,
        GLIMMER_MODEL_URL: profile.modelArtifacts.model.url,
        GLIMMER_MODEL_SHA256: profile.modelArtifacts.model.sha256,
        GLIMMER_MMPROJ_URL: profile.modelArtifacts.mmproj.url,
        GLIMMER_MMPROJ_SHA256: profile.modelArtifacts.mmproj.sha256,
        GLIMMER_DFLASH_URL: profile.modelArtifacts.draftModel.url,
        GLIMMER_DFLASH_SHA256: profile.modelArtifacts.draftModel.sha256,
        GLIMMER_ARTIFACT_HOSTS: profile.modelArtifacts.allowedHosts.join(","),
      },
    };
  }

  private validateWorker(
    profile: ComputeProfileV1,
    worker: ComputeWorkerStatus,
    requireReady: boolean,
  ): string | null {
    if (!/^r2-[a-f0-9]{12}$/.test(worker.buildId)) {
      return "worker image did not report an immutable R2 build id";
    }
    if (worker.model.contextTokens !== profile.contextTokens) {
      return `worker context ${worker.model.contextTokens} does not match profile context ${profile.contextTokens}`;
    }
    if (requireReady && (!worker.ready || !worker.model.ready || worker.workerState !== "ready")) {
      return "worker or model did not become ready";
    }
    return null;
  }

  private async bootstrapWorker(
    podId: string,
    profile: ComputeProfileV1,
    secret: WorkerSecretV1,
  ): Promise<ComputeWorkerStatus> {
    const client = this.dependencies.workerFactory(podId);
    let lastError = "worker proxy is unavailable";
    const attempts = Math.max(
      1,
      Math.min(this.dependencies.workerReadyAttempts, Math.floor(profile.idleTimeoutSeconds / 12)),
    );
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const initial = await client.health(secret.capability);
        const initialError = this.validateWorker(profile, initial, false);
        if (initialError) throw new PermanentWorkerValidationError(initialError);
        let capability = secret.capability;
        if (!capability) {
          if (!secret.bootstrapToken) {
            throw new WorkerProtocolError("worker bootstrap state is unavailable");
          }
          const handshake = await client.handshake({
            bootstrapToken: secret.bootstrapToken,
            controllerInstanceId: safeInstanceId(CONFIG.instanceId),
            nonce: secret.controllerNonce,
            idempotencyKey: secret.handshakeIdempotencyKey,
          });
          if (
            handshake.buildId !== initial.buildId ||
            handshake.contextTokens !== profile.contextTokens
          ) {
            throw new PermanentWorkerValidationError(
              "worker handshake identity does not match health",
            );
          }
          const rotated = await this.dependencies.storeWorkerHandshake(
            secret.leaseId,
            handshake.capability,
            handshake.checkpointKey,
          );
          capability = rotated.capability;
        }
        const ready = await client.health(capability);
        const readyError = this.validateWorker(profile, ready, true);
        if (!readyError) return ready;
        lastError = readyError;
      } catch (error) {
        if (error instanceof PermanentWorkerValidationError) throw error;
        lastError = error instanceof Error ? error.message : "worker bootstrap failed";
      }
      if (attempt + 1 < attempts) {
        await this.dependencies.sleep(2_000);
      }
    }
    throw new WorkerProtocolError(lastError);
  }

  private async terminateFailedBootstrap(
    client: RunPodClient,
    lease: ComputeLeaseV1,
    reason: string,
  ): Promise<boolean> {
    const podId = lease.podId;
    if (!podId) {
      this.clearWatchdogHeartbeat();
      await this.dependencies.deleteWorkerSecret(lease.id);
      await this.deleteWatchdogLeaseBestEffort(lease.id);
      return true;
    }
    await this.dependencies.saveLease({
      ...lease,
      state: "terminating",
      error: `${reason}; termination requested immediately`,
    });
    await client.deletePod(podId);
    if (await this.waitForTermination(client, podId)) {
      this.clearWatchdogHeartbeat();
      await this.dependencies.finishUsage(lease.id, this.dependencies.now().toISOString());
      await this.dependencies.clearLease(lease.id);
      await this.dependencies.deleteWorkerSecret(lease.id);
      await this.deleteWatchdogLeaseBestEffort(lease.id);
      return true;
    }
    this.scheduleCleanupRetry("retry failed worker bootstrap termination");
    return false;
  }

  private validateAllocatedPod(profile: ComputeProfileV1, pod: RunPodPod): string | null {
    if (pod.desiredStatus !== "RUNNING") {
      return `RunPod returned desiredStatus ${pod.desiredStatus}; RUNNING was required`;
    }
    const observedPrice = price(pod);
    if (observedPrice === undefined) return "RunPod did not report a verifiable hourly rate";
    if (observedPrice > profile.maxGpuHourlyUsd) {
      return `provider rate $${observedPrice.toFixed(4)}/h exceeds the configured $${profile.maxGpuHourlyUsd.toFixed(4)}/h ceiling`;
    }
    if (pod.gpu?.count !== 1) {
      return pod.gpu?.count === undefined
        ? "RunPod did not prove that exactly one GPU was allocated"
        : `RunPod allocated ${pod.gpu.count} GPUs; policy requires exactly one`;
    }
    if (!pod.gpu.id) return "RunPod did not report the allocated GPU type";
    if (!profile.gpuTypeIds.some((gpuTypeId) => gpuTypeId === pod.gpu?.id)) {
      return `RunPod allocated GPU type ${pod.gpu.id}, which is outside the active profile`;
    }
    return null;
  }

  private clearSafetyTimer() {
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    this.safetyTimer = null;
  }

  private scheduleCleanupRetry(reason: string) {
    this.clearSafetyTimer();
    this.safetyTimer = setTimeout(() => {
      void this.stop(reason).catch((error) => {
        console.error(
          `[compute] cleanup retry failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, 5_000);
    this.safetyTimer.unref?.();
  }

  private async waitForTermination(client: RunPodClient, podId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const pod = await client.getPod(podId);
      if (!pod || pod.desiredStatus === "TERMINATED") return true;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  private async scheduleSafety(lease: ComputeLeaseV1, profile: ComputeProfileV1) {
    this.clearSafetyTimer();
    const nowMs = this.dependencies.now().getTime();
    const deadlines = [Date.parse(lease.idleDeadlineAt), Date.parse(lease.hardDeadlineAt)];
    if (lease.observedHourlyUsd && lease.observedHourlyUsd > 0) {
      const usage = await this.dependencies.readUsage(this.dependencies.now());
      const daySpent = Math.max(usage.estimatedTodayUsd, usage.reconciledTodayUsd ?? 0);
      const monthSpent = Math.max(usage.estimatedMonthUsd, usage.reconciledMonthUsd ?? 0);
      if (profile.dailyBudgetUsd !== undefined) {
        deadlines.push(
          nowMs +
            Math.max(
              0,
              ((profile.dailyBudgetUsd - daySpent) / lease.observedHourlyUsd) * 3_600_000,
            ),
        );
      }
      if (profile.monthlyBudgetUsd !== undefined) {
        deadlines.push(
          nowMs +
            Math.max(
              0,
              ((profile.monthlyBudgetUsd - monthSpent) / lease.observedHourlyUsd) * 3_600_000,
            ),
        );
      }
    }
    const delay = Math.max(0, Math.min(...deadlines) - nowMs);
    this.safetyTimer = setTimeout(() => {
      void this.stop("automatic safety deadline").catch((error) => {
        console.error(
          `[compute] automatic cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, delay);
    this.safetyTimer.unref?.();
  }

  async readConfig(): Promise<ComputeConfigV1> {
    return this.dependencies.readConfig();
  }

  async saveConfig(input: unknown): Promise<ComputeConfigV1> {
    return this.exclusive(async () => {
      const lease = await this.dependencies.readLease();
      if (lease) {
        throw new ComputeControlError(
          "Stop active RunPod compute before changing its configuration",
          409,
        );
      }
      return this.dependencies.saveConfig(input);
    });
  }

  async getStatus(): Promise<ComputeStatus> {
    const config = await this.dependencies.readConfig();
    const lease = await this.dependencies.readLease();
    if (!lease) return this.statusFrom(config, null, null);
    try {
      const pod = await this.findLeasePod(await this.client(), lease);
      if (!pod || pod.desiredStatus !== "RUNNING") return this.statusFrom(config, lease, pod);
      try {
        const secret = await this.dependencies.readWorkerSecret(lease.id);
        const worker = await this.dependencies.workerFactory(pod.id).health(secret?.capability);
        if (!secret?.capability) {
          return this.statusFrom(
            config,
            lease,
            pod,
            "Worker is reachable, but authenticated readiness is not established.",
            { ...worker, ready: false, workerState: "bootstrapping" },
          );
        }
        const profile = config.profiles.find((candidate) => candidate.id === lease.profileId);
        const workerError = profile ? this.validateWorker(profile, worker, false) : null;
        return this.statusFrom(
          config,
          lease,
          pod,
          workerError ?? undefined,
          workerError ? { ...worker, ready: false, workerState: "bootstrapping" } : worker,
        );
      } catch (error) {
        return this.statusFrom(
          config,
          lease,
          pod,
          `Worker status unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    } catch (error) {
      return this.statusFrom(
        config,
        lease,
        null,
        `RunPod status unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  async testCredentials(): Promise<ComputeCredentialTestResult> {
    const pods = await (await this.client()).listPods();
    return {
      provider: "runpod",
      authenticated: true,
      checkedAt: this.dependencies.now().toISOString(),
      visiblePodCount: pods.length,
      detail: "RunPod accepted the stored credential. No resource was created.",
    };
  }

  async testWatchdog(): Promise<ComputeWatchdogTestResult> {
    return this.exclusive(async () => {
      let result: ComputeWatchdogTestResult;
      try {
        result = await (await this.watchdog()).status();
      } catch (error) {
        throw new ComputeControlError(
          `Independent compute watchdog test failed: ${error instanceof Error ? error.message : "unknown error"}`,
          error instanceof WatchdogProtocolError && error.status === 401 ? 502 : 503,
        );
      }
      if (!result.ready || !result.lastSweepAt) {
        throw new ComputeControlError(
          "Independent compute watchdog is reachable but its scheduled sweep is not ready",
          503,
        );
      }
      await this.dependencies.markWatchdogVerified(result);
      return result;
    });
  }

  async start(): Promise<ComputeControlResult> {
    return this.exclusive(async () => {
      const config = await this.dependencies.readConfig();
      const profile = activeProfile(config);
      if (!config.enabled || config.defaultBackend !== "runpod_pod" || !profile) {
        throw new ComputeControlError("RunPod compute is not enabled as the active backend", 412);
      }
      if (!profile.watchdogConfigured) {
        throw new ComputeControlError(
          "RunPod compute cannot start until the independent watchdog has passed its live test",
          412,
        );
      }
      const existing = await this.dependencies.readLease();
      if (existing) {
        const status = await this.getStatus();
        return { started: false, status };
      }
      // Refresh provider billing inside this guarded mutation before deciding
      // whether another paid allocation fits the configured budgets.
      const usage = await this.getUsage(true);
      const budget = budgetStatus(profile, usage);
      if (!budget.allowed) {
        throw new ComputeControlError(budget.reason ?? "compute budget blocks this start", 409);
      }
      let watchdog: WatchdogClient;
      try {
        watchdog = await this.watchdog();
        const watchdogStatus = await watchdog.status();
        if (!watchdogStatus.ready || !watchdogStatus.lastSweepAt) {
          throw new WatchdogProtocolError("scheduled sweep is not ready");
        }
      } catch (error) {
        throw new ComputeControlError(
          `RunPod compute cannot start because the independent watchdog is unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
          503,
        );
      }
      const now = this.dependencies.now();
      const leaseId = randomUUID();
      const podName = `glimmer-${safeInstanceId(CONFIG.instanceId)}-${leaseId.slice(0, 12)}`;
      const client = await this.client();
      let lease: ComputeLeaseV1 = {
        version: 1,
        id: leaseId,
        profileId: profile.id,
        podName,
        state: "provisioning",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastActivityAt: now.toISOString(),
        idleDeadlineAt: new Date(now.getTime() + profile.idleTimeoutSeconds * 1_000).toISOString(),
        hardDeadlineAt: new Date(
          now.getTime() + profile.hardSessionLimitSeconds * 1_000,
        ).toISOString(),
      };
      lease = await this.dependencies.saveLease(lease);
      const workerSecret = await this.dependencies.createWorkerSecret(leaseId);
      if (!workerSecret.bootstrapToken) {
        await this.dependencies.clearLease(leaseId);
        throw new ComputeControlError("worker bootstrap secret was not created", 500);
      }
      try {
        await watchdog.upsertLease(this.watchdogLease(lease, profile, now));
      } catch (error) {
        await this.dependencies.clearLease(leaseId);
        await this.dependencies.deleteWorkerSecret(leaseId);
        throw new ComputeControlError(
          `RunPod compute was not created because the watchdog rejected its lease: ${error instanceof Error ? error.message : "unknown error"}`,
          503,
        );
      }
      this.scheduleWatchdogHeartbeat();
      const createRequest = this.createInput(profile, podName, workerSecret.bootstrapToken);
      let pod: RunPodPod;
      try {
        pod = await client.createPod(createRequest);
      } catch (error) {
        // Creation has no documented idempotency key. Recover an exact-name
        // Pod before declaring failure so a lost response cannot orphan spend.
        let providerListSucceeded = false;
        const matches = await client.listPods().then(
          (pods) => {
            providerListSucceeded = true;
            return pods.filter((candidate) => candidate.name === podName);
          },
          () => [],
        );
        if (matches.length !== 1) {
          this.clearWatchdogHeartbeat();
          await this.dependencies.saveLease({
            ...lease,
            state: "failed",
            error:
              matches.length > 1
                ? "RunPod create outcome is ambiguous; multiple Pods have the lease name"
                : `RunPod create failed: ${error instanceof Error ? error.message : "unknown error"}`,
          });
          if (matches.length === 0 && providerListSucceeded) {
            await this.dependencies.clearLease(leaseId);
            await this.dependencies.deleteWorkerSecret(leaseId);
            await this.deleteWatchdogLeaseBestEffort(leaseId);
          }
          throw error;
        }
        pod = matches[0];
      }
      lease = await this.dependencies.saveLease({ ...lease, podId: pod.id });
      try {
        await watchdog.upsertLease(this.watchdogLease(lease, profile));
      } catch (error) {
        await this.dependencies.saveLease({
          ...lease,
          state: "terminating",
          error: "watchdog did not accept the allocated Pod identity; termination requested",
        });
        this.clearWatchdogHeartbeat();
        await client.deletePod(pod.id);
        if (await this.waitForTermination(client, pod.id)) {
          this.clearWatchdogHeartbeat();
          await this.dependencies.clearLease(lease.id);
          await this.dependencies.deleteWorkerSecret(lease.id);
          await this.deleteWatchdogLeaseBestEffort(lease.id);
        } else {
          this.scheduleCleanupRetry("retry watchdog publication failure termination");
        }
        throw new ComputeControlError(
          `RunPod allocation was terminated because the watchdog did not accept its identity: ${error instanceof Error ? error.message : "unknown error"}`,
          503,
        );
      }
      const allocationError = this.validateAllocatedPod(profile, pod);
      if (allocationError) {
        const rejectedRate = price(pod);
        if (rejectedRate !== undefined) {
          await this.dependencies.beginUsage({
            leaseId,
            podId: pod.id,
            startedAt: this.dependencies.now().toISOString(),
            hourlyUsd: rejectedRate,
          });
        }
        await this.dependencies.saveLease({
          ...lease,
          state: "budget_blocked",
          observedHourlyUsd: rejectedRate,
          error: `${allocationError}; termination requested immediately`,
        });
        this.clearWatchdogHeartbeat();
        await client.deletePod(pod.id);
        if (await this.waitForTermination(client, pod.id)) {
          if (rejectedRate !== undefined) {
            await this.dependencies.finishUsage(leaseId, this.dependencies.now().toISOString());
          }
          await this.dependencies.clearLease(leaseId);
          await this.dependencies.deleteWorkerSecret(leaseId);
          this.clearWatchdogHeartbeat();
          await this.deleteWatchdogLeaseBestEffort(leaseId);
        } else {
          this.scheduleCleanupRetry("retry rejected allocation termination");
        }
        throw new ComputeControlError(allocationError, 409);
      }
      const observedHourlyUsd = price(pod)!;
      const startedAt = this.dependencies.now().toISOString();
      await this.dependencies.beginUsage({
        leaseId,
        podId: pod.id,
        startedAt,
        hourlyUsd: observedHourlyUsd,
      });
      lease = await this.dependencies.saveLease({
        ...lease,
        state: "bootstrapping",
        observedHourlyUsd,
      });
      await this.scheduleSafety(lease, profile);
      let worker: ComputeWorkerStatus;
      try {
        worker = await this.bootstrapWorker(pod.id, profile, workerSecret);
      } catch (error) {
        const reason = `Worker bootstrap failed: ${error instanceof Error ? error.message : "unknown error"}`;
        await this.terminateFailedBootstrap(client, lease, reason);
        throw new ComputeControlError(reason, 502);
      }
      lease = await this.dependencies.saveLease({
        ...lease,
        state: "ready",
        workerProtocolVersion: 1,
        workerBuildId: worker.buildId,
        workerReadyAt: this.dependencies.now().toISOString(),
        error: undefined,
      });
      return {
        started: true,
        status: await this.statusFrom(config, lease, pod, undefined, worker),
      };
    });
  }

  async stop(reason = "manual stop"): Promise<ComputeControlResult> {
    return this.exclusive(async () => {
      this.clearSafetyTimer();
      this.clearWatchdogHeartbeat();
      const config = await this.dependencies.readConfig();
      let lease = await this.dependencies.readLease();
      if (!lease) return { stopped: false, status: await this.statusFrom(config, null, null) };
      const client = await this.client();
      const pod = await this.findLeasePod(client, lease, true);
      if (!pod) {
        await this.dependencies.finishUsage(lease.id, this.dependencies.now().toISOString());
        await this.dependencies.clearLease(lease.id);
        await this.dependencies.deleteWorkerSecret(lease.id);
        await this.deleteWatchdogLeaseBestEffort(lease.id);
        return {
          stopped: false,
          status: await this.statusFrom(config, null, null, "The recorded Pod no longer exists."),
        };
      }
      lease =
        (await this.dependencies.updateLease((current) => ({
          ...current,
          state: "terminating",
          error: reason,
        }))) ?? lease;
      // R1 profiles require a network volume. RunPod documents that such
      // Pods cannot be stopped, so idle cleanup must terminate the Pod.
      await client.deletePod(pod.id);
      if (!(await this.waitForTermination(client, pod.id))) {
        await this.dependencies.saveLease({
          ...lease,
          state: "terminating",
          error: "RunPod still reports the Pod while termination is pending",
        });
        this.scheduleCleanupRetry("retry provider termination");
        throw new ComputeControlError(
          "RunPod still reports the Pod while termination is pending",
          502,
        );
      }
      await this.dependencies.finishUsage(lease.id, this.dependencies.now().toISOString());
      await this.dependencies.clearLease(lease.id);
      await this.dependencies.deleteWorkerSecret(lease.id);
      await this.deleteWatchdogLeaseBestEffort(lease.id);
      return {
        stopped: true,
        terminated: true,
        status: await this.statusFrom(config, null, null, "RunPod Pod terminated."),
      };
    });
  }

  async terminateExact(podId: string): Promise<ComputeControlResult> {
    const lease = await this.dependencies.readLease();
    if (!lease?.podId || lease.podId !== podId) {
      throw new ComputeControlError("podId must exactly match the active compute lease", 409);
    }
    return this.stop("explicit exact-id termination");
  }

  async getUsage(reconcile = true): Promise<ComputeUsageSummary> {
    if (reconcile) {
      const key = await this.dependencies.readApiKey();
      if (key) {
        const now = this.dependencies.now();
        const starts = usageWindowStarts(now);
        const records = await this.dependencies.clientFactory(key).getPodBilling({
          startTime: starts.month,
        });
        const trackedPodIds = new Set(await this.dependencies.readTrackedPodIds());
        const trackedRecords = records.filter(
          (record) => !!record.podId && trackedPodIds.has(record.podId),
        );
        const todayStart = Date.parse(starts.today);
        await this.dependencies.storeReconciledUsage({
          checkedAt: now.toISOString(),
          todayUsd: trackedRecords
            .filter((record) => Date.parse(record.time) >= todayStart)
            .reduce((sum, record) => sum + record.amount, 0),
          monthUsd: trackedRecords.reduce((sum, record) => sum + record.amount, 0),
        });
      }
    }
    return this.dependencies.readUsage(this.dependencies.now());
  }

  async reconcileOnStartup(): Promise<{ recovered: boolean; cleaned: boolean; detail: string }> {
    return this.exclusive(async () => {
      this.clearWatchdogHeartbeat();
      const lease = await this.dependencies.readLease();
      if (!lease) return { recovered: false, cleaned: false, detail: "no compute lease" };
      const config = await this.dependencies.readConfig();
      const profile = config.profiles.find((candidate) => candidate.id === lease.profileId);
      const client = await this.client();
      const pod = await this.findLeasePod(client, lease, true);
      if (!pod) {
        await this.dependencies.finishUsage(lease.id, this.dependencies.now().toISOString());
        await this.dependencies.clearLease(lease.id);
        await this.dependencies.deleteWorkerSecret(lease.id);
        await this.deleteWatchdogLeaseBestEffort(lease.id);
        return { recovered: false, cleaned: true, detail: "missing Pod lease cleared" };
      }
      if (!profile) {
        await client.deletePod(pod.id);
        if (!(await this.waitForTermination(client, pod.id))) {
          await this.dependencies.updateLease((current) => ({
            ...current,
            state: "terminating",
            error: "Pod termination is pending after its compute profile was removed",
          }));
          this.scheduleCleanupRetry("retry missing-profile termination");
          return {
            recovered: false,
            cleaned: false,
            detail: "Pod termination is still pending",
          };
        }
        await this.dependencies.finishUsage(lease.id, this.dependencies.now().toISOString());
        await this.dependencies.clearLease(lease.id);
        await this.dependencies.deleteWorkerSecret(lease.id);
        await this.deleteWatchdogLeaseBestEffort(lease.id);
        return {
          recovered: false,
          cleaned: true,
          detail: "Pod terminated because its compute profile is missing",
        };
      }
      try {
        if (!profile.watchdogConfigured) {
          throw new WatchdogProtocolError("watchdog has not passed its live test");
        }
        const watchdog = await this.watchdog();
        const watchdogStatus = await watchdog.status();
        if (!watchdogStatus.ready || !watchdogStatus.lastSweepAt) {
          throw new WatchdogProtocolError("scheduled sweep is not ready");
        }
        await watchdog.upsertLease(this.watchdogLease({ ...lease, podId: pod.id }, profile));
        this.scheduleWatchdogHeartbeat();
      } catch (error) {
        await client.deletePod(pod.id);
        if (!(await this.waitForTermination(client, pod.id))) {
          await this.dependencies.updateLease((current) => ({
            ...current,
            podId: pod.id,
            state: "terminating",
            error: "independent watchdog unavailable during startup recovery",
          }));
          this.scheduleCleanupRetry("retry missing-watchdog startup termination");
          return {
            recovered: false,
            cleaned: false,
            detail: "Pod termination is pending because the independent watchdog is unavailable",
          };
        }
        await this.dependencies.finishUsage(lease.id, this.dependencies.now().toISOString());
        await this.dependencies.clearLease(lease.id);
        await this.dependencies.deleteWorkerSecret(lease.id);
        await this.deleteWatchdogLeaseBestEffort(lease.id);
        return {
          recovered: false,
          cleaned: true,
          detail: `Pod terminated because the independent watchdog is unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
        };
      }
      const allocationError = this.validateAllocatedPod(profile, pod);
      const deadlinePassed =
        this.dependencies.now().getTime() >=
        Math.min(Date.parse(lease.idleDeadlineAt), Date.parse(lease.hardDeadlineAt));
      if (allocationError || deadlinePassed) {
        this.clearWatchdogHeartbeat();
        await client.deletePod(pod.id);
        if (!(await this.waitForTermination(client, pod.id))) {
          await this.dependencies.updateLease((current) => ({
            ...current,
            state: "terminating",
            error: allocationError ?? "expired compute lease termination is pending",
          }));
          this.scheduleCleanupRetry("retry startup safety termination");
          return {
            recovered: false,
            cleaned: false,
            detail: "Pod termination is still pending",
          };
        }
        await this.dependencies.finishUsage(lease.id, this.dependencies.now().toISOString());
        await this.dependencies.clearLease(lease.id);
        await this.dependencies.deleteWorkerSecret(lease.id);
        this.clearWatchdogHeartbeat();
        await this.deleteWatchdogLeaseBestEffort(lease.id);
        return {
          recovered: false,
          cleaned: true,
          detail: allocationError ?? "expired compute lease terminated",
        };
      }
      let worker: ComputeWorkerStatus | undefined;
      if (pod.desiredStatus === "RUNNING") {
        const secret = await this.dependencies.readWorkerSecret(lease.id);
        if (!secret) {
          const cleaned = await this.terminateFailedBootstrap(
            client,
            { ...lease, podId: pod.id },
            "worker secret is missing after gateway restart",
          );
          return {
            recovered: false,
            cleaned,
            detail: cleaned
              ? "Pod terminated because worker authentication state is missing"
              : "Pod termination is pending because worker authentication state is missing",
          };
        }
        try {
          worker = await this.bootstrapWorker(pod.id, profile, secret);
        } catch (error) {
          const reason = `worker recovery failed: ${error instanceof Error ? error.message : "unknown error"}`;
          const cleaned = await this.terminateFailedBootstrap(
            client,
            { ...lease, podId: pod.id },
            reason,
          );
          return { recovered: false, cleaned, detail: reason };
        }
      }
      const updated =
        (await this.dependencies.updateLease((current) => ({
          ...current,
          podId: pod.id,
          observedHourlyUsd: price(pod),
          state: worker?.ready
            ? "ready"
            : pod.desiredStatus === "RUNNING"
              ? "bootstrapping"
              : "stopped",
          ...(worker
            ? {
                workerProtocolVersion: 1 as const,
                workerBuildId: worker.buildId,
                workerReadyAt: this.dependencies.now().toISOString(),
                error: undefined,
              }
            : {}),
        }))) ?? lease;
      await this.scheduleSafety(updated, profile);
      return { recovered: true, cleaned: false, detail: "compute lease reattached" };
    });
  }
}

let singleton: ComputeController | null = null;

export function getComputeController(): ComputeController {
  singleton ??= new ComputeController();
  return singleton;
}

export function resetComputeControllerForTests() {
  singleton = null;
}
