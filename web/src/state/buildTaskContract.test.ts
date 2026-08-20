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

  // §7 Advanced controls: an untouched composer must produce zero behavior
  // change — no `advanced` key at all, so the orchestrator's own defaults apply.
  it("omits `advanced` entirely when no advanced field was touched", () => {
    const contract = buildTaskContract(BASE);
    expect(contract.advanced).toBeUndefined();
  });

  it("omits toolchainMode when it is left at the default 'path' (behaviorally identical to omitting it)", () => {
    const contract = buildTaskContract({ ...BASE, toolchainMode: "path" });
    expect(contract.advanced).toBeUndefined();
  });

  it("includes only the advanced fields the user actually set", () => {
    const contract = buildTaskContract({ ...BASE, timeoutSeconds: 300 });
    expect(contract.advanced).toEqual({ timeoutSeconds: 300 });
  });

  it("includes a non-default toolchainMode", () => {
    const contract = buildTaskContract({ ...BASE, toolchainMode: "linked" });
    expect(contract.advanced).toEqual({ toolchainMode: "linked" });
  });

  it("omits an empty/whitespace modelReadinessUrl but includes a real one, trimmed", () => {
    expect(buildTaskContract({ ...BASE, modelReadinessUrl: "   " }).advanced).toBeUndefined();
    expect(buildTaskContract({ ...BASE, modelReadinessUrl: " https://model.local/ready  " }).advanced).toEqual({
      modelReadinessUrl: "https://model.local/ready",
    });
  });

  it("omits architectFirst when false, includes it when true", () => {
    expect(buildTaskContract({ ...BASE, architectFirst: false }).advanced).toBeUndefined();
    expect(buildTaskContract({ ...BASE, architectFirst: true }).advanced).toEqual({ architectFirst: true });
  });

  it("carries maxTurns through unchanged (existing top-level field, not nested under advanced)", () => {
    const contract = buildTaskContract({ ...BASE, maxTurns: 15 });
    expect(contract.maxTurns).toBe(15);
    expect(contract.advanced).toBeUndefined();
  });
});
