import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WatchdogClient, WatchdogProtocolError, parseWatchdogStatus } from "./watchdogClient.js";

const TOKEN = "watchdog_ingest_token_with_32_chars_minimum";
const NOW = new Date("2026-08-30T12:00:00.000Z");

function status() {
  return {
    service: "glimmer-compute-watchdog",
    schemaVersion: 1,
    ready: true,
    checkedAt: NOW.toISOString(),
    lastSweepAt: NOW.toISOString(),
    staleAfterSeconds: 180,
  };
}

describe("WatchdogClient", () => {
  it("signs the exact request and accepts a strict status response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const timestamp = new Headers(init?.headers).get("X-Glimmer-Timestamp")!;
      const expected = createHmac("sha256", TOKEN)
        .update(`GET\n${url.pathname}\n${timestamp}\n`)
        .digest("hex");
      expect(new Headers(init?.headers).get("X-Glimmer-Signature")).toBe(`v1=${expected}`);
      expect(init?.redirect).toBe("error");
      return Response.json(status());
    });
    const client = new WatchdogClient({
      baseUrl: "https://watchdog.example",
      ingestToken: TOKEN,
      fetchImpl,
      now: () => NOW,
    });
    await expect(client.status()).resolves.toEqual(status());
  });

  it("publishes and deletes a minimal lease without provider credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "PUT") {
        expect(JSON.parse(String(init.body))).toEqual({
          schemaVersion: 1,
          leaseId: "lease-1",
          ownerInstanceId: "instance-1",
          podName: "pod-1",
          hardDeadlineAt: "2026-08-30T13:00:00.000Z",
          lastHeartbeatAt: NOW.toISOString(),
          maxHourlyUsd: 1.75,
        });
        expect(String(init.body)).not.toContain("apiKey");
        return Response.json(
          { accepted: true, leaseId: "lease-1", storedAt: NOW.toISOString() },
          { status: 201 },
        );
      }
      expect(url.pathname).toBe("/v1/leases/lease-1");
      return Response.json({ deleted: true, leaseId: "lease-1" });
    });
    const client = new WatchdogClient({
      baseUrl: "https://watchdog.example",
      ingestToken: TOKEN,
      fetchImpl,
      now: () => NOW,
    });
    await client.upsertLease({
      schemaVersion: 1,
      leaseId: "lease-1",
      ownerInstanceId: "instance-1",
      podName: "pod-1",
      hardDeadlineAt: "2026-08-30T13:00:00.000Z",
      lastHeartbeatAt: NOW.toISOString(),
      maxHourlyUsd: 1.75,
    });
    await client.deleteLease("lease-1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects endpoint confusion and response shape drift", () => {
    expect(
      () =>
        new WatchdogClient({
          baseUrl: "https://user:password@watchdog.example/path",
          ingestToken: TOKEN,
        }),
    ).toThrow(WatchdogProtocolError);
    expect(() => parseWatchdogStatus({ ...status(), secret: "unexpected" })).toThrow(
      /unsupported or missing fields/,
    );
  });

  it("stops reading an oversized watchdog response", async () => {
    const client = new WatchdogClient({
      baseUrl: "https://watchdog.example",
      ingestToken: TOKEN,
      fetchImpl: vi.fn().mockResolvedValue(new Response("x".repeat(64 * 1024 + 1))),
      now: () => NOW,
    });
    await expect(client.status()).rejects.toThrow(/safe size limit/);
  });
});
