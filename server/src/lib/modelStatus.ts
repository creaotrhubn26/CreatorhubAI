import type { ModelStatus } from "@glimmer/shared";

// Best-effort extras from llama.cpp's GET /props — public, no api-key check
// (unlike /health, /completion, etc., so this never needs the Bearer header
// probeModel itself doesn't send either). Shape per llama.cpp server docs:
// { default_generation_settings: { n_ctx, speculative, ... }, model_path, ... }.
export type ModelProps = Pick<ModelStatus, "contextSize" | "modelPath" | "speculativeDecoding">;

export async function probeModelProps(
  baseUrl: string,
  timeoutMs = 1500,
): Promise<ModelProps | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/props`, { signal: controller.signal });
    if (!res.ok) return null;
    const body: any = await res.json();
    const gen = body?.default_generation_settings;
    const props: ModelProps = {};
    if (typeof gen?.n_ctx === "number") props.contextSize = gen.n_ctx;
    if (typeof body?.model_path === "string") props.modelPath = body.model_path;
    if (typeof gen?.speculative === "boolean") props.speculativeDecoding = gen.speculative;
    return Object.keys(props).length > 0 ? props : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeModel(baseUrl: string, timeoutMs = 3000): Promise<ModelStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, { signal: controller.signal });
    if (res.status === 401 || res.status === 403) {
      return {
        status: "REACHABLE_AUTH",
        endpoint: baseUrl,
        httpStatus: res.status,
        provenance: "deterministic-backend",
      };
    }
    if (res.ok) {
      return {
        status: "ONLINE",
        endpoint: baseUrl,
        httpStatus: res.status,
        provenance: "deterministic-backend",
      };
    }
    return {
      status: "OFFLINE",
      endpoint: baseUrl,
      httpStatus: res.status,
      provenance: "deterministic-backend",
    };
  } catch {
    return { status: "OFFLINE", endpoint: baseUrl, provenance: "deterministic-backend" };
  } finally {
    clearTimeout(timer);
  }
}
