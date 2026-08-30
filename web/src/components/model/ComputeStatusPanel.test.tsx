import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComputeStatus } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { ComputeStatusPanel } from "./ComputeStatusPanel";

const offline: ComputeStatus = {
  backend: "runpod_pod",
  state: "offline",
  checkedAt: "2026-08-29T12:00:00Z",
  profileId: "runpod-a100",
  detail: "No RunPod Pod is active.",
  budget: {
    allowed: true,
    hourlyCeilingUsd: 1.75,
    estimatedTodayUsd: 0,
    estimatedMonthUsd: 0,
  },
  policy: {
    secureCloudOnly: true,
    maximumGpuCount: 1,
    watchdogConfigured: false,
    unattendedUseAllowed: false,
  },
};

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ComputeStatusPanel />
    </QueryClientProvider>,
  );
}

function mockUsage() {
  vi.spyOn(glimmerApi, "getComputeUsage").mockResolvedValue({
    checkedAt: "2026-08-29T12:00:00Z",
    estimatedTodayUsd: 0.25,
    estimatedMonthUsd: 1.5,
    estimatedTotalUsd: 1.5,
    reconciledTodayUsd: 0.2,
    provenance: { estimate: "local-interval-ledger", reconciled: "runpod-billing-api" },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("ComputeStatusPanel", () => {
  it("shows the provider ceiling and watchdog limitation honestly", async () => {
    vi.spyOn(glimmerApi, "getComputeStatus").mockResolvedValue(offline);
    mockUsage();
    renderPanel();
    expect(await screen.findByText("offline")).toBeInTheDocument();
    expect(screen.getByText("$1.7500")).toBeInTheDocument();
    expect(screen.getByText(/Independent watchdog unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start external compute" })).toBeDisabled();
  });

  it("starts only the explicitly selected remote backend", async () => {
    vi.spyOn(glimmerApi, "getComputeStatus").mockResolvedValue({
      ...offline,
      policy: { ...offline.policy, watchdogConfigured: true, unattendedUseAllowed: true },
    });
    mockUsage();
    const start = vi.spyOn(glimmerApi, "startCompute").mockResolvedValue({
      started: true,
      status: { ...offline, state: "bootstrapping" },
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Start external compute" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  });

  it("enables termination from the 202 bootstrap response before a slow status refetch", async () => {
    const configured = {
      ...offline,
      policy: { ...offline.policy, watchdogConfigured: true, unattendedUseAllowed: true },
    };
    let resolveRefetch!: (status: ComputeStatus) => void;
    vi.spyOn(glimmerApi, "getComputeStatus")
      .mockResolvedValueOnce(configured)
      .mockImplementation(
        async () =>
          new Promise<ComputeStatus>((resolve) => {
            resolveRefetch = resolve;
          }),
      );
    mockUsage();
    const bootstrapping: ComputeStatus = {
      ...configured,
      state: "bootstrapping",
      detail: "Worker bootstrap is continuing in the background.",
      pod: {
        id: "pod_123",
        name: "glimmer-test",
        desiredStatus: "RUNNING",
        gpuTypeId: "NVIDIA A100 80GB PCIe",
        gpuCount: 1,
        adjustedCostPerHr: 1.39,
      },
    };
    vi.spyOn(glimmerApi, "startCompute").mockResolvedValue({
      started: true,
      status: bootstrapping,
    });

    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Start external compute" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Terminate external compute" })).toBeEnabled(),
    );
    expect(screen.getByText("pod_123")).toBeInTheDocument();
    resolveRefetch(bootstrapping);
  });

  it("renders provider-observed GPU/rate and offers termination for an active Pod", async () => {
    vi.spyOn(glimmerApi, "getComputeStatus").mockResolvedValue({
      ...offline,
      state: "bootstrapping",
      pod: {
        id: "pod_123",
        name: "glimmer-test",
        desiredStatus: "RUNNING",
        gpuTypeId: "NVIDIA A100 80GB PCIe",
        gpuCount: 1,
        adjustedCostPerHr: 1.39,
      },
      budget: { ...offline.budget!, currentHourlyUsd: 1.39 },
      worker: {
        protocolVersion: 1,
        buildId: "r2-aaaaaaaaaaaa",
        ready: true,
        workerState: "ready",
        model: { ready: true, contextTokens: 65_536 },
      },
    });
    mockUsage();
    vi.spyOn(glimmerApi, "stopCompute").mockResolvedValue({
      stopped: true,
      terminated: true,
      status: offline,
    });
    renderPanel();
    expect(await screen.findByText("pod_123")).toBeInTheDocument();
    expect(screen.getByText("NVIDIA A100 80GB PCIe")).toBeInTheDocument();
    expect(screen.getByText("$1.3900")).toBeInTheDocument();
    expect(screen.getByText("Authenticated and ready")).toBeInTheDocument();
    expect(screen.getByText("r2-aaaaaaaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("65,536 tokens")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminate external compute" })).toBeEnabled();
  });

  it("renders bounded bootstrap progress and the retained outcome", async () => {
    const worker = {
      protocolVersion: 2 as const,
      buildId: "r2-bbbbbbbbbbbb",
      ready: false,
      workerState: "bootstrapping" as const,
      model: { ready: false, contextTokens: 65_536 as const },
      bootstrap: {
        stage: "artifact_downloading" as const,
        outcome: "in_progress" as const,
        stageStartedAt: "2026-08-29T12:00:00Z",
        updatedAt: "2026-08-29T12:00:05Z",
        artifact: {
          kind: "model" as const,
          phase: "downloading" as const,
          bytesCompleted: 268_435_456,
          bytesTotal: 19_700_000_000,
        },
      },
    };
    vi.spyOn(glimmerApi, "getComputeStatus").mockResolvedValue({
      ...offline,
      state: "bootstrapping",
      pod: {
        id: "pod_progress",
        name: "glimmer-progress",
        desiredStatus: "RUNNING",
      },
      worker,
      lastDiagnostic: {
        schemaVersion: 1,
        leaseId: "lease-progress",
        podId: "pod_progress",
        podName: "glimmer-progress",
        observedAt: "2026-08-29T12:00:05Z",
        outcome: "bootstrapping",
        worker,
      },
    });
    mockUsage();
    renderPanel();

    expect(await screen.findByText("artifact downloading")).toBeInTheDocument();
    expect(
      screen.getByText("model downloading — 268,435,456 / 19,700,000,000 bytes"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("bootstrapping", { selector: "dd" })).toHaveLength(2);
    expect(screen.getByText("2026-08-29T12:00:05Z")).toBeInTheDocument();
  });
});
