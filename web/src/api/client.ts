import type {
  DashboardStatus, ModelStatus, GlimmerSession, RepoMap, WorkspaceInfo, TaskContract, TaskIntelligence, SessionAnalysis,
  SessionAssistantAnswer, ArchitecturePlan, ArchitectReview, DeliveryReview, GlimmerTask, HumanAcceptance, CreateWorkspaceResult,
} from "@glimmer/shared";

export const API_BASE = (import.meta as any).env?.VITE_API_BASE ?? "http://127.0.0.1:4317";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export const glimmerApi = {
  getStatus: () => request<DashboardStatus>("/api/status"),
  getModelStatus: () => request<ModelStatus>("/api/model/status"),
  listSessions: () => request<GlimmerSession[]>("/api/sessions"),
  getSession: (id: string) => request<GlimmerSession>(`/api/sessions/${id}`),
  getSessionDiff: (id: string) => request<{ diff: string }>(`/api/sessions/${id}/diff`),
  getSessionAnalysis: (id: string) => request<SessionAnalysis>(`/api/sessions/${id}/analysis`),
  getArchitecturePlan: (id: string) => request<ArchitecturePlan>(`/api/sessions/${id}/plan`),
  getArchitectReviews: (id: string) => request<ArchitectReview[]>(`/api/sessions/${id}/architect-reviews`),
  getDeliveryReview: (id: string) => request<DeliveryReview>(`/api/sessions/${id}/delivery-review`),
  getSessionTasks: (id: string) => request<GlimmerTask[]>(`/api/sessions/${id}/tasks`),
  askSession: (id: string, question: string) =>
    request<SessionAssistantAnswer>(`/api/sessions/${id}/ask`, { method: "POST", body: JSON.stringify({ question }) }),
  getRepositoryMap: () => request<RepoMap>("/api/repository/map"),
  listWorkspaces: () => request<WorkspaceInfo[]>("/api/workspaces"),
  // §27/§4.1 — creates a fresh git worktree+branch off the source repo.
  // Deliberately bypasses the generic `request()` helper: on failure the
  // server may have already created the worktree/branch before a later step
  // failed (never auto-deleted — see lib/git.ts createWorkspace), and names
  // them in the JSON error body. `request()` discards the body on a non-2xx
  // response, which would silently drop that half-created-state detail the
  // user needs to see.
  createWorkspace: async (taskName: string): Promise<CreateWorkspaceResult> => {
    const res = await fetch(`${API_BASE}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskName }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = [body.error, body.workspace && `workspace: ${body.workspace}`, body.branch && `branch: ${body.branch}`]
        .filter(Boolean)
        .join(" — ");
      throw new Error(detail || `POST /api/workspaces failed: ${res.status}`);
    }
    return body as CreateWorkspaceResult;
  },
  createSession: (taskContract: TaskContract, workspace: string) =>
    request<GlimmerSession>("/api/sessions", { method: "POST", body: JSON.stringify({ taskContract, workspace }) }),
  runSession: (id: string) => request<{ started: boolean }>(`/api/sessions/${id}/run`, { method: "POST" }),
  cancelSession: (id: string) => request<{ cancelled: boolean }>(`/api/sessions/${id}/cancel`, { method: "POST" }),
  revertFile: (id: string, path: string) =>
    request<{ reverted: string }>(`/api/sessions/${id}/revert-file`, { method: "POST", body: JSON.stringify({ path }) }),
  // §14 Diff Review — human "accept for review", distinct from technical
  // verification. Gateway-owned; see server/src/lib/sessions.ts.
  acceptSession: (id: string) => request<HumanAcceptance>(`/api/sessions/${id}/accept`, { method: "POST" }),
  getTaskIntelligence: (scopePackage: string, scopeArea?: string) => {
    const params = new URLSearchParams({ scopePackage });
    if (scopeArea) params.set("scopeArea", scopeArea);
    return request<TaskIntelligence>(`/api/task-intelligence?${params.toString()}`);
  },
};
