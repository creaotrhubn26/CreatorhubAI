import type { VerificationCheckResult } from "@glimmer/shared";

export function computeVerificationBadge(
  check: VerificationCheckResult
): { label: string; tone: "pass" | "fail" | "baseline-ok" } {
  if (check.newErrorSignatures.length > 0) return { label: "NEW FAILURE", tone: "fail" };
  if (check.status === "PASS_BASELINE") return { label: "PASS (baseline)", tone: "baseline-ok" };
  if (check.ok) return { label: "PASS", tone: "pass" };
  return { label: "FAIL", tone: "fail" };
}
