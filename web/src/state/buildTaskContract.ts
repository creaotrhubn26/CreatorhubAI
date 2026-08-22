import type { TaskContract } from "@glimmer/shared";

type ToolchainMode = NonNullable<NonNullable<TaskContract["advanced"]>["toolchainMode"]>;

const DEFAULT_TOOLCHAIN_MODE: ToolchainMode = "path";

export interface TaskComposerFormState {
  objective: string;
  scopePackage: TaskContract["scope"]["package"];
  scopeArea?: string;
  mode: TaskContract["mode"];
  verification: string[];
  repairBudget: number;
  maxTurns?: number;
  // Task 1.4 (V7 §6) — shown in the same Advanced section as maxTurns
  // above, but lives in the contract's top-level `budgets`, not `advanced`
  // (see buildTaskContract). Undefined here means "unbounded".
  maxChangedFiles?: number;
  // §7 Advanced controls — collapsed by default in the UI. Left
  // undefined/default here means "not in the contract" (see buildTaskContract).
  timeoutSeconds?: number;
  toolchainMode?: ToolchainMode;
  modelReadinessUrl?: string;
  architectFirst?: boolean;
}

export function buildTaskContract(form: TaskComposerFormState): TaskContract {
  const advanced: NonNullable<TaskContract["advanced"]> = {};
  if (form.timeoutSeconds !== undefined) advanced.timeoutSeconds = form.timeoutSeconds;
  if (form.toolchainMode !== undefined && form.toolchainMode !== DEFAULT_TOOLCHAIN_MODE) {
    advanced.toolchainMode = form.toolchainMode;
  }
  if (form.modelReadinessUrl?.trim()) advanced.modelReadinessUrl = form.modelReadinessUrl.trim();
  if (form.architectFirst) advanced.architectFirst = true;

  return {
    objective: form.objective,
    scope: { package: form.scopePackage, area: form.scopeArea },
    mode: form.mode,
    constraints: { minimalChange: true, noCommit: true, noPush: true, noDeploy: true, noDependencyInstall: true },
    verification: form.verification,
    repairBudget: Math.min(5, Math.max(0, form.repairBudget)),
    maxTurns: form.maxTurns,
    // Omitted entirely when nothing was touched — orchestrator defaults apply.
    ...(form.maxChangedFiles !== undefined ? { budgets: { maxChangedFiles: form.maxChangedFiles } } : {}),
    ...(Object.keys(advanced).length > 0 ? { advanced } : {}),
  };
}
