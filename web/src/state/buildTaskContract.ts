import type { TaskContract } from "@glimmer/shared";

export interface TaskComposerFormState {
  objective: string;
  scopePackage: TaskContract["scope"]["package"];
  scopeArea?: string;
  mode: TaskContract["mode"];
  verification: string[];
  repairBudget: number;
  maxTurns?: number;
}

export function buildTaskContract(form: TaskComposerFormState): TaskContract {
  return {
    objective: form.objective,
    scope: { package: form.scopePackage, area: form.scopeArea },
    mode: form.mode,
    constraints: { minimalChange: true, noCommit: true, noPush: true, noDeploy: true, noDependencyInstall: true },
    verification: form.verification,
    repairBudget: Math.min(5, Math.max(0, form.repairBudget)),
    maxTurns: form.maxTurns,
  };
}
