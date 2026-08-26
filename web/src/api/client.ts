import type {
  DashboardStatus,
  ModelStatus,
  GlimmerSession,
  RepoMap,
  WorkspaceInfo,
  TaskContract,
  TaskIntelligence,
  SessionAnalysis,
  SessionAssistantAnswer,
  ArchitecturePlan,
  ArchitectReview,
  DeliveryReview,
  DeliveryPacket,
  GlimmerTask,
  HumanAcceptance,
  CreateWorkspaceResult,
  VisualVerification,
  TaskOverride,
  EvidenceIndexResponse,
  EvidenceEntryResponse,
  DocGraph,
  DocGraphSource,
  ApprovalRequest,
  FsListing,
  FsFile,
  RepositorySelection,
  ModelRegistry,
  ModelRegistryUpdate,
  SessionDiff,
  HunkReviewResult,
  TaskReport,
  CliIntegrationsStatus,
  DeveloperClientsStatus,
  WorkspaceHandoffClientId,
  WorkspaceHandoffResult,
  McpConfigUpdate,
  McpIntegrationsStatus,
  DiagnosticsStatus,
  GatewayHealth,
  GatewayReadiness,
  RepairResult,
} from "@glimmer/shared";

export const API_BASE = (import.meta as any).env?.VITE_API_BASE ?? "http://127.0.0.1:4317";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    // Preserve the gateway's actionable explanation (for example, that a
    // task workspace is on `main` instead of an isolated `glimmer/*`
    // branch). Dropping the JSON body here used to leave the composer with
    // only an opaque status code, even when the server had already explained
    // exactly how to recover.
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const detail = typeof body?.error === "string" ? body.error : null;
    throw new Error(detail ?? `${init?.method ?? "GET"} ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export type ModelControlResult = ModelStatus & {
  started?: boolean;
  stopped?: boolean;
  pid?: number;
  error?: string;
  // Why a stop reported `stopped: false` — nothing was running, or the target
  // survived the attempt. Present only in that case.
  detail?: string;
};

async function modelControl(action: "start" | "stop"): Promise<ModelControlResult> {
  const res = await fetch(`${API_BASE}/api/model/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  // 409 = already running / already coming up: a real state, not a failure.
  if (!res.ok && res.status !== 409) {
    throw new Error(body.error || `POST /api/model/${action} failed: ${res.status}`);
  }
  return body as ModelControlResult;
}

// Shared POST+SSE reader for session and repository-selection asks. The two
// routes differ only in their evidence source/body; transport failure and
// upstream error-frame semantics must stay byte-identical so the assistant
// component's fallback decision cannot drift between them.
async function streamAssistant(
  path: string,
  body: unknown,
  onDelta: (delta: string) => void,
): Promise<string> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`POST ${path} failed: ${res.status}`);

  let full = "";
  let sawDone = false;
  function processLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof parsed.delta === "string") {
      full += parsed.delta;
      onDelta(parsed.delta);
    } else if (parsed.done) {
      sawDone = true;
      if (typeof parsed.answer === "string") full = parsed.answer;
    } else if (parsed.error) {
      const err = new Error(parsed.error);
      err.name = "AssistantUpstreamError";
      throw err;
    }
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    }
    processLine(buffer);
  } finally {
    reader.cancel().catch(() => {});
  }
  if (!sawDone) throw new Error("stream ended before the done frame");
  return full;
}

export const glimmerApi = {
  getHealth: () => request<GatewayHealth>("/api/health"),
  getReadiness: () => request<GatewayReadiness>("/api/ready"),
  getDiagnostics: () => request<DiagnosticsStatus>("/api/diagnostics"),
  repairInstallation: () => request<RepairResult>("/api/diagnostics/repair", { method: "POST" }),
  downloadSupportBundle: async () => {
    const response = await fetch(`${API_BASE}/api/diagnostics/support-bundle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) throw new Error(`Support export failed: ${response.status}`);
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "glimmer-support.json";
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
    return filename;
  },
  getStatus: () => request<DashboardStatus>("/api/status"),
  getCliIntegrations: () => request<CliIntegrationsStatus>("/api/integrations/cli"),
  getDeveloperClients: () => request<DeveloperClientsStatus>("/api/integrations/developer-clients"),
  openWorkspace: (clientId: WorkspaceHandoffClientId, workspace: string) =>
    request<WorkspaceHandoffResult>("/api/workspaces/open", {
      method: "POST",
      body: JSON.stringify({ clientId, workspace }),
    }),
  getMcpIntegrations: () => request<McpIntegrationsStatus>("/api/integrations/mcp"),
  saveMcpIntegrations: (update: McpConfigUpdate) =>
    request<McpIntegrationsStatus>("/api/integrations/mcp", {
      method: "PUT",
      body: JSON.stringify(update),
    }),
  getModelStatus: () => request<ModelStatus>("/api/model/status"),
  getModelRegistry: () => request<ModelRegistry>("/api/models/config"),
  saveModelRegistry: (registry: ModelRegistryUpdate) =>
    request<ModelRegistry>("/api/models/config", { method: "PUT", body: JSON.stringify(registry) }),
  listSessions: () => request<GlimmerSession[]>("/api/sessions"),
  getSession: (id: string) => request<GlimmerSession>(`/api/sessions/${id}`),
  getSessionDiff: (id: string) => request<SessionDiff>(`/api/sessions/${id}/diff`),
  getSessionAnalysis: (id: string) => request<SessionAnalysis>(`/api/sessions/${id}/analysis`),
  getArchitecturePlan: (id: string) => request<ArchitecturePlan>(`/api/sessions/${id}/plan`),
  getTaskReport: (id: string) => request<TaskReport>(`/api/sessions/${id}/task-report`),
  getArchitectReviews: (id: string) =>
    request<ArchitectReview[]>(`/api/sessions/${id}/architect-reviews`),
  getDeliveryReview: (id: string) => request<DeliveryReview>(`/api/sessions/${id}/delivery-review`),
  // Task 8.2 (V7 §23.16) -- the concise session close-out handoff document.
  getDeliveryPacket: (id: string) => request<DeliveryPacket>(`/api/sessions/${id}/delivery-packet`),
  getSessionTasks: (id: string) => request<GlimmerTask[]>(`/api/sessions/${id}/tasks`),
  // Task 5.2 (V7 §26/§46) -- evidence-index.json list + one capped
  // entry lookup by id, same one-route-two-shapes split as the server
  // route (see server/src/routes/sessions.ts).
  getEvidenceIndex: (id: string) => request<EvidenceIndexResponse>(`/api/sessions/${id}/evidence`),
  getEvidenceEntry: (id: string, evidenceId: string) =>
    request<EvidenceEntryResponse>(
      `/api/sessions/${id}/evidence?id=${encodeURIComponent(evidenceId)}`,
    ),
  // Task 4.3 — human skip/approve, gateway-owned (see server/src/lib/
  // sessions.ts writeTaskOverride). One-shot: a second click just replaces
  // the prior override, no undo.
  skipTask: (id: string, taskId: string) =>
    request<{ taskId: string } & TaskOverride>(`/api/sessions/${id}/tasks/${taskId}/skip`, {
      method: "POST",
    }),
  approveTask: (id: string, taskId: string) =>
    request<{ taskId: string } & TaskOverride>(`/api/sessions/${id}/tasks/${taskId}/approve`, {
      method: "POST",
    }),
  // Task 8.3 (V7 §14/§35) -- human approve/deny for a YELLOW-classified
  // action glimmer-engineer.py is currently blocked on (approvals.json).
  // One-shot per approvalId: a second click on an already-resolved id is a
  // gateway-side no-op (see resolveApproval), not an error.
  approveApproval: (id: string, approvalId: string) =>
    request<{ approvalId: string } & ApprovalRequest>(
      `/api/sessions/${id}/approvals/${approvalId}/approve`,
      { method: "POST" },
    ),
  denyApproval: (id: string, approvalId: string) =>
    request<{ approvalId: string } & ApprovalRequest>(
      `/api/sessions/${id}/approvals/${approvalId}/deny`,
      { method: "POST" },
    ),
  // V7 §22.16 -- bypasses the generic request() helper (which throws on any
  // non-2xx) because 404 here is the honest, common "never ran
  // glimmer-visual.py" case a panel needs to render as "Not run", not an
  // error to surface.
  getVisualVerification: async (id: string): Promise<VisualVerification | null> => {
    const res = await fetch(`${API_BASE}/api/sessions/${id}/visual/manifest`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET /api/sessions/${id}/visual/manifest failed: ${res.status}`);
    return res.json() as Promise<VisualVerification>;
  },
  // Full-size screenshot URL — opened directly (new tab / <img src>), never
  // fetched through request().
  visualScreenshotUrl: (id: string, file: string) =>
    `${API_BASE}/api/sessions/${id}/visual/screenshot/${encodeURIComponent(file)}`,
  askSession: (id: string, question: string) =>
    request<SessionAssistantAnswer>(`/api/sessions/${id}/ask`, {
      method: "POST",
      body: JSON.stringify({ question }),
    }),
  askSessionStream: (id: string, question: string, onDelta: (delta: string) => void) =>
    streamAssistant(`/api/sessions/${id}/ask?stream=1`, { question }, onDelta),
  askRepository: (selection: RepositorySelection, question: string) =>
    request<SessionAssistantAnswer>("/api/repository/ask", {
      method: "POST",
      body: JSON.stringify({ question, selection }),
    }),
  askRepositoryStream: (
    selection: RepositorySelection,
    question: string,
    onDelta: (delta: string) => void,
  ) => streamAssistant("/api/repository/ask?stream=1", { question, selection }, onDelta),
  getRepositoryMap: () => request<RepoMap>("/api/repository/map"),
  // Task 7.5 (V7 "System Explorer") -- bypasses request() the same way
  // getVisualVerification does: 404 (no session's workspace carries a
  // docs/graph.json — the common "repo never ran --docs-bootstrap" case)
  // is an honest "no graph" fact for the screen to render, not a fetch error.
  // M6 fix: response carries `source` (the workspace + session the graph was
  // actually read from) so the screen can label it instead of presenting a
  // "first found" graph as unambiguously "this repository".
  getDocGraph: async (): Promise<(DocGraph & { source: DocGraphSource }) | null> => {
    const res = await fetch(`${API_BASE}/api/repository/doc-graph`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET /api/repository/doc-graph failed: ${res.status}`);
    return res.json() as Promise<DocGraph & { source: DocGraphSource }>;
  },
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
      const detail = [
        body.error,
        body.workspace && `workspace: ${body.workspace}`,
        body.branch && `branch: ${body.branch}`,
      ]
        .filter(Boolean)
        .join(" — ");
      throw new Error(detail || `POST /api/workspaces failed: ${res.status}`);
    }
    return body as CreateWorkspaceResult;
  },
  createSession: (taskContract: TaskContract, workspace: string) =>
    request<GlimmerSession>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ taskContract, workspace }),
    }),
  runSession: (id: string) =>
    request<{ started: boolean }>(`/api/sessions/${id}/run`, { method: "POST" }),
  cancelSession: (id: string) =>
    request<{ cancelled: boolean }>(`/api/sessions/${id}/cancel`, { method: "POST" }),
  revertFile: (id: string, path: string) =>
    request<{ reverted: string }>(`/api/sessions/${id}/revert-file`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  acceptHunk: (id: string, hunkId: string, path: string) =>
    request<HunkReviewResult>(`/api/sessions/${id}/hunks/${hunkId}/accept`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  rejectHunk: (id: string, hunkId: string, path: string) =>
    request<HunkReviewResult>(`/api/sessions/${id}/hunks/${hunkId}/reject`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  // §14 Diff Review — human "accept for review", distinct from technical
  // verification. Gateway-owned; see server/src/lib/sessions.ts.
  acceptSession: (id: string) =>
    request<HumanAcceptance>(`/api/sessions/${id}/accept`, { method: "POST" }),
  // Model server process control. Both bypass the generic request() helper:
  // "already running" (409 from start) is an honest current-state answer the
  // screen renders, not an error — the body carries the same ModelStatus
  // shape as a success, so the caller never has to invent one.
  startModelServer: () => modelControl("start"),
  stopModelServer: () => modelControl("stop"),
  // Task 4c(a): the composer passes its live mode/objective/verificationLevel
  // (the risk hints the endpoint requires before it will score anything) and
  // the workspace being composed against, so the panel stops rendering a
  // permanently-null risk and a possibly-unrelated repo's areas.
  getTaskIntelligence: (params: {
    scopePackage: string;
    scopeArea?: string;
    workspace?: string;
    mode?: string;
    objective?: string;
    verificationLevel?: string;
    candidateCount?: number;
  }) => {
    const query = new URLSearchParams({ scopePackage: params.scopePackage });
    if (params.scopeArea) query.set("scopeArea", params.scopeArea);
    if (params.workspace) query.set("workspace", params.workspace);
    if (params.mode) query.set("mode", params.mode);
    if (params.objective) query.set("objective", params.objective);
    if (params.verificationLevel) query.set("verificationLevel", params.verificationLevel);
    if (params.candidateCount !== undefined)
      query.set("candidateCount", String(params.candidateCount));
    return request<TaskIntelligence>(`/api/task-intelligence?${query.toString()}`);
  },
  // Task 4c(2/3): read-only directory listing for the composer's path pickers
  // (browser/dev fallback — the Tauri app uses the native Finder dialog).
  // Bypasses request() for the same reason readFile does: a refusal has a
  // reason ("root must be inside …", "that path is not browsable"), and a
  // status code echoed back with the whole query string is not one.
  listDirectory: async (params: {
    path?: string;
    root?: string;
    includeFiles?: boolean;
  }): Promise<FsListing> => {
    const query = new URLSearchParams();
    if (params.path) query.set("path", params.path);
    if (params.root) query.set("root", params.root);
    if (params.includeFiles) query.set("includeFiles", "1");
    const res = await fetch(`${API_BASE}/api/fs/dirs?${query.toString()}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `GET /api/fs/dirs failed: ${res.status}`);
    return body as FsListing;
  },
  // Task A1/A3: one file's text for the read-only viewer. Bypasses request()
  // — which throws a status-only message — because the viewer must be able to
  // tell the user WHY a read failed ("path is a directory", "permission
  // denied", "path does not exist"), and a failed read must never be able to
  // render as an empty file.
  // No `root` here on purpose (review M1): the gateway picks the root itself —
  // the known workspace containing the path — so the client cannot influence
  // what boundary a content read is checked against.
  readFile: async (params: { path: string }): Promise<FsFile> => {
    const query = new URLSearchParams({ path: params.path });
    const res = await fetch(`${API_BASE}/api/fs/file?${query.toString()}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `GET /api/fs/file failed: ${res.status}`);
    return body as FsFile;
  },
};
