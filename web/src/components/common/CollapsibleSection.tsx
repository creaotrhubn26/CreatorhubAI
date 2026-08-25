import { useState, type ReactNode } from "react";
import { IconChevron } from "./Icons";

// Shared disclosure wrapper for session-detail panels (Risk & Scope,
// Architecture Plan, Architect Reviews, Tasks, Delivery Review). The body is
// hidden via the native `hidden` attribute rather than unmounted, so its real
// content stays queryable (existing tests that assert on panel content keep
// working) while still being visually collapsed by default.
export function CollapsibleSection({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="section-panel">
      <button
        className="section-panel__header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <IconChevron open={open} />
        <span className="section-panel__title">{title}</span>
        {summary && <span className="section-panel__summary">{summary}</span>}
      </button>
      <div className="section-panel__body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
