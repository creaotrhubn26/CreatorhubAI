import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ModelRunState } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { StatusBadge } from "../common/StatusBadge";
import { ComputeStatusPanel } from "./ComputeStatusPanel";

// What each intermediate state actually means, so the screen never implies
// more than the gateway can prove. ONLINE comes from a 200 on /health and
// nothing else — spawning a process is not evidence the model is up.
const RUN_STATE_NOTE: Record<ModelRunState, string> = {
  OFFLINE: "Not running.",
  STARTING: "Start script launched — the port isn't accepting connections yet.",
  LOADING:
    "Port is up, /health hasn't returned 200 yet — the model is loading (1–2 min). It keeps running after you quit the app; press Stop to free the memory (~20 GB).",
  ONLINE:
    "/health returned 200. It keeps running after you quit the app; press Stop to free the memory (~20 GB).",
  FAILED: "The process we started exited before the server came up.",
};

const TRANSITIONAL = new Set<ModelRunState>(["STARTING", "LOADING"]);

export function ModelStatusScreen() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["model-status"],
    queryFn: glimmerApi.getModelStatus,
    // Poll harder while something is actually happening — a start takes
    // 1–2 minutes and the state moves STARTING -> LOADING -> ONLINE on its own.
    refetchInterval: (query) =>
      TRANSITIONAL.has((query.state.data?.runState ?? "OFFLINE") as ModelRunState) ? 2000 : 5000,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["model-status"] });
  const startMutation = useMutation({
    mutationFn: glimmerApi.startModelServer,
    onSuccess: invalidate,
  });
  const stopMutation = useMutation({
    mutationFn: glimmerApi.stopModelServer,
    onSuccess: invalidate,
  });

  if (!data) return <div>Unavailable</div>;

  const runState = data.runState ?? "OFFLINE";
  const pending = startMutation.isPending || stopMutation.isPending;
  // A 409/no-op comes back as a normal result with started/stopped false —
  // show what the gateway said rather than a success the user didn't get.
  const lastResult = startMutation.data ?? stopMutation.data;
  const noOp =
    (startMutation.data && startMutation.data.started === false) ||
    (stopMutation.data && stopMutation.data.stopped === false);
  const failure = startMutation.error ?? stopMutation.error;

  return (
    <div>
      <h1>Muse Glimmer</h1>
      <StatusBadge status={data.status} />
      <section>
        <h2>Local model server</h2>
        <StatusBadge status={runState} />
        <p>{RUN_STATE_NOTE[runState as ModelRunState]}</p>
        <button
          className="btn-primary"
          onClick={() => startMutation.mutate()}
          disabled={pending || (runState !== "OFFLINE" && runState !== "FAILED")}
        >
          Start server
        </button>
        <button onClick={() => stopMutation.mutate()} disabled={pending || runState === "OFFLINE"}>
          Stop server
        </button>
        <p>
          Stop targets whatever holds the model port — including a llama-server you started in a
          terminal.
        </p>
        {failure && <p className="error">{String(failure)}</p>}
        {/* A stop that didn't stop anything says why. Never a silent click. */}
        {lastResult?.detail && <p className="error">Nothing was stopped: {lastResult.detail}.</p>}
        {noOp && lastResult && !lastResult.detail && (
          <p>No change: the server was already {lastResult.runState ?? "Unavailable"}.</p>
        )}
        {lastResult?.error && <p className="error">{lastResult.error}</p>}
        {runState === "FAILED" && (
          <>
            <p>Exit code: {data.exitCode ?? "Unavailable"}</p>
            <pre className="mono">{data.logTail ?? "Unavailable"}</pre>
          </>
        )}
      </section>
      <dl>
        <dt>Endpoint</dt>
        <dd className="mono">{data.endpoint}</dd>
        <dt>Context</dt>
        <dd>{data.contextSize ?? "Unavailable"}</dd>
        <dt>Model path</dt>
        <dd className="mono">{data.modelPath ?? "Unavailable"}</dd>
        <dt>Speculative decoding</dt>
        <dd>
          {data.speculativeDecoding === undefined
            ? "Unavailable"
            : data.speculativeDecoding
              ? "Enabled"
              : "Disabled"}
        </dd>
        <dt>Draft model</dt>
        <dd>Unavailable</dd>
        <dt>Prompt tokens</dt>
        <dd>Unavailable</dd>
        <dt>Tokens/sec</dt>
        <dd>Unavailable</dd>
      </dl>
      <ComputeStatusPanel />
    </div>
  );
}
