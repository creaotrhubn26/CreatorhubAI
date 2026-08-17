import type { RepoMap, RepoPackage, ChangedFile, TaskContract, RiskLevel, ScopeGuardResult } from "@glimmer/shared";

export interface AreaGuess {
  area: string | null;
  package: RepoPackage | null;
}

function findPackage(repoMap: RepoMap, needle: string): RepoPackage | undefined {
  const lower = needle.toLowerCase();
  return repoMap.packages
    .filter((p) => lower.startsWith(p.dir.toLowerCase()) || p.dir.toLowerCase().startsWith(lower))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}

export function inferArea(scope: TaskContract["scope"], repoMap: RepoMap | null): AreaGuess {
  if (!repoMap || repoMap.packages.length === 0) return { area: null, package: null };
  const hint = scope.area ?? scope.paths?.[0];
  if (hint) {
    const pkg = findPackage(repoMap, hint);
    if (pkg) return { area: pkg.dir, package: pkg };
  }
  if (scope.package === "frontend" || scope.package === "backend") {
    const pkg = repoMap.packages.find(
      (p) => p.dir.toLowerCase().includes(scope.package) || p.name.toLowerCase().includes(scope.package)
    );
    if (pkg) return { area: pkg.dir, package: pkg };
  }
  return { area: null, package: null };
}

export function suggestVerification(pkg: RepoPackage | null): string[] {
  if (!pkg) return [];
  const suggestions: string[] = [];
  if ("typecheck" in pkg.scripts) suggestions.push("frontend-typecheck");
  if (Object.keys(pkg.scripts).some((s) => s === "test:unit" || s === "test")) suggestions.push("targeted-test");
  return suggestions;
}

const LOCKFILE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const MIGRATION_RE = /migrat/i;
const AUTH_RE = /\b(auth|permission|security|credential)/i;
const INFRA_RE = /(^|\/)(\.github\/workflows\/|Dockerfile|docker-compose|terraform)/i;
const API_RE = /\b(api|schema|openapi)\b/i;

export function computeRiskScore(changedFiles: ChangedFile[], repoMap: RepoMap | null): RiskLevel {
  const paths = changedFiles.map((f) => f.path);
  let highSignals = 0;
  let medium = false;

  if (paths.length > 8) medium = true;
  if (paths.some((p) => p.endsWith("package.json"))) medium = true;
  if (paths.some((p) => LOCKFILE_RE.test(p))) highSignals++;
  if (paths.some((p) => MIGRATION_RE.test(p))) highSignals++;
  if (paths.some((p) => AUTH_RE.test(p))) highSignals++;
  if (paths.some((p) => INFRA_RE.test(p))) medium = true;
  if (paths.some((p) => API_RE.test(p))) medium = true;

  if (repoMap && repoMap.packages.length > 1) {
    const touched = new Set(
      paths.map((p) => repoMap.packages.find((pkg) => p.startsWith(pkg.dir))?.dir).filter(Boolean)
    );
    if (touched.size > 1) medium = true;
  }

  if (highSignals >= 2) return "CRITICAL";
  if (highSignals === 1) return "HIGH";
  if (medium) return "MEDIUM";
  return "LOW";
}

function expectedPrefixes(scope: TaskContract["scope"], repoMap: RepoMap | null): string[] {
  if (scope.paths && scope.paths.length > 0) return scope.paths;
  if (scope.area) return [scope.area];
  if (scope.package === "frontend" || scope.package === "backend") {
    if (repoMap) {
      const pkg = repoMap.packages.find(
        (p) => p.dir.toLowerCase().includes(scope.package) || p.name.toLowerCase().includes(scope.package)
      );
      if (pkg) return [pkg.dir];
    }
    return [scope.package];
  }
  return []; // repository/directory/files with no explicit path: nothing meaningful to guard against
}

export function computeScopeGuard(
  scope: TaskContract["scope"],
  changedFiles: ChangedFile[],
  repoMap: RepoMap | null
): ScopeGuardResult {
  const expected = expectedPrefixes(scope, repoMap);
  const actual = changedFiles.map((f) => f.path);
  if (expected.length === 0) {
    // F5: "directory"/"files" scope CLAIMS to be bounded to a concrete path,
    // but the composer previously allowed submitting one with no path ever
    // filled in — expectedPrefixes() then has nothing to guard against.
    // Reporting inScope: true here would be indistinguishable from the
    // honest, intentional "repository" scope (no boundary by design) below.
    // Never trust the client on this: report the state as unbounded instead
    // of silently passing every file as "in scope".
    if (scope.package === "directory" || scope.package === "files") {
      return { inScope: false, expected, actual, expandedFiles: [], unbounded: true };
    }
    return { inScope: true, expected, actual, expandedFiles: [] };
  }
  const expandedFiles = actual.filter(
    (p) => !expected.some((prefix) => p === prefix || p.startsWith(prefix.replace(/\/$/, "") + "/"))
  );
  return { inScope: expandedFiles.length === 0, expected, actual, expandedFiles };
}
