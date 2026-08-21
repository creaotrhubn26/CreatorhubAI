import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { VerificationCheckResult, VerificationSummary } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { computeVerificationBadge } from "../../state/computeVerificationBadge";
import { StatusBadge } from "../common/StatusBadge";
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
          <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{check.outputTail}</pre>
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
      {baselineAcceptedCount} pre-existing failure{baselineAcceptedCount === 1 ? "" : "s"} accepted via baseline —{" "}
      {newFailureTotal === 0
        ? "No new failures introduced"
        : `${newFailureTotal} NEW failure${newFailureTotal === 1 ? "" : "s"} introduced`}
    </p>
  );
}

// Exported so the IDE shell's bottom-panel VERIFICATION tab can re-home this
// exact body (session-scoped) without re-implementing the check rendering.
export function VerificationBody({ verification }: { verification: VerificationSummary | null | undefined }) {
  if (!verification) return <EmptyState icon="◌" text="Unavailable" />;
  const checks = verification.checks;
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <StatusBadge status={verification.overall} />
      </div>
      <BaselineSummary checks={checks} />
      {checks.length === 0 && <EmptyState icon="◌" text="Unavailable" />}
      {checks.map((c) => (
        <CheckCard key={c.command} check={c} />
      ))}
    </div>
  );
}

export function VerificationCenterScreen() {
  const { id } = useParams<{ id?: string }>();

  // No :id -> sidebar link's existing behavior: latest global session, via
  // /api/status. With :id -> this specific session's own verification
  // summary, already carried on GlimmerSession — no dedicated endpoint needed.
  const statusQuery = useQuery({ queryKey: ["status"], queryFn: glimmerApi.getStatus, enabled: !id });
  const sessionQuery = useQuery({
    queryKey: ["session", id, "verification"],
    queryFn: () => glimmerApi.getSession(id!),
    enabled: !!id,
  });

  const verification = id ? sessionQuery.data?.verification : statusQuery.data?.verification;

  return (
    <div>
      <h1>Verification</h1>
      <VerificationBody verification={verification} />
    </div>
  );
}
