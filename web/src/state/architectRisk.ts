import type { TaskContract } from "@glimmer/shared";

// Task 2.1 fix round 1 (V7 §5.5): composer-side PREVIEW of the
// orchestrator's deterministic risk score. KEEP IN SYNC WITH
// glimmer-v2.py's compute_architect_risk -- same signal names, points,
// and threshold. This is not the source of truth: glimmer-v2.py
// recomputes the real score server-side from the real contract at run
// time, so a drift between the two implementations would only ever show
// a wrong/stale preview line here, never change what actually triggers
// architect mode. Accepted dual-implementation risk -- if the Python
// table changes, this file must be updated to match by hand.
export const ARCHITECT_RISK_THRESHOLD = 5;
const ARCHITECT_RISK_CANDIDATE_THRESHOLD = 5;

// Mirrors glimmer-v2.py's _PROTECTED_AREA_WORDS exactly.
const PROTECTED_AREA_WORDS = new Set([
  "auth",
  "authentication",
  "payment",
  "payments",
  "migration",
  "migrations",
  "schema",
  "security",
]);

// Mirrors glimmer-v2.py's _segment_tokens: split on any run of
// non-alphanumeric characters, case-insensitive, exact-token match (not
// substring -- "author" does not match "auth").
function segmentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// The exact derivation server/src/lib/runner.ts's buildArgs uses for
// --verification-level. Exported so the composer's task-intelligence request
// (Task 4c(a)) sends the same value the orchestrator will actually run with,
// rather than a second guess at it.
export function deriveVerificationLevel(contract: TaskContract): string {
  return contract.verification.length === 0 ? "minimal" : "standard";
}

export interface ArchitectRisk {
  score: number;
  signals: string[];
}

export function computeArchitectRisk(contract: TaskContract): ArchitectRisk {
  let score = 0;
  const signals: string[] = [];

  if (contract.mode === "refactor") {
    score += 3;
    signals.push("mode_refactor");
  }

  if (contract.scope.package === "repository") {
    score += 2;
    signals.push("multi_package_scope");
  }

  // Same proxy glimmer-v2.py's main() uses at trigger-decision time: no
  // ArchitecturePlan.candidateFiles exists yet, so scope.paths.length is
  // the only pre-architect signal available.
  const candidateCount = contract.scope.paths?.length ?? 0;
  if (candidateCount > ARCHITECT_RISK_CANDIDATE_THRESHOLD) {
    score += 2;
    signals.push("candidate_count_high");
  }

  const objectiveTokens = segmentTokens(contract.objective ?? "");
  if (objectiveTokens.some((token) => PROTECTED_AREA_WORDS.has(token))) {
    score += 3;
    signals.push("protected_area_keyword");
  }

  // Same derivation server/src/lib/runner.ts's buildArgs uses for
  // --verification-level ("full" is never actually produced by today's
  // composer/runner path -- only "minimal"/"standard" -- so this signal
  // is honest dead code here, exactly mirroring the orchestrator's own
  // current behavior, not a bug).
  // Typed as `string`, not the narrower "minimal"|"standard" TS would
  // otherwise infer, so the "full" comparison below stays a real (if
  // currently unreachable) branch instead of a TS2367 compile error --
  // "full" is a legitimate value of this same field on the Python side,
  // just not one today's composer/runner derivation ever produces.
  const verificationLevel: string = deriveVerificationLevel(contract);
  if (verificationLevel === "full") {
    score += 2;
    signals.push("verification_full");
  }

  return { score, signals };
}
