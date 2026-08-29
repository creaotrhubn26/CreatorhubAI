import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ComputeRunState } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { StatusBadge } from "../common/StatusBadge";

const ACTIVE_STATES = new Set<ComputeRunState>([
  "provisioning",
  "bootstrapping",
  "ready",
  "busy",
  "idle",
  "stopping",
  "terminating",
  "budget_blocked",
]);

function money(value: number | undefined): string {
  return value === undefined ? "Unavailable" : `$${value.toFixed(4)}`;
}

export function ComputeStatusPanel() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["compute-status"],
    queryFn: glimmerApi.getComputeStatus,
    refetchInterval: 5_000,
    retry: false,
  });
  const usage = useQuery({
    queryKey: ["compute-usage"],
    queryFn: glimmerApi.getComputeUsage,
    refetchInterval: 30_000,
    retry: false,
  });
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["compute-status"] }),
      queryClient.invalidateQueries({ queryKey: ["compute-usage"] }),
    ]);
  };
  const start = useMutation({ mutationFn: glimmerApi.startCompute, onSuccess: invalidate });
  const stop = useMutation({ mutationFn: glimmerApi.stopCompute, onSuccess: invalidate });
  const reconcileUsage = useMutation({
    mutationFn: glimmerApi.reconcileComputeUsage,
    onSuccess: (summary) => queryClient.setQueryData(["compute-usage"], summary),
  });

  if (status.isPending) return <p>Loading external compute status…</p>;
  if (status.error || !status.data) {
    return <p role="alert">External compute unavailable — {String(status.error ?? "unknown")}</p>;
  }

  const data = status.data;
  const pending = start.isPending || stop.isPending;
  const active =
    ACTIVE_STATES.has(data.state) ||
    data.state === "failed" ||
    (!!data.pod && data.state !== "stopped" && data.state !== "offline");
  const failure = start.error ?? stop.error;

  return (
    <section aria-labelledby="external-compute-heading">
      <h2 id="external-compute-heading">External compute</h2>
      <StatusBadge status={data.state} />
      <p>{data.detail}</p>
      <dl>
        <dt>Backend</dt>
        <dd>{data.backend === "runpod_pod" ? "RunPod Pod" : "Local process"}</dd>
        <dt>Profile</dt>
        <dd>{data.profileId ?? "Unavailable"}</dd>
        <dt>Pod</dt>
        <dd className="mono">{data.pod?.id ?? "None"}</dd>
        <dt>GPU</dt>
        <dd>{data.pod?.gpuTypeId ?? "Unavailable"}</dd>
        <dt>Worker</dt>
        <dd>
          {data.worker
            ? data.worker.ready
              ? "Authenticated and ready"
              : data.worker.workerState
            : "Unavailable"}
        </dd>
        <dt>Worker build</dt>
        <dd className="mono">{data.worker?.buildId ?? "Unavailable"}</dd>
        <dt>Model context</dt>
        <dd>
          {data.worker
            ? `${data.worker.model.contextTokens.toLocaleString()} tokens`
            : "Unavailable"}
        </dd>
        <dt>Current rate</dt>
        <dd>{money(data.budget?.currentHourlyUsd)}</dd>
        <dt>Hourly ceiling</dt>
        <dd>{money(data.budget?.hourlyCeilingUsd)}</dd>
        <dt>Estimated today</dt>
        <dd>{money(usage.data?.estimatedTodayUsd)}</dd>
        <dt>Provider-reconciled today</dt>
        <dd>{money(usage.data?.reconciledTodayUsd)}</dd>
      </dl>
      {data.idleDeadlineAt && <p>Idle cleanup deadline: {data.idleDeadlineAt}</p>}
      {data.hardDeadlineAt && <p>Hard deadline: {data.hardDeadlineAt}</p>}
      {data.pod?.desiredStatus === "RUNNING" && !data.worker?.ready && (
        <p role="alert">
          Provider capacity is allocated, but authenticated worker readiness is not proven.
        </p>
      )}
      {!data.policy.watchdogConfigured && (
        <p role="note">
          Independent watchdog unavailable. Keep the Control Center running and do not leave paid
          compute unattended.
        </p>
      )}
      <button
        type="button"
        className="btn-primary"
        onClick={() => start.mutate()}
        disabled={
          pending || active || data.backend !== "runpod_pod" || !data.policy.watchdogConfigured
        }
      >
        Start external compute
      </button>
      <button type="button" onClick={() => stop.mutate()} disabled={pending || !active}>
        Terminate external compute
      </button>
      <button
        type="button"
        onClick={() => reconcileUsage.mutate()}
        disabled={reconcileUsage.isPending}
      >
        {reconcileUsage.isPending ? "Reconciling…" : "Reconcile provider billing"}
      </button>
      <p>
        The RunPod profile uses a network volume, so cleanup terminates the Pod while preserving the
        separate model/cache volume.
      </p>
      {failure && <p role="alert">Compute operation failed — {(failure as Error).message}</p>}
      {reconcileUsage.error && (
        <p role="alert">
          Billing reconciliation failed — {(reconcileUsage.error as Error).message}
        </p>
      )}
      {data.budget && !data.budget.allowed && (
        <p role="alert">Budget blocked: {data.budget.reason ?? "configured limit reached"}</p>
      )}
    </section>
  );
}
