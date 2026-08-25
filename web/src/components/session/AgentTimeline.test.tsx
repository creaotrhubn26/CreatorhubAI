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

  it("shows model identity per call while allowlisting secret-free details", () => {
    const modelCall = Object.assign({
      id: "e-model", sessionId: "s1", timestamp: "t", type: "model_request_started",
      requestId: "req-1", role: "architect", providerId: "frontier", modelId: "reasoner-1",
    }, {
      apiKey: "must-not-render",
      apiKeyFile: "/private/key",
      baseUrl: "https://private-endpoint.example/v1",
    }) as unknown as GlimmerEvent;
    render(<AgentTimeline events={[modelCall]} />);

    const label = screen.getByText("MODEL architect → frontier/reasoner-1");
    fireEvent.click(label);
    const rendered = screen.getByText(/"requestId"/).textContent ?? "";
    expect(rendered).toContain("req-1");
    expect(rendered).not.toContain("must-not-render");
    expect(rendered).not.toContain("apiKeyFile");
    expect(rendered).not.toContain("baseUrl");
  });

  // M3 (followup-1-2 review): a scope_expanded event a human explicitly
  // approved (V7 §15 write-time pause) must not read/look identical to an
  // unapproved one -- distinct label, distinct icon color, and the
  // approval provenance must survive into the expanded detail view.
  it("renders an unapproved scope_expanded event with the plain label and red icon", () => {
    const unapproved: GlimmerEvent = {
      id: "e4", sessionId: "s1", timestamp: "t", type: "scope_expanded",
      expected: ["src/dialog"], actual: ["backend/x.ts"],
    };
    const { container } = render(<AgentTimeline events={[unapproved]} />);

    expect(screen.getByText("SCOPE EXPANSION")).toBeInTheDocument();
    expect(screen.queryByText(/approved/i)).not.toBeInTheDocument();
    const icon = container.querySelector(".tl-icon") as HTMLElement;
    expect(icon.style.getPropertyValue("--tl-color")).toBe("var(--red)");
  });

  it("renders an approved scope_expanded event with a distinct label, amber icon, and approvedBy in the detail view", () => {
    const approved: GlimmerEvent = {
      id: "e5", sessionId: "s1", timestamp: "t", type: "scope_expanded",
      expected: ["src/dialog"], actual: ["backend/x.ts"],
      approved: true, approvedBy: "daniel", approvalId: "s1-appr-1",
    };
    const { container } = render(<AgentTimeline events={[approved]} />);

    const label = screen.getByText("SCOPE EXPANSION (approved by daniel)");
    expect(label).toBeInTheDocument();
    const icon = container.querySelector(".tl-icon") as HTMLElement;
    expect(icon.style.getPropertyValue("--tl-color")).toBe("var(--amber)");

    fireEvent.click(label);
    const rendered = screen.getByText(/"approvedBy"/).textContent ?? "";
    expect(rendered).toContain("daniel");
    expect(rendered).toContain("s1-appr-1");
  });
});
