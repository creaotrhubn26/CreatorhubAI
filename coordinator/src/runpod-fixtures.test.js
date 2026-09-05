import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  filterRawRunPodV2PodsByExactName,
  parseRunPodV2Pod,
  parseRunPodV2PodIdentity,
  parseRunPodV2PodList,
} from "./runpod-v2.js";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../../fixtures/runpod-rest-v1/${name}`, import.meta.url)));

describe("RunPod REST v1 fixture contract", () => {
  it("parses the sanitized live GPU Pod shape, including imageName", () => {
    const pod = parseRunPodV2Pod(fixture("pod-gpu.json"));
    expect(pod).toMatchObject({
      id: "pod_fixture_gpu1",
      status: "RUNNING",
      cloud: "SECURE",
      dataCenterId: "EUR-IS-1",
      gpu: { id: "NVIDIA A100 80GB PCIe", count: 1 },
      cpu: null,
      mounts: { network: [{ volumeId: "vol_fixture_1", path: "/workspace" }] },
    });
    expect(pod.image).toContain("@sha256:");
    expect("env" in pod).toBe(false);
  });

  it("derives the GPU from machine metadata when the nested gpu object is absent", () => {
    const raw = fixture("pod-gpu.json");
    delete raw.gpu;
    const pod = parseRunPodV2Pod(raw);
    expect(pod.gpu).toEqual({ id: "NVIDIA A100 80GB PCIe", count: 1 });
    expect(pod.cpu).toBeNull();
  });

  it("parses the sanitized live CPU Pod shape", () => {
    const pod = parseRunPodV2Pod(fixture("pod-cpu.json"));
    expect(pod).toMatchObject({
      id: "pod_fixture_cpu1",
      cpu: { id: "cpu3c", vcpuCount: 2 },
      gpu: null,
    });
  });

  it("recovers owned Pods by exact name even though full list parsing fails", () => {
    const list = fixture("pod-list.json");
    expect(() => parseRunPodV2PodList(list)).toThrow();
    const matches = filterRawRunPodV2PodsByExactName(list, "glimmer-gpu-fixture").map(
      parseRunPodV2Pod,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("pod_fixture_gpu1");
    expect(parseRunPodV2PodIdentity(list[2])).toEqual({
      id: "pod_fixture_unrelated",
      name: "unrelated-notebook",
      status: "RUNNING",
    });
  });
});
