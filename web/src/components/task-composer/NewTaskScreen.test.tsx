import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { NewTaskScreen } from "./NewTaskScreen";
import * as client from "../../api/client";

// NewTaskScreen calls useNavigate() (per the task-12 brief's exact implementation),
// which requires a Router context to render. MemoryRouter is added here (matching
// the pattern already used in AppShell.test.tsx) purely as test scaffolding — it
// does not change what is asserted.
function withQuery(ui: React.ReactElement, initialEntries: Array<string | { pathname: string; state?: unknown }> = ["/"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("NewTaskScreen", () => {
  beforeEach(() => {
    // NewTaskScreen now renders TaskIntelligencePanel, which fetches on mount.
    // Stub it so these tests exercise the composer form, not the network.
    vi.spyOn(client.glimmerApi, "getTaskIntelligence").mockResolvedValue({
      likelyArea: null, likelyPackage: null, suggestedVerification: [], estimatedRisk: null,
      provenance: "deterministic-backend", repoMapStatus: "none",
    });
    // Task 4c(2): the composer now also lists known workspaces for quick-pick
    // and can browse directories. Stub both network boundaries.
    vi.spyOn(client.glimmerApi, "listWorkspaces").mockResolvedValue([]);
    vi.spyOn(client.glimmerApi, "listDirectory").mockResolvedValue({
      root: "/tmp/ws", path: "/tmp/ws", parent: null, entries: [{ name: "src", isDir: true }], truncated: false,
    });
  });


  it("renders commit/push/deploy/install as permanently disabled and unchecked", () => {
    render(withQuery(<NewTaskScreen />));
    for (const label of ["Commit", "Push", "Deploy", "Install dependencies"]) {
      const box = screen.getByLabelText(label) as HTMLInputElement;
      expect(box.disabled).toBe(true);
      expect(box.checked).toBe(false);
    }
  });

  it("renders read/search/modify as checked and enabled", () => {
    render(withQuery(<NewTaskScreen />));
    for (const label of ["Read repository", "Search repository", "Modify files"]) {
      const box = screen.getByLabelText(label) as HTMLInputElement;
      expect(box.checked).toBe(true);
    }
  });

  it("shows the RUN GLIMMER primary action", () => {
    render(withQuery(<NewTaskScreen />));
    expect(screen.getByRole("button", { name: "RUN GLIMMER" })).toBeInTheDocument();
  });

  it("lets the user toggle a verification checkbox on", () => {
    render(withQuery(<NewTaskScreen />));
    const box = screen.getByLabelText("Frontend typecheck") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
  });

  // Task 8.2 (V7 §23.14): DeliveryReviewPanel's "convert next step to task"
  // action navigates here with router state { objective } — a DRAFT prefill
  // only. Nothing runs automatically: the objective field is pre-filled,
  // every other field keeps its normal default, and RUN GLIMMER still
  // requires an explicit click.
  it("prefills the objective from router state when arriving via 'convert to task'", () => {
    render(
      withQuery(<NewTaskScreen />, [{ pathname: "/tasks/new", state: { objective: "Add restoration progress state" } }])
    );
    expect(screen.getByPlaceholderText("What should Glimmer work on?")).toHaveValue("Add restoration progress state");
    expect(screen.getByRole("button", { name: "RUN GLIMMER" })).toBeInTheDocument();
  });

  it("defaults the objective to empty when arriving with no router state", () => {
    render(withQuery(<NewTaskScreen />));
    expect(screen.getByPlaceholderText("What should Glimmer work on?")).toHaveValue("");
  });

  // F5: "directory"/"files" scope previously had no way to enter a concrete
  // path at all — scopeArea stayed "" forever, so the backend's scope guard
  // could never tell what was in/out of scope and silently reported
  // inScope: true for any change. A path input must appear for these scope
  // types, and submission must be blocked while it's empty.
  it("does not show a scope-path input for the default 'Entire repository' scope", () => {
    render(withQuery(<NewTaskScreen />));
    expect(screen.queryByLabelText(/scope path/i)).not.toBeInTheDocument();
  });

  it("shows a required scope-path input when 'Selected directory' is chosen, and blocks submission until filled", () => {
    render(withQuery(<NewTaskScreen />));
    fireEvent.change(screen.getByText("Scope").closest("fieldset")!.querySelector("select")!, {
      target: { value: "directory" },
    });

    const pathInput = screen.getByLabelText(/scope path/i) as HTMLInputElement;
    expect(pathInput).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/what should glimmer work on/i), { target: { value: "Fix the dialog" } });
    fireEvent.change(screen.getByLabelText("Workspace path"), { target: { value: "/tmp/ws" } });

    expect(screen.getByRole("button", { name: "RUN GLIMMER" })).toBeDisabled();

    fireEvent.change(pathInput, { target: { value: "frontend/src/dialog" } });
    expect(screen.getByRole("button", { name: "RUN GLIMMER" })).not.toBeDisabled();
  });

  it("shows the same required scope-path input when 'Selected files' is chosen", () => {
    render(withQuery(<NewTaskScreen />));
    fireEvent.change(screen.getByText("Scope").closest("fieldset")!.querySelector("select")!, {
      target: { value: "files" },
    });
    expect(screen.getByLabelText(/scope path/i)).toBeInTheDocument();
  });

  // §7 Advanced controls: collapsed by default, typed inputs only, submits
  // omitted-when-empty so an untouched composer changes nothing behaviorally.
  describe("Advanced controls", () => {
    it("renders the Advanced section collapsed by default", () => {
      render(withQuery(<NewTaskScreen />));
      const details = screen.getByText("Advanced").closest("details") as HTMLDetailsElement;
      expect(details).toBeInTheDocument();
      expect(details.open).toBe(false);
    });

    it("shows max turns, timeout, toolchain mode, model readiness URL, and architect-first controls", () => {
      render(withQuery(<NewTaskScreen />));
      expect(screen.getByLabelText("Max turns")).toBeInTheDocument();
      expect(screen.getByLabelText("Timeout (seconds)")).toBeInTheDocument();
      expect(screen.getByLabelText("Toolchain mode")).toBeInTheDocument();
      expect(screen.getByLabelText("Model readiness URL")).toBeInTheDocument();
      expect(screen.getByLabelText("Architect first")).toBeInTheDocument();
    });

    it("defaults toolchain mode to 'path' and architect-first to off, with helper text explaining it", () => {
      render(withQuery(<NewTaskScreen />));
      expect((screen.getByLabelText("Toolchain mode") as HTMLSelectElement).value).toBe("path");
      expect((screen.getByLabelText("Architect first") as HTMLInputElement).checked).toBe(false);
      expect(screen.getByText(/runs a read-only planning pass first/i)).toBeInTheDocument();
    });

    it("submits a contract with no `advanced` key when the section is left untouched", async () => {
      const createSpy = vi
        .spyOn(client.glimmerApi, "createSession")
        .mockResolvedValue({ id: "s1" } as any);
      vi.spyOn(client.glimmerApi, "runSession").mockResolvedValue({ started: true } as any);

      render(withQuery(<NewTaskScreen />));
      fireEvent.change(screen.getByPlaceholderText(/what should glimmer work on/i), { target: { value: "Fix the dialog" } });
      fireEvent.change(screen.getByLabelText("Workspace path"), { target: { value: "/tmp/ws" } });
      fireEvent.click(screen.getByRole("button", { name: "RUN GLIMMER" }));

      await vi.waitFor(() => expect(createSpy).toHaveBeenCalled());
      const [contract] = createSpy.mock.calls[0];
      expect(contract.advanced).toBeUndefined();
    });

    it("submits only the advanced fields the user actually set", async () => {
      const createSpy = vi
        .spyOn(client.glimmerApi, "createSession")
        .mockResolvedValue({ id: "s2" } as any);
      vi.spyOn(client.glimmerApi, "runSession").mockResolvedValue({ started: true } as any);

      render(withQuery(<NewTaskScreen />));
      fireEvent.change(screen.getByPlaceholderText(/what should glimmer work on/i), { target: { value: "Fix the dialog" } });
      fireEvent.change(screen.getByLabelText("Workspace path"), { target: { value: "/tmp/ws" } });
      fireEvent.change(screen.getByLabelText("Timeout (seconds)"), { target: { value: "300" } });
      fireEvent.change(screen.getByLabelText("Toolchain mode"), { target: { value: "linked" } });
      fireEvent.click(screen.getByLabelText("Architect first"));
      fireEvent.click(screen.getByRole("button", { name: "RUN GLIMMER" }));

      await vi.waitFor(() => expect(createSpy).toHaveBeenCalled());
      const [contract] = createSpy.mock.calls[0];
      expect(contract.advanced).toEqual({ timeoutSeconds: 300, toolchainMode: "linked", architectFirst: true });
    });
  });

  // §27/§4.1 — the composer's "New worktree" affordance. glimmerApi.createWorkspace
  // is the real client method (web/src/api/client.ts); these tests stub only the
  // network boundary, exercising the actual pending/success/error wiring in the
  // component.
  describe("New worktree", () => {
    it("disables Create until a task name is entered", () => {
      render(withQuery(<NewTaskScreen />));
      const createButton = screen.getByRole("button", { name: "Create" });
      expect(createButton).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "role room story logic" } });
      expect(createButton).not.toBeDisabled();
    });

    it("on success, adopts the created workspace path as the selected workspace", async () => {
      let resolveCreate: (v: { workspace: string; branch: string; baselineSha: string }) => void;
      vi.spyOn(client.glimmerApi, "createWorkspace").mockReturnValue(
        new Promise((resolve) => { resolveCreate = resolve; })
      );

      render(withQuery(<NewTaskScreen />));
      fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "role room story logic" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));

      // Pending state: fetch can take ~10s+, so the button must reflect that
      // instead of looking inert/clickable-again.
      expect(await screen.findByRole("button", { name: /creating worktree/i })).toBeInTheDocument();

      resolveCreate!({
        workspace: "/Users/danielqazi/glimmer-role-room-story-logic-20260821-010000",
        branch: "glimmer/role-room-story-logic-20260821-010000",
        baselineSha: "a".repeat(40),
      });

      await vi.waitFor(() =>
        expect((screen.getByLabelText("Workspace path") as HTMLInputElement).value).toBe(
          "/Users/danielqazi/glimmer-role-room-story-logic-20260821-010000"
        )
      );
    });

    it("on failure, shows the server's error text — including a half-created path if one is named", async () => {
      vi.spyOn(client.glimmerApi, "createWorkspace").mockRejectedValue(
        new Error("workspace and branch were created but failed post-create verification: worktree is dirty — workspace: /Users/danielqazi/glimmer-x-20260821-010000 — branch: glimmer/x-20260821-010000")
      );

      render(withQuery(<NewTaskScreen />));
      fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "x" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/glimmer-x-20260821-010000/);
      // Workspace path must NOT be silently adopted on failure.
      expect((screen.getByLabelText("Workspace path") as HTMLInputElement).value).toBe("");
    });
  });

  // Task 4c(2/3): picking paths instead of typing them.
  describe("path pickers", () => {
    it("adopts a browsed directory as the workspace path", async () => {
      render(withQuery(<NewTaskScreen />));
      fireEvent.click(screen.getByRole("button", { name: "Choose workspace…" }));
      fireEvent.click(await screen.findByRole("button", { name: "Use this directory" }));
      expect((screen.getByLabelText("Workspace path") as HTMLInputElement).value).toBe("/tmp/ws");
    });

    it("offers known workspaces as one-click quick picks", async () => {
      vi.spyOn(client.glimmerApi, "listWorkspaces").mockResolvedValue([
        { path: "/Users/u/glimmer-x", branch: "glimmer/x", headSha: "a", baselineSha: null, dirty: false, changedFiles: [] },
      ]);
      render(withQuery(<NewTaskScreen />));
      fireEvent.click(await screen.findByRole("button", { name: "/Users/u/glimmer-x" }));
      expect((screen.getByLabelText("Workspace path") as HTMLInputElement).value).toBe("/Users/u/glimmer-x");
    });

    it("keeps the workspace text input editable for pasted paths", () => {
      render(withQuery(<NewTaskScreen />));
      const input = screen.getByLabelText("Workspace path") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "/pasted/path" } });
      expect(input.value).toBe("/pasted/path");
    });

    it("refuses to browse a scope path before a workspace is chosen (nothing to root it at)", () => {
      render(withQuery(<NewTaskScreen />));
      fireEvent.change(screen.getByText("Scope").closest("fieldset")!.querySelector("select")!, {
        target: { value: "directory" },
      });
      expect(screen.getByRole("button", { name: "Choose directory…" })).toBeDisabled();
      expect(screen.getByText("Choose a workspace first.")).toBeInTheDocument();
    });

    // The scope contract stores workspace-RELATIVE paths; an absolute one
    // would never match a changed-file path in the backend's scope guard.
    it("stores a browsed scope directory workspace-relative, rooted at the workspace", async () => {
      vi.spyOn(client.glimmerApi, "listDirectory").mockResolvedValue({
        root: "/tmp/ws", path: "/tmp/ws/frontend/src", parent: "/tmp/ws/frontend", entries: [], truncated: false,
      });
      render(withQuery(<NewTaskScreen />));
      fireEvent.change(screen.getByLabelText("Workspace path"), { target: { value: "/tmp/ws" } });
      fireEvent.change(screen.getByText("Scope").closest("fieldset")!.querySelector("select")!, {
        target: { value: "directory" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Choose directory…" }));
      fireEvent.click(await screen.findByRole("button", { name: "Use this directory" }));
      expect((screen.getByLabelText(/scope path/i) as HTMLInputElement).value).toBe("frontend/src");
    });

    it("refuses a picked path outside the workspace instead of storing an unusable absolute path", async () => {
      vi.spyOn(client.glimmerApi, "listDirectory").mockResolvedValue({
        root: "/tmp/ws", path: "/somewhere/else", parent: null, entries: [], truncated: false,
      });
      render(withQuery(<NewTaskScreen />));
      fireEvent.change(screen.getByLabelText("Workspace path"), { target: { value: "/tmp/ws" } });
      fireEvent.change(screen.getByText("Scope").closest("fieldset")!.querySelector("select")!, {
        target: { value: "directory" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Choose directory…" }));
      fireEvent.click(await screen.findByRole("button", { name: "Use this directory" }));
      // (the "a path is required" guard also renders role="alert" here, so
      // match on the text of this specific refusal)
      expect(await screen.findByText(/outside the chosen workspace/i)).toBeInTheDocument();
      expect((screen.getByLabelText(/scope path/i) as HTMLInputElement).value).toBe("");
    });

    it("stores multi-selected files as a comma-separated relative list, still hand-editable", async () => {
      vi.spyOn(client.glimmerApi, "listDirectory").mockResolvedValue({
        root: "/tmp/ws",
        path: "/tmp/ws/src",
        parent: "/tmp/ws",
        entries: [{ name: "a.ts", isDir: false }, { name: "b.ts", isDir: false }],
        truncated: false,
      });
      render(withQuery(<NewTaskScreen />));
      fireEvent.change(screen.getByLabelText("Workspace path"), { target: { value: "/tmp/ws" } });
      fireEvent.change(screen.getByText("Scope").closest("fieldset")!.querySelector("select")!, {
        target: { value: "files" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Choose files…" }));
      fireEvent.click(await screen.findByLabelText("a.ts"));
      fireEvent.click(screen.getByLabelText("b.ts"));
      fireEvent.click(screen.getByRole("button", { name: /Use 2 selected files/ }));

      const scopeInput = screen.getByLabelText(/scope path/i) as HTMLInputElement;
      expect(scopeInput.value).toBe("src/a.ts, src/b.ts");
      fireEvent.change(scopeInput, { target: { value: "src/a.ts" } });
      expect(scopeInput.value).toBe("src/a.ts");
    });
  });

  // Task 2.1 fix round 1 (V7 §5.5): composer preview of the orchestrator's
  // risk-based architect auto-trigger.
  describe("architect-risk preview", () => {
    it("shows nothing at the default form state (multi_package_scope alone is below threshold)", () => {
      render(withQuery(<NewTaskScreen />));
      expect(screen.queryByText(/architect mode will auto-trigger/i)).not.toBeInTheDocument();
    });

    it("shows the deterministic score/signals line once the score crosses the threshold", () => {
      render(withQuery(<NewTaskScreen />));
      // Default scopePackage is already "repository" (multi_package_scope, +2);
      // switching mode to "refactor" (+3) crosses the threshold of 5.
      fireEvent.change(screen.getByText("Mode").closest("fieldset")!.querySelector("select")!, {
        target: { value: "refactor" },
      });
      expect(
        screen.getByText("Architect mode will auto-trigger (score 5: mode_refactor, multi_package_scope)")
      ).toBeInTheDocument();
    });
  });
});
