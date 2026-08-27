import { describe, it, expect } from "vitest";
import { buildTaskContract, type TaskComposerFormState } from "./buildTaskContract";
import { DEFAULT_DESIGN_FORM } from "./designContract";

const BASE: TaskComposerFormState = {
  ...DEFAULT_DESIGN_FORM,
  objective: "Fix dialog state restoration",
  intentKind: "auto",
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
      minimalChange: true,
      noCommit: true,
      noPush: true,
      noDeploy: true,
      noDependencyInstall: true,
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

  it("records a manual interpretation as explicit and leaves auto-detection to the caller", () => {
    expect(buildTaskContract(BASE).intent).toBeUndefined();
    expect(buildTaskContract({ ...BASE, intentKind: "improvement-assessment" }).intent).toEqual({
      kind: "improvement-assessment",
      source: "explicit",
    });
  });

  // §7 Advanced controls: an untouched composer must produce zero behavior
  // change — no `advanced` key at all, so the orchestrator's own defaults apply.
  it("omits `advanced` entirely when no advanced field was touched", () => {
    const contract = buildTaskContract(BASE);
    expect(contract.advanced).toBeUndefined();
  });

  // Task 4c(3): the file picker can select several files; the backend's scope
  // guard checks every entry of scope.paths but treats scope.area as a single
  // prefix, so a multi-file selection has to land in paths.
  it("splits a multi-file scope into scope.paths, leaving other scopes on scope.area", () => {
    const files = buildTaskContract({
      ...BASE,
      scopePackage: "files",
      scopeArea: "src/a.ts, src/b.ts",
    });
    expect(files.scope).toEqual({ package: "files", paths: ["src/a.ts", "src/b.ts"] });

    const directory = buildTaskContract({
      ...BASE,
      scopePackage: "directory",
      scopeArea: "frontend/src/dialog",
    });
    expect(directory.scope).toEqual({ package: "directory", area: "frontend/src/dialog" });
  });

  it("keeps a single picked file as a one-entry paths list, not a bare area", () => {
    const contract = buildTaskContract({ ...BASE, scopePackage: "files", scopeArea: "src/a.ts" });
    expect(contract.scope).toEqual({ package: "files", paths: ["src/a.ts"] });
  });

  // Task 1.4 (V7 §6): budgets.maxChangedFiles.
  it("omits `budgets` entirely when maxChangedFiles is untouched", () => {
    expect(buildTaskContract(BASE).budgets).toBeUndefined();
  });

  it("carries maxChangedFiles into contract.budgets.maxChangedFiles", () => {
    const contract = buildTaskContract({ ...BASE, maxChangedFiles: 25 });
    expect(contract.budgets).toEqual({ maxChangedFiles: 25 });
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
    expect(
      buildTaskContract({ ...BASE, modelReadinessUrl: " https://model.local/ready  " }).advanced,
    ).toEqual({
      modelReadinessUrl: "https://model.local/ready",
    });
  });

  it("omits architectFirst when false, includes it when true", () => {
    expect(buildTaskContract({ ...BASE, architectFirst: false }).advanced).toBeUndefined();
    expect(buildTaskContract({ ...BASE, architectFirst: true }).advanced).toEqual({
      architectFirst: true,
    });
  });

  it("carries maxTurns through unchanged (existing top-level field, not nested under advanced)", () => {
    const contract = buildTaskContract({ ...BASE, maxTurns: 15 });
    expect(contract.maxTurns).toBe(15);
    expect(contract.advanced).toBeUndefined();
  });

  it("builds a CMS/token-aware design contract and enables architect, visual, and readiness gates", () => {
    const contract = buildTaskContract({
      ...BASE,
      designEnabled: true,
      designKind: "reference-match",
      designTargetUrl: "http://localhost:5173/settings",
      designAudience: "content editors",
      designPrimaryAction: "publish",
      designRequirements: "Primary action remains visible\nErrors explain recovery",
      designReferenceImages: "Settings | design/settings.png",
      allowReferenceImageModelUpload: true,
      designStates: "dialog-open | click | [aria-label='Settings'] | dialog is visible",
      cmsStrategy: "existing",
      cmsProviderHint: "Sanity",
      cmsSchemaPaths: "cms/schema",
      cmsRequirements: "Hero copy remains editor-managed",
      cmsLocalizationRequired: true,
      designTokenStrategy: "existing",
      designTokenSourcePaths: "src/theme.css",
      designTokenRequirements: "Reuse semantic color tokens",
      designElementEdits: [
        {
          id: "edit-1",
          target: "settings title",
          screenshot: "1440x900-initial.png",
          viewport: "1440x900",
          state: "initial",
          region: { x: 0.1, y: 0.2 },
          text: "Workspace settings",
          style: {},
          createdAt: "2026-08-27T10:00:00.000Z",
        },
      ],
      designAssetRequests: [
        {
          id: "asset-1",
          kind: "vector",
          prompt: "Geometric settings illustration",
          outputPath: "public/generated/settings.svg",
          aspectRatio: "4:3",
          animated: false,
          referenceImages: [],
          referenceUploadPolicy: "local-only",
          createdAt: "2026-08-27T10:00:00.000Z",
        },
      ],
    });
    expect(contract.verification).toContain("visual");
    expect(contract.advanced?.architectFirst).toBe(true);
    expect(contract.qualityGates).toEqual({
      customerReadinessRequired: true,
      minimumCustomerReadiness: "ready_with_known_limitations",
    });
    expect(contract.design).toMatchObject({
      targetUrl: "http://localhost:5173/settings",
      referenceImagePolicy: "vision-model",
      cms: { strategy: "existing", providerHint: "Sanity", localizationRequired: true },
      designTokens: { strategy: "existing", allowNewTokens: false },
      elementEdits: [{ target: "settings title" }],
      assetRequests: [{ kind: "vector", outputPath: "public/generated/settings.svg" }],
    });
    expect(contract.design?.states[0].actions[0]).toEqual({
      action: "click",
      selector: "[aria-label='Settings']",
    });
  });
});
