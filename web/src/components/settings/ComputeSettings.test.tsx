import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComputeConfigV1 } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { ComputeSettings } from "./ComputeSettings";

const config: ComputeConfigV1 = {
  version: 1,
  enabled: false,
  defaultBackend: "local_process",
  activeProfileId: "runpod-a100",
  source: "saved",
  profiles: [
    {
      id: "runpod-a100",
      label: "RunPod A100 80 GB",
      provider: "runpod",
      cloudType: "SECURE",
      performance: "economy",
      gpuTypeIds: ["NVIDIA A100 80GB PCIe", "NVIDIA A100-SXM4-80GB"],
      gpuCount: 1,
      contextTokens: 65_536,
      imageDigest: `ghcr.io/example/glimmer@sha256:${"a".repeat(64)}`,
      networkVolumeId: "network_volume_1",
      maxGpuHourlyUsd: 1.75,
      idleTimeoutSeconds: 300,
      clarificationTimeoutSeconds: 120,
      hardSessionLimitSeconds: 7_200,
      dailyBudgetUsd: 10,
      monthlyBudgetUsd: 50,
      hasApiKey: true,
      watchdogConfigured: false,
    },
    {
      id: "runpod-h100-latency",
      label: "RunPod H100 latency",
      provider: "runpod",
      cloudType: "SECURE",
      performance: "latency",
      gpuTypeIds: ["NVIDIA H100 PCIe", "NVIDIA H100 80GB HBM3"],
      gpuCount: 1,
      contextTokens: 65_536,
      imageDigest: `ghcr.io/example/glimmer@sha256:${"b".repeat(64)}`,
      networkVolumeId: "network_volume_1",
      maxGpuHourlyUsd: 3.75,
      idleTimeoutSeconds: 300,
      clarificationTimeoutSeconds: 120,
      hardSessionLimitSeconds: 7_200,
      dailyBudgetUsd: 10,
      monthlyBudgetUsd: 50,
      hasApiKey: true,
      watchdogConfigured: false,
    },
  ],
};

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ComputeSettings />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("ComputeSettings", () => {
  it("keeps the stored key secret and saves an explicit RunPod selection", async () => {
    vi.spyOn(glimmerApi, "getComputeConfig").mockResolvedValue(config);
    const save = vi.spyOn(glimmerApi, "saveComputeConfig").mockResolvedValue({
      ...config,
      enabled: true,
      defaultBackend: "runpod_pod",
    });
    renderSettings();

    const key = (await screen.findByLabelText(/API key/i)) as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(key.value).toBe("");
    expect(screen.getByText(/no independently deployed watchdog/i)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Enable external compute configuration/i));
    fireEvent.change(screen.getByLabelText("Default backend"), {
      target: { value: "runpod_pod" },
    });
    fireEvent.change(key, { target: { value: "new-runpod-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save compute settings" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        enabled: true,
        defaultBackend: "runpod_pod",
        activeProfileId: "runpod-a100",
        apiKey: "new-runpod-secret",
      }),
    );
    const payload = save.mock.calls[0][0];
    expect(JSON.stringify(payload.profiles)).not.toContain("hasApiKey");
    expect(JSON.stringify(payload.profiles)).not.toContain("watchdogConfigured");
    expect(await screen.findByText("Compute settings saved.")).toBeInTheDocument();
  });

  it("keeps H100 behind an explicit latency-profile selection", async () => {
    vi.spyOn(glimmerApi, "getComputeConfig").mockResolvedValue(config);
    vi.spyOn(glimmerApi, "saveComputeConfig").mockResolvedValue(config);
    renderSettings();

    const profile = await screen.findByLabelText("Active profile");
    fireEvent.change(profile, { target: { value: "runpod-h100-latency" } });
    expect(screen.getAllByText(/H100 latency/).length).toBeGreaterThan(0);
    expect(screen.getByText(/NVIDIA H100 PCIe/)).toBeInTheDocument();
  });

  it("tests only the stored credential and states that no resource was created", async () => {
    vi.spyOn(glimmerApi, "getComputeConfig").mockResolvedValue(config);
    const testCredential = vi.spyOn(glimmerApi, "testComputeCredential").mockResolvedValue({
      provider: "runpod",
      authenticated: true,
      checkedAt: "2026-08-29T12:00:00Z",
      visiblePodCount: 2,
      detail: "accepted",
    });
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Test stored credential" }));
    await waitFor(() => expect(testCredential).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/2 Pod\(s\) visible.*No resource was created/i),
    ).toBeInTheDocument();
  });
});
