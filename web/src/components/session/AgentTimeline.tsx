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
                <pre className="mono" onClick={() => navigator.clipboard?.writeText(JSON.stringify(e, null, 2))}>
                  {JSON.stringify(e, null, 2)}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
