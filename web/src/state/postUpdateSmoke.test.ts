import { describe, expect, it, vi } from "vitest";
import { rollbackReleaseUrl, runPostUpdateSmoke } from "./postUpdateSmoke";

const marker = {
  fromVersion: "0.2.2",
  toVersion: "0.2.3",
  installedAt: "2026-08-26T20:00:00.000Z",
};

const readiness = {
  status: "degraded" as const,
  coreReady: true,
  checkedAt: "now",
  components: [],
};

describe("post-update smoke test", () => {
  it("accepts a degraded optional model when all core components are ready", async () => {
    const clearMarker = vi.fn();
    await expect(
      runPostUpdateSmoke({
        readMarker: () => marker,
        getVersion: async () => "0.2.3",
        getReadiness: async () => readiness,
        clearMarker,
      }),
    ).resolves.toEqual({
      status: "success",
      message: "Update 0.2.3 passed the automatic startup test.",
    });
    expect(clearMarker).toHaveBeenCalledOnce();
  });

  it("retries while the supervised gateway starts", async () => {
    const getReadiness = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValue(readiness);
    const wait = vi.fn().mockResolvedValue(undefined);
    const result = await runPostUpdateSmoke({
      readMarker: () => marker,
      getVersion: async () => "0.2.3",
      getReadiness,
      wait,
      clearMarker: vi.fn(),
    });
    expect(result?.status).toBe("success");
    expect(getReadiness).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1_000);
  });

  it("returns a validated previous-release recovery link on failure", async () => {
    const result = await runPostUpdateSmoke({
      readMarker: () => marker,
      getVersion: async () => "0.2.2",
      attempts: 1,
    });
    expect(result).toMatchObject({
      status: "failure",
      rollbackUrl: "https://github.com/creaotrhubn26/CreatorhubAI/releases/tag/v0.2.2",
    });
  });

  it("falls back to the releases index for an invalid version", () => {
    expect(rollbackReleaseUrl("../../bad")).toBe(
      "https://github.com/creaotrhubn26/CreatorhubAI/releases",
    );
  });
});
