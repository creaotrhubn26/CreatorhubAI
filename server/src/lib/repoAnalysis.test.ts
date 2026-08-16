import { describe, it, expect } from "vitest";
import { inferArea, suggestVerification, computeRiskScore, computeScopeGuard } from "./repoAnalysis.js";
import type { RepoMap, ChangedFile, TaskContract } from "@glimmer/shared";

const REPO_MAP: RepoMap = {
  generatedAt: "2026-08-17T00:00:00Z",
  workspace: "/ws",
  branch: "glimmer/x",
  head: "abc",
  upstream: null,
  packages: [
    { path: "frontend/package.json", dir: "frontend", name: "creatorhub-frontend", scripts: { typecheck: "tsc --noEmit", "test:unit": "vitest run" }, frameworks: ["React", "Vite"], engines: null, workspaces: null },
    { path: "backend/package.json", dir: "backend", name: "creatorhub-backend", scripts: { build: "tsc" }, frameworks: [], engines: null, workspaces: null },
  ],
};

describe("inferArea", () => {
  it("matches by explicit scope.area path prefix", () => {
    const result = inferArea({ package: "directory", area: "frontend/client/src/dialog" }, REPO_MAP);
    expect(result.area).toBe("frontend");
    expect(result.package?.name).toBe("creatorhub-frontend");
  });

  it("matches by scope.package enum when no area given", () => {
    const result = inferArea({ package: "backend" }, REPO_MAP);
    expect(result.package?.name).toBe("creatorhub-backend");
  });

  it("returns nulls when nothing matches or repoMap is unavailable", () => {
    expect(inferArea({ package: "repository" }, null)).toEqual({ area: null, package: null });
    expect(inferArea({ package: "repository" }, REPO_MAP)).toEqual({ area: null, package: null });
  });
});

describe("suggestVerification", () => {
  it("suggests frontend-typecheck when the package has a typecheck script", () => {
    expect(suggestVerification(REPO_MAP.packages[0])).toContain("frontend-typecheck");
  });

  it("suggests targeted-test when the package has a test script", () => {
    expect(suggestVerification(REPO_MAP.packages[0])).toContain("targeted-test");
  });

  it("suggests nothing for a package with neither script, or a null package", () => {
    expect(suggestVerification(REPO_MAP.packages[1])).toEqual([]);
    expect(suggestVerification(null)).toEqual([]);
  });
});

function files(...paths: string[]): ChangedFile[] {
  return paths.map((path) => ({ path, status: "modified" as const }));
}

describe("computeRiskScore", () => {
  it("is LOW for a small, ordinary change", () => {
    expect(computeRiskScore(files("frontend/src/Button.tsx"), REPO_MAP)).toBe("LOW");
  });

  it("is MEDIUM when package.json changes", () => {
    expect(computeRiskScore(files("frontend/package.json"), REPO_MAP)).toBe("MEDIUM");
  });

  it("is MEDIUM when the change spans more than one package", () => {
    expect(computeRiskScore(files("frontend/src/a.tsx", "backend/src/b.ts"), REPO_MAP)).toBe("MEDIUM");
  });

  it("is HIGH when a lockfile changes", () => {
    expect(computeRiskScore(files("frontend/package-lock.json"), REPO_MAP)).toBe("HIGH");
  });

  it("is HIGH when a migration file changes", () => {
    expect(computeRiskScore(files("backend/migrations/003_add_column.sql"), REPO_MAP)).toBe("HIGH");
  });

  it("is HIGH when an auth/security path changes", () => {
    expect(computeRiskScore(files("backend/src/auth/session.ts"), REPO_MAP)).toBe("HIGH");
  });

  it("is CRITICAL when two distinct high-risk signals fire together", () => {
    expect(computeRiskScore(files("frontend/package-lock.json", "backend/src/auth/session.ts"), REPO_MAP)).toBe("CRITICAL");
  });

  it("is LOW for an empty change set", () => {
    expect(computeRiskScore([], REPO_MAP)).toBe("LOW");
  });
});

const CONTRACT_SCOPE_DIR: TaskContract["scope"] = { package: "directory", area: "frontend/client/src/dialog" };

describe("computeScopeGuard", () => {
  it("reports in-scope when every changed file is under the expected prefix", () => {
    const result = computeScopeGuard(CONTRACT_SCOPE_DIR, files("frontend/client/src/dialog/Dialog.tsx"), REPO_MAP);
    expect(result.inScope).toBe(true);
    expect(result.expandedFiles).toEqual([]);
  });

  it("reports scope expansion when a changed file falls outside the expected prefix", () => {
    const result = computeScopeGuard(
      CONTRACT_SCOPE_DIR,
      files("frontend/client/src/dialog/Dialog.tsx", "backend/src/unrelated.ts"),
      REPO_MAP
    );
    expect(result.inScope).toBe(false);
    expect(result.expandedFiles).toEqual(["backend/src/unrelated.ts"]);
  });

  it("has no meaningful boundary for repository-wide scope — always in scope", () => {
    const result = computeScopeGuard({ package: "repository" }, files("anything/anywhere.ts"), REPO_MAP);
    expect(result.inScope).toBe(true);
    expect(result.expected).toEqual([]);
  });

  it("derives an expected prefix from scope.package when no explicit paths/area are given", () => {
    const result = computeScopeGuard({ package: "backend" }, files("frontend/src/a.tsx"), REPO_MAP);
    expect(result.inScope).toBe(false);
    expect(result.expected).toEqual(["backend"]);
  });
});
