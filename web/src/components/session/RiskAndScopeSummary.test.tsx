import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RiskAndScopeSummary } from "./RiskAndScopeSummary";

describe("RiskAndScopeSummary", () => {
  it("renders the risk level and no scope-expansion notice when in scope", () => {
    render(<RiskAndScopeSummary analysis={{ riskScore: "LOW", scopeGuard: { inScope: true, expected: ["frontend"], actual: ["frontend/a.ts"], expandedFiles: [] } }} />);
    expect(screen.getByText("LOW")).toBeInTheDocument();
    expect(screen.queryByText(/SCOPE EXPANSION/i)).not.toBeInTheDocument();
  });

  it("renders a SCOPE EXPANSION notice with expected vs actual when out of scope", () => {
    render(<RiskAndScopeSummary analysis={{ riskScore: "MEDIUM", scopeGuard: { inScope: false, expected: ["frontend/client/src/dialog"], actual: ["frontend/client/src/dialog/a.ts", "backend/b.ts"], expandedFiles: ["backend/b.ts"] } }} />);
    expect(screen.getByText(/SCOPE EXPANSION/i)).toBeInTheDocument();
    expect(screen.getByText("frontend/client/src/dialog")).toBeInTheDocument();
    expect(screen.getByText("backend/b.ts")).toBeInTheDocument();
  });

  it("renders nothing scope-related when scopeGuard is null (no contract on record)", () => {
    render(<RiskAndScopeSummary analysis={{ riskScore: "LOW", scopeGuard: null }} />);
    expect(screen.queryByText(/SCOPE EXPANSION/i)).not.toBeInTheDocument();
  });

  it("renders CRITICAL and HIGH risk distinctly from LOW/MEDIUM", () => {
    const { rerender } = render(<RiskAndScopeSummary analysis={{ riskScore: "CRITICAL", scopeGuard: null }} />);
    const criticalClassName = screen.getByText("CRITICAL").className;
    rerender(<RiskAndScopeSummary analysis={{ riskScore: "LOW", scopeGuard: null }} />);
    const lowClassName = screen.getByText("LOW").className;
    expect(criticalClassName).not.toBe(lowClassName);
  });
});
