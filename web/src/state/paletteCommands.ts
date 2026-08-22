import type { GlimmerSession } from "@glimmer/shared";
import { shortSessionId } from "./sessionListMeta";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export type PaletteMode = "command" | "session";

export interface PaletteCommandsContext {
  mode: PaletteMode;
  sessions: Pick<GlimmerSession, "id" | "task" | "status">[];
  navigate: (to: string) => void;
  toggleLeftPanel: () => void;
  toggleAssistantPanel: () => void;
}

// Session mode lists every known session (Enter navigates straight to it);
// command mode lists navigation + panel-toggle actions. Kept as one
// exported function per the brief rather than two, since the caller always
// knows which mode it's building for.
export function buildCommands(ctx: PaletteCommandsContext): PaletteCommand[] {
  if (ctx.mode === "session") {
    return ctx.sessions.map((s) => ({
      id: `session-${s.id}`,
      label: s.task || shortSessionId(s.id),
      hint: s.status,
      run: () => ctx.navigate(`/sessions/${s.id}`),
    }));
  }

  return [
    { id: "new-task", label: "New Task", run: () => ctx.navigate("/tasks/new") },
    { id: "goto-dashboard", label: "Go to Dashboard", run: () => ctx.navigate("/") },
    { id: "goto-sessions", label: "Go to Sessions", run: () => ctx.navigate("/sessions") },
    { id: "goto-verification", label: "Go to Verification Center", run: () => ctx.navigate("/verification") },
    { id: "goto-repository", label: "Go to Repository Map", run: () => ctx.navigate("/repository") },
    { id: "goto-system-explorer", label: "Go to System Explorer", run: () => ctx.navigate("/system-explorer") },
    { id: "goto-model", label: "Go to Model Status", run: () => ctx.navigate("/model") },
    { id: "goto-settings", label: "Go to Settings", run: () => ctx.navigate("/settings") },
    { id: "toggle-left-panel", label: "Toggle left panel", hint: "[", run: ctx.toggleLeftPanel },
    { id: "toggle-assistant-panel", label: "Toggle assistant panel", hint: "]", run: ctx.toggleAssistantPanel },
  ];
}

// Pure and tested on its own: empty query -> everything, otherwise a
// case-insensitive substring match on the label. No fuzzy-match library.
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => c.label.toLowerCase().includes(q));
}
