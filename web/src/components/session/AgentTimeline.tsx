import { useState } from "react";
import type { GlimmerEvent } from "@glimmer/shared";

const FILTERS = ["All", "Agent", "Tools", "Security", "Changes", "Verification", "Diagnostics"] as const;
type Filter = (typeof FILTERS)[number];

function matchesFilter(e: GlimmerEvent, filter: Filter): boolean {
  if (filter === "All") return true;
  if (filter === "Agent") return e.type === "agent_state_changed" || e.type === "candidate_selected" || e.type === "scope_expanded";
  if (filter === "Tools") return e.type === "tool_started" || e.type === "tool_completed";
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
  }
}

export function AgentTimeline({ events }: { events: GlimmerEvent[] }) {
  const [filter, setFilter] = useState<Filter>("All");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const visible = events.filter((e) => matchesFilter(e, filter));

  return (
    <div>
      <div role="tablist">
        {FILTERS.map((f) => (
          <button key={f} aria-pressed={f === filter} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>
      <ul>
        {visible.map((e) => {
          const isOpen = expanded.has(e.id);
          // Spec §21 Safety UX: a tool_blocked event is a security callout,
          // not just another collapsible log line — command + reason must be
          // visible without a click, in a visually distinct (red) tone.
          if (e.type === "tool_blocked") {
            return (
              <li
                key={e.id}
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
          return (
            <li key={e.id}>
              <button onClick={() => setExpanded((prev) => {
                const next = new Set(prev);
                next.has(e.id) ? next.delete(e.id) : next.add(e.id);
                return next;
              })}>
                {describe(e)}
              </button>
              {isOpen && (
                <pre className="mono" onClick={() => navigator.clipboard?.writeText(JSON.stringify(eventDetails(e), null, 2))}>
                  {JSON.stringify(eventDetails(e), null, 2)}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
