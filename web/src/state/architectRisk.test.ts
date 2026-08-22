import { describe, it, expect } from "vitest";
import { computeArchitectRisk, ARCHITECT_RISK_THRESHOLD } from "./architectRisk";
import type { TaskContract } from "@glimmer/shared";

// Mirrors glimmer-v2.py's --architect-risk-selfcheck cases exactly, ported
// to the TS mirror of compute_architect_risk. Keep this file's cases in
// sync with that selfcheck the same way architectRisk.ts is kept in sync
// with compute_architect_risk itself.
const BASE: TaskContract = {
  objective: "add a dashboard widget",
  scope: { package: "frontend" },
  mode: "implement",
  constraints: { minimalChange: true, noCommit: true, noPush: true, noDeploy: true, noDependencyInstall: true },
  verification: [],
  repairBudget: 2,
};

describe("computeArchitectRisk", () => {
  it("scores 0 with no signals", () => {
    expect(computeArchitectRisk(BASE)).toEqual({ score: 0, signals: [] });
  });

  it("mode_refactor signal", () => {
    expect(computeArchitectRisk({ ...BASE, mode: "refactor" })).toEqual({
      score: 3,
      signals: ["mode_refactor"],
    });
  });

  it("multi_package_scope signal", () => {
    expect(computeArchitectRisk({ ...BASE, scope: { package: "repository" } })).toEqual({
      score: 2,
      signals: ["multi_package_scope"],
    });
  });

  it("candidate_count_high signal (scope.paths.length > 5)", () => {
    const paths = Array.from({ length: 6 }, (_, i) => `file${i}.ts`);
    expect(computeArchitectRisk({ ...BASE, scope: { package: "frontend", paths } })).toEqual({
      score: 2,
      signals: ["candidate_count_high"],
    });
  });

  it("candidate_count_high does not fire exactly at the threshold (strictly greater-than)", () => {
    const paths = Array.from({ length: 5 }, (_, i) => `file${i}.ts`);
    expect(computeArchitectRisk({ ...BASE, scope: { package: "frontend", paths } })).toEqual({
      score: 0,
      signals: [],
    });
  });

  it("protected_area_keyword signal", () => {
    expect(computeArchitectRisk({ ...BASE, objective: "migrate the auth schema" })).toEqual({
      score: 3,
      signals: ["protected_area_keyword"],
    });
  });

  it("protected_area_keyword is exact-token, not substring (author must not match auth)", () => {
    expect(computeArchitectRisk({ ...BASE, objective: "credit the author of this module" })).toEqual({
      score: 0,
      signals: [],
    });
  });

  it("verification_full never fires today (composer/runner only ever derive minimal/standard)", () => {
    // Documents the honest current ceiling: there is no UI/contract path
    // that produces "full" verification level yet (mirrors runner.ts's
    // buildArgs derivation) -- any non-empty verification list still only
    // derives "standard", never "full".
    expect(computeArchitectRisk({ ...BASE, verification: ["frontend-typecheck"] })).toEqual({
      score: 0,
      signals: [],
    });
  });

  it("combination crossing the threshold: mode_refactor + multi_package_scope == 5", () => {
    const result = computeArchitectRisk({
      ...BASE,
      mode: "refactor",
      scope: { package: "repository" },
    });
    expect(result.score).toBe(5);
    expect(result.score).toBeGreaterThanOrEqual(ARCHITECT_RISK_THRESHOLD);
    expect(result.signals).toEqual(["mode_refactor", "multi_package_scope"]);
  });

  it("any single signal alone stays below the threshold", () => {
    expect(computeArchitectRisk({ ...BASE, mode: "refactor" }).score).toBeLessThan(ARCHITECT_RISK_THRESHOLD);
    expect(computeArchitectRisk({ ...BASE, objective: "migrate the payment schema" }).score).toBeLessThan(
      ARCHITECT_RISK_THRESHOLD
    );
  });

  it("stacks every reachable signal additively, in table order", () => {
    const paths = Array.from({ length: 6 }, (_, i) => `file${i}.ts`);
    const result = computeArchitectRisk({
      ...BASE,
      objective: "migrate the payment schema",
      scope: { package: "repository", paths },
      mode: "refactor",
    });
    expect(result).toEqual({
      score: 10,
      signals: ["mode_refactor", "multi_package_scope", "candidate_count_high", "protected_area_keyword"],
    });
  });
});
