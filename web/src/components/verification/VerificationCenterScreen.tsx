import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { FinalStatus, VerificationCheckResult, VerificationSummary } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { computeVerificationBadge } from "../../state/computeVerificationBadge";
import { StatusBadge, statusColor } from "../common/StatusBadge";
import { EmptyState } from "../common/EmptyState";

const TONE_COLOR: Record<ReturnType<typeof computeVerificationBadge>["tone"], string> = {
  pass: "var(--green)",
  fail: "var(--red)",
  "baseline-ok": "var(--amber)",
  "not-run": "var(--gray)",
};

function CheckCard({ check }: { check: VerificationCheckResult }) {
  const badge = computeVerificationBadge(check);
  const color = TONE_COLOR[badge.tone];
  return (
    <fieldset>
      <legend className="mono">{check.command}</legend>
      <span className="badge-check" style={{ ["--badge-color" as any]: color }}>
        {badge.label}
      </span>
      <dl>
        <dt>Return code</dt>
        <dd className="mono">{check.returncode}</dd>
        <dt>Elapsed</dt>
        <dd className="mono">{check.elapsedSeconds}s</dd>
      </dl>
      {check.outputTail && (
        <details>
          <summary>Output</summary>
          <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>
            {check.outputTail}
          </pre>
        </details>
      )}
    </fieldset>
  );
}

// Session-scoped baseline story: how many checks were accepted because their
// failures pre-date this session (status PASS_BASELINE), and how many NEW
// error signatures Glimmer itself introduced (sum across all checks). Only
// rendered once checks actually ran — an empty check list (NOT_RUN) must
// never be read as "ran clean".
function BaselineSummary({ checks }: { checks: VerificationCheckResult[] }) {
  if (checks.length === 0) return null;
  const baselineAcceptedCount = checks.filter((c) => c.status === "PASS_BASELINE").length;
  const newFailureTotal = checks.reduce((sum, c) => sum + c.newErrorSignatures.length, 0);
  return (
    <p className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>
      {baselineAcceptedCount} pre-existing failure{baselineAcceptedCount === 1 ? "" : "s"} accepted
      via baseline —{" "}
      {newFailureTotal === 0
        ? "No new failures introduced"
        : `${newFailureTotal} NEW failure${newFailureTotal === 1 ? "" : "s"} introduced`}
    </p>
  );
}

// V7 §18: recommended checks run but never gate VERIFIED -- kept visually
// distinct (muted, its own labeled section) so nobody reads a recommended
// failure as something that blocked promotion.
function RecommendedSection({ checks }: { checks: VerificationCheckResult[] | undefined }) {
  if (!checks || checks.length === 0) return null;
  return (
    <div style={{ marginTop: 24, opacity: 0.7 }}>
      <p className="mono" style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
        Recommended (non-gating)
      </p>
      {checks.map((c) => (
        <CheckCard key={c.command} check={c} />
      ))}
    </div>
  );
}

const FINAL_STATUS_LABELS: Array<[keyof FinalStatus, string]> = [
  ["functional", "Functional"],
  ["visual", "Visual"],
  ["architecture", "Architecture"],
  ["documentation", "Documentation"],
];

// architecture/documentation use the approved/rejected/not_run gate
// vocabulary (not a StatusBadge-known status string), so they get their own
// small color mapping; functional/visual reuse statusColor's existing
// VerificationOverall / visual-status entries directly, one color system.
function finalStatusColor(field: keyof FinalStatus, value: string): string {
  if (field === "architecture" || field === "documentation") {
    if (value === "approved") return "var(--green)";
    if (value === "rejected") return "var(--red)";
    return "var(--gray)";
  }
  return statusColor(value);
}

// V7 §22.17: compact 4-cell gate summary, always present on a real session
// (readSession composes it deterministically) -- same one-chip-per-field
// pattern as GatesRow.
function FinalStatusRow({ finalStatus }: { finalStatus: FinalStatus }) {
  return (
    <div
      className="gates-row"
      style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, margin: "0 0 16px" }}
    >
      {FINAL_STATUS_LABELS.map(([key, label]) => (
        <span
          key={key}
          className="meta-value"
          style={{ ["--badge-color" as any]: finalStatusColor(key, finalStatus[key]) }}
        >
          {label}: {finalStatus[key]}
        </span>
      ))}
    </div>
  );
}

// Exported so the IDE shell's bottom-panel VERIFICATION tab can re-home this
// exact body (session-scoped) without re-implementing the check rendering.
export function VerificationBody({
  verification,
  finalStatus,
}: {
  verification: VerificationSummary | null | undefined;
  finalStatus?: FinalStatus;
}) {
  if (!verification) return <EmptyState icon="◌" text="Unavailable" />;
  const checks = verification.checks;
  return (
    <div>
      {finalStatus && <FinalStatusRow finalStatus={finalStatus} />}
      <div style={{ marginBottom: 16 }}>
        <StatusBadge status={verification.overall} />
      </div>
      <BaselineSummary checks={checks} />
      {checks.length === 0 && <EmptyState icon="◌" text="Unavailable" />}
      {checks.map((c) => (
        <CheckCard key={c.command} check={c} />
      ))}
      <RecommendedSection checks={verification.recommendedChecks} />
    </div>
  );
}

export function VerificationCenterScreen() {
  const { id } = useParams<{ id?: string }>();

  // No :id -> sidebar link's existing behavior: latest global session, via
  // /api/status. With :id -> this specific session's own verification
  // summary, already carried on GlimmerSession — no dedicated endpoint needed.
  const statusQuery = useQuery({
    queryKey: ["status"],
    queryFn: glimmerApi.getStatus,
    enabled: !id,
  });
  const sessionQuery = useQuery({
    queryKey: ["session", id, "verification"],
    queryFn: () => glimmerApi.getSession(id!),
    enabled: !!id,
  });

  const verification = id ? sessionQuery.data?.verification : statusQuery.data?.verification;
  // finalStatus only exists on a real GlimmerSession (composed by
  // readSession) -- DashboardStatus's own embedded verification summary (no
  // :id) has no session to compose one from.
  const finalStatus = id ? sessionQuery.data?.finalStatus : undefined;

  return (
    <div>
      <h1>Verification</h1>
      <VerificationBody verification={verification} finalStatus={finalStatus} />
    </div>
  );
}
