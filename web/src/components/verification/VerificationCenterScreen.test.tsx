import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GlimmerSession, VerificationCheckResult } from "@glimmer/shared";
import { VerificationCenterScreen } from "./VerificationCenterScreen";
import * as client from "../../api/client";

afterEach(() => vi.restoreAllMocks());

function withProviders(path: string, route: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={<VerificationCenterScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function check(overrides: Partial<VerificationCheckResult>): VerificationCheckResult {
  return {
    command: "npm test",
    status: "PASS",
    ok: true,
    returncode: 0,
    elapsedSeconds: 1.2,
    outputTail: "",
    baselineAware: false,
    newErrorSignatures: [],
    ...overrides,
  };
}

function session(overrides: Partial<GlimmerSession>): GlimmerSession {
  return {
    id: "s1",
    task: "Fix dialog parser",
    status: "verified",
    workspace: "/ws",
    branch: "glimmer/x",
    baselineSha: "abc",
    changedFiles: [],
    verification: { overall: "VERIFIED", checks: [] },
    repairsUsed: 0,
    repairBudget: 2,
    finalStatus: {
      functional: "VERIFIED",
      visual: "not_run",
      architecture: "not_run",
      documentation: "not_run",
    },
    ...overrides,
  };
}

describe("VerificationCenterScreen", () => {
  it("with no :id, falls back to the latest global session via getStatus (sidebar link behavior)", async () => {
    const getStatusSpy = vi.spyOn(client.glimmerApi, "getStatus").mockResolvedValue({
      model: { status: "UNKNOWN", endpoint: "", provenance: "deterministic-backend" },
      activeSession: null,
      latestSession: null,
      recentSessions: [],
      verification: { overall: "VERIFIED", checks: [check({ command: "git diff --check" })] },
    } as any);
    const getSessionSpy = vi.spyOn(client.glimmerApi, "getSession");

    render(withProviders("/verification", "/verification"));

    await waitFor(() => expect(screen.getByText("git diff --check")).toBeInTheDocument());
    expect(getStatusSpy).toHaveBeenCalled();
    expect(getSessionSpy).not.toHaveBeenCalled();
  });

  it("with :id, uses the session's own verification summary via getSession, not the global status route", async () => {
    const getStatusSpy = vi.spyOn(client.glimmerApi, "getStatus");
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue(
      session({
        verification: {
          overall: "FAILED",
          checks: [check({ command: "vitest", status: "CODE_FAIL", ok: false })],
        },
      }),
    );

    render(withProviders("/sessions/s1/verification", "/sessions/:id/verification"));

    await waitFor(() => expect(screen.getByText("vitest")).toBeInTheDocument());
    expect(getStatusSpy).not.toHaveBeenCalled();
  });

  it("renders the overall VERIFIED banner distinctly from FAILED", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue(
      session({
        verification: { overall: "VERIFIED", checks: [check({})] },
      }),
    );
    render(withProviders("/sessions/s1/verification", "/sessions/:id/verification"));
    await waitFor(() => expect(screen.getByText("VERIFIED")).toBeInTheDocument());
  });

  it("renders PASS_BASELINE distinct from a clean PASS", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue(
      session({
        verification: {
          overall: "PARTIAL",
          checks: [
            check({ command: "git diff --check", status: "PASS", ok: true }),
            check({
              command: "npm run typecheck",
              status: "PASS_BASELINE",
              ok: true,
              baselineAware: true,
            }),
          ],
        },
      }),
    );
    render(withProviders("/sessions/s1/verification", "/sessions/:id/verification"));

    await waitFor(() => expect(screen.getByText("PASS")).toBeInTheDocument());
    expect(screen.getByText("PASS (baseline)")).toBeInTheDocument();
  });

  it("labels a baseline-aware check with new error signatures as NEW FAILURE, not a pass", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue(
      session({
        verification: {
          overall: "FAILED",
          checks: [
            check({
              command: "npm run typecheck",
              status: "PASS_BASELINE",
              ok: true,
              baselineAware: true,
              newErrorSignatures: ["TS2345: new error"],
            }),
          ],
        },
      }),
    );
    render(withProviders("/sessions/s1/verification", "/sessions/:id/verification"));
    await waitFor(() => expect(screen.getByText("NEW FAILURE")).toBeInTheDocument());
  });

  it("surfaces the baseline-aware summary: count of baseline-accepted checks and total new error signatures", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue(
      session({
        verification: {
          overall: "PARTIAL",
          checks: [
            check({
              command: "a",
              status: "PASS_BASELINE",
              baselineAware: true,
              newErrorSignatures: [],
            }),
            check({
              command: "b",
              status: "PASS_BASELINE",
              baselineAware: true,
              newErrorSignatures: ["e1", "e2"],
            }),
            check({ command: "c", status: "PASS", ok: true }),
          ],
        },
      }),
    );
    render(withProviders("/sessions/s1/verification", "/sessions/:id/verification"));

    await waitFor(() =>
      expect(screen.getByText(/2 pre-existing failures accepted via baseline/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/2 NEW failures introduced/)).toBeInTheDocument();
  });

  it("shows an honest zero-state 'No new failures introduced' only once checks actually ran", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue(
      session({
        verification: { overall: "VERIFIED", checks: [check({})] },
      }),
    );
    render(withProviders("/sessions/s1/verification", "/sessions/:id/verification"));
    await waitFor(() => expect(screen.getByText(/No new failures introduced/)).toBeInTheDocument());
  });

  it("never shows the zero-state or a success banner when verification never ran (NOT_RUN with no checks)", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue(
      session({
        verification: { overall: "NOT_RUN", checks: [] },
      }),
    );
    render(withProviders("/sessions/s1/verification", "/sessions/:id/verification"));

    await waitFor(() => expect(screen.getByText("NOT_RUN")).toBeInTheDocument());
    expect(screen.queryByText(/No new failures introduced/)).not.toBeInTheDocument();
    expect(screen.queryByText("VERIFIED")).not.toBeInTheDocument();
  });

  it("renders an individual NOT_RUN check as not-run, never blended into FAIL", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue(
      session({
        verification: {
          overall: "PARTIAL",
          checks: [check({ command: "e2e", status: "NOT_RUN", ok: false })],
        },
      }),
    );
    render(withProviders("/sessions/s1/verification", "/sessions/:id/verification"));
    await waitFor(() => expect(screen.getByText("NOT RUN")).toBeInTheDocument());
    expect(screen.queryByText("FAIL")).not.toBeInTheDocument();
  });

  it("shows recommended checks in a separate muted section, never mixed into the gating checks list", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue(
      session({
        verification: {
          overall: "VERIFIED",
          checks: [check({ command: "npm run typecheck" })],
          recommendedChecks: [check({ command: "npm run lint", status: "CODE_FAIL", ok: false })],
        },
      }),
    );
    render(withProviders("/sessions/s1/verification", "/sessions/:id/verification"));

    await waitFor(() => expect(screen.getByText("npm run typecheck")).toBeInTheDocument());
    expect(screen.getByText("npm run lint")).toBeInTheDocument();
    expect(screen.getByText("Recommended (non-gating)")).toBeInTheDocument();
    // overall banner stays VERIFIED even though a recommended check failed --
    // recommended never gates.
    expect(screen.getByText("VERIFIED")).toBeInTheDocument();
  });

  it("renders no recommended section when there are no recommended checks (absent or empty)", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue(
      session({
        verification: { overall: "VERIFIED", checks: [check({})] },
      }),
    );
    render(withProviders("/sessions/s1/verification", "/sessions/:id/verification"));

    await waitFor(() => expect(screen.getByText("VERIFIED")).toBeInTheDocument());
    expect(screen.queryByText("Recommended (non-gating)")).not.toBeInTheDocument();
  });

  it("shows command, returncode, elapsed, and a collapsible output tail per check", async () => {
    vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue(
      session({
        verification: {
          overall: "FAILED",
          checks: [
            check({
              command: "vitest",
              status: "CODE_FAIL",
              ok: false,
              returncode: 1,
              elapsedSeconds: 3.4,
              outputTail: "1 test failed",
            }),
          ],
        },
      }),
    );
    render(withProviders("/sessions/s1/verification", "/sessions/:id/verification"));

    await waitFor(() => expect(screen.getByText("vitest")).toBeInTheDocument());
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("3.4s")).toBeInTheDocument();
    const summary = screen.getByText("Output");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("1 test failed")).toBeInTheDocument();
  });

  // V7 §22.17
  describe("finalStatus 4-cell gate row", () => {
    it("renders all 4 cells from the session's finalStatus", async () => {
      vi.spyOn(client.glimmerApi, "getSession").mockResolvedValue(
        session({
          verification: { overall: "VERIFIED", checks: [check({})] },
          finalStatus: {
            functional: "VERIFIED",
            visual: "PASS_WITH_WARNINGS",
            architecture: "approved",
            documentation: "not_run",
          },
        }),
      );
      render(withProviders("/sessions/s1/verification", "/sessions/:id/verification"));

      await waitFor(() => expect(screen.getByText(/Functional: VERIFIED/)).toBeInTheDocument());
      expect(screen.getByText(/Visual: PASS_WITH_WARNINGS/)).toBeInTheDocument();
      expect(screen.getByText(/Architecture: approved/)).toBeInTheDocument();
      expect(screen.getByText(/Documentation: not_run/)).toBeInTheDocument();
    });

    it("renders nothing extra with no :id (global status has no finalStatus to compose from)", async () => {
      vi.spyOn(client.glimmerApi, "getStatus").mockResolvedValue({
        model: { status: "UNKNOWN", endpoint: "", provenance: "deterministic-backend" },
        activeSession: null,
        latestSession: null,
        recentSessions: [],
        verification: { overall: "VERIFIED", checks: [check({})] },
      } as any);
      render(withProviders("/verification", "/verification"));

      await waitFor(() => expect(screen.getByText("VERIFIED")).toBeInTheDocument());
      expect(screen.queryByText(/Functional:/)).not.toBeInTheDocument();
    });
  });
});
