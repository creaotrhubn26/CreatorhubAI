import type { GlimmerSession } from "@glimmer/shared";
import { statusColor } from "../common/StatusBadge";
import { READINESS_COLOR } from "./DeliveryReviewPanel";

type Statuses = NonNullable<GlimmerSession["statuses"]>;

// Task 8.1 (V7 §23.11): one chip per combined-status leg, in the spec's own
// order. Reuses existing color vocabularies rather than inventing a new one
// (ladder: reuse before inventing) -- statusColor already maps VERIFIED/
// FAILED/NOT_RUN/PASS/FAIL/BLOCKED/PASS_WITH_WARNINGS (technical/visual);
// READINESS_COLOR already maps the 5-level customerReadiness vocabulary
// (delivery/overall). architecture/documentation's approved/rejected/not_run
// falls back to statusColor's default gray for "not_run" and gets two new
// entries (below) for approved/rejected.
const STATUS_LABELS: Array<[keyof Statuses, string]> = [
  ["technical", "Technical"],
  ["architecture", "Architecture"],
  ["documentation", "Docs"],
  ["visual", "Visual"],
  ["delivery", "Delivery"],
  ["overall", "Overall"],
];

const GATE_LEG_COLOR: Record<string, string> = {
  approved: "var(--green)",
  rejected: "var(--red)",
};

function statusLegColor(key: keyof Statuses, value: string): string {
  if (key === "delivery" || key === "overall")
    return READINESS_COLOR[value as never] ?? "var(--gray)";
  if (key === "architecture" || key === "documentation")
    return GATE_LEG_COLOR[value] ?? "var(--gray)";
  return statusColor(value);
}

// Compact one-line summary of manifest["statuses"] (orchestrator-recorded
// self-report, V7 §23.11) -- absent entirely on sessions predating this
// task, same optional-field convention as GatesRow.
export function StatusesRow({ statuses }: { statuses?: Statuses }) {
  if (!statuses) return null;
  return (
    <div
      className="statuses-row"
      style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, margin: "8px 0" }}
    >
      {STATUS_LABELS.map(([key, label]) => (
        <span
          key={key}
          className="meta-value"
          style={{ ["--badge-color" as any]: statusLegColor(key, statuses[key]) }}
        >
          {label} {statuses[key]}
        </span>
      ))}
    </div>
  );
}
