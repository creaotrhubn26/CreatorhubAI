import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

const NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/tasks/new", label: "New Task" },
  { to: "/workspaces", label: "Workspaces" },
  { to: "/sessions", label: "Sessions" },
  { to: "/repository", label: "Repository" },
  { to: "/verification", label: "Verification" },
  { to: "/model", label: "Model" },
  { to: "/settings", label: "Settings" },
];

export interface RepoContext {
  repository: string;
  worktree: string;
  baseline: string;
  status: "Clean" | "Dirty";
}

export function AppShell({ repoContext, children }: { repoContext: RepoContext | null; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", minHeight: "100vh" }}>
      <aside style={{ borderRight: "1px solid var(--border)", padding: 16 }}>
        <nav style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 24 }}>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {repoContext ? (
            <>
              <div>{repoContext.repository}</div>
              <div>Worktree</div>
              <div>{repoContext.worktree}</div>
              <div>Baseline</div>
              <div>{repoContext.baseline}</div>
              <div>Status</div>
              <div>{repoContext.status}</div>
            </>
          ) : (
            <div>Not connected</div>
          )}
        </div>
      </aside>
      <main style={{ padding: 24 }}>{children}</main>
    </div>
  );
}
