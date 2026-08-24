import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import type { TaskIntelligence } from "@glimmer/shared";

// Task 4c(a): the objective is a free-text field the user types into; sending
// every keystroke would hammer the endpoint, so it lags the input by this
// much. Every other input (mode/scope/verification/workspace) changes at most
// once per click and is passed straight through.
const OBJECTIVE_DEBOUNCE_MS = 400;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

// Task 4c(c): a null field has three genuinely different meanings, and
// rendering all three as "Unavailable" made a working panel read as broken.
//   * repository-wide scope has no single area/package by definition — the
//     backend's inferArea returns null on purpose (not applicable)
//   * no repo map for this workspace yet — nothing is known (unknown)
//   * a map exists and simply matched nothing — unknown too, but not because
//     the data is missing
const NOT_APPLICABLE = "Not applicable — repository-wide scope";
const NO_REPO_MAP = "No repository map for this workspace yet";

function honestField(
  value: string | null,
  data: TaskIntelligence,
  scopePackage: string
): { text: string; state: "value" | "not-applicable" | "unknown" } {
  if (value) return { text: value, state: "value" };
  if (scopePackage === "repository") return { text: NOT_APPLICABLE, state: "not-applicable" };
  if (data.repoMapStatus === "unmatched-workspace" || data.repoMapStatus === "none") {
    return { text: NO_REPO_MAP, state: "unknown" };
  }
  return { text: "Unavailable", state: "unknown" };
}

// One line naming WHICH repository map the fields above came from — the panel
// claims to be "repository-derived", so it has to be able to say which
// repository, and to admit when the answer is "none yet".
const REPO_MAP_BASIS: Record<TaskIntelligence["repoMapStatus"], string> = {
  "workspace-matched": "Repository map: from a previous session in this workspace.",
  "unmatched-workspace": "No session has produced a repository map for this workspace yet.",
  "first-found": "Repository map: first one found across all sessions — choose a workspace above to scope it to your repository.",
  none: "No repository map exists in any session yet.",
};

export function TaskIntelligencePanel({
  scopePackage,
  scopeArea,
  workspace,
  mode,
  objective,
  verificationLevel,
  candidateCount,
}: {
  scopePackage: string;
  scopeArea?: string;
  workspace?: string;
  mode?: string;
  objective?: string;
  verificationLevel?: string;
  candidateCount?: number;
}) {
  const debouncedObjective = useDebounced(objective ?? "", OBJECTIVE_DEBOUNCE_MS);
  const { data } = useQuery({
    queryKey: [
      "task-intelligence", scopePackage, scopeArea, workspace, mode, debouncedObjective, verificationLevel, candidateCount,
    ],
    queryFn: () =>
      glimmerApi.getTaskIntelligence({
        scopePackage,
        scopeArea,
        workspace,
        mode,
        objective: debouncedObjective || undefined,
        verificationLevel,
        candidateCount,
      }),
  });

  if (!data) return null;

  const area = honestField(data.likelyArea, data, scopePackage);
  const pkg = honestField(data.likelyPackage, data, scopePackage);
  const verification = honestField(
    data.suggestedVerification.length ? data.suggestedVerification.join(", ") : null,
    data,
    scopePackage
  );

  return (
    <fieldset>
      <legend>Task Intelligence</legend>
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Deterministic — repository-derived, not a model guess ({data.provenance})
      </p>
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>{REPO_MAP_BASIS[data.repoMapStatus]}</p>
      <dl>
        <dt>Likely area</dt>
        <dd data-state={area.state}>{area.text}</dd>
        <dt>Likely package</dt>
        <dd data-state={pkg.state}>{pkg.text}</dd>
        <dt>Suggested verification</dt>
        <dd data-state={verification.state}>{verification.text}</dd>
        <dt>Estimated risk</dt>
        {/* Risk is scored from mode/objective/verification/candidate-count
            hints only — it needs no repo map, so it stays a plain value or an
            honest "Unavailable" when the caller sent no hints at all. */}
        <dd>{data.estimatedRisk ?? "Unavailable"}</dd>
      </dl>
    </fieldset>
  );
}
