import {
  parseRunPodBillingRecords,
  parseRunPodPod,
  parseRunPodPodList,
  type RunPodBillingRecord,
  type RunPodCreatePodInput,
  type RunPodPod,
} from "./runpodSchemas.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class RunPodApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface RunPodClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function normalizedBaseUrl(value: string): string {
  const parsed = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new RunPodApiError("RunPod API base URL must be HTTPS (or loopback for tests)");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function validPodId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,191}$/.test(value)) {
    throw new RunPodApiError("RunPod Pod id is invalid");
  }
  return value;
}

export class RunPodClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: RunPodClientOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    if (!options.apiKey.trim()) throw new RunPodApiError("RunPod API key is not configured");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    requestedTimeoutMs?: number,
  ): Promise<unknown> {
    if (
      requestedTimeoutMs !== undefined &&
      (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0)
    ) {
      throw new RunPodApiError("RunPod API request timeout must be positive");
    }
    const timeoutMs =
      requestedTimeoutMs === undefined
        ? this.timeoutMs
        : Math.max(1, Math.min(this.timeoutMs, Math.floor(requestedTimeoutMs)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      headers.set("Authorization", `Bearer ${this.options.apiKey.trim()}`);
      if (init.body !== undefined) headers.set("Content-Type", "application/json");
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        throw new RunPodApiError(
          `RunPod API request failed with HTTP ${response.status}`,
          response.status,
        );
      }
      if (response.status === 204) return null;
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new RunPodApiError(
          "RunPod API response exceeds the safe size limit",
          response.status,
        );
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
            throw new RunPodApiError(
              "RunPod API response exceeds the safe size limit",
              response.status,
            );
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
      const text = new TextDecoder().decode(bytes);
      if (!text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new RunPodApiError("RunPod API returned invalid JSON", response.status);
      }
    } catch (error) {
      if (error instanceof RunPodApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new RunPodApiError("RunPod API request timed out");
      }
      throw new RunPodApiError(
        `RunPod API request failed: ${error instanceof Error ? error.message : "unknown network error"}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async listPods(): Promise<RunPodPod[]> {
    return parseRunPodPodList(await this.request("/pods"));
  }

  async getPod(podId: string, options: { timeoutMs?: number } = {}): Promise<RunPodPod | null> {
    try {
      return parseRunPodPod(
        await this.request(
          `/pods/${encodeURIComponent(validPodId(podId))}?includeMachine=true`,
          {},
          options.timeoutMs,
        ),
      );
    } catch (error) {
      if (error instanceof RunPodApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createPod(input: RunPodCreatePodInput): Promise<RunPodPod> {
    return parseRunPodPod(
      await this.request("/pods", { method: "POST", body: JSON.stringify(input) }),
    );
  }

  async startPod(podId: string): Promise<void> {
    await this.request(`/pods/${encodeURIComponent(validPodId(podId))}/start`, {
      method: "POST",
    });
  }

  async stopPod(podId: string): Promise<void> {
    await this.request(`/pods/${encodeURIComponent(validPodId(podId))}/stop`, {
      method: "POST",
    });
  }

  async deletePod(podId: string): Promise<void> {
    await this.request(`/pods/${encodeURIComponent(validPodId(podId))}`, {
      method: "DELETE",
    });
  }

  async getPodBilling(options: {
    startTime: string;
    podId?: string;
  }): Promise<RunPodBillingRecord[]> {
    const query = new URLSearchParams({
      bucketSize: "day",
      grouping: "podId",
      startTime: options.startTime,
    });
    if (options.podId) query.set("podId", validPodId(options.podId));
    return parseRunPodBillingRecords(await this.request(`/billing/pods?${query.toString()}`));
  }
}
