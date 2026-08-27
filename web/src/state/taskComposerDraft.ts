import type { TaskComposerFormState } from "./buildTaskContract";

const STORAGE_KEY = "glimmer.task-composer-draft.v1";
const INTENTS = new Set(["auto", "direct", "improvement-assessment"]);
const SCOPES = new Set(["repository", "frontend", "backend", "directory", "files"]);
const MODES = new Set(["inspect", "plan", "implement", "debug", "test", "review", "refactor"]);
const TOOLCHAINS = new Set(["path", "linked", "none"]);
const VERIFICATION = new Set(["frontend-typecheck", "targeted-test"]);

export interface TaskComposerDraft {
  form: TaskComposerFormState;
  workspace: string;
  newTaskName: string;
  savedAt: string;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function optionalInteger(value: unknown, min: number, max: number): value is number | undefined {
  return (
    value === undefined || (Number.isInteger(value) && Number(value) >= min && Number(value) <= max)
  );
}

function parseDraft(value: unknown): TaskComposerDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Record<string, unknown>;
  const form = draft.form as Record<string, unknown> | undefined;
  if (
    draft.version !== 1 ||
    !form ||
    !boundedString(form.objective, 20_000) ||
    !INTENTS.has(String(form.intentKind)) ||
    !SCOPES.has(String(form.scopePackage)) ||
    !boundedString(form.scopeArea, 4_096) ||
    !MODES.has(String(form.mode)) ||
    !Array.isArray(form.verification) ||
    !form.verification.every((item) => typeof item === "string" && VERIFICATION.has(item)) ||
    !Number.isInteger(form.repairBudget) ||
    Number(form.repairBudget) < 0 ||
    Number(form.repairBudget) > 5 ||
    !optionalInteger(form.maxTurns, 1, 64) ||
    !optionalInteger(form.maxChangedFiles, 1, 500) ||
    !optionalInteger(form.timeoutSeconds, 60, 3_600) ||
    (form.toolchainMode !== undefined && !TOOLCHAINS.has(String(form.toolchainMode))) ||
    !boundedString(form.modelReadinessUrl, 2_048) ||
    (form.architectFirst !== undefined && typeof form.architectFirst !== "boolean") ||
    !boundedString(draft.workspace, 4_096) ||
    !boundedString(draft.newTaskName, 256) ||
    typeof draft.savedAt !== "string"
  ) {
    return null;
  }
  return {
    form: form as unknown as TaskComposerFormState,
    workspace: draft.workspace,
    newTaskName: draft.newTaskName,
    savedAt: draft.savedAt,
  };
}

export function loadTaskComposerDraft(): TaskComposerDraft | null {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = parseDraft(JSON.parse(raw));
    if (!parsed) window.localStorage?.removeItem(STORAGE_KEY);
    return parsed;
  } catch {
    return null;
  }
}

export function saveTaskComposerDraft(
  form: TaskComposerFormState,
  workspace: string,
  newTaskName: string,
): void {
  try {
    window.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        form,
        workspace,
        newTaskName,
        savedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // Local storage may be disabled or full; the composer remains fully usable.
  }
}

export function clearTaskComposerDraft(): void {
  try {
    window.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort cleanup only.
  }
}
