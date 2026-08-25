import { Routes, Route } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AppShell, type RepoContext } from "./components/layout/AppShell";
import { glimmerApi } from "./api/client";
import { DashboardScreen } from "./components/dashboard/DashboardScreen";
import { NewTaskScreen } from "./components/task-composer/NewTaskScreen";
import { ActiveSessionScreen } from "./components/session/ActiveSessionScreen";
import { DiffReviewScreen } from "./components/diff/DiffReviewScreen";
import { VerificationCenterScreen } from "./components/verification/VerificationCenterScreen";
import { RepositoryMapScreen } from "./components/repository/RepositoryMapScreen";
import { SystemExplorerScreen } from "./components/system-explorer/SystemExplorerScreen";
import { FileTreeScreen } from "./components/explorer/FileTreeScreen";
import { SessionHistoryScreen } from "./components/history/SessionHistoryScreen";
import { ModelStatusScreen } from "./components/model/ModelStatusScreen";
import { SettingsScreen } from "./components/settings/SettingsScreen";

// The workspaces route dedupes by session workspace, walking sessions
// newest-first, so the first entry is the current/most-recent workspace —
// no separate "latest session" lookup needed.
function useRepoContext(): RepoContext | null {
  const { data: workspaces } = useQuery({
    queryKey: ["workspaces"],
    queryFn: glimmerApi.listWorkspaces,
    refetchInterval: 5000,
  });
  const workspace = workspaces?.[0];
  if (!workspace) return null;
  return {
    repository: workspace.path.split(/[\\/]/).filter(Boolean).pop() ?? workspace.path,
    worktree: workspace.branch,
    baseline: workspace.baselineSha ? workspace.baselineSha.slice(0, 7) : "Unavailable",
    status: workspace.dirty ? "Dirty" : "Clean",
  };
}

export function App() {
  const repoContext = useRepoContext();
  return (
    <AppShell repoContext={repoContext}>
      <Routes>
        <Route path="/" element={<DashboardScreen />} />
        <Route path="/tasks/new" element={<NewTaskScreen />} />
        <Route path="/workspaces" element={<SessionHistoryScreen />} />
        <Route path="/sessions" element={<SessionHistoryScreen />} />
        <Route path="/sessions/:id" element={<ActiveSessionScreen />} />
        <Route path="/sessions/:id/diff" element={<DiffReviewScreen />} />
        <Route path="/sessions/:id/verification" element={<VerificationCenterScreen />} />
        <Route path="/verification" element={<VerificationCenterScreen />} />
        <Route path="/files" element={<FileTreeScreen />} />
        <Route path="/repository" element={<RepositoryMapScreen />} />
        <Route path="/system-explorer" element={<SystemExplorerScreen />} />
        <Route path="/model" element={<ModelStatusScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
      </Routes>
    </AppShell>
  );
}
