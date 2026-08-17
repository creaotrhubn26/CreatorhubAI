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
        <dt>Prompt tokens</dt>
        <dd>Unavailable</dd>
        <dt>Tokens/sec</dt>
        <dd>Unavailable</dd>
      </dl>
    </div>
  );
}
