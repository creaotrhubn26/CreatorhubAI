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
});
