import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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
      status: "ONLINE",
      endpoint: "http://127.0.0.1:8080",
      provenance: "deterministic-backend",
      contextSize: 65536,
      modelPath: "/models/muse-glimmer-30b.gguf",
      speculativeDecoding: true,
    });
    render(withQuery(<ModelStatusScreen />));
    await waitFor(() => expect(screen.getByText("65536")).toBeInTheDocument());
    expect(screen.getByText("/models/muse-glimmer-30b.gguf")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
  });

  it("shows 'Unavailable' for every /props-derived field when the probe never provided them, never fabricating a value", async () => {
    vi.spyOn(client.glimmerApi, "getModelStatus").mockResolvedValue({
      status: "ONLINE",
      endpoint: "http://127.0.0.1:8080",
      provenance: "deterministic-backend",
    });
    render(withQuery(<ModelStatusScreen />));
    await waitFor(() => expect(screen.getByText("ONLINE")).toBeInTheDocument());
    // Context, Model path, Speculative decoding, Draft model, Prompt tokens, Tokens/sec.
    expect(screen.getAllByText("Unavailable")).toHaveLength(6);
  });

  it("offers Start (not Stop) when the server is OFFLINE", async () => {
    vi.spyOn(client.glimmerApi, "getModelStatus").mockResolvedValue({
      status: "OFFLINE",
      endpoint: "http://127.0.0.1:8080",
      provenance: "deterministic-backend",
      runState: "OFFLINE",
    });
    render(withQuery(<ModelStatusScreen />));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start server" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Stop server" })).toBeDisabled();
  });

  it("shows STARTING as its own state and refuses a second start — never claims ONLINE from a spawn", async () => {
    vi.spyOn(client.glimmerApi, "getModelStatus").mockResolvedValue({
      status: "OFFLINE",
      endpoint: "http://127.0.0.1:8080",
      provenance: "deterministic-backend",
      runState: "STARTING",
    });
    render(withQuery(<ModelStatusScreen />));
    await waitFor(() => expect(screen.getByText("STARTING")).toBeInTheDocument());
    expect(screen.queryByText("ONLINE")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start server" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop server" })).toBeEnabled();
  });

  it("distinguishes LOADING (port up, /health not 200 yet) from ONLINE", async () => {
    vi.spyOn(client.glimmerApi, "getModelStatus").mockResolvedValue({
      status: "OFFLINE",
      endpoint: "http://127.0.0.1:8080",
      provenance: "deterministic-backend",
      runState: "LOADING",
      httpStatus: 503,
    });
    render(withQuery(<ModelStatusScreen />));
    await waitFor(() => expect(screen.getByText("LOADING")).toBeInTheDocument());
    expect(screen.getByText(/the model is loading/i)).toBeInTheDocument();
  });

  it("surfaces the exit code and log tail when the process we started failed", async () => {
    vi.spyOn(client.glimmerApi, "getModelStatus").mockResolvedValue({
      status: "OFFLINE",
      endpoint: "http://127.0.0.1:8080",
      provenance: "deterministic-backend",
      runState: "FAILED",
      exitCode: 1,
      logTail: "error: failed to load model",
    });
    render(withQuery(<ModelStatusScreen />));
    await waitFor(() => expect(screen.getByText("FAILED")).toBeInTheDocument());
    expect(screen.getByText("Exit code: 1")).toBeInTheDocument();
    expect(screen.getByText("error: failed to load model")).toBeInTheDocument();
    // A failure is retryable, so Start stays available.
    expect(screen.getByRole("button", { name: "Start server" })).toBeEnabled();
  });

  it("says why nothing was stopped when the target survived the stop attempt", async () => {
    vi.spyOn(client.glimmerApi, "getModelStatus").mockResolvedValue({
      status: "ONLINE",
      endpoint: "http://127.0.0.1:8080",
      provenance: "deterministic-backend",
      runState: "ONLINE",
    });
    vi.spyOn(client.glimmerApi, "stopModelServer").mockResolvedValue({
      stopped: false,
      detail: "something is still listening on the model port (ONLINE)",
      status: "ONLINE",
      endpoint: "http://127.0.0.1:8080",
      provenance: "deterministic-backend",
      runState: "ONLINE",
    });
    render(withQuery(<ModelStatusScreen />));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop server" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Stop server" }));
    await waitFor(() =>
      expect(
        screen.getByText(/Nothing was stopped: something is still listening/),
      ).toBeInTheDocument(),
    );
  });

  it("reports an already-running server as a no-op rather than a successful start", async () => {
    vi.spyOn(client.glimmerApi, "getModelStatus").mockResolvedValue({
      status: "OFFLINE",
      endpoint: "http://127.0.0.1:8080",
      provenance: "deterministic-backend",
      runState: "OFFLINE",
    });
    vi.spyOn(client.glimmerApi, "startModelServer").mockResolvedValue({
      started: false,
      status: "ONLINE",
      endpoint: "http://127.0.0.1:8080",
      provenance: "deterministic-backend",
      runState: "ONLINE",
    });
    render(withQuery(<ModelStatusScreen />));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start server" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Start server" }));
    await waitFor(() =>
      expect(screen.getByText(/No change: the server was already ONLINE/)).toBeInTheDocument(),
    );
  });
});
