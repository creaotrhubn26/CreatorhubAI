import type { ModelStatus } from "@glimmer/shared";

export async function probeModel(baseUrl: string, timeoutMs = 3000): Promise<ModelStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, { signal: controller.signal });
    if (res.status === 401 || res.status === 403) {
      return { status: "REACHABLE_AUTH", endpoint: baseUrl, httpStatus: res.status, provenance: "deterministic-backend" };
    }
    if (res.ok) {
      return { status: "ONLINE", endpoint: baseUrl, httpStatus: res.status, provenance: "deterministic-backend" };
    }
    return { status: "OFFLINE", endpoint: baseUrl, httpStatus: res.status, provenance: "deterministic-backend" };
  } catch {
    return { status: "OFFLINE", endpoint: baseUrl, provenance: "deterministic-backend" };
  } finally {
    clearTimeout(timer);
  }
}
