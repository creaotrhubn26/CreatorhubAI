import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ModelStatusScreen } from "./ModelStatusScreen";
import * as client from "../../api/client";

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("ModelStatusScreen", () => {
  it("renders real /props-derived metrics when the backend provides them", async () => {
    vi.spyOn(client.glimmerApi, "getModelStatus").mockResolvedValue({
      status: "ONLINE", endpoint: "http://127.0.0.1:8080", provenance: "deterministic-backend",
      contextSize: 65536, modelPath: "/models/muse-glimmer-30b.gguf", speculativeDecoding: true,
    });
    render(withQuery(<ModelStatusScreen />));
    await waitFor(() => expect(screen.getByText("65536")).toBeInTheDocument());
    expect(screen.getByText("/models/muse-glimmer-30b.gguf")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
  });

  it("shows 'Unavailable' for every /props-derived field when the probe never provided them, never fabricating a value", async () => {
    vi.spyOn(client.glimmerApi, "getModelStatus").mockResolvedValue({
      status: "ONLINE", endpoint: "http://127.0.0.1:8080", provenance: "deterministic-backend",
    });
    render(withQuery(<ModelStatusScreen />));
    await waitFor(() => expect(screen.getByText("ONLINE")).toBeInTheDocument());
    // Context, Model path, Speculative decoding, Draft model, Prompt tokens, Tokens/sec.
    expect(screen.getAllByText("Unavailable")).toHaveLength(6);
  });
});
