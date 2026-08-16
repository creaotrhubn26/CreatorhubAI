import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { computeVerificationBadge } from "../../state/computeVerificationBadge";

export function VerificationCenterScreen() {
  const { data } = useQuery({ queryKey: ["status"], queryFn: glimmerApi.getStatus });
  const checks = data?.verification?.checks ?? [];

  return (
    <div>
      <h1>Verification</h1>
      {checks.length === 0 && <div>Unavailable</div>}
      {checks.map((c) => {
        const badge = computeVerificationBadge(c);
        return (
          <div key={c.command}>
            <span className="mono">{c.command}</span> — {badge.label}
          </div>
        );
      })}
    </div>
  );
}
