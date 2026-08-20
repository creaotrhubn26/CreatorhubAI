import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { glimmerApi } from "../../api/client";
import { buildTaskContract, type TaskComposerFormState } from "../../state/buildTaskContract";
import { TaskIntelligencePanel } from "./TaskIntelligencePanel";

const DEFAULT_FORM: TaskComposerFormState = {
  objective: "", scopePackage: "repository", scopeArea: "", mode: "implement",
  verification: [], repairBudget: 2, maxTurns: undefined,
  timeoutSeconds: undefined, toolchainMode: "path", modelReadinessUrl: "", architectFirst: false,
};

const PATH_SCOPED_PACKAGES = new Set(["directory", "files"]);

export function NewTaskScreen() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [workspace, setWorkspace] = useState("");
  const navigate = useNavigate();
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
    <div>
      <h1>What should Glimmer work on?</h1>
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
          {["inspect", "plan", "implement", "debug", "test", "review"].map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </fieldset>

      <TaskIntelligencePanel scopePackage={form.scopePackage} scopeArea={form.scopeArea || undefined} />

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

      <fieldset>
        <legend>Repair budget</legend>
        <input
          type="range" min={0} max={5} value={form.repairBudget}
          onChange={(e) => setForm({ ...form, repairBudget: Number(e.target.value) })}
        />
        <span>{form.repairBudget}</span>
      </fieldset>

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

      <button
        onClick={() => runMutation.mutate()}
        disabled={!form.objective || !workspace || scopePathMissing || runMutation.isPending}
      >
        RUN GLIMMER
      </button>
    </div>
  );
}
