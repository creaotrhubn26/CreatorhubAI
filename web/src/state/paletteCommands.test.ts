import { describe, it, expect, vi } from "vitest";
import { buildCommands, filterCommands } from "./paletteCommands";

describe("filterCommands", () => {
  const commands = [
    { id: "a", label: "Go to Dashboard", run: () => {} },
    { id: "b", label: "Go to Settings", run: () => {} },
    { id: "c", label: "New Task", run: () => {} },
  ];

  it("returns everything for an empty query", () => {
    expect(filterCommands(commands, "")).toEqual(commands);
    expect(filterCommands(commands, "   ")).toEqual(commands);
  });

  it("matches a case-insensitive substring of the label", () => {
    expect(filterCommands(commands, "dash")).toEqual([commands[0]]);
    expect(filterCommands(commands, "DASH")).toEqual([commands[0]]);
    expect(filterCommands(commands, "go to")).toEqual([commands[0], commands[1]]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterCommands(commands, "zzz")).toEqual([]);
  });
});

describe("buildCommands", () => {
  const navigate = vi.fn();
  const toggleLeftPanel = vi.fn();
  const toggleAssistantPanel = vi.fn();

  it("command mode lists navigation and panel-toggle actions", () => {
    const cmds = buildCommands({
      mode: "command",
      sessions: [],
      navigate,
      toggleLeftPanel,
      toggleAssistantPanel,
    });
    const labels = cmds.map((c) => c.label);
    expect(labels).toContain("New Task");
    expect(labels).toContain("Go to Dashboard");
    expect(labels).toContain("Go to Sessions");
    expect(labels).toContain("Go to Verification Center");
    expect(labels).toContain("Go to Repository Map");
    expect(labels).toContain("Go to Model Status");
    expect(labels).toContain("Go to Settings");
    expect(labels).toContain("Toggle left panel");
    expect(labels).toContain("Toggle assistant panel");

    cmds.find((c) => c.id === "goto-settings")!.run();
    expect(navigate).toHaveBeenCalledWith("/settings");
  });

  it("session mode lists one entry per session with objective + status", () => {
    const cmds = buildCommands({
      mode: "session",
      sessions: [
        { id: "20260821-221803-glimmer-fix-bug", task: "Fix the bug", status: "implementing" },
        { id: "20260821-221900-glimmer-no-task", task: "", status: "created" },
      ],
      navigate,
      toggleLeftPanel,
      toggleAssistantPanel,
    });
    expect(cmds).toHaveLength(2);
    expect(cmds[0].label).toBe("Fix the bug");
    expect(cmds[0].hint).toBe("implementing");
    // falls back to the short id when there's no objective text yet
    expect(cmds[1].label).toMatch(/glimmer|no-task/);

    cmds[0].run();
    expect(navigate).toHaveBeenCalledWith("/sessions/20260821-221803-glimmer-fix-bug");
  });
});
