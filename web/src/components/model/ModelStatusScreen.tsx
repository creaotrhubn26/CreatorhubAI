import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { StatusBadge } from "../common/StatusBadge";

export function ModelStatusScreen() {
  const { data } = useQuery({ queryKey: ["model-status"], queryFn: glimmerApi.getModelStatus, refetchInterval: 5000 });

  if (!data) return <div>Unavailable</div>;

  return (
    <div>
      <h1>Muse Glimmer</h1>
      <StatusBadge status={data.status} />
      <dl>
        <dt>Endpoint</dt>
        <dd className="mono">{data.endpoint}</dd>
        <dt>Context</dt>
        <dd>{data.contextSize ?? "Unavailable"}</dd>
        <dt>Model path</dt>
        <dd className="mono">{data.modelPath ?? "Unavailable"}</dd>
        <dt>Speculative decoding</dt>
        <dd>{data.speculativeDecoding === undefined ? "Unavailable" : data.speculativeDecoding ? "Enabled" : "Disabled"}</dd>
        <dt>Draft model</dt>
        <dd>Unavailable</dd>
        <dt>Prompt tokens</dt>
        <dd>Unavailable</dd>
        <dt>Tokens/sec</dt>
        <dd>Unavailable</dd>
      </dl>
    </div>
  );
}
