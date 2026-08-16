import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { glimmerApi } from "../../api/client";
import { buildTaskContract, type TaskComposerFormState } from "../../state/buildTaskContract";

const DEFAULT_FORM: TaskComposerFormState = {
  objective: "", scopePackage: "repository", scopeArea: "", mode: "implement",
  verification: [], repairBudget: 2, maxTurns: undefined,
};

export function NewTaskScreen() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [workspace, setWorkspace] = useState("");
  const navigate = useNavigate();

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
      </fieldset>

      <fieldset>
        <legend>Mode</legend>
        <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as any })}>
          {["inspect", "plan", "implement", "debug", "test", "review"].map((m) => (
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

      <button
        onClick={() => runMutation.mutate()}
        disabled={!form.objective || !workspace || runMutation.isPending}
      >
        RUN GLIMMER
      </button>
    </div>
  );
}
