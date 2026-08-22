import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentTimeline } from "./AgentTimeline";
import type { GlimmerEvent } from "@glimmer/shared";

describe("AgentTimeline", () => {
  it("strips fields not declared on the GlimmerEvent variant when expanding an event", () => {
    // Simulate a runtime-only extra field that TypeScript's GlimmerEvent type
    // would never let us write as a literal — the point is to prove the
    // render path allowlists fields rather than trusting the object shape.
    const eventWithExtraField = Object.assign(
      { id: "e1", sessionId: "s1", timestamp: "t", type: "tool_started", tool: "read_file", args: {} },
      { extraField: "should not appear" }
    ) as unknown as GlimmerEvent;

    render(<AgentTimeline events={[eventWithExtraField]} />);

    fireEvent.click(screen.getByText("TOOL read_file"));

    const rendered = screen.getByText(/"tool"/).textContent ?? "";
    expect(rendered).not.toContain("extraField");
    expect(rendered).toContain("read_file");
  });

  it("renders an unrecognized/future event type via the generic fallback instead of a blank or crashing row", () => {
    // Simulates a session.jsonl line whose "type" this build doesn't have a
    // dedicated case for yet (e.g. a newer orchestrator emitting a V7 event
    // type this Control Center build predates) — the fallback in describe()/
    // eventDetails() must still render something readable, not throw or
    // silently drop the row.
    const future = { id: "e3", sessionId: "s1", timestamp: "t", type: "future_event_type", widgetCount: 3 } as unknown as GlimmerEvent;

    render(<AgentTimeline events={[future]} />);

    const label = screen.getByText(/future_event_type/);
    expect(label).toBeInTheDocument();

    fireEvent.click(label);
    const rendered = screen.getByText(/"widgetCount"/).textContent ?? "";
    expect(rendered).toContain("3");
  });

  it("renders a tool_blocked event as a formatted BLOCKED callout with the command and reason visible, no click needed", () => {
    const blocked: GlimmerEvent = {
      id: "e2", sessionId: "s1", timestamp: "t", type: "tool_blocked",
      command: "git push origin main",
      reason: "Remote writes are disabled for autonomous sessions.",
    };
    render(<AgentTimeline events={[blocked]} />);

    expect(screen.getByText("BLOCKED")).toBeInTheDocument();
    expect(screen.getByText("git push origin main")).toBeInTheDocument();
    expect(screen.getByText("Remote writes are disabled for autonomous sessions.")).toBeInTheDocument();
  });
});
