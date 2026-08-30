import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  ComputeBudgetStatus,
  ComputeConfigV1,
  ComputeControlResult,
  ComputeCredentialTestResult,
  ComputeLastDiagnostic,
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
import { readLastComputeDiagnostic, saveLastComputeDiagnostic } from "./computeDiagnosticStore.js";
import { RunPodApiError, RunPodClient } from "./runpodClient.js";
import { RunPodSchemaError, type RunPodCreatePodInput, type RunPodPod } from "./runpodSchemas.js";
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
class WorkerBootstrapCancelledError extends Error {}

const ALLOCATION_EVIDENCE_MAX_WAIT_MS = 25_000;
const ALLOCATION_EVIDENCE_RETRY_MS = 2_500;
const CREATE_OUTCOME_POLL_ATTEMPTS = 3;
const WORKER_READY_RETRY_MS = 2_000;
const DEFAULT_WORKER_READY_ATTEMPTS = 1_800;
const DEFINITIVE_CREATE_REJECTION_STATUSES = new Set([400, 401, 403]);

interface ControllerDependencies {
  now: () => Date;
  monotonicNow: () => number;
  readConfig: typeof readComputeConfig;
  saveConfig: typeof saveComputeConfig;
  readApiKey: typeof readRunPodApiKey;
  readWatchdogAccess: typeof readComputeWatchdogAccess;
  markWatchdogVerified: typeof markComputeWatchdogVerified;
  readLease: typeof readComputeLease;
  saveLease: typeof saveComputeLease;
  updateLease: typeof updateComputeLease;
  clearLease: typeof clearComputeLease;
  readDiagnostic: typeof readLastComputeDiagnostic;
  saveDiagnostic: typeof saveLastComputeDiagnostic;
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
  monotonicNow: () => performance.now(),
  readConfig: readComputeConfig,
  saveConfig: saveComputeConfig,
  readApiKey: readRunPodApiKey,
  readWatchdogAccess: readComputeWatchdogAccess,
  markWatchdogVerified: markComputeWatchdogVerified,
  readLease: readComputeLease,
  saveLease: saveComputeLease,
  updateLease: updateComputeLease,
  clearLease: clearComputeLease,
  readDiagnostic: readLastComputeDiagnostic,
  saveDiagnostic: saveLastComputeDiagnostic,
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
  // A cold worker may spend several minutes preparing checksum-bound model
  // artifacts and the llama runtime. Keep a high defensive iteration cap,
  // while bootstrapWorker enforces the tighter persisted lease and budget
  // deadline with a monotonic clock.
  workerReadyAttempts: DEFAULT_WORKER_READY_ATTEMPTS,
};

function activeProfile(config: ComputeConfigV1): ComputeProfileV1 | null {
  return config.profiles.find((profile) => profile.id === config.activeProfileId) ?? null;
}

function price(pod: RunPodPod): number | undefined {
  return pod.adjustedCostPerHr ?? pod.costPerHr;
}

function allocationReadErrorIsPermanent(error: unknown): boolean {
  if (error instanceof RunPodSchemaError) return true;
  if (!(error instanceof RunPodApiError)) return false;
  if (error.status === undefined) {
    return error.message === "RunPod Pod id is invalid";
  }
  return error.status >= 400 && error.status < 500 && !new Set([408, 425, 429]).has(error.status);
}

function createRejectionIsDefinitive(error: unknown): error is RunPodApiError {
  return (
    error instanceof RunPodApiError &&
    error.status !== undefined &&
    DEFINITIVE_CREATE_REJECTION_STATUSES.has(error.status)
  );
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

function safetyDeadlineMs(
  profile: ComputeProfileV1,
  usage: ComputeUsageSummary,
  lease: ComputeLeaseV1,
  nowMs: number,
): number {
  const deadlines = [Date.parse(lease.idleDeadlineAt), Date.parse(lease.hardDeadlineAt)];
  const hourlyUsd = lease.observedHourlyUsd;
  if (hourlyUsd && hourlyUsd > 0) {
    const daySpent = Math.max(usage.estimatedTodayUsd, usage.reconciledTodayUsd ?? 0);
    const monthSpent = Math.max(usage.estimatedMonthUsd, usage.reconciledMonthUsd ?? 0);
    if (profile.dailyBudgetUsd !== undefined) {
      deadlines.push(
        nowMs + Math.max(0, ((profile.dailyBudgetUsd - daySpent) / hourlyUsd) * 3_600_000),
      );
    }
    if (profile.monthlyBudgetUsd !== undefined) {
      deadlines.push(
        nowMs + Math.max(0, ((profile.monthlyBudgetUsd - monthSpent) / hourlyUsd) * 3_600_000),
      );
    }
  }
  return Math.min(...deadlines);
}

function safeInstanceId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, 32) || "local";
}

function boundedComputeDetail(value: string): string {
  const printable = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  }).join("");
  return printable.replace(/\s+/g, " ").trim().slice(0, 500);
}

function workerBootstrapFailureMessage(error: unknown): string {
  if (error instanceof PermanentWorkerValidationError || error instanceof WorkerProtocolError) {
    return error.message;
  }
  return "unexpected worker bootstrap error";
}

function bootstrapDetail(worker: ComputeWorkerStatus): string | null {
  const bootstrap = worker.bootstrap;
  if (!bootstrap) return null;
  if (bootstrap.outcome === "failed") {
    return `Worker bootstrap reported ${bootstrap.failureCode ?? "unexpected_failure"}.`;
  }
  if (bootstrap.outcome === "ready") {
    return `Authenticated worker ${worker.buildId} is ready with ${worker.model.contextTokens} context tokens.`;
  }
  const artifact = bootstrap.artifact;
  if (artifact) {
    const progress =
      artifact.bytesCompleted !== undefined && artifact.bytesTotal !== undefined
        ? ` (${artifact.bytesCompleted.toLocaleString("en-US")} of ${artifact.bytesTotal.toLocaleString("en-US")} bytes)`
        : "";
    return `Worker bootstrap: ${artifact.kind} ${artifact.phase}${progress}.`;
  }
  return `Worker bootstrap: ${bootstrap.stage.replaceAll("_", " ")}.`;
}

function diagnosticOutcome(worker: ComputeWorkerStatus): ComputeLastDiagnostic["outcome"] {
  if (worker.bootstrap?.outcome === "failed") return "failed";
  return worker.ready ? "ready" : "bootstrapping";
}

export class ComputeController {
  private operation: Promise<unknown> = Promise.resolve();
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogHeartbeat: ReturnType<typeof setInterval> | null = null;
  private watchdogHeartbeatRunning = false;
  private readonly workerBootstraps = new Map<string, Promise<void>>();
  private readonly cancelledWorkerBootstraps = new Set<string>();
  private lastComputeDetail: string | null = null;

  constructor(private readonly dependencies: ControllerDependencies = DEFAULT_DEPENDENCIES) {}

  private async readDiagnosticBestEffort(): Promise<ComputeLastDiagnostic | null> {
    try {
      return await this.dependencies.readDiagnostic();
    } catch {
      console.error("[compute] retained bootstrap diagnostic is unreadable");
      return null;
    }
  }

  private async saveDiagnosticBestEffort(diagnostic: ComputeLastDiagnostic): Promise<void> {
    try {
      await this.dependencies.saveDiagnostic(diagnostic);
    } catch {
      console.error("[compute] bootstrap diagnostic could not be persisted");
    }
  }

  private recordWorkerDiagnostic(
    lease: ComputeLeaseV1,
    podId: string,
    worker: ComputeWorkerStatus,
  ): Promise<void> {
    return this.saveDiagnosticBestEffort({
      schemaVersion: 1,
      leaseId: lease.id,
      podId,
      podName: lease.podName,
      observedAt: this.dependencies.now().toISOString(),
      outcome: diagnosticOutcome(worker),
      worker,
    });
  }

  private async recordTerminalDiagnostic(
    lease: ComputeLeaseV1,
    outcome: "failed" | "terminated",
  ): Promise<void> {
    if (!lease.podId) return;
    const existing = await this.readDiagnosticBestEffort();
    if (existing?.leaseId === lease.id && existing.outcome === "failed") return;
    await this.saveDiagnosticBestEffort({
      schemaVersion: 1,
      leaseId: lease.id,
      podId: lease.podId,
      podName: lease.podName,
      observedAt: this.dependencies.now().toISOString(),
      outcome,
      ...(existing?.leaseId === lease.id && existing.worker ? { worker: existing.worker } : {}),
    });
  }

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
    const [usage, lastDiagnostic] = await Promise.all([
      this.dependencies.readUsage(this.dependencies.now()),
      this.readDiagnosticBestEffort(),
    ]);
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
          this.lastComputeDetail ??
          (lastDiagnostic?.outcome === "failed"
            ? `The last worker bootstrap failed at ${lastDiagnostic.worker?.bootstrap?.stage ?? "an unavailable stage"}; no RunPod Pod is active.`
            : undefined) ??
          (config.defaultBackend === "local_process"
            ? "Local process execution remains selected."
            : "No RunPod Pod is active."),
        ...(lastDiagnostic ? { lastDiagnostic } : {}),
        policy: this.policy(profile ?? undefined),
      };
    }
    let state = lease.state;
    if (pod?.desiredStatus === "EXITED") state = "stopped";
    if (pod?.desiredStatus === "TERMINATED") state = "offline";
    if (pod?.desiredStatus === "RUNNING" && state === "provisioning") state = "bootstrapping";
    if (pod?.desiredStatus === "RUNNING" && state === "ready" && worker && !worker.ready) {
      state = "bootstrapping";
    }
    if (pod?.desiredStatus === "RUNNING" && lease.state === "ready" && worker?.ready) {
      state = "ready";
    }
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
      ...(lastDiagnostic ? { lastDiagnostic } : {}),
      detail:
        detail ??
        lease.error ??
        (worker && bootstrapDetail(worker)) ??
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
    if (lease.podId) {
      const pod = await client.getPod(lease.podId);
      if (pod && (pod.id !== lease.podId || pod.name !== lease.podName)) {
        throw new ComputeControlError(
          "RunPod returned a Pod identity that does not match the durable compute lease",
          502,
        );
      }
      return pod;
    }
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

  private async waitForCreateOutcome(client: RunPodClient, podName: string): Promise<RunPodPod[]> {
    for (let attempt = 0; attempt < CREATE_OUTCOME_POLL_ATTEMPTS; attempt += 1) {
      try {
        const matches = (await client.listPods()).filter((pod) => pod.name === podName);
        if (matches.length > 0) return matches;
      } catch {
        // A lost create response plus a transient list failure is ambiguous.
        // Retain the provisional lease and retry rather than declaring absence.
      }
      if (attempt + 1 < CREATE_OUTCOME_POLL_ATTEMPTS) {
        await this.dependencies.sleep(ALLOCATION_EVIDENCE_RETRY_MS);
      }
    }
    return [];
  }

  private provisionalAbsenceNeedsReconciliation(lease: ComputeLeaseV1): boolean {
    return !lease.podId && this.dependencies.now().getTime() < Date.parse(lease.hardDeadlineAt);
  }

  private async retainProvisionalLease(lease: ComputeLeaseV1, reason: string): Promise<void> {
    try {
      await this.dependencies.saveLease({
        ...lease,
        state: "terminating",
        error: reason,
      });
    } catch (error) {
      console.error(
        `[compute] could not persist provisional reconciliation state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.scheduleCleanupRetry("retry ambiguous create outcome reconciliation", lease);
  }

  private async terminateNameMatchedPods(
    client: RunPodClient,
    lease: ComputeLeaseV1,
    pods: RunPodPod[],
    profile: ComputeProfileV1 | undefined,
    reason: string,
  ): Promise<boolean> {
    this.clearSafetyTimer();
    this.clearWatchdogHeartbeat();
    const exactMatches = [
      ...new Map(
        pods.filter((pod) => pod.name === lease.podName).map((pod) => [pod.id, pod]),
      ).values(),
    ];
    if (exactMatches.length === 0) return false;
    try {
      await this.dependencies.saveLease({
        ...lease,
        state: "terminating",
        error: reason,
      });
    } catch (error) {
      console.error(
        `[compute] could not persist ambiguous-Pod cleanup state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let allConfirmedAbsent = true;
    for (const pod of exactMatches) {
      const hourlyUsd = Math.max(
        profile?.maxGpuHourlyUsd ?? lease.observedHourlyUsd ?? 0,
        price(pod) ?? 0,
      );
      try {
        await this.dependencies.beginUsage({
          leaseId: lease.id,
          podId: pod.id,
          startedAt: lease.createdAt,
          hourlyUsd,
        });
      } catch (error) {
        console.error(
          `[compute] could not track ambiguous Pod ${pod.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        await client.deletePod(pod.id);
      } catch {
        // Confirmation below decides whether this exact id is gone.
      }
      if (!(await this.waitForTermination(client, pod.id))) {
        allConfirmedAbsent = false;
      }
    }
    if (!allConfirmedAbsent) {
      this.scheduleCleanupRetry("retry ambiguous Pod termination", lease);
      return false;
    }
    const confirmed = await this.markProviderTerminationConfirmed(lease);
    if (await this.finalizeTerminatedLease(confirmed)) return true;
    this.scheduleFinalizationRetry(confirmed, "retry ambiguous Pod finalization");
    return false;
  }

  private createInput(
    profile: ComputeProfileV1,
    podName: string,
    bootstrapToken: string,
    leaseId: string,
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
        GLIMMER_LEASE_ID: leaseId,
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
    if (worker.bootstrap?.outcome === "failed") {
      return `worker bootstrap reported ${worker.bootstrap.failureCode ?? "unexpected_failure"}`;
    }
    if (requireReady && (!worker.ready || !worker.model.ready || worker.workerState !== "ready")) {
      return "worker or model did not become ready";
    }
    return null;
  }

  private async assertWorkerBootstrapActive(
    leaseId: string,
    podId: string,
  ): Promise<ComputeLeaseV1> {
    const current = await this.dependencies.readLease();
    if (
      this.cancelledWorkerBootstraps.has(leaseId) ||
      !current ||
      current.id !== leaseId ||
      current.podId !== podId ||
      current.state !== "bootstrapping"
    ) {
      throw new WorkerBootstrapCancelledError("worker bootstrap was cancelled");
    }
    return current;
  }

  private persistWorkerHandshake(
    leaseId: string,
    podId: string,
    capability: string,
    checkpointKey: string,
  ): Promise<WorkerSecretV1> {
    return this.exclusive(async () => {
      await this.assertWorkerBootstrapActive(leaseId, podId);
      return this.dependencies.storeWorkerHandshake(leaseId, capability, checkpointKey);
    });
  }

  private async bootstrapWorker(
    podId: string,
    profile: ComputeProfileV1,
    lease: ComputeLeaseV1,
    secret: WorkerSecretV1,
  ): Promise<ComputeWorkerStatus> {
    const client = this.dependencies.workerFactory(podId);
    let lastError = "worker proxy is unavailable";
    let capability = secret.capability;
    const now = this.dependencies.now();
    const remainingLeaseMs =
      safetyDeadlineMs(profile, await this.dependencies.readUsage(now), lease, now.getTime()) -
      now.getTime();
    if (remainingLeaseMs <= 0) {
      throw new WorkerProtocolError("worker bootstrap deadline elapsed");
    }
    const deadlineMs = this.dependencies.monotonicNow() + remainingLeaseMs;
    const attempts = Math.max(
      1,
      Math.min(DEFAULT_WORKER_READY_ATTEMPTS, Math.floor(this.dependencies.workerReadyAttempts)),
    );
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await this.assertWorkerBootstrapActive(lease.id, podId);
      const remainingBeforeHealthMs = deadlineMs - this.dependencies.monotonicNow();
      if (remainingBeforeHealthMs <= 0) break;
      try {
        const initial = await client.health(capability, {
          timeoutMs: Math.ceil(remainingBeforeHealthMs),
        });
        await this.assertWorkerBootstrapActive(lease.id, podId);
        const initialError = this.validateWorker(profile, initial, false);
        if (initialError) {
          if (
            initial.bootstrap?.outcome === "failed" &&
            /^r2-[a-f0-9]{12}$/.test(initial.buildId) &&
            initial.model.contextTokens === profile.contextTokens
          ) {
            await this.recordWorkerDiagnostic(lease, podId, initial);
          }
          throw new PermanentWorkerValidationError(initialError);
        }
        await this.recordWorkerDiagnostic(lease, podId, initial);
        if (!capability) {
          if (!secret.bootstrapToken) {
            throw new WorkerProtocolError("worker bootstrap state is unavailable");
          }
          const remainingBeforeHandshakeMs = deadlineMs - this.dependencies.monotonicNow();
          if (remainingBeforeHandshakeMs <= 0) {
            throw new WorkerProtocolError("worker bootstrap deadline elapsed");
          }
          const handshake = await client.handshake(
            {
              bootstrapToken: secret.bootstrapToken,
              controllerInstanceId: safeInstanceId(CONFIG.instanceId),
              nonce: secret.controllerNonce,
              idempotencyKey: secret.handshakeIdempotencyKey,
            },
            { timeoutMs: Math.ceil(remainingBeforeHandshakeMs) },
          );
          await this.assertWorkerBootstrapActive(lease.id, podId);
          if (
            handshake.buildId !== initial.buildId ||
            handshake.contextTokens !== profile.contextTokens
          ) {
            throw new PermanentWorkerValidationError(
              "worker handshake identity does not match health",
            );
          }
          const rotated = await this.persistWorkerHandshake(
            secret.leaseId,
            podId,
            handshake.capability,
            handshake.checkpointKey,
          );
          capability = rotated.capability;
        }
        const remainingBeforeReadyMs = deadlineMs - this.dependencies.monotonicNow();
        if (remainingBeforeReadyMs <= 0) {
          throw new WorkerProtocolError("worker bootstrap deadline elapsed");
        }
        const ready = await client.health(capability, {
          timeoutMs: Math.ceil(remainingBeforeReadyMs),
        });
        await this.assertWorkerBootstrapActive(lease.id, podId);
        const readyError = this.validateWorker(profile, ready, true);
        if (!readyError) {
          await this.recordWorkerDiagnostic(lease, podId, ready);
          return ready;
        }
        await this.recordWorkerDiagnostic(lease, podId, ready);
        if (ready.bootstrap?.outcome === "failed") {
          throw new PermanentWorkerValidationError(readyError);
        }
        lastError = readyError;
      } catch (error) {
        if (
          error instanceof PermanentWorkerValidationError ||
          error instanceof WorkerBootstrapCancelledError
        ) {
          throw error;
        }
        lastError = error instanceof Error ? error.message : "worker bootstrap failed";
      }
      const remainingBeforeSleepMs = deadlineMs - this.dependencies.monotonicNow();
      if (attempt + 1 < attempts && remainingBeforeSleepMs > 0) {
        await this.dependencies.sleep(Math.min(WORKER_READY_RETRY_MS, remainingBeforeSleepMs));
      }
    }
    throw new WorkerProtocolError(
      this.dependencies.monotonicNow() >= deadlineMs
        ? `worker bootstrap deadline elapsed: ${lastError}`
        : lastError,
    );
  }

  private enqueueWorkerBootstrap(
    client: RunPodClient,
    profile: ComputeProfileV1,
    lease: ComputeLeaseV1,
    secret: WorkerSecretV1,
  ): void {
    if (this.workerBootstraps.has(lease.id)) return;
    const afterCurrentMutation = this.operation.catch(() => undefined);
    const task = afterCurrentMutation
      .then(() => this.runWorkerBootstrap(client, profile, lease, secret))
      .catch((error) => {
        console.error(
          `[compute] background worker bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (this.workerBootstraps.get(lease.id) === task) {
          this.workerBootstraps.delete(lease.id);
          this.cancelledWorkerBootstraps.delete(lease.id);
        }
      });
    this.workerBootstraps.set(lease.id, task);
  }

  private cancelWorkerBootstrap(leaseId: string): void {
    if (this.workerBootstraps.has(leaseId)) {
      this.cancelledWorkerBootstraps.add(leaseId);
    }
  }

  private async runWorkerBootstrap(
    client: RunPodClient,
    profile: ComputeProfileV1,
    lease: ComputeLeaseV1,
    secret: WorkerSecretV1,
  ): Promise<void> {
    let worker: ComputeWorkerStatus;
    try {
      worker = await this.bootstrapWorker(lease.podId!, profile, lease, secret);
    } catch (error) {
      if (error instanceof WorkerBootstrapCancelledError) return;
      await this.failWorkerBootstrap(
        client,
        lease,
        `Worker bootstrap failed: ${workerBootstrapFailureMessage(error)}`,
      );
      return;
    }
    await this.completeWorkerBootstrap(client, profile, lease, worker);
  }

  private failWorkerBootstrap(
    client: RunPodClient,
    lease: ComputeLeaseV1,
    reason: string,
  ): Promise<void> {
    return this.exclusive(async () => {
      let current: ComputeLeaseV1;
      try {
        current = await this.assertWorkerBootstrapActive(lease.id, lease.podId!);
      } catch (error) {
        if (error instanceof WorkerBootstrapCancelledError) return;
        throw error;
      }
      this.lastComputeDetail = boundedComputeDetail(reason);
      await this.recordTerminalDiagnostic(current, "failed");
      await this.terminateAllocatedPod(client, current, reason);
    });
  }

  private completeWorkerBootstrap(
    client: RunPodClient,
    expectedProfile: ComputeProfileV1,
    lease: ComputeLeaseV1,
    worker: ComputeWorkerStatus,
  ): Promise<void> {
    return this.exclusive(async () => {
      let current: ComputeLeaseV1;
      try {
        current = await this.assertWorkerBootstrapActive(lease.id, lease.podId!);
      } catch (error) {
        if (error instanceof WorkerBootstrapCancelledError) return;
        throw error;
      }
      try {
        const config = await this.dependencies.readConfig();
        const profile = config.profiles.find((candidate) => candidate.id === current.profileId);
        if (!profile || profile.id !== expectedProfile.id) {
          throw new Error("compute profile changed during worker bootstrap");
        }
        const pod = await this.findLeasePod(client, current);
        if (!pod) throw new Error("RunPod Pod disappeared during worker bootstrap");
        const allocationError = this.validateAllocatedPod(profile, pod);
        if (allocationError) throw new Error(allocationError);
        const safetyError = await this.preBootstrapSafetyError(current, profile);
        if (safetyError) throw new Error(safetyError);
        const workerError = this.validateWorker(profile, worker, true);
        if (workerError) throw new Error(workerError);
        const persistedReady = await this.dependencies.saveLease({
          ...current,
          state: "ready",
          workerProtocolVersion: worker.protocolVersion,
          workerBuildId: worker.buildId,
          workerReadyAt: this.dependencies.now().toISOString(),
          error: undefined,
        });
        this.lastComputeDetail = null;
        await this.scheduleSafety(persistedReady, profile);
      } catch (error) {
        const latest = await this.dependencies.readLease();
        if (
          latest?.id === lease.id &&
          latest.podId === lease.podId &&
          (latest.state === "bootstrapping" ||
            (latest.state === "ready" && latest.workerBuildId === worker.buildId))
        ) {
          const detail = boundedComputeDetail(
            `Worker readiness finalization failed: ${error instanceof Error ? error.message : "unknown error"}`,
          );
          this.lastComputeDetail = detail;
          await this.terminateAllocatedPod(client, latest, detail);
        }
      }
    });
  }

  private async terminateFailedBootstrap(
    client: RunPodClient,
    lease: ComputeLeaseV1,
    reason: string,
  ): Promise<boolean> {
    return this.terminateAllocatedPod(client, lease, reason);
  }

  private async markProviderTerminationConfirmed(lease: ComputeLeaseV1): Promise<ComputeLeaseV1> {
    this.cancelWorkerBootstrap(lease.id);
    const confirmed: ComputeLeaseV1 = {
      ...lease,
      state: "terminating",
      providerTerminationConfirmedAt: this.dependencies.now().toISOString(),
    };
    let persisted = confirmed;
    try {
      persisted = await this.dependencies.saveLease(confirmed);
    } catch (error) {
      console.error(
        `[compute] could not persist provider-termination confirmation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.recordTerminalDiagnostic(persisted, "terminated");
    return persisted;
  }

  private async finalizeTerminatedLease(lease: ComputeLeaseV1): Promise<boolean> {
    this.cancelWorkerBootstrap(lease.id);
    this.clearWatchdogHeartbeat();
    try {
      await this.dependencies.finishUsage(lease.id, this.dependencies.now().toISOString());
      await this.dependencies.deleteWorkerSecret(lease.id);
      await this.deleteWatchdogLeaseBestEffort(lease.id);
      const cleared = await this.dependencies.clearLease(lease.id);
      if (!cleared) {
        const current = await this.dependencies.readLease();
        if (current?.id === lease.id) throw new Error("confirmed lease could not be cleared");
      }
      return true;
    } catch (error) {
      console.error(
        `[compute] terminated Pod finalization is incomplete: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private scheduleFinalizationRetry(lease: ComputeLeaseV1, reason: string) {
    this.clearSafetyTimer();
    this.safetyTimer = setTimeout(() => {
      void this.exclusive(async () => {
        const current = await this.dependencies.readLease();
        if (!current || current.id !== lease.id) return;
        const confirmed = current.providerTerminationConfirmedAt
          ? current
          : await this.markProviderTerminationConfirmed({
              ...current,
              providerTerminationConfirmedAt: lease.providerTerminationConfirmedAt,
            });
        if (!(await this.finalizeTerminatedLease(confirmed))) {
          const latest = await this.dependencies.readLease();
          if (latest?.id === lease.id) {
            this.scheduleFinalizationRetry(latest, reason);
          }
        }
      }).catch((error) => {
        console.error(
          `[compute] ${reason} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, 5_000);
    this.safetyTimer.unref?.();
  }

  private async terminateAllocatedPod(
    client: RunPodClient,
    lease: ComputeLeaseV1,
    reason: string,
  ): Promise<boolean> {
    this.cancelWorkerBootstrap(lease.id);
    this.clearSafetyTimer();
    this.clearWatchdogHeartbeat();
    const podId = lease.podId;
    if (!podId) {
      await this.dependencies.deleteWorkerSecret(lease.id);
      await this.deleteWatchdogLeaseBestEffort(lease.id);
      await this.dependencies.clearLease(lease.id);
      return true;
    }
    try {
      await this.dependencies.saveLease({
        ...lease,
        state: "terminating",
        error: `${reason}; termination requested immediately`,
      });
    } catch (error) {
      console.error(
        `[compute] could not persist terminating state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      await client.deletePod(podId);
    } catch {
      // DELETE may have reached the provider even when its response was lost.
      // Exact-id absence below is the only condition that permits cleanup.
    }
    if (!(await this.waitForTermination(client, podId))) {
      this.scheduleCleanupRetry("retry provider termination", lease);
      return false;
    }
    const confirmed = await this.markProviderTerminationConfirmed(lease);
    if (await this.finalizeTerminatedLease(confirmed)) return true;
    this.scheduleFinalizationRetry(confirmed, "retry terminated allocation finalization");
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

  private allocationEvidenceIsPending(profile: ComputeProfileV1, pod: RunPodPod): boolean {
    if (pod.desiredStatus !== "RUNNING") return false;
    const observedPrice = price(pod);
    if (observedPrice !== undefined && observedPrice > profile.maxGpuHourlyUsd) return false;
    if (pod.gpu?.count !== undefined && pod.gpu.count !== 1) return false;
    if (pod.gpu?.id && !profile.gpuTypeIds.some((gpuTypeId) => gpuTypeId === pod.gpu?.id)) {
      return false;
    }
    return observedPrice === undefined || pod.gpu?.count === undefined || !pod.gpu?.id;
  }

  private async waitForAllocationEvidence(
    client: RunPodClient,
    profile: ComputeProfileV1,
    initial: RunPodPod,
    expectedName: string,
  ): Promise<RunPodPod> {
    const deadlineMs = this.dependencies.monotonicNow() + ALLOCATION_EVIDENCE_MAX_WAIT_MS;
    let observed = initial;
    for (;;) {
      const validationError = this.validateAllocatedPod(profile, observed);
      if (!validationError || !this.allocationEvidenceIsPending(profile, observed)) {
        return observed;
      }
      const remainingBeforeReadMs = deadlineMs - this.dependencies.monotonicNow();
      if (remainingBeforeReadMs <= 0) return observed;
      try {
        const refreshed = await client.getPod(initial.id, {
          timeoutMs: Math.ceil(remainingBeforeReadMs),
        });
        if (refreshed) {
          if (refreshed.id !== initial.id || refreshed.name !== expectedName) {
            return refreshed;
          }
          observed = refreshed;
          const refreshedError = this.validateAllocatedPod(profile, observed);
          if (!refreshedError || !this.allocationEvidenceIsPending(profile, observed)) {
            return observed;
          }
        }
      } catch (error) {
        if (allocationReadErrorIsPermanent(error)) throw error;
        // A transient read failure cannot promote an incomplete create response.
        // Keep polling the exact Pod id, then fail closed through the existing
        // allocation rejection and termination path if proof never arrives.
      }
      const remainingBeforeSleepMs = deadlineMs - this.dependencies.monotonicNow();
      if (remainingBeforeSleepMs <= 0) return observed;
      await this.dependencies.sleep(Math.min(ALLOCATION_EVIDENCE_RETRY_MS, remainingBeforeSleepMs));
    }
  }

  private async preBootstrapSafetyError(
    lease: ComputeLeaseV1,
    profile: ComputeProfileV1,
  ): Promise<string | null> {
    const now = this.dependencies.now();
    const nowMs = now.getTime();
    if (nowMs >= Date.parse(lease.hardDeadlineAt)) {
      return "RunPod hard session deadline elapsed before worker bootstrap";
    }
    if (nowMs >= Date.parse(lease.idleDeadlineAt)) {
      return "RunPod idle deadline elapsed before worker bootstrap";
    }
    const budget = budgetStatus(
      profile,
      await this.dependencies.readUsage(now),
      lease.observedHourlyUsd,
    );
    return budget.allowed
      ? null
      : `RunPod budget no longer permits worker bootstrap: ${budget.reason ?? "budget exhausted"}`;
  }

  private clearSafetyTimer() {
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    this.safetyTimer = null;
  }

  private scheduleCleanupRetry(
    reason: string,
    expectedLease: Pick<ComputeLeaseV1, "id" | "podId">,
  ) {
    this.clearSafetyTimer();
    this.safetyTimer = setTimeout(() => {
      void this.stop(reason, expectedLease.podId, expectedLease.id).catch((error) => {
        if (error instanceof ComputeControlError && error.statusCode === 409) return;
        console.error(
          `[compute] cleanup retry failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, 5_000);
    this.safetyTimer.unref?.();
  }

  private async waitForTermination(client: RunPodClient, podId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let pod: RunPodPod | null;
      try {
        pod = await client.getPod(podId);
      } catch {
        return false;
      }
      if (!pod) return true;
      if (pod.id !== podId) return false;
      if (pod.desiredStatus === "TERMINATED") return true;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  private async scheduleSafety(lease: ComputeLeaseV1, profile: ComputeProfileV1) {
    this.clearSafetyTimer();
    const nowMs = this.dependencies.now().getTime();
    const usage = await this.dependencies.readUsage(this.dependencies.now());
    const delay = Math.max(0, safetyDeadlineMs(profile, usage, lease, nowMs) - nowMs);
    this.safetyTimer = setTimeout(() => {
      void this.stop("automatic safety deadline", lease.podId, lease.id).catch((error) => {
        if (error instanceof ComputeControlError && error.statusCode === 409) return;
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
        if (
          !workerError ||
          (profile &&
            worker.bootstrap?.outcome === "failed" &&
            /^r2-[a-f0-9]{12}$/.test(worker.buildId) &&
            worker.model.contextTokens === profile.contextTokens)
        ) {
          await this.recordWorkerDiagnostic(lease, pod.id, worker);
        }
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
      const createRequest = this.createInput(
        profile,
        podName,
        workerSecret.bootstrapToken,
        leaseId,
      );
      let pod: RunPodPod;
      try {
        pod = await client.createPod(createRequest);
      } catch (error) {
        if (createRejectionIsDefinitive(error)) {
          const confirmed = await this.markProviderTerminationConfirmed(lease);
          const cleaned = await this.finalizeTerminatedLease(confirmed);
          if (!cleaned) {
            this.scheduleFinalizationRetry(
              confirmed,
              "retry definitively rejected create finalization",
            );
          }
          throw new ComputeControlError(
            `RunPod rejected Pod creation with HTTP ${error.status}; local cleanup ${cleaned ? "completed" : "is pending"}`,
            502,
          );
        }
        // Creation has no documented idempotency key. Recover an exact-name
        // Pod before declaring failure so a lost response cannot orphan spend.
        const matches = await this.waitForCreateOutcome(client, podName);
        if (matches.length > 1) {
          const cleaned = await this.terminateNameMatchedPods(
            client,
            lease,
            matches,
            profile,
            "RunPod create outcome is ambiguous; terminating every exact-name match",
          );
          throw new ComputeControlError(
            `RunPod create outcome was ambiguous; exact-name Pod termination ${cleaned ? "completed" : "is pending"}`,
            502,
          );
        }
        if (matches.length === 0) {
          await this.retainProvisionalLease(
            lease,
            `RunPod create outcome is unknown after a lost response: ${error instanceof Error ? error.message : "unknown error"}`,
          );
          throw new ComputeControlError(
            "RunPod create outcome is unknown; protected exact-name reconciliation is scheduled",
            502,
          );
        }
        pod = matches[0];
      }
      const allocatedPodId = pod.id;
      let allocatedLease: ComputeLeaseV1 = {
        ...lease,
        podId: allocatedPodId,
        observedHourlyUsd: profile.maxGpuHourlyUsd,
      };
      try {
        await this.dependencies.beginUsage({
          leaseId,
          podId: allocatedPodId,
          startedAt: allocatedLease.createdAt,
          hourlyUsd: profile.maxGpuHourlyUsd,
        });
        const persistedAllocation = await this.dependencies.saveLease(allocatedLease);
        allocatedLease = {
          ...persistedAllocation,
          id: leaseId,
          podId: allocatedPodId,
          observedHourlyUsd: profile.maxGpuHourlyUsd,
        };
        try {
          await watchdog.upsertLease(this.watchdogLease(allocatedLease, profile));
        } catch (error) {
          throw new ComputeControlError(
            `watchdog did not accept the allocated Pod identity: ${error instanceof Error ? error.message : "unknown error"}`,
            503,
          );
        }
        await this.scheduleSafety(allocatedLease, profile);

        pod = await this.waitForAllocationEvidence(client, profile, pod, podName);
        const identityError =
          pod.id !== allocatedPodId || pod.name !== podName
            ? "RunPod did not preserve the allocated Pod identity"
            : null;
        const allocationError = identityError ?? this.validateAllocatedPod(profile, pod);
        if (allocationError) throw new ComputeControlError(allocationError, 409);

        const observedHourlyUsd = price(pod)!;
        const persistedBootstrap = await this.dependencies.saveLease({
          ...allocatedLease,
          state: "bootstrapping",
          observedHourlyUsd,
        });
        allocatedLease = {
          ...persistedBootstrap,
          id: leaseId,
          podId: allocatedPodId,
          observedHourlyUsd,
        };
        await this.saveDiagnosticBestEffort({
          schemaVersion: 1,
          leaseId,
          podId: allocatedPodId,
          podName,
          observedAt: this.dependencies.now().toISOString(),
          outcome: "bootstrapping",
        });
        await this.scheduleSafety(allocatedLease, profile);

        const bootstrapSafetyError = await this.preBootstrapSafetyError(allocatedLease, profile);
        if (bootstrapSafetyError) throw new ComputeControlError(bootstrapSafetyError, 409);

        this.lastComputeDetail = null;
        this.enqueueWorkerBootstrap(client, profile, allocatedLease, workerSecret);
        return {
          started: true,
          status: await this.statusFrom(
            config,
            allocatedLease,
            pod,
            "The RunPod allocation is verified and worker bootstrap is continuing in the background.",
          ),
        };
      } catch (error) {
        const failure =
          error instanceof ComputeControlError
            ? error
            : new ComputeControlError(
                `local post-create bookkeeping failed: ${error instanceof Error ? error.message : "unknown error"}`,
                500,
              );
        const cleaned = await this.terminateAllocatedPod(client, allocatedLease, failure.message);
        throw new ComputeControlError(
          `RunPod allocation ${cleaned ? "was terminated" : "termination is pending"}: ${failure.message}`,
          failure.statusCode,
        );
      }
    });
  }

  async stop(
    reason = "manual stop",
    expectedPodId?: string,
    expectedLeaseId?: string,
  ): Promise<ComputeControlResult> {
    return this.exclusive(async () => {
      let lease = await this.dependencies.readLease();
      if (expectedLeaseId !== undefined && lease?.id !== expectedLeaseId) {
        throw new ComputeControlError("leaseId must exactly match the active compute lease", 409);
      }
      if (expectedPodId !== undefined && lease?.podId !== expectedPodId) {
        throw new ComputeControlError("podId must exactly match the active compute lease", 409);
      }
      if (lease) this.cancelWorkerBootstrap(lease.id);
      let config: ComputeConfigV1;
      try {
        config = await this.dependencies.readConfig();
      } catch (error) {
        if (lease) {
          this.scheduleCleanupRetry("retry stop after compute configuration read failure", lease);
          this.clearWatchdogHeartbeat();
        }
        throw error;
      }
      if (!lease) {
        this.clearSafetyTimer();
        this.clearWatchdogHeartbeat();
        return { stopped: false, status: await this.statusFrom(config, null, null) };
      }
      if (lease.providerTerminationConfirmedAt) {
        this.clearSafetyTimer();
        this.clearWatchdogHeartbeat();
        if (!(await this.finalizeTerminatedLease(lease))) {
          this.scheduleFinalizationRetry(lease, "retry confirmed termination finalization");
          throw new ComputeControlError(
            "RunPod is terminated, but local compute finalization is still pending",
            500,
          );
        }
        return {
          stopped: true,
          terminated: true,
          status: await this.statusFrom(config, null, null, "RunPod Pod terminated."),
        };
      }
      let client: RunPodClient;
      try {
        client = await this.client();
      } catch (error) {
        this.scheduleCleanupRetry("retry stop after RunPod client failure", lease);
        this.clearWatchdogHeartbeat();
        throw error;
      }
      this.clearSafetyTimer();
      this.clearWatchdogHeartbeat();
      if (!lease.podId) {
        const provisionalPodName = lease.podName;
        const provisionalProfileId = lease.profileId;
        let matches: RunPodPod[];
        try {
          matches = (await client.listPods()).filter((pod) => pod.name === provisionalPodName);
        } catch (error) {
          this.scheduleCleanupRetry("retry provisional Pod lookup", lease);
          throw new ComputeControlError(
            `RunPod provisional Pod lookup failed: ${error instanceof Error ? error.message : "unknown error"}`,
            502,
          );
        }
        const profile = config.profiles.find((candidate) => candidate.id === provisionalProfileId);
        if (matches.length > 1) {
          if (
            !(await this.terminateNameMatchedPods(
              client,
              lease,
              matches,
              profile,
              "multiple Pods matched the unique provisional lease name",
            ))
          ) {
            throw new ComputeControlError(
              "RunPod exact-name Pod termination is still pending",
              502,
            );
          }
          return {
            stopped: true,
            terminated: true,
            status: await this.statusFrom(
              config,
              null,
              null,
              "All exact-name RunPod Pods terminated.",
            ),
          };
        }
        const pod = matches[0];
        if (!pod && this.provisionalAbsenceNeedsReconciliation(lease)) {
          await this.retainProvisionalLease(
            lease,
            "RunPod create outcome remains unknown during the convergence window",
          );
          throw new ComputeControlError(
            "RunPod create outcome remains unknown; exact-name reconciliation is pending",
            502,
          );
        }
        if (!pod) {
          const confirmed = await this.markProviderTerminationConfirmed(lease);
          if (!(await this.finalizeTerminatedLease(confirmed))) {
            this.scheduleFinalizationRetry(confirmed, "retry absent provisional finalization");
            throw new ComputeControlError(
              "RunPod is absent, but local compute finalization is still pending",
              500,
            );
          }
          return {
            stopped: false,
            status: await this.statusFrom(config, null, null, "The recorded Pod no longer exists."),
          };
        }
        const trackedHourlyUsd = Math.max(
          profile?.maxGpuHourlyUsd ?? lease.observedHourlyUsd ?? 0,
          price(pod) ?? 0,
        );
        try {
          await this.dependencies.beginUsage({
            leaseId: lease.id,
            podId: pod.id,
            startedAt: lease.createdAt,
            hourlyUsd: trackedHourlyUsd,
          });
        } catch (error) {
          console.error(
            `[compute] could not restore provisional Pod usage tracking: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        lease = { ...lease, podId: pod.id, observedHourlyUsd: trackedHourlyUsd };
      }
      // R1 profiles require a network volume. RunPod documents that such
      // Pods cannot be stopped, so idle cleanup must terminate the Pod.
      if (!(await this.terminateAllocatedPod(client, lease, reason))) {
        throw new ComputeControlError(
          "RunPod still reports the Pod while termination is pending",
          502,
        );
      }
      return {
        stopped: true,
        terminated: true,
        status: await this.statusFrom(config, null, null, "RunPod Pod terminated."),
      };
    });
  }

  async terminateExact(podId: string): Promise<ComputeControlResult> {
    return this.stop("explicit exact-id termination", podId);
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
      if (lease.providerTerminationConfirmedAt) {
        const cleaned = await this.finalizeTerminatedLease(lease);
        if (!cleaned) {
          this.scheduleFinalizationRetry(lease, "retry startup termination finalization");
        }
        return {
          recovered: false,
          cleaned,
          detail: cleaned
            ? "confirmed provider termination finalized"
            : "local termination finalization is still pending",
        };
      }
      const client = await this.client();
      let pod: RunPodPod | null;
      try {
        pod = await this.findLeasePod(client, lease, true);
      } catch (error) {
        if (!lease.podId) {
          let matches: RunPodPod[] = [];
          try {
            matches = (await client.listPods()).filter(
              (candidate) => candidate.name === lease.podName,
            );
          } catch {
            // Keep the durable provisional lease when provider convergence
            // cannot be observed during startup.
          }
          if (matches.length > 0) {
            const cleaned = await this.terminateNameMatchedPods(
              client,
              lease,
              matches,
              profile,
              "ambiguous provisional Pods found during startup recovery",
            );
            return {
              recovered: false,
              cleaned,
              detail: cleaned
                ? "ambiguous provisional Pods terminated"
                : "provisional Pod termination is still pending",
            };
          }
          await this.retainProvisionalLease(
            lease,
            `provisional Pod lookup remains ambiguous during startup: ${error instanceof Error ? error.message : "unknown error"}`,
          );
          return {
            recovered: false,
            cleaned: false,
            detail: "provisional Pod reconciliation is still pending",
          };
        }
        const trackedHourlyUsd = profile?.maxGpuHourlyUsd ?? lease.observedHourlyUsd ?? 0;
        const trackedLease = {
          ...lease,
          podId: lease.podId,
          observedHourlyUsd: trackedHourlyUsd,
        };
        try {
          await this.dependencies.beginUsage({
            leaseId: lease.id,
            podId: lease.podId,
            startedAt: lease.createdAt,
            hourlyUsd: trackedHourlyUsd,
          });
        } catch (usageError) {
          console.error(
            `[compute] could not restore usage tracking before identity cleanup: ${usageError instanceof Error ? usageError.message : String(usageError)}`,
          );
        }
        const cleaned = await this.terminateAllocatedPod(
          client,
          trackedLease,
          "RunPod returned a mismatched identity during startup recovery",
        );
        return {
          recovered: false,
          cleaned,
          detail: cleaned
            ? "mismatched Pod identity terminated"
            : "Pod identity is untrusted and exact-id termination is still pending",
        };
      }
      if (!pod) {
        if (this.provisionalAbsenceNeedsReconciliation(lease)) {
          await this.retainProvisionalLease(
            lease,
            "provisional Pod absence is not yet stable during startup recovery",
          );
          return {
            recovered: false,
            cleaned: false,
            detail: "provisional Pod reconciliation is still pending",
          };
        }
        const confirmed = await this.markProviderTerminationConfirmed(lease);
        const cleaned = await this.finalizeTerminatedLease(confirmed);
        if (!cleaned) {
          this.scheduleFinalizationRetry(confirmed, "retry missing Pod finalization");
        }
        return {
          recovered: false,
          cleaned,
          detail: cleaned ? "missing Pod lease cleared" : "local finalization is still pending",
        };
      }
      const recoveredPodId = lease.podId ?? pod.id;
      const trackedHourlyUsd = profile?.maxGpuHourlyUsd ?? lease.observedHourlyUsd ?? 0;
      const trackedLease: ComputeLeaseV1 = {
        ...lease,
        podId: recoveredPodId,
        observedHourlyUsd: trackedHourlyUsd,
      };
      try {
        await this.dependencies.beginUsage({
          leaseId: lease.id,
          podId: recoveredPodId,
          startedAt: lease.createdAt,
          hourlyUsd: trackedHourlyUsd,
        });
      } catch (error) {
        const cleaned = await this.terminateAllocatedPod(
          client,
          trackedLease,
          "compute usage tracking failed during startup recovery",
        );
        return {
          recovered: false,
          cleaned,
          detail: "Pod termination requested because usage tracking could not be recovered",
        };
      }
      if (lease.state === "terminating") {
        const cleaned = await this.terminateAllocatedPod(
          client,
          trackedLease,
          "continuing termination requested before gateway restart",
        );
        return {
          recovered: false,
          cleaned,
          detail: cleaned
            ? "pending Pod termination completed during startup recovery"
            : "Pod termination requested before restart is still pending",
        };
      }
      if (!lease.podId) {
        const cleaned = await this.terminateAllocatedPod(
          client,
          trackedLease,
          "a name-only provisional Pod cannot be reattached after restart",
        );
        return {
          recovered: false,
          cleaned,
          detail: cleaned
            ? "provisional Pod terminated after startup recovery"
            : "provisional Pod termination is still pending",
        };
      }
      if (!profile) {
        const cleaned = await this.terminateAllocatedPod(
          client,
          trackedLease,
          "compute profile was removed",
        );
        return {
          recovered: false,
          cleaned,
          detail: cleaned
            ? "Pod terminated because its compute profile is missing"
            : "Pod termination is still pending",
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
        await watchdog.upsertLease(this.watchdogLease(trackedLease, profile));
        this.scheduleWatchdogHeartbeat();
      } catch (error) {
        const cleaned = await this.terminateAllocatedPod(
          client,
          trackedLease,
          "independent watchdog unavailable during startup recovery",
        );
        return {
          recovered: false,
          cleaned,
          detail: cleaned
            ? `Pod terminated because the independent watchdog is unavailable: ${error instanceof Error ? error.message : "unknown error"}`
            : "Pod termination is pending because the independent watchdog is unavailable",
        };
      }
      try {
        await this.scheduleSafety(trackedLease, profile);
      } catch (error) {
        const cleaned = await this.terminateAllocatedPod(
          client,
          trackedLease,
          "compute safety scheduling failed during startup recovery",
        );
        return {
          recovered: false,
          cleaned,
          detail: "Pod termination requested because local safety scheduling failed",
        };
      }
      const deadlinePassed =
        this.dependencies.now().getTime() >=
        Math.min(Date.parse(lease.idleDeadlineAt), Date.parse(lease.hardDeadlineAt));
      let allocationError: string | null = null;
      if (!deadlinePassed) {
        try {
          pod = await this.waitForAllocationEvidence(client, profile, pod, lease.podName);
        } catch {
          const reason = "allocation evidence could not be verified during startup recovery";
          const cleaned = await this.terminateAllocatedPod(client, trackedLease, reason);
          return {
            recovered: false,
            cleaned,
            detail: cleaned
              ? "Pod terminated because allocation evidence could not be verified"
              : "Pod termination is pending because allocation evidence could not be verified",
          };
        }
        allocationError =
          pod.id !== trackedLease.podId || pod.name !== lease.podName
            ? "RunPod did not preserve the allocated Pod identity"
            : this.validateAllocatedPod(profile, pod);
        if (!allocationError) {
          try {
            allocationError = await this.preBootstrapSafetyError(trackedLease, profile);
          } catch {
            allocationError = "compute safety validation failed during startup recovery";
          }
        }
      }
      if (allocationError || deadlinePassed) {
        const reason = allocationError ?? "expired compute lease";
        const cleaned = await this.terminateAllocatedPod(client, trackedLease, reason);
        return {
          recovered: false,
          cleaned,
          detail: cleaned ? `${reason} terminated` : "Pod termination is still pending",
        };
      }
      if (pod.desiredStatus === "RUNNING") {
        const secret = await this.dependencies.readWorkerSecret(lease.id);
        if (!secret) {
          const cleaned = await this.terminateFailedBootstrap(
            client,
            trackedLease,
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
          const updated = await this.dependencies.updateLease((current) => {
            if (current.id !== lease.id || current.podId !== recoveredPodId) {
              throw new Error("durable compute lease changed during startup recovery");
            }
            return {
              ...current,
              podId: recoveredPodId,
              observedHourlyUsd: price(pod) ?? trackedHourlyUsd,
              state: "bootstrapping",
              workerProtocolVersion: undefined,
              workerBuildId: undefined,
              workerReadyAt: undefined,
              error: undefined,
            };
          });
          if (!updated || updated.id !== lease.id || updated.podId !== recoveredPodId) {
            throw new Error("durable compute lease disappeared during startup recovery");
          }
          await this.scheduleSafety(updated, profile);
          this.enqueueWorkerBootstrap(client, profile, updated, secret);
          return {
            recovered: true,
            cleaned: false,
            detail: "compute lease reattached; worker bootstrap is continuing in the background",
          };
        } catch (error) {
          const cleaned = await this.terminateAllocatedPod(
            client,
            trackedLease,
            `startup recovery bookkeeping failed: ${error instanceof Error ? error.message : "unknown error"}`,
          );
          return {
            recovered: false,
            cleaned,
            detail: "Pod termination requested because startup recovery could not be persisted",
          };
        }
      }
      try {
        const updated = await this.dependencies.updateLease((current) => ({
          ...current,
          podId: recoveredPodId,
          observedHourlyUsd: price(pod) ?? trackedHourlyUsd,
          state: "stopped",
        }));
        if (!updated || updated.id !== lease.id || updated.podId !== recoveredPodId) {
          throw new Error("durable compute lease disappeared during startup recovery");
        }
        await this.scheduleSafety(updated, profile);
        return { recovered: true, cleaned: false, detail: "compute lease reattached" };
      } catch (error) {
        const cleaned = await this.terminateAllocatedPod(
          client,
          trackedLease,
          `startup recovery bookkeeping failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        return {
          recovered: false,
          cleaned,
          detail: "Pod termination requested because startup recovery could not be persisted",
        };
      }
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
