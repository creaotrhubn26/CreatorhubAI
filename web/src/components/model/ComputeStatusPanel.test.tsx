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
    expect(screen.getByRole("button", { name: "Start external compute" })).toBeEnabled();
  });

  it("starts only the explicitly selected remote backend", async () => {
    vi.spyOn(glimmerApi, "getComputeStatus").mockResolvedValue(offline);
    mockUsage();
    const start = vi.spyOn(glimmerApi, "startCompute").mockResolvedValue({
      started: true,
      status: { ...offline, state: "bootstrapping" },
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Start external compute" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
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
});
