import type { GlimmerSession } from "@glimmer/shared";

type Gates = NonNullable<GlimmerSession["gates"]>;

// V7 §5.11: the five final-acceptance gates, in the spec's own order, plus
// Task 4.2's tasksResolved (fix round 1, MODERATE 6) -- same missing-key-is-
// honest-"—" convention as the other five.
// tasksResolvedBy is a string annotation on tasksResolved, not a gate value
// of its own -- excluded here so gates[key] below stays boolean|null|
// undefined (gateColor/gateSymbol's actual domain) instead of widening to
// include "human".
type ValueGateKey = Exclude<keyof Gates, "tasksResolvedBy">;

const GATE_LABELS: Array<[ValueGateKey, string]> = [
  ["implementationComplete", "Implementation"],
  ["architectureApproved", "Architecture"],
  ["verificationPassed", "Verification"],
  ["scopeApproved", "Scope"],
  ["documentationCurrent", "Docs"],
  ["tasksResolved", "Tasks"],
  // Task 8.1 (V7 §23.10): "would I send this to a customer?" quality gate.
  ["customerReadinessApproved", "Delivery"],
];

function gateSymbol(value: boolean | null | undefined): string {
  if (value === true) return "✓";
  if (value === false) return "✗";
  return "—"; // null/undefined: not-applicable or never-ran, not a failure
}

function gateColor(value: boolean | null | undefined): string {
  if (value === true) return "var(--green)";
  if (value === false) return "var(--red)";
  return "var(--gray)";
}

// Compact one-line summary of manifest["gates"] (orchestrator-recorded
// fact, never model output) — one chip per gate, always all 5 so a
// missing key on an older/no-plan session reads honestly as "—" rather
// than being silently omitted.
// Review round 1 (Important 1): tasksResolved==true off a human skip/
// approve override (not orchestrator evidence) must read visibly
// differently from a plain evidence-derived ✓ -- see gates.tasksResolvedBy
// (glimmer-v2.py's any_task_resolved_by_human_override).
function gateSuffix(key: ValueGateKey, gates: Gates): string {
  return key === "tasksResolved" && gates.tasksResolvedBy === "human" ? " (human)" : "";
}

export function GatesRow({ gates }: { gates?: Gates }) {
  if (!gates) return null;
  return (
    <div
      className="gates-row"
      style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, margin: "8px 0" }}
    >
      {GATE_LABELS.map(([key, label]) => (
        <span
          key={key}
          className="meta-value"
          style={{ ["--badge-color" as any]: gateColor(gates[key]) }}
        >
          {label} {gateSymbol(gates[key])}
          {gateSuffix(key, gates)}
        </span>
      ))}
    </div>
  );
}
