import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { GlimmerEvent, GlimmerSession } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { SessionEventsContext, useSessionEvents } from "../../api/useSessionEvents";
import { statusColor } from "../common/StatusBadge";
import { EmptyState } from "../common/EmptyState";
import { AgentTimeline } from "../session/AgentTimeline";
import { TasksPanel } from "../session/TasksPanel";
import { SessionAssistant } from "../session/SessionAssistant";
import { VerificationBody } from "../verification/VerificationCenterScreen";
import { groupSessionsByDay, isPendingSessionId, relativeTime, sessionTimestamp } from "../../state/sessionListMeta";
import { STATES as RUNNING_STATES } from "../session/AgentStateStepper";
import {
  IconBack, IconChevron, IconClose, IconDashboard, IconForward, IconModel,
  IconNewTask, IconRepository, IconSearch, IconSessions, IconSettings, IconVerification,
} from "../common/Icons";

export interface RepoContext {
  repository: string;
  worktree: string;
  baseline: string;
  status: "Clean" | "Dirty";
}

const OPEN_TABS_KEY = "glimmer.openTabs";
const RIGHT_PANEL_COLLAPSED_KEY = "glimmer.rightPanelCollapsed";
const MAX_TABS = 6;

// Session ids are `YYYYMMDD-HHMMSS-glimmer-<task-slug>` — long enough that
// showing them in full would blow out a tab or breadcrumb. Keep the
// timestamp (which sorts/identifies) and a short slug tail.
function shortSessionId(id: string): string {
  const marker = "-glimmer-";
  const idx = id.indexOf(marker);
  if (idx === -1) return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
  const stamp = id.slice(0, idx);
  const slug = id.slice(idx + marker.length);
  return `${stamp}…${slug.length > 12 ? slug.slice(-12) : slug}`;
}

// A running/active session pulses its status dot and gets the elapsed +
// last-activity line in ActiveSessionScreen. Reuses AgentStateStepper's own
// in-flight-states list so "is this running" is defined in exactly one place.
function isRunningStatus(status: GlimmerSession["status"]): boolean {
  return (RUNNING_STATES as readonly string[]).includes(status);
}

type ActivityKey = "dashboard" | "sessions" | "new-task" | "verification" | "repository" | "model" | "settings";

const ACTIVITY_ITEMS: Array<{ key: ActivityKey; label: string; to: string; Icon: typeof IconDashboard }> = [
  { key: "dashboard", label: "Dashboard", to: "/", Icon: IconDashboard },
  { key: "sessions", label: "Sessions", to: "/sessions", Icon: IconSessions },
  { key: "new-task", label: "New Task", to: "/tasks/new", Icon: IconNewTask },
  { key: "verification", label: "Verification", to: "/verification", Icon: IconVerification },
  { key: "repository", label: "Repository", to: "/repository", Icon: IconRepository },
  { key: "model", label: "Model", to: "/model", Icon: IconModel },
];
const SETTINGS_ITEM = { key: "settings" as const, label: "Settings", to: "/settings", Icon: IconSettings };

function activePageOf(pathname: string): ActivityKey {
  if (pathname === "/settings") return "settings";
  if (pathname === "/verification" || pathname.endsWith("/verification")) return "verification";
  if (pathname === "/tasks/new") return "new-task";
  if (pathname === "/repository") return "repository";
  if (pathname === "/model") return "model";
  if (pathname === "/") return "dashboard";
  if (pathname.startsWith("/sessions") || pathname.startsWith("/workspaces")) return "sessions";
  return "dashboard";
}

function EventsRawList({ events }: { events: GlimmerEvent[] }) {
  if (!events.length) return <div className="ide-bottompanel__empty">No events recorded yet for this session.</div>;
  return (
    <ul>
      {events.map((e) => (
        <li key={e.id} className="row mono" style={{ fontSize: 12 }}>
          <span style={{ color: "var(--text-muted)" }}>{new Date(e.timestamp).toLocaleTimeString()}</span> {e.type}
        </li>
      ))}
    </ul>
  );
}

function Section({
  title, collapsed, onToggle, children, footer,
}: { title: string; collapsed: boolean; onToggle: () => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="ide-section">
      <button className="ide-section__header" onClick={onToggle} aria-expanded={!collapsed}>
        <IconChevron open={!collapsed} /> {title}
      </button>
      {!collapsed && (
        <div className="ide-section__body">
          {children}
          {footer}
        </div>
      )}
    </div>
  );
}

export function AppShell({ repoContext, children }: { repoContext: RepoContext | null; children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();

  const sessionMatch = location.pathname.match(/^\/sessions\/([^/]+)/);
  const activeSessionId = sessionMatch?.[1];
  const activePage = activePageOf(location.pathname);

  const { data: rawSessions } = useQuery({ queryKey: ["sessions"], queryFn: glimmerApi.listSessions, refetchInterval: 5000 });
  // pending-* rows are transient adopted-workspace placeholders — once the
  // real session id shows up they're a duplicate, not a second session, so
  // they never belong in any session-browsing list.
  const sessions = useMemo(() => (rawSessions ?? []).filter((s) => !isPendingSessionId(s.id)), [rawSessions]);
  const { data: modelStatus } = useQuery({ queryKey: ["model-status"], queryFn: glimmerApi.getModelStatus, refetchInterval: 5000 });
  const { data: activeSession } = useQuery({
    queryKey: ["session", activeSessionId],
    queryFn: () => glimmerApi.getSession(activeSessionId!),
    enabled: !!activeSessionId,
    refetchInterval: 4000,
  });
  const events = useSessionEvents(activeSessionId ?? "");
  // lastEventAt: real wall-clock receipt time for the shared context, so any
  // consumer (ActiveSessionScreen's liveness line) can read it. The events
  // array only gets a new reference when useSessionEvents' onmessage handler
  // fires (a real SSE receipt) or when it resets to [] on session switch —
  // so this effect fires exactly on those two occasions, never fabricated.
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  useEffect(() => {
    setLastEventAt(events.length > 0 ? Date.now() : null);
  }, [events]);

  // §5 open-session tabs: which sessions the user has looked at this app
  // session, capped and persisted — real navigation state, not a fabricated
  // "recent files" list.
  const [openTabs, setOpenTabs] = useState<string[]>(() => {
    try {
      return JSON.parse(window.localStorage?.getItem(OPEN_TABS_KEY) ?? "[]");
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      window.localStorage?.setItem(OPEN_TABS_KEY, JSON.stringify(openTabs));
    } catch {
      /* storage unavailable (private mode, disabled, or no window) — tabs just won't persist */
    }
  }, [openTabs]);
  useEffect(() => {
    if (!activeSessionId) return;
    setOpenTabs((prev) => {
      if (prev.includes(activeSessionId)) return prev;
      const next = [...prev, activeSessionId];
      return next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next;
    });
  }, [activeSessionId]);

  function closeTab(id: string) {
    setOpenTabs((prev) => {
      const next = prev.filter((t) => t !== id);
      if (id === activeSessionId) {
        const fallback = next[next.length - 1];
        navigate(fallback ? `/sessions/${fallback}` : "/");
      }
      return next;
    });
  }

  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  function toggleSection(key: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const [bottomTab, setBottomTab] = useState<"timeline" | "verification" | "tasks" | "events">("timeline");
  const [bottomCollapsed, setBottomCollapsed] = useState(false);

  // §10: AI Assistant panel collapses like the bottom panel — persisted so
  // it stays out of the way across reloads once the user closes it.
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(() => {
    try {
      return window.localStorage?.getItem(RIGHT_PANEL_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage?.setItem(RIGHT_PANEL_COLLAPSED_KEY, rightPanelCollapsed ? "1" : "0");
    } catch {
      /* storage unavailable — collapse state just won't persist */
    }
  }, [rightPanelCollapsed]);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const matches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return (sessions ?? []).filter((s) => s.task.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)).slice(0, 8);
  }, [searchQuery, sessions]);

  function openSession(id: string) {
    navigate(`/sessions/${id}`);
    setSearchQuery("");
    setSearchFocused(false);
  }

  const visibleSessions = sessions.slice(0, 12);
  const sidebarGroups = useMemo(() => groupSessionsByDay(visibleSessions), [visibleSessions]);

  return (
    <div className="ide">
      <header className="ide-topbar">
        <div className="ide-topbar__traffic-inset" />
        <div className="ide-topbar__nav">
          <button aria-label="Back" onClick={() => navigate(-1)}><IconBack /></button>
          <button aria-label="Forward" onClick={() => navigate(1)}><IconForward /></button>
        </div>
        <div className="ide-topbar__search">
          <div className="ide-topbar__search-pill">
            <IconSearch />
            <input
              placeholder="Search sessions…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && matches[0]) openSession(matches[0].id);
                if (e.key === "Escape") setSearchQuery("");
              }}
            />
          </div>
          {searchFocused && matches.length > 0 && (
            <div className="ide-topbar__search-results">
              {matches.map((s) => (
                <button
                  key={s.id}
                  className="ide-topbar__search-result"
                  onMouseDown={() => openSession(s.id)}
                >
                  <span className="ide-status-dot" style={{ color: statusColor(s.status) }} />
                  {s.task}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="ide-topbar__right">
          <button className="btn-primary" onClick={() => navigate("/tasks/new")}>New Task</button>
          <Link className="ide-topbar__gear" to="/settings" aria-label="Settings"><IconSettings /></Link>
        </div>
      </header>

      <div className="ide-body">
        <nav className="ide-activitybar">
          {ACTIVITY_ITEMS.map(({ key, label, to, Icon }) => (
            <button
              key={key}
              className={`ide-activitybar__item${activePage === key ? " is-active" : ""}`}
              onClick={() => navigate(to)}
              aria-label={label}
              aria-current={activePage === key ? "page" : undefined}
            >
              <Icon />
              {label}
            </button>
          ))}
          <div className="ide-activitybar__spacer" />
          <button
            className={`ide-activitybar__item${activePage === "settings" ? " is-active" : ""}`}
            onClick={() => navigate(SETTINGS_ITEM.to)}
            aria-label={SETTINGS_ITEM.label}
            aria-current={activePage === "settings" ? "page" : undefined}
          >
            <SETTINGS_ITEM.Icon />
            {SETTINGS_ITEM.label}
          </button>
        </nav>

        <aside className="ide-leftpanel">
          <div className="ide-leftpanel__header">
            GLIMMER
            <span className="ide-leftpanel__workspace">{repoContext?.repository ?? "Not connected"}</span>
          </div>
          <div className="ide-leftpanel__body">
            <Section title="Sessions" collapsed={collapsedSections.has("sessions")} onToggle={() => toggleSection("sessions")}>
              {visibleSessions.length === 0 && <div className="ide-section__link" style={{ color: "var(--text-muted)" }}>Unavailable</div>}
              {sidebarGroups.map((group) => (
                <div key={group.label}>
                  <div className="ide-session-daygroup">{group.label}</div>
                  {group.sessions.map((s) => (
                    <button
                      key={s.id}
                      className={`ide-session-row${s.id === activeSessionId ? " is-active" : ""}`}
                      onClick={() => openSession(s.id)}
                    >
                      <span
                        className={`ide-status-dot${isRunningStatus(s.status) ? " ide-status-dot--pulse" : ""}`}
                        style={{ color: statusColor(s.status) }}
                      />
                      <span className="ide-session-row__main">
                        <span className="ide-session-row__task">{s.task}</span>
                        <span className="ide-session-row__meta">{s.status} · {relativeTime(sessionTimestamp(s))}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
              {sessions.length > visibleSessions.length && (
                <Link className="ide-section__link" to="/sessions">View all sessions →</Link>
              )}
            </Section>

            <Section title="Model" collapsed={collapsedSections.has("model")} onToggle={() => toggleSection("model")}>
              <div className="ide-model-row">
                <span className="ide-status-dot" style={{ color: statusColor(modelStatus?.status ?? "UNKNOWN") }} />
                <span className="ide-model-row__name">Muse Glimmer</span>
                {modelStatus && <span className="mono" style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>{modelStatus.status}</span>}
              </div>
              {modelStatus?.contextSize && (
                <div className="ide-model-row" style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>
                  {modelStatus.contextSize.toLocaleString()} ctx
                </div>
              )}
              <Link className="ide-section__link" to="/model">Model Settings</Link>
            </Section>
          </div>

          <div className="ide-leftpanel__repo">
            {repoContext ? (
              <dl>
                <dt>Worktree</dt><dd className="mono">{repoContext.worktree}</dd>
                <dt>Baseline</dt><dd className="mono">{repoContext.baseline}</dd>
                <dt>Status</dt><dd>{repoContext.status}</dd>
              </dl>
            ) : (
              <div>Not connected</div>
            )}
          </div>
        </aside>

        <div className="ide-editor">
          <div className="ide-tabrow">
            {openTabs.map((id) => {
              const s = sessions?.find((x) => x.id === id);
              const isActive = id === activeSessionId;
              return (
                <div key={id} className={`ide-tab${isActive ? " is-active" : ""}`}>
                  <button className="ide-tab__select" onClick={() => navigate(`/sessions/${id}`)}>
                    <span
                      className={`ide-status-dot${s && isRunningStatus(s.status) ? " ide-status-dot--pulse" : ""}`}
                      style={{ color: statusColor(s?.status ?? "created") }}
                    />
                    <span className="mono">{shortSessionId(id)}</span>
                  </button>
                  <button className="ide-tab__close" aria-label={`Close ${shortSessionId(id)}`} onClick={() => closeTab(id)}>
                    <IconClose />
                  </button>
                </div>
              );
            })}
          </div>

          {repoContext && (
            <div className="ide-breadcrumbs">
              <span>{repoContext.repository}</span>
              <span>›</span>
              <span>{activeSession?.branch ?? repoContext.worktree}</span>
              {activeSessionId && (
                <>
                  <span>›</span>
                  <strong className="mono">{shortSessionId(activeSessionId)}</strong>
                </>
              )}
            </div>
          )}

          <div className="ide-content">
            <SessionEventsContext.Provider value={{ events, lastEventAt }}>{children}</SessionEventsContext.Provider>
          </div>

          <div className="ide-bottompanel">
            <div className="ide-bottompanel__tabs">
              {(["timeline", "verification", "tasks", "events"] as const).map((t) => (
                <button
                  key={t}
                  className={`ide-bottompanel__tab${bottomTab === t ? " is-active" : ""}`}
                  onClick={() => { setBottomTab(t); setBottomCollapsed(false); }}
                >
                  {t}
                </button>
              ))}
              <button
                className="ide-bottompanel__collapse"
                aria-label={bottomCollapsed ? "Expand panel" : "Collapse panel"}
                onClick={() => setBottomCollapsed((c) => !c)}
              >
                <IconChevron open={!bottomCollapsed} />
              </button>
            </div>
            {!bottomCollapsed && (
              <div className="ide-bottompanel__body">
                {!activeSessionId && <EmptyState icon="▤" text={`Open a session to see its ${bottomTab}.`} />}
                {activeSessionId && bottomTab === "timeline" && <AgentTimeline events={events} />}
                {activeSessionId && bottomTab === "verification" && <VerificationBody verification={activeSession?.verification} />}
                {activeSessionId && bottomTab === "tasks" && <TasksPanel sessionId={activeSessionId} />}
                {activeSessionId && bottomTab === "events" && <EventsRawList events={events} />}
              </div>
            )}
          </div>
        </div>

        <aside className={`ide-rightpanel${rightPanelCollapsed ? " is-collapsed" : ""}`}>
          {rightPanelCollapsed ? (
            <button className="ide-rightpanel__reopen" aria-label="Expand AI Assistant" onClick={() => setRightPanelCollapsed(false)}>
              ‹
            </button>
          ) : (
            <>
              <div className="ide-rightpanel__header">
                AI Assistant
                <button
                  className="ide-rightpanel__collapse"
                  aria-label="Collapse AI Assistant"
                  onClick={() => setRightPanelCollapsed(true)}
                >
                  <IconChevron open={false} />
                </button>
              </div>
              <div className="ide-rightpanel__body">
                {activeSessionId ? (
                  <SessionAssistant sessionId={activeSessionId} session={activeSession} />
                ) : (
                  <EmptyState icon="💬" text="Open a session to ask questions about it." />
                )}
              </div>
            </>
          )}
        </aside>
      </div>

      <footer className="ide-statusbar">
        <div className="ide-statusbar__group">
          <span className="mono">⎇ {repoContext?.worktree ?? "no branch"}</span>
          {activeSession && <span>{activeSession.status}</span>}
          {activeSession?.gates && (
            <span>
              gate: {activeSession.gates.architectureApproved === true ? "approved" : activeSession.gates.architectureApproved === false ? "rejected" : "not reviewed"}
            </span>
          )}
        </div>
        <div className="ide-statusbar__spacer" />
        <div className="ide-statusbar__group">
          <span>model: {modelStatus?.status ?? "UNKNOWN"}</span>
          <span>verification: {activeSession?.verification.overall ?? "—"}</span>
          {activeSessionId && <span>{events.length} events</span>}
        </div>
      </footer>
    </div>
  );
}
