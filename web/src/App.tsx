import { Routes, Route } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { DashboardScreen } from "./components/dashboard/DashboardScreen";
import { NewTaskScreen } from "./components/task-composer/NewTaskScreen";
import { ActiveSessionScreen } from "./components/session/ActiveSessionScreen";
import { DiffReviewScreen } from "./components/diff/DiffReviewScreen";
import { VerificationCenterScreen } from "./components/verification/VerificationCenterScreen";
import { RepositoryMapScreen } from "./components/repository/RepositoryMapScreen";
import { SessionHistoryScreen } from "./components/history/SessionHistoryScreen";
import { ModelStatusScreen } from "./components/model/ModelStatusScreen";
import { SettingsScreen } from "./components/settings/SettingsScreen";

export function App() {
  return (
    <AppShell repoContext={null}>
      <Routes>
        <Route path="/" element={<DashboardScreen />} />
        <Route path="/tasks/new" element={<NewTaskScreen />} />
        <Route path="/workspaces" element={<SessionHistoryScreen />} />
        <Route path="/sessions" element={<SessionHistoryScreen />} />
        <Route path="/sessions/:id" element={<ActiveSessionScreen />} />
        <Route path="/sessions/:id/diff" element={<DiffReviewScreen />} />
        <Route path="/verification" element={<VerificationCenterScreen />} />
        <Route path="/repository" element={<RepositoryMapScreen />} />
        <Route path="/model" element={<ModelStatusScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
      </Routes>
    </AppShell>
  );
}
