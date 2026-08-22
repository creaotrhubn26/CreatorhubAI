import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { glimmerApi } from "../../api/client";
import { buildTaskContract, type TaskComposerFormState } from "../../state/buildTaskContract";
import { computeArchitectRisk, ARCHITECT_RISK_THRESHOLD } from "../../state/architectRisk";
import { TaskIntelligencePanel } from "./TaskIntelligencePanel";

const DEFAULT_FORM: TaskComposerFormState = {
  objective: "", scopePackage: "repository", scopeArea: "", mode: "implement",
  verification: [], repairBudget: 2, maxTurns: undefined, maxChangedFiles: undefined,
  timeoutSeconds: undefined, toolchainMode: "path", modelReadinessUrl: "", architectFirst: false,
};

const PATH_SCOPED_PACKAGES = new Set(["directory", "files"]);

const SCOPE_LABEL: Record<TaskComposerFormState["scopePackage"], string> = {
  repository: "entire repository",
  frontend: "frontend",
  backend: "backend",
  directory: "selected directory",
  files: "selected files",
};

// Pre-run summary line: one sentence stating exactly what will run, derived
// live from the real form state — never fabricated, updates as the user types.
function buildSummaryLine(form: TaskComposerFormState): string {
  const scope = PATH_SCOPED_PACKAGES.has(form.scopePackage) && form.scopeArea?.trim()
    ? `${SCOPE_LABEL[form.scopePackage]} (${form.scopeArea.trim()})`
    : SCOPE_LABEL[form.scopePackage];
  const verification = form.verification.length === 0
    ? "no verification checks"
    : `${form.verification.length} verification check${form.verification.length === 1 ? "" : "s"}`;
  const repairs = `${form.repairBudget} repair${form.repairBudget === 1 ? "" : "s"}`;
  return `${form.mode} · ${scope} · ${verification} · ${repairs}`;
}

// Task 2.1 fix round 1 (V7 §5.5): deterministic preview of the
// orchestrator's risk-based architect auto-trigger (compute_architect_risk
// in glimmer-v2.py; mirrored client-side in state/architectRisk.ts). null
// below threshold -- render nothing, exactly per the spec ("when below:
// nothing").
function buildArchitectRiskLine(form: TaskComposerFormState): string | null {
  const risk = computeArchitectRisk(buildTaskContract(form));
  if (risk.score < ARCHITECT_RISK_THRESHOLD) return null;
  return `Architect mode will auto-trigger (score ${risk.score}: ${risk.signals.join(", ")})`;
}

export function NewTaskScreen() {
  const location = useLocation();
  // Task 8.2 (V7 §23.14): DeliveryReviewPanel's "convert next step to task"
  // action navigates here with { state: { objective } } -- a DRAFT prefill
  // only (the objective field, pre-filled; the human still reviews/edits
  // every other field and presses Run themselves). Read once at mount, the
  // same "seed initial state, ignore afterward" pattern router.state-based
  // prefills always use -- a later in-place navigation to this same route
  // (e.g. clicking "New Task" again) does not fight the user's own typing.
  const prefillObjective = (location.state as { objective?: string } | null)?.objective;
  const [form, setForm] = useState<TaskComposerFormState>(() =>
    prefillObjective ? { ...DEFAULT_FORM, objective: prefillObjective } : DEFAULT_FORM
  );
  const [workspace, setWorkspace] = useState("");
  const [newTaskName, setNewTaskName] = useState("");
  const navigate = useNavigate();

  // §27/§4.1 — "New worktree" affordance: cuts a fresh git worktree+branch
  // off the source repo and adopts it as the workspace path above, the same
  // field POST /sessions already reads. Fetch can take ~10s+ (git fetch
  // over the network), so this is its own pending state, separate from
  // runMutation.
  const createWorkspaceMutation = useMutation({
    mutationFn: (taskName: string) => glimmerApi.createWorkspace(taskName),
    onSuccess: (result) => setWorkspace(result.workspace),
  });
  // F5: "directory"/"files" scope claims to be bounded to a concrete path —
  // without one, the backend's scope guard has nothing to check against and
  // silently reports every change as in-scope. Require the path here so that
  // state is now rare, not the default outcome of picking these scope types.
  const needsScopePath = PATH_SCOPED_PACKAGES.has(form.scopePackage);
  const scopePathMissing = needsScopePath && !form.scopeArea?.trim();

  const runMutation = useMutation({
    mutationFn: async () => {
      const contract = buildTaskContract(form);
      const session = await glimmerApi.createSession(contract, workspace);
      await glimmerApi.runSession(session.id);
      return session;
    },
    onSuccess: (session) => navigate(`/sessions/${session.id}`),
  });

  return (
    <div className="composer">
      <div className="composer__scroll">
        <h1>What should Glimmer work on?</h1>
        <div className="composer__columns">
          <div className="composer__main">
            <textarea
              value={form.objective}
              onChange={(e) => setForm({ ...form, objective: e.target.value })}
              placeholder="What should Glimmer work on?"
            />
            <label>
              Workspace path
              <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
            </label>

            <fieldset>
              <legend>New worktree</legend>
              <label>
                Task name
                <input
                  value={newTaskName}
                  onChange={(e) => setNewTaskName(e.target.value)}
                  placeholder="e.g. role-room-story-logic"
                  disabled={createWorkspaceMutation.isPending}
                />
              </label>
              <button
                type="button"
                onClick={() => createWorkspaceMutation.mutate(newTaskName)}
                disabled={!newTaskName.trim() || createWorkspaceMutation.isPending}
              >
                {createWorkspaceMutation.isPending ? "Creating worktree…" : "Create"}
              </button>
              {createWorkspaceMutation.isError && (
                <span role="alert"> {(createWorkspaceMutation.error as Error).message}</span>
              )}
            </fieldset>

            <fieldset>
              <legend>Scope</legend>
              <select value={form.scopePackage} onChange={(e) => setForm({ ...form, scopePackage: e.target.value as any })}>
                <option value="repository">Entire repository</option>
                <option value="frontend">Frontend</option>
                <option value="backend">Backend</option>
                <option value="directory">Selected directory</option>
                <option value="files">Selected files</option>
              </select>
              {needsScopePath && (
                <label>
                  Scope path
                  <input
                    value={form.scopeArea ?? ""}
                    onChange={(e) => setForm({ ...form, scopeArea: e.target.value })}
                    placeholder={form.scopePackage === "files" ? "e.g. src/foo.ts" : "e.g. frontend/src/dialog"}
                  />
                  {scopePathMissing && <span role="alert"> A path is required for this scope.</span>}
                </label>
              )}
            </fieldset>

            <fieldset>
              <legend>Mode</legend>
              <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as any })}>
                {["inspect", "plan", "implement", "debug", "test", "review", "refactor"].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </fieldset>

            <fieldset>
              <legend>Verification</legend>
              <label>
                <input
                  type="checkbox"
                  checked={form.verification.includes("frontend-typecheck")}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      verification: e.target.checked
                        ? [...form.verification, "frontend-typecheck"]
                        : form.verification.filter((v) => v !== "frontend-typecheck"),
                    })
                  }
                />
                Frontend typecheck
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.verification.includes("targeted-test")}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      verification: e.target.checked
                        ? [...form.verification, "targeted-test"]
                        : form.verification.filter((v) => v !== "targeted-test"),
                    })
                  }
                />
                Targeted test
              </label>
            </fieldset>
          </div>

          <div className="composer__side">
            <TaskIntelligencePanel scopePackage={form.scopePackage} scopeArea={form.scopeArea || undefined} />

            <fieldset>
              <legend>Permissions</legend>
              <label><input type="checkbox" checked readOnly /> Read repository</label>
              <label><input type="checkbox" checked readOnly /> Search repository</label>
              <label><input type="checkbox" checked readOnly /> Modify files</label>
              <label><input type="checkbox" checked={false} disabled /> Commit</label>
              <label><input type="checkbox" checked={false} disabled /> Push</label>
              <label><input type="checkbox" checked={false} disabled /> Deploy</label>
              <label><input type="checkbox" checked={false} disabled /> Install dependencies</label>
            </fieldset>

            <fieldset>
              <legend>Repair budget</legend>
              <input
                type="range" min={0} max={5} value={form.repairBudget}
                onChange={(e) => setForm({ ...form, repairBudget: Number(e.target.value) })}
              />
              <span>{form.repairBudget}</span>
            </fieldset>

            <details>
              <summary>Advanced</summary>
              <label>
                Max turns
                <input
                  type="number" min={1} max={64}
                  value={form.maxTurns ?? ""}
                  onChange={(e) => setForm({ ...form, maxTurns: e.target.value === "" ? undefined : Number(e.target.value) })}
                />
              </label>
              <label>
                Max changed files
                <input
                  type="number" min={1} max={500}
                  value={form.maxChangedFiles ?? ""}
                  onChange={(e) => setForm({ ...form, maxChangedFiles: e.target.value === "" ? undefined : Number(e.target.value) })}
                  placeholder="unlimited"
                />
              </label>
              <label>
                Timeout (seconds)
                <input
                  type="number" min={60} max={3600}
                  value={form.timeoutSeconds ?? ""}
                  onChange={(e) => setForm({ ...form, timeoutSeconds: e.target.value === "" ? undefined : Number(e.target.value) })}
                />
              </label>
              <label>
                Toolchain mode
                <select
                  value={form.toolchainMode}
                  onChange={(e) => setForm({ ...form, toolchainMode: e.target.value as TaskComposerFormState["toolchainMode"] })}
                >
                  <option value="path">path</option>
                  <option value="linked">linked</option>
                  <option value="none">none</option>
                </select>
              </label>
              <label>
                Model readiness URL
                <input
                  type="url"
                  value={form.modelReadinessUrl ?? ""}
                  onChange={(e) => setForm({ ...form, modelReadinessUrl: e.target.value })}
                  placeholder="https://..."
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.architectFirst ?? false}
                  onChange={(e) => setForm({ ...form, architectFirst: e.target.checked })}
                />
                Architect first
              </label>
              <p>Runs a read-only planning pass first.</p>
            </details>
          </div>
        </div>
      </div>

      <div className="composer__runbar">
        <p className="composer__summary">{buildSummaryLine(form)}</p>
        {buildArchitectRiskLine(form) && (
          <p className="composer__architect-risk">{buildArchitectRiskLine(form)}</p>
        )}
        <button
          className="btn-primary"
          onClick={() => runMutation.mutate()}
          disabled={!form.objective || !workspace || scopePathMissing || runMutation.isPending}
        >
          RUN GLIMMER
        </button>
      </div>
    </div>
  );
}
