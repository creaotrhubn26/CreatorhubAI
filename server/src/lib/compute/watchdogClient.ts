import { createHmac } from "node:crypto";
import type { ComputeWatchdogTestResult } from "@glimmer/shared";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9._-]{1,191}$/;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{32,512}$/;

export interface WatchdogLeaseV1 {
  schemaVersion: 1;
  leaseId: string;
  ownerInstanceId: string;
  podName: string;
  podId?: string;
  hardDeadlineAt: string;
  lastHeartbeatAt: string;
  maxHourlyUsd: number;
}

export interface WatchdogClientOptions {
  baseUrl: string;
  ingestToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export class WatchdogProtocolError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function normalizedBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WatchdogProtocolError("watchdog endpoint is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new WatchdogProtocolError("watchdog endpoint must be an origin-only HTTPS URL");
  }
  return parsed.origin;
}

function validId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw new WatchdogProtocolError(`${label} is invalid`);
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WatchdogProtocolError("watchdog returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new WatchdogProtocolError("watchdog response contains unsupported or missing fields");
  }
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new WatchdogProtocolError(`${label} is invalid`);
  }
  return value;
}

export function watchdogRequestSignature(
  ingestToken: string,
  method: string,
  requestPath: string,
  timestampMs: number,
  body: string,
): string {
  if (!SAFE_TOKEN.test(ingestToken)) {
    throw new WatchdogProtocolError("watchdog ingest token is invalid");
  }
  const message = `${method.toUpperCase()}\n${requestPath}\n${timestampMs}\n${body}`;
  return createHmac("sha256", ingestToken).update(message).digest("hex");
}

export function parseWatchdogStatus(value: unknown): ComputeWatchdogTestResult {
  const raw = object(value);
  exactKeys(raw, [
    "service",
    "schemaVersion",
    "ready",
    "checkedAt",
    "lastSweepAt",
    "staleAfterSeconds",
  ]);
  if (
    raw.service !== "glimmer-compute-watchdog" ||
    raw.schemaVersion !== 1 ||
    typeof raw.ready !== "boolean" ||
    !Number.isInteger(raw.staleAfterSeconds) ||
    Number(raw.staleAfterSeconds) < 120 ||
    Number(raw.staleAfterSeconds) > 600 ||
    (raw.lastSweepAt !== null && typeof raw.lastSweepAt !== "string")
  ) {
    throw new WatchdogProtocolError("watchdog status schema is invalid");
  }
  return {
    service: "glimmer-compute-watchdog",
    schemaVersion: 1,
    ready: raw.ready,
    checkedAt: timestamp(raw.checkedAt, "watchdog checkedAt"),
    ...(raw.lastSweepAt === null
      ? {}
      : { lastSweepAt: timestamp(raw.lastSweepAt, "watchdog lastSweepAt") }),
    staleAfterSeconds: Number(raw.staleAfterSeconds),
  };
}

export class WatchdogClient {
  private readonly baseUrl: string;
  private readonly ingestToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: WatchdogClientOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    this.ingestToken = options.ingestToken.trim();
    if (!SAFE_TOKEN.test(this.ingestToken)) {
      throw new WatchdogProtocolError("watchdog ingest token is invalid");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  private async request(method: string, requestPath: string, body = ""): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    const timestampMs = this.now().getTime();
    const signature = watchdogRequestSignature(
      this.ingestToken,
      method,
      requestPath,
      timestampMs,
      body,
    );
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${requestPath}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          "X-Glimmer-Timestamp": String(timestampMs),
          "X-Glimmer-Signature": `v1=${signature}`,
        },
        ...(body ? { body } : {}),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new WatchdogProtocolError(
          `watchdog request failed with HTTP ${response.status}`,
          response.status,
        );
      }
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new WatchdogProtocolError("watchdog response exceeds the safe size limit");
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new WatchdogProtocolError("watchdog response exceeds the safe size limit");
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new WatchdogProtocolError("watchdog returned invalid JSON");
      }
    } catch (error) {
      if (error instanceof WatchdogProtocolError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new WatchdogProtocolError("watchdog request timed out");
      }
      throw new WatchdogProtocolError(
        `watchdog request failed: ${error instanceof Error ? error.message : "unknown network error"}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async status(): Promise<ComputeWatchdogTestResult> {
    return parseWatchdogStatus(await this.request("GET", "/v1/status"));
  }

  async upsertLease(lease: WatchdogLeaseV1): Promise<void> {
    const leaseId = validId(lease.leaseId, "watchdog lease id");
    const response = object(
      await this.request("PUT", `/v1/leases/${encodeURIComponent(leaseId)}`, JSON.stringify(lease)),
    );
    exactKeys(response, ["accepted", "leaseId", "storedAt"]);
    if (
      response.accepted !== true ||
      response.leaseId !== leaseId ||
      typeof response.storedAt !== "string" ||
      !Number.isFinite(Date.parse(response.storedAt))
    ) {
      throw new WatchdogProtocolError("watchdog lease acknowledgement is invalid");
    }
  }

  async deleteLease(leaseId: string): Promise<void> {
    const safeLeaseId = validId(leaseId, "watchdog lease id");
    const response = object(
      await this.request("DELETE", `/v1/leases/${encodeURIComponent(safeLeaseId)}`),
    );
    exactKeys(response, ["deleted", "leaseId"]);
    if (response.deleted !== true || response.leaseId !== safeLeaseId) {
      throw new WatchdogProtocolError("watchdog delete acknowledgement is invalid");
    }
  }
}
