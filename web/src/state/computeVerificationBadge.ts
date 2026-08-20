import type { VerificationCheckResult } from "@glimmer/shared";

export function computeVerificationBadge(
  check: VerificationCheckResult
): { label: string; tone: "pass" | "fail" | "baseline-ok" | "not-run" } {
  // A check that never ran is neither a pass nor a failure — must never fall
  // through to the ok:false -> FAIL branch below, or "didn't run" reads as
  // "ran and failed".
  if (check.status === "NOT_RUN") return { label: "NOT RUN", tone: "not-run" };
  if (check.newErrorSignatures.length > 0) return { label: "NEW FAILURE", tone: "fail" };
  if (check.status === "PASS_BASELINE") return { label: "PASS (baseline)", tone: "baseline-ok" };
  if (check.ok) return { label: "PASS", tone: "pass" };
  return { label: "FAIL", tone: "fail" };
}
