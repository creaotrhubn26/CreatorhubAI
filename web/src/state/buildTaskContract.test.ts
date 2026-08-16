import { describe, it, expect } from "vitest";
import { buildTaskContract, type TaskComposerFormState } from "./buildTaskContract";

const BASE: TaskComposerFormState = {
  objective: "Fix dialog state restoration",
  scopePackage: "frontend",
  scopeArea: "role-room",
  mode: "implement",
  verification: ["frontend-typecheck", "targeted-test"],
  repairBudget: 2,
  maxTurns: undefined,
};

describe("buildTaskContract", () => {
  it("always forces noCommit/noPush/noDeploy/noDependencyInstall to true", () => {
    const contract = buildTaskContract(BASE);
    expect(contract.constraints).toEqual({
      minimalChange: true, noCommit: true, noPush: true, noDeploy: true, noDependencyInstall: true,
    });
  });

  it("clamps repair budget into 0..5", () => {
    expect(buildTaskContract({ ...BASE, repairBudget: 9 }).repairBudget).toBe(5);
    expect(buildTaskContract({ ...BASE, repairBudget: -1 }).repairBudget).toBe(0);
  });

  it("carries objective, scope, mode, and verification through unchanged", () => {
    const contract = buildTaskContract(BASE);
    expect(contract.objective).toBe(BASE.objective);
    expect(contract.scope).toEqual({ package: "frontend", area: "role-room" });
    expect(contract.mode).toBe("implement");
    expect(contract.verification).toEqual(["frontend-typecheck", "targeted-test"]);
  });
});
