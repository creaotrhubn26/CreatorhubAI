import { useState } from "react";
import type { GlimmerEvent, ToolCompletedEvent, ToolStartedEvent } from "@glimmer/shared";
import { statusColor } from "../common/StatusBadge";

const FILTERS = ["All", "Agent", "Tools", "Security", "Changes", "Verification", "Diagnostics"] as const;
type Filter = (typeof FILTERS)[number];

// A tool_started + its later tool_completed (same tool name) are one action
// from a human's point of view — merge them into a single row instead of two
// log lines, with the result compacted into a preview until expanded.
type TimelineRow =
  | { kind: "tool"; id: string; indent: boolean; started: ToolStartedEvent; completed?: ToolCompletedEvent }
  | { kind: "event"; id: string; indent: boolean; event: GlimmerEvent };

function buildRows(events: GlimmerEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const pendingByTool = new Map<string, number>();
  for (const e of events) {
    if (e.type === "tool_started") {
      rows.push({ kind: "tool", id: e.id, indent: true, started: e });
      pendingByTool.set(e.tool, rows.length - 1);
      continue;
    }
    if (e.type === "tool_completed") {
      const idx = pendingByTool.get(e.tool);
      const row = idx !== undefined ? rows[idx] : undefined;
      if (row?.kind === "tool" && !row.completed) {
        row.completed = e;
        pendingByTool.delete(e.tool);
        continue;
      }
      // No matching open tool_started (out-of-order stream) — still show it.
      rows.push({ kind: "event", id: e.id, indent: true, event: e });
      continue;
    }
    // agent_state_changed marks a new phase — everything else nests under
    // the most recent one, giving the timeline visible hierarchy.
    rows.push({ kind: "event", id: e.id, indent: e.type !== "agent_state_changed", event: e });
  }
  return rows;
}

function rowMatchesFilter(row: TimelineRow, filter: Filter): boolean {
  if (filter === "All") return true;
  if (row.kind === "tool") return filter === "Tools";
  const e = row.event;
  if (filter === "Agent") return e.type === "agent_state_changed" || e.type === "candidate_selected" || e.type === "scope_expanded";
  if (filter === "Tools") return e.type === "tool_completed";
  if (filter === "Security") return e.type === "tool_blocked";
  if (filter === "Changes") return e.type === "file_changed";
  if (filter === "Verification") return e.type === "verification_started" || e.type === "verification_completed";
  if (filter === "Diagnostics") return e.type === "parser_recovery";
  return true;
}

function describe(e: GlimmerEvent): string {
  switch (e.type) {
    case "tool_started": return `TOOL ${e.tool}`;
    case "tool_completed": return `RESULT ${e.tool}`;
    case "tool_blocked": return `SECURITY BLOCK ${e.command}`;
    case "file_changed": return `EDIT ${e.path}`;
    case "verification_started": return `VERIFY ${e.command}`;
    case "verification_completed": return `VERIFY ${e.check}: ${e.status}`;
    case "agent_state_changed": return `STATE ${e.state}`;
    case "candidate_selected": return `DECISION ${e.file}`;
    case "scope_expanded": return "SCOPE EXPANSION";
    case "repair_started": return `REPAIR ${e.iteration}`;
    case "parser_recovery": return `PEG retry (attempt ${e.attempt})`;
    case "session_completed": return `SESSION ${e.status}`;
    // Generic fallback: any event type this build doesn't have a
    // dedicated case for yet (including new V7 types) still renders a
    // readable row instead of crashing/going blank.
    default: return `EVENT ${e.type}`;
  }
}

// Icon glyph + a per-type color var, used for both standalone events and
// merged tool rows. No icon library — small inline glyphs, same discipline
// as components/common/Icons.tsx.
function iconMeta(row: TimelineRow): { glyph: string; color: string } {
  if (row.kind === "tool") return { glyph: "⚙", color: "var(--blue)" };
  const e = row.event;
  switch (e.type) {
    case "tool_completed": return { glyph: "⚙", color: "var(--blue)" };
    case "tool_blocked": return { glyph: "⛔", color: "var(--red)" };
    case "file_changed": return { glyph: "✎", color: "var(--accent-strong)" };
    case "verification_started": return { glyph: "◎", color: "var(--amber)" };
    case "verification_completed": return { glyph: "◎", color: statusColor(e.status) };
    case "agent_state_changed": return { glyph: "▸", color: "var(--text-secondary)" };
    case "candidate_selected": return { glyph: "◆", color: "var(--accent-strong)" };
    case "scope_expanded": return { glyph: "⚠", color: "var(--red)" };
    case "repair_started": return { glyph: "↻", color: "var(--amber)" };
    case "parser_recovery": return { glyph: "⟲", color: "var(--gray)" };
    case "session_completed": return { glyph: "■", color: statusColor(e.status) };
    default: return { glyph: "•", color: "var(--text-muted)" };
  }
}

function eventDetails(e: GlimmerEvent): Record<string, unknown> {
  const base = { id: e.id, sessionId: e.sessionId, timestamp: e.timestamp, type: e.type };
  switch (e.type) {
    case "tool_started": return { ...base, tool: e.tool, args: e.args };
    case "tool_completed": return { ...base, tool: e.tool, resultSummary: e.resultSummary };
    case "tool_blocked": return { ...base, command: e.command, reason: e.reason };
    case "file_changed": return { ...base, path: e.path, changeType: e.changeType };
    case "verification_started": return { ...base, command: e.command };
    case "verification_completed": return { ...base, check: e.check, status: e.status, baselineAware: e.baselineAware };
    case "agent_state_changed": return { ...base, state: e.state };
    case "candidate_selected": return { ...base, file: e.file, reasons: e.reasons };
    case "scope_expanded": return { ...base, expected: e.expected, actual: e.actual };
    case "repair_started": return { ...base, iteration: e.iteration };
    case "parser_recovery": return { ...base, attempt: e.attempt, payloadPath: e.payloadPath };
    case "session_completed": return { ...base, status: e.status };
    // Generic fallback: dump every field the event actually carries
    // (base plus whatever else is on it) rather than hand-listing fields
    // per type — covers new V7 types with no per-type case yet.
    default: return { ...base, ...(e as unknown as Record<string, unknown>) };
  }
}

function toolRowDetails(started: ToolStartedEvent, completed?: ToolCompletedEvent): Record<string, unknown> {
  const startDetails = eventDetails(started);
  if (!completed) return startDetails;
  return { ...startDetails, completedAt: completed.timestamp, resultSummary: completed.resultSummary };
}

function preview(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function AgentTimeline({ events }: { events: GlimmerEvent[] }) {
  const [filter, setFilter] = useState<Filter>("All");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const rows = buildRows(events).filter((r) => rowMatchesFilter(r, filter));

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="card">
      <div role="tablist">
        {FILTERS.map((f) => (
          <button key={f} aria-pressed={f === filter} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>
      <ul>
        {rows.map((row) => {
          // Spec §21 Safety UX: a tool_blocked event is a security callout,
          // not just another collapsible log line — command + reason must be
          // visible without a click, in a visually distinct (red) tone.
          if (row.kind === "event" && row.event.type === "tool_blocked") {
            const e = row.event;
            return (
              <li
                key={row.id}
                role="alert"
                style={{
                  border: "1px solid var(--red)",
                  borderRadius: "var(--radius)",
                  padding: 8,
                  margin: "4px 0",
                  color: "var(--red)",
                }}
              >
                <strong>BLOCKED</strong>
                <div className="mono">{e.command}</div>
                <div>Reason:</div>
                <div>{e.reason}</div>
              </li>
            );
          }

          const isOpen = expanded.has(row.id);
          const { glyph, color } = iconMeta(row);
          const label = row.kind === "tool" ? describe(row.started) : describe(row.event);
          const previewText = row.kind === "tool" && row.completed ? preview(row.completed.resultSummary) : undefined;
          const details = row.kind === "tool" ? toolRowDetails(row.started, row.completed) : eventDetails(row.event);

          return (
            <li key={row.id} className={`timeline-row tl-row${row.indent ? " indent" : ""}`}>
              <span className="tl-icon" style={{ ["--tl-color" as any]: color }} aria-hidden="true">{glyph}</span>
              <button className="timeline-toggle" onClick={() => toggle(row.id)}>
                {label}
                {previewText ? ` → ${previewText}` : ""}
              </button>
              {isOpen && (
                <pre className="mono" onClick={() => navigator.clipboard?.writeText(JSON.stringify(details, null, 2))}>
                  {JSON.stringify(details, null, 2)}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
