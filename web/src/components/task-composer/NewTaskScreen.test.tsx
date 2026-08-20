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
function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("NewTaskScreen", () => {
  beforeEach(() => {
    // NewTaskScreen now renders TaskIntelligencePanel, which fetches on mount.
    // Stub it so these tests exercise the composer form, not the network.
    vi.spyOn(client.glimmerApi, "getTaskIntelligence").mockResolvedValue({
      likelyArea: null, likelyPackage: null, suggestedVerification: [], estimatedRisk: null, provenance: "deterministic-backend",
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
});
