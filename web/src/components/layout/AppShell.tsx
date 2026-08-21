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
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <div className="app-shell__title">Glimmer</div>
        <nav className="app-shell__nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="app-shell__repo-context mono">
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
      <main className="app-shell__main">{children}</main>
    </div>
  );
}
