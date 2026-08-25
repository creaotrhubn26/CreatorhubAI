import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RiskAndScopeSummary } from "./RiskAndScopeSummary";

describe("RiskAndScopeSummary", () => {
  it("renders the risk level and no scope-expansion notice when in scope", () => {
    render(
      <RiskAndScopeSummary
        analysis={{
          riskScore: "LOW",
          scopeGuard: {
            inScope: true,
            expected: ["frontend"],
            actual: ["frontend/a.ts"],
            expandedFiles: [],
          },
          provenance: "git-derived",
        }}
      />,
    );
    expect(screen.getByText("LOW")).toBeInTheDocument();
    expect(screen.queryByText(/SCOPE EXPANSION/i)).not.toBeInTheDocument();
  });

  it("renders a SCOPE EXPANSION notice with expected vs actual when out of scope", () => {
    render(
      <RiskAndScopeSummary
        analysis={{
          riskScore: "MEDIUM",
          scopeGuard: {
            inScope: false,
            expected: ["frontend/client/src/dialog"],
            actual: ["frontend/client/src/dialog/a.ts", "backend/b.ts"],
            expandedFiles: ["backend/b.ts"],
          },
          provenance: "git-derived",
        }}
      />,
    );
    expect(screen.getByText(/SCOPE EXPANSION/i)).toBeInTheDocument();
    expect(screen.getByText("frontend/client/src/dialog")).toBeInTheDocument();
    expect(screen.getByText("backend/b.ts")).toBeInTheDocument();
  });

  it("renders an explicit 'Unavailable' scope-guard notice when scopeGuard is null, never blank silence", () => {
    render(
      <RiskAndScopeSummary
        analysis={{ riskScore: "LOW", scopeGuard: null, provenance: "git-derived" }}
      />,
    );
    expect(screen.queryByText(/SCOPE EXPANSION/i)).not.toBeInTheDocument();
    // Blank silence under a "Risk & Scope — Live" panel reads as "scope is
    // fine", which is a fabricated claim when no task contract was ever
    // persisted for this session. The unknown state must be visible.
    expect(screen.getByText(/Scope guard: Unavailable/i)).toBeInTheDocument();
  });

  it("renders CRITICAL and HIGH risk distinctly from LOW/MEDIUM", () => {
    const { rerender } = render(
      <RiskAndScopeSummary
        analysis={{ riskScore: "CRITICAL", scopeGuard: null, provenance: "git-derived" }}
      />,
    );
    const criticalClassName = screen.getByText("CRITICAL").className;
    rerender(
      <RiskAndScopeSummary
        analysis={{ riskScore: "LOW", scopeGuard: null, provenance: "git-derived" }}
      />,
    );
    const lowClassName = screen.getByText("LOW").className;
    expect(criticalClassName).not.toBe(lowClassName);
  });

  it("reads the provenance field into the Live caption instead of a fully static string", () => {
    render(
      <RiskAndScopeSummary
        analysis={{ riskScore: "LOW", scopeGuard: null, provenance: "git-derived" }}
      />,
    );
    expect(screen.getByText(/git-derived/)).toBeInTheDocument();
  });

  // F5: directory/files scope with no concrete path can no longer report
  // inScope: true — the gateway now returns unbounded: true instead. Must
  // render an honest "can't verify" notice (mirroring the scopeGuard === null
  // pattern above), never blank silence and never the SCOPE EXPANSION box
  // (which would show misleadingly empty expected/actual/expandedFiles lists).
  it("renders an explicit 'Unbounded' notice, not SCOPE EXPANSION, when scope is directory/files with no concrete path", () => {
    render(
      <RiskAndScopeSummary
        analysis={{
          riskScore: "LOW",
          scopeGuard: {
            inScope: false,
            expected: [],
            actual: ["anything/anywhere.ts"],
            expandedFiles: [],
            unbounded: true,
          },
          provenance: "git-derived",
        }}
      />,
    );
    expect(screen.queryByText(/SCOPE EXPANSION/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Scope guard: Unbounded/i)).toBeInTheDocument();
  });
});
