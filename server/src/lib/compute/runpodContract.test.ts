import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  filterRawRunPodPodsByName,
  parseRunPodPod,
  parseRunPodPodIdentity,
  parseRunPodPodList,
} from "./runpodSchemas.js";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../../fixtures/runpod-rest-v1/${name}`, import.meta.url), "utf8"),
  );

describe("RunPod REST v1 fixture contract", () => {
  it("parses the sanitized live GPU Pod shape", () => {
    expect(parseRunPodPod(fixture("pod-gpu.json"))).toMatchObject({
      id: "pod_fixture_gpu1",
      name: "glimmer-gpu-fixture",
      desiredStatus: "RUNNING",
      adjustedCostPerHr: 1.39,
      gpu: { id: "NVIDIA A100 80GB PCIe", count: 1 },
    });
  });

  it("parses the sanitized live CPU Pod shape", () => {
    expect(parseRunPodPod(fixture("pod-cpu.json"))).toMatchObject({
      id: "pod_fixture_cpu1",
      desiredStatus: "RUNNING",
    });
  });

  it("recovers owned Pods by exact name even though full list parsing fails", () => {
    const list = fixture("pod-list.json");
    expect(() => parseRunPodPodList(list)).toThrow();
    const matches = filterRawRunPodPodsByName(list, "glimmer-gpu-fixture").map(parseRunPodPod);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("pod_fixture_gpu1");
    expect(parseRunPodPodIdentity((list as unknown[])[2])).toEqual({
      id: "pod_fixture_unrelated",
      name: "unrelated-notebook",
      desiredStatus: "RUNNING",
    });
  });
});
