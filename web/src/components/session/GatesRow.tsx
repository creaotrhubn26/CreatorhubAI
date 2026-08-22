import type { GlimmerSession } from "@glimmer/shared";

type Gates = NonNullable<GlimmerSession["gates"]>;

// V7 §5.11: the five final-acceptance gates, in the spec's own order.
const GATE_LABELS: Array<[keyof Gates, string]> = [
  ["implementationComplete", "Implementation"],
  ["architectureApproved", "Architecture"],
  ["verificationPassed", "Verification"],
  ["scopeApproved", "Scope"],
  ["documentationCurrent", "Docs"],
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
export function GatesRow({ gates }: { gates?: Gates }) {
  if (!gates) return null;
  return (
    <div className="gates-row" style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, margin: "8px 0" }}>
      {GATE_LABELS.map(([key, label]) => (
        <span key={key} className="meta-value" style={{ ["--badge-color" as any]: gateColor(gates[key]) }}>
          {label} {gateSymbol(gates[key])}
        </span>
      ))}
    </div>
  );
}
