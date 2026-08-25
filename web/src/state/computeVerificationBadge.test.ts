import { describe, it, expect } from "vitest";
import { computeVerificationBadge } from "./computeVerificationBadge";

describe("computeVerificationBadge", () => {
  it("labels a clean PASS as pass", () => {
    expect(
      computeVerificationBadge({
        command: "git diff --check",
        status: "PASS",
        ok: true,
        returncode: 0,
        elapsedSeconds: 0,
        outputTail: "",
        baselineAware: false,
        newErrorSignatures: [],
      }),
    ).toEqual({ label: "PASS", tone: "pass" });
  });

  it("labels PASS_BASELINE with zero new failures as baseline-ok, not a regression", () => {
    expect(
      computeVerificationBadge({
        command: "npm run typecheck",
        status: "PASS_BASELINE",
        ok: true,
        returncode: 2,
        elapsedSeconds: 6.46,
        outputTail: "...",
        baselineAware: true,
        newErrorSignatures: [],
      }),
    ).toEqual({ label: "PASS (baseline)", tone: "baseline-ok" });
  });

  it("labels a check with new error signatures as a Glimmer regression even if baselineAware", () => {
    expect(
      computeVerificationBadge({
        command: "npm run typecheck",
        status: "PASS_BASELINE",
        ok: true,
        returncode: 2,
        elapsedSeconds: 6.46,
        outputTail: "...",
        baselineAware: true,
        newErrorSignatures: ["new error"],
      }),
    ).toEqual({ label: "NEW FAILURE", tone: "fail" });
  });

  it("labels CODE_FAIL as fail", () => {
    expect(
      computeVerificationBadge({
        command: "vitest",
        status: "CODE_FAIL",
        ok: false,
        returncode: 1,
        elapsedSeconds: 1,
        outputTail: "",
        baselineAware: false,
        newErrorSignatures: [],
      }),
    ).toEqual({ label: "FAIL", tone: "fail" });
  });

  it("labels NOT_RUN as not-run, never as a pass or a failure", () => {
    expect(
      computeVerificationBadge({
        command: "e2e",
        status: "NOT_RUN",
        ok: false,
        returncode: 0,
        elapsedSeconds: 0,
        outputTail: "",
        baselineAware: false,
        newErrorSignatures: [],
      }),
    ).toEqual({ label: "NOT RUN", tone: "not-run" });
  });
});
