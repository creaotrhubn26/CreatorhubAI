import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { GlimmerEvent, GlimmerSession, RepositorySelection } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { SessionEventsContext, useSessionEvents } from "../../api/useSessionEvents";
import { statusColor } from "../common/StatusBadge";
import { EmptyState } from "../common/EmptyState";
import { AgentTimeline } from "../session/AgentTimeline";
import { TasksPanel } from "../session/TasksPanel";
import { SessionAssistant } from "../session/SessionAssistant";
import { VerificationBody } from "../verification/VerificationCenterScreen";
import {
  groupSessionsByDay,
  isPendingSessionId,
  relativeTime,
  sessionTimestamp,
  shortSessionId,
} from "../../state/sessionListMeta";
import { buildCommands, type PaletteMode } from "../../state/paletteCommands";
import { CommandPalette } from "../common/CommandPalette";
import { completionTitle, isUnseenCompletion, newlyCompleted } from "../../state/completionNotify";
import { sendCompletionNotification } from "../../state/desktopNotify";
import { mostSpecificContainingWorkspace } from "../../state/fileLink";
import { STATES as RUNNING_STATES } from "../session/AgentStateStepper";
import {
  IconBack,
  IconChevron,
  IconClose,
  IconDashboard,
  IconFiles,
  IconForward,
  IconModel,
  IconNewTask,
  IconRepository,
  IconSearch,
  IconSessions,
  IconSettings,
  IconVerification,
} from "../common/Icons";

export interface RepoContext {
  repository: string;
  worktree: string;
  baseline: string;
  status: "Clean" | "Dirty";
}

const OPEN_TABS_KEY = "glimmer.openTabs";
const LEFT_PANEL_COLLAPSED_KEY = "glimmer.leftPanelCollapsed";
const RIGHT_PANEL_COLLAPSED_KEY = "glimmer.rightPanelCollapsed";
const MAX_TABS = 6;

// Re-exported for back-compat — logic now lives in state/sessionListMeta.ts
// alongside the rest of the session-row formatting helpers.
export { shortSessionId };

// A running/active session pulses its status dot and gets the elapsed +
// last-activity line in ActiveSessionScreen. Reuses AgentStateStepper's own
// in-flight-states list so "is this running" is defined in exactly one place.
function isRunningStatus(status: GlimmerSession["status"]): boolean {
  return RUNNING_STATES.includes(status);
}

type ActivityKey =
  | "dashboard"
  | "sessions"
  | "new-task"
  | "verification"
  | "files"
  | "repository"
  | "system-explorer"
  | "model"
  | "settings";

const ACTIVITY_ITEMS: Array<{
  key: ActivityKey;
  label: string;
  to: string;
  Icon: typeof IconDashboard;
}> = [
  { key: "dashboard", label: "Dashboard", to: "/", Icon: IconDashboard },
  { key: "sessions", label: "Sessions", to: "/sessions", Icon: IconSessions },
  { key: "new-task", label: "New Task", to: "/tasks/new", Icon: IconNewTask },
  { key: "verification", label: "Verification", to: "/verification", Icon: IconVerification },
  // Round A / Task A2 -- read-only file tree + code viewer.
  { key: "files", label: "Files", to: "/files", Icon: IconFiles },
  { key: "repository", label: "Repository", to: "/repository", Icon: IconRepository },
  // Task 7.5 (V7 "System Explorer") -- read-only doc-graph browser.
  { key: "system-explorer", label: "System Explorer", to: "/system-explorer", Icon: IconSearch },
  { key: "model", label: "Model", to: "/model", Icon: IconModel },
];
const SETTINGS_ITEM = {
  key: "settings" as const,
  label: "Settings",
  to: "/settings",
  Icon: IconSettings,
};

function activePageOf(pathname: string): ActivityKey {
  if (pathname === "/settings") return "settings";
  if (pathname === "/verification" || pathname.endsWith("/verification")) return "verification";
  if (pathname === "/tasks/new") return "new-task";
  if (pathname === "/files") return "files";
  if (pathname === "/repository") return "repository";
  if (pathname === "/system-explorer") return "system-explorer";
  if (pathname === "/model") return "model";
  if (pathname === "/") return "dashboard";
  if (pathname.startsWith("/sessions") || pathname.startsWith("/workspaces")) return "sessions";
  return "dashboard";
}

function EventsRawList({ events }: { events: GlimmerEvent[] }) {
  if (!events.length)
    return <div className="ide-bottompanel__empty">No events recorded yet for this session.</div>;
  return (
    <ul>
      {events.map((e) => (
        <li key={e.id} className="row mono" style={{ fontSize: 12 }}>
          <span style={{ color: "var(--text-muted)" }}>
            {new Date(e.timestamp).toLocaleTimeString()}
          </span>{" "}
          {e.type}
        </li>
      ))}
    </ul>
  );
}

function Section({
  title,
  collapsed,
  onToggle,
  children,
  footer,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
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

export function AppShell({
  repoContext,
  children,
}: {
  repoContext: RepoContext | null;
  children: ReactNode;
}) {
  const location = useLocation();
  const navigate = useNavigate();

  const sessionMatch = location.pathname.match(/^\/sessions\/([^/]+)/);
  const fileQuery = new URLSearchParams(location.search);
  const fileSessionId = location.pathname === "/files" ? fileQuery.get("session") : null;
  // The Files route can retain the real session it came from so the one
  // shared SSE stream stays alive. Reject slash-bearing/empty URL input here
  // rather than opening a reconnecting stream to a path-shaped id.
  const contextualFileSessionId =
    fileSessionId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(fileSessionId)
      ? fileSessionId
      : undefined;
  const activeSessionId = sessionMatch?.[1] ?? contextualFileSessionId;
  const selectionStart = Number(fileQuery.get("start"));
  const selectionEnd = Number(fileQuery.get("end"));
  const selectionPath = location.pathname === "/files" ? fileQuery.get("path") : null;
  const repositorySelection: RepositorySelection | null =
    selectionPath &&
    Number.isInteger(selectionStart) &&
    Number.isInteger(selectionEnd) &&
    selectionStart > 0 &&
    selectionEnd >= selectionStart
      ? { path: selectionPath, startLine: selectionStart, endLine: selectionEnd }
      : null;
  const activePage = activePageOf(location.pathname);
  // Status bar's session-status/verification items: the open session's own
  // verification view, or the Verification Center when nothing is open.
  const verificationTarget = activeSessionId
    ? `/sessions/${activeSessionId}/verification`
    : "/verification";

  const { data: rawSessions } = useQuery({
    queryKey: ["sessions"],
    queryFn: glimmerApi.listSessions,
    refetchInterval: 5000,
  });
  const { data: workspaces } = useQuery({
    queryKey: ["workspaces"],
    queryFn: glimmerApi.listWorkspaces,
    refetchInterval: 5000,
  });
  // pending-* rows are transient adopted-workspace placeholders — once the
  // real session id shows up they're a duplicate, not a second session, so
  // they never belong in any session-browsing list.
  const sessions = useMemo(
    () => (rawSessions ?? []).filter((s) => !isPendingSessionId(s.id)),
    [rawSessions],
  );
  const { data: modelStatus } = useQuery({
    queryKey: ["model-status"],
    queryFn: glimmerApi.getModelStatus,
    refetchInterval: 5000,
  });
  const { data: activeSession } = useQuery({
    queryKey: ["session", activeSessionId],
    queryFn: () => glimmerApi.getSession(activeSessionId!),
    enabled: !!activeSessionId,
    refetchInterval: 4000,
  });
  const selectionWorkspace = repositorySelection
    ? mostSpecificContainingWorkspace(
        (workspaces ?? []).map((workspace) => workspace.path),
        repositorySelection.path,
      )
    : undefined;
  const events = useSessionEvents(activeSessionId ?? "");
  // lastEventAt must be the max of the events' own `timestamp` field, not
  // Date.now() at receipt: the SSE route replays the whole events.jsonl
  // backlog from lastCount=0 on every reconnect (server/src/routes/
  // sessions.ts), and EventSource auto-reconnects on blips/sleep/route
  // return — receipt-time would show "just now" for a genuinely stalled
  // session. Deterministic and replay-immune; null when there are no events.
  // Events are append-ordered (replay preserves that order), so the last
  // parseable timestamp is the max — scan from the end and stop at the
  // first one, rather than scanning the whole array.
  const sessionEventsValue = useMemo(() => {
    let lastEventAt: number | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const t = new Date(events[i].timestamp).getTime();
      if (!Number.isNaN(t)) {
        lastEventAt = t;
        break;
      }
    }
    return { events, lastEventAt };
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
    const next = openTabs.filter((tabId) => tabId !== id);
    setOpenTabs(next);

    if (id === activeSessionId) {
      const fallback = next[next.length - 1];
      navigate(fallback ? `/sessions/${fallback}` : "/");
    }
  }

  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  function toggleSection(key: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const [bottomTab, setBottomTab] = useState<"timeline" | "verification" | "tasks" | "events">(
    "timeline",
  );
  const [bottomCollapsed, setBottomCollapsed] = useState(false);

  // Sidebar collapses the same way the assistant panel does (below) —
  // persisted, toggled by its own header button or the `[` shortcut.
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(() => {
    try {
      return window.localStorage?.getItem(LEFT_PANEL_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage?.setItem(LEFT_PANEL_COLLAPSED_KEY, leftPanelCollapsed ? "1" : "0");
    } catch {
      /* storage unavailable — collapse state just won't persist */
    }
  }, [leftPanelCollapsed]);

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

  // Command palette (cmd+K) / session switcher (cmd+P). A single global
  // keydown listener drives both plus the `[`/`]` panel-toggle shortcuts.
  // cmd+K/cmd+P are chords (not plain text a user would type), so they fire
  // regardless of focus — including from inside an input/textarea/
  // contenteditable. The bare `[`/`]` (and Escape) ARE plain keys, so they
  // stay guarded: ignored while typing in a field, except the palette's own
  // input (marked with data-palette-input so Escape still reaches it there).
  const [palette, setPalette] = useState<{ open: boolean; mode: PaletteMode }>({
    open: false,
    mode: "command",
  });
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Palette invocation: Ctrl+K/Ctrl+P are Cocoa text-editing bindings on
      // mac (delete-to-line-start / previous-line), so ctrlKey must not open
      // the palette there — only metaKey (Cmd) does. Elsewhere ctrlKey is the
      // right chord. navigator.platform is deprecated but synchronous; when
      // it's unavailable, default to mac (metaKey-only) since that's the
      // safer/no-op-elsewhere assumption.
      const isMac = navigator.platform ? navigator.platform.toUpperCase().startsWith("MAC") : true;
      const paletteMod = isMac ? e.metaKey : e.ctrlKey;
      if (paletteMod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette({ open: true, mode: "command" });
        return;
      }
      if (paletteMod && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPalette({ open: true, mode: "session" });
        return;
      }

      const target = e.target instanceof HTMLElement ? e.target : null;
      const isPaletteInput = target?.dataset.paletteInput === "true";
      const isTypingElsewhere =
        !!target &&
        !isPaletteInput &&
        (/^(input|textarea)$/i.test(target.tagName) || target.isContentEditable);
      // The palette-input exemption only ever covers Escape (so the palette
      // can close itself while focused) — typing a literal `[`/`]` into the
      // palette's own search box must never toggle a side panel.
      if (isTypingElsewhere || (isPaletteInput && e.key !== "Escape")) return;

      if (e.key === "Escape") {
        setPalette((p) => (p.open ? { ...p, open: false } : p));
        return;
      }
      // `mod`/altKey guard: Cmd+[ and Cmd+] are the browser's Back/Forward
      // chords and Alt+[/Alt+] are common editor bindings — none of those
      // should also toggle a panel as a side effect.
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "[" && !mod && !e.altKey) {
        setLeftPanelCollapsed((c) => !c);
        return;
      }
      if (e.key === "]" && !mod && !e.altKey) {
        setRightPanelCollapsed((c) => !c);
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const paletteCommands = useMemo(
    () =>
      buildCommands({
        mode: palette.mode,
        sessions,
        navigate,
        toggleLeftPanel: () => setLeftPanelCollapsed((c) => !c),
        toggleAssistantPanel: () => setRightPanelCollapsed((c) => !c),
      }),
    [palette.mode, sessions, navigate],
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const matches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return (sessions ?? [])
      .filter((s) => s.task.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
      .slice(0, 8);
  }, [searchQuery, sessions]);

  function openSession(id: string) {
    navigate(`/sessions/${id}`);
    setSearchQuery("");
    setSearchFocused(false);
  }

  const visibleSessions = sessions.slice(0, 12);
  const sidebarGroups = useMemo(() => groupSessionsByDay(visibleSessions), [visibleSessions]);

  // Completion notifications: title badge + optional system notification.
  // prevStatusRef holds the last-seen status per session id so transitions
  // can be detected across polls without re-deriving them from history.
  // baseTitleRef captures the document's real title once, before this
  // component ever rewrites it, so the "(N) " prefix always has a clean
  // base to reapply onto.
  const prevStatusRef = useRef<Record<string, string>>({});
  const baseTitleRef = useRef<string>(document.title);
  const [unseenIds, setUnseenIds] = useState<Set<string>>(new Set());

  // Restore the real page title on unmount — this component may have left
  // it rewritten with a "(N) " unseen-completion badge.
  useEffect(() => {
    const baseTitle = baseTitleRef.current;
    return () => {
      document.title = baseTitle;
    };
  }, []);

  useEffect(() => {
    const nextStatus: Record<string, string> = {};
    for (const s of sessions) nextStatus[s.id] = s.status;
    const completed = newlyCompleted(prevStatusRef.current, nextStatus);
    prevStatusRef.current = nextStatus;
    if (completed.length === 0) return;

    // One gate — isUnseenCompletion — drives both the title badge and the
    // system notification, so a session finishing while its own tab is
    // open and the window is focused triggers neither.
    const unseen = completed.filter((id) =>
      isUnseenCompletion(id, activeSessionId, document.hidden),
    );
    if (unseen.length === 0) return;

    for (const id of unseen) {
      sendCompletionNotification("Glimmer", `${shortSessionId(id)} finished: ${nextStatus[id]}`);
    }

    setUnseenIds((prev) => {
      const next = new Set(prev);
      for (const id of unseen) next.add(id);
      return next;
    });
  }, [sessions, activeSessionId]);

  // Clear the unseen mark for whichever session the user is now viewing —
  // both on navigating to it and on refocusing a tab already parked on it.
  useEffect(() => {
    function clearActiveUnseen() {
      if (!activeSessionId) return;
      setUnseenIds((prev) => {
        if (!prev.has(activeSessionId)) return prev;
        const next = new Set(prev);
        next.delete(activeSessionId);
        return next;
      });
    }
    clearActiveUnseen();
    window.addEventListener("focus", clearActiveUnseen);
    document.addEventListener("visibilitychange", clearActiveUnseen);
    return () => {
      window.removeEventListener("focus", clearActiveUnseen);
      document.removeEventListener("visibilitychange", clearActiveUnseen);
    };
  }, [activeSessionId]);

  useEffect(() => {
    document.title = completionTitle(baseTitleRef.current, unseenIds.size);
  }, [unseenIds]);

  return (
    <div className="ide">
      <header className="ide-topbar">
        <div className="ide-topbar__traffic-inset" />
        <div className="ide-topbar__nav">
          <button aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <button aria-label="Forward" onClick={() => navigate(1)}>
            <IconForward />
          </button>
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
          <button className="btn-primary" onClick={() => navigate("/tasks/new")}>
            New Task
          </button>
          <Link className="ide-topbar__gear" to="/settings" aria-label="Settings">
            <IconSettings />
          </Link>
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

        <aside className={`ide-leftpanel${leftPanelCollapsed ? " is-collapsed" : ""}`}>
          {leftPanelCollapsed ? (
            <button
              className="ide-leftpanel__reopen"
              aria-label="Expand sidebar"
              onClick={() => setLeftPanelCollapsed(false)}
            >
              ›
            </button>
          ) : (
            <>
              <div className="ide-leftpanel__header">
                GLIMMER
                <span className="ide-leftpanel__workspace">
                  {repoContext?.repository ?? "Not connected"}
                </span>
                <button
                  className="ide-leftpanel__collapse"
                  aria-label="Collapse sidebar"
                  onClick={() => setLeftPanelCollapsed(true)}
                >
                  <IconChevron open={false} />
                </button>
              </div>
              <div className="ide-leftpanel__body">
                <Section
                  title="Sessions"
                  collapsed={collapsedSections.has("sessions")}
                  onToggle={() => toggleSection("sessions")}
                >
                  {visibleSessions.length === 0 && (
                    <div className="ide-section__link" style={{ color: "var(--text-muted)" }}>
                      Unavailable
                    </div>
                  )}
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
                            <span className="ide-session-row__meta">
                              {s.status} · {relativeTime(sessionTimestamp(s))}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
                  {sessions.length > visibleSessions.length && (
                    <Link className="ide-section__link" to="/sessions">
                      View all sessions →
                    </Link>
                  )}
                </Section>

                <Section
                  title="Model"
                  collapsed={collapsedSections.has("model")}
                  onToggle={() => toggleSection("model")}
                >
                  <div className="ide-model-row">
                    <span
                      className="ide-status-dot"
                      style={{ color: statusColor(modelStatus?.status ?? "UNKNOWN") }}
                    />
                    <span className="ide-model-row__name">Muse Glimmer</span>
                    {modelStatus && (
                      <span
                        className="mono"
                        style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}
                      >
                        {modelStatus.status}
                      </span>
                    )}
                  </div>
                  {modelStatus?.contextSize && (
                    <div
                      className="ide-model-row"
                      style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}
                    >
                      {modelStatus.contextSize.toLocaleString()} ctx
                    </div>
                  )}
                  <Link className="ide-section__link" to="/model">
                    Model Settings
                  </Link>
                </Section>
              </div>

              <div className="ide-leftpanel__repo">
                {repoContext ? (
                  <dl>
                    <dt>Worktree</dt>
                    <dd className="mono">{repoContext.worktree}</dd>
                    <dt>Baseline</dt>
                    <dd className="mono">{repoContext.baseline}</dd>
                    <dt>Status</dt>
                    <dd>{repoContext.status}</dd>
                  </dl>
                ) : (
                  <div>Not connected</div>
                )}
              </div>
            </>
          )}
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
                  <button
                    className="ide-tab__close"
                    aria-label={`Close ${shortSessionId(id)}`}
                    onClick={() => closeTab(id)}
                  >
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
            <SessionEventsContext.Provider value={sessionEventsValue}>
              {children}
            </SessionEventsContext.Provider>
          </div>

          <div className="ide-bottompanel">
            <div className="ide-bottompanel__tabs">
              {(["timeline", "verification", "tasks", "events"] as const).map((t) => (
                <button
                  key={t}
                  className={`ide-bottompanel__tab${bottomTab === t ? " is-active" : ""}`}
                  onClick={() => {
                    setBottomTab(t);
                    setBottomCollapsed(false);
                  }}
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
                {!activeSessionId && (
                  <EmptyState icon="▤" text={`Open a session to see its ${bottomTab}.`} />
                )}
                {activeSessionId && bottomTab === "timeline" && <AgentTimeline events={events} />}
                {activeSessionId && bottomTab === "verification" && (
                  <VerificationBody
                    verification={activeSession?.verification}
                    finalStatus={activeSession?.finalStatus}
                  />
                )}
                {activeSessionId && bottomTab === "tasks" && (
                  <TasksPanel sessionId={activeSessionId} session={activeSession} />
                )}
                {activeSessionId && bottomTab === "events" && <EventsRawList events={events} />}
              </div>
            )}
          </div>
        </div>

        <aside className={`ide-rightpanel${rightPanelCollapsed ? " is-collapsed" : ""}`}>
          {rightPanelCollapsed ? (
            <button
              className="ide-rightpanel__reopen"
              aria-label="Expand AI Assistant"
              onClick={() => setRightPanelCollapsed(false)}
            >
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
                {repositorySelection ? (
                  <SessionAssistant
                    selection={repositorySelection}
                    onDraftTask={
                      selectionWorkspace
                        ? (objective) =>
                            navigate("/tasks/new", {
                              state: {
                                selectionDraft: {
                                  objective,
                                  workspace: selectionWorkspace,
                                  path: repositorySelection.path,
                                  startLine: repositorySelection.startLine,
                                  endLine: repositorySelection.endLine,
                                },
                              },
                            })
                        : undefined
                    }
                  />
                ) : activeSessionId ? (
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
          <button className="statusbar-item mono" onClick={() => navigate("/repository")}>
            ⎇ {repoContext?.worktree ?? "no branch"}
          </button>
          {activeSession && (
            <button className="statusbar-item" onClick={() => navigate(verificationTarget)}>
              {activeSession.status}
            </button>
          )}
          {activeSession?.gates && (
            <span>
              gate:{" "}
              {activeSession.gates.architectureApproved === true
                ? "approved"
                : activeSession.gates.architectureApproved === false
                  ? "rejected"
                  : "not reviewed"}
            </span>
          )}
        </div>
        <div className="ide-statusbar__spacer" />
        <div className="ide-statusbar__group">
          <button className="statusbar-item" onClick={() => navigate("/model")}>
            model: {modelStatus?.status ?? "UNKNOWN"}
          </button>
          <button className="statusbar-item" onClick={() => navigate(verificationTarget)}>
            verification: {activeSession?.verification.overall ?? "—"}
          </button>
          {activeSessionId && <span>{events.length} events</span>}
        </div>
      </footer>

      {palette.open && (
        <CommandPalette
          commands={paletteCommands}
          placeholder={palette.mode === "session" ? "Jump to a session…" : "Type a command…"}
          onClose={() => setPalette((p) => ({ ...p, open: false }))}
        />
      )}
    </div>
  );
}
