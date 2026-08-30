import { describe, expect, it, vi } from "vitest";
import { RunPodApiError, RunPodClient } from "./runpodClient.js";
import type { RunPodCreatePodInput } from "./runpodSchemas.js";

const API_KEY = "runpod-test-secret";
const POD = {
  id: "pod_123",
  name: "glimmer-test",
  desiredStatus: "RUNNING",
  adjustedCostPerHr: 1.39,
  gpu: { id: "NVIDIA A100 80GB PCIe", count: 1 },
};

function client(fetchImpl: typeof fetch, timeoutMs?: number) {
  return new RunPodClient({
    baseUrl: "https://rest.runpod.io/v1",
    apiKey: API_KEY,
    fetchImpl,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

describe("RunPodClient", () => {
  it("uses the documented bearer REST contract and validates create responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(POD), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const input: RunPodCreatePodInput = {
      name: "glimmer-test",
      imageName: `ghcr.io/example/glimmer@sha256:${"a".repeat(64)}`,
      containerRegistryAuthId: "registry_auth_1",
      cloudType: "SECURE",
      computeType: "GPU",
      gpuTypeIds: ["NVIDIA A100 80GB PCIe"],
      gpuTypePriority: "availability",
      gpuCount: 1,
      containerDiskInGb: 50,
      networkVolumeId: "volume_1",
      volumeMountPath: "/workspace",
      ports: ["4318/http"],
      interruptible: false,
      locked: false,
      env: { GLIMMER_CONTEXT_TOKENS: "65536" },
    };

    await expect(client(fetchImpl).createPod(input)).resolves.toMatchObject({
      id: "pod_123",
      adjustedCostPerHr: 1.39,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://rest.runpod.io/v1/pods");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it("uses exact encoded Pod paths and treats a provider 404 as absent", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 404 }));
    await expect(client(fetchImpl).getPod("pod_123")).resolves.toBeNull();
    expect(fetchImpl.mock.calls[0][0]).toBe("https://rest.runpod.io/v1/pods/pod_123");
    await expect(client(fetchImpl).getPod("../unsafe")).rejects.toThrow("Pod id is invalid");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts exact Pod reads at the smaller of the requested and client timeouts", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      });
      const api = client(fetchImpl, 50);

      const shorter = expect(api.getPod("pod_123", { timeoutMs: 20 })).rejects.toThrow(
        "request timed out",
      );
      await vi.advanceTimersByTimeAsync(20);
      await shorter;

      const capped = expect(api.getPod("pod_123", { timeoutMs: 200 })).rejects.toThrow(
        "request timed out",
      );
      await vi.advanceTimersByTimeAsync(49);
      expect(fetchImpl.mock.calls[1][1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await capped;
      expect(fetchImpl.mock.calls[1][1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the documented start, stop, and delete lifecycle endpoints", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const api = client(fetchImpl);
    await api.startPod("pod_123");
    await api.stopPod("pod_123");
    await api.deletePod("pod_123");
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["https://rest.runpod.io/v1/pods/pod_123/start", "POST"],
      ["https://rest.runpod.io/v1/pods/pod_123/stop", "POST"],
      ["https://rest.runpod.io/v1/pods/pod_123", "DELETE"],
    ]);
  });

  it("never includes the API key or provider body in surfaced errors", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: `bad credential ${API_KEY}` }), { status: 401 }),
      );
    const error = await client(fetchImpl)
      .listPods()
      .catch((caught) => caught as RunPodApiError);
    expect(error).toBeInstanceOf(RunPodApiError);
    expect(error.status).toBe(401);
    expect(error.message).toBe("RunPod API request failed with HTTP 401");
    expect(error.message).not.toContain(API_KEY);
  });

  it("rejects malformed successful responses instead of fabricating provider state", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ id: "pod_123" }), { status: 200 }));
    await expect(client(fetchImpl).getPod("pod_123")).rejects.toThrow("name is required");
  });

  it("rejects oversized responses and disables redirects before parsing", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("[]", {
        status: 200,
        headers: { "content-length": String(3 * 1024 * 1024) },
      }),
    );
    await expect(client(fetchImpl).listPods()).rejects.toThrow("safe size limit");
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe("error");
  });

  it("requests provider billing with documented grouping and time parameters", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            amount: 1.25,
            podId: "pod_123",
            gpuTypeId: "NVIDIA A100 80GB PCIe",
            time: "2026-08-01T00:00:00.000Z",
            timeBilledMs: 3_600_000,
          },
        ]),
        { status: 200 },
      ),
    );
    await expect(
      client(fetchImpl).getPodBilling({
        startTime: "2026-08-01T00:00:00.000Z",
        podId: "pod_123",
      }),
    ).resolves.toMatchObject([{ amount: 1.25, podId: "pod_123" }]);
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.pathname).toBe("/v1/billing/pods");
    expect(url.searchParams.get("bucketSize")).toBe("day");
    expect(url.searchParams.get("grouping")).toBe("podId");
    expect(url.searchParams.get("podId")).toBe("pod_123");
  });
});
